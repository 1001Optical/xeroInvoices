/**
 * 루트/헬스 문서용 엔드포인트 요약 (server에서 JSON으로 노출 가능)
 */
export const rootEndpointsDocumentation = {
  xeroInternalAccessToken: {
    method: 'GET',
    path: '/api/internal/xero/access-token',
    query: {
      entity:
        '법인명 문자열 (ENTITY_CONFIG 키와 동일, 예: 1001 Optical Pty Ltd). 미입력 시 DEFAULT_ENTITY'
    },
    headers: {
      Authorization: 'Bearer <XERO_INTERNAL_API_KEY>',
      'x-api-key': '대안: XERO_INTERNAL_API_KEY 값'
    },
    response: {
      success: 'boolean',
      accessToken: 'string',
      expiresIn: '초 단위 남은 유효 시간',
      tenantId: '해당 엔티티 테넌트 UUID',
      entity: 'string'
    },
    note: 'refresh_token 미포함. identity 호출은 1001server/utils/xero.js 에서만 수행.'
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
    note: '푸시 수신 라우트 헬스체크'
  }
};
