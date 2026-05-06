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

function artmostExpenseAccountCode() {
  return String(
    process.env.ARTMOST_XERO_EXPENSE_ACCOUNT_CODE ||
      process.env.HOYA_XERO_EXPENSE_ACCOUNT_CODE ||
      '51103'
  ).trim();
}

function artmostTrackingCategoryName() {
  return String(
    process.env.ARTMOST_XERO_TRACKING_CATEGORY_NAME ||
      process.env.HOYA_XERO_TRACKING_CATEGORY_NAME ||
      'Store'
  ).trim();
}

function buildTrackingForStore(storeName) {
  const categoryName = artmostTrackingCategoryName();
  const option = String(storeName || '').trim();
  if (!categoryName || !option) return {};
  return {
    Tracking: [{ Name: categoryName, Option: option.slice(0, 100) }]
  };
}

function normalizeTaxType(taxType) {
  const t = String(taxType || '').trim().toLowerCase();
  if (!t) return 'EXEMPTEXPENSES';
  if (t === 'gst free expenses' || t === 'exemptexpenses') return 'EXEMPTEXPENSES';
  if (t === 'gst on expenses' || t === 'input') return 'INPUT';
  return String(taxType).trim();
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
  const safe = String(email || '').replace(/"/g, '');
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

function parseContactIdByEntityMap() {
  const raw = process.env.ARTMOST_XERO_CONTACT_ID_BY_ENTITY?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function resolveArtmostSupplierContactId(accessToken, tenantId, entityName) {
  const byEntity = parseContactIdByEntityMap();
  if (byEntity[entityName]) return String(byEntity[entityName]).trim();

  const globalId = process.env.ARTMOST_XERO_CONTACT_ID?.trim();
  if (globalId) return globalId;

  const nameCandidates = [
    process.env.ARTMOST_XERO_CONTACT_NAME?.trim(),
    'Artmost*',
    'AKW Healthcare T/A ArtMost GOV Contact Lenses Australia',
    'ArtMost GOV Contact Lenses Australia',
    'AKW Healthcare'
  ].filter(Boolean);
  for (const name of nameCandidates) {
    const foundByName = await findContactIdByName(accessToken, tenantId, name);
    if (foundByName) return foundByName;
  }

  const emailCandidates = [
    process.env.ARTMOST_XERO_CONTACT_EMAIL?.trim(),
    'accounts@artmostgovau.com.au',
    'admin@artmostgovau.com.au'
  ].filter(Boolean);
  for (const email of emailCandidates) {
    const foundByEmail = await findContactIdByEmail(accessToken, tenantId, email);
    if (foundByEmail) return foundByEmail;
  }

  const containsCandidates = ['Artmost', 'ArtMost', 'AKW'];
  for (const token of containsCandidates) {
    const foundByContains = await findContactIdByNameContains(accessToken, tenantId, token);
    if (foundByContains) return foundByContains;
  }

  throw new Error(
    `Artmost 공급처 Contact를 찾을 수 없습니다. ARTMOST_XERO_CONTACT_ID 또는 ARTMOST_XERO_CONTACT_ID_BY_ENTITY 설정 필요 (entity=${entityName})`
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
  if (!cn?.CreditNoteID) throw new Error('Xero CreditNote 응답에 CreditNoteID 없음');
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

function buildXeroLineItems(fields, { forCredit = false } = {}) {
  const src = Array.isArray(fields?.xeroDraftLineItems) ? fields.xeroDraftLineItems : [];
  const tracking = buildTrackingForStore(fields?.matchedBranchName);
  const accountCode = artmostExpenseAccountCode();
  const out = src.map((li) => ({
    Description: String(li.Description || 'Artmost').slice(0, 4000),
    Quantity: Number(li.Quantity || 1) || 1,
    UnitAmount: forCredit ? Math.abs(Number(li.UnitAmount || 0)) : Number(li.UnitAmount || 0),
    AccountCode: accountCode,
    TaxType: normalizeTaxType(li.TaxType),
    ...tracking
  }));
  return out.length
    ? out
    : [
        {
          Description: `Artmost — ${fields?.referenceNumber || 'invoice'}`.slice(0, 4000),
          Quantity: 1,
          UnitAmount: 0,
          AccountCode: accountCode,
          TaxType: 'EXEMPTEXPENSES',
          ...tracking
        }
      ];
}

export async function ensureArtmostAccPayAndAttach(opts) {
  const { fields, pagePdfBuffer, attachmentFileName } = opts;
  const entityName = fields?.matchedEntity;
  if (!entityName) throw new Error('Artmost branch/entity 매칭 실패');

  const referenceNumber = sanitizeReferenceForXero(
    fields?.referenceNumber || fields?.invoiceNumber
  );
  if (!referenceNumber) throw new Error('Artmost invoiceNumber 없음');

  const invoiceDate = String(fields?.invoiceDateIso || '');
  const dueDate = String(fields?.dueDateIso || invoiceDate || '');
  if (!invoiceDate) throw new Error('Artmost invoiceDateIso 없음');
  if (!dueDate) throw new Error('Artmost dueDateIso 없음');

  const accessToken = await getAccessToken(entityName);
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);

  const contactId = await resolveArtmostSupplierContactId(accessToken, tenantId, entityName);
  const lineItems = buildXeroLineItems(fields);

  let existing = await findAccPayByInvoiceNumber(accessToken, tenantId, referenceNumber);
  let invoiceId;
  if (existing?.InvoiceID) {
    invoiceId = existing.InvoiceID;
    console.log('[Artmost Xero] ACCPAY 기존 건 재사용', { invoiceId, referenceNumber, entityName });
  } else {
    const created = await createAccPayInvoice(accessToken, tenantId, {
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: invoiceDate,
      DueDate: dueDate,
      InvoiceNumber: referenceNumber,
      CurrencyCode: 'AUD',
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems
    });
    invoiceId = created.InvoiceID;
    console.log('[Artmost Xero] ACCPAY 생성', {
      invoiceId,
      referenceNumber,
      entityName,
      lines: lineItems.length
    });
  }

  const detail = await getInvoiceDetail(accessToken, tenantId, invoiceId);
  const attCount = detail?.Attachments?.length ?? 0;
  if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
    throw new Error(`인보이스 ${invoiceId} 첨부 ${attCount}개 — 최대 ${MAX_ATTACHMENTS_PER_INVOICE}개`);
  }
  if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) {
    console.log('[Artmost Xero] 동일 첨부 파일명 존재 — 업로드 스킵', {
      invoiceId,
      attachmentFileName
    });
    return;
  }

  await uploadInvoicePdfAttachment(
    accessToken,
    tenantId,
    invoiceId,
    attachmentFileName,
    pagePdfBuffer
  );
  console.log('[Artmost Xero] 첨부 업로드', {
    invoiceId,
    referenceNumber,
    file: sanitizeAttachmentFileName(attachmentFileName),
    bytes: pagePdfBuffer.length
  });
}

/**
 * ArtMost 반품/마이너스 PDF → Xero Supplier Credit (ACCPAYCREDIT) 생성/첨부.
 * CreditNotes API는 금액을 양수 라인으로 받으므로 PDF의 음수 금액은 절대값으로 변환한다.
 * @param {Parameters<typeof ensureArtmostAccPayAndAttach>[0]} opts
 */
export async function ensureArtmostSupplierCreditAndAttach(opts) {
  const { fields, pagePdfBuffer, attachmentFileName } = opts;
  const entityName = fields?.matchedEntity;
  if (!entityName) throw new Error('Artmost branch/entity 매칭 실패');

  const referenceNumber = sanitizeReferenceForXero(
    fields?.referenceNumber || fields?.invoiceNumber
  );
  if (!referenceNumber) throw new Error('Artmost invoiceNumber 없음');

  const invoiceDate = String(fields?.invoiceDateIso || '');
  const dueDate = String(fields?.dueDateIso || invoiceDate || '');
  if (!invoiceDate) throw new Error('Artmost invoiceDateIso 없음');
  if (!dueDate) throw new Error('Artmost dueDateIso 없음');

  const accessToken = await getAccessToken(entityName);
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);

  const contactId = await resolveArtmostSupplierContactId(accessToken, tenantId, entityName);
  const lineItems = buildXeroLineItems(fields, { forCredit: true });

  let existing = await findSupplierCreditByCreditNoteNumber(
    accessToken,
    tenantId,
    referenceNumber
  );
  let creditNoteId;
  if (existing?.CreditNoteID) {
    creditNoteId = existing.CreditNoteID;
    console.log('[Artmost Xero] ACCPAYCREDIT 기존 건 재사용', {
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
      CurrencyCode: 'AUD',
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems
    });
    creditNoteId = created.CreditNoteID;
    console.log('[Artmost Xero] ACCPAYCREDIT 생성', {
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
    console.log('[Artmost Xero] 크레딧 동일 첨부 파일명 존재 — 업로드 스킵', {
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
  console.log('[Artmost Xero] 크레딧 첨부 업로드', {
    creditNoteId,
    referenceNumber,
    file: sanitizeAttachmentFileName(attachmentFileName),
    bytes: pagePdfBuffer.length
  });
}

