/**
 * Hoya Daily Combined 메일 처리
 *
 * - 메일 1통에 PDF 첨부가 **여러 개**일 수 있음 → **각 PDF마다** 순차 처리
 * - 각 PDF는 **여러 페이지**일 수 있음 → **페이지 1장 = 인보이스 1건** (파싱 + Xero Bill + 해당 페이지 PDF 첨부)
 * - 같은 메일 안에서 ref|date 중복은 스킵 (seenKeysThisMessage)
 */
import { createPayableGmailClient } from './gmailPayableAuth.js';
import {
  getLastHistoryId,
  setLastHistoryId,
  hasProcessedMessageId,
  addProcessedMessageId,
  hasProcessedInvoiceKey,
  addProcessedInvoiceKey,
  makeInvoiceKey
} from './gmailHistoryState.js';
import { parseHoyaCombinedPdf } from './hoyaPdfParser.js';
import { splitPdfToSinglePageBuffers } from './pdfSplit.js';
import { ensureHoyaAccPayAndAttach } from './xeroHoyaBills.js';

function sanitizeForFileRef(ref) {
  return String(ref).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

/** 여러 PDF에 같은 ref·페이지 조합이 드물게 겹칠 때 첨부 파일명 구분용 */
function attachmentNamePrefixFromFilename(filename) {
  const base = String(filename || 'pdf')
    .replace(/^.*[/\\]/, '')
    .replace(/\.pdf$/i, '');
  return sanitizeForFileRef(base).slice(0, 60);
}

const HOYA_FROM = /axd365au@hoya\.com/i;
const DAILY_COMBINED_SUBJECT = /Daily\s+Combined\s+Invoice/i;

function getHeader(headers, name) {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function collectPdfAttachments(part, acc) {
  if (!part) return;
  const mime = part.mimeType || '';
  const filename = part.filename || '';
  if ((mime === 'application/pdf' || /\.pdf$/i.test(filename)) && part.body?.attachmentId) {
    acc.push({ attachmentId: part.body.attachmentId, filename: filename || 'attachment.pdf' });
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectPdfAttachments(p, acc);
  }
}

function isHoyaDailyCombinedInvoice(headers) {
  const subj = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  return DAILY_COMBINED_SUBJECT.test(subj) && HOYA_FROM.test(from);
}

function logPdfParseError({ messageId, attachmentFilename, page, error }) {
  console.error(
    '[Hoya PDF error]',
    JSON.stringify({
      messageId,
      attachmentFilename,
      page: page ?? null,
      error
    })
  );
}

async function listRecentHoyaFallback(gmail, ids) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'from:axd365au@hoya.com subject:"Daily Combined Invoice" newer_than:14d',
    maxResults: 20
  });
  for (const m of res.data.messages || []) {
    if (m.id) ids.add(m.id);
  }
}

/**
 * @param {{ skipInvoiceDedupe?: boolean, skipPersistInvoiceKeys?: boolean }} [options]
 *   skipInvoiceDedupe — 이미 처리된 ref|date 인보이스도 다시 시도 (수동 테스트용)
 *   skipPersistInvoiceKeys — 성공해도 processedInvoiceKeys 에 저장하지 않음
 * @returns {Promise<boolean>} true = 이 메일은 완전히 끝났고 messageId 저장해도 됨
 */
async function processOneMessage(gmail, messageId, userEmail, options = {}) {
  const skipInvoiceDedupe = Boolean(options.skipInvoiceDedupe);
  const skipPersistInvoiceKeys = Boolean(options.skipPersistInvoiceKeys);
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  const headers = full.data.payload?.headers || [];
  if (!isHoyaDailyCombinedInvoice(headers)) {
    return true;
  }

  const pdfs = [];
  collectPdfAttachments(full.data.payload, pdfs);
  if (pdfs.length === 0) {
    console.warn('[Hoya] PDF 첨부 없음 messageId=', messageId);
    return false;
  }

  const subj = getHeader(headers, 'Subject');
  console.log('[Hoya] 처리:', subj, 'messageId=', messageId, 'pdf첨부개수=', pdfs.length);
  if (pdfs.length > 0) {
    console.log('[Hoya] PDF 파일:', pdfs.map((p) => p.filename));
  }

  /** 메일 단위 성공 후에만 DB에 씀 (중간 실패 시 인보이스 키도 남기지 않음) */
  const invoiceKeysToPersist = new Set();
  /** 이번 메일 안에서 이미 잡은 ref|date (같은 PDF/페이지 중복 방지) */
  const seenKeysThisMessage = new Set();

  for (const { attachmentId, filename } of pdfs) {
    let buffer;
    try {
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId
      });
      const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
      buffer = Buffer.from(b64, 'base64');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `attachment download: ${msg}`
      });
      return false;
    }

    let parsed;
    try {
      parsed = await parseHoyaCombinedPdf(buffer, { attachmentFileName: filename });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `PDF open: ${msg}`
      });
      return false;
    }

    for (const pe of parsed.pageErrors) {
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: pe.page,
        error: pe.error
      });
    }
    if (parsed.pageErrors.length > 0) {
      return false;
    }

    let pageBuffers;
    try {
      pageBuffers = await splitPdfToSinglePageBuffers(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `pdf-lib split: ${msg}`
      });
      return false;
    }

    if (pageBuffers.length !== parsed.invoices.length) {
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `페이지 수 불일치: split=${pageBuffers.length} parse=${parsed.invoices.length}`
      });
      return false;
    }

    for (const inv of parsed.invoices) {
      const ref = inv.referenceNumber;
      const dt = inv.invoiceDate;
      if (!ref || !dt) {
        logPdfParseError({
          messageId,
          attachmentFilename: filename,
          page: inv.page,
          error: 'referenceNumber 또는 invoiceDate 없음 (Xero bill 불가)'
        });
        return false;
      }

      const key = makeInvoiceKey(ref, dt);
      if (seenKeysThisMessage.has(key)) {
        console.log(
          '[Hoya invoice skip duplicate]',
          JSON.stringify({
            messageId,
            referenceNumber: ref,
            invoiceDate: dt,
            page: inv.page,
            reason: 'same_mail_duplicate'
          })
        );
        continue;
      }
      if (
        !skipInvoiceDedupe &&
        (await hasProcessedInvoiceKey(userEmail, key))
      ) {
        console.log(
          '[Hoya invoice skip duplicate]',
          JSON.stringify({
            messageId,
            referenceNumber: ref,
            invoiceDate: dt,
            page: inv.page,
            reason: 'already_processed'
          })
        );
        continue;
      }

      const pageIdx = inv.page - 1;
      const pagePdf = pageBuffers[pageIdx];
      const srcPrefix = attachmentNamePrefixFromFilename(filename);
      const attachName = `${srcPrefix}_${sanitizeForFileRef(ref)}_p${inv.page}.pdf`;

      try {
        await ensureHoyaAccPayAndAttach({
          referenceNumber: ref,
          invoiceDateStr: dt,
          soldTo: inv.soldTo,
          storeLine: inv.storeLine,
          fullPageText: inv.rawText,
          lineItems: inv.lineItems,
          pagePdfBuffer: pagePdf,
          attachmentFileName: attachName
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const xero = err.response?.data;
        console.error(
          '[Hoya Xero error]',
          JSON.stringify({
            messageId,
            attachmentFilename: filename,
            page: inv.page,
            referenceNumber: ref,
            error: msg,
            xero: xero || null
          })
        );
        return false;
      }

      seenKeysThisMessage.add(key);
      invoiceKeysToPersist.add(key);

      console.log(
        '[Hoya] 페이지 처리 완료 (파싱 + Xero 첨부)',
        filename,
        'page',
        inv.page,
        JSON.stringify(
          {
            referenceNumber: inv.referenceNumber,
            invoiceDate: inv.invoiceDate,
            storeLine: inv.storeLine,
            soldTo: inv.soldTo,
            lineItems: inv.lineItems
          },
          null,
          2
        )
      );
    }
  }

  if (!skipPersistInvoiceKeys) {
    for (const key of invoiceKeysToPersist) {
      await addProcessedInvoiceKey(userEmail, key);
    }
  } else if (invoiceKeysToPersist.size > 0) {
    console.log(
      '[Hoya] skipPersistInvoiceKeys — 인보이스 키 DB 저장 생략',
      [...invoiceKeysToPersist]
    );
  }

  return true;
}

/**
 * 수동/스크립트에서 특정 messageId 만 처리할 때 사용
 * @param {*} gmail google.gmail v1 클라이언트
 * @param {string} messageId
 * @param {string} userEmail
 * @param {{ skipInvoiceDedupe?: boolean, skipPersistInvoiceKeys?: boolean }} [options]
 */
export async function processHoyaGmailMessage(gmail, messageId, userEmail, options) {
  return processOneMessage(gmail, messageId, userEmail, options);
}

/**
 * Pub/Sub 알림 후: history.list 로 신규 메일 → Hoya Daily Combined + PDF 파싱
 * historyId 는 배치 전부 성공 시에만 갱신 (중간 실패 시 다음 푸시에서 재시도)
 * @param {{ gmail?: { emailAddress?: string, historyId?: string } }} parsed
 */
export async function runHoyaGmailPipeline(parsed) {
  const userEmail = parsed?.gmail?.emailAddress;
  const newHistoryId = parsed?.gmail?.historyId;
  if (!userEmail || !newHistoryId) return;

  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error('[Hoya] Gmail 클라이언트:', e.message);
    return;
  }

  const messageIds = new Set();
  const last = await getLastHistoryId(userEmail);

  if (last) {
    try {
      let pageToken;
      do {
        const hist = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: last,
          pageToken,
          historyTypes: ['messageAdded']
        });

        for (const h of hist.data.history || []) {
          for (const added of h.messagesAdded || []) {
            if (added.message?.id) messageIds.add(added.message.id);
          }
        }
        pageToken = hist.data.nextPageToken || undefined;
      } while (pageToken);
    } catch (e) {
      const status = e.response?.status || e.code;
      if (status === 404) {
        console.warn('[Hoya Gmail] history 404 — 최근 메일로 대체 조회');
        await listRecentHoyaFallback(gmail, messageIds);
      } else {
        throw e;
      }
    }
  } else {
    await listRecentHoyaFallback(gmail, messageIds);
  }

  if (messageIds.size === 0) {
    console.log('[Hoya] 신규 메시지 없음 → historyId 갱신만 수행', newHistoryId);
    await setLastHistoryId(userEmail, newHistoryId);
    return;
  }

  let batchFailed = false;

  for (const id of messageIds) {
    if (await hasProcessedMessageId(userEmail, id)) {
      console.log('[Hoya] skip duplicate messageId=', id);
      continue;
    }

    try {
      const ok = await processOneMessage(gmail, id, userEmail);
      if (!ok) {
        batchFailed = true;
        continue;
      }
      await addProcessedMessageId(userEmail, id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Hoya] message 실패', id, msg);
      batchFailed = true;
    }
  }

  if (!batchFailed) {
    await setLastHistoryId(userEmail, newHistoryId);
    console.log('[Hoya] 배치 성공 → lastHistoryId=', newHistoryId);
  } else {
    console.warn(
      '[Hoya] 배치에 실패 포함 → lastHistoryId 유지 (재시도 가능). 새 값=',
      newHistoryId
    );
  }
}
