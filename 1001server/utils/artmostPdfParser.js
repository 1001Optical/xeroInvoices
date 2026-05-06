import { BRANCHES } from '../../constants.js';
import {
  inspectAlconPdfBuffer,
  parseAlconTaxInvoicePdf
} from './alconPdfParser.js';

function normSpace(s) {
  return String(s || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function parseMoney(s) {
  const raw = String(s || '').trim();
  const sign = /^\(.*\)$/.test(raw) && !raw.includes('-') ? -1 : 1;
  const n = parseFloat(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const MONEY_TOKEN = String.raw`\(?-?\$?\s*-?[0-9,]+\.\d{2}\)?`;

function parseDdMmYyyyToIso(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function calcDueDateInvoiceMonthEndPlus30(invoiceDateIso) {
  const m = String(invoiceDateIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const endOfMonthUtc = new Date(Date.UTC(y, mo, 0));
  endOfMonthUtc.setUTCDate(endOfMonthUtc.getUTCDate() + 30);
  return endOfMonthUtc.toISOString().slice(0, 10);
}

function matchBranchFromStoreText(storeRaw) {
  const s = String(storeRaw || '').toLowerCase();
  if (!s) return null;
  return (
    BRANCHES.find((b) => s.includes(String(b.name || '').toLowerCase())) || null
  );
}

function extractStoreLabel(flatText) {
  const m = flatText.match(/(1001\s+Optometry\s+[A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
  return m?.[1] ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function extractArtmostFieldsFromCombinedText(combinedText) {
  const text = normSpace(combinedText);
  const flat = text.replace(/\n/g, ' ');

  const invoiceNumber = flat.match(/Invoice\s*Number:\s*(\d{3,})/i)?.[1] || null;
  const invoiceDate = flat.match(/Invoice\s*Date:\s*([0-3]?\d\/[0-1]?\d\/\d{4})/i)?.[1] || null;
  const invoiceDateIso = parseDdMmYyyyToIso(invoiceDate);
  const dueDateIso = calcDueDateInvoiceMonthEndPlus30(invoiceDateIso);
  const storeRaw = extractStoreLabel(flat);
  const branch = matchBranchFromStoreText(storeRaw);

  const productLines = [];
  const productLabelRe = /GOV\s+General\s+Ortho-?K/gi;
  for (const hit of flat.matchAll(productLabelRe)) {
    const start = hit.index ?? 0;
    const lookahead = flat.slice(start, start + 1400);
    const qp = lookahead.match(new RegExp(`(\\d+)\\s*(${MONEY_TOKEN})`));
    if (!qp) continue;
    const description = String(hit[0] || '').replace(/\s+/g, ' ').trim();
    const qty = Number(qp[1]);
    const lineAmount = parseMoney(qp[2]);
    const unitAmount = qty > 0 ? lineAmount / qty : lineAmount;
    const dedupeKey = `${description}|${qty}|${lineAmount}`;
    if (productLines.some((x) => `${x.description}|${x.qty}|${x.lineAmount}` === dedupeKey)) {
      continue;
    }
    productLines.push({ description, qty, lineAmount, unitAmount, taxType: 'GST Free Expenses' });
  }

  const shippingAmount = parseMoney(
    flat.match(new RegExp(`Shipping\\s+(${MONEY_TOKEN})`, 'i'))?.[1] || 0
  );
  const patientName = flat.match(/Patient\s*Name:\s*([A-Za-z][A-Za-z\s]+\d+)/i)?.[1]?.trim() || null;
  const documentKind =
    productLines.some((p) => Number(p.lineAmount || 0) < 0) ||
    shippingAmount < 0 ||
    /\bcredit\s+note\b|\breturn\b|\brefund\b/i.test(flat)
      ? 'supplier_credit_note'
      : 'supplier_invoice';

  const xeroDraftLineItems = [
    ...productLines.map((p) => ({
      Description: p.description,
      Quantity: p.qty,
      UnitAmount: p.unitAmount,
      TaxType: 'GST Free Expenses'
    }))
  ];
  if (shippingAmount > 0) {
    xeroDraftLineItems.push({
      Description: 'Shipping',
      Quantity: 1,
      UnitAmount: shippingAmount,
      TaxType: 'GST Free Expenses'
    });
  }
  if (patientName) {
    xeroDraftLineItems.push({
      Description: `Patient Name: ${patientName}`,
      Quantity: 1,
      UnitAmount: 0,
      TaxType: 'GST Free Expenses'
    });
  }

  return {
    invoiceNumber,
    documentKind,
    referenceNumber: invoiceNumber,
    invoiceDate,
    invoiceDateIso,
    dueDateIso,
    storeRaw,
    matchedBranchCode: branch?.code || null,
    matchedBranchName: branch?.name || null,
    matchedEntity: branch?.entity || null,
    shippingAmount,
    patientName,
    productLines,
    xeroDraftLineItems
  };
}

export async function parseArtmostInvoicePdf(buffer, options = {}) {
  const parsed = await parseAlconTaxInvoicePdf(buffer, options);
  const combinedText = parsed.invoices.map((x) => x.mergedText || '').join('\n');
  const fields = extractArtmostFieldsFromCombinedText(combinedText);
  return {
    invoices: [
      {
        page: 1,
        attachmentFileName: options.attachmentFileName,
        mergedText: combinedText,
        fields
      }
    ],
    pageErrors: parsed.pageErrors
  };
}

export async function inspectArtmostPdfBuffer(buffer) {
  const base = await inspectAlconPdfBuffer(buffer);
  const combinedText = (base.pages || []).map((p) => p.mergedPreview || '').join('\n');
  const fields = extractArtmostFieldsFromCombinedText(combinedText);
  return {
    ...base,
    pages: (base.pages || []).map((p) => ({
      ...p,
      fieldsPlaceholder: fields
    }))
  };
}

