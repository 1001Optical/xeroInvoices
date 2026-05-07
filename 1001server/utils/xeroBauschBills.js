import axios from 'axios';
import { xeroExpenseAccountCodeCl } from '../../constants.js';
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
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function bauschExpenseAccountCode() {
  const c = process.env.BAUSCH_XERO_EXPENSE_ACCOUNT_CODE;
  return String((c && c.trim()) || xeroExpenseAccountCodeCl()).trim();
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
    process.env.BAUSCH_XERO_TRACKING_CATEGORY_NAME?.trim() ||
    process.env.HOYA_XERO_TRACKING_CATEGORY_NAME?.trim() ||
    '';
  const trackingCategoryId =
    process.env.BAUSCH_XERO_TRACKING_CATEGORY_ID?.trim() ||
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
  return res.data?.Contacts?.[0]?.ContactID || null;
}

async function findContactIdByNameContains(accessToken, tenantId, token) {
  const safe = String(token || '').replace(/"/g, '');
  if (!safe) return null;
  const where = `Name.Contains("${safe}")`;
  const url = `${API}/Contacts?where=${encodeURIComponent(where)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  return res.data?.Contacts?.[0]?.ContactID || null;
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
  return res.data?.Contacts?.[0]?.ContactID || null;
}

async function resolveBauschSupplierContactId(accessToken, tenantId) {
  const globalId = process.env.BAUSCH_XERO_CONTACT_ID?.trim();
  if (globalId) return globalId;

  const envName = process.env.BAUSCH_XERO_CONTACT_NAME?.trim();
  if (envName) {
    const exact = envName.replace(/\*+$/, '').trim();
    const byExact = await findContactIdByName(accessToken, tenantId, exact);
    if (byExact) return byExact;
  }

  const byContains = await findContactIdByNameContains(
    accessToken,
    tenantId,
    'Bausch & Lomb (Australia)'
  );
  if (byContains) return byContains;

  const byEmail = await findContactIdByEmail(
    accessToken,
    tenantId,
    process.env.BAUSCH_FROM_EMAIL?.trim() || 'sap_generated_no_reply@bausch.com'
  );
  if (byEmail) return byEmail;

  throw new Error('Bausch 공급처 Contact를 찾을 수 없습니다. BAUSCH_XERO_CONTACT_ID 설정 필요');
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
  return (
    list.find(
      (x) => x.Type === 'ACCPAY' && sanitizeReferenceForXero(x.InvoiceNumber) === ref
    ) || null
  );
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
  return (attachments || []).some((a) => sanitizeAttachmentFileName(a?.FileName || '') === want);
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

/**
 * PDF 파서 lineItemsForXero: unitPriceExGst = Tax Exclusive unit, qty, gst, taxType
 */
function buildXeroLineItems(fields, referenceNumber, { forCredit = false } = {}) {
  const tracking = buildTrackingForStore(fields?.matchedBranchName);
  const src = Array.isArray(fields?.lineItemsForXero) ? fields.lineItemsForXero : [];
  const out = [];
  for (const li of src) {
    if (!li) continue;
    const qty = Number(li.qty ?? 1) || 1;
    let unitEx = Number(li.unitPriceExGst ?? 0);
    const gst = Math.abs(Number(li.gst ?? 0));
    if (forCredit) unitEx = Math.abs(unitEx);
    else if (unitEx < 0) unitEx = Math.abs(unitEx);
    const row = {
      Description: String(li.productDescription || referenceNumber).slice(0, 4000),
      Quantity: qty,
      UnitAmount: Number(unitEx || 0),
      AccountCode: bauschExpenseAccountCode(),
      TaxType: mapTaxTypeToXeroCode(li.taxType, gst),
      ...tracking
    };
    void gst;
    out.push(row);
  }
  return out.filter((x) => Number.isFinite(x.UnitAmount));
}

export async function ensureBauschAccPayAndAttach(opts) {
  const { fields, pagePdfBuffer, attachmentFileName } = opts;
  const entityName = fields?.matchedEntity;
  if (!entityName) {
    throw new Error(`B&L Customer No 매칭 실패: ${fields?.billToNumber || '(없음)'}`);
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

  const contactId = await resolveBauschSupplierContactId(accessToken, tenantId);
  const lineItems = buildXeroLineItems(fields, referenceNumber);
  if (lineItems.length === 0) throw new Error('B&L 라인 없음');

  let existing = await findAccPayByInvoiceNumber(accessToken, tenantId, referenceNumber);
  let invoiceId;
  if (existing?.InvoiceID) {
    invoiceId = existing.InvoiceID;
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
  }

  const detail = await getInvoiceDetail(accessToken, tenantId, invoiceId);
  const attCount = detail?.Attachments?.length ?? 0;
  if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
    throw new Error(`인보이스 ${invoiceId} 첨부 상한`);
  }
  if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) return;
  await uploadInvoicePdfAttachment(
    accessToken,
    tenantId,
    invoiceId,
    attachmentFileName,
    pagePdfBuffer
  );
}

export async function ensureBauschSupplierCreditAndAttach(opts) {
  const { fields, pagePdfBuffer, attachmentFileName } = opts;
  const entityName = fields?.matchedEntity;
  if (!entityName) {
    throw new Error(`B&L Customer No 매칭 실패: ${fields?.billToNumber || '(없음)'}`);
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

  const contactId = await resolveBauschSupplierContactId(accessToken, tenantId);
  const lineItems = buildXeroLineItems(fields, referenceNumber, { forCredit: true });
  if (lineItems.length === 0) throw new Error('B&L 크레딧 라인 없음');

  let existing = await findSupplierCreditByCreditNoteNumber(accessToken, tenantId, referenceNumber);
  let creditNoteId;
  if (existing?.CreditNoteID) {
    creditNoteId = existing.CreditNoteID;
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
  }

  const detail = await getCreditNoteDetail(accessToken, tenantId, creditNoteId);
  const attCount = detail?.Attachments?.length ?? 0;
  if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
    throw new Error(`크레딧 ${creditNoteId} 첨부 상한`);
  }
  if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) return;
  await uploadCreditNotePdfAttachment(
    accessToken,
    tenantId,
    creditNoteId,
    attachmentFileName,
    pagePdfBuffer
  );
}
