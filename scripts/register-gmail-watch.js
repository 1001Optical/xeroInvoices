/**
 * Gmail users.watch() 등록 — 로컬/배포 후 수동 실행용.
 * 프로덕션 자동 갱신: Cloud Scheduler → GET/POST /webhooks/gmail/renew-watch?token=...
 * @see 1001server/routes/gmailPubSub.js
 *
 * 사용: npm run gmail:watch
 */
import dotenv from 'dotenv';
import { registerPayableGmailWatch } from '../1001server/utils/gmailWatchRegister.js';

dotenv.config();

registerPayableGmailWatch()
  .then((out) => {
    console.log('WATCH RESPONSE:', JSON.stringify(out.raw, null, 2));
    if (out.historyId) console.log('historyId:', out.historyId);
    if (out.expirationIso) {
      console.log('watch 만료(대략):', out.expirationIso, '(만료 전에 갱신 권장)');
    }
  })
  .catch((err) => {
    const data = err.response?.data;
    console.error('Gmail watch 실패:', data || err.message);
    if (data?.error) console.error(JSON.stringify(data.error, null, 2));
    process.exit(1);
  });
