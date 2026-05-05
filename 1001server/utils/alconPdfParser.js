/**
 * Alcon TAX INVOICE PDF — 텍스트 추출 + (추후) 필드 매핑용 뼈대.
 * 전제: 첨부 PDF 1개 = 페이지 1장 = 인보이스 1건 (호야 combined 와 다름).
 * 레이아웃 확정 전까지는 페이지별 raw / reading-order / space-join 문자열만 반환합니다.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';
import { BRANCHES } from '../../constants.js';

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 */
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

function normalizeExtractText(s) {
  return String(s)
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\r/g, '\n');
}

/**
 * @param {{ items: Array<{ str?: string, transform: number[] }> }} textContent
 */
function buildReadingOrderText(textContent) {
  const items = textContent.items
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

/**
 * @param {string} normalized
 * @returns {Record<string, unknown>}
 */
/** "27,46" / "1.234,56" → number (호주 PDF는 대체로 마침표 소수) */
function parseMoneyAud(s) {
  if (s == null || String(s).trim() === '') return null;
  const t = String(s).trim().replace(/\s/g, '');
  const euroStyle = /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(t);
  const normalized = euroStyle ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function alconExpenseAccountCode() {
  return String(process.env.ALCON_XERO_EXPENSE_ACCOUNT_CODE || '10075303').trim();
}

function alconFreightAccountCode() {
  return String(
    process.env.ALCON_XERO_FREIGHT_ACCOUNT_CODE || alconExpenseAccountCode()
  ).trim();
}

function alconTaxTypeFreeExpenses() {
  return String(process.env.ALCON_XERO_TAX_FREE_CODE || 'GST Free Expenses').trim();
}

function alconTaxTypeOnExpenses() {
  return String(process.env.ALCON_XERO_TAX_ON_EXPENSES_CODE || 'GST on Expenses').trim();
}

function chooseAlconTaxTypeByGst(gstAmount) {
  const g = Number(gstAmount || 0);
  return g > 0 ? alconTaxTypeOnExpenses() : alconTaxTypeFreeExpenses();
}

function matchBranchByAlconAccount(alconAccount) {
  const key = String(alconAccount || '').trim();
  if (!key) return null;
  return BRANCHES.find((b) => String(b.alconAccount || '').trim() === key) || null;
}

function isMoneyToken(s) {
  return /^-?[\d.,]+$/.test(String(s || '').trim());
}

function isLikelyQty(s) {
  const t = String(s || '').trim();
  if (!/^\d{1,6}$/.test(t)) return false;
  const n = parseInt(t, 10);
  return n >= 0 && n <= 999999;
}

function isLikelyUom(s) {
  return /^[A-Z]{2,6}$/.test(String(s || '').trim());
}

/**
 * "Contract No…" 아래 상세표 ~ "Net Goods Value" 직전까지 잘라, 세로 나열(설명·Qty·금액4개) 행을 여러 개 파싱.
 * FREIGHT Direct to Patient 처럼 품목코드 없이 설명만 오는 행도 처리.
 */
function extractAlconLineItemsVertical(text) {
  const full = normalizeExtractText(text);
  const netIdx = full.search(/\n\s*Net\s+Goods\s+Value\b/i);
  if (netIdx < 0) return [];

  const head = full.slice(0, netIdx);
  const contractIdx = head.search(/Contract No\.\s*\/\s*Contract period/i);
  const sliceFrom = contractIdx >= 0 ? contractIdx : 0;
  const tail = head.slice(sliceFrom);

  const hdr = tail.match(
    /Amount\s+Due\s*\n\s*incl\s+GST\s*\n\s*GST\s*\n+([\s\S]*)$/im
  );
  const body = (hdr ? hdr[1] : tail).trim();
  if (!body) return [];

  const L = body.split('\n').map((l) => l.trim()).filter(Boolean);

  const lineItems = [];
  let i = 0;

  while (i < L.length) {
    if (/^Customer reference$/i.test(L[i])) {
      i += 1;
      if (i < L.length) i += 1; // value line
      continue;
    }
    if (/^Serial No\b/i.test(L[i])) {
      i += 1;
      if (i < L.length) i += 1; // / batch / expiry line
      continue;
    }
    if (/^Old Product No$/i.test(L[i])) {
      i += 1;
      if (i < L.length) i += 1; // old code
      continue;
    }
    if (/^Ord Taken by$/i.test(L[i])) {
      i += 1;
      if (i < L.length) i += 1; // operator name
      continue;
    }

    if (/%\s*Material\s+Grp/i.test(L[i]) || /Material\s+Grp\.?\s*Disc/i.test(L[i])) {
      i++;
      if (i < L.length && isMoneyToken(L[i])) i++;
      continue;
    }
    if (/^-\d[\d.,]*\s*%/.test(L[i])) {
      i++;
      if (i < L.length && isMoneyToken(L[i])) i++;
      continue;
    }

    let alconOrderLineRef = null;
    let productCode = null;

    if (/^\d{10,12}$/.test(L[i])) {
      alconOrderLineRef = L[i];
      i++;
    }

    if (
      i < L.length &&
      /^\d{6,9}$/.test(L[i]) &&
      L[i + 1] &&
      !isLikelyQty(L[i + 1]) &&
      !isMoneyToken(L[i + 1])
    ) {
      productCode = L[i];
      i++;
    }

    const descParts = [];
    while (i < L.length) {
      const l = L[i];
      if (
        /^Customer reference$/i.test(l) ||
        /^Serial No\b/i.test(l) ||
        /^Old Product No$/i.test(l) ||
        /^Ord Taken by$/i.test(l)
      ) {
        break;
      }
      if (/^\d{10,12}$/.test(l) && descParts.length === 0) {
        break;
      }
      if (isLikelyQty(l) && descParts.length > 0) {
        break;
      }
      if (isLikelyQty(l) && descParts.length === 0) {
        break;
      }
      descParts.push(l);
      i++;
    }

    if (descParts.length === 0 || i >= L.length) {
      if (i < L.length) i++;
      continue;
    }

    if (!isLikelyQty(L[i])) {
      i++;
      continue;
    }
    const qty = parseInt(L[i], 10);
    i++;
    if (i >= L.length || !isLikelyUom(L[i])) {
      break;
    }
    const uom = L[i];
    i++;

    const nums = [];
    while (i < L.length && nums.length < 4 && isMoneyToken(L[i])) {
      nums.push(parseMoneyAud(L[i]));
      i++;
    }
    if (nums.length < 4) {
      break;
    }

    const productDescription = descParts.join(' ').trim();
    const lineKind = /^FREIGHT\b/i.test(productDescription)
      ? 'freight'
      : 'product';

    lineItems.push({
      lineKind,
      alconOrderLineRef,
      productCode,
      productDescription,
      qty,
      uom,
      unitPriceExGst: nums[0],
      extendedPriceExGst: nums[1],
      amountDueInclGst: nums[2],
      gst: nums[3]
    });
  }

  return lineItems;
}

/**
 * mergedText(또는 inspect JSON 의 mergedPreview) 한 덩어리에서 필드 추출.
 * 레이아웃은 실제 샘플( TAX INVOICE / Date / Invoice Number / Bill To NNN ) 기준.
 * @param {string} normalized normalizeExtractText 적용된 본문
 */
export function extractAlconInvoiceFieldsPlaceholder(normalized) {
  const text = normalizeExtractText(normalized);
  const flat = text.replace(/\n+/g, ' ');

  const invoiceNumber =
    (text.match(
      /Invoice\s+Number\s+(?:\n\s*)+(\d{2}\.\d{2}\.\d{4})\s+(?:\n\s*)+(\d{6,})/i
    ) ||
      text.match(
        /Invoice\s+Number[\s\S]{0,80}?(\d{2}\.\d{2}\.\d{4})[\s\S]{0,40}?(\d{6,})/i
      ))?.[2] ?? null;

  const invoiceDate =
    (text.match(
      /Invoice\s+Number\s+(?:\n\s*)+(\d{2}\.\d{2}\.\d{4})\s+(?:\n\s*)+\d{6,}/i
    ) ||
      text.match(/(\d{2}\.\d{2}\.\d{4})\s+(?:\n\s*)+(\d{6,})\s*\n/i))?.[1] ?? null;

  const abnRaw = text.match(/ABN:\s*([\d\s]+)/i)?.[1]?.trim().replace(/\s+/g, ' ') ?? null;

  const billToAccount = text.match(/Bill\s+To\s+(\d+)/i)?.[1] ?? null;
  const shipToAccount = text.match(/Ship\s+to\s+(\d+)/i)?.[1] ?? null;

  let billToLines = null;
  if (billToAccount) {
    const block = text.match(
      new RegExp(
        `Bill\\s+To\\s+${billToAccount}\\s*\\n([\\s\\S]*?)(?=\\n\\s*Ship\\s+to\\s)`,
        'i'
      )
    );
    if (block?.[1]) {
      billToLines = block[1]
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }
  }

  const currency = /\bAUD\b/.test(text) ? 'AUD' : null;

  const netGoods = parseMoneyAud(
    text.match(/Net\s+Goods\s+Value\s+(?:\n\s*)+AUD\s+(?:\n\s*)+([\d.,-]+)/i)?.[1]
  );
  const totalFreight = parseMoneyAud(
    text.match(/Total\s+Freight\s+charge\s+(?:\n\s*)+AUD\s+(?:\n\s*)+([\d.,-]+)/i)?.[1]
  );
  const totalGst = parseMoneyAud(
    text.match(/Total\s+GST\s+(?:\n\s*)+AUD\s+(?:\n\s*)+([\d.,-]+)/i)?.[1]
  );
  const total = parseMoneyAud(
    text.match(/Amt\s+Due\s+incl\s+GST\s+(?:\n\s*)+AUD\s+(?:\n\s*)+([\d.,-]+)/i)?.[1]
  );

  const paymentDueOn =
    text.match(/Payment\s+Due\s+On\s+(?:\n\s*)+(\d{2}\.\d{2}\.\d{4})/i)?.[1] ?? null;
  const alconSo = text.match(/Alcon\s+SO\s+(?:\n\s*)+(\d+)/i)?.[1] ?? null;
  const yourOrderRef =
    flat.match(/Your\s+Order\s+Ref\s+(\d+)\s*\/\s*(\d{2}\.\d{2}\.\d{4})/i)?.[1] ?? null;

  const lineItems = extractAlconLineItemsVertical(text);
  const lineItemsForXero = lineItems.map((li) => {
    const accountCode =
      li.lineKind === 'freight' ? alconFreightAccountCode() : alconExpenseAccountCode();
    return {
      ...li,
      accountCode,
      taxType: chooseAlconTaxTypeByGst(li.gst)
    };
  });
  const matchedBranch = matchBranchByAlconAccount(billToAccount);

  const discountPct = flat.match(/-?([\d.,]+)\s*%\s*Material\s+Grp\.\s*Disc/i)?.[1] ?? null;
  const discountAmount = parseMoneyAud(
    text.match(/Material\s+Grp\.\s*Disc\.%\s+(?:\n\s*)+(-?[\d.,]+)/i)?.[1]
  );

  return {
    billToNumber: billToAccount,
    invoiceNumber,
    invoiceDate,
    invoiceDateNormalized: invoiceDate ? invoiceDate.replace(/\./g, '/') : null,
    paymentDueOn,
    paymentDueOnNormalized: paymentDueOn ? paymentDueOn.replace(/\./g, '/') : null,
    abn: abnRaw,
    alconBillToAccount: billToAccount,
    alconShipToAccount: shipToAccount,
    matchedBranchCode: matchedBranch?.code || null,
    matchedBranchName: matchedBranch?.name || null,
    matchedEntity: matchedBranch?.entity || null,
    billToLines,
    currency,
    subtotal: netGoods,
    totalFreight,
    gst: totalGst,
    total,
    alconSo,
    yourOrderRef,
    discountPct,
    discountAmount,
    lineItems,
    lineItemsForXero,
    xeroDefaults: {
      expenseAccountCode: alconExpenseAccountCode(),
      freightAccountCode: alconFreightAccountCode(),
      taxFreeCode: alconTaxTypeFreeExpenses(),
      taxOnExpensesCode: alconTaxTypeOnExpenses()
    }
  };
}

/**
 * 디버그: PDF 버퍼 → 페이지별 텍스트·플레이스홀더 필드 (통상 pages.length === 1)
 * @param {Buffer} buffer
 */
export async function inspectAlconPdfBuffer(buffer) {
  const pdf = await getDocument(getPdfDocumentParams(buffer)).promise;
  const out = {
    numPages: pdf.numPages,
    pages: []
  };

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items || [];
    const rawText = items.map((it) => ('str' in it ? it.str : '')).join('\n');
    const spaceJoined = items.map((it) => ('str' in it ? it.str : '')).join(' ');
    const readingOrderText = buildReadingOrderText(textContent);
    const merged = pickBestAlconMergeCandidate(rawText, readingOrderText, spaceJoined);
    const normalized = normalizeExtractText(merged);
    const nonEmpty = items.filter((it) => 'str' in it && String(it.str).trim()).length;

    out.pages.push({
      page: pageNum,
      textItemCount: items.length,
      nonEmptyTextItemCount: nonEmpty,
      fieldsPlaceholder: extractAlconInvoiceFieldsPlaceholder(normalized),
      mergedPreview: merged.slice(0, 16000),
      previewRaw: rawText.slice(0, 12000),
      previewReading: readingOrderText.slice(0, 12000),
      previewSpace: spaceJoined.slice(0, 12000)
    });
  }

  return out;
}

function pickBestAlconMergeCandidate(rawText, readingOrderText, spaceJoined) {
  const a = normalizeExtractText(rawText);
  const b = normalizeExtractText(readingOrderText);
  const c = normalizeExtractText(spaceJoined);
  const scored = [
    { text: a, score: scoreTextForAlconHeuristic(a) },
    { text: b, score: scoreTextForAlconHeuristic(b) },
    { text: c, score: scoreTextForAlconHeuristic(c) }
  ];
  scored.sort((x, y) => y.score - x.score);
  return scored[0].text;
}

/** 알콘 인보이스에 흔한 토큰이 있으면 가산 (매핑 전 휴리스틱) */
function scoreTextForAlconHeuristic(text) {
  const t = text.toUpperCase();
  let s = 0;
  if (/\bALCON\b/.test(t)) s += 3;
  if (/\bTAX\s*INVOICE\b/.test(t)) s += 2;
  if (/\bABN\b/.test(t)) s += 1;
  if (/\bGST\b/.test(t)) s += 1;
  if (/\bINVOICE\b/.test(t)) s += 1;
  return s;
}

/**
 * Alcon 메일 첨부 PDF 1개 파싱 — 통상 1페이지만 있음(`invoices.length === 1`).
 * 여러 페이지가 있으면 경고 후 페이지마다 항목을 넣음(비정상·수동 확인용).
 * @param {Buffer} buffer
 * @param {{ attachmentFileName?: string }} [options]
 * @returns {Promise<{
 *   invoices: Array<{
 *     page: number,
 *     attachmentFileName?: string,
 *     rawText: string,
 *     readingOrderText: string,
 *     spaceJoined: string,
 *     mergedText: string,
 *     fields: Record<string, unknown>
 *   }>,
 *   pageErrors: Array<{ page: number, error: string }>
 * }>}
 */
export async function parseAlconTaxInvoicePdf(buffer, options = {}) {
  const pdf = await getDocument(getPdfDocumentParams(buffer)).promise;
  if (pdf.numPages !== 1) {
    console.warn(
      '[Alcon PDF] 기대: 1페이지/파일 — 실제 페이지 수:',
      pdf.numPages,
      options.attachmentFileName ? `(${options.attachmentFileName})` : ''
    );
  }
  const invoices = [];
  const pageErrors = [];
  const attName = options.attachmentFileName;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = textContent.items || [];
      const rawText = items.map((it) => ('str' in it ? it.str : '')).join('\n');
      const spaceJoined = items.map((it) => ('str' in it ? it.str : '')).join(' ');
      const readingOrderText = buildReadingOrderText(textContent);
      const mergedText = pickBestAlconMergeCandidate(
        rawText,
        readingOrderText,
        spaceJoined
      );
      const normalized = normalizeExtractText(mergedText);

      invoices.push({
        page: pageNum,
        attachmentFileName: attName,
        rawText: normalizeExtractText(rawText),
        readingOrderText: normalizeExtractText(readingOrderText),
        spaceJoined: normalizeExtractText(spaceJoined),
        mergedText: normalized,
        fields: extractAlconInvoiceFieldsPlaceholder(normalized)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pageErrors.push({ page: pageNum, error: msg });
    }
  }

  return { invoices, pageErrors };
}
