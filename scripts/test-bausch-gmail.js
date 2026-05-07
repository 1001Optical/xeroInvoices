#!/usr/bin/env node
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPayableGmailClient } from '../1001server/utils/gmailPayableAuth.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload
} from '../1001server/utils/gmailHoyaPipeline.js';
import { processBauschGmailMessage } from '../1001server/utils/gmailBauschPipeline.js';
import { inspectBauschPdfBuffer } from '../1001server/utils/bauschPdfParser.js';
import { initXeroTokenServiceEnvOnly } from '../1001server/utils/xero.js';
import {
  LIST_DAY_TIMEZONE,
  listMessagesForSydneyCalendarDay,
  yesterdayYmdInSydney
} from './gmailListSydneyRange.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

function parseArgs(argv) {
  const out = {
    cmd: null,
    messageId: null,
    customQ: null,
    dateStr: null,
    max: 20,
    outPath: null,
    pdfIndex: undefined
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
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: batch, pageToken });
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
    rows.push({ id, subject: get('subject'), from: get('from'), date: get('date') });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let gmail;
  try {
    gmail = createPayableGmailClient();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const userEmail = profile.data.emailAddress;
  console.log('Mailbox:', userEmail);

  if (args.cmd === 'list') {
    const day = args.dateStr || yesterdayYmdInSydney();
    /** gmailBauschPipeline 발신자와 동일 (자동 알림 + Phua 등) */
    const base =
      '(from:sap_generated_no_reply@bausch.com OR from:PengLee.Phua@bausch.com) subject:"B&L Invoice"';
    let rows;
    if (args.customQ) {
      rows = await listMessages(gmail, args.customQ, args.max);
      console.log('Query (--q):', args.customQ);
    } else {
      const result = await listMessagesForSydneyCalendarDay(gmail, {
        baseQuery: base,
        ymd: day,
        maxResults: args.max
      });
      rows = result.rows;
      console.log(
        `${LIST_DAY_TIMEZONE} 달력 ${day} → Gmail internalDate 구간 [${new Date(result.startMs).toISOString()}, ${new Date(result.endMs).toISOString()})`
      );
      console.log('Gmail 검색 q (후보):', result.q);
    }
    console.log('\nID\tSubject\tDate');
    for (const r of rows) console.log(`${r.id}\t${r.subject}\t${r.date}`);
    return;
  }

  if (args.cmd === 'run') {
    initXeroTokenServiceEnvOnly();
    const outcome = await processBauschGmailMessage(gmail, args.messageId, userEmail);
    console.log('[Bausch] outcome:', outcome);
    process.exit(outcome === 'failed' ? 1 : 0);
  }

  if (args.cmd === 'inspect') {
    const full = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
    const pdfs = collectPdfAttachmentsFromPayload(full.data.payload);
    const indices = args.pdfIndex != null ? [args.pdfIndex] : pdfs.map((_, i) => i);
    const out = { messageId: args.messageId, pdfAttachmentCount: pdfs.length, attachments: [] };
    for (const idx of indices) {
      const item = pdfs[idx];
      let buffer;
      if (item.buffer) buffer = item.buffer;
      else {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: args.messageId,
          id: item.attachmentId
        });
        const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
        buffer = Buffer.from(b64, 'base64');
      }
      if (!bufferLooksLikePdf(buffer)) continue;
      const inspected = await inspectBauschPdfBuffer(buffer);
      out.attachments.push({ index: idx, filename: item.filename, bytes: buffer.length, inspected });
    }
    const json = JSON.stringify(out, null, 2);
    if (args.outPath) await fs.writeFile(path.resolve(args.outPath), json, 'utf8');
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
