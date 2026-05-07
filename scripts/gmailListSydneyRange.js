/**
 * 테스트 스크립트 `list --date YYYY-MM-DD`:
 * 날짜는 **Australia/Sydney 달력의 하루**로 해석합니다.
 *
 * Gmail `after:/before:` 는 **날짜만** 받아서 하루 전체(UTC 자정 기준) 단위로만 잘립니다.
 * 그래서 “시드니 6일 하루”를 정확히 맞추려면:
 * 1) 시드니 자정 → UTC epoch (`internalDate` 와 같은 축)으로 구간 [startMs, endMs) 계산
 * 2) Gmail 검색으로 후보만 좁힌 다음
 * 3) `messages.get` 의 **internalDate** 로 위 구간에 속하는 메일만 남깁니다.
 */

/** @typedef {readonly string[]} PadEnvKeys */

export const LIST_DAY_TIMEZONE = 'Australia/Sydney';

/** 스크립트별 패딩 env (레거시 — 현재 list 기본은 internalDate 필터 사용) */
export const PAD_ENV_KEYS = {
  hoya: /** @type {PadEnvKeys} */ (['HOYA_GMAIL_LIST_AFTER_PAD_DAYS']),
  bausch: /** @type {PadEnvKeys} */ ([
    'BAUSCH_GMAIL_LIST_AFTER_PAD_DAYS',
    'HOYA_GMAIL_LIST_AFTER_PAD_DAYS'
  ]),
  alcon: /** @type {PadEnvKeys} */ ([
    'ALCON_GMAIL_LIST_AFTER_PAD_DAYS',
    'HOYA_GMAIL_LIST_AFTER_PAD_DAYS'
  ]),
  artmost: /** @type {PadEnvKeys} */ ([
    'ARTMOST_GMAIL_LIST_AFTER_PAD_DAYS',
    'HOYA_GMAIL_LIST_AFTER_PAD_DAYS'
  ])
};

/** 그레고리력 ±delta 일 (순수 달력 연산) */
function calendarShiftDays(y, m, d, deltaDays) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate()
  };
}

function getZonedParts(ms, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms));
  const pick = (t) => parseInt(p.find((x) => x.type === t)?.value || '0', 10);
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second')
  };
}

/**
 * Sydney 달력 y/m/d 00:00:00 에 해당하는 첫 UTC instant (epoch ms).
 * 이진 탐색으로 “그 날짜가 시작되는 순간”을 찾습니다.
 */
export function utcMillisAtStartOfSydneyDay(y, mo, d) {
  let lo = Date.UTC(y, mo - 1, d - 2);
  let hi = Date.UTC(y, mo - 1, d + 2);
  const targetKey = y * 10000 + mo * 100 + d;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const z = getZonedParts(mid, LIST_DAY_TIMEZONE);
    const zKey = z.year * 10000 + z.month * 100 + z.day;
    if (zKey < targetKey) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * @param {string} ymd YYYY-MM-DD (Sydney 달력)
 * @returns {{ startMs: number, endMs: number }}
 *   Gmail internalDate 는 [startMs, endMs) 구간에 있으면 시드니 그날 수신으로 본다.
 */
export function getSydneyCalendarDayUtcRangeMs(ymd) {
  const [y, mo, d] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!y || !mo || !d) throw new Error(`날짜 형식: YYYY-MM-DD (${ymd})`);
  const startMs = utcMillisAtStartOfSydneyDay(y, mo, d);
  const next = calendarShiftDays(y, mo, d, 1);
  const endMs = utcMillisAtStartOfSydneyDay(next.y, next.mo, next.d);
  return { startMs, endMs };
}

function utcSlashYmdFromMs(ms) {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${String(x.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Gmail q 용 느슨한 after/before (UTC 날짜). 경계 메일 누락 방지로 ±1 UTC 일 여유.
 * 최종 범위는 반드시 internalDate 필터로 맞춤.
 */
export function gmailRoughUtcWindowQueryFromSydneyDay(ymd) {
  const { startMs, endMs } = getSydneyCalendarDayUtcRangeMs(ymd);
  const DAY = 86400000;
  return `after:${utcSlashYmdFromMs(startMs - DAY)} before:${utcSlashYmdFromMs(endMs + DAY)}`;
}

/**
 * @deprecated 레거시 패딩 방식. 새 로직은 getSydneyCalendarDayUtcRangeMs + internalDate.
 * @param {PadEnvKeys | string[]} [envPadKeys]
 */
export function gmailQueryDayRangeForList(ymd, envPadKeys = PAD_ENV_KEYS.hoya) {
  void envPadKeys;
  return gmailRoughUtcWindowQueryFromSydneyDay(ymd);
}

/**
 * @param {PadEnvKeys | string[]} envKeys
 * @returns {number} 0…5
 */
export function resolveAfterPadDays(envKeys) {
  let raw = '1';
  for (const k of envKeys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== '') {
      raw = String(v).trim();
      break;
    }
  }
  const n = Number(raw);
  if (Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(5, n));
}

/** 시드니 기준 "어제" YYYY-MM-DD (--date 생략 시) */
export function yesterdayYmdInSydney() {
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

/**
 * 시드니 달력 하루에 해당하는 메일만 반환 (internalDate 기준).
 * @param {*} gmail google.gmail v1
 * @param {{ baseQuery: string, ymd: string, maxResults: number }} opts
 */
export async function listMessagesForSydneyCalendarDay(gmail, opts) {
  const { baseQuery, ymd, maxResults } = opts;
  const { startMs, endMs } = getSydneyCalendarDayUtcRangeMs(ymd);
  const q = `${baseQuery} ${gmailRoughUtcWindowQueryFromSydneyDay(ymd)}`.trim();

  const cap = Math.min(Math.max(1, maxResults), 500);
  const rows = [];
  let pageToken;
  const MAX_LIST_PAGES = 50;

  for (let page = 0; page < MAX_LIST_PAGES && rows.length < cap; page++) {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(100, Math.max(50, cap * 3)),
      pageToken
    });
    const messages = res.data.messages || [];
    pageToken = res.data.nextPageToken || undefined;

    for (const m of messages) {
      if (!m?.id || rows.length >= cap) break;
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const internalDate = parseInt(String(full.data.internalDate ?? ''), 10);
      if (!Number.isFinite(internalDate) || internalDate < startMs || internalDate >= endMs) {
        continue;
      }
      const headers = full.data.payload?.headers || [];
      const get = (n) => headers.find((h) => h.name?.toLowerCase() === n)?.value || '';
      rows.push({
        id: m.id,
        subject: get('subject'),
        from: get('from'),
        date: get('date'),
        internalDate
      });
    }

    if (!pageToken) break;
  }

  return { rows, q, startMs, endMs };
}
