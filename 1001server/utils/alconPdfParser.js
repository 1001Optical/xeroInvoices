/**
 * Alcon TAX INVOICE PDF — 텍스트 추출 + (추후) 필드 매핑용 뼈대.
 * 레이아웃 확정 전까지는 페이지별 raw / reading-order / space-join 문자열만 반환합니다.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';

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
 * 매핑 전 단계: 정규식/필드 추출은 비워 두고, 나중에 parseAlconInvoicePageText 등으로 채움.
 * @param {string} normalized
 * @returns {Record<string, unknown>}
 */
export function extractAlconInvoiceFieldsPlaceholder(normalized) {
  void normalized;
  return {
    invoiceNumber: null,
    invoiceDate: null,
    abn: null,
    billTo: null,
    shipTo: null,
    currency: null,
    subtotal: null,
    gst: null,
    total: null,
    lineItems: []
  };
}

/**
 * 디버그: PDF 버퍼 → 페이지별 텍스트·플레이스홀더 필드
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
 * Alcon 메일 첨부 PDF 1개 파싱 (1페이지=1건 또는 여러 페이지=1건 — PDF 실물 보고 조정)
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
