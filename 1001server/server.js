import { xeroInternalRouter } from './routes/xeroInternal.js';

/**
 * 전역 API_TOKEN 이전에 등록: /api/internal/xero 는 XERO_INTERNAL_API_KEY 만 검사
 */
export function checkApiToken(req, res, next) {
  const expected = process.env.API_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'API_TOKEN is not configured' });
  }
  const auth = req.headers.authorization;
  let token = '';
  if (auth && /^Bearer\s+/i.test(auth)) {
    token = auth.replace(/^Bearer\s+/i, '').trim();
  } else if (typeof req.headers['x-api-key'] === 'string') {
    token = req.headers['x-api-key'].trim();
  }
  if (token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * app.use(express.json()) 이후, 나머지 /api 라우트보다 먼저 호출하세요.
 * @param {import('express').Express} app
 */
export function registerInternalXeroBeforeApiGuard(app) {
  app.use('/api/internal/xero', xeroInternalRouter);
  app.use((req, res, next) => {
    if (
      req.originalUrl.startsWith('/api/') &&
      !req.originalUrl.startsWith('/api/internal/xero')
    ) {
      return checkApiToken(req, res, next);
    }
    next();
  });
}

/** @deprecated 이름 호환 — registerInternalXeroBeforeApiGuard 와 동일 */
export const registerInternalXeroAndApiGuard = registerInternalXeroBeforeApiGuard;
