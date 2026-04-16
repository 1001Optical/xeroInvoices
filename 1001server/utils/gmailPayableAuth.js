import { google } from 'googleapis';

/**
 * .env PAYABLE_GMAIL_* 로 Gmail API 클라이언트
 */
export function createPayableGmailClient() {
  const clientId = process.env.PAYABLE_GMAIL_CLIENT_ID;
  const clientSecret = process.env.PAYABLE_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.PAYABLE_GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'PAYABLE_GMAIL_CLIENT_ID, PAYABLE_GMAIL_CLIENT_SECRET, PAYABLE_GMAIL_REFRESH_TOKEN 가 필요합니다.'
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth });
}
