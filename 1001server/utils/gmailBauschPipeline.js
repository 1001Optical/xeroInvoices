import { createPayableGmailClient } from './gmailPayableAuth.js';
import {
  getLastHistoryId,
  setLastHistoryId,
  hasProcessedBauschMessageId,
  addProcessedBauschMessageId
} from './gmailHistoryState.js';
import { collectMessageIdsSinceHistoryForPayables } from './gmailPayableHistorySync.js';
import { parseBauschInvoicePdf } from './bauschPdfParser.js';
import {
  ensureBauschAccPayAndAttach,
  ensureBauschSupplierCreditAndAttach
} from './xeroBauschBills.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload
} from './gmailHoyaPipeline.js';
import { isGmailRequestedEntityNotFound } from './gmailApiErrors.js';

const BAUSCH_FROM_EMAIL = /sap_generated_no_reply@bausch\.com/i;
/** Gmail 표시명 "Bausch & Lomb (Australia) Pty. Ltd*" 등 */
const BAUSCH_FROM_DISPLAY =
  /Bausch\s*&\s*Lomb\s*\(\s*Australia\s*\)\s*Pty\.?\s*Ltd\*?/i;
const BAUSCH_SUBJECT = /\bB&L\s+Invoice\b/i;

function getHeader(headers, name) {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function isBauschInvoiceMail(headers) {
  const subj = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  const fromOk = BAUSCH_FROM_EMAIL.test(from) || BAUSCH_FROM_DISPLAY.test(from);
  return fromOk && BAUSCH_SUBJECT.test(subj);
}

function logBauschPdfError({ messageId, attachmentFilename, page, error }) {
  console.error(
    '[Bausch PDF]',
    JSON.stringify({
      messageId,
      attachmentFilename,
      page: page ?? null,
      error
    })
  );
}

/**
 * @typedef {'skipped' | 'success' | 'failed' | 'orphan'} BauschProcessOutcome
 */

export async function processBauschGmailMessage(gmail, messageId, userEmail) {
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
      console.warn('[Bausch] messages.get 404 건너뜀', messageId);
      return 'orphan';
    }
    throw err;
  }

  const headers = full.data.payload?.headers || [];
  if (!isBauschInvoiceMail(headers)) return 'skipped';

  const pdfs = collectPdfAttachmentsFromPayload(full.data.payload);
  if (pdfs.length === 0) {
    console.warn('[Bausch] PDF 첨부 없음 messageId=', messageId);
    return 'failed';
  }

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
        logBauschPdfError({
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
      continue;
    }

    let parsed;
    try {
      parsed = await parseBauschInvoicePdf(buffer, { attachmentFileName: filename });
    } catch (err) {
      hadFailure = true;
      logBauschPdfError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `PDF open: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }

    for (const pe of parsed.pageErrors) {
      hadFailure = true;
      logBauschPdfError({
        messageId,
        attachmentFilename: filename,
        page: pe.page,
        error: pe.error
      });
    }

    for (const inv of parsed.invoices) {
      try {
        if (!inv.fields?.invoiceNumber || !inv.fields?.invoiceDate) {
          throw new Error('invoiceNumber/invoiceDate 추출 실패');
        }
        if (inv.fields?.documentKind === 'supplier_credit_note') {
          await ensureBauschSupplierCreditAndAttach({
            fields: inv.fields,
            pagePdfBuffer: buffer,
            attachmentFileName: filename
          });
        } else {
          await ensureBauschAccPayAndAttach({
            fields: inv.fields,
            pagePdfBuffer: buffer,
            attachmentFileName: filename
          });
        }
      } catch (err) {
        hadFailure = true;
        console.error(
          '[Bausch Xero error]',
          JSON.stringify({
            messageId,
            attachmentFilename: filename,
            page: inv.page,
            invoiceNumber: inv.fields?.invoiceNumber || null,
            billToNumber: inv.fields?.billToNumber || null,
            error: err instanceof Error ? err.message : String(err),
            xero: err?.response?.data || null
          })
        );
      }
    }
  }

  return hadFailure ? 'failed' : 'success';
}

export async function runBauschGmailPipeline(parsed) {
  const userEmail = parsed?.gmail?.emailAddress;
  const newHistoryId = parsed?.gmail?.historyId;
  if (!userEmail || !newHistoryId) return;

  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error('[Bausch] Gmail 클라이언트:', e.message);
    return;
  }

  const last = await getLastHistoryId(userEmail);
  const messageIds = await collectMessageIdsSinceHistoryForPayables(gmail, userEmail, last);
  if (messageIds.size === 0) {
    await setLastHistoryId(userEmail, newHistoryId);
    return;
  }

  let batchFailed = false;
  for (const id of messageIds) {
    if (await hasProcessedBauschMessageId(userEmail, id)) continue;
    try {
      const outcome = await processBauschGmailMessage(gmail, id, userEmail);
      if (outcome === 'failed') {
        batchFailed = true;
        continue;
      }
      if (outcome === 'success' || outcome === 'orphan') {
        await addProcessedBauschMessageId(userEmail, id);
      }
    } catch (err) {
      if (isGmailRequestedEntityNotFound(err)) {
        await addProcessedBauschMessageId(userEmail, id);
        continue;
      }
      batchFailed = true;
    }
  }

  if (!batchFailed) await setLastHistoryId(userEmail, newHistoryId);
}
