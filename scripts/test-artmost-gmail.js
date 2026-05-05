#!/usr/bin/env node
/**
 * Artmost 메일 — Gmail 검색·PDF inspect·파싱
 *
 *   node scripts/test-artmost-gmail.js list
 *   node scripts/test-artmost-gmail.js list --q 'from:admin@artmostgovau.com.au newer_than:7d'
 *   node scripts/test-artmost-gmail.js run <messageId>
 *   node scripts/test-artmost-gmail.js inspect <messageId> [--pdf N] [--out path.json] [--file-only]
 */
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPayableGmailClient } from '../1001server/utils/gmailPayableAuth.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload
} from '../1001server/utils/gmailHoyaPipeline.js';
import { processArtmostGmailMessage } from '../1001server/utils/gmailArtmostPipeline.js';
import { inspectArtmostPdfBuffer } from '../1001server/utils/artmostPdfParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

function usage() {
  console.log(`Usage:
  node scripts/test-artmost-gmail.js list [--date YYYY-MM-DD] [--q "gmail query"] [--max N]
  node scripts/test-artmost-gmail.js run <messageId>
  node scripts/test-artmost-gmail.js inspect <messageId> [--pdf N] [--out path.json] [--file-only]
`);
}

function gmailQueryForLocalDay(ymd) {
  const [y, mo, da] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!y || !mo || !da) throw new Error(`날짜 형식: YYYY-MM-DD (${ymd})`);
  const start = new Date(y, mo - 1, da);
  const end = new Date(y, mo - 1, da + 1);
  const fmt = (d) =>
    `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  return `after:${fmt(start)} before:${fmt(end)}`;
}

function yesterdayLocalYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseArgs(argv) {
  const out = {
    cmd: null,
    messageId: null,
    customQ: null,
    dateStr: null,
    max: 20,
    outPath: null,
    pdfIndex: undefined,
    inspectFileOnly: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'list') out.cmd = 'list';
    else if (a === 'run') {
      out.cmd = 'run';
      out.messageId = argv[++i];
    } else if (a === 'inspect') {
      out.cmd = 'inspect';
      out.messageId = argv[++i];
    } else if (a === '--q') out.customQ = argv[++i];
    else if (a === '--date') out.dateStr = argv[++i];
    else if (a === '--max') out.max = parseInt(argv[++i], 10) || 20;
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--pdf') out.pdfIndex = parseInt(argv[++i], 10);
    else if (a === '--file-only') out.inspectFileOnly = true;
  }
  return out;
}

async function listMessages(gmail, q, maxResults) {
  const cap = Math.min(Math.max(1, maxResults), 500);
  const ids = [];
  let pageToken;
  do {
    const batch = Math.min(500, cap - ids.length);
    if (batch <= 0) break;
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: batch,
      pageToken
    });
    for (const m of res.data.messages || []) {
      if (m.id) ids.push(m.id);
      if (ids.length >= cap) break;
    }
    pageToken = ids.length >= cap ? undefined : res.data.nextPageToken;
  } while (pageToken);
  const rows = [];
  for (const id of ids) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date']
    });
    const headers = full.data.payload?.headers || [];
    const get = (n) => headers.find((h) => h.name?.toLowerCase() === n)?.value || '';
    rows.push({
      id,
      subject: get('subject'),
      from: get('from'),
      date: get('date')
    });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd) {
    usage();
    process.exit(1);
  }

  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const userEmail = profile.data.emailAddress;
  if (!userEmail) {
    console.error('Gmail 프로필에 emailAddress 없음');
    process.exit(1);
  }

  if (args.cmd === 'list') {
    const day = args.dateStr || yesterdayLocalYmd();
    const q =
      args.customQ ||
      `from:admin@artmostgovau.com.au subject:"Your ArtMost GOV Contact Lenses Australia order" ${gmailQueryForLocalDay(day)}`;
    const rows = await listMessages(gmail, q, args.max);
    if (rows.length === 0) {
      console.log('검색 결과 없음. --date 나 --q 로 범위를 넓혀 보세요.');
      return;
    }
    for (const r of rows) {
      console.log(`${r.id}\t${r.subject}\t${r.date}`);
    }
    return;
  }

  if (args.cmd === 'run') {
    if (!args.messageId) {
      usage();
      process.exit(1);
    }
    const outcome = await processArtmostGmailMessage(gmail, args.messageId, userEmail);
    console.log('[Artmost] outcome:', outcome);
    process.exit(outcome === 'failed' ? 1 : 0);
  }

  if (args.cmd === 'inspect') {
    if (!args.messageId) {
      usage();
      process.exit(1);
    }
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: args.messageId,
      format: 'full'
    });
    const pdfs = collectPdfAttachmentsFromPayload(full.data.payload);
    if (pdfs.length === 0) {
      console.error('PDF 첨부 없음');
      process.exit(1);
    }
    if (
      args.pdfIndex != null &&
      (args.pdfIndex < 0 || args.pdfIndex >= pdfs.length)
    ) {
      console.error(`--pdf ${args.pdfIndex} 는 유효하지 않음 (0…${pdfs.length - 1})`);
      process.exit(1);
    }
    const indices =
      args.pdfIndex != null ? [args.pdfIndex] : pdfs.map((_, i) => i);

    const combined = {
      messageId: args.messageId,
      pdfAttachmentCount: pdfs.length,
      attachments: []
    };

    for (const idx of indices) {
      const item = pdfs[idx];
      const filename = item.filename;
      let buffer;
      if (item.buffer) {
        buffer = item.buffer;
      } else if (item.attachmentId) {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: args.messageId,
          id: item.attachmentId
        });
        const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
        buffer = Buffer.from(b64, 'base64');
      } else {
        console.error(`[PDF ${idx}] buffer·attachmentId 없음`);
        process.exit(1);
      }
      if (item.sniffPdf && !bufferLooksLikePdf(buffer)) {
        combined.attachments.push({
          index: idx,
          filename,
          byteLength: buffer.length,
          skippedNotPdf: true
        });
        continue;
      }
      const report = await inspectArtmostPdfBuffer(buffer);
      combined.attachments.push({
        index: idx,
        filename,
        byteLength: buffer.length,
        ...report
      });
    }

    const textReport = JSON.stringify(combined, null, 2);
    const defaultOut = path.join(__dirname, '..', 'data', 'artmost-inspect-last.json');
    const outTarget = args.outPath || defaultOut;
    await fs.mkdir(path.dirname(outTarget), { recursive: true });
    await fs.writeFile(outTarget, textReport, 'utf8');
    console.log('저장:', outTarget);
    if (!args.inspectFileOnly) {
      console.log(textReport);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
