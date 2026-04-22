/**
 * Hoya 인보이스 1건(ACCPAY Bill) = PDF 1페이지 → Xero Bill 생성/조회 후 해당 페이지 PDF 첨부
 * SOLD TO의 스토어 → constants BRANCHES 매칭으로 법인(entity) 선택, 라인·세금·Store 트래킹 반영
 *
 * Xero API: ACCPAY(Bill) 에서 UI 의 「Reference」는 Reference 필드가 아니라 InvoiceNumber(공급자 인보이스 번호)에 넣어야 함.
 * Reference JSON 필드는 ACCREC 전용이라 Bill 에 넣어도 무시·빈 값으로 보임.
 * @see https://developer.xero.com/documentation/api/accounting/invoices
 * @see https://developer.xero.com/documentation/api/accounting/attachments#invoices
 *
 * 첨부 PUT 디버그:
 *   HOYA_XERO_DEBUG_ATTACH_PUT=1 → PUT 직전 비교용 한 줄 (tenantId, invoiceId, tokenFpSha256_12)
 *   HOYA_XERO_DEBUG_ATTACH_PUT_VERBOSE=1 → 위 + 상세 JSON
 *   HOYA_XERO_DEBUG_ORG=1 → 같은 토큰·테넌트로 GET Organisation 스냅샷 (권한/조직 비교용)
 *   HOYA_XERO_FIND_INVOICE_RETRIES=5 (기본) → find ACCPAY/크레딧 시 429·503 재시도 횟수
 */
import axios from 'axios';
import { createHash } from 'crypto';
import {
  ENTITY_CONFIG,
  getAccessToken,
  getTenantIdForEntity,
  DEFAULT_ENTITY
} from './xero.js';
import { matchBranchFromHoyaPdf } from './hoyaBranchMatch.js';

const API = 'https://api.xero.com/api.xro/2.0';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_INVOICE = 10;

let loggedAttachment401Hint = false;
let loggedTrackingCategoryNameMissingHint = false;
let loggedTrackingOptionMissingHint = false;

/** Optical vs Indooroopilly PUT 비교용 — tenantId · invoiceId · 토큰 지문 한 줄 */
function hoyaXeroDebugAttachPutEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.HOYA_XERO_DEBUG_ATTACH_PUT || '').trim());
}

function hoyaXeroDebugAttachPutVerboseEnabled() {
  return /^(1|true|yes)$/i.test(
    String(process.env.HOYA_XERO_DEBUG_ATTACH_PUT_VERBOSE || '').trim()
  );
}

/** GET Organisation — 테넌트별 조직 스냅샷 비교 */
function hoyaXeroDebugOrgEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.HOYA_XERO_DEBUG_ORG || '').trim());
}

function xeroAccessTokenFingerprint(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') {
    return { prefix: '', suffix: '', sha256_12: '(empty)' };
  }
  const sha256_12 = createHash('sha256').update(accessToken, 'utf8').digest('hex').slice(0, 12);
  return {
    prefix: accessToken.slice(0, 24),
    suffix: accessToken.slice(-16),
    sha256_12
  };
}

/** 401 시 어떤 URL에서 터졌는지 로그 (스코프·엔드포인트 추적용) */
const hoyaXeroHttp = axios.create();
hoyaXeroHttp.interceptors.response.use(
  (r) => r,
  (err) => {
    const st = err.response?.status;
    const u = err.config?.url;
    const d = err.response?.data?.Detail || err.response?.data?.Title;
    if (st === 401 && u) {
      const isAtt = /\/Attachments\//i.test(String(u));
      if (isAtt) {
        console.error('[Hoya Xero] 401 (첨부)', d || 'AuthorizationUnsuccessful');
        if (!loggedAttachment401Hint) {
          loggedAttachment401Hint = true;
          console.error(
            '[Hoya Xero] (한 번만) 첨부는 accounting.attachments 스코프 필요. 포털에 스코프 추가 → Xero 재승인 → **미들웨어/DB refresh 를 새 토큰으로 교체**. 그 전까지 같은 401이 반복됩니다.'
          );
        }
      } else {
        console.error('[Hoya Xero] 401 at:', u, d ? `— ${d}` : '');
      }
    }
    return Promise.reject(err);
  }
);

const DEFAULT_HOYA_CONTACT_NAME = 'HOYA LENS AUSTRALIA PTY. LIMITED';

const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

/**
 * Accounting 호출 전에 동일 access token 으로 GET /connections — Postman 과 동일하게 붙는지 확인
 * (기본 axios: 401 시 hoyaXeroHttp 인터셉터와 무관하게 본문 처리)
 */
async function verifyXeroConnectionsBeforeAccounting(accessToken, expectedTenantId) {
  const res = await axios.get(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    validateStatus: () => true
  });

  if (res.status >= 400) {
    const body =
      typeof res.data === 'object' && res.data != null
        ? JSON.stringify(res.data).slice(0, 400)
        : String(res.data || '').slice(0, 200);
    throw new Error(
      `GET /connections HTTP ${res.status} — 토큰이 Xero 에서 거절됐을 수 있음: ${body}`
    );
  }

  const rows = Array.isArray(res.data) ? res.data : [];
  const exp = String(expectedTenantId || '').trim().toLowerCase();
  const hasTenant = rows.some(
    (r) => String(r?.tenantId || '').trim().toLowerCase() === exp
  );

  console.log('[Hoya Xero] /connections', {
    httpStatus: res.status,
    connectionCount: rows.length,
    expectedTenantInList: hasTenant,
    expectedTenantId
  });

  if (rows.length === 0) {
    console.warn('[Hoya Xero] /connections: 연결된 조직 0개 — 앱 연결·스코프 확인');
  } else if (!hasTenant) {
    console.warn(
      '[Hoya Xero] /connections: 이 토큰의 연결 목록에 Xero-tenant-id 가 없음 — tenant·토큰 출처 불일치 가능'
    );
  }
}

/**
 * 같은 access + Xero-tenant-id 로 Organisation 조회 (실패 시 로그만)
 */
async function fetchAndLogXeroOrganisationSnapshot(accessToken, tenantId, entityName) {
  if (!hoyaXeroDebugOrgEnabled()) return;
  try {
    const res = await hoyaXeroHttp.get(`${API}/Organisation`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json'
      },
      validateStatus: () => true
    });
    if (res.status >= 400) {
      console.warn('[Hoya Xero debug] Organisation GET', res.status, {
        entityName,
        tenantId,
        body: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 500) : String(res.data)
      });
      return;
    }
    const org = res.data?.Organisations?.[0];
    console.log(
      '[Hoya Xero debug] Organisation',
      JSON.stringify({
        entityName,
        tenantId,
        Name: org?.Name ?? null,
        LegalName: org?.LegalName ?? null,
        OrganisationType: org?.OrganisationType ?? null,
        BaseCurrency: org?.BaseCurrency ?? null,
        CountryCode: org?.CountryCode ?? null,
        IsDemoCompany: org?.IsDemoCompany ?? null,
        Version: org?.Version ?? null
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Hoya Xero debug] Organisation 요청 예외', { entityName, tenantId, msg });
  }
}

/**
 * @param {object} opts
 * @param {{ entityName: string } | null} [precomputedMatch] 이미 matchBranchFromHoyaPdf 결과가 있으면 재호출 생략
 */
function resolveHoyaEntityName(opts, precomputedMatch) {
  if (opts?.entityName?.trim()) return opts.entityName.trim();
  const matched =
    precomputedMatch ??
    matchBranchFromHoyaPdf({
      storeLine: opts?.storeLine,
      soldTo: opts?.soldTo,
      fullPageText: opts?.fullPageText
    });
  if (matched?.entityName) return matched.entityName;
  const fromEnv =
    process.env.HOYA_XERO_ENTITY?.trim() || process.env.HOYA_FALLBACK_ENTITY?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_ENTITY;
}

function expenseAccountCode() {
  const c = process.env.HOYA_XERO_EXPENSE_ACCOUNT_CODE;
  return (c && String(c).trim()) || '51103';
}

/**
 * GST 금액 0 → 무료, 아니면 경비 GST (조직별 TaxType 문자열은 Xero 설정·env로 맞춤)
 */
function taxTypeForLine(gstMoney, taxFree, taxOnExpenses, fallbackSingle) {
  if (fallbackSingle) return fallbackSingle;
  return gstMoney === 0 ? taxFree : taxOnExpenses;
}

/**
 * 법인명(entity 문자열) → Hoya 공급처 Contact UUID (JSON 한 줄 오버라이드)
 * 예: HOYA_XERO_CONTACT_ID_BY_ENTITY={"1001 Indooroopilly Pty Ltd":"xxxxxxxx-...","1001 Optical Pty Ltd":"..."}
 */
function parseHoyaContactIdByEntityMap() {
  const raw = process.env.HOYA_XERO_CONTACT_ID_BY_ENTITY?.trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch {
    /* ignore */
  }
  return {};
}

async function getContactByIdInTenant(accessToken, tenantId, contactId) {
  const res = await hoyaXeroHttp.get(`${API}/Contacts/${contactId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    },
    validateStatus: () => true
  });
  if (res.status !== 200) return { ok: false, status: res.status };
  const c = res.data?.Contacts?.[0];
  if (c?.ContactID) return { ok: true, contact: c };
  return { ok: false, status: res.status };
}

async function findContactIdByName(accessToken, tenantId, name) {
  const safe = String(name).replace(/"/g, '""');
  const where = `Name=="${safe}"`;
  const url = `${API}/Contacts?where=${encodeURIComponent(where)}`;
  const res = await hoyaXeroHttp.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.Contacts || [];
  return list[0]?.ContactID || null;
}

/**
 * Hoya 공급처 ContactID 결정 순서:
 * 1) HOYA_XERO_CONTACT_ID_BY_ENTITY JSON 의 해당 법인 키
 * 2) ENTITY_CONFIG[entityName].hoyaContactIdEnv (예: HOYA_XERO_CONTACT_ID_INDO)
 * 3) HOYA_XERO_CONTACT_ID + 이 테넌트에서 GET /Contacts/{id} 로 존재 확인 → 없으면 이름 조회
 * 4) HOYA_XERO_CONTACT_NAME 이름 조회
 *
 * @param {string} entityName constants / resolveHoyaEntityName 와 동일한 법인 문자열
 */
async function resolveSupplierContactId(accessToken, tenantId, entityName) {
  const map = parseHoyaContactIdByEntityMap();
  const mapped =
    map[entityName] != null ? String(map[entityName]).trim() : '';
  if (mapped) {
    console.log('[Hoya Xero] HOYA_XERO_CONTACT_ID_BY_ENTITY (JSON)', {
      entityName,
      contactId: mapped.slice(0, 8) + '…'
    });
    return mapped;
  }

  const cfg = ENTITY_CONFIG[entityName];
  const envKey = cfg?.hoyaContactIdEnv;
  const fromEntityEnv =
    envKey && String(process.env[envKey] || '').trim()
      ? String(process.env[envKey]).trim()
      : '';
  if (fromEntityEnv) {
    console.log('[Hoya Xero] 법인별 Contact ID (.env)', {
      entityName,
      env: envKey,
      contactId: fromEntityEnv.slice(0, 8) + '…'
    });
    return fromEntityEnv;
  }

  const globalId = process.env.HOYA_XERO_CONTACT_ID?.trim();
  if (globalId) {
    const check = await getContactByIdInTenant(accessToken, tenantId, globalId);
    if (check.ok) {
      console.log(
        '[Hoya Xero] HOYA_XERO_CONTACT_ID — 이 테넌트에서 확인됨 (GET /Contacts/{id})'
      );
      return globalId;
    }
    if (check.status === 404) {
      console.warn(
        '[Hoya Xero] HOYA_XERO_CONTACT_ID 가 이 법인(테넌트)에 없음 — Optical용 UUID를 Indooroopilly에 쓰면 400이 납니다. 이름으로 공급처 조회 시도.',
        { entityName, tenantId }
      );
    } else if (check.status === 401 || check.status === 403) {
      console.warn(
        '[Hoya Xero] Contact 단건 조회 불가 HTTP',
        check.status,
        '— accounting.contacts 없으면 확인 생략. 멀티 법인이면 HOYA_XERO_CONTACT_ID_INDO 등 법인별 키 또는 HOYA_XERO_CONTACT_ID_BY_ENTITY JSON 설정 권장.'
      );
      console.log(
        '[Hoya Xero] HOYA_XERO_CONTACT_ID 그대로 사용 (스코프 제한 시 이 법인에서 실패할 수 있음)'
      );
      return globalId;
    } else {
      console.warn(
        '[Hoya Xero] Contact 조회 HTTP',
        check.status,
        '— 이름으로 공급처 조회 시도'
      );
    }
  }

  const name = process.env.HOYA_XERO_CONTACT_NAME?.trim() || DEFAULT_HOYA_CONTACT_NAME;
  const found = await findContactIdByName(accessToken, tenantId, name);
  if (!found) {
    const hint =
      cfg?.hoyaContactIdEnv &&
      ` .env 에 ${cfg.hoyaContactIdEnv}=<이 조직 Xero의 Hoya Contact UUID>`;
    throw new Error(
      `Xero에서 공급처 Contact를 찾을 수 없습니다: "${name}".${hint || ''} 또는 HOYA_XERO_CONTACT_ID_BY_ENTITY JSON 에 "${entityName}" 키를 넣거나, 해당 조직 Xero에 동일 이름 Contact를 만드세요.`
    );
  }
  console.log('[Hoya Xero] 공급처 Contact 이름 조회', { name, contactId: found.slice(0, 8) + '…' });
  return found;
}

function logXeroError(payload) {
  console.error('[Hoya Xero error]', JSON.stringify(payload));
}

/** Xero Bill Reference (공백·길이 정리, 최대 255) */
function sanitizeReferenceForXero(ref) {
  const s = String(ref ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!s) return '';
  return s.length > 255 ? s.slice(0, 255) : s;
}

/**
 * 라인의 Store(트래킹) Option 값: BRANCHES 매칭 시 branch.name, 실패 시 선택적 env 폴백
 * Option 문자열은 Xero 조직에 이미 존재하는 트래킹 옵션과 일치해야 함
 */
function resolveTrackingStoreOption(matched) {
  const fromBranch = matched?.branch?.name && String(matched.branch.name).trim();
  if (fromBranch) return fromBranch.slice(0, 100);
  const fb = process.env.HOYA_XERO_TRACKING_OPTION_FALLBACK?.trim();
  return fb ? fb.slice(0, 100) : null;
}

async function postInvoiceMinimalUpdate(accessToken, tenantId, payload) {
  await hoyaXeroHttp.post(
    `${API}/Invoices`,
    { Invoices: [payload] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );
}

function parseMoney(s) {
  if (s == null) return 0;
  const n = String(s).replace(/[^0-9.-]/g, '');
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

/** 파서 깨짐 라인(설명·수량·단가·금액 모두 비어 있음) — Xero 0.01 더미로 보내지 않음 */
function hoyaLineItemHasAnySignal(li) {
  const desc = (li?.description || '').trim();
  if (desc) return true;
  const q = parseMoney(li?.qty);
  const p = parseMoney(li?.price);
  const a = parseMoney(li?.amount);
  return q !== 0 || p !== 0 || a !== 0;
}

/**
 * PDF 본문에서 CUSTOMER REF / ORDER ID 블록만 뽑아 한 줄 Description 문자열로 합침 (Xero 추가 라인용)
 * ORDER ID 값이 라벨 다음 줄에만 있는 경우(빈 줄·공백 허용) 첫 비어 있지 않은 줄을 사용
 */
function buildHoyaMetaRefOrderDescription(fullPageText) {
  if (fullPageText == null || fullPageText === '') return '';
  const t = String(fullPageText).replace(/\r\n/g, '\n');

  let customerRef = '';
  const mCr = t.match(/CUSTOMER\s+REF\s*:\s*([^\n]*)/i);
  if (mCr) customerRef = String(mCr[1] || '').trim();

  let orderId = '';
  const mOi = t.match(/ORDER\s+ID\s*:/i);
  if (mOi) {
    const tail = t.slice(mOi.index + mOi[0].length);
    const mVal = tail.match(/(?:^\s*\n)*\s*([^\n]+)/);
    if (mVal) orderId = String(mVal[1] || '').trim();
  }

  const parts = [];
  if (customerRef) parts.push(`CUSTOMER REF: ${customerRef}`);
  if (orderId) parts.push(`ORDER ID: ${orderId}`);
  return parts.join('  ');
}

function buildAccPayLineItems({
  lineItems,
  storeNameForTracking,
  accountCode,
  taxFreeCode,
  taxOnExpensesCode,
  singleTaxType,
  referenceNumber,
  storeLine,
  fullPageText
}) {
  const trackingCategoryName = process.env.HOYA_XERO_TRACKING_CATEGORY_NAME?.trim();
  const trackingCategoryId = process.env.HOYA_XERO_TRACKING_CATEGORY_ID?.trim();
  /** Online 전용 옵션 UUID — 다른 매장명은 추후 JSON 매핑 확장 */
  const trackingOptionIdOnline = process.env.HOYA_XERO_TRACKING_OPTION_ID_ONLINE?.trim();

  let tracking = {};
  if (trackingCategoryName && storeNameForTracking) {
    const opt = String(storeNameForTracking).slice(0, 100);
    const row = {
      Name: trackingCategoryName,
      Option: opt
    };
    if (trackingCategoryId) row.TrackingCategoryID = trackingCategoryId;
    if (opt.toLowerCase() === 'online' && trackingOptionIdOnline) {
      row.TrackingOptionID = trackingOptionIdOnline;
    }
    tracking = { Tracking: [row] };
  }

  const lines = [];
  const usable = (lineItems || []).filter(hoyaLineItemHasAnySignal);
  for (const li of usable) {
    const qty = parseMoney(li.qty);
    const unitAmount = parseMoney(li.price);
    const gstAmt = parseMoney(li.gst);
    const q = qty > 0 ? qty : 1;
    const ua = unitAmount > 0 ? unitAmount : 0.01;
    const tt = taxTypeForLine(gstAmt, taxFreeCode, taxOnExpensesCode, singleTaxType);
    const desc = (li.description || '').trim() || `Hoya — ${referenceNumber}`;
    lines.push({
      Description: desc.slice(0, 4000),
      Quantity: q,
      UnitAmount: ua,
      AccountCode: accountCode,
      TaxType: tt,
      ...tracking
    });
  }

  if (lines.length === 0) {
    lines.push({
      Description: `Hoya — ${storeLine || referenceNumber}`.slice(0, 4000),
      Quantity: 1,
      /** 설명-only / 합계에 반영하지 않음 (0.01×N건 누적 방지) */
      UnitAmount: 0,
      AccountCode: accountCode,
      TaxType: singleTaxType || taxFreeCode,
      ...tracking
    });
  }

  const metaDesc = buildHoyaMetaRefOrderDescription(fullPageText);
  if (metaDesc) {
    lines.push({
      Description: metaDesc.slice(0, 4000),
      Quantity: 1,
      UnitAmount: 0,
      AccountCode: accountCode,
      TaxType: singleTaxType || taxFreeCode
    });
  }

  return lines;
}

/** Hoya 공급자 크레딧 노트 라인 — PDF 에 qty 0·금액 음수 등 → Xero 는 양수 UnitAmount */
function buildAccPayCreditLineItems({
  lineItems,
  storeNameForTracking,
  accountCode,
  taxFreeCode,
  taxOnExpensesCode,
  singleTaxType,
  referenceNumber,
  storeLine,
  fullPageText
}) {
  const trackingCategoryName = process.env.HOYA_XERO_TRACKING_CATEGORY_NAME?.trim();
  const trackingCategoryId = process.env.HOYA_XERO_TRACKING_CATEGORY_ID?.trim();
  const trackingOptionIdOnline = process.env.HOYA_XERO_TRACKING_OPTION_ID_ONLINE?.trim();

  let tracking = {};
  if (trackingCategoryName && storeNameForTracking) {
    const opt = String(storeNameForTracking).slice(0, 100);
    const row = {
      Name: trackingCategoryName,
      Option: opt
    };
    if (trackingCategoryId) row.TrackingCategoryID = trackingCategoryId;
    if (opt.toLowerCase() === 'online' && trackingOptionIdOnline) {
      row.TrackingOptionID = trackingOptionIdOnline;
    }
    tracking = { Tracking: [row] };
  }

  const lines = [];
  const usable = (lineItems || []).filter(hoyaLineItemHasAnySignal);
  for (const li of usable) {
    let q = parseMoney(li.qty);
    let ua = parseMoney(li.price);
    const gstAmt = parseMoney(li.gst);
    const lineAmt = parseMoney(li.amount);

    if (lineAmt < 0) {
      ua = Math.abs(lineAmt);
      q = q > 0 ? q : 1;
    } else if (q <= 0 && lineAmt > 0 && ua <= 0) {
      q = 1;
      ua = lineAmt;
    } else if (q <= 0 && ua <= 0 && lineAmt !== 0) {
      q = 1;
      ua = Math.abs(lineAmt);
    } else if (q <= 0 && ua > 0) {
      q = 1;
    }

    if (ua <= 0) ua = 0.01;
    const tt = taxTypeForLine(gstAmt, taxFreeCode, taxOnExpensesCode, singleTaxType);
    const desc =
      (li.description || '').trim() || `Hoya supplier credit — ${referenceNumber}`;
    lines.push({
      Description: desc.slice(0, 4000),
      Quantity: q,
      UnitAmount: ua,
      AccountCode: accountCode,
      TaxType: tt,
      ...tracking
    });
  }

  if (lines.length === 0) {
    lines.push({
      Description: `Hoya supplier credit — ${storeLine || referenceNumber}`.slice(0, 4000),
      Quantity: 1,
      UnitAmount: 0,
      AccountCode: accountCode,
      TaxType: singleTaxType || taxFreeCode,
      ...tracking
    });
  }

  const metaDesc = buildHoyaMetaRefOrderDescription(fullPageText);
  if (metaDesc) {
    lines.push({
      Description: metaDesc.slice(0, 4000),
      Quantity: 1,
      UnitAmount: 0,
      AccountCode: accountCode,
      TaxType: singleTaxType || taxFreeCode
    });
  }

  return lines;
}

const EN_MONTH_TO_NUM = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

/**
 * DD/MM/YYYY 또는 DD MMM YYYY(영문 월, 예: 15 Apr 2026) → YYYY-MM-DD
 * @param {string} dateStr
 */
export function parseInvoiceDateToXero(dateStr) {
  const s = String(dateStr).trim();
  const slash = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (slash) {
    let d = parseInt(slash[1], 10);
    let mo = parseInt(slash[2], 10);
    let y = parseInt(slash[3], 10);
    if (y < 100) y += 2000;
    const mm = String(mo).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  const eng = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (eng) {
    const day = parseInt(eng[1], 10);
    const monKey = eng[2].slice(0, 3).toLowerCase();
    const y = parseInt(eng[3], 10);
    const mo = EN_MONTH_TO_NUM[monKey];
    if (!mo || day < 1 || day > 31) {
      throw new Error(`인보이스 날짜(영문 월) 파싱 실패: ${dateStr}`);
    }
    return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  throw new Error(`인보이스 날짜 파싱 실패: ${dateStr}`);
}

/** @param {string} isoYmd YYYY-MM-DD */
export function addCalendarDaysToIsoDate(isoYmd, days) {
  const m = String(isoYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`날짜 형식 오류: ${isoYmd}`);
  const d = new Date(
    Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Hoya Due Date: 인보이스일 + 60일이 떨어지는 달의 마지막 날 (UTC 달력)
 * 예: 21 Apr → +60일이 6월 → Due 30 Jun
 */
function hoyaDueDateEndOfMonthAfter60Days(isoYmd) {
  const m = String(isoYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`날짜 형식 오류: ${isoYmd}`);
  const d = new Date(
    Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  );
  d.setUTCDate(d.getUTCDate() + 60);
  const y = d.getUTCFullYear();
  const mon = d.getUTCMonth();
  const last = new Date(Date.UTC(y, mon + 1, 0));
  return last.toISOString().slice(0, 10);
}

function sanitizeAttachmentFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
}

/** PUT 과 동일한 규칙으로 정규화한 파일명이 이미 Xero 첨부 목록에 있으면 중복 업로드 방지 */
function xeroAlreadyHasAttachmentNamed(attachments, uploadFileName) {
  const want = sanitizeAttachmentFileName(uploadFileName);
  const list = Array.isArray(attachments) ? attachments : [];
  return list.some((a) => {
    const fn = a?.FileName != null ? String(a.FileName) : '';
    return sanitizeAttachmentFileName(fn) === want;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 동일 테넌트·같은 InvoiceNumber/CreditNoteNumber 로 동시에 create 가 나가지 않게 직렬화 (PM2 중복·429 재시도 시 이중 Draft 방지) */
const hoyaXeroExclusiveChains = new Map();

function runHoyaXeroExclusive(serialKey, fn) {
  const prev = hoyaXeroExclusiveChains.get(serialKey) || Promise.resolve();
  const next = prev.then(() => fn());
  hoyaXeroExclusiveChains.set(serialKey, next.catch(() => {}));
  return next;
}

/**
 * ACCPAY 중복 방지: UI Reference = API InvoiceNumber (공급자 인보이스 번호, 예 IN05339094)
 */
async function findAccPayBySupplierInvoiceNumberOnce(accessToken, tenantId, supplierInvoiceNumber) {
  const ref = sanitizeReferenceForXero(supplierInvoiceNumber);
  if (!ref) return null;
  const safeRef = ref.replace(/"/g, '');
  const where = `InvoiceNumber=="${safeRef}"`;
  const url = `${API}/Invoices?where=${encodeURIComponent(where)}`;
  const res = await hoyaXeroHttp.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.Invoices || [];
  return (
    list.find(
      (inv) => sanitizeReferenceForXero(inv.InvoiceNumber) === ref && inv.Type === 'ACCPAY'
    ) || null
  );
}

async function findAccPayBySupplierInvoiceNumber(accessToken, tenantId, supplierInvoiceNumber) {
  const ref = sanitizeReferenceForXero(supplierInvoiceNumber);
  if (!ref) return null;
  const maxTry = Math.max(1, Math.min(8, Number(process.env.HOYA_XERO_FIND_INVOICE_RETRIES || 5)));
  let lastErr;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    try {
      return await findAccPayBySupplierInvoiceNumberOnce(accessToken, tenantId, supplierInvoiceNumber);
    } catch (e) {
      lastErr = e;
      const st = e.response?.status;
      if (st === 429 || st === 503) {
        const waitMs = Math.min(10_000, 350 * 2 ** attempt);
        console.warn('[Hoya Xero] find ACCPAY 재시도', { referenceNumber: ref, attempt: attempt + 1, status: st, waitMs });
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * 공급자 크레딧(ACCPAYCREDIT) — Invoices 가 아니라 CreditNotes API 사용
 * @see https://developer.xero.com/documentation/api/accounting/creditnotes
 */
async function findSupplierCreditByCreditNoteNumberOnce(accessToken, tenantId, creditNoteNumber) {
  const ref = sanitizeReferenceForXero(creditNoteNumber);
  if (!ref) return null;
  const safeRef = ref.replace(/"/g, '');
  const where = `CreditNoteNumber=="${safeRef}"`;
  const url = `${API}/CreditNotes?where=${encodeURIComponent(where)}`;
  const res = await hoyaXeroHttp.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  const list = res.data?.CreditNotes || [];
  return (
    list.find(
      (cn) =>
        sanitizeReferenceForXero(cn.CreditNoteNumber) === ref && cn.Type === 'ACCPAYCREDIT'
    ) || null
  );
}

async function findSupplierCreditByCreditNoteNumber(accessToken, tenantId, creditNoteNumber) {
  const ref = sanitizeReferenceForXero(creditNoteNumber);
  if (!ref) return null;
  const maxTry = Math.max(1, Math.min(8, Number(process.env.HOYA_XERO_FIND_INVOICE_RETRIES || 5)));
  let lastErr;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    try {
      return await findSupplierCreditByCreditNoteNumberOnce(accessToken, tenantId, creditNoteNumber);
    } catch (e) {
      lastErr = e;
      const st = e.response?.status;
      if (st === 429 || st === 503) {
        const waitMs = Math.min(10_000, 350 * 2 ** attempt);
        console.warn('[Hoya Xero] find ACCPAYCREDIT 재시도', {
          creditNoteNumber: ref,
          attempt: attempt + 1,
          status: st,
          waitMs
        });
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function createSupplierCreditNote(accessToken, tenantId, body) {
  const res = await hoyaXeroHttp.post(
    `${API}/CreditNotes`,
    { CreditNotes: [body] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );
  const cn = res.data?.CreditNotes?.[0];
  if (!cn?.CreditNoteID) {
    throw new Error('Xero CreditNote 응답에 CreditNoteID 없음');
  }
  return cn;
}

async function getCreditNoteDetail(accessToken, tenantId, creditNoteId) {
  const res = await hoyaXeroHttp.get(`${API}/CreditNotes/${creditNoteId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  return res.data?.CreditNotes?.[0] || null;
}

async function postCreditNoteMinimalUpdate(accessToken, tenantId, payload) {
  await hoyaXeroHttp.post(
    `${API}/CreditNotes`,
    { CreditNotes: [payload] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );
}

/**
 * @param {{
 *   entityName?: string,
 *   tokenFpAfterGetAccess?: { prefix: string, suffix: string, sha256_12: string } | null,
 *   tokenFpAfterGetDetail?: { prefix: string, suffix: string, sha256_12: string } | null
 * }} [attachDebug]
 */
async function uploadCreditNotePdfAttachment(
  accessToken,
  tenantId,
  creditNoteId,
  fileName,
  pdfBuffer,
  attachDebug = null
) {
  if (pdfBuffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`PDF가 25MB 초과: ${pdfBuffer.length} bytes`);
  }
  const safeName = sanitizeAttachmentFileName(fileName);
  const url = `${API}/CreditNotes/${creditNoteId}/Attachments/${encodeURIComponent(safeName)}`;

  if (hoyaXeroDebugAttachPutEnabled()) {
    const fpPut = xeroAccessTokenFingerprint(accessToken);
    console.log(
      '[Hoya Xero debug] attach PUT fp',
      JSON.stringify({
        tenantId,
        invoiceId: creditNoteId,
        tokenFpSha256_12: fpPut.sha256_12
      })
    );
    if (hoyaXeroDebugAttachPutVerboseEnabled()) {
      console.log(
        '[Hoya Xero debug] attachment PUT 직전 (ACCPAYCREDIT) verbose',
        JSON.stringify({
          entityName: attachDebug?.entityName ?? null,
          tenantId,
          creditNoteId,
          url,
          filename: safeName,
          contentType: 'application/pdf',
          contentLength: pdfBuffer?.length ?? null,
          bodyIsBuffer: Buffer.isBuffer(pdfBuffer),
          tokenFpAfterGetAccess: attachDebug?.tokenFpAfterGetAccess ?? null,
          tokenFpAfterGetDetail: attachDebug?.tokenFpAfterGetDetail ?? null,
          tokenFpPut: fpPut,
          tokenSameAsFlowStart:
            attachDebug?.tokenFpAfterGetAccess?.sha256_12 != null
              ? attachDebug.tokenFpAfterGetAccess.sha256_12 === fpPut.sha256_12
              : null,
          tokenSameAsAfterDetail:
            attachDebug?.tokenFpAfterGetDetail?.sha256_12 != null
              ? attachDebug.tokenFpAfterGetDetail.sha256_12 === fpPut.sha256_12
              : null
        })
      );
    }
  }

  await hoyaXeroHttp.put(url, pdfBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/pdf'
    },
    maxBodyLength: MAX_ATTACHMENT_BYTES + 1,
    maxContentLength: MAX_ATTACHMENT_BYTES + 1
  });
}

async function createAccPayInvoice(accessToken, tenantId, body) {
  const res = await hoyaXeroHttp.post(
    `${API}/Invoices`,
    { Invoices: [body] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );
  const inv = res.data?.Invoices?.[0];
  if (!inv?.InvoiceID) {
    throw new Error('Xero 인보이스 생성 응답에 InvoiceID 없음');
  }
  return inv;
}

async function getInvoiceDetail(accessToken, tenantId, invoiceId) {
  const res = await hoyaXeroHttp.get(`${API}/Invoices/${invoiceId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json'
    }
  });
  return res.data?.Invoices?.[0] || null;
}

/**
 * @param {{
 *   entityName?: string,
 *   tokenFpAfterGetAccess?: { prefix: string, suffix: string, sha256_12: string } | null,
 *   tokenFpAfterGetDetail?: { prefix: string, suffix: string, sha256_12: string } | null
 * }} [attachDebug]
 */
async function uploadInvoicePdfAttachment(
  accessToken,
  tenantId,
  invoiceId,
  fileName,
  pdfBuffer,
  attachDebug = null
) {
  if (pdfBuffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`PDF가 25MB 초과: ${pdfBuffer.length} bytes`);
  }

  const safeName = sanitizeAttachmentFileName(fileName);
  const url = `${API}/Invoices/${invoiceId}/Attachments/${encodeURIComponent(safeName)}`;

  if (hoyaXeroDebugAttachPutEnabled()) {
    const fpPut = xeroAccessTokenFingerprint(accessToken);
    console.log(
      '[Hoya Xero debug] attach PUT fp',
      JSON.stringify({
        tenantId,
        invoiceId,
        tokenFpSha256_12: fpPut.sha256_12
      })
    );
    if (hoyaXeroDebugAttachPutVerboseEnabled()) {
      console.log(
        '[Hoya Xero debug] attachment PUT 직전 (ACCPAY) verbose',
        JSON.stringify({
          entityName: attachDebug?.entityName ?? null,
          tenantId,
          invoiceId,
          url,
          filename: safeName,
          contentType: 'application/pdf',
          contentLength: pdfBuffer?.length ?? null,
          bodyIsBuffer: Buffer.isBuffer(pdfBuffer),
          tokenFpAfterGetAccess: attachDebug?.tokenFpAfterGetAccess ?? null,
          tokenFpAfterGetDetail: attachDebug?.tokenFpAfterGetDetail ?? null,
          tokenFpPut: fpPut,
          tokenSameAsFlowStart:
            attachDebug?.tokenFpAfterGetAccess?.sha256_12 != null
              ? attachDebug.tokenFpAfterGetAccess.sha256_12 === fpPut.sha256_12
              : null,
          tokenSameAsAfterDetail:
            attachDebug?.tokenFpAfterGetDetail?.sha256_12 != null
              ? attachDebug.tokenFpAfterGetDetail.sha256_12 === fpPut.sha256_12
              : null
        })
      );
    }
  }

  await hoyaXeroHttp.put(url, pdfBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/pdf'
    },
    maxBodyLength: MAX_ATTACHMENT_BYTES + 1,
    maxContentLength: MAX_ATTACHMENT_BYTES + 1
  });
}

/**
 * Hoya 인보이스 번호(IN…) = ACCPAY InvoiceNumber(UI Reference) 기준 조회 또는 생성 후 1페이지 PDF 첨부
 * @param {{
 *   referenceNumber: string,
 *   invoiceDateStr: string,
 *   storeLine?: string|null,
 *   soldTo?: string|null,
 *   entityName?: string,
 *   lineItems: Array<object>,
 *   pagePdfBuffer: Buffer,
 *   attachmentFileName: string,
 *   fullPageText?: string|null,
 * }} opts
 */
export async function ensureHoyaAccPayAndAttach(opts) {
  const {
    referenceNumber,
    invoiceDateStr,
    storeLine,
    soldTo,
    fullPageText,
    lineItems,
    pagePdfBuffer,
    attachmentFileName
  } = opts;

  const refTrim = sanitizeReferenceForXero(referenceNumber);
  if (!refTrim) {
    throw new Error(
      'referenceNumber 가 비어 있어 Xero Bill InvoiceNumber(UI Reference) 를 설정할 수 없습니다'
    );
  }

  const matched = matchBranchFromHoyaPdf({ storeLine, soldTo, fullPageText });
  const entityName = resolveHoyaEntityName(opts, matched);
  if (!matched && !opts.entityName) {
    console.warn('[Hoya Xero] BRANCHES 스토어 이름 매칭 실패 — 기본/HOYA_XERO_ENTITY 법인 사용', {
      storeLine: storeLine?.slice?.(0, 300),
      soldTo: soldTo?.slice?.(0, 300),
      entityName
    });
  }

  const accessToken = await getAccessToken(entityName);
  const tokenFpAfterGetAccess = hoyaXeroDebugAttachPutEnabled()
    ? xeroAccessTokenFingerprint(accessToken)
    : null;
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) {
    throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);
  }

  const entity = entityName;
  console.log({
    entity,
    tenantId,
    tokenPrefix: accessToken.slice(0, 40)
  });

  await verifyXeroConnectionsBeforeAccounting(accessToken, tenantId);
  await fetchAndLogXeroOrganisationSnapshot(accessToken, tenantId, entityName);

  const contactId = await resolveSupplierContactId(accessToken, tenantId, entityName);
  const accountCode = expenseAccountCode();
  const date = parseInvoiceDateToXero(invoiceDateStr);
  const dueDate = hoyaDueDateEndOfMonthAfter60Days(date);
  const currency = process.env.HOYA_XERO_CURRENCY || 'AUD';

  /** GST=0 라인. GSTFREE 는 판매 쪽에 쓰이는 경우가 많아 ACCPAY+경비계정에서 400 나는 조직이 많음 → AU 는 보통 EXEMPTEXPENSES */
  const taxFree =
    process.env.HOYA_XERO_TAX_GST_FREE?.trim() || 'EXEMPTEXPENSES';
  const taxOnExpenses =
    process.env.HOYA_XERO_TAX_GST_ON_EXPENSES?.trim() || 'INPUT';
  const singleTax = process.env.HOYA_XERO_LINE_TAX_TYPE?.trim() || '';

  const storeNameForTracking = resolveTrackingStoreOption(matched);
  const trackingCat = process.env.HOYA_XERO_TRACKING_CATEGORY_NAME?.trim();
  if (!trackingCat && !loggedTrackingCategoryNameMissingHint) {
    loggedTrackingCategoryNameMissingHint = true;
    console.warn(
      '[Hoya Xero] (한 번만) HOYA_XERO_TRACKING_CATEGORY_NAME 미설정 — Bill 라인의 Store 열은 비어 있습니다. Xero 조직 설정 → 추적(예: Store)의 정확한 이름을 .env 에 넣으세요. Option은 BRANCHES 매칭 매장명(예: Online) 또는 HOYA_XERO_TRACKING_OPTION_FALLBACK 입니다.'
    );
  }
  if (trackingCat && !storeNameForTracking && !loggedTrackingOptionMissingHint) {
    loggedTrackingOptionMissingHint = true;
    console.warn(
      '[Hoya Xero] (한 번만) 트래킹 카테고리는 설정됐으나 Option(매장)을 정하지 못했습니다. constants BRANCHES·invoiceAliases 또는 HOYA_XERO_TRACKING_OPTION_FALLBACK 을 확인하세요.'
    );
  }

  const xeroLineItems = buildAccPayLineItems({
    lineItems,
    storeNameForTracking,
    accountCode,
    taxFreeCode: taxFree,
    taxOnExpensesCode: taxOnExpenses,
    singleTaxType: singleTax || null,
    referenceNumber: refTrim,
    storeLine,
    fullPageText
  });

  return runHoyaXeroExclusive(`ACCPAY|${tenantId}|${refTrim}`, async () => {
    let existing = await findAccPayBySupplierInvoiceNumber(accessToken, tenantId, refTrim);

    let invoiceId;
    if (existing?.InvoiceID) {
      invoiceId = existing.InvoiceID;
      console.log('[Hoya Xero] ACCPAY 기존 건(InvoiceNumber·UI Reference 일치) — 첨부만 진행', {
        invoiceId,
        referenceNumber: refTrim,
        entityName,
        existingDate: existing.DateString ?? existing.Date
      });
    } else {
      const created = await createAccPayInvoice(accessToken, tenantId, {
        Type: 'ACCPAY',
        Contact: { ContactID: contactId },
        Date: date,
        DueDate: dueDate,
        InvoiceNumber: refTrim,
        CurrencyCode: currency,
        Status: 'AUTHORISED',
        LineAmountTypes: 'Exclusive',
        LineItems: xeroLineItems
      });
      invoiceId = created.InvoiceID;
      console.log('[Hoya Xero] ACCPAY 생성', {
        invoiceId,
        referenceNumber: refTrim,
        entityName,
        lines: xeroLineItems.length
      });
    }

    const detail = await getInvoiceDetail(accessToken, tenantId, invoiceId);
    if (refTrim && !String(detail?.InvoiceNumber || '').trim()) {
      try {
        await postInvoiceMinimalUpdate(accessToken, tenantId, {
          InvoiceID: invoiceId,
          InvoiceNumber: refTrim
        });
        console.log('[Hoya Xero] Bill InvoiceNumber(UI Reference) 가 비어 있어 파싱값으로 보정', {
          invoiceId,
          InvoiceNumber: refTrim
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[Hoya Xero] InvoiceNumber 보정 실패 (Xero에서 수동 입력)', {
          invoiceId,
          InvoiceNumber: refTrim,
          error: msg
        });
      }
    }

    const attCount = detail?.Attachments?.length ?? 0;
    if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
      const msg = `인보이스 ${invoiceId} 첨부 ${attCount}개 — 최대 ${MAX_ATTACHMENTS_PER_INVOICE}개`;
      logXeroError({ referenceNumber: refTrim, invoiceId, error: msg });
      throw new Error(msg);
    }

    if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) {
      console.log('[Hoya Xero] 첨부 이미 동일 파일명 존재 — 업로드 스킵', {
        invoiceId,
        referenceNumber: refTrim,
        file: sanitizeAttachmentFileName(attachmentFileName)
      });
      return;
    }

    const tokenFpAfterGetDetail = hoyaXeroDebugAttachPutEnabled()
      ? xeroAccessTokenFingerprint(accessToken)
      : null;

    await uploadInvoicePdfAttachment(
      accessToken,
      tenantId,
      invoiceId,
      attachmentFileName,
      pagePdfBuffer,
      {
        entityName,
        tokenFpAfterGetAccess,
        tokenFpAfterGetDetail
      }
    );
    console.log('[Hoya Xero] 첨부 업로드', {
      invoiceId,
      referenceNumber: refTrim,
      file: attachmentFileName,
      bytes: pagePdfBuffer.length,
      accPaySource: existing?.InvoiceID ? 'reference_reuse' : 'new_create'
    });
  });
}

/**
 * Hoya 공급자 크레딧 노트(FCN…) → Xero CreditNotes API (Type ACCPAYCREDIT) + PDF 첨부
 * (Invoices 엔드포인트로는 생성 불가 — "Invoice not of valid type for creation")
 * @param {Parameters<typeof ensureHoyaAccPayAndAttach>[0]} opts
 */
export async function ensureHoyaSupplierCreditAndAttach(opts) {
  const {
    referenceNumber,
    invoiceDateStr,
    storeLine,
    soldTo,
    fullPageText,
    lineItems,
    pagePdfBuffer,
    attachmentFileName
  } = opts;

  const refTrim = sanitizeReferenceForXero(referenceNumber);
  if (!refTrim) {
    throw new Error(
      'referenceNumber 가 비어 있어 Xero Supplier Credit InvoiceNumber 를 설정할 수 없습니다'
    );
  }

  const matched = matchBranchFromHoyaPdf({ storeLine, soldTo, fullPageText });
  const entityName = resolveHoyaEntityName(opts, matched);
  if (!matched && !opts.entityName) {
    console.warn('[Hoya Xero] BRANCHES 스토어 이름 매칭 실패 — 기본/HOYA_XERO_ENTITY 법인 사용', {
      storeLine: storeLine?.slice?.(0, 300),
      soldTo: soldTo?.slice?.(0, 300),
      entityName
    });
  }

  const accessToken = await getAccessToken(entityName);
  const tokenFpAfterGetAccess = hoyaXeroDebugAttachPutEnabled()
    ? xeroAccessTokenFingerprint(accessToken)
    : null;
  const tenantId = getTenantIdForEntity(entityName);
  if (!tenantId) {
    throw new Error(`테넌트 ID 없음 (법인: ${entityName})`);
  }

  console.log({
    entity: entityName,
    tenantId,
    kind: 'ACCPAYCREDIT',
    tokenPrefix: accessToken.slice(0, 40)
  });

  await verifyXeroConnectionsBeforeAccounting(accessToken, tenantId);
  await fetchAndLogXeroOrganisationSnapshot(accessToken, tenantId, entityName);

  const contactId = await resolveSupplierContactId(accessToken, tenantId, entityName);
  const accountCode = expenseAccountCode();
  const date = parseInvoiceDateToXero(invoiceDateStr);
  const dueDate = hoyaDueDateEndOfMonthAfter60Days(date);
  const currency = process.env.HOYA_XERO_CURRENCY || 'AUD';

  const taxFree =
    process.env.HOYA_XERO_TAX_GST_FREE?.trim() || 'EXEMPTEXPENSES';
  const taxOnExpenses =
    process.env.HOYA_XERO_TAX_GST_ON_EXPENSES?.trim() || 'INPUT';
  const singleTax = process.env.HOYA_XERO_LINE_TAX_TYPE?.trim() || '';

  const storeNameForTracking = resolveTrackingStoreOption(matched);
  const xeroLineItems = buildAccPayCreditLineItems({
    lineItems,
    storeNameForTracking,
    accountCode,
    taxFreeCode: taxFree,
    taxOnExpensesCode: taxOnExpenses,
    singleTaxType: singleTax || null,
    referenceNumber: refTrim,
    storeLine,
    fullPageText
  });

  return runHoyaXeroExclusive(`ACCPAYCREDIT|${tenantId}|${refTrim}`, async () => {
    let existing = await findSupplierCreditByCreditNoteNumber(
      accessToken,
      tenantId,
      refTrim
    );

    let creditNoteId;
    if (existing?.CreditNoteID) {
      creditNoteId = existing.CreditNoteID;
      console.log('[Hoya Xero] ACCPAYCREDIT 기존 건(CreditNoteNumber 일치) — 첨부만 진행', {
        creditNoteId,
        creditNoteNumber: refTrim,
        entityName
      });
    } else {
      const created = await createSupplierCreditNote(accessToken, tenantId, {
        Type: 'ACCPAYCREDIT',
        Contact: { ContactID: contactId },
        Date: date,
        DueDate: dueDate,
        CreditNoteNumber: refTrim,
        CurrencyCode: currency,
        Status: 'AUTHORISED',
        LineAmountTypes: 'Exclusive',
        LineItems: xeroLineItems
      });
      creditNoteId = created.CreditNoteID;
      console.log('[Hoya Xero] ACCPAYCREDIT 생성 (CreditNotes)', {
        creditNoteId,
        creditNoteNumber: refTrim,
        entityName,
        lines: xeroLineItems.length
      });
    }

    const detail = await getCreditNoteDetail(accessToken, tenantId, creditNoteId);
    if (refTrim && !String(detail?.CreditNoteNumber || '').trim()) {
      try {
        await postCreditNoteMinimalUpdate(accessToken, tenantId, {
          CreditNoteID: creditNoteId,
          CreditNoteNumber: refTrim
        });
        console.log('[Hoya Xero] CreditNoteNumber 보정', {
          creditNoteId,
          CreditNoteNumber: refTrim
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[Hoya Xero] CreditNoteNumber 보정 실패', {
          creditNoteId,
          error: msg
        });
      }
    }

    const attCount = detail?.Attachments?.length ?? 0;
    if (attCount >= MAX_ATTACHMENTS_PER_INVOICE) {
      const msg = `크레딧 노트 ${creditNoteId} 첨부 ${attCount}개 — 최대 ${MAX_ATTACHMENTS_PER_INVOICE}개`;
      logXeroError({ referenceNumber: refTrim, invoiceId: creditNoteId, error: msg });
      throw new Error(msg);
    }

    if (xeroAlreadyHasAttachmentNamed(detail?.Attachments, attachmentFileName)) {
      console.log('[Hoya Xero] 크레딧 첨부 이미 동일 파일명 존재 — 업로드 스킵', {
        creditNoteId,
        creditNoteNumber: refTrim,
        file: sanitizeAttachmentFileName(attachmentFileName)
      });
      return;
    }

    const tokenFpAfterGetDetail = hoyaXeroDebugAttachPutEnabled()
      ? xeroAccessTokenFingerprint(accessToken)
      : null;

    await uploadCreditNotePdfAttachment(
      accessToken,
      tenantId,
      creditNoteId,
      attachmentFileName,
      pagePdfBuffer,
      {
        entityName,
        tokenFpAfterGetAccess,
        tokenFpAfterGetDetail
      }
    );
    console.log('[Hoya Xero] 크레딧 첨부 업로드', {
      creditNoteId,
      creditNoteNumber: refTrim,
      file: attachmentFileName,
      bytes: pagePdfBuffer.length,
      accPaySource: existing?.CreditNoteID ? 'reference_reuse' : 'new_create'
    });
  });
}
