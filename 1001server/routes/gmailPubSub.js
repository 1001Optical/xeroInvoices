/**
 * Gmail API + Cloud Pub/Sub 푸시 구독이 POST 하는 수신부.
 * GCP에서 구독 URL 예: https://your-domain.com/webhooks/gmail/pubsub?token=<GMAIL_PUBSUB_PUSH_TOKEN>
 *
 * Watch 자동 갱신: Cloud Scheduler → GET /webhooks/gmail/renew-watch?token=<GMAIL_WATCH_RENEW_TOKEN>
 */
import express from 'express';
import {
  parsePubSubGmailNotification,
  onGmailPubSubNotification
} from '../utils/gmailPubSub.js';
import { registerPayableGmailWatch } from '../utils/gmailWatchRegister.js';

export const gmailPubSubRouter = express.Router();

/** Pub/Sub 구독 URL에 token 쿼리로 넣는 공유 비밀 (미설정이면 검사 안 함) */
function verifyPushToken(req, res, next) {
  const configured = process.env.GMAIL_PUBSUB_PUSH_TOKEN;
  if (!configured) return next();
  const q = req.query.token;
  if (q !== configured) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/** Cloud Scheduler 등 — users.watch() 재등록 (GMAIL_WATCH_RENEW_TOKEN 필수) */
function verifyRenewWatchToken(req, res, next) {
  const configured = process.env.GMAIL_WATCH_RENEW_TOKEN?.trim();
  if (!configured) {
    return res.status(503).json({
      error: 'GMAIL_WATCH_RENEW_TOKEN not configured',
      hint: 'Set a random secret in .env; call ?token=... or Authorization: Bearer ...'
    });
  }
  const q = req.query.token;
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (q === configured || bearer === configured) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

/** 헬스체크 (로드밸런서·수동 확인) */
gmailPubSubRouter.get('/health', verifyPushToken, (req, res) => {
  res.json({
    ok: true,
    service: 'gmail-pubsub-webhook',
    pushTokenRequired: Boolean(process.env.GMAIL_PUBSUB_PUSH_TOKEN),
    watchRenewConfigured: Boolean(process.env.GMAIL_WATCH_RENEW_TOKEN?.trim())
  });
});

async function renewWatchHandler(req, res) {
  try {
    const out = await registerPayableGmailWatch();
    console.log('[Gmail watch] renewed via HTTP', {
      historyId: out.historyId,
      expirationIso: out.expirationIso
    });
    return res.json({
      ok: true,
      historyId: out.historyId,
      expiration: out.expiration,
      expirationIso: out.expirationIso
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Gmail watch] renew failed:', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}

gmailPubSubRouter.get('/renew-watch', verifyRenewWatchToken, renewWatchHandler);
gmailPubSubRouter.post('/renew-watch', verifyRenewWatchToken, renewWatchHandler);

/**
 * Pub/Sub push 엔드포인트 — 본문은 Google 표준 envelope
 * @see https://cloud.google.com/pubsub/docs/push#receive_push
 */
gmailPubSubRouter.post('/pubsub', verifyPushToken, async (req, res) => {
  try {
    const parsed = parsePubSubGmailNotification(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    onGmailPubSubNotification(parsed);

    return res.status(204).send();
  } catch (err) {
    console.error('[Gmail Pub/Sub] handler error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});
