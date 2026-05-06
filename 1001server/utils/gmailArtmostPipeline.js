/**
 * Artmost 주문 영수증 메일 — PDF 파싱 후 Xero ACCPAY 생성/첨부.
 * 제목: … order receipt … 또는 … order from … is complete (동일 발신자)
 * 발신: admin@artmostgovau.com.au
 */
import { createPayableGmailClient } from './gmailPayableAuth.js';
import {
  getLastHistoryId,
  setLastHistoryId,
  hasProcessedArtmostMessageId,
  addProcessedArtmostMessageId
} from './gmailHistoryState.js';
import { collectMessageIdsSinceHistoryForPayables } from './gmailPayableHistorySync.js';
import { parseArtmostInvoicePdf } from './artmostPdfParser.js';
import {
  ensureArtmostAccPayAndAttach,
  ensureArtmostSupplierCreditAndAttach
} from './xeroArtmostBills.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload
} from './gmailHoyaPipeline.js';
import { isGmailRequestedEntityNotFound } from './gmailApiErrors.js';

const ARTMOST_FROM_EMAIL = /admin@artmostgovau\.com\.au/i;
/** receipt 메일 + “order … is complete” 알림 모두 동일 PDF 패턴으로 처리 */
const ARTMOST_ORDER_SUBJECT_BASE =
  /Your\s+ArtMost\s+GOV\s+Contact\s+Lenses\s+Australia\s+order\b/i;

function getHeader(headers, name) {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function isArtmostOrderMail(headers) {
  const subj = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  if (!ARTMOST_FROM_EMAIL.test(from)) return false;
  if (!ARTMOST_ORDER_SUBJECT_BASE.test(subj)) return false;
  const receipt = /order\s+receipt/i.test(subj);
  const complete = /\bis\s+complete\b/i.test(subj);
  return receipt || complete;
}

function logArtmostPdfError({ messageId, attachmentFilename, page, error }) {
  console.error(
    '[Artmost PDF]',
    JSON.stringify({
      messageId,
      attachmentFilename,
      page: page ?? null,
      error
    })
  );
}

/**
 * @typedef {'skipped' | 'success' | 'failed' | 'orphan'} ArtmostProcessOutcome
 *   orphan — Gmail messages.get 404 (삭제·고아 history ID), 재시도 불가 → 처리함으로 기록
 */

/**
 * @returns {Promise<ArtmostProcessOutcome>}
 *   skipped — Artmost 대상 메일 아님
 *   success — PDF 파싱 완료
 *   failed — 대상 메일인데 PDF 없음/다운로드·파싱 오류
 *   orphan — 메시지 ID 가 Gmail 에 없음 (404)
 */
export async function processArtmostGmailMessage(gmail, messageId, userEmail) {
  void userEmail;

  let full;
  try {
    full = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });
  } catch (err) {
    if (isGmailRequestedEntityNotFound(err)) {
      console.warn('[Artmost] messages.get 404 건너뜀', messageId);
      return 'orphan';
    }
    throw err;
  }

  const headers = full.data.payload?.headers || [];
  if (!isArtmostOrderMail(headers)) {
    console.log(
      '[Artmost] skip (헤더 불일치 — receipt/complete+admin@artmost 아님)',
      JSON.stringify({
        messageId,
        subject: getHeader(headers, 'Subject')?.slice(0, 200),
        from: getHeader(headers, 'From')?.slice(0, 200)
      })
    );
    return 'skipped';
  }

  const pdfs = collectPdfAttachmentsFromPayload(full.data.payload);
  if (pdfs.length === 0) {
    console.warn('[Artmost] PDF 첨부 없음 messageId=', messageId);
    return 'failed';
  }

  console.log(
    '[Artmost] 처리:',
    getHeader(headers, 'Subject'),
    'messageId=',
    messageId,
    '첨부후보=',
    pdfs.length
  );

  let hadFailure = false;
  for (const item of pdfs) {
    const filename = item.filename;
    let buffer;
    if (item.buffer) {
      buffer = item.buffer;
    } else if (item.attachmentId) {
      try {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: item.attachmentId
        });
        const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
        buffer = Buffer.from(b64, 'base64');
      } catch (err) {
        hadFailure = true;
        logArtmostPdfError({
          messageId,
          attachmentFilename: filename,
          page: null,
          error: `attachment download: ${err instanceof Error ? err.message : String(err)}`
        });
        continue;
      }
      if (item.sniffPdf && !bufferLooksLikePdf(buffer)) continue;
    } else {
      hadFailure = true;
      logArtmostPdfError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: 'PDF 항목에 buffer·attachmentId 없음'
      });
      continue;
    }

    let parsed;
    try {
      parsed = await parseArtmostInvoicePdf(buffer, { attachmentFileName: filename });
    } catch (err) {
      hadFailure = true;
      logArtmostPdfError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `PDF open: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }

    for (const pe of parsed.pageErrors) {
      hadFailure = true;
      logArtmostPdfError({
        messageId,
        attachmentFilename: filename,
        page: pe.page,
        error: pe.error
      });
    }

    for (const inv of parsed.invoices) {
      try {
        const opts = {
          fields: inv.fields,
          pagePdfBuffer: buffer,
          attachmentFileName: filename
        };
        if (inv.fields?.documentKind === 'supplier_credit_note') {
          await ensureArtmostSupplierCreditAndAttach(opts);
        } else {
          await ensureArtmostAccPayAndAttach(opts);
        }
      } catch (err) {
        hadFailure = true;
        console.error(
          '[Artmost Xero error]',
          JSON.stringify({
            messageId,
            attachmentFilename: filename,
            page: inv.page,
            invoiceNumber: inv.fields?.invoiceNumber || null,
            documentKind: inv.fields?.documentKind || 'supplier_invoice',
            matchedEntity: inv.fields?.matchedEntity || null,
            error: err instanceof Error ? err.message : String(err),
            xero: err?.response?.data || null
          })
        );
      }
    }
  }

  if (hadFailure) return 'failed';
  return 'success';
}

export async function runArtmostGmailPipeline(parsed) {
  const userEmail = parsed?.gmail?.emailAddress;
  const newHistoryId = parsed?.gmail?.historyId;
  if (!userEmail || !newHistoryId) return;

  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error('[Artmost] Gmail 클라이언트:', e.message);
    return;
  }

  const last = await getLastHistoryId(userEmail);
  const messageIds = await collectMessageIdsSinceHistoryForPayables(
    gmail,
    userEmail,
    last
  );

  if (messageIds.size === 0) {
    await setLastHistoryId(userEmail, newHistoryId);
    return;
  }

  let batchFailed = false;
  for (const id of messageIds) {
    if (await hasProcessedArtmostMessageId(userEmail, id)) continue;
    try {
      const outcome = await processArtmostGmailMessage(gmail, id, userEmail);
      if (outcome === 'failed') {
        batchFailed = true;
        continue;
      }
      if (outcome === 'success' || outcome === 'orphan') {
        await addProcessedArtmostMessageId(userEmail, id);
      }
    } catch (err) {
      if (isGmailRequestedEntityNotFound(err)) {
        console.warn('[Artmost] message 건너뜀 (Gmail 404)', id);
        await addProcessedArtmostMessageId(userEmail, id);
        continue;
      }
      batchFailed = true;
      console.error('[Artmost] message 실패', id, err instanceof Error ? err.message : String(err));
    }
  }

  if (!batchFailed) {
    await setLastHistoryId(userEmail, newHistoryId);
  }
}
