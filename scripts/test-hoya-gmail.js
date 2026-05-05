#!/usr/bin/env node
/**
 * Hoya Daily Combined 메일을 Gmail API로 찾아서 파이프라인(파싱 + Xero) 실행
 *
 * 목록 (기본 "어제": Australia/Sydney 달력; Gmail after:/before: 와 시차 보정용 HOYA_GMAIL_LIST_AFTER_PAD_DAYS 기본 1):
 *   node scripts/test-hoya-gmail.js list
 *   node scripts/test-hoya-gmail.js list --q 'from:axd365au@hoya.com newer_than:2d'
 *   node scripts/test-hoya-gmail.js list --date 2026-04-14
 *   (같은 날 메일이 여러 통인데 ID가 하나만 나올 때: 제목이 조금 다르면 기본 검색에서 빠짐 → 아래 --loose)
 *   node scripts/test-hoya-gmail.js list --date 2026-04-16 --loose
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
 *   node scripts/test-hoya-gmail.js inspect <messageId> [--pdf N] [--out path.json] [--file-only]
 *   (기본: 전체 JSON 을 터미널에도 출력. 길면 --file-only 로 파일만 저장)
 *   → 첨부 PDF가 여러 개면 **전부** 덤프 (특정 것만: --pdf 0 첫 번째)
 *
 * Gmail API가 첨부를 몇 개로 노출하는지 (웹에서 PDF 두 개인데 API는 1개일 때):
 *   node scripts/test-hoya-gmail.js payload <messageId>
 */
import dotenv from 'dotenv';
import fs from 'fs/promises';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPayableGmailClient } from '../1001server/utils/gmailPayableAuth.js';
import {
  bufferLooksLikePdf,
  collectPdfAttachmentsFromPayload,
  processHoyaGmailMessage
} from '../1001server/utils/gmailHoyaPipeline.js';
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
  node scripts/test-hoya-gmail.js list [--date YYYY-MM-DD] [--loose] [--q "gmail query"] [--max N]
    (after 날짜 하루 앞당김 기본 — 시드니 새벽 수신이 Gmail 검색에서 전날로 잡히는 경우 보정)
  node scripts/test-hoya-gmail.js run <messageId> [--force] [--mysql]
  node scripts/test-hoya-gmail.js inspect <messageId> [--pdf N] [--out path.json] [--file-only]
  node scripts/test-hoya-gmail.js payload <messageId>
`);
}

/**
 * Gmail messages.get — format=full 페이로드 트리 + format=raw MIME 힌트
 * (웹 UI 첨부 개수와 API 불일치 원인 확인용)
 */
function walkPayloadParts(part, depth, lines) {
  if (!part) return;
  const pad = '  '.repeat(depth);
  const attId = part.body?.attachmentId || '';
  const dataLen = part.body?.data ? String(part.body.data).length : 0;
  const mime = part.mimeType || '(no mimeType)';
  const fn = part.filename || '';
  lines.push(
    `${pad}- ${mime}${fn ? ` ; filename=${JSON.stringify(fn)}` : ''}${attId ? ` ; attachmentId=${attId.slice(0, 12)}…` : ''}${dataLen ? ` ; body.data b64 길이≈${dataLen}` : ''}`
  );
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      walkPayloadParts(p, depth + 1, lines);
    }
  }
}

function countAttachmentIdsInPayload(part) {
  let n = 0;
  if (!part) return 0;
  if (part.body?.attachmentId) n += 1;
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) n += countAttachmentIdsInPayload(p);
  }
  return n;
}

async function dumpGmailMessagePayload(gmail, messageId) {
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });
  const lines = [];
  lines.push('=== format=full payload 트리 (Gmail API) ===');
  walkPayloadParts(full.data.payload, 0, lines);
  console.log(lines.join('\n'));
  const nAtt = countAttachmentIdsInPayload(full.data.payload);
  console.log(`\n→ 이 트리 안의 body.attachmentId 개수: ${nAtt}`);

  const rawRes = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'raw'
  });
  const rawB64 = rawRes.data.raw;
  if (!rawB64) {
    console.log('\n(raw 형식 없음)');
    return;
  }
  const buf = Buffer.from(
    String(rawB64).replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
  const rawLatin = buf.toString('latin1');
  /** multipart 안 파트 헤더까지 포함하려면 전체 문자열에서 집계(본문 바이너리에 가끔 ASCII 가 겹칠 수 있으나 희귀) */
  const cdAttachment = (rawLatin.match(/Content-Disposition:\s*attachment/gi) || [])
    .length;
  const ctPdf = (rawLatin.match(/Content-Type:\s*application\/pdf/gi) || [])
    .length;
  const fnPdfQuoted = (rawLatin.match(/filename="[^"]+\.pdf"/gi) || []).length;
  const fnPdfStar = (rawLatin.match(/filename\*=UTF-8''[^;\s]+\.pdf/gi) || [])
    .length;
  const nameParamPdf = (rawLatin.match(
    /(?:^|\r?\n)[^\n]*\bname=(?:"|'|)[^"'\r\n;]+\.pdf/gi
  ) || []).length;
  const headerLineMentionsPdf = (
    rawLatin.match(
      /(?:Content-(?:Type|Disposition)|^[\t ]*(?:filename|name)=)[^\n]*\.pdf/gim
    ) || []
  ).length;

  console.log('\n=== format=raw RFC822 휴리스틱 (multipart 파트 헤더 포함, 본문 일부와 겹칠 수 있음) ===');
  console.log(`전체 raw 바이트: ${buf.length}`);
  console.log(`Content-Disposition: attachment 줄 수(대략): ${cdAttachment}`);
  console.log(`Content-Type: application/pdf 줄 수(대략): ${ctPdf}`);
  console.log(`filename="….pdf" (quoted) 개수(대략): ${fnPdfQuoted}`);
  console.log(`filename*=UTF-8''….pdf 개수(대략): ${fnPdfStar}`);
  console.log(`name=…\\.pdf 형태 줄(대략, octet-stream 에 흔함): ${nameParamPdf}`);
  console.log(`헤더 줄 중 .pdf 가 들어간 첨부 관련 줄(대략): ${headerLineMentionsPdf}`);
  console.log(
    '\n해석: 첨부가 application/octet-stream; name="….pdf" 로만 오면 application/pdf·filename="…" 줄 수는 0일 수 있음(정상).'
  );
  console.log(
    '※ 웹에서 PDF가 두 개인데 attachment·첨부 후보가 1이면, 두 번째는 MIME 첨부가 아니라 미리보기·ZIP·다른 메일일 수 있음.'
  );
}

/** list 검색 기준 타임존 — 웹에서 보는 호주 업무일과 맞추기 */
const LIST_DAY_TIMEZONE = 'Australia/Sydney';

/** 그레고리력 ±delta 일 (서버 TZ 무관) */
function calendarShiftDays(y, m, d, deltaDays) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate()
  };
}

function slashYmd(parts) {
  const { y, mo, d } = parts;
  return `${y}/${String(mo).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/**
 * --date YYYY-MM-DD 를 "그날 받은 메일"로 검색할 때 Gmail 의 after:/before: 해석(계정·UTC) 때문에
 * 시드니 새벽 메일이 하루 밀려 나오는 경우가 있어 after 만 HOYA_GMAIL_LIST_AFTER_PAD_DAYS 만큼 앞당김 (기본 1일).
 */
function gmailQueryDayRangeForList(ymd) {
  const [y, mo, da] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!y || !mo || !da) throw new Error(`날짜 형식: YYYY-MM-DD (${ymd})`);
  const padAfter = Math.max(
    0,
    Math.min(5, Number(process.env.HOYA_GMAIL_LIST_AFTER_PAD_DAYS ?? 1))
  );
  const afterStart = calendarShiftDays(y, mo, da, -padAfter);
  const beforeExclusive = calendarShiftDays(y, mo, da, 1);
  return `after:${slashYmd(afterStart)} before:${slashYmd(beforeExclusive)}`;
}

function yesterdayYmdInListTimezone() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LIST_DAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const g = (t) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  const prev = calendarShiftDays(g('year'), g('month'), g('day'), -1);
  return `${prev.y}-${String(prev.mo).padStart(2, '0')}-${String(prev.d).padStart(2, '0')}`;
}

/** 내부 토큰 URL이 이 PC가 아닌 호스트를 가리키는지 (원격이면 그 서버의 env 가 따로 필요함) */
function tokenBaseIsRemoteHost(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!s) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const h = (u.hostname || '').toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    return true;
  } catch {
    return true;
  }
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
    useMysql: false,
    /** list: subject:"Daily Combined Invoice" 조건 생략 (같은 날 Hoya 메일 전부 볼 때) */
    looseList: false,
    /** inspect: JSON 을 터미널에 출력하지 않고 파일만 저장 */
    inspectFileOnly: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'list') out.cmd = 'list';
    else if (a === 'run') {
      out.cmd = 'run';
      out.messageId = argv[++i];
    } else if (a === '--mysql') out.useMysql = true;
    else if (a === '--loose') out.looseList = true;
    else if (a === 'inspect') {
      out.cmd = 'inspect';
      out.messageId = argv[++i];
    } else if (a === 'payload') {
      out.cmd = 'payload';
      out.messageId = argv[++i];
    } else if (a === '--force') out.force = true;
    else if (a === '--q') out.customQ = argv[++i];
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
  console.log('Mailbox:', userEmail);

  if (args.cmd === 'list') {
    const day = args.dateStr || yesterdayYmdInListTimezone();
    const base = args.looseList
      ? 'from:axd365au@hoya.com'
      : 'from:axd365au@hoya.com subject:"Daily Combined Invoice"';
    const range = gmailQueryDayRangeForList(day);
    const q = args.customQ || `${base} ${range}`;
    console.log(`Query (${LIST_DAY_TIMEZONE} 기준 날짜=${day}, after 패딩=${process.env.HOYA_GMAIL_LIST_AFTER_PAD_DAYS ?? 1}일):`, q);
    if (args.looseList && !args.customQ) {
      console.log(
        '(제목 필터 없음 — Daily Combined 가 아닌 제목의 Hoya 메일도 포함. 파이프라인 run 은 제목·발신 검사 있음.)'
      );
    }
    const rows = await listMessages(gmail, q, args.max);
    if (rows.length === 0) {
      console.log(
        '검색 결과 없음. Gmail 의 after:/before: 가 계정 시간대·UTC 와 어긋나면 시드니 새벽 메일이 빠질 수 있음.'
      );
      console.log(
        '시도: HOYA_GMAIL_LIST_AFTER_PAD_DAYS=2 node scripts/test-hoya-gmail.js list --date',
        day,
        '| 또는 --date 하루 전후 | 또는 --loose / --q \'from:axd365au@hoya.com newer_than:7d\''
      );
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
        if (tokenBaseIsRemoteHost(baseUrl)) {
          console.warn(
            '[Hoya test] 베이스 URL 이 localhost 가 아닙니다. 토큰 요청은 **그 원격 서버**에서 처리되며, 그쪽 배포 환경에도 XERO_INTERNAL_API_KEY(또는 동일 정책)가 있어야 합니다. 이 Mac 의 .env 는 "요청을 보내는 쪽"만 설정합니다.'
          );
        }
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

  if (args.cmd === 'payload') {
    if (!args.messageId) {
      usage();
      process.exit(1);
    }
    await dumpGmailMessagePayload(gmail, args.messageId);
    return;
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
      args.pdfIndex != null
        ? [args.pdfIndex]
        : pdfs.map((_, i) => i);
    const sniffN = pdfs.filter((p) => p.sniffPdf).length;
    console.log(
      'PDF·첨부 후보',
      pdfs.length,
      '개',
      sniffN > 0 ? `(그중 MIME 불명·시그니처 확인 ${sniffN}개)` : '',
      '— inspect:',
      indices.length === 1 ? `인덱스 ${indices[0]} 만` : '전부'
    );

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
        console.log(
          `\n[PDF ${idx}] 스킵 (PDF 시그니처 아님):`,
          filename,
          'bytes:',
          buffer.length
        );
        combined.attachments.push({
          index: idx,
          filename,
          byteLength: buffer.length,
          skippedNotPdf: true
        });
        continue;
      }
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
    const defaultOut = path.join(__dirname, '..', 'data', 'hoya-inspect-last.json');
    const outTarget = args.outPath || defaultOut;
    await fs.mkdir(path.dirname(outTarget), { recursive: true });
    await fs.writeFile(outTarget, textReport, 'utf8');
    console.log('저장:', outTarget);
    if (!args.inspectFileOnly) {
      console.log('\n--- 전체 JSON (stdout) ---\n');
      console.log(textReport);
    } else {
      console.log('(--file-only: JSON 는 위 경로 파일만 참고)');
    }
    return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
