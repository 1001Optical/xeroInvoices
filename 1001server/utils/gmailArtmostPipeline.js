/**
 * Artmost 주문 영수증 메일 — PDF 파싱 후 Xero ACCPAY 생성/첨부.
 * 제목: Your ArtMost GOV Contact Lenses Australia order receipt ...
 * 발신: admin@artmostgovau.com.au
 */
import { createPayableGmailClient } from './gmailPayableAuth.js';
import {
  getLastHistoryId,
  setLastHistoryId,
  hasProcessedAlconMessageId,
  addProcessedAlconMessageId
} from './gmailHistoryState.js';
import { collectMessageIdsSinceHistoryForPayables } from './gmailPayableHistorySync.js';
import { parseArtmostInvoicePdf } from './artmostPdfParser.js';
import { ensureArtmostAccPayAndAttach } from './xeroArtmostBills.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload
} from './gmailHoyaPipeline.js';

const ARTMOST_FROM_EMAIL = /admin@artmostgovau\.com\.au/i;
const ARTMOST_RECEIPT_SUBJECT =
  /Your\s+ArtMost\s+GOV\s+Contact\s+Lenses\s+Australia\s+order\s+receipt/i;

function getHeader(headers, name) {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function isArtmostOrderReceiptMail(headers) {
  const subj = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  return ARTMOST_RECEIPT_SUBJECT.test(subj) && ARTMOST_FROM_EMAIL.test(from);
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
 * @typedef {'skipped' | 'success' | 'failed'} ArtmostProcessOutcome
 */

/**
 * @returns {Promise<ArtmostProcessOutcome>}
 *   skipped — Artmost 대상 메일 아님
 *   success — PDF 파싱 완료
 *   failed — 대상 메일인데 PDF 없음/다운로드·파싱 오류
 */
export async function processArtmostGmailMessage(gmail, messageId, userEmail) {
  void userEmail;

  const full = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  const headers = full.data.payload?.headers || [];
  if (!isArtmostOrderReceiptMail(headers)) {
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
        await ensureArtmostAccPayAndAttach({
          fields: inv.fields,
          pagePdfBuffer: buffer,
          attachmentFileName: filename
        });
      } catch (err) {
        hadFailure = true;
        console.error(
          '[Artmost Xero error]',
          JSON.stringify({
            messageId,
            attachmentFilename: filename,
            page: inv.page,
            invoiceNumber: inv.fields?.invoiceNumber || null,
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
    if (await hasProcessedAlconMessageId(userEmail, id)) continue;
    try {
      const outcome = await processArtmostGmailMessage(gmail, id, userEmail);
      if (outcome === 'failed') {
        batchFailed = true;
        continue;
      }
      if (outcome === 'success') {
        await addProcessedAlconMessageId(userEmail, id);
      }
    } catch (err) {
      batchFailed = true;
      console.error('[Artmost] message 실패', id, err instanceof Error ? err.message : String(err));
    }
  }

  if (!batchFailed) {
    await setLastHistoryId(userEmail, newHistoryId);
  }
}
