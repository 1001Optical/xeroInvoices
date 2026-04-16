/**
 * Gmail users.watch() 등록 — 한 번 실행하면 Pub/Sub 토픽으로 메일함 변경 알림이 갑니다.
 * GCP에서 해당 토픽 → 구독(푸시) → 서버 /webhooks/gmail/pubsub 로 이미 연결했다고 가정.
 *
 * 사용: npm run gmail:watch
 * 필요 env: PAYABLE_GMAIL_CLIENT_ID, PAYABLE_GMAIL_CLIENT_SECRET, PAYABLE_GMAIL_REFRESH_TOKEN, PAYABLE_SUBPUB
 * 선택: PAYABLE_GMAIL_WATCH_LABEL_IDS (쉼표구분, 기본 INBOX)
 */
import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

const clientId = process.env.PAYABLE_GMAIL_CLIENT_ID;
const clientSecret = process.env.PAYABLE_GMAIL_CLIENT_SECRET;
const refreshToken = process.env.PAYABLE_GMAIL_REFRESH_TOKEN;
const topicName = process.env.PAYABLE_SUBPUB;

if (!clientId || !clientSecret || !refreshToken || !topicName) {
  console.error(
    '필수 환경 변수가 없습니다: PAYABLE_GMAIL_CLIENT_ID, PAYABLE_GMAIL_CLIENT_SECRET, PAYABLE_GMAIL_REFRESH_TOKEN, PAYABLE_SUBPUB'
  );
  process.exit(1);
}

const labelIds = process.env.PAYABLE_GMAIL_WATCH_LABEL_IDS
  ? process.env.PAYABLE_GMAIL_WATCH_LABEL_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ['INBOX'];

const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });

const gmail = google.gmail({ version: 'v1', auth });

async function watch() {
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName,
      labelIds
    }
  });

  console.log('WATCH RESPONSE:', JSON.stringify(res.data, null, 2));
  if (res.data.historyId) {
    console.log('historyId:', res.data.historyId);
  }
  if (res.data.expiration) {
    const exp = Number(res.data.expiration);
    console.log(
      'watch 만료(대략):',
      new Date(exp).toISOString(),
      '(만료 전에 다시 npm run gmail:watch 권장)'
    );
  }
}

watch().catch((err) => {
  const data = err.response?.data;
  console.error('Gmail watch 실패:', data || err.message);
  if (data?.error) console.error(JSON.stringify(data.error, null, 2));
  process.exit(1);
});
