/**
 * Gmail history.list 로 신규 messageId 수집 (Hoya·Alcon 등 Payable 인보이스 공통)
 * startHistoryId 404 시 최근 발신 메일로 대체 (Hoya + Alcon 발신자)
 */

/**
 * @param {*} gmail google.gmail v1
 * @param {string} userEmail
 * @param {string | null} lastHistoryId getLastHistoryId 결과
 * @returns {Promise<Set<string>>}
 */
export async function collectMessageIdsSinceHistoryForPayables(
  gmail,
  userEmail,
  lastHistoryId
) {
  const messageIds = new Set();

  if (lastHistoryId) {
    try {
      let pageToken;
      do {
        const hist = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: lastHistoryId,
          pageToken,
          historyTypes: ['messageAdded']
        });

        for (const h of hist.data.history || []) {
          for (const added of h.messagesAdded || []) {
            if (added.message?.id) messageIds.add(added.message.id);
          }
        }
        pageToken = hist.data.nextPageToken || undefined;
      } while (pageToken);
    } catch (e) {
      const status = e.response?.status || e.code;
      if (status === 404) {
        console.warn(
          '[Gmail Payables] history 404 — 최근 Hoya/Alcon 메일로 대체 조회',
          userEmail
        );
        await listRecentPayableVendorFallback(gmail, messageIds);
      } else {
        throw e;
      }
    }
  } else {
    await listRecentPayableVendorFallback(gmail, messageIds);
  }

  return messageIds;
}

async function listRecentPayableVendorFallback(gmail, ids) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: '(from:axd365au@hoya.com OR from:my.accounts@alcon.com) newer_than:14d',
    maxResults: 40
  });
  for (const m of res.data.messages || []) {
    if (m.id) ids.add(m.id);
  }
}
