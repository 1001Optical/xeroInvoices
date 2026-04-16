/**
 * Hoya 인보이스 1건(ACCPAY Bill) = PDF 1페이지 → Xero Bill 생성/조회 후 해당 페이지 PDF 첨부
 * SOLD TO의 스토어 → constants BRANCHES 매칭으로 법인(entity) 선택, 라인·세금·Store 트래킹 반영
 * @see https://developer.xero.com/documentation/api/accounting/invoices
 * @see https://developer.xero.com/documentation/api/accounting/attachments#invoices
 */
import axios from 'axios';
import {
  getAccessToken,
  getTenantIdForEntity,
  DEFAULT_ENTITY
} from './xero.js';
import { matchBranchFromHoyaPdf } from './hoyaBranchMatch.js';

const API = 'https://api.xero.com/api.xro/2.0';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_INVOICE = 10;

const DEFAULT_HOYA_CONTACT_NAME = 'HOYA LENS AUSTRALIA PTY. LIMITED';

/**
 * @param {object} opts
 * @param {{ entityName: string } | null} [precomputedMatch] 이미 matchBranchFromHoyaPdf 결과가 있으면 재호출 생략
 */
function resolveHoyaEntityName(opts, precomputedMatch) {
  if (opts?.entityName?.trim()) return opts.entityName.trim();
  const matched =
    precomputedMatch ??
    matchBranchFromHoyaPdf({
      storeLine: opts?.storeLine,
      soldTo: opts?.soldTo,
      fullPageText: opts?.fullPageText
    });
  if (matched?.entityName) return matched.entityName;
  const fromEnv =
    process.env.HOYA_XERO_ENTITY?.trim() || process.env.HOYA_FALLBACK_ENTITY?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_ENTITY;
}

function expenseAccountCode() {
  const c = process.env.HOYA_XERO_EXPENSE_ACCOUNT_CODE;
  return (c && String(c).trim()) || '51103';
}

/**
 * GST 금액 0 → 무료, 아니면 경비 GST (조직별 TaxType 문자열은 Xero 설정·env로 맞춤)
 */
function taxTypeForLine(gstMoney, taxFree, taxOnExpenses, fallbackSingle) {
  if (fallbackSingle) return fallbackSingle;
  return gstMoney === 0 ? taxFree : taxOnExpenses;
}

async function findContactIdByName(accessToken, tenantId, name) {
  const safe = String(name).replace(/"/g, '""');
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

async function resolveSupplierContactId(accessToken, tenantId) {
  const id = process.env.HOYA_XERO_CONTACT_ID?.trim();
  if (id) return id;
  const name = process.env.HOYA_XERO_CONTACT_NAME?.trim() || DEFAULT_HOYA_CONTACT_NAME;
  const found = await findContactIdByName(accessToken, tenantId, name);
  if (!found) {
    throw new Error(
      `Xero에서 공급처 Contact를 찾을 수 없습니다: "${name}". HOYA_XERO_CONTACT_ID 를 설정하거나 Xero에 동일 이름 Contact를 만드세요.`
    );
  }
  return found;
}

function logXeroError(payload) {
  console.error('[Hoya Xero error]', JSON.stringify(payload));
}

function parseMoney(s) {
  if (s == null) return 0;
  const n = String(s).replace(/[^0-9.-]/g, '');
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

function buildAccPayLineItems({
  lineItems,
  storeNameForTracking,
  accountCode,
  taxFreeCode,
  taxOnExpensesCode,
  singleTaxType,
  referenceNumber,
  storeLine
}) {
  const trackingCategoryName = process.env.HOYA_XERO_TRACKING_CATEGORY_NAME?.trim();
  const tracking =
    trackingCategoryName && storeNameForTracking
      ? {
          Tracking: [
            {
              Name: trackingCategoryName,
              Option: String(storeNameForTracking).slice(0, 100)
            }
          ]
        }
      : {};

  const lines = [];
  for (const li of lineItems || []) {
    const qty = parseMoney(li.qty);
    const unitAmount = parseMoney(li.price);
    const gstAmt = parseMoney(li.gst);
    const q = qty > 0 ? qty : 1;
    const ua = unitAmount > 0 ? unitAmount : 0.01;
    const tt = taxTypeForLine(gstAmt, taxFreeCode, taxOnExpensesCode, singleTaxType);
    const desc = (li.description || '').trim() || `Hoya — ${referenceNumber}`;
    lines.push({
      Description: desc.slice(0, 4000),
      Quantity: q,
      UnitAmount: ua,
      AccountCode: accountCode,
      TaxType: tt,
      ...tracking
    });
  }

  if (lines.length === 0) {
    lines.push({
      Description: `Hoya — ${storeLine || referenceNumber}`.slice(0, 4000),
      Quantity: 1,
      UnitAmount: 0.01,
      AccountCode: accountCode,
      TaxType: singleTaxType || taxFreeCode,
      ...tracking
    });
  }
  return lines;
}

const EN_MONTH_TO_NUM = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

/**
 * DD/MM/YYYY 또는 DD MMM YYYY(영문 월, 예: 15 Apr 2026) → YYYY-MM-DD
 * @param {string} dateStr
 */
export function parseInvoiceDateToXero(dateStr) {
  const s = String(dateStr).trim();
  const slash = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (slash) {
    let d = parseInt(slash[1], 10);
    let mo = parseInt(slash[2], 10);
    let y = parseInt(slash[3], 10);
    if (y < 100) y += 2000;
    const mm = String(mo).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  const eng = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (eng) {
    const day = parseInt(eng[1], 10);
    const monKey = eng[2].slice(0, 3).toLowerCase();
    const y = parseInt(eng[3], 10);
    const mo = EN_MONTH_TO_NUM[monKey];
    if (!mo || day < 1 || day > 31) {
      throw new Error(`인보이스 날짜(영문 월) 파싱 실패: ${dateStr}`);
    }
    return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  throw new Error(`인보이스 날짜 파싱 실패: ${dateStr}`);
}

/** @param {string} isoYmd YYYY-MM-DD */
export function addCalendarDaysToIsoDate(isoYmd, days) {
  const m = String(isoYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`날짜 형식 오류: ${isoYmd}`);
  const d = new Date(
    Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sanitizeAttachmentFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
}

async function findAccPayByReference(accessToken, tenantId, reference) {
  const safeRef = String(reference).replace(/"/g, '');
  const where = `Reference=="${safeRef}"`;
  const url = `${API}/Invoices?where=${encodeURIComponent(where)}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.Invoices || [];
  return list.find((inv) => inv.Reference === reference && inv.Type === 'ACCPAY') || null;
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
  if (!inv?.InvoiceID) {
    throw new Error('Xero 인보이스 생성 응답에 InvoiceID 없음');
  }
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

async function uploadInvoicePdfAttachment(
  accessToken,
  tenantId,
  invoiceId,
  fileName,
  pdfBuffer
) {
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

/**
 * Reference 기준 ACCPAY 조회 또는 생성 후 1페이지 PDF 첨부
 * @param {{
 *   referenceNumber: string,
 *   invoiceDateStr: string,
 *   storeLine?: string|null,
 *   soldTo?: string|null,
 *   entityName?: string,
 *   lineItems: Array<object>,
 *   pagePdfBuffer: Buffer,
 *   attachmentFileName: string,
 *   fullPageText?: string|null,
 * }} opts
 */
export async function ensureHoyaAccPayAndAttach(opts) {
  const {
    referenceNumber,
    invoiceDateStr,
    storeLine,
    soldTo,
    fullPageText,
    lineItems,
    pagePdfBuffer,
    attachmentFileName
  } = opts;

  const matched = matchBranchFromHoyaPdf({ storeLine, soldTo, fullPageText });
  const entityName = resolveHoyaEntityName(opts, matched);
  if (!matched && !opts.entityName) {
    console.warn('[Hoya Xero] BRANCHES 스토어 이름 매칭 실패 — 기본/HOYA_XERO_ENTITY 법인 사용', {
      storeLine: storeLine?.slice?.(0, 300),
      soldTo: soldTo?.slice?.(0, 300),
      entityName
    });
  }

  const accessToken = await getAccessToken(entityName);
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) {
    throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);
  }

  const contactId = await resolveSupplierContactId(accessToken, tenantId);
  const accountCode = expenseAccountCode();
  const date = parseInvoiceDateToXero(invoiceDateStr);
  const dueDate = addCalendarDaysToIsoDate(date, 30);
  const currency = process.env.HOYA_XERO_CURRENCY || 'AUD';

  const taxFree =
    process.env.HOYA_XERO_TAX_GST_FREE?.trim() || 'GSTFREE';
  const taxOnExpenses =
    process.env.HOYA_XERO_TAX_GST_ON_EXPENSES?.trim() || 'INPUT';
  const singleTax = process.env.HOYA_XERO_LINE_TAX_TYPE?.trim() || '';

  const storeNameForTracking = matched?.branch?.name || null;
  const xeroLineItems = buildAccPayLineItems({
    lineItems,
    storeNameForTracking,
    accountCode,
    taxFreeCode: taxFree,
    taxOnExpensesCode: taxOnExpenses,
    singleTaxType: singleTax || null,
    referenceNumber,
    storeLine
  });

  let existing = await findAccPayByReference(
    accessToken,
    tenantId,
    referenceNumber
  );

  let invoiceId;
  if (existing?.InvoiceID) {
    invoiceId = existing.InvoiceID;
  } else {
    const created = await createAccPayInvoice(accessToken, tenantId, {
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: date,
      DueDate: dueDate,
      Reference: referenceNumber,
      CurrencyCode: currency,
      Status: 'DRAFT',
      LineAmountTypes: 'Exclusive',
      LineItems: xeroLineItems
    });
    invoiceId = created.InvoiceID;
    console.log('[Hoya Xero] ACCPAY 생성', {
      invoiceId,
      referenceNumber,
      entityName,
      lines: xeroLineItems.length
    });
  }

  const detail = await getInvoiceDetail(accessToken, tenantId, invoiceId);
  const attCount = detail?.Attachments?.length ?? 0;
  if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
    const msg = `인보이스 ${invoiceId} 첨부 ${attCount}개 — 최대 ${MAX_ATTACHMENTS_PER_INVOICE}개`;
    logXeroError({ referenceNumber, invoiceId, error: msg });
    throw new Error(msg);
  }

  await uploadInvoicePdfAttachment(
    accessToken,
    tenantId,
    invoiceId,
    attachmentFileName,
    pagePdfBuffer
  );
  console.log('[Hoya Xero] 첨부 업로드', {
    invoiceId,
    referenceNumber,
    file: attachmentFileName,
    bytes: pagePdfBuffer.length
  });
}
