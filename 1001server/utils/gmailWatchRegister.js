/**
 * Gmail users.watch() 등록 — 스크립트·HTTP 갱신 엔드포인트 공용.
 * 환경: PAYABLE_GMAIL_CLIENT_ID, PAYABLE_GMAIL_CLIENT_SECRET, PAYABLE_GMAIL_REFRESH_TOKEN, PAYABLE_SUBPUB
 * 선택: PAYABLE_GMAIL_WATCH_LABEL_IDS (쉼표 구분 label ID)
 */
import { google } from 'googleapis';

/**
 * @returns {Promise<{ historyId: string | null, expiration: number | null, expirationIso: string | null, raw: object }>}
 */
export async function registerPayableGmailWatch() {
  const clientId = process.env.PAYABLE_GMAIL_CLIENT_ID;
  const clientSecret = process.env.PAYABLE_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.PAYABLE_GMAIL_REFRESH_TOKEN;
  const topicName = process.env.PAYABLE_SUBPUB;

  if (!clientId || !clientSecret || !refreshToken || !topicName) {
    throw new Error(
      '필수 env 누락: PAYABLE_GMAIL_CLIENT_ID, PAYABLE_GMAIL_CLIENT_SECRET, PAYABLE_GMAIL_REFRESH_TOKEN, PAYABLE_SUBPUB'
    );
  }

  const labelIds = process.env.PAYABLE_GMAIL_WATCH_LABEL_IDS
    ? process.env.PAYABLE_GMAIL_WATCH_LABEL_IDS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName,
      ...(labelIds.length > 0 ? { labelIds } : {})
    }
  });

  const data = res.data || {};
  const exp = data.expiration != null ? Number(data.expiration) : null;
  return {
    historyId: data.historyId != null ? String(data.historyId) : null,
    expiration: Number.isFinite(exp) ? exp : null,
    expirationIso: Number.isFinite(exp) ? new Date(exp).toISOString() : null,
    raw: data
  };
}
