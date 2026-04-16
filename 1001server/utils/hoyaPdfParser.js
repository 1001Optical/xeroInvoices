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
function mergeHoyaParseAttempts(primary, secondary, tertiary) {
  const a = parseHoyaInvoicePageText(normalizeExtractText(primary));
  const b = parseHoyaInvoicePageText(normalizeExtractText(secondary));
  const c = tertiary
    ? parseHoyaInvoicePageText(normalizeExtractText(tertiary))
    : { lineItems: [] };
  const lineItems = a.lineItems?.length
    ? a.lineItems
    : b.lineItems?.length
      ? b.lineItems
      : c.lineItems?.length
        ? c.lineItems
        : [];
  return {
    referenceNumber: a.referenceNumber || b.referenceNumber || c.referenceNumber,
    invoiceDate: a.invoiceDate || b.invoiceDate || c.invoiceDate,
    soldTo: a.soldTo || b.soldTo || c.soldTo,
    storeLine: a.storeLine || b.storeLine || c.storeLine,
    lineItems
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
function extractReferenceNumber(normalized, flat) {
  const candidates = [normalized, flat, squeezeText(normalized)];
  /** 라벨만 있고 값이 아래쪽(TAX INVOICE 다음)에 있는 Hoya 레이아웃 */
  const refPatterns = [
    /TAX\s+INVOICE\s+(IN[A-Z0-9][A-Z0-9_-]*)/i,
    /INVOICE\s*(?:NUMBER|NO\.?)\s*:?\s*(IN[A-Z0-9][A-Z0-9_-]*)/i,
    /INVOICE\s*(?:NUMBER|NO\.?)\s*:?\s*([A-Z]{1,6}\d[A-Z0-9_-]*)/i,
    /INVOICE\s*(?:NUMBER|NO\.?)\s*:?\s*(\d{5,12})/,
    /Invoice\s*(?:Number|No\.?)\s*:?\s*([A-Z0-9][A-Z0-9_-]{3,})/i,
    /\b(IN\d{4,})\b/i,
    /\b(INV[A-Z0-9][A-Z0-9_-]{2,})\b/i
  ];
  for (const hay of candidates) {
    for (const re of refPatterns) {
      const m = hay.match(re);
      if (m?.[1]) return m[1].trim();
    }
  }
  return null;
}

/**
 * @param {string} normalized
 * @param {string} flat
 */
function extractInvoiceDate(normalized, flat) {
  const candidates = [normalized, flat, squeezeText(normalized)];
  /** DD MMM YYYY (예: 15 Apr 2026) — 라벨 INVOICE DATE 와 값이 떨어진 Hoya */
  const datePatterns = [
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
  const soldPatterns = [
    /SOLD\s*TO\s*([\s\S]*?)(?=PRODUCT\s*DESCRIPTION|INVOICE\s*(?:NUMBER|DATE)|$)/i,
    /SHIP\s*TO\s*([\s\S]*?)(?=PRODUCT\s*DESCRIPTION|INVOICE\s*(?:NUMBER|DATE)|$)/i,
    /CUSTOMER\s*([\s\S]*?)(?=PRODUCT\s*DESCRIPTION|INVOICE\s*(?:NUMBER|DATE)|$)/i
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

  const lineItems = extractProductLineItems(normalized);

  return {
    referenceNumber,
    invoiceDate,
    soldTo,
    storeLine,
    lineItems
  };
}

/**
 * QTY 헤더 이후 표 형태: 한 줄에 수량·단가·GST·금액 4열 (PDF 텍스트가 한 줄로 나올 때)
 */
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

    const tableStart = block.search(/\bQTY\b/i);
    let numericRows = [];
    if (tableStart >= 0) {
      const tableText = block.slice(tableStart);
      numericRows = parseNumericRowsFromTableText(tableText);
    }

    if (numericRows.length > 0) {
      for (const row of numericRows) {
        items.push({
          description,
          qty: row.qty,
          price: row.price,
          gst: row.gst,
          amount: row.amount
        });
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

    items.push({
      description,
      qty: qtyMatch ? qtyMatch[1].trim() : null,
      price: priceMatch ? priceMatch[1].trim() : null,
      gst: gstMatch ? gstMatch[1].trim() : null,
      amount: amtMatch ? amtMatch[1].trim() : null
    });
  }

  return items;
}
