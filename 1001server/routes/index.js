/**
 * 루트/헬스 문서용 엔드포인트 요약 (server에서 JSON으로 노출 가능)
 */
export const rootEndpointsDocumentation = {
  xeroInternalAccessToken: {
    method: 'GET',
    path: '/api/internal/xero/access-token',
    query:
      '무시됨 (?entity 등). 항상 DEFAULT_ENTITY(기본 1001 Optical Pty Ltd) = xero_tokens id 1 만 사용',
    headers: {
      Authorization: 'Bearer <XERO_INTERNAL_API_KEY>',
      'x-api-key': '대안: XERO_INTERNAL_API_KEY 값'
    },
    response: {
      success: 'boolean',
      accessToken: 'string',
      expiresIn: '초 단위 남은 유효 시간',
      tenantId: 'DEFAULT_ENTITY(Optical) 테넌트 UUID — 다른 법인은 호출 쪽 .env *_TENANT_ID',
      entity: '항상 DEFAULT_ENTITY 문자열 (예: 1001 Optical Pty Ltd)',
      xeroTokensRowId: '1 (ENTITY_CONFIG / DB id)'
    },
    note:
      'refresh_token 미포함. 멀티 테넌트 Xero 호출 시 access 는 이 토큰, Xero-tenant-id 는 각 법인 env. identity 호출은 1001server/utils/xero.js 에서만 수행.'
  },
  gmailPubSubPush: {
    method: 'POST',
    path: '/webhooks/gmail/pubsub',
    query: {
      token:
        '선택: GMAIL_PUBSUB_PUSH_TOKEN 과 같으면 허용 (미설정 시 토큰 검사 없음, 운영에서는 설정 권장)'
    },
    body: 'Google Pub/Sub push envelope (message.data = Gmail 알림 base64 JSON)',
    response: '성공 시 204 No Content'
  },
  gmailPubSubHealth: {
    method: 'GET',
    path: '/webhooks/gmail/health',
    note: '푸시 수신 라우트 헬스체크; watchRenewConfigured 는 GMAIL_WATCH_RENEW_TOKEN 설정 여부'
  },
  gmailWatchRenew: {
    method: 'GET or POST',
    path: '/webhooks/gmail/renew-watch',
    query: {
      token: '필수: GMAIL_WATCH_RENEW_TOKEN 과 동일 (env 미설정 시 503)'
    },
    headers: {
      Authorization: '대안: Bearer <GMAIL_WATCH_RENEW_TOKEN>'
    },
    note:
      'Gmail users.watch() 재등록 — Cloud Scheduler 예: 6일마다 GET 호출. Pub/Sub 토큰(GMAIL_PUBSUB_PUSH_TOKEN)과 별도 비밀 권장'
  }
};
