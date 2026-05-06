/**
 * 테스트 스크립트의 `list --date YYYY-MM-DD` 용: 날짜는 **Australia/Sydney 달력의 그 하루**로 해석합니다.
 * (Gmail 웹에서 보는 수신 시각과 같은 업무일 기준 — 서버 로컬 TZ 와 무관.)
 *
 * Gmail 검색의 after:/before: 는 내부적으로 UTC 경계와 맞물려 시드니 새벽 메일이 검색에서 빠지는 경우가 있어,
 * after 만 env 로 지정한 일수만큼 앞당깁니다.
 */

/** @typedef {readonly string[]} PadEnvKeys */

export const LIST_DAY_TIMEZONE = 'Australia/Sydney';

/** 스크립트별로 어떤 env 키를 볼지 (앞에서 설정된 값 우선) */
export const PAD_ENV_KEYS = {
  hoya: /** @type {PadEnvKeys} */ (['HOYA_GMAIL_LIST_AFTER_PAD_DAYS']),
  alcon: /** @type {PadEnvKeys} */ ([
    'ALCON_GMAIL_LIST_AFTER_PAD_DAYS',
    'HOYA_GMAIL_LIST_AFTER_PAD_DAYS'
  ]),
  artmost: /** @type {PadEnvKeys} */ ([
    'ARTMOST_GMAIL_LIST_AFTER_PAD_DAYS',
    'HOYA_GMAIL_LIST_AFTER_PAD_DAYS'
  ])
};

/** 그레고리력 ±delta 일 (순수 달력 연산; 타임존 오프셋과 무관) */
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

/**
 * @param {string} ymd - YYYY-MM-DD (시드니 달력의 그날)
 * @param {PadEnvKeys | string[]} [envPadKeys]
 */
export function gmailQueryDayRangeForList(ymd, envPadKeys = PAD_ENV_KEYS.hoya) {
  const [y, mo, da] = ymd.split('-').map((x) => parseInt(x, 10));
  if (!y || !mo || !da) throw new Error(`날짜 형식: YYYY-MM-DD (${ymd})`);
  const padAfter = resolveAfterPadDays(envPadKeys);
  const afterStart = calendarShiftDays(y, mo, da, -padAfter);
  const beforeExclusive = calendarShiftDays(y, mo, da, 1);
  return `after:${slashYmd(afterStart)} before:${slashYmd(beforeExclusive)}`;
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
