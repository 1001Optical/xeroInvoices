import express from 'express';
import {
  getAccessToken,
  getAccessTokenRemainingSeconds,
  getTenantIdForEntity,
  DEFAULT_ENTITY,
  ENTITY_CONFIG,
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
  const internalKey = process.env.XERO_INTERNAL_API_KEY;
  if (!internalKey) {
    return res.status(503).json({
      success: false,
      error: 'XERO_INTERNAL_API_KEY is not configured'
    });
  }

  const provided = readInternalKey(req);
  if (!provided || provided !== internalKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const raw = req.query.entity != null ? String(req.query.entity).trim() : '';
  const entity = raw || DEFAULT_ENTITY;

  try {
    resolveEntityConfig(entity);
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: e.message || 'Unknown entity',
      knownEntities: Object.keys(ENTITY_CONFIG)
    });
  }

  try {
    const accessToken = await getAccessToken(entity);
    const expiresIn = getAccessTokenRemainingSeconds(entity);
    const tenantId = getTenantIdForEntity(entity);
    if (!tenantId) {
      const cfg = ENTITY_CONFIG[entity];
      return res.status(503).json({
        success: false,
        error: `Tenant ID 환경 변수 ${cfg.tenantEnv} 가 비어 있습니다.`
      });
    }
    return res.json({
      success: true,
      accessToken,
      expiresIn,
      tenantId,
      entity
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Token refresh failed'
    });
  }
});
