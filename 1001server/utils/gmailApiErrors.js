/**
 * Gmail API 공통 오류 판별 (googleapis / gaxios)
 */

/** 메시지·첨부 등이 없을 때 — history 에 남은 고아 ID 로 무한 재시도되는 것 방지용 */
export function isGmailRequestedEntityNotFound(err) {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/requested entity was not found/i.test(msg)) return true;
  if (err.code === 404) return true;
  const st = err.response?.status;
  if (st === 404) return true;
  const errors = err.response?.data?.error?.errors;
  if (Array.isArray(errors) && errors.some((e) => e?.reason === 'notFound')) return true;
  return false;
}
