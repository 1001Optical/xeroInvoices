/**
 * Xero OAuth (identity) 호출은 이 모듈의 fetchAccessTokenFromIdentity 만 사용합니다.
 *
 * 별도 프로세스(CLI 등)는 원격 미들웨어로 access 만 받을 수 있습니다:
 *   베이스: XERO_INTERNAL_TOKEN_BASE_URL | SERVER_BASE_URL | BACKEND_URL
 *   키: XERO_INTERNAL_API_KEY | BACKEND_API_TOKEN
 * → GET {base}/api/internal/xero/access-token (refresh 는 미들웨어·DB 쪽에만 존재)
 *   이 내부 API는 쿼리와 무관하게 항상 xero_tokens id 1(DEFAULT_ENTITY) 기준 access·tenantId 만 반환.
 *   다른 법인 Xero 호출은 같은 access + 호출 쪽 .env 의 해당 Xero-tenant-id(UUID)를 씁니다.
 *
 *   BACKEND_URL(또는 XERO_INTERNAL_TOKEN_BASE_URL) + XERO_INTERNAL_API_KEY|BACKEND_API_TOKEN 가 있으면
 *   기본적으로 access 는 **항상** GET /api/internal/xero/access-token 만 사용 — 로컬 MySQL·XERO_RT_* refresh 조회 안 함.
 *   예외: refresh 를 DB 에서 돌리는 **발급 서버**(index + xero_tokens) 에는 XERO_ISSUE_TOKENS_HERE=1 을 넣어 identity 경로 유지.
 *
 * OAuth 앱(XERO_CLIENT_ID / XERO_CLIENT_SECRET)은 하나이고, 법인(엔티티)마다
 * 테넌트 UUID 는 ENTITY_CONFIG 의 tenantEnv 로 분리합니다.
 *
 * 기본: 모든 엔티티가 같은 access — refresh 는 한 법인 행만 사용
 * (XERO_REFRESH_SOURCE_ENTITY 또는 DEFAULT_ENTITY, 보통 1001 Optical Pty Ltd).
 * 법인마다 다른 refresh(DB id 2~9)를 쓰려면 XERO_USE_SINGLE_REFRESH_ENTITY=0
 * Xero 동의에 모든 조직이 포함된 연결이어야 다른 엔티티 tenantId 로 API 호출이 성공합니다.
 */
import axios from 'axios';

const IDENTITY_TOKEN_URL = 'https://identity.xero.com/connect/token';
const CACHE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * 법인명 문자열( constants.js 의 branch.entity 와 동일 ) → DB 행 id, 초기 토큰 env, 테넌트 env
 * id 1~9: xero_tokens 테이블 PK와 1:1
 *
 * Hoya Bill 공급처 Contact UUID 는 조직마다 다름. .env 예시 (필요한 법인만):
 *   HOYA_XERO_CONTACT_ID_OPTICAL=…   ← XERO_RT_OPTICAL / XERO_TENANT_ID 와 같은 법인
 *   HOYA_XERO_CONTACT_ID_INDO=…      ← XERO_RT_INDO / INDO_TENANT_ID
 * 우선순위는 xeroHoyaBills.resolveSupplierContactId 주석 참고.
 *
 * @property {string} [hoyaContactIdEnv] process.env 키 — 법인별 Hoya 공급처 ContactID
 */
export const ENTITY_CONFIG = {
  '1001 Optical Pty Ltd': {
    id: 1,
    tokenEnv: 'XERO_RT_OPTICAL',
    tenantEnv: 'XERO_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_OPTICAL'
  },
  '1001 Chatswood Chase Pty Ltd': {
    id: 2,
    tokenEnv: 'XERO_RT_CHASE',
    tenantEnv: 'CHASE_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_CHASE'
  },
  'WSQ Eyecare Pty ltd': {
    id: 3,
    tokenEnv: 'XERO_RT_WSQ',
    tenantEnv: 'WSQ_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_WSQ'
  },
  'AJ Eyecare Pty Ltd': {
    id: 4,
    tokenEnv: 'XERO_RT_AJ',
    tenantEnv: 'AJ_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_AJ'
  },
  '1001 Hurstville Pty Ltd': {
    id: 5,
    tokenEnv: 'XERO_RT_HURSTVILLE',
    tenantEnv: 'HURSTVILLE_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_HURSTVILLE'
  },
  'CNC Eyecare Pty Ltd': {
    id: 6,
    tokenEnv: 'XERO_RT_CNC',
    tenantEnv: 'CNC_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_CNC'
  },
  'SK Eyecare Pty Ltd': {
    id: 7,
    tokenEnv: 'XERO_RT_SK',
    tenantEnv: 'SK_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_SK'
  },
  'JSJ Eyecare Pty Ltd': {
    id: 8,
    tokenEnv: 'XERO_RT_JSJ',
    tenantEnv: 'JSJ_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_JSJ'
  },
  '1001 Indooroopilly Pty Ltd': {
    id: 9,
    tokenEnv: 'XERO_RT_INDO',
    tenantEnv: 'INDO_TENANT_ID',
    hoyaContactIdEnv: 'HOYA_XERO_CONTACT_ID_INDO'
  }
};

/** getAccessToken() 인자 생략 시 사용하는 법인명 */
export const DEFAULT_ENTITY =
  (typeof process !== 'undefined' && process.env.XERO_DEFAULT_ENTITY) || '1001 Optical Pty Ltd';

/** @deprecated DEFAULT_ENTITY 사용 */
export const DEFAULT_XERO_ENTITY = DEFAULT_ENTITY;

/**
 * true: 모든 getAccessToken 이 Optical(앵커) refresh 한 줄로 갱신 — PUT 포함 동일 JWT
 * false: ENTITY_CONFIG 대로 법인별 refresh (XERO_USE_SINGLE_REFRESH_ENTITY=0)
 */
function useSingleSharedXeroRefresh() {
  const raw = String(process.env.XERO_USE_SINGLE_REFRESH_ENTITY ?? '').trim();
  if (!raw) return true;
  return /^(1|true|yes)$/i.test(raw);
}

/** 공유 refresh 가 저장된 법인명 (ENTITY_CONFIG 키) */
function sharedRefreshSourceEntityName() {
  const raw = process.env.XERO_REFRESH_SOURCE_ENTITY?.trim();
  if (raw && ENTITY_CONFIG[raw]) return raw;
  return DEFAULT_ENTITY;
}

/** 내부 HTTP 클라이언트·문서용: access 를 어떤 법인 DB 행으로 갱신할지 (기본 Optical) */
export function getXeroAccessTokenIssuerEntity() {
  return sharedRefreshSourceEntityName();
}

/**
 * refresh 읽기·저장·access 캐시 키에 쓰는 앵커 법인.
 * 단일 refresh 모드면 소스 법인 하나로 통일, 아니면 요청한 법인 그대로.
 */
function tokenAnchorEntity(requestedEntityName) {
  /** 원격 미들웨어만 쓰는 CLI/워커: 항상 issuer 한 줄로 받은 access 를 법인 간 공유 캐시 */
  if (usesInternalHttpAccessToken()) return sharedRefreshSourceEntityName();
  if (useSingleSharedXeroRefresh()) return sharedRefreshSourceEntityName();
  return String(requestedEntityName);
}

/** @type {import('mysql2/promise').Pool | null} */
let poolRef = null;

/** true면 MySQL 없이 env(및 세션 메모리)만 사용 — CLI·로컬 테스트용 */
let tokenPersistenceEnvOnly = false;

/** 회전된 refresh token 을 DB 대신 메모리에만 보관 (프로세스 종료 시 .env 반영 필요) */
const memoryRefreshTokens = new Map();

/** @type {Map<string, { accessToken: string, expiresAtMs: number }>} */
const tokenCache = new Map();

/** @type {Map<string, Promise<string>>} */
const refreshInFlight = new Map();

/** 내부 access-token API 응답으로 받은 tenantId (로컬에 tenant env 없을 때) */
const tenantIdFromInternalApi = new Map();

/**
 * 미들웨어 베이스 URL (슬래시 없음).
 * 우선순위: XERO_INTERNAL_TOKEN_BASE_URL → SERVER_BASE_URL → BACKEND_URL
 */
function internalTokenBaseUrl() {
  const raw =
    process.env.XERO_INTERNAL_TOKEN_BASE_URL ||
    process.env.SERVER_BASE_URL ||
    process.env.BACKEND_URL ||
    '';
  return String(raw).trim().replace(/\/$/, '');
}

/**
 * Bearer 로 보낼 키. XERO_INTERNAL_API_KEY 가 없으면 BACKEND_API_TOKEN (원격 미들웨어용)
 */
function internalHttpApiKey() {
  const a = process.env.XERO_INTERNAL_API_KEY?.trim();
  if (a) return a;
  return process.env.BACKEND_API_TOKEN?.trim() || '';
}

/**
 * 이 프로세스가 refresh/identity 대신 HTTP 미들웨어로 access token 만 받는 모드
 */
export function usesInternalHttpAccessToken() {
  return !!(internalTokenBaseUrl() && internalHttpApiKey());
}

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
  const key = String(entityName);
  if (tenantIdFromInternalApi.has(key)) {
    const cached = tenantIdFromInternalApi.get(key);
    if (cached && String(cached).trim()) return String(cached).trim();
  }
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
  tokenPersistenceEnvOnly = false;
}

/**
 * MySQL 없이 동작: 각 법인 refresh token 은 `ENTITY_CONFIG.tokenEnv` 환경 변수만 사용.
 * 토큰 회전 시 DB 저장 대신 메모리에만 유지되며, 재시작 후에는 새 refresh token 을 .env에 넣어야 할 수 있음.
 */
export function initXeroTokenServiceEnvOnly() {
  poolRef = null;
  tokenPersistenceEnvOnly = true;
}

export async function ensureXeroTokensReady() {
  if (usesInternalHttpAccessToken()) return;
  if (!poolRef && !tokenPersistenceEnvOnly) {
    throw new Error(
      'initXeroTokenService(pool), initXeroTokenServiceEnvOnly(), 또는 미들웨어용 BACKEND_URL+BACKEND_API_TOKEN(또는 XERO_INTERNAL_TOKEN_BASE_URL+XERO_INTERNAL_API_KEY) 를 설정하세요.'
    );
  }
}

/**
 * xero_tokens.id === ENTITY_CONFIG[entityName].id 행에서만 읽습니다.
 * DB가 비어 있으면 tokenEnv 이름의 환경 변수 값을 초기 refresh token 으로 사용합니다.
 * @param {string} entityName
 */
export async function getStoredRefreshTokenForEntity(entityName) {
  await ensureXeroTokensReady();
  const anchor = tokenAnchorEntity(entityName);
  const cfg = resolveEntityConfig(anchor);
  if (tokenPersistenceEnvOnly || !poolRef) {
    if (memoryRefreshTokens.has(anchor)) {
      const m = memoryRefreshTokens.get(anchor);
      if (m && String(m).trim()) return String(m).trim();
    }
    const fromEnv = process.env[cfg.tokenEnv];
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    return null;
  }
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
  const anchor = tokenAnchorEntity(entityName);
  if (tokenPersistenceEnvOnly || !poolRef) {
    memoryRefreshTokens.set(anchor, refreshToken);
    return;
  }
  const cfg = resolveEntityConfig(anchor);
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
  const key = tokenAnchorEntity(entityName);
  const entry = tokenCache.get(key);
  if (!entry || !cacheValid(entry)) return 0;
  return Math.max(0, Math.floor((entry.expiresAtMs - Date.now()) / 1000));
}

/**
 * GET /api/internal/xero/access-token — refresh 는 1001server 쪽에만 있음
 */
async function fetchAccessTokenFromInternalHttp(entityName) {
  const base = internalTokenBaseUrl();
  const apiKey = internalHttpApiKey();
  if (!apiKey) {
    throw new Error(
      '호출 쪽 .env 에 XERO_INTERNAL_API_KEY 또는 BACKEND_API_TOKEN 이 없습니다 (Authorization Bearer 로 보낼 값)'
    );
  }
  const url = `${base}/api/internal/xero/access-token`;
  let res;
  try {
    res = await axios.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      validateStatus: () => true
    });
  } catch (err) {
    const msg = err.response?.data || err.message;
    throw new Error(`내부 access-token API 연결 실패: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
  }
  const data = res.data;
  if (res.status >= 400 || !data?.success || !data?.accessToken) {
    let bodyErr = '';
    if (typeof data?.error === 'string' && data.error.trim()) {
      bodyErr = data.error.trim();
    } else if (typeof data?.message === 'string' && data.message.trim()) {
      /** 원격 미들웨어가 { error: true, message: "..." } 형태로 줄 때 */
      bodyErr = data.message.trim();
    } else if (data && typeof data === 'object') {
      try {
        bodyErr = JSON.stringify(data).slice(0, 400);
      } catch {
        /* ignore */
      }
    }
    const hint503 =
      res.status === 503 && !bodyErr
        ? ' — 원격(수신) 서버 배포 환경에 XERO_INTERNAL_API_KEY 또는 BACKEND_API_TOKEN 이 없으면 503입니다. 로컬 .env 는 요청 보내는 쪽만 적용됩니다.'
        : '';
    throw new Error(
      bodyErr
        ? `[내부 API HTTP ${res.status}] ${bodyErr}`
        : `내부 access-token API 실패 (HTTP ${res.status})${hint503}`
    );
  }
  const reqKey = String(entityName);
  const respEntity = String(data.entity ?? '').trim();
  if (
    data.tenantId &&
    String(data.tenantId).trim() &&
    respEntity &&
    respEntity === reqKey
  ) {
    tenantIdFromInternalApi.set(reqKey, String(data.tenantId).trim());
  }
  const expiresInSec = Number(data.expiresIn) || 0;
  const expiresAtMs =
    expiresInSec > 0
      ? Date.now() + expiresInSec * 1000
      : Date.now() + 25 * 60 * 1000;
  tokenCache.set(tokenAnchorEntity(entityName), { accessToken: data.accessToken, expiresAtMs });
  return data.accessToken;
}

/**
 * 내부 access-token URL+키가 있으면 워커·CLI 는 로컬 refresh 를 읽지 않고 HTTP 만 사용.
 * 발급 전용 프로세스만 XERO_ISSUE_TOKENS_HERE=1 로 DB→identity 경로 유지.
 */
function isXeroRefreshIssuerProcess() {
  return /^(1|true|yes)$/i.test(String(process.env.XERO_ISSUE_TOKENS_HERE || '').trim());
}

function shouldUseInternalHttpForRefresh() {
  if (!usesInternalHttpAccessToken()) return false;
  if (tokenPersistenceEnvOnly) return false;
  if (isXeroRefreshIssuerProcess()) return false;
  return true;
}

async function refreshAccessTokenInternal(entityName) {
  if (shouldUseInternalHttpForRefresh()) {
    return fetchAccessTokenFromInternalHttp(entityName);
  }

  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    throw new Error('XERO_CLIENT_ID, XERO_CLIENT_SECRET 환경 변수를 설정하세요.');
  }

  const refreshToken = await getStoredRefreshTokenForEntity(entityName);
  const cacheKey = tokenAnchorEntity(entityName);
  if (!refreshToken) {
    const cfg = resolveEntityConfig(cacheKey);
    let hint = useSingleSharedXeroRefresh()
      ? `공유 Refresh 법인 "${cacheKey}" — MySQL xero_tokens.id=${cfg.id} 또는 ${cfg.tokenEnv}`
      : `법인 "${entityName}"의 Refresh Token이 없습니다. MySQL xero_tokens.id=${cfg.id} 또는 환경 변수 ${cfg.tokenEnv}`;
    if (!usesInternalHttpAccessToken()) {
      hint +=
        ' — 미들웨어만 쓰려면 BACKEND_URL(또는 XERO_INTERNAL_TOKEN_BASE_URL) + XERO_INTERNAL_API_KEY|BACKEND_API_TOKEN 설정';
    } else if (isXeroRefreshIssuerProcess()) {
      hint += ' — 발급 서버(XERO_ISSUE_TOKENS_HERE=1)는 xero_tokens 또는 XERO_RT_* 확인';
    }
    throw new Error(`${hint} 를 설정하세요.`);
  }

  let data;
  try {
    data = await fetchAccessTokenFromIdentity(
      refreshToken,
      process.env.XERO_CLIENT_ID,
      process.env.XERO_CLIENT_SECRET
    );
  } catch (err) {
    tokenCache.delete(cacheKey);
    console.error('토큰 갱신 실패:', err.response?.status, err.response?.data || err.message);
    throw err;
  }

  const accessToken = data.access_token;
  if (!accessToken) {
    tokenCache.delete(cacheKey);
    throw new Error('Access Token이 응답에 포함되지 않았습니다.');
  }

  const expiresInSec = Number(data.expires_in) || 1800;
  const expiresAtMs = Date.now() + expiresInSec * 1000;
  tokenCache.set(cacheKey, { accessToken, expiresAtMs });

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

  const cacheKey = tokenAnchorEntity(key);

  /** Postman 과 비교 시: 캐시 때문에 예전 access 가 나갈 수 있음 — `XERO_SKIP_ACCESS_TOKEN_CACHE=1` 이면 매번 갱신 경로 */
  const skipCache = /^(1|true|yes)$/i.test(
    String(process.env.XERO_SKIP_ACCESS_TOKEN_CACHE || '')
  );
  if (skipCache) {
    tokenCache.delete(cacheKey);
  } else {
    const cached = tokenCache.get(cacheKey);
    if (cacheValid(cached)) {
      return cached.accessToken;
    }
  }

  if (refreshInFlight.has(cacheKey)) {
    return refreshInFlight.get(cacheKey);
  }

  const p = refreshAccessTokenInternal(key)
    .catch((err) => {
      tokenCache.delete(cacheKey);
      throw err;
    })
    .finally(() => {
      refreshInFlight.delete(cacheKey);
    });

  refreshInFlight.set(cacheKey, p);
  return p;
}
