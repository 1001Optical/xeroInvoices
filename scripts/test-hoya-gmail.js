#!/usr/bin/env node
/**
 * Hoya Daily Combined 메일을 Gmail API로 찾아서 파이프라인(파싱 + Xero) 실행
 *
 * 목록 (기본: 어제 하루, 로컬 날짜 기준):
 *   node scripts/test-hoya-gmail.js list
 *   node scripts/test-hoya-gmail.js list --q 'from:axd365au@hoya.com newer_than:2d'
 *   node scripts/test-hoya-gmail.js list --date 2026-04-14
 *
 * 특정 messageId 처리 (Gmail 웹 → 메일 열기 → URL의 /.../메시지ID):
 *   node scripts/test-hoya-gmail.js run <messageId> [--force] [--mysql]
 *   Xero (권장): 미들웨어가 refresh 보유 시
 *     BACKEND_URL + BACKEND_API_TOKEN (또는 XERO_INTERNAL_TOKEN_BASE_URL + XERO_INTERNAL_API_KEY)
 *     → 스크립트 .env 에 XERO_RT_* 없어도 됨 (미들웨어/서버 쪽에 RT 또는 MySQL)
 *   그 외: --mysql (DB) 또는 로컬 .env XERO_RT_* + initXeroTokenServiceEnvOnly
 *
 * --force: 이미 처리된 인보이스(ref|date)여도 다시 Xero까지 시도 (같은 Reference면 Bill은 재생성 안 됨)
 *
 * PDF에서 실제로 어떤 텍스트가 추출되는지 (인보이스 번호/날짜 못 찾을 때):
 *   node scripts/test-hoya-gmail.js inspect <messageId> [--pdf N] [--out path.json]
 *   → 첨부 PDF가 여러 개면 **전부** 덤프 (특정 것만: --pdf 0 첫 번째)
 */
import dotenv from 'dotenv';
import fs from 'fs/promises';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPayableGmailClient } from '../1001server/utils/gmailPayableAuth.js';
import { processHoyaGmailMessage } from '../1001server/utils/gmailHoyaPipeline.js';
import { inspectHoyaPdfBuffer } from '../1001server/utils/hoyaPdfParser.js';
import { initXeroTokenService, initXeroTokenServiceEnvOnly } from '../1001server/utils/xero.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

/** `run` + MySQL 쓸 때만 (선택). 기본은 DB 없이 .env refresh token 만 사용 */
function createMysqlPool() {
  return mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3307', 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

function usage() {
  console.log(`Usage:
  node scripts/test-hoya-gmail.js list [--date YYYY-MM-DD] [--q "gmail query"] [--max N]
  node scripts/test-hoya-gmail.js run <messageId> [--force] [--mysql]
  node scripts/test-hoya-gmail.js inspect <messageId> [--pdf N] [--out path.json]
`);
}

/** 로컬 달력 기준 "어제"의 Gmail after/before 구간 (하루) */
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
    force: false,
    customQ: null,
    dateStr: null,
    max: 20,
    outPath: null,
    /** @type {number|undefined} inspect 시 0부터, 생략 시 모든 PDF */
    pdfIndex: undefined,
    /** run 시 MySQL + xero_tokens 사용 (기본 false) */
    useMysql: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'list') out.cmd = 'list';
    else if (a === 'run') {
      out.cmd = 'run';
      out.messageId = argv[++i];
    } else if (a === '--mysql') out.useMysql = true;
    else if (a === 'inspect') {
      out.cmd = 'inspect';
      out.messageId = argv[++i];
    } else if (a === '--force') out.force = true;
    else if (a === '--q') out.customQ = argv[++i];
    else if (a === '--date') out.dateStr = argv[++i];
    else if (a === '--max') out.max = parseInt(argv[++i], 10) || 20;
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--pdf') out.pdfIndex = parseInt(argv[++i], 10);
  }
  return out;
}

function collectPdfAttachments(part, acc) {
  if (!part) return;
  const mime = part.mimeType || '';
  const filename = part.filename || '';
  if ((mime === 'application/pdf' || /\.pdf$/i.test(filename)) && part.body?.attachmentId) {
    acc.push({ attachmentId: part.body.attachmentId, filename: filename || 'attachment.pdf' });
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectPdfAttachments(p, acc);
  }
}

async function listMessages(gmail, q, maxResults) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults
  });
  const ids = (res.data.messages || []).map((m) => m.id).filter(Boolean);
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
  console.log('Mailbox:', userEmail);

  if (args.cmd === 'list') {
    const day = args.dateStr || yesterdayLocalYmd();
    const base = 'from:axd365au@hoya.com subject:"Daily Combined Invoice"';
    const q = args.customQ || `${base} ${gmailQueryForLocalDay(day)}`;
    console.log('Query:', q);
    const rows = await listMessages(gmail, q, args.max);
    if (rows.length === 0) {
      console.log('검색 결과 없음. --date 나 --q 로 범위를 넓혀 보세요.');
      return;
    }
    console.log('\nID\tSubject\tDate');
    for (const r of rows) {
      console.log(`${r.id}\t${r.subject}\t${r.date}`);
    }
    console.log(
      `\n실행 예: node scripts/test-hoya-gmail.js run ${rows[0].id}`
    );
    return;
  }

  if (args.cmd === 'run') {
    if (!args.messageId) {
      usage();
      process.exit(1);
    }
    let baseUrl = (
      process.env.XERO_INTERNAL_TOKEN_BASE_URL ||
      process.env.SERVER_BASE_URL ||
      process.env.BACKEND_URL ||
      ''
    ).trim();
    const internalKey = (
      process.env.XERO_INTERNAL_API_KEY ||
      process.env.BACKEND_API_TOKEN ||
      ''
    ).trim();
    /** 키만 있고 URL이 없으면 같은 .env 의 PORT(기본 8080)로 로컬 서버 추정 — xero.js 도 동일 env 를 읽음 */
    if (internalKey && !baseUrl && !args.useMysql) {
      const p = Number(process.env.PORT || 8080);
      baseUrl = `http://127.0.0.1:${p}`;
      process.env.XERO_INTERNAL_TOKEN_BASE_URL = baseUrl;
      console.log(
        '[Hoya test] Xero: 베이스 URL 생략 →',
        baseUrl,
        '(PORT 기준, npm run start 로컬 서버; 원격이면 BACKEND_URL 설정)'
      );
    }
    const useInternalHttp = !!(baseUrl && internalKey && !args.useMysql);

    let pool = null;
    try {
      if (useInternalHttp) {
        console.log(
          '[Hoya test] Xero: 1001server 내부 API',
          baseUrl.replace(/\/$/, ''),
          '(refresh 는 서버만 보유, 스크립트는 GET /api/internal/xero/access-token 만 호출 — 서버 콘솔에 [xero internal] 로그가 찍혀야 함)'
        );
      } else if (args.useMysql) {
        pool = createMysqlPool();
        initXeroTokenService(pool);
        console.log('[Hoya test] Xero: MySQL xero_tokens 사용 (--mysql)');
      } else {
        initXeroTokenServiceEnvOnly();
        console.log(
          '[Hoya test] Xero: 미들웨어 미사용 — XERO_INTERNAL_API_KEY / BACKEND_API_TOKEN 없음.',
          '\n  → XERO_RT_OPTICAL 직접 갱신 모드. 원격이면 BACKEND_URL + BACKEND_API_TOKEN 설정.'
        );
      }
    } catch (e) {
      console.error(
        'Xero 초기화 실패:',
        e instanceof Error ? e.message : e
      );
      process.exit(1);
    }
    try {
      const ok = await processHoyaGmailMessage(
        gmail,
        args.messageId,
        userEmail,
        {
          skipInvoiceDedupe: args.force,
          skipPersistInvoiceKeys: args.force
        }
      );
      process.exit(ok ? 0 : 1);
    } finally {
      if (pool) await pool.end();
    }
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
    const pdfs = [];
    collectPdfAttachments(full.data.payload, pdfs);
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
      args.pdfIndex != null
        ? [args.pdfIndex]
        : pdfs.map((_, i) => i);
    console.log(
      'PDF 첨부',
      pdfs.length,
      '개 — inspect:',
      indices.length === 1 ? `인덱스 ${indices[0]} 만` : '전부'
    );

    const combined = {
      messageId: args.messageId,
      pdfAttachmentCount: pdfs.length,
      attachments: []
    };
    for (const idx of indices) {
      const { attachmentId, filename } = pdfs[idx];
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: args.messageId,
        id: attachmentId
      });
      const b64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
      const buffer = Buffer.from(b64, 'base64');
      console.log(`\n[PDF ${idx}]`, filename, 'bytes:', buffer.length);
      const report = await inspectHoyaPdfBuffer(buffer);
      combined.attachments.push({
        index: idx,
        filename,
        byteLength: buffer.length,
        ...report
      });
      for (const p of report.pages) {
        console.log(
          `  page ${p.page} items=${p.textItemCount} ref=${p.parsed?.referenceNumber ?? '—'} date=${p.parsed?.invoiceDate ?? '—'}`
        );
      }
    }
    const textReport = JSON.stringify(combined, null, 2);
    console.log('\n--- 전체 JSON (요약 위에 출력됨) ---');
    const defaultOut = path.join(__dirname, '..', 'data', 'hoya-inspect-last.json');
    const outTarget = args.outPath || defaultOut;
    await fs.mkdir(path.dirname(outTarget), { recursive: true });
    await fs.writeFile(outTarget, textReport, 'utf8');
    console.log('저장:', outTarget);
    return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
