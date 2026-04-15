/**
 * Xero OAuth (identity) 호출은 이 모듈의 fetchAccessTokenFromIdentity 만 사용합니다.
 * 다른 프로세스/서비스는 identity 직접 호출 대신 GET /api/internal/xero/access-token 을 사용하세요.
 *
 * OAuth 앱(XERO_CLIENT_ID / XERO_CLIENT_SECRET)은 하나이고, 법인(엔티티)마다
 * MySQL xero_tokens.id 행·refresh token·tenant 환경 변수는 ENTITY_CONFIG 로 분리합니다.
 */
import axios from 'axios';

const IDENTITY_TOKEN_URL = 'https://identity.xero.com/connect/token';
const CACHE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * 법인명 문자열( constants.js 의 branch.entity 와 동일 ) → DB 행 id, 초기 토큰 env, 테넌트 env
 * id 1~9: xero_tokens 테이블 PK와 1:1
 */
export const ENTITY_CONFIG = {
  '1001 Optical Pty Ltd': {
    id: 1,
    tokenEnv: 'XERO_RT_OPTICAL',
    tenantEnv: 'XERO_TENANT_ID'
  },
  '1001 Chatswood Chase Pty Ltd': {
    id: 2,
    tokenEnv: 'XERO_RT_CHASE',
    tenantEnv: 'CHASE_TENANT_ID'
  },
  'WSQ Eyecare Pty ltd': {
    id: 3,
    tokenEnv: 'XERO_RT_WSQ',
    tenantEnv: 'WSQ_TENANT_ID'
  },
  'AJ Eyecare Pty Ltd': {
    id: 4,
    tokenEnv: 'XERO_RT_AJ',
    tenantEnv: 'AJ_TENANT_ID'
  },
  '1001 Hurstville Pty Ltd': {
    id: 5,
    tokenEnv: 'XERO_RT_HURSTVILLE',
    tenantEnv: 'HURSTVILLE_TENANT_ID'
  },
  'CNC Eyecare Pty Ltd': {
    id: 6,
    tokenEnv: 'XERO_RT_CNC',
    tenantEnv: 'CNC_TENANT_ID'
  },
  'SK Eyecare Pty Ltd': {
    id: 7,
    tokenEnv: 'XERO_RT_SK',
    tenantEnv: 'SK_TENANT_ID'
  },
  'JSJ Eyecare Pty Ltd': {
    id: 8,
    tokenEnv: 'XERO_RT_JSJ',
    tenantEnv: 'JSJ_TENANT_ID'
  },
  '1001 Indooroopilly Pty Ltd': {
    id: 9,
    tokenEnv: 'XERO_RT_INDO',
    tenantEnv: 'INDO_TENANT_ID'
  }
};

/** getAccessToken() 인자 생략 시 사용하는 법인명 */
export const DEFAULT_ENTITY =
  (typeof process !== 'undefined' && process.env.XERO_DEFAULT_ENTITY) || '1001 Optical Pty Ltd';

/** @deprecated DEFAULT_ENTITY 사용 */
export const DEFAULT_XERO_ENTITY = DEFAULT_ENTITY;

/** @type {import('mysql2/promise').Pool | null} */
let poolRef = null;

/** @type {Map<string, { accessToken: string, expiresAtMs: number }>} */
const tokenCache = new Map();

/** @type {Map<string, Promise<string>>} */
const refreshInFlight = new Map();

/**
 * @param {string} entityName ENTITY_CONFIG 키와 동일한 법인명
 * @returns {typeof ENTITY_CONFIG[string]}
 */
export function resolveEntityConfig(entityName) {
  const cfg = ENTITY_CONFIG[entityName];
  if (!cfg) {
    throw new Error(
      `등록되지 않은 엔티티입니다: "${entityName}". ENTITY_CONFIG 키(법인명)와 동일한 문자열을 사용하세요.`
    );
  }
  return cfg;
}

/**
 * @param {string} entityName
 * @returns {string} 해당 법인의 Xero Tenant UUID
 */
export function getTenantIdForEntity(entityName) {
  const cfg = resolveEntityConfig(entityName);
  const v = process.env[cfg.tenantEnv];
  return (v && String(v).trim()) || '';
}

/**
 * identity.xero.com/connect/token 호출 — 프로젝트에서 유일한 토큰 엔드포인트 호출부
 * @param {string} refreshToken
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ access_token: string, expires_in?: number, refresh_token?: string }>}
 */
export async function fetchAccessTokenFromIdentity(refreshToken, clientId, clientSecret) {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  const response = await axios.post(IDENTITY_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
export function initXeroTokenService(pool) {
  poolRef = pool;
}

export async function ensureXeroTokensReady() {
  if (!poolRef) throw new Error('initXeroTokenService(pool)를 먼저 호출하세요.');
}

/**
 * xero_tokens.id === ENTITY_CONFIG[entityName].id 행에서만 읽습니다.
 * DB가 비어 있으면 tokenEnv 이름의 환경 변수 값을 초기 refresh token 으로 사용합니다.
 * @param {string} entityName
 */
export async function getStoredRefreshTokenForEntity(entityName) {
  await ensureXeroTokensReady();
  const cfg = resolveEntityConfig(entityName);
  const [rows] = await poolRef.query('SELECT refresh_token FROM xero_tokens WHERE id = ?', [
    cfg.id
  ]);
  const dbToken = rows?.[0]?.refresh_token;
  if (dbToken && String(dbToken).trim()) return String(dbToken).trim();
  const fromEnv = process.env[cfg.tokenEnv];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return null;
}

/**
 * @param {string} entityName
 * @param {string} refreshToken
 */
async function saveRefreshTokenForEntity(entityName, refreshToken) {
  await ensureXeroTokensReady();
  const cfg = resolveEntityConfig(entityName);
  const [r] = await poolRef.query(
    'UPDATE xero_tokens SET refresh_token = ? WHERE id = ?',
    [refreshToken, cfg.id]
  );
  if (r.affectedRows > 0) return;
  await poolRef.query('INSERT INTO xero_tokens (id, refresh_token) VALUES (?, ?)', [
    cfg.id,
    refreshToken
  ]);
}

function cacheValid(entry) {
  if (!entry) return false;
  return Date.now() < entry.expiresAtMs - CACHE_REFRESH_MARGIN_MS;
}

/**
 * 내부 API 응답용: 캐시 기준 남은 유효 시간(초). 캐시 없으면 0.
 * @param {string} entityName
 */
export function getAccessTokenRemainingSeconds(entityName) {
  const key = String(entityName);
  const entry = tokenCache.get(key);
  if (!entry || !cacheValid(entry)) return 0;
  return Math.max(0, Math.floor((entry.expiresAtMs - Date.now()) / 1000));
}

async function refreshAccessTokenInternal(entityName) {
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    throw new Error('XERO_CLIENT_ID, XERO_CLIENT_SECRET 환경 변수를 설정하세요.');
  }

  const refreshToken = await getStoredRefreshTokenForEntity(entityName);
  if (!refreshToken) {
    const cfg = resolveEntityConfig(entityName);
    throw new Error(
      `법인 "${entityName}"의 Refresh Token이 없습니다. MySQL xero_tokens.id=${cfg.id} 또는 환경 변수 ${cfg.tokenEnv} 를 설정하세요.`
    );
  }

  let data;
  try {
    data = await fetchAccessTokenFromIdentity(
      refreshToken,
      process.env.XERO_CLIENT_ID,
      process.env.XERO_CLIENT_SECRET
    );
  } catch (err) {
    tokenCache.delete(String(entityName));
    console.error('토큰 갱신 실패:', err.response?.status, err.response?.data || err.message);
    throw err;
  }

  const accessToken = data.access_token;
  if (!accessToken) {
    tokenCache.delete(String(entityName));
    throw new Error('Access Token이 응답에 포함되지 않았습니다.');
  }

  const expiresInSec = Number(data.expires_in) || 1800;
  const expiresAtMs = Date.now() + expiresInSec * 1000;
  tokenCache.set(String(entityName), { accessToken, expiresAtMs });

  const newRt = data.refresh_token;
  if (newRt && newRt !== refreshToken) {
    await saveRefreshTokenForEntity(entityName, newRt);
  }

  return accessToken;
}

/**
 * 엔티티별 메모리 캐시 + 만료 5분 전까지 재사용 + 동일 엔티티 동시 요청 단일 갱신(single-flight)
 * @param {string} [entityName=DEFAULT_ENTITY]
 */
export async function getAccessToken(entityName = DEFAULT_ENTITY) {
  const key = String(entityName);
  resolveEntityConfig(key);
  await ensureXeroTokensReady();

  const cached = tokenCache.get(key);
  if (cacheValid(cached)) {
    return cached.accessToken;
  }

  if (refreshInFlight.has(key)) {
    return refreshInFlight.get(key);
  }

  const p = refreshAccessTokenInternal(key)
    .catch((err) => {
      tokenCache.delete(key);
      throw err;
    })
    .finally(() => {
      refreshInFlight.delete(key);
    });

  refreshInFlight.set(key, p);
  return p;
}
