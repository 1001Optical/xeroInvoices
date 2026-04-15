/**
 * Google Cloud Pub/Sub → Gmail users.watch() 알림 페이로드 처리
 * @see https://cloud.google.com/pubsub/docs/push
 * @see https://developers.google.com/gmail/api/guides/push
 */

/**
 * Pub/Sub push 본문에서 Gmail 알림 JSON 추출
 * @param {object} body - req.body (Pub/Sub envelope)
 * @returns {{ subscription?: string, gmail?: { emailAddress?: string, historyId?: string }, raw?: string, parseError?: string } | null}
 */
export function parsePubSubGmailNotification(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const msg = body.message;
  if (!msg || typeof msg !== 'object') {
    return { subscription: body.subscription, parseError: 'missing message' };
  }

  const b64 = msg.data;
  if (b64 == null || b64 === '') {
    return {
      subscription: body.subscription,
      messageId: msg.messageId || msg.message_id,
      parseError: 'empty data (heartbeat or non-data message)'
    };
  }

  let raw;
  try {
    raw = Buffer.from(String(b64), 'base64').toString('utf8');
  } catch (e) {
    return {
      subscription: body.subscription,
      parseError: `base64 decode failed: ${e.message}`
    };
  }

  let gmail;
  try {
    gmail = JSON.parse(raw);
  } catch {
    return { subscription: body.subscription, raw, parseError: 'JSON parse failed' };
  }

  return {
    subscription: body.subscription,
    messageId: msg.messageId || msg.message_id,
    gmail: {
      emailAddress: gmail.emailAddress,
      historyId: gmail.historyId != null ? String(gmail.historyId) : undefined
    },
    raw
  };
}

/**
 * 이후 Gmail API history.list / messages.get 등으로 PDF 처리할 훅 (지금은 로그용)
 * @param {object} parsed parsePubSubGmailNotification 결과
 */
export async function onGmailPubSubNotification(parsed) {
  if (parsed?.gmail?.emailAddress && parsed?.gmail?.historyId) {
    console.log(
      '[Gmail Pub/Sub] 알림:',
      parsed.gmail.emailAddress,
      'historyId=',
      parsed.gmail.historyId
    );
  } else if (parsed?.parseError) {
    console.log('[Gmail Pub/Sub]', parsed.parseError, parsed.subscription || '');
  }
}
