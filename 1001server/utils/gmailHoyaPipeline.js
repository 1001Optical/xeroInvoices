/**
 * Hoya Daily Combined 메일 처리
 *
 * - 메일 1통에 PDF 첨부가 **여러 개**일 수 있음 → **각 PDF마다** 순차 처리
 * - 각 PDF는 **여러 페이지**일 수 있음 → **페이지 1장 = 인보이스 1건** (파싱 + Xero Bill 또는 Supplier Credit + 해당 페이지 PDF 첨부)
 * - 같은 메일 안에서 ref|date 중복은 스킵 (seenKeysThisMessage)
 * - 한 PDF에서 실패해도 **다음 PDF**는 계속 시도 (예전에는 첫 실패 시 return false 로 뒤 첨부 미처리)
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
import {
  ensureHoyaAccPayAndAttach,
  ensureHoyaSupplierCreditAndAttach
} from './xeroHoyaBills.js';

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

/** Gmail API body.data (base64url) → Buffer */
function decodeGmailBodyData(data) {
  if (data == null || data === '') return null;
  try {
    const b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

function looksLikePdfPart(part) {
  const mime = String(part.mimeType || '').toLowerCase();
  const fn = String(part.filename || '');
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return true;
  if (/-pdf|\/pdf$/i.test(mime)) return true;
  if (/\.pdf$/i.test(fn)) return true;
  if (
    (mime === 'application/octet-stream' ||
      mime === 'binary/octet-stream' ||
      mime === 'application/force-download') &&
    /\.pdf$/i.test(fn)
  ) {
    return true;
  }
  return false;
}

/** Buffer 앞부분이 PDF 인지 (앞쪽 공백 허용) — Gmail MIME 누락 시 sniff 용 */
export function bufferLooksLikePdf(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return true;
  const head = buf.slice(0, Math.min(64, buf.length)).toString('latin1');
  return /^\s*%PDF/.test(head);
}

/** 트리 순서대로 body.attachmentId 가 있는 모든 파트 (Gmail이 주는 첨부 전부) */
function collectAllAttachmentPartsInOrder(part, list) {
  if (!part) return;
  if (part.body?.attachmentId) {
    list.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename || 'attachment'
    });
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      collectAllAttachmentPartsInOrder(p, list);
    }
  }
}

function dedupeAttachmentsByIdInOrder(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (seen.has(x.attachmentId)) continue;
    seen.add(x.attachmentId);
    out.push(x);
  }
  return out;
}

/**
 * messages.get format=full 의 payload 트리에서 PDF 첨부 수집.
 * - 일반: body.attachmentId (별도 attachments.get)
 * - 인라인/일부 메일 클라이언트: body.data 만 있고 attachmentId 없음
 * - attachmentId + data 가 같이 있으면 attachmentId만 사용(중복 방지)
 */
function collectPdfAttachmentsWalk(part, acc, seenAttachmentIds) {
  if (!part) return;
  const filename = part.filename || 'attachment.pdf';

  if (looksLikePdfPart(part)) {
    const attId = part.body?.attachmentId;
    if (attId) {
      if (!seenAttachmentIds.has(attId)) {
        seenAttachmentIds.add(attId);
        acc.push({ attachmentId: attId, filename });
      }
    } else if (part.body?.data) {
      const buf = decodeGmailBodyData(part.body.data);
      if (buf && bufferLooksLikePdf(buf)) {
        acc.push({ filename, buffer: buf });
      }
    }
  }

  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      collectPdfAttachmentsWalk(p, acc, seenAttachmentIds);
    }
  }
}

/**
 * @returns {Array<{
 *   filename: string,
 *   attachmentId?: string,
 *   buffer?: Buffer,
 *   sniffPdf?: boolean
 * }>}
 */
export function collectPdfAttachmentsFromPayload(payload) {
  const primary = [];
  const seenPrimaryIds = new Set();
  collectPdfAttachmentsWalk(payload, primary, seenPrimaryIds);

  const primaryIdSet = new Set(
    primary.map((p) => p.attachmentId).filter(Boolean)
  );

  const allAttach = [];
  collectAllAttachmentPartsInOrder(payload, allAttach);
  const uniqueAttach = dedupeAttachmentsByIdInOrder(allAttach);

  const extra = [];
  for (const a of uniqueAttach) {
    if (primaryIdSet.has(a.attachmentId)) continue;
    extra.push({
      attachmentId: a.attachmentId,
      filename: a.filename,
      sniffPdf: true
    });
  }

  return [...primary, ...extra];
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
 * @returns {Promise<boolean>} true = 이 메일 전부 성공, messageId 저장해도 됨. false = 일부 실패(재시도 가능); 성공한 인보이스 키는 이미 저장됨
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

  const pdfs = collectPdfAttachmentsFromPayload(full.data.payload);
  if (pdfs.length === 0) {
    console.warn('[Hoya] PDF 첨부 없음 messageId=', messageId);
    return false;
  }

  const subj = getHeader(headers, 'Subject');
  const sniffN = pdfs.filter((p) => p.sniffPdf).length;
  const directN = pdfs.length - sniffN;
  console.log(
    '[Hoya] 처리:',
    subj,
    'messageId=',
    messageId,
    '첨부후보=',
    pdfs.length,
    sniffN > 0 ? `(MIME로 PDF확정 ${directN}, 나머지 ${sniffN}개는 다운로드 후 시그니처 확인)` : ''
  );
  if (pdfs.length > 0) {
    console.log('[Hoya] 파일:', pdfs.map((p) => p.filename));
  }

  /** 성공한 인보이스 키 — 부분 성공 시에도 저장해 재시도 시 Xero 중복 방지 */
  const invoiceKeysToPersist = new Set();
  /** 이번 메일 안에서 이미 잡은 ref|date (같은 PDF/페이지 중복 방지) */
  const seenKeysThisMessage = new Set();
  let messageHadFailure = false;

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
        messageHadFailure = true;
        logPdfParseError({
          messageId,
          attachmentFilename: filename,
          page: null,
          error: `attachment download: ${msg}`
        });
        console.warn('[Hoya] 다음 PDF 첨부 계속 시도 (다운로드 실패)', filename);
        continue;
      }
      if (item.sniffPdf && !bufferLooksLikePdf(buffer)) {
        console.log(
          '[Hoya] MIME 불명 첨부 스킵 (PDF 시그니처 아님)',
          JSON.stringify({ messageId, filename, bytes: buffer.length })
        );
        continue;
      }
    } else {
      messageHadFailure = true;
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: 'PDF 항목에 buffer·attachmentId 없음'
      });
      continue;
    }

    let parsed;
    try {
      parsed = await parseHoyaCombinedPdf(buffer, { attachmentFileName: filename });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      messageHadFailure = true;
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `PDF open: ${msg}`
      });
      console.warn('[Hoya] 다음 PDF 첨부 계속 시도 (PDF 열기 실패)', filename);
      continue;
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
      messageHadFailure = true;
      console.warn('[Hoya] 다음 PDF 첨부 계속 시도 (페이지 파싱 오류)', filename);
      continue;
    }

    let pageBuffers;
    try {
      pageBuffers = await splitPdfToSinglePageBuffers(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      messageHadFailure = true;
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `pdf-lib split: ${msg}`
      });
      console.warn('[Hoya] 다음 PDF 첨부 계속 시도 (split 실패)', filename);
      continue;
    }

    if (pageBuffers.length !== parsed.invoices.length) {
      messageHadFailure = true;
      logPdfParseError({
        messageId,
        attachmentFilename: filename,
        page: null,
        error: `페이지 수 불일치: split=${pageBuffers.length} parse=${parsed.invoices.length}`
      });
      console.warn('[Hoya] 다음 PDF 첨부 계속 시도 (페이지 수 불일치)', filename);
      continue;
    }

    for (const inv of parsed.invoices) {
      const ref = inv.referenceNumber;
      const dt = inv.invoiceDate;
      if (!ref || !dt) {
        messageHadFailure = true;
        logPdfParseError({
          messageId,
          attachmentFilename: filename,
          page: inv.page,
          error: 'referenceNumber 또는 invoiceDate 없음 (Xero bill 불가)'
        });
        continue;
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

      const xeroOpts = {
        referenceNumber: ref,
        invoiceDateStr: dt,
        soldTo: inv.soldTo,
        storeLine: inv.storeLine,
        fullPageText: inv.rawText,
        lineItems: inv.lineItems,
        pagePdfBuffer: pagePdf,
        attachmentFileName: attachName
      };
      try {
        if (inv.documentKind === 'supplier_credit_note') {
          await ensureHoyaSupplierCreditAndAttach(xeroOpts);
        } else {
          await ensureHoyaAccPayAndAttach(xeroOpts);
        }
      } catch (err) {
        messageHadFailure = true;
        const msg = err instanceof Error ? err.message : String(err);
        const xero = err.response?.data;
        console.error(
          '[Hoya Xero error]',
          JSON.stringify({
            messageId,
            attachmentFilename: filename,
            page: inv.page,
            referenceNumber: ref,
            documentKind: inv.documentKind || 'supplier_invoice',
            error: msg,
            xero: xero || null
          })
        );
        console.warn('[Hoya] 이 페이지 건너뜀, 같은 메일의 다른 PDF·페이지 계속');
        continue;
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
            documentKind: inv.documentKind,
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

  if (messageHadFailure) {
    console.warn(
      '[Hoya] 메일 일부 실패 — messageId 재처리 가능, 성공분 인보이스 키는 이미 저장됨',
      messageId
    );
    return false;
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
