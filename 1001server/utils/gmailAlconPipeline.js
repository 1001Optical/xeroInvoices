/**
 * Alcon TAX INVOICE 메일 — PDF 텍스트 추출·파싱만 (Xero/매핑은 추후).
 * 제목: Your Alcon TAX INVOICE, 발신: my.accounts@alcon.com
 * PDF: 파일당 1페이지·1인보이스 (호야 multi-page combined 와 다름).
 */
import { createPayableGmailClient } from './gmailPayableAuth.js';
import {
  getLastHistoryId,
  setLastHistoryId,
  hasProcessedAlconMessageId,
  addProcessedAlconMessageId
} from './gmailHistoryState.js';
import { collectMessageIdsSinceHistoryForPayables } from './gmailPayableHistorySync.js';
import { parseAlconTaxInvoicePdf } from './alconPdfParser.js';
import {
  ensureAlconAccPayAndAttach,
  ensureAlconSupplierCreditAndAttach
} from './xeroAlconBills.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload
} from './gmailHoyaPipeline.js';
import { isGmailRequestedEntityNotFound } from './gmailApiErrors.js';

/** Gmail From 표시명 기준 고정: "Alcon Laboratories (Australia) Pty Ltd*" */
const ALCON_FROM = /Alcon\s+Laboratories\s+\(Australia\)\s+Pty\s+Ltd\*?/i;
const ALCON_FROM_EMAIL = /my\.accounts@alcon\.com/i;
const ALCON_TAX_INVOICE_SUBJECT = /Your\s+Alcon\s+TAX\s+INVOICE/i;

function getHeader(headers, name) {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function isAlconTaxInvoiceMail(headers) {
  const subj = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  const subjectOk = ALCON_TAX_INVOICE_SUBJECT.test(subj);
  const fromOk = ALCON_FROM.test(from) || ALCON_FROM_EMAIL.test(from);
  return subjectOk && fromOk;
}

function logAlconPdfError({ messageId, attachmentFilename, page, error }) {
  console.error(
    '[Alcon PDF]',
    JSON.stringify({
      messageId,
      attachmentFilename,
      page: page ?? null,
      error
    })
  );
}

/**
 * @typedef {'skipped' | 'success' | 'failed' | 'orphan'} AlconProcessOutcome
 *   orphan — Gmail messages.get 404 (삭제·고아 history ID)
 */

/**
 * @returns {Promise<AlconProcessOutcome>}
 *   skipped — 알콘 인보이스 메일 아님
 *   success — 알콘 메일이고 첨부 PDF 파싱 + Xero 업로드 완료
 *   failed — 알콘 메일인데 PDF 없음·다운로드/파싱 오류
 *   orphan — 메시지 ID 가 Gmail 에 없음 (404)
 */
export async function processAlconGmailMessage(gmail, messageId, userEmail) {
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
      console.warn('[Alcon] messages.get 404 건너뜀', messageId);
      return 'orphan';
    }
    throw err;
  }

  const headers = full.data.payload?.headers || [];
  if (!isAlconTaxInvoiceMail(headers)) {
    console.log(
      '[Alcon] skip (header mismatch)',
      JSON.stringify({
        messageId,
        subject: getHeader(headers, 'Subject'),
        from: getHeader(headers, 'From')
      })
    );
    return 'skipped';
  }

  const pdfs = collectPdfAttachmentsFromPayload(full.data.payload);
  if (pdfs.length === 0) {
    console.warn('[Alcon] PDF 첨부 없음 messageId=', messageId);
    return 'failed';
  }

  const subj = getHeader(headers, 'Subject');
  console.log(
    '[Alcon] 처리:',
    subj,
    'messageId=',
    messageId,
    '첨부후보=',
    pdfs.length
  );
  console.log('[Alcon] 파일:', pdfs.map((p) => p.filename));

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
        const msg = err instanceof Error ? err.message : String(err);
        hadFailure = true;
        logAlconPdfError({
          messageId,
          attachmentFilename: filename,
          page: null,
          error: `attachment download: ${msg}`
        });
        continue;
      }
      if (item.sniffPdf && !bufferLooksLikePdf(buffer)) {
        console.log(
          '[Alcon] MIME 불명 첨부 스킵 (PDF 시그니처 아님)',
          JSON.stringify({ messageId, filename, bytes: buffer.length })
        );
        continue;
      }
    } else {
      hadFailure = true;
      logAlconPdfError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: 'PDF 항목에 buffer·attachmentId 없음'
      });
      continue;
    }

    let parsed;
    try {
      parsed = await parseAlconTaxInvoicePdf(buffer, { attachmentFileName: filename });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hadFailure = true;
      logAlconPdfError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `PDF open: ${msg}`
      });
      continue;
    }

    for (const pe of parsed.pageErrors) {
      hadFailure = true;
      logAlconPdfError({
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
          await ensureAlconSupplierCreditAndAttach(opts);
        } else {
          await ensureAlconAccPayAndAttach(opts);
        }
      } catch (err) {
        hadFailure = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          '[Alcon Xero error]',
          JSON.stringify({
            messageId,
            attachmentFilename: filename,
            page: inv.page,
            invoiceNumber: inv.fields?.invoiceNumber || null,
            billToNumber: inv.fields?.billToNumber || null,
            documentKind: inv.fields?.documentKind || 'supplier_invoice',
            error: msg,
            xero: err.response?.data || null
          })
        );
      }
    }
  }

  if (hadFailure) {
    console.warn('[Alcon] 메일 일부 실패 messageId=', messageId);
    return 'failed';
  }
  return 'success';
}

/**
 * 단독 실행용 (스크립트). Pub/Sub 에서는 runPayableGmailPipelines 사용 권장.
 */
export async function runAlconGmailPipeline(parsed) {
  const userEmail = parsed?.gmail?.emailAddress;
  const newHistoryId = parsed?.gmail?.historyId;
  if (!userEmail || !newHistoryId) return;

  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error('[Alcon] Gmail 클라이언트:', e.message);
    return;
  }

  const last = await getLastHistoryId(userEmail);
  const messageIds = await collectMessageIdsSinceHistoryForPayables(
    gmail,
    userEmail,
    last
  );

  if (messageIds.size === 0) {
    console.log('[Alcon] 신규 메시지 없음 → historyId 갱신만 수행', newHistoryId);
    await setLastHistoryId(userEmail, newHistoryId);
    return;
  }

  let batchFailed = false;

  for (const id of messageIds) {
    if (await hasProcessedAlconMessageId(userEmail, id)) {
      console.log('[Alcon] skip duplicate messageId=', id);
      continue;
    }

    try {
      const outcome = await processAlconGmailMessage(gmail, id, userEmail);
      if (outcome === 'skipped') {
        continue;
      }
      if (outcome === 'orphan') {
        await addProcessedAlconMessageId(userEmail, id);
        continue;
      }
      if (outcome === 'failed') {
        batchFailed = true;
        continue;
      }
      await addProcessedAlconMessageId(userEmail, id);
    } catch (err) {
      if (isGmailRequestedEntityNotFound(err)) {
        console.warn('[Alcon] message 건너뜀 (Gmail 404)', id);
        await addProcessedAlconMessageId(userEmail, id);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Alcon] message 실패', id, msg);
      batchFailed = true;
    }
  }

  if (!batchFailed) {
    await setLastHistoryId(userEmail, newHistoryId);
    console.log('[Alcon] 배치 성공 → lastHistoryId=', newHistoryId);
  } else {
    console.warn(
      '[Alcon] 배치에 실패 포함 → lastHistoryId 유지 (재시도 가능). 새 값=',
      newHistoryId
    );
  }
}
