/**
 * Gmail API + Cloud Pub/Sub 푸시 구독이 POST 하는 수신부.
 * GCP에서 구독 URL 예: https://your-domain.com/webhooks/gmail/pubsub?token=<GMAIL_PUBSUB_PUSH_TOKEN>
 */
import express from 'express';
import {
  parsePubSubGmailNotification,
  onGmailPubSubNotification
} from '../utils/gmailPubSub.js';

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

gmailPubSubRouter.use(verifyPushToken);

/** 헬스체크 (로드밸런서·수동 확인) */
gmailPubSubRouter.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'gmail-pubsub-webhook',
    pushTokenRequired: Boolean(process.env.GMAIL_PUBSUB_PUSH_TOKEN)
  });
});

/**
 * Pub/Sub push 엔드포인트 — 본문은 Google 표준 envelope
 * @see https://cloud.google.com/pubsub/docs/push#receive_push
 */
gmailPubSubRouter.post('/pubsub', async (req, res) => {
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
