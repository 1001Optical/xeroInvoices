import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';
import { BRANCHES } from '../../constants.js';

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

function toPlainUint8Array(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (Buffer.isBuffer(buffer)) return Uint8Array.from(buffer);
  if (buffer instanceof Uint8Array) return Uint8Array.from(buffer);
  return new Uint8Array(buffer);
}

function getPdfDocumentParams(buffer) {
  return {
    data: toPlainUint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true
  };
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\r/g, '\n');
}

function parseMoneyAud(s) {
  if (s == null || String(s).trim() === '') return null;
  const raw = String(s).trim();
  const sign = /^\(.*\)$/.test(raw) && !raw.includes('-') ? -1 : 1;
  const t = raw.replace(/\s/g, '');
  const euroStyle = /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(t);
  const normalized = euroStyle
    ? t.replace(/[()]/g, '').replace(/\./g, '').replace(',', '.')
    : t.replace(/[()]/g, '').replace(/,/g, '');
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? sign * n : null;
}

/** dd.mm.yyyy 또는 dd/mm/yyyy → dd/mm/yyyy */
function sanitizeInvoiceDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim().replace(/\./g, '/').replace(/-/g, '/');
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const d = String(parseInt(m[1], 10)).padStart(2, '0');
  const mo = String(parseInt(m[2], 10)).padStart(2, '0');
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  return `${d}/${mo}/${String(y)}`;
}

/** 인보이스 날짜(달력 월 M)의 마지막 날 UTC + 30일 → dd/mm/yyyy */
function paymentDueLastMonthEndPlus30(invoiceDateDdMmYyyy) {
  const m = String(invoiceDateDdMmYyyy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  void day;
  const lastOfMonthUtc = new Date(Date.UTC(y, mo, 0));
  const due = new Date(lastOfMonthUtc.getTime());
  due.setUTCDate(due.getUTCDate() + 30);
  const dd = String(due.getUTCDate()).padStart(2, '0');
  const mm = String(due.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = due.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function buildReadingOrderText(textContent) {
  const items = (textContent.items || [])
    .filter((it) => 'str' in it && it.str !== '')
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5]
    }));
  if (items.length === 0) return '';
  const yTol = 4;
  items.sort((a, b) => {
    if (Math.abs(a.y - b.y) > yTol) return b.y - a.y;
    return a.x - b.x;
  });
  let out = '';
  let lastY = null;
  for (const it of items) {
    if (lastY !== null && Math.abs(it.y - lastY) > yTol) out += '\n';
    else if (out.length > 0 && lastY !== null) out += ' ';
    out += it.str;
    lastY = it.y;
  }
  return out;
}

function matchBranchByBauschAccount(accountNo) {
  const key = String(accountNo || '').trim();
  if (!key) return null;
  return BRANCHES.find((b) => String(b.bashLombAccount || '').trim() === key) || null;
}

/**
 * Invoice No. (Date)   91335806 (05.05.2026)
 */
function extractInvoiceNoAndDate(text, flat) {
  const patterns = [
    /Invoice\s+No\.\s*\(\s*Date\s*\)\s+(\d{5,})\s*\(\s*(\d{2}[./-]\d{2}[./-]\d{4})\s*\)/i,
    /Invoice\s+No\.\s*\(?\s*Date\s*\)?\s+(\d{5,})\s*\(\s*(\d{2}[./-]\d{2}[./-]\d{4})\s*\)/i,
    /Invoice\s+No\.?\s*\(Date\)\s+(\d{5,})\s*\(\s*(\d{2}[./-]\d{2}[./-]\d{4})\s*\)/i
  ];
  for (const p of patterns) {
    const m = flat.match(p) || text.match(p);
    if (m?.[1] && m?.[2]) {
      return {
        invoiceNumber: String(m[1]).trim(),
        invoiceDateRaw: String(m[2]).trim()
      };
    }
  }
  return { invoiceNumber: null, invoiceDateRaw: null };
}

/** Customer No.   600788 — 지점 매칭용 (Bill-To 라벨 제외) */
function extractCustomerNo(text, flat) {
  const m =
    flat.match(/\bCustomer\s+No\.\s+(\d{5,})\b/i) ||
    text.match(/\bCustomer\s+No\.\s+(\d{5,})\b/i);
  return m?.[1] ? String(m[1]).trim() : null;
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x).toLowerCase();
    if (!x || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** flat 세그먼트에서 다음 품목 행(줄번호 + 품번-) 직전까지만 Reference 로 사용 */
function trimFlatReferenceSegment(tail) {
  const s = String(tail || '').trim();
  const m = s.match(/^(.+?)(?=\s+\d{1,3}\s+[A-Z][A-Za-z0-9]*-\d[\w\-]*\s+)/);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  const cutGst = s.replace(/\s+\*?\s*GST\s+Applied[\s\S]*$/i, '').trim();
  return cutGst.replace(/\s+/g, ' ');
}

/**
 * Customer Reference: 가 품목 사이에 여러 번 나올 수 있음.
 * - 줄바꿈이 있는 text 에서는 레이블당 한 줄만 캡처 (flat 단일 줄 blob 방지).
 * - 보조로 flat 을 레이블로 split 해 다음 품목 행 전까지 자름.
 */
function extractCustomerReferences(text, flat) {
  const byLine = [];
  const lineRe = /\bCustomer\s+Reference:\s*([^\n]+)/gi;
  let mm;
  while ((mm = lineRe.exec(text)) !== null) {
    const v = String(mm[1]).trim().replace(/\s+/g, ' ');
    if (v) byLine.push(v);
  }
  const a = dedupeStrings(byLine);

  const flatSrc = String(flat || '');
  const parts = flatSrc.split(/\bCustomer\s+Reference:\s*/i);
  const byFlat = [];
  for (let i = 1; i < parts.length; i++) {
    const seg = trimFlatReferenceSegment(parts[i]);
    if (seg) byFlat.push(seg);
  }
  const b = dedupeStrings(byFlat);

  if (a.length >= 2) return a;
  if (b.length > a.length) return b;
  return a.length ? a : b;
}

/**
 * 푸터: Total Ex GST / GST Payable / Total Payable (공백 유연)
 */
function extractTotalsTriple(text, flat) {
  const direct =
    flat.match(
      /Total\s+Ex\s+GST\s+GST\s+Payable\s+Total\s+Payable\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/i
    ) ||
    text.match(
      /Total\s+Ex\s+GST\s+GST\s+Payable\s+Total\s+Payable\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/i
    );
  if (direct) {
    return {
      totalExGst: parseMoneyAud(direct[1]),
      gstPayable: parseMoneyAud(direct[2]),
      totalPayable: parseMoneyAud(direct[3])
    };
  }
  const beforePay = flat.match(/([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+How\s+to\s+Pay/i);
  if (beforePay) {
    return {
      totalExGst: parseMoneyAud(beforePay[1]),
      gstPayable: parseMoneyAud(beforePay[2]),
      totalPayable: parseMoneyAud(beforePay[3])
    };
  }
  const block =
    text.match(
      /\*\s*GST\s+Applied\s+to\s+Item\s+([\s\S]{0,400}?)(?=How\s+to\s+Pay|Bausch\s*&?\s*Lomb|$)/i
    )?.[1] || '';
  const src = block || text;
  const m = src.match(/(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s*$/m);
  if (!m) return { totalExGst: null, gstPayable: null, totalPayable: null };
  return {
    totalExGst: parseMoneyAud(m[1]),
    gstPayable: parseMoneyAud(m[2]),
    totalPayable: parseMoneyAud(m[3])
  };
}

/**
 * 품목 행: … ProductNo … Description … UOM Qty unit unit totalNet (마지막 세 금액)
 */
function extractProductLines(flat) {
  const lines = [];
  const re =
    /\b(\d+)\s+([A-Z][A-Za-z0-9]*-\d[\w\-]*)\s+(.+?)\s+(EA|PK|BX|CS|KT)\s+(\d+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d.,]+)/gi;
  let mm;
  while ((mm = re.exec(flat)) !== null) {
    const itemLineNo = mm[1];
    const productNo = mm[2];
    const description = String(mm[3]).replace(/\s+/g, ' ').trim();
    void mm[4];
    const qty = parseInt(mm[5], 10) || 1;
    const unitEx = parseMoneyAud(mm[6]);
    const midEx = parseMoneyAud(mm[7]);
    const totalNetEx = parseMoneyAud(mm[8]);
    void midEx;
    const netForLine = totalNetEx != null ? totalNetEx : unitEx != null ? unitEx * qty : null;
    const unitNet =
      unitEx != null && qty > 0
        ? totalNetEx != null
          ? totalNetEx / qty
          : unitEx
        : netForLine != null && qty > 0
          ? netForLine / qty
          : null;
    lines.push({
      kind: 'product',
      itemLineNo,
      productNo,
      description: `${productNo} ${description}`.slice(0, 500),
      qty,
      unitPriceExGst: unitNet,
      lineNetExGst: netForLine,
      /** 라인별 GST는 PDF에서 분리 어려우면 푸터 GST 분배 전까지 0 처리 가능 */
      gst: 0
    });
  }
  return lines;
}

/** 같은 페이지에서 reading + raw 를 합치지 않은 경우에도 중복 매칭 방지 */
function dedupeProductLines(lines) {
  const seen = new Set();
  const out = [];
  for (const li of lines) {
    const k = [li.itemLineNo, li.productNo, li.qty, li.lineNetExGst].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(li);
  }
  return out;
}

function inferTaxTypeForLine(gstPayableTotal) {
  return Number(gstPayableTotal || 0) > 0.005 ? 'GST on Expenses' : 'GST Free Expenses';
}

function buildLineItemsForXero(productLines, customerReferences, gstPayableTotal) {
  const taxDefault = inferTaxTypeForLine(gstPayableTotal);
  const xero = [];
  for (const li of productLines) {
    const gst =
      taxDefault === 'GST on Expenses' && li.lineNetExGst != null && li.unitPriceExGst != null
        ? Math.max(0, Number(li.lineNetExGst) - Number(li.unitPriceExGst) * Number(li.qty || 1))
        : 0;
    xero.push({
      lineKind: 'product',
      productDescription: li.description,
      qty: li.qty,
      unitPriceExGst: li.unitPriceExGst,
      amountDueInclGst: (li.lineNetExGst ?? 0) + gst,
      gst,
      taxType: gst > 0.005 ? 'GST on Expenses' : 'GST Free Expenses'
    });
  }
  for (const ref of customerReferences) {
    xero.push({
      lineKind: 'reference',
      productDescription: `Customer Reference: ${ref}`,
      qty: 1,
      unitPriceExGst: 0,
      amountDueInclGst: 0,
      gst: 0,
      taxType: 'GST Free Expenses'
    });
  }
  return xero;
}

function detectDocumentKind(totalPayable, productLines) {
  if (totalPayable != null && totalPayable < 0) return 'supplier_credit_note';
  if (productLines.some((l) => (l.lineNetExGst ?? 0) < 0 || (l.unitPriceExGst ?? 0) < 0)) {
    return 'supplier_credit_note';
  }
  return 'supplier_invoice';
}

function extractBauschFields(mergedText) {
  const text = normalizeText(mergedText);
  const flat = text.replace(/\s+/g, ' ');

  const { invoiceNumber, invoiceDateRaw } = extractInvoiceNoAndDate(text, flat);
  const invoiceDate = sanitizeInvoiceDate(invoiceDateRaw);

  const billToNumber = extractCustomerNo(text, flat);
  const matchedBranch = matchBranchByBauschAccount(billToNumber);

  const customerReferences = extractCustomerReferences(text, flat);
  const customerReference =
    customerReferences.length === 0
      ? null
      : customerReferences.length === 1
        ? customerReferences[0]
        : customerReferences.join(' | ');
  const productLines = dedupeProductLines(extractProductLines(flat));
  const totals = extractTotalsTriple(text, flat);

  let lineItemsForXero = buildLineItemsForXero(
    productLines,
    customerReferences,
    totals.gstPayable
  );

  if (lineItemsForXero.length === 0 && totals.totalPayable != null) {
    lineItemsForXero = [
      {
        lineKind: 'product',
        productDescription: invoiceNumber ? `B&L Invoice ${invoiceNumber}` : 'B&L Invoice',
        qty: 1,
        unitPriceExGst: totals.totalExGst ?? totals.totalPayable,
        amountDueInclGst: totals.totalPayable ?? totals.totalExGst ?? 0,
        gst: totals.gstPayable ?? 0,
        taxType: inferTaxTypeForLine(totals.gstPayable)
      }
    ];
    for (const ref of customerReferences) {
      lineItemsForXero.push({
        lineKind: 'reference',
        productDescription: `Customer Reference: ${ref}`,
        qty: 1,
        unitPriceExGst: 0,
        amountDueInclGst: 0,
        gst: 0,
        taxType: 'GST Free Expenses'
      });
    }
  }

  const paymentDueOn = invoiceDate ? paymentDueLastMonthEndPlus30(invoiceDate) : null;

  const docKind = detectDocumentKind(totals.totalPayable, productLines);

  return {
    documentKind: docKind,
    invoiceNumber,
    invoiceDate,
    paymentDueOn,
    billToNumber,
    matchedBranchCode: matchedBranch?.code || null,
    matchedBranchName: matchedBranch?.name || null,
    matchedEntity: matchedBranch?.entity || null,
    customerReferences,
    customerReference,
    currency: /\bAUD\b/i.test(flat) ? 'AUD' : 'AUD',
    subtotal: totals.totalExGst,
    gst: totals.gstPayable,
    total: totals.totalPayable,
    totalExGst: totals.totalExGst,
    gstPayable: totals.gstPayable,
    totalPayable: totals.totalPayable,
    lineItemsRaw: productLines,
    lineItemsForXero
  };
}

export async function parseBauschInvoicePdf(buffer, options = {}) {
  const pdf = await getDocument(getPdfDocumentParams(buffer)).promise;
  const invoices = [];
  const pageErrors = [];
  const attName = options.attachmentFileName;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = textContent.items || [];
      const rawText = items.map((it) => ('str' in it ? it.str : '')).join('\n');
      const readingOrderText = buildReadingOrderText(textContent);
      // readingOrderText + rawText 를 합치면 B&L PDF 에서 동일 표가 두 번 들어가 품목이 중복됨
      let mergedText = normalizeText(readingOrderText);
      if (!mergedText.trim()) mergedText = normalizeText(rawText);
      invoices.push({
        page: pageNum,
        attachmentFileName: attName,
        mergedText,
        fields: extractBauschFields(mergedText)
      });
    } catch (err) {
      pageErrors.push({
        page: pageNum,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { invoices, pageErrors };
}

export async function inspectBauschPdfBuffer(buffer) {
  const parsed = await parseBauschInvoicePdf(buffer);
  return {
    numPages: parsed.invoices.length + parsed.pageErrors.length,
    invoices: parsed.invoices.map((x) => ({
      page: x.page,
      fields: x.fields,
      mergedPreview: String(x.mergedText || '').slice(0, 16000)
    })),
    pageErrors: parsed.pageErrors
  };
}
