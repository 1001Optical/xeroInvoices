/**
 * PDF SOLD TO / 1001 … 줄에서 constants.js BRANCHES 와 매칭 → Xero 법인(entity) 문자열
 * - name 포함 여부
 * - invoiceAliases(선택) — Online → "1001 OPTICAL CENTRAL DISTRIBUTION" 등 인보이스 전용 문구
 */
import { BRANCHES } from '../../constants.js';

/**
 * 매칭 문자열 후보: branch.name + 각 branch.invoiceAliases[]
 * 긴 문자열을 먼저 시도 (Chatswood Westfield vs Chatswood 등)
 * @returns {Array<{ branch: (typeof BRANCHES)[number], phrase: string }>}
 */
function sortedBranchNeedles() {
  const pairs = [];
  for (const b of BRANCHES) {
    pairs.push({ branch: b, phrase: String(b.name) });
    const aliases = b.invoiceAliases;
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        if (a != null && String(a).trim()) pairs.push({ branch: b, phrase: String(a) });
      }
    }
  }
  pairs.sort((x, y) => y.phrase.length - x.phrase.length);
  return pairs;
}

const NEEDLES = sortedBranchNeedles();

/**
 * @param {{ storeLine?: string|null, soldTo?: string|null, fullPageText?: string|null }} fields
 *   fullPageText — SOLD TO 블록만 잡히면 'Account' 등 오탐일 때, 페이지 전체에서 1001… 문구 매칭용
 */
export function matchBranchFromHoyaPdf(fields) {
  const hay = [fields?.storeLine, fields?.soldTo, fields?.fullPageText]
    .filter((x) => x != null && String(x).trim() !== '')
    .join('\n')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!hay) return null;

  for (const { branch, phrase } of NEEDLES) {
    const n = phrase.trim().toLowerCase();
    if (n.length < 2) continue;
    if (hay.includes(n)) {
      const entityName = branch.entity || branch.bankEntity;
      if (!entityName) continue;
      return { branch, entityName };
    }
  }
  return null;
}
