/**
 * 외부 워커·별도 서버용 access token 발급.
 * 상세: ../docs/XERO_INTERNAL_ACCESS_TOKEN.md
 *
 * 이 라우트는 쿼리(?entity, ?accessEntity 등)를 읽지 않습니다.
 * 항상 DEFAULT_ENTITY(기본 1001 Optical Pty Ltd) = xero_tokens id 1 기준으로만 발급합니다.
 */
import express from 'express';
import {
  getAccessToken,
  getAccessTokenRemainingSeconds,
  getTenantIdForEntity,
  DEFAULT_ENTITY,
  resolveEntityConfig
} from '../utils/xero.js';

export const xeroInternalRouter = express.Router();

function readInternalKey(req) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const key = req.headers['x-api-key'];
  if (typeof key === 'string') return key.trim();
  return '';
}

xeroInternalRouter.get('/access-token', async (req, res) => {
  const internalKey =
    process.env.XERO_INTERNAL_API_KEY?.trim() ||
    process.env.BACKEND_API_TOKEN?.trim();
  if (!internalKey) {
    return res.status(503).json({
      success: false,
      error:
        '이 서버(수신) 프로세스에 XERO_INTERNAL_API_KEY 또는 BACKEND_API_TOKEN 이 없습니다. PM2/배포 환경 변수에 설정하세요. (요청 헤더 누락은 401입니다)'
    });
  }

  const provided = readInternalKey(req);
  if (!provided || provided !== internalKey) {
    return res.status(401).json({
      success: false,
      error:
        'Unauthorized — Authorization: Bearer 또는 x-api-key 로 키를 보내야 합니다 (클라이언트 .env 의 XERO_INTERNAL_API_KEY / BACKEND_API_TOKEN 과 수신 서버 값이 동일해야 함)'
    });
  }

  const anchorEntity = DEFAULT_ENTITY;
  let anchorCfg;
  try {
    anchorCfg = resolveEntityConfig(anchorEntity);
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `DEFAULT_ENTITY "${anchorEntity}" 가 ENTITY_CONFIG 에 없습니다: ${e.message || e}`
    });
  }

  console.log('[xero internal] GET /access-token (항상 xero_tokens row)', {
    xeroTokensRowId: anchorCfg.id,
    entity: anchorEntity
  });

  try {
    const accessToken = await getAccessToken(anchorEntity);
    const expiresIn = getAccessTokenRemainingSeconds(anchorEntity);
    const tenantId = getTenantIdForEntity(anchorEntity);
    if (!tenantId) {
      console.warn('[xero internal] tenantId 없음', anchorEntity, anchorCfg.tenantEnv);
      return res.status(503).json({
        success: false,
        error: `Tenant ID 환경 변수 ${anchorCfg.tenantEnv} 가 비어 있습니다.`
      });
    }
    console.log('[xero internal] access-token 발급 OK', {
      xeroTokensRowId: anchorCfg.id,
      entity: anchorEntity
    });
    return res.json({
      success: true,
      accessToken,
      expiresIn,
      tenantId,
      entity: anchorEntity,
      xeroTokensRowId: anchorCfg.id
    });
  } catch (error) {
    const msg = error.message || 'Token refresh failed';
    console.error('[xero internal] access-token 실패', {
      xeroTokensRowId: anchorCfg.id,
      entity: anchorEntity,
      error: msg
    });
    return res.status(500).json({
      success: false,
      error: msg
    });
  }
});
