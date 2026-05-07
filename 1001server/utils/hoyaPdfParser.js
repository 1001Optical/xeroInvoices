/**
 * Hoya Daily Combined Invoice PDF: 한 파일에 여러 페이지 = 각 페이지가 인보이스 1건.
 * 메일에는 이런 PDF가 여러 첨부될 수 있음 — 호출 쪽(gmailHoyaPipeline)에서 첨부마다 이 모듈을 호출.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

/**
 * pdf.js는 Node의 Buffer(Uint8Array 서브클래스)를 data로 받지 않음 — 순수 Uint8Array로 복사
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 */
function toPlainUint8Array(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (Buffer.isBuffer(buffer)) return Uint8Array.from(buffer);
  if (buffer instanceof Uint8Array) return Uint8Array.from(buffer);
  return new Uint8Array(buffer);
}

/** pdf.js 문서 옵션: disableFontFace 는 임베드 폰트(TT 경고) 시 텍스트 추출이 나아지는 경우가 있음 */
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
 * @param {Buffer} buffer
 * @returns {Promise<{
 *   invoices: Array<object>,
 *   pageErrors: Array<{ page: number, error: string }>
 * }>}
 */
/**
 * pdf.js 기본 순서(join \\n)로는 라벨·값이 떨어져 매칭 실패할 때가 있어,
 * 좌표 기준(위→아래, 왼→오)으로 한 줄씩 이어 붙인 텍스트도 함께 시도합니다.
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
 * Gmail 첨부 등 파일명에서 인보이스 번호 힌트 (예: INVOICES_015799.pdf)
 * @param {string} [fileName]
 */
export function extractReferenceHintFromAttachmentName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const base = fileName.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/i, '');
  const m1 = base.match(/INVOICES[_-]?([A-Z0-9]+)/i);
  if (m1?.[1]) return m1[1].trim();
  const m2 = base.match(/\b(IN\d{4,})\b/i);
  if (m2?.[1]) return m2[1].trim();
  const m3 = base.match(/\b(FCN[A-Z0-9]+)\b/i);
  if (m3?.[1]) return m3[1].trim();
  return null;
}

/**
 * PDF 버퍼만으로 추출 텍스트·파싱 결과 덤프 (디버그·inspect 명령용)
 * @param {Buffer} buffer
 */
export async function inspectHoyaPdfBuffer(buffer) {
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
    const withSpaces = mergeHoyaParseAttempts(rawText, readingOrderText, spaceJoined);
    const nonEmpty = items.filter((it) => 'str' in it && String(it.str).trim()).length;
    out.pages.push({
      page: pageNum,
      textItemCount: items.length,
      nonEmptyTextItemCount: nonEmpty,
      parsed: withSpaces,
      previewRaw: rawText.slice(0, 12000),
      previewReading: readingOrderText.slice(0, 12000),
      previewSpace: spaceJoined.slice(0, 12000)
    });
  }
  return out;
}

/**
 * @param {Buffer} buffer
 * @param {{ attachmentFileName?: string }} [options]
 */
export async function parseHoyaCombinedPdf(buffer, options = {}) {
  const pdf = await getDocument(getPdfDocumentParams(buffer)).promise;
  const invoices = [];
  const pageErrors = [];
  const refHint = extractReferenceHintFromAttachmentName(options.attachmentFileName);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const rawText = textContent.items.map((it) => ('str' in it ? it.str : '')).join('\n');
      const spaceJoined = textContent.items
        .map((it) => ('str' in it ? it.str : ''))
        .join(' ');
      const readingOrderText = buildReadingOrderText(textContent);

      let fields;
      try {
        fields = mergeHoyaParseAttempts(rawText, readingOrderText, spaceJoined);
        if (!fields.referenceNumber && refHint) {
          fields = { ...fields, referenceNumber: refHint };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pageErrors.push({ page: pageNum, error: `field parse: ${msg}` });
        invoices.push({
          page: pageNum,
          rawText,
          referenceNumber: null,
          invoiceDate: null,
          soldTo: null,
          storeLine: null,
          lineItems: [],
          documentKind: 'supplier_invoice',
          fieldParseFailed: true
        });
        continue;
      }

      invoices.push({
        page: pageNum,
        rawText,
        ...fields
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pageErrors.push({ page: pageNum, error: msg });
    }
  }

  return { invoices, pageErrors };
}

/**
 * @param {string} primary join(\\n)
 * @param {string} secondary 읽기 순서
 * @param {string} [tertiary] join(공백) — 라벨·값이 한 줄로 이어질 때
 */
function countMeaningfulLineItems(items) {
  if (!items?.length) return 0;
  return items.filter((li) => {
    const d = (li?.description || '').trim();
    const q = parseFloat(String(li?.qty ?? '').replace(/,/g, ''));
    const p = parseFloat(String(li?.price ?? '').replace(/,/g, ''));
    const amt = parseFloat(String(li?.amount ?? '').replace(/,/g, ''));
    const hasNum =
      (Number.isFinite(q) && q !== 0) ||
      (Number.isFinite(p) && p !== 0) ||
      (Number.isFinite(amt) && amt !== 0);
    return !!(d || hasNum);
  }).length;
}

function storeMetaQuality(x) {
  const sl = String(x?.storeLine || '').trim();
  const st = String(x?.soldTo || '');
  if (/\b1001\s+OPTICAL\s+CENTRAL\s+DISTRIBUTION\b/i.test(sl)) return 4;
  if (/\b1001\s+OPTICAL\s+CENTRAL\s+DISTRIBUTION\b/i.test(st)) return 4;
  if (/^\s*account\b/im.test(st) && !/\b1001\b/i.test(st)) return 0;
  if (sl.toLowerCase() === 'account') return 0;
  if (/\bdelivery\s+note\s+no\.?/i.test(st) && !/\b1001\s+OPTICAL\b/i.test(st)) return 0;
  return sl || st ? 1 : 0;
}

function mergeHoyaParseAttempts(primary, secondary, tertiary) {
  const a = parseHoyaInvoicePageText(normalizeExtractText(primary));
  const b = parseHoyaInvoicePageText(normalizeExtractText(secondary));
  const c = tertiary
    ? parseHoyaInvoicePageText(normalizeExtractText(tertiary))
    : {
        lineItems: [],
        soldTo: null,
        storeLine: null,
        documentKind: 'supplier_invoice'
      };

  const attempts = [a, b, c];
  let bestItems = [];
  let bestLiScore = -1;
  for (const x of attempts) {
    const s = countMeaningfulLineItems(x.lineItems);
    if (s > bestLiScore) {
      bestLiScore = s;
      bestItems = x.lineItems || [];
    }
  }
  if (bestLiScore <= 0) {
    bestItems = a.lineItems?.length
      ? a.lineItems
      : b.lineItems?.length
        ? b.lineItems
        : c.lineItems || [];
  }

  const metaPick = attempts.reduce((best, x) =>
    storeMetaQuality(x) > storeMetaQuality(best) ? x : best
  );

  const documentKind =
    a.documentKind === 'supplier_credit_note' ||
    b.documentKind === 'supplier_credit_note' ||
    c.documentKind === 'supplier_credit_note'
      ? 'supplier_credit_note'
      : 'supplier_invoice';

  return {
    referenceNumber: a.referenceNumber || b.referenceNumber || c.referenceNumber,
    invoiceDate: a.invoiceDate || b.invoiceDate || c.invoiceDate,
    soldTo: metaPick.soldTo || a.soldTo || b.soldTo || c.soldTo,
    storeLine: metaPick.storeLine || a.storeLine || b.storeLine || c.storeLine,
    lineItems: bestItems,
    documentKind
  };
}

/** 공백·줄바꿈 정규화한 문자열에서 시도 (라벨·값 분리 대응) */
function squeezeText(text) {
  return text.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * 인보이스 번호: IN… 고정이 아닌 D365 변형까지 시도
 * @param {string} normalized 줄바꿈 유지
 * @param {string} flat 한 줄
 */
/**
 * TAX INVOICE 다음 몇 줄 안의 INxxxxxxxx (PDF에서 제목과 번호가 줄이 갈라질 때)
 * TAX / INVOICE 가 서로 다른 줄에만 있는 경우도 포함
 */
function extractReferenceAfterTaxInvoice(normalized) {
  const m = normalized.match(/\bTAX(?:\s+|\s*[\r\n]+\s*)INVOICE\b/i);
  if (!m || m.index == null) return null;
  const tail = normalized.slice(m.index + m[0].length);
  const lines = tail
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (/^INVOICE\s*(?:NUMBER|NO\.?)/i.test(line)) continue;
    const im = line.match(/^(IN\d{4,})\b/i);
    if (im?.[1]) return im[1].trim();
    const im2 = line.match(/\b(IN\d{5,})\b/i);
    if (im2?.[1]) return im2[1].trim();
  }
  return null;
}

/** 본문에서 크레딧 문서 구분 — 공백 없는 CREDITNOTE 도 허용 */
const HOYA_CREDIT_NOTE_MARK = /\bCREDIT\s*NOTE\b/i;

const SKIP_CREDIT_REF_LINE =
  /^(CREDIT\s*NOTE(\s+(DATE|NUMBER))?|HOYA\b|ABN\b|MAIL\s+TO:|TEL\.|FAX\(|UNIT\s+\d)/i;

/**
 * CREDIT NOTE NUMBER 라벨 뒤에서 문서번호 추출 (FCN/CN 등 접두에 의존하지 않음)
 */
function filterCreditNoteDocumentNumber(raw) {
  const v = filterBogusReference(String(raw).replace(/^[*]+|[*]+$/g, '').trim());
  if (!v) return null;
  if (/^0+$/.test(v)) return null;
  /** 짧은 순수 숫자(배치·연도)는 문서번호로 쓰지 않음 */
  if (/^\d+$/.test(v) && v.length < 8) return null;
  if (/^(19|20)\d{2}$/.test(v)) return null;
  const lower = v.toLowerCase();
  if (
    lower === 'credit' ||
    lower === 'note' ||
    lower === 'number' ||
    lower === 'date' ||
    /^credit\s*note$/i.test(v)
  ) {
    return null;
  }
  return v;
}

function extractHoyaSupplierCreditNoteNumber(normalized, flat) {
  if (!HOYA_CREDIT_NOTE_MARK.test(normalized)) return null;
  const candidates = [normalized, flat, squeezeText(normalized)];
  for (const hay of candidates) {
    const m = hay.match(/\bCREDIT\s*NOTE\s+NUMBER\b/i);
    if (!m || m.index == null) continue;
    const tail = hay.slice(m.index + m[0].length);
    const lines = tail.split(/\n/).map((l) => l.trim());
    for (const line of lines.slice(0, 24)) {
      if (!line || SKIP_CREDIT_REF_LINE.test(line)) continue;
      const tokens = line.split(/\s+/);
      for (const tok of tokens) {
        const t = tok.replace(/^[*]+|[*]+$/g, '');
        if (/^[A-Z0-9][A-Z0-9_-]{3,}$/i.test(t)) {
          const ok = filterCreditNoteDocumentNumber(t);
          if (ok) return ok;
        }
      }
    }
  }
  return null;
}

const BOGUS_REFERENCE_TOKENS = new Set([
  'quantity',
  'description',
  'amount',
  'patient',
  'delivery',
  'reference',
  'account',
  'total',
  'number',
  'date',
  'invoice',
  'invoices',
  'tax',
  'note',
  'credit'
]);

function filterBogusReference(ref) {
  if (ref == null || ref === '') return null;
  const s = String(ref).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (BOGUS_REFERENCE_TOKENS.has(lower)) return null;
  /** TAX INVOICE 옆 토큰으로 잡힌 라벨 (IN + … 패턴 오탐) */
  if (/^in\s*voices?$/i.test(s)) return null;
  /**
   * IN으로 시작하지만 숫자가 없음 → "INVOICE" 등 (\bIN[A-Z0-9]…\b 오탐 방지).
   * Hoya 공급 인보이스 번호는 IN + 숫자(또는 FCN…) 형태가 대부분.
   */
  if (/^IN[A-Z0-9_-]+$/i.test(s) && !/\d/.test(s)) return null;
  return s;
}

function extractReferenceNumber(normalized, flat) {
  const creditRef = extractHoyaSupplierCreditNoteNumber(normalized, flat);
  if (creditRef) return creditRef;

  const candidates = [normalized, flat, squeezeText(normalized)];
  /** 같은 줄 / 다음 줄 — Hoya TAX INVOICE 블록 (ORIGINAL INVOICE NUMBER 는 제외) */
  /** IN… 는 숫자 포함 필수 — 단어 INVOICE 가 IN+V+… 로 잡히는 것 방지 */
  const inWithDigit = 'IN(?=[A-Z0-9_-]*\\d)[A-Z0-9][A-Z0-9_-]*';
  const refPatterns = [
    new RegExp(`TAX\\s+INVOICE\\s+(${inWithDigit})`, 'i'),
    new RegExp(`TAX\\s+INVOICE\\s*[\\r\\n]+\\s*(${inWithDigit})`, 'im'),
    /TAX\s+INVOICE\s*[\s\n]+\b(IN\d{5,})\b/i,
    /(?<!\bORIGINAL\s)INVOICE\s*(?:NUMBER|NO\.?)\s*:?\s*(IN[A-Z0-9][A-Z0-9_-]*)/i,
    /(?<!\bORIGINAL\s)INVOICE\s*(?:NUMBER|NO\.?)\s*:?\s*([A-Z]{1,6}\d[A-Z0-9_-]*)/i,
    /(?<!\bORIGINAL\s)INVOICE\s*(?:NUMBER|NO\.?)\s*:?\s*(\d{5,12})/,
    /(?<!\bORIGINAL\s)Invoice\s*(?:Number|No\.?)\s*:?\s*([A-Z0-9][A-Z0-9_-]{3,})/i,
    /\b(IN\d{4,})\b/i,
    /\b(INV[A-Z0-9][A-Z0-9_-]{2,})\b/i
  ];
  for (const hay of candidates) {
    for (const re of refPatterns) {
      const m = hay.match(re);
      if (m?.[1]) {
        const v = filterBogusReference(m[1].trim());
        if (v) return v;
      }
    }
  }
  const tailRef = extractReferenceAfterTaxInvoice(normalized);
  return filterBogusReference(tailRef);
}

/**
 * @param {string} normalized
 * @param {string} flat
 */
function extractInvoiceDate(normalized, flat) {
  const candidates = [normalized, flat, squeezeText(normalized)];
  /** DD MMM YYYY (예: 15 Apr 2026) — 라벨 INVOICE DATE 와 값이 떨어진 Hoya */
  const datePatterns = [
    /CREDIT\s*NOTE\s+DATE\s*[\s:]*(?:[\r\n]+\s*)*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})/i,
    /INVOICE\s*DATE\s*:?\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})/i,
    /\b([0-9]{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+[0-9]{4})\b/i,
    /INVOICE\s*DATE\s*:?\s*([0-9]{1,2}\s*[/\-.]\s*[0-9]{1,2}\s*[/\-.]\s*[0-9]{2,4})/i,
    /Invoice\s*date\s*:?\s*([0-9]{1,2}\s*[/\-.]\s*[0-9]{1,2}\s*[/\-.]\s*[0-9]{2,4})/i,
    /DATE\s*OF\s*INVOICE\s*:?\s*([0-9]{1,2}\s*[/\-.]\s*[0-9]{1,2}\s*[/\-.]\s*[0-9]{2,4})/i,
    /Document\s*date\s*:?\s*([0-9]{1,2}\s*[/\-.]\s*[0-9]{1,2}\s*[/\-.]\s*[0-9]{2,4})/i
  ];
  for (const hay of candidates) {
    for (const re of datePatterns) {
      const m = hay.match(re);
      if (m?.[1]) {
        const raw = m[1].trim();
        if (/\d{1,2}\s+[A-Za-z]{3}/.test(raw)) {
          return raw.replace(/\s+/g, ' ');
        }
        return raw.replace(/\s+/g, '').trim();
      }
    }
  }
  const flatOne = squeezeText(normalized);
  const idx = flatOne.toLowerCase().indexOf('invoice');
  if (idx >= 0) {
    const tail = flatOne.slice(idx);
    const dm = tail.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dm?.[1]) return dm[1].trim();
  }
  return null;
}

/**
 * 한 페이지 텍스트에서 필드 추출 (레이아웃 차이에 대비해 여러 패턴 시도)
 * @param {string} text
 */
export function parseHoyaInvoicePageText(text) {
  const normalized = normalizeExtractText(text).replace(/\r/g, '\n');
  const flat = normalized.replace(/\n+/g, ' ');

  const referenceNumber = extractReferenceNumber(normalized, flat);

  let invoiceDate = extractInvoiceDate(normalized, flat);

  let soldTo = null;
  let storeLine = null;
  const tableStartAhead =
    '(?=PRODUCT\\s*DESCRIPTION|\\n\\s*Description\\b|INVOICE\\s*(?:NUMBER|DATE)|$)';
  const soldPatterns = [
    new RegExp(`SOLD\\s*TO\\s*([\\s\\S]*?)${tableStartAhead}`, 'i'),
    new RegExp(
      `SHIP\\s*TO\\s+(?!Account\\b)([\\s\\S]*?)${tableStartAhead}`,
      'i'
    ),
    new RegExp(`CUSTOMER\\s*([\\s\\S]*?)${tableStartAhead}`, 'i')
  ];
  for (const re of soldPatterns) {
    const soldBlock = normalized.match(re);
    if (soldBlock) {
      soldTo = soldBlock[1].trim().replace(/\n{2,}/g, '\n');
      const lines = soldTo.split('\n').map((l) => l.trim()).filter(Boolean);
      storeLine = lines.find((l) => /1001/i.test(l)) || lines[0] || null;
      break;
    }
  }

  /**
   * Hoya: Central 주소 블록 — SOLD TO 정규식이 세로 레이아웃·표 헤더(Account…)만 잡은 경우 덮어씀
   */
  const hasCentral = /\b1001\s+OPTICAL\s+CENTRAL\s+DISTRIBUTION\b/i.test(normalized);
  const centralLooksWrong =
    !soldTo ||
    /^\s*account\b/im.test(String(soldTo)) ||
    String(storeLine || '')
      .trim()
      .toLowerCase() === 'account' ||
    (/\bdelivery\s+note\s+no\.?/i.test(String(soldTo)) &&
      !/\b1001\s+OPTICAL\b/i.test(String(soldTo)));
  if (hasCentral && centralLooksWrong) {
    const anchor = /\b1001\s+OPTICAL\s+CENTRAL\s+DISTRIBUTION\b/i;
    const am = normalized.match(anchor);
    if (am?.index != null) {
      const tail = normalized.slice(am.index);
      const stopPd = tail.search(/\n\s*PRODUCT\s*DESCRIPTION\b/i);
      const stopDesc = tail.search(
        /\n\s*Description\b[\s\S]{0,120}?\bQ(?:ty|TY)\b[\s\S]{0,80}?\bPRICE\b/i
      );
      const stopCands = [stopPd, stopDesc].filter((i) => i >= 0);
      const stopIdx = stopCands.length ? Math.min(...stopCands) : -1;
      const slice =
        stopIdx >= 0 ? tail.slice(0, stopIdx) : tail.slice(0, Math.min(tail.length, 800));
      soldTo = slice.trim().replace(/\n{3,}/g, '\n\n');
      const lines = soldTo.split('\n').map((l) => l.trim()).filter(Boolean);
      storeLine = lines.find((l) => /1001/i.test(l)) || lines[0] || null;
    }
  }

  let lineItems = extractProductLineItems(normalized);
  const isCredit = HOYA_CREDIT_NOTE_MARK.test(normalized);
  if (isCredit) {
    const cn = extractCreditNoteLineItems(normalized);
    if (cn.length > 0) lineItems = cn;
  }

  /**
   * PRODUCT DESCRIPTION 없이 한 줄에만 나오는 요금·배송 라인
   * 예: "Delivery Charge - April 2026 1 12.00 1.20 13.20"
   * extractProductLineItems 는 PRODUCT DESCRIPTION 앵커가 없으면 [] → Xero 0원 폴백 라인만 들어가던 케이스
   */
  if (!isCredit && lineItems.length === 0) {
    const standalone = parseHoyaLensRowsTrailingFourNumbers(normalized);
    if (standalone.length > 0) {
      const seen = new Set();
      lineItems = [];
      for (const r of standalone) {
        const k = `${r.description}|${r.qty}|${r.price}|${r.gst}|${r.amount}`;
        if (seen.has(k)) continue;
        seen.add(k);
        lineItems.push(r);
      }
    }
  }

  const documentKind = isCredit ? 'supplier_credit_note' : 'supplier_invoice';

  return {
    referenceNumber,
    invoiceDate,
    soldTo,
    storeLine,
    lineItems,
    documentKind
  };
}

/**
 * QTY 헤더 이후 표 형태: 한 줄에 수량·단가·GST·금액 4열 (PDF 텍스트가 한 줄로 나올 때)
 */
/** 표 헤더 한 줄 (QTY PRICE GST …) */
const HOYA_TABLE_HEADER_LINE = /\bQTY\b.*\bPRICE\b.*\bGST\b/i;

/**
 * 한 줄 끝에 Qty·Unit·GST·Amount 네 숫자가 붙는 Hoya 형식
 * 예: OT-PZGR-1.50 HARD / R SPH 0.00 1 20.00 2.00 22.00
 */
function parseHoyaLensRowsTrailingFourNumbers(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  let baseProduct = '';

  for (const line of lines) {
    if (/^product\s*description/i.test(line)) continue;
    if (HOYA_TABLE_HEADER_LINE.test(line)) continue;
    if (/^\s*sales\s+order\s+no\.?/i.test(line)) break;
    if (/^\*[\d,*]+\*$/.test(line.replace(/\s/g, ''))) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 5) {
      if (/[A-Za-z]/.test(line) && !/^[\d\s,.-]+$/.test(line)) {
        baseProduct = line.replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    const tail = [];
    let idx = tokens.length - 1;
    while (idx >= 0 && tail.length < 4) {
      const raw = String(tokens[idx]).replace(/,/g, '');
      if (/^-?\d+\.?\d*$/.test(raw)) {
        tail.unshift(raw);
        idx--;
      } else break;
    }
    if (tail.length < 4) {
      if (/[A-Za-z]/.test(line) && tokens.length <= 8) {
        baseProduct = line.replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    const specTokens = tokens.slice(0, tokens.length - 4);
    const spec = specTokens.join(' ').trim();
    if (!spec) continue;

    const desc = [baseProduct, spec].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    out.push({
      description: desc,
      qty: tail[0],
      price: tail[1],
      gst: tail[2],
      amount: tail[3]
    });
  }
  return out;
}

/**
 * 제품/렌즈 코드 줄 다음에 qty·price·gst·amount (한 줄 네 숫자 또는 PDF에서 네 줄로 쪼개진 경우)
 * 예: OT-SVF-1.50 MC / 1 1.25 0.00 1.25  또는  OT… 후 줄바꿈 1 / 1.96 / 0.00 / 1.96
 */
function parseHoyaProductNumericPairRows(block) {
  const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let pendingDesc = null;
  let numBuffer = [];

  const flushBufferedQuad = () => {
    if (pendingDesc && numBuffer.length === 4) {
      out.push({
        description: pendingDesc.replace(/\s+/g, ' ').trim().slice(0, 2000),
        qty: numBuffer[0],
        price: numBuffer[1],
        gst: numBuffer[2],
        amount: numBuffer[3]
      });
      pendingDesc = null;
    }
    numBuffer = [];
  };

  for (const line of lines) {
    if (/^product\s*description/i.test(line)) continue;
    if (HOYA_TABLE_HEADER_LINE.test(line)) {
      flushBufferedQuad();
      pendingDesc = null;
      numBuffer = [];
      continue;
    }
    if (/^\s*sales\s+order\s+no\.?/i.test(line)) break;

    const tokens = line.split(/\s+/);
    const isQuad =
      tokens.length === 4 &&
      tokens.every((t) => /^-?\d+\.?\d*$/.test(String(t).replace(/,/g, '')));

    if (isQuad) {
      const descForRow = pendingDesc;
      flushBufferedQuad();
      out.push({
        description: (descForRow || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        qty: String(tokens[0]).replace(/,/g, ''),
        price: String(tokens[1]).replace(/,/g, ''),
        gst: String(tokens[2]).replace(/,/g, ''),
        amount: String(tokens[3]).replace(/,/g, '')
      });
      pendingDesc = null;
      numBuffer = [];
      continue;
    }

    const allTokNumeric =
      tokens.length >= 1 &&
      tokens.every((t) => /^-?\d+\.?\d*$/.test(String(t).replace(/,/g, '')));

    if (allTokNumeric && pendingDesc) {
      if (tokens.length === 1) {
        numBuffer.push(String(tokens[0]).replace(/,/g, ''));
        if (numBuffer.length === 4) {
          flushBufferedQuad();
        }
        continue;
      }
      numBuffer = [];
      continue;
    }

    flushBufferedQuad();
    numBuffer = [];

    if (/^\*[\d,*]+\*$/.test(line.replace(/\s/g, ''))) continue;
    if (/^\d{5,}\s+\d{3,}\s+/i.test(line)) {
      pendingDesc = null;
      continue;
    }

    if (/[A-Za-z]/.test(line) && line.length >= 2) {
      pendingDesc = line.replace(/\s+/g, ' ').trim();
    } else {
      pendingDesc = null;
    }
  }

  flushBufferedQuad();
  return out.filter((r) => r.qty && r.price);
}

function parseNumericRowsFromTableText(tableText) {
  const rows = [];
  for (const line of tableText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    if (/^qty$/i.test(parts[0])) continue;
    const qtyNum = parseFloat(String(parts[0]).replace(/,/g, ''));
    if (!Number.isFinite(qtyNum)) continue;
    rows.push({
      qty: parts[0].trim(),
      price: parts[1].trim(),
      gst: parts[2].trim(),
      amount: parts[3].trim()
    });
  }
  return rows;
}

/** 숫자만 있는 줄 (qty / unit / gst / line amount) */
function isNumericTokenLine(line) {
  const t = String(line).trim().replace(/,/g, '');
  if (t === '' || t === '-') return false;
  return /^-?\d+\.?\d*$/.test(t);
}

/** 처방·도수 줄: SPH… / (CYL+AXIS 조합 등) 렌즈 스펙 */
function isLensSpecLine(line) {
  const t = String(line).trim();
  if (/^[RL]\s+SPH\b/i.test(t)) return true;
  if (/^SPH\s/i.test(t)) return true;
  if (/^PL\s/i.test(t)) return true;
  if (/\bSPH\s*\+?-?[\d.]/.test(t) && /\bCYL\b/i.test(t)) return true;
  return false;
}

/**
 * Hoya 렌즈 인보이스: 한 제품명(S-HLEU HD DFUV) 아래 SPH… 줄마다 qty·price·gst·amount 가 세로로 나오는 경우
 * @param {string} block PRODUCT DESCRIPTION 이 포함된 블록
 */
function parseVerticalHoyaLensBlock(block) {
  const rawLines = block.split('\n').map((l) => l.trim());
  const lines = rawLines.filter((l) => l !== '');
  let start = 0;
  const amountIdx = lines.findIndex((l, idx) => /^amount$/i.test(l) && idx > 0);
  if (amountIdx >= 0) start = amountIdx + 1;
  else {
    const gstIdx = lines.findIndex((l) => /^gst$/i.test(l));
    if (gstIdx >= 0 && gstIdx + 1 < lines.length && /^amount$/i.test(lines[gstIdx + 1])) {
      start = gstIdx + 2;
    }
  }

  let baseDesc = '';
  let i = start;
  if (
    i < lines.length &&
    !isLensSpecLine(lines[i]) &&
    !isNumericTokenLine(lines[i]) &&
    !/^qty$/i.test(lines[i]) &&
    !/^price$/i.test(lines[i]) &&
    !/^gst$/i.test(lines[i]) &&
    !/^amount$/i.test(lines[i]) &&
    !/^product\s*description$/i.test(lines[i])
  ) {
    baseDesc = lines[i].replace(/\s+/g, ' ').trim();
    i++;
  }

  const items = [];
  while (i < lines.length) {
    const L = lines[i];
    if (/^quantity$/i.test(L)) break;
    if (/^total\s*au\$?$/i.test(L)) break;
    if (/^incl\s*gst$/i.test(L)) break;
    if (/^payment\s+terms/i.test(L)) break;

    if (isLensSpecLine(L)) {
      const spec = L.replace(/\s+/g, ' ').trim();
      i++;
      const nums = [];
      while (i < lines.length && nums.length < 4) {
        const t = lines[i];
        if (isLensSpecLine(t)) break;
        if (/^quantity$/i.test(t) || /^total/i.test(t)) break;
        if (isNumericTokenLine(t)) {
          nums.push(t.trim());
          i++;
        } else {
          break;
        }
      }
      if (nums.length === 4) {
        const description = [baseDesc, spec].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 2000);
        items.push({
          description,
          qty: nums[0],
          price: nums[1],
          gst: nums[2],
          amount: nums[3]
        });
      }
    } else {
      if (
        !isNumericTokenLine(L) &&
        !/^qty$/i.test(L) &&
        !/^price$/i.test(L) &&
        /^[A-Z0-9+].{3,}/i.test(L)
      ) {
        baseDesc = L.replace(/\s+/g, ' ').trim();
      }
      i++;
    }
  }
  return items;
}

function normalizeCreditNumericToken(raw) {
  const t = String(raw).trim().replace(/,/g, '');
  const p = t.match(/^\(([-\d.]+)\)$/);
  if (p) return String(-Math.abs(parseFloat(p[1])));
  return t;
}

function isCreditNoteAmountLine(line) {
  const t = String(line).trim().replace(/,/g, '');
  if (t === '' || t === '-') return false;
  if (/^-?\d+\.?\d*$/.test(t)) return true;
  return /^\(-?[\d.]+\)$/.test(t);
}

/**
 * Hoya 공급자 크레딧 노트: Description / Qty / PRICE / GST / Amount 표 (PRODUCT DESCRIPTION 없음)
 */
function extractCreditNoteLineItems(normalized) {
  const items = [];
  const dm = normalized.match(/\bDescription\b/i);
  if (!dm || dm.index == null) return items;

  let tail = normalized.slice(dm.index);
  const endIdx = tail.search(/\bSRN\s+NUMBER\b/i);
  if (endIdx > 0) tail = tail.slice(0, endIdx);

  const headProbe = tail.slice(0, 500);
  if (!/\bQ(?:ty|TY)\b/i.test(headProbe) || !/\bPRICE\b/i.test(headProbe)) return items;

  const lines = tail.split(/\n/).map((l) => l.trim());
  let i = 0;
  while (i < lines.length) {
    if (/^amount$/i.test(lines[i])) {
      i++;
      break;
    }
    i++;
  }

  let descParts = [];
  let numBuffer = [];

  const flushRow = () => {
    if (numBuffer.length === 4 && descParts.length > 0) {
      const description = descParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (description && !/^amount$/i.test(description)) {
        items.push({
          description,
          qty: numBuffer[0],
          price: numBuffer[1],
          gst: numBuffer[2],
          amount: numBuffer[3]
        });
      }
    }
    descParts = [];
    numBuffer = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (/^the title of\b/i.test(line)) break;
    if (/^payment\s+terms\b/i.test(line)) break;
    if (/^quantity$/i.test(line) && /total/i.test(String(lines[i + 1] || '').toLowerCase())) break;

    const oneLineQuad = line.match(
      /^(.+?)\s+(-?[\d.]+|\([\d.]+\))\s+(-?[\d.]+|\([\d.]+\))\s+(-?[\d.]+|\([\d.]+\))\s+(-?[\d.]+|\([\d.]+\))\s*$/
    );
    if (oneLineQuad && /[A-Za-z]{2,}/.test(oneLineQuad[1])) {
      flushRow();
      const d = oneLineQuad[1].trim();
      if (!/^(Qty|QTY|PRICE|GST|Amount|Description)$/i.test(d)) {
        items.push({
          description: d.slice(0, 2000),
          qty: normalizeCreditNumericToken(oneLineQuad[2]),
          price: normalizeCreditNumericToken(oneLineQuad[3]),
          gst: normalizeCreditNumericToken(oneLineQuad[4]),
          amount: normalizeCreditNumericToken(oneLineQuad[5])
        });
      }
      continue;
    }

    if (isCreditNoteAmountLine(line)) {
      if (descParts.length === 0 && numBuffer.length === 0) continue;
      numBuffer.push(normalizeCreditNumericToken(line));
      if (numBuffer.length === 4) {
        flushRow();
      }
      continue;
    }

    if (numBuffer.length > 0) {
      numBuffer = [];
    }
    if (/^qty$/i.test(line) || /^price$/i.test(line) || /^gst$/i.test(line) || /^amount$/i.test(line))
      continue;
    if (/[A-Za-z]/.test(line)) {
      descParts.push(line);
    }
  }
  flushRow();

  return items.filter((r) => r.description && (r.amount || r.price || r.qty));
}

/**
 * PRODUCT DESCRIPTION 블록마다 렌즈/금액 줄 추출
 * - 동일 설명 아래 QTY/PRICE/GST/AMOUNT 행이 여러 줄이면 각각 별도 라인 아이템
 * - 표 파싱 실패 시 기존 단일 정규식 폴백
 */
function extractProductLineItems(normalized) {
  const items = [];
  const re = /PRODUCT\s*DESCRIPTION/gi;
  let m;
  const starts = [];
  while ((m = re.exec(normalized)) !== null) {
    starts.push(m.index);
  }
  if (starts.length === 0) return items;

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : normalized.length;
    const block = normalized.slice(from, to);

    const descMatch = block.match(
      /PRODUCT\s*DESCRIPTION\s*([\s\S]*?)(?=\bQTY\b|\bPRICE\b|\bGST\b|\bAMOUNT\b)/i
    );
    const description = descMatch
      ? descMatch[1].trim().replace(/\s+/g, ' ').slice(0, 2000)
      : '';

    const verticalLens = parseVerticalHoyaLensBlock(block);
    if (verticalLens.length > 0) {
      for (const row of verticalLens) {
        items.push(row);
      }
      continue;
    }

    const pairRows = parseHoyaProductNumericPairRows(block);
    if (pairRows.length > 0) {
      for (const row of pairRows) {
        items.push(row);
      }
      continue;
    }

    const tableStart = block.search(/\bQTY\b/i);
    let numericRows = [];
    if (tableStart >= 0) {
      const tableText = block.slice(tableStart);
      numericRows = parseNumericRowsFromTableText(tableText);
    }

    if (numericRows.length > 0) {
      const headerDesc = description?.trim() || '';
      for (const row of numericRows) {
        items.push({
          description: headerDesc,
          qty: row.qty,
          price: row.price,
          gst: row.gst,
          amount: row.amount
        });
      }
      continue;
    }

    const sameLineLens = parseHoyaLensRowsTrailingFourNumbers(block);
    if (sameLineLens.length > 0) {
      for (const row of sameLineLens) {
        items.push(row);
      }
      continue;
    }

    const qtyMatch =
      block.match(/\bQTY\s*([0-9]+(?:\.[0-9]+)?)/i) ||
      block.match(/\bQTY\b[^\d\n]*\n\s*([0-9]+(?:\.[0-9]+)?)/i);
    const priceMatch = block.match(/\bPRICE\s*([$€£]?\s*[\d,.-]+)/i);
    const gstMatch = block.match(/\bGST\s*([$€£]?\s*[\d,.-]+)/i);
    const amtMatch =
      block.match(/\bAMOUNT\s*([$€£]?\s*[\d,.-]+)/i) ||
      block.match(/\bTOTAL\s*([$€£]?\s*[\d,.-]+)/i);

    const loose = (s) => parseFloat(String(s || '').replace(/[^0-9.-]/g, ''));
    const qtyN = qtyMatch ? loose(qtyMatch[1]) : NaN;
    const priceN = priceMatch ? loose(priceMatch[1]) : NaN;
    const amtN = amtMatch ? loose(amtMatch[1]) : NaN;
    const descOk = Boolean(description?.trim());
    const okPair =
      descOk &&
      Number.isFinite(qtyN) &&
      qtyN > 0 &&
      ((Number.isFinite(priceN) && priceN > 0) || (Number.isFinite(amtN) && amtN > 0));

    if (okPair) {
      items.push({
        description,
        qty: qtyMatch ? qtyMatch[1].trim() : null,
        price: priceMatch ? priceMatch[1].trim() : null,
        gst: gstMatch ? gstMatch[1].trim() : null,
        amount: amtMatch ? amtMatch[1].trim() : null
      });
    }
  }

  return items;
}
