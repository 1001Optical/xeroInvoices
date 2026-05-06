import axios from 'axios';
import { getAccessToken, getTenantIdForEntity } from './xero.js';

const API = 'https://api.xero.com/api.xro/2.0';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_INVOICE = 10;

function sanitizeReferenceForXero(ref) {
  return String(ref || '').replace(/\s+/g, ' ').trim().slice(0, 255);
}

function sanitizeAttachmentFileName(name) {
  return String(name || 'attachment.pdf')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function parseInvoiceDateToXero(dateStr) {
  const s = String(dateStr || '').trim();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) throw new Error(`인보이스 날짜 파싱 실패: ${dateStr}`);
  let d = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function alconExpenseAccountCode() {
  const c =
    process.env.ALCON_XERO_EXPENSE_ACCOUNT_CODE ||
    process.env.HOYA_XERO_EXPENSE_ACCOUNT_CODE ||
    '51103';
  return String(c).trim();
}

function alconFreightAccountCode() {
  const c = process.env.ALCON_XERO_FREIGHT_ACCOUNT_CODE || alconExpenseAccountCode();
  return String(c).trim();
}

function mapTaxTypeToXeroCode(taxType, gstAmount) {
  const raw = String(taxType || '').trim();
  if (!raw) return Number(gstAmount || 0) > 0 ? 'INPUT' : 'EXEMPTEXPENSES';
  const key = raw.toLowerCase();
  if (key === 'gst free expenses' || key === 'exemptexpenses') return 'EXEMPTEXPENSES';
  if (key === 'gst on expenses' || key === 'input') return 'INPUT';
  return raw;
}

function buildTrackingForStore(storeName) {
  const trackingCategoryName =
    process.env.ALCON_XERO_TRACKING_CATEGORY_NAME?.trim() ||
    process.env.HOYA_XERO_TRACKING_CATEGORY_NAME?.trim() ||
    '';
  const trackingCategoryId =
    process.env.ALCON_XERO_TRACKING_CATEGORY_ID?.trim() ||
    process.env.HOYA_XERO_TRACKING_CATEGORY_ID?.trim() ||
    '';
  const option = String(storeName || '').trim();
  if (!trackingCategoryName || !option) return {};
  const row = {
    Name: trackingCategoryName,
    Option: option.slice(0, 100)
  };
  if (trackingCategoryId) row.TrackingCategoryID = trackingCategoryId;
  return { Tracking: [row] };
}

async function findContactIdByName(accessToken, tenantId, name) {
  const safe = String(name || '').replace(/"/g, '');
  if (!safe) return null;
  const where = `Name=="${safe}"`;
  const url = `${API}/Contacts?where=${encodeURIComponent(where)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.Contacts || [];
  return list[0]?.ContactID || null;
}

async function findContactIdByEmail(accessToken, tenantId, email) {
  const safe = String(email || '').trim().replace(/"/g, '');
  if (!safe) return null;
  const where = `EmailAddress=="${safe}"`;
  const url = `${API}/Contacts?where=${encodeURIComponent(where)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.Contacts || [];
  return list[0]?.ContactID || null;
}

function parseAlconContactIdByEntityMap() {
  const raw = process.env.ALCON_XERO_CONTACT_ID_BY_ENTITY?.trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

async function resolveAlconSupplierContactId(accessToken, tenantId, entityName) {
  const byEntity = parseAlconContactIdByEntityMap();
  if (byEntity[entityName]) return String(byEntity[entityName]).trim();

  const globalId = process.env.ALCON_XERO_CONTACT_ID?.trim();
  if (globalId) return globalId;

  const name =
    process.env.ALCON_XERO_CONTACT_NAME?.trim() || 'Alcon Laboratories (Australia) Pty Ltd';
  const found = await findContactIdByName(accessToken, tenantId, name);
  if (found) return found;
  const byEmail = await findContactIdByEmail(
    accessToken,
    tenantId,
    process.env.ALCON_FROM_EMAIL?.trim() || 'my.accounts@alcon.com'
  );
  if (byEmail) return byEmail;
  throw new Error(
    `Alcon 공급처 Contact를 찾을 수 없습니다. ALCON_XERO_CONTACT_ID 또는 ALCON_XERO_CONTACT_ID_BY_ENTITY 설정 필요 (entity=${entityName})`
  );
}

async function findAccPayByInvoiceNumber(accessToken, tenantId, invoiceNumber) {
  const ref = sanitizeReferenceForXero(invoiceNumber);
  if (!ref) return null;
  const where = `InvoiceNumber=="${ref.replace(/"/g, '')}"`;
  const url = `${API}/Invoices?where=${encodeURIComponent(where)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.Invoices || [];
  return list.find((x) => x.Type === 'ACCPAY' && sanitizeReferenceForXero(x.InvoiceNumber) === ref) || null;
}

async function findSupplierCreditByCreditNoteNumber(accessToken, tenantId, creditNoteNumber) {
  const ref = sanitizeReferenceForXero(creditNoteNumber);
  if (!ref) return null;
  const where = `CreditNoteNumber=="${ref.replace(/"/g, '')}"`;
  const url = `${API}/CreditNotes?where=${encodeURIComponent(where)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.CreditNotes || [];
  return (
    list.find(
      (x) =>
        x.Type === 'ACCPAYCREDIT' &&
        sanitizeReferenceForXero(x.CreditNoteNumber) === ref
    ) || null
  );
}

async function createAccPayInvoice(accessToken, tenantId, body) {
  const res = await axios.post(
    `${API}/Invoices`,
    { Invoices: [body] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );
  const inv = res.data?.Invoices?.[0];
  if (!inv?.InvoiceID) throw new Error('Xero 인보이스 생성 응답에 InvoiceID 없음');
  return inv;
}

async function getInvoiceDetail(accessToken, tenantId, invoiceId) {
  const res = await axios.get(`${API}/Invoices/${invoiceId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  return res.data?.Invoices?.[0] || null;
}

async function createSupplierCreditNote(accessToken, tenantId, body) {
  const res = await axios.post(
    `${API}/CreditNotes`,
    { CreditNotes: [body] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );
  const cn = res.data?.CreditNotes?.[0];
  if (!cn?.CreditNoteID) throw new Error('Xero CreditNote 생성 응답에 CreditNoteID 없음');
  return cn;
}

async function getCreditNoteDetail(accessToken, tenantId, creditNoteId) {
  const res = await axios.get(`${API}/CreditNotes/${creditNoteId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  return res.data?.CreditNotes?.[0] || null;
}

function xeroAlreadyHasAttachmentNamed(attachments, uploadFileName) {
  const want = sanitizeAttachmentFileName(uploadFileName);
  return (attachments || []).some((a) => {
    const fn = a?.FileName != null ? String(a.FileName) : '';
    return sanitizeAttachmentFileName(fn) === want;
  });
}

async function uploadInvoicePdfAttachment(accessToken, tenantId, invoiceId, fileName, pdfBuffer) {
  if (pdfBuffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`PDF가 25MB 초과: ${pdfBuffer.length} bytes`);
  }
  const safeName = sanitizeAttachmentFileName(fileName);
  const url = `${API}/Invoices/${invoiceId}/Attachments/${encodeURIComponent(safeName)}`;
  await axios.put(url, pdfBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/pdf'
    },
    maxBodyLength: MAX_ATTACHMENT_BYTES + 1,
    maxContentLength: MAX_ATTACHMENT_BYTES + 1
  });
}

async function uploadCreditNotePdfAttachment(accessToken, tenantId, creditNoteId, fileName, pdfBuffer) {
  if (pdfBuffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`PDF가 25MB 초과: ${pdfBuffer.length} bytes`);
  }
  const safeName = sanitizeAttachmentFileName(fileName);
  const url = `${API}/CreditNotes/${creditNoteId}/Attachments/${encodeURIComponent(safeName)}`;
  await axios.put(url, pdfBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/pdf'
    },
    maxBodyLength: MAX_ATTACHMENT_BYTES + 1,
    maxContentLength: MAX_ATTACHMENT_BYTES + 1
  });
}

function buildXeroLineItems(fields, referenceNumber, { forCredit = false } = {}) {
  const src = Array.isArray(fields?.lineItemsForXero) ? fields.lineItemsForXero : [];
  const tracking = buildTrackingForStore(fields?.matchedBranchName);
  const out = src
    .filter((li) => li && Number(li.qty || 0) > 0)
    .map((li) => {
      const qty = Number(li.qty || 1) || 1;
      const gst = Math.abs(Number(li.gst || 0));
      const amountInclRaw = Number(li.amountDueInclGst || 0);
      const amountIncl = forCredit ? Math.abs(amountInclRaw) : amountInclRaw;
      const netLineAmount = amountIncl !== 0 ? amountIncl - gst : 0;
      let unitAmount = qty > 0 ? netLineAmount / qty : netLineAmount;
      if (!(unitAmount > 0)) {
        const fallback = Number(li.extendedPriceExGst || li.unitPriceExGst || 0);
        unitAmount = forCredit ? Math.abs(fallback) : fallback;
      }
      const accountCode =
        li.lineKind === 'freight' ? alconFreightAccountCode() : alconExpenseAccountCode();
      return {
        Description: String(li.productDescription || referenceNumber).slice(0, 4000),
        Quantity: qty,
        UnitAmount: Number(unitAmount || 0),
        AccountCode: accountCode,
        TaxType: mapTaxTypeToXeroCode(li.taxType, gst),
        ...tracking
      };
    });

  if (out.length > 0) return out;
  return [
    {
      Description: `Alcon ${forCredit ? 'supplier credit' : 'invoice'} — ${referenceNumber}`.slice(0, 4000),
      Quantity: 1,
      UnitAmount: Math.abs(Number(fields?.total || 0)),
      AccountCode: alconExpenseAccountCode(),
      TaxType: mapTaxTypeToXeroCode(fields?.xeroDefaults?.taxFreeCode, 0),
      ...tracking
    }
  ];
}

/**
 * @param {{
 *   fields: Record<string, any>,
 *   pagePdfBuffer: Buffer,
 *   attachmentFileName: string
 * }} opts
 */
export async function ensureAlconAccPayAndAttach(opts) {
  const { fields, pagePdfBuffer, attachmentFileName } = opts;
  const entityName = fields?.matchedEntity;
  if (!entityName) {
    throw new Error(`Bill To 계정 매칭 실패: ${fields?.billToNumber || '(없음)'}`);
  }

  const referenceNumber = sanitizeReferenceForXero(fields?.invoiceNumber);
  if (!referenceNumber) throw new Error('invoiceNumber 없음');
  const invoiceDate = parseInvoiceDateToXero(fields?.invoiceDate);
  const dueDate = fields?.paymentDueOn
    ? parseInvoiceDateToXero(fields.paymentDueOn)
    : invoiceDate;

  const accessToken = await getAccessToken(entityName);
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);

  const contactId = await resolveAlconSupplierContactId(accessToken, tenantId, entityName);
  const lineItems = buildXeroLineItems(fields, referenceNumber);
  if (lineItems.some((x) => !x.AccountCode)) {
    throw new Error('Alcon line item AccountCode 비어 있음');
  }

  let existing = await findAccPayByInvoiceNumber(accessToken, tenantId, referenceNumber);
  let invoiceId;
  if (existing?.InvoiceID) {
    invoiceId = existing.InvoiceID;
    console.log('[Alcon Xero] ACCPAY 기존 건 재사용', { invoiceId, referenceNumber, entityName });
  } else {
    const created = await createAccPayInvoice(accessToken, tenantId, {
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: invoiceDate,
      DueDate: dueDate,
      InvoiceNumber: referenceNumber,
      CurrencyCode: fields?.currency || 'AUD',
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems
    });
    invoiceId = created.InvoiceID;
    console.log('[Alcon Xero] ACCPAY 생성', { invoiceId, referenceNumber, entityName, lines: lineItems.length });
  }

  const detail = await getInvoiceDetail(accessToken, tenantId, invoiceId);
  const attCount = detail?.Attachments?.length ?? 0;
  if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
    throw new Error(`인보이스 ${invoiceId} 첨부 ${attCount}개 — 최대 ${MAX_ATTACHMENTS_PER_INVOICE}개`);
  }
  if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) {
    console.log('[Alcon Xero] 동일 첨부 파일명 존재 — 업로드 스킵', { invoiceId, attachmentFileName });
    return;
  }
  await uploadInvoicePdfAttachment(
    accessToken,
    tenantId,
    invoiceId,
    attachmentFileName,
    pagePdfBuffer
  );
  console.log('[Alcon Xero] 첨부 업로드', {
    invoiceId,
    referenceNumber,
    file: sanitizeAttachmentFileName(attachmentFileName),
    bytes: pagePdfBuffer.length
  });
}

/**
 * Alcon 반품/마이너스 PDF → Xero Supplier Credit (ACCPAYCREDIT) 생성/첨부.
 * CreditNotes API는 금액을 양수 라인으로 받으므로 PDF의 음수 금액은 절대값으로 변환한다.
 * @param {Parameters<typeof ensureAlconAccPayAndAttach>[0]} opts
 */
export async function ensureAlconSupplierCreditAndAttach(opts) {
  const { fields, pagePdfBuffer, attachmentFileName } = opts;
  const entityName = fields?.matchedEntity;
  if (!entityName) {
    throw new Error(`Bill To 계정 매칭 실패: ${fields?.billToNumber || '(없음)'}`);
  }

  const referenceNumber = sanitizeReferenceForXero(fields?.invoiceNumber);
  if (!referenceNumber) throw new Error('invoiceNumber 없음');
  const invoiceDate = parseInvoiceDateToXero(fields?.invoiceDate);
  const dueDate = fields?.paymentDueOn
    ? parseInvoiceDateToXero(fields.paymentDueOn)
    : invoiceDate;

  const accessToken = await getAccessToken(entityName);
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);

  const contactId = await resolveAlconSupplierContactId(accessToken, tenantId, entityName);
  const lineItems = buildXeroLineItems(fields, referenceNumber, { forCredit: true });
  if (lineItems.some((x) => !x.AccountCode)) {
    throw new Error('Alcon credit line item AccountCode 비어 있음');
  }

  let existing = await findSupplierCreditByCreditNoteNumber(
    accessToken,
    tenantId,
    referenceNumber
  );
  let creditNoteId;
  if (existing?.CreditNoteID) {
    creditNoteId = existing.CreditNoteID;
    console.log('[Alcon Xero] ACCPAYCREDIT 기존 건 재사용', {
      creditNoteId,
      referenceNumber,
      entityName
    });
  } else {
    const created = await createSupplierCreditNote(accessToken, tenantId, {
      Type: 'ACCPAYCREDIT',
      Contact: { ContactID: contactId },
      Date: invoiceDate,
      DueDate: dueDate,
      CreditNoteNumber: referenceNumber,
      CurrencyCode: fields?.currency || 'AUD',
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems
    });
    creditNoteId = created.CreditNoteID;
    console.log('[Alcon Xero] ACCPAYCREDIT 생성', {
      creditNoteId,
      referenceNumber,
      entityName,
      lines: lineItems.length
    });
  }

  const detail = await getCreditNoteDetail(accessToken, tenantId, creditNoteId);
  const attCount = detail?.Attachments?.length ?? 0;
  if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
    throw new Error(`크레딧 노트 ${creditNoteId} 첨부 ${attCount}개 — 최대 ${MAX_ATTACHMENTS_PER_INVOICE}개`);
  }
  if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) {
    console.log('[Alcon Xero] 크레딧 동일 첨부 파일명 존재 — 업로드 스킵', {
      creditNoteId,
      attachmentFileName
    });
    return;
  }
  await uploadCreditNotePdfAttachment(
    accessToken,
    tenantId,
    creditNoteId,
    attachmentFileName,
    pagePdfBuffer
  );
  console.log('[Alcon Xero] 크레딧 첨부 업로드', {
    creditNoteId,
    referenceNumber,
    file: sanitizeAttachmentFileName(attachmentFileName),
    bytes: pagePdfBuffer.length
  });
}
