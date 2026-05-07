/**
 * Google Cloud Pub/Sub → Gmail users.watch() 알림 페이로드 처리
 * @see https://cloud.google.com/pubsub/docs/push
 * @see https://developers.google.com/gmail/api/guides/push
 */
import { createPayableGmailClient } from './gmailPayableAuth.js';
import {
  getLastHistoryId,
  setLastHistoryId,
  hasProcessedMessageId,
  addProcessedMessageId,
  hasProcessedArtmostMessageId,
  addProcessedArtmostMessageId,
  hasProcessedBauschMessageId,
  addProcessedBauschMessageId,
  hasProcessedAlconMessageId,
  addProcessedAlconMessageId
} from './gmailHistoryState.js';
import { collectMessageIdsSinceHistoryForPayables } from './gmailPayableHistorySync.js';
import { processHoyaGmailMessage } from './gmailHoyaPipeline.js';
import { processArtmostGmailMessage } from './gmailArtmostPipeline.js';
import { processBauschGmailMessage } from './gmailBauschPipeline.js';
import { processAlconGmailMessage } from './gmailAlconPipeline.js';
import { isGmailRequestedEntityNotFound } from './gmailApiErrors.js';

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
 * Artmost + Bausch + Alcon + Hoya Payable 인보이스: history 한 번 조회 후 메일마다 순차 처리, historyId 는 배치 전부 성공 시에만 갱신
 * @param {object} parsed parsePubSubGmailNotification 결과
 */
export async function runPayableGmailPipelines(parsed) {
  const userEmail = parsed?.gmail?.emailAddress;
  const newHistoryId = parsed?.gmail?.historyId;
  if (!userEmail || !newHistoryId) return;

  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error('[Gmail Payables] 클라이언트:', e.message);
    return;
  }

  const last = await getLastHistoryId(userEmail);
  const messageIds = await collectMessageIdsSinceHistoryForPayables(
    gmail,
    userEmail,
    last
  );

  console.log('[Gmail Payables] history 배치', {
    mailbox: userEmail,
    lastHistoryId: last ?? '(없음·폴백 목록 사용)',
    newHistoryId,
    candidateMessages: messageIds.size,
    sampleIds: [...messageIds].slice(0, 8)
  });

  if (messageIds.size === 0) {
    console.log('[Gmail Payables] 신규 메시지 없음 → historyId 갱신', newHistoryId);
    await setLastHistoryId(userEmail, newHistoryId);
    return;
  }

  let batchFailed = false;

  for (const id of messageIds) {
    try {
      if (!(await hasProcessedArtmostMessageId(userEmail, id))) {
        const artmostOutcome = await processArtmostGmailMessage(gmail, id, userEmail);
        if (artmostOutcome === 'failed') {
          batchFailed = true;
        } else if (artmostOutcome === 'success' || artmostOutcome === 'orphan') {
          await addProcessedArtmostMessageId(userEmail, id);
        }
      }

      if (!(await hasProcessedAlconMessageId(userEmail, id))) {
        const alconOutcome = await processAlconGmailMessage(gmail, id, userEmail);
        if (alconOutcome === 'failed') {
          batchFailed = true;
        } else if (alconOutcome === 'success' || alconOutcome === 'orphan') {
          await addProcessedAlconMessageId(userEmail, id);
        }
      }

      if (!(await hasProcessedBauschMessageId(userEmail, id))) {
        const bauschOutcome = await processBauschGmailMessage(gmail, id, userEmail);
        if (bauschOutcome === 'failed') {
          batchFailed = true;
        } else if (bauschOutcome === 'success' || bauschOutcome === 'orphan') {
          await addProcessedBauschMessageId(userEmail, id);
        }
      }

      if (!(await hasProcessedMessageId(userEmail, id))) {
        const hoyaOk = await processHoyaGmailMessage(gmail, id, userEmail);
        if (!hoyaOk) {
          batchFailed = true;
        } else {
          await addProcessedMessageId(userEmail, id);
        }
      }
    } catch (err) {
      if (isGmailRequestedEntityNotFound(err)) {
        console.warn('[Gmail Payables] message 건너뜀 (Gmail 404)', id);
        await addProcessedMessageId(userEmail, id);
        await addProcessedArtmostMessageId(userEmail, id);
        await addProcessedAlconMessageId(userEmail, id);
        await addProcessedBauschMessageId(userEmail, id);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Gmail Payables] message 실패', id, msg);
      batchFailed = true;
    }
  }

  if (!batchFailed) {
    await setLastHistoryId(userEmail, newHistoryId);
    console.log('[Gmail Payables] 배치 성공 → lastHistoryId=', newHistoryId);
  } else {
    console.warn(
      '[Gmail Payables] 배치에 실패 포함 → lastHistoryId 유지 (재시도 가능). 새 값=',
      newHistoryId
    );
  }
}

/**
 * Pub/Sub 푸시 — Artmost·Bausch·Alcon·Hoya Payable 파이프라인 (비동기 시작)
 * @param {object} parsed parsePubSubGmailNotification 결과
 */
export function onGmailPubSubNotification(parsed) {
  if (parsed?.parseError) {
    console.log('[Gmail Pub/Sub]', parsed.parseError, parsed.subscription || '');
    return;
  }
  if (parsed?.gmail?.emailAddress && parsed?.gmail?.historyId) {
    console.log(
      '[Gmail Pub/Sub] 알림:',
      parsed.gmail.emailAddress,
      'historyId=',
      parsed.gmail.historyId
    );
  }
  void runPayableGmailPipelines(parsed).catch((err) => {
    console.error('[Gmail Payables pipeline]', err.message);
  });
}
