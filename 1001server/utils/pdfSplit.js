import { PDFDocument } from 'pdf-lib';

/**
 * Combined PDF → 페이지별 단일 PDF Buffer 배열 (인덱스 0 = 1페이지)
 * @param {Buffer} buffer
 * @returns {Promise<Buffer[]>}
 */
export async function splitPdfToSinglePageBuffers(buffer) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const n = src.getPageCount();
  const buffers = [];

  for (let i = 0; i < n; i++) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page);
    const bytes = await doc.save();
    buffers.push(Buffer.from(bytes));
  }

  return buffers;
}
