# 별도 서버·크론·워커에서 Xero access token 받기

다른 미들웨어(별도 서버·크론·워커)에서 **1001server만** 토큰을 발급받고 Xero를 호출할 때 쓰는 방법입니다.

## 1. 무엇을 호출하는지

| 항목 | 값 |
|------|-----|
| 메서드·경로 | `GET /api/internal/xero/access-token` |
| 베이스 URL | 1001server 주소 (예: `https://your-api.example.com`, 로컬이면 `http://localhost:8000`) |
| 쿼리 | `entity` — 아래 엔티티 문자열과 **정확히 동일**해야 함 |

**전체 URL 예**

```http
GET {BASE}/api/internal/xero/access-token?entity=1001%20Optical%20Pty%20Ltd
```

`entity`는 `1001server/utils/xero.js`의 `ENTITY_CONFIG` **키**와 한 글자도 다르면 안 됩니다. (예: `'WSQ Eyecare Pty ltd`의 `ltd` 소문자 등)

## 2. 인증 헤더 (둘 중 하나)

1001server `.env`에 **`XERO_INTERNAL_API_KEY`**가 설정되어 있어야 하고, 요청 시 그 값과 같아야 합니다.

```http
Authorization: Bearer <XERO_INTERNAL_API_KEY>
```

또는

```http
x-api-key: <XERO_INTERNAL_API_KEY>
```

이 경로는 `server.js`에서 전역 `API_TOKEN`보다 먼저 걸려 있어서, 일반 대시보드용 `API_TOKEN`이 아니라 **이 내부 키**를 씁니다.

## 3. 응답 (JSON)

성공 시 대략 다음 형태입니다.

```json
{
  "success": true,
  "accessToken": "<JWT>",
  "expiresIn": 1234,
  "tenantId": "<uuid>",
  "entity": "1001 Optical Pty Ltd"
}
```

| 필드 | 설명 |
|------|------|
| `accessToken` | Xero API `Authorization: Bearer`에 넣는 값 |
| `tenantId` | Xero 요청 헤더 `Xero-tenant-id` |
| `expiresIn` | 대략적인 남은 유효 시간(초) |

**`refresh_token`은 절대 내려오지 않습니다.**

에러 시: `400`(잘못된 entity), `401`(키 불일치), `503`(서버에 `XERO_INTERNAL_API_KEY` 미설정), `500`(갱신 실패 등). 에러 본문은 `error` 필드를 볼 수 있습니다.

## 4. 받은 뒤 Xero API 호출 방법

1. 위 API로 `accessToken`, `tenantId`를 받는다.
2. Xero REST 호출 시:
   - `Authorization: Bearer {accessToken}`
   - `Xero-tenant-id: {tenantId}`
   - `Accept: application/json`
3. access가 만료되면 **같은 내부 API를 다시 호출**해 새 `accessToken`을 받으면 됩니다. (refresh는 1001server·DB에서만 처리)

## 5. 예시: curl

```bash
curl -sS -G "${BASE_URL}/api/internal/xero/access-token" \
  --data-urlencode "entity=1001 Optical Pty Ltd" \
  -H "Authorization: Bearer ${XERO_INTERNAL_API_KEY}"
```

## 6. 예시: Node (fetch)

```javascript
const base = process.env.SERVER_BASE_URL; // 예: https://api.example.com
const entity = '1001 Optical Pty Ltd';
const url = new URL('/api/internal/xero/access-token', base);
url.searchParams.set('entity', entity);
const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${process.env.XERO_INTERNAL_API_KEY}`,
  },
});
const data = await res.json();
if (!res.ok) throw new Error(data.error || data.message || String(res.status));
const r = await fetch('https://api.xero.com/api.xro/2.0/Organisation', {
  headers: {
    Authorization: `Bearer ${data.accessToken}`,
    'Xero-tenant-id': data.tenantId,
    Accept: 'application/json',
  },
});
```

## 7. 같은 Node(1001server) 안의 다른 코드라면

별도 HTTP 없이 `1001server/utils/xero.js`에서 **`getAccessToken(entityName)`** 과 **`getTenantIdForEntity(entityName)`** 만 쓰면 됩니다. 내부 HTTP API는 **다른 프로세스**가 붙을 때만 필요합니다.

## 요약

다른 미들웨어는 `GET {1001server}/api/internal/xero/access-token?entity=...` + **`Authorization: Bearer` 또는 `x-api-key`로 `XERO_INTERNAL_API_KEY`**를 보내고, 응답의 **`accessToken` + `tenantId`**로 Xero를 호출하면 됩니다.

## `scripts/test-hoya-gmail.js run` (로컬)

`npm run start`로 1001server가 떠 있고, 그 프로세스가 refresh(DB/.env)를 갖고 있으면 **스크립트 쪽 `.env`에 refresh를 넣지 않아도** 됩니다.

다음을 설정합니다 (예: 포트는 `index.js` 기본 `8080`).

```env
XERO_INTERNAL_TOKEN_BASE_URL=http://localhost:8080
# 또는 SERVER_BASE_URL=http://localhost:8080
XERO_INTERNAL_API_KEY=<서버와 동일한 값>
```

이때 `1001server/utils/xero.js`의 `getAccessToken()`은 내부 HTTP로 access만 받고, **`XERO_RT_OPTICAL` 등은 생략 가능**합니다. 테넌트 ID도 응답의 `tenantId`를 캐시해 사용합니다.

**주의:** `XERO_INTERNAL_TOKEN_BASE_URL`은 **서버 프로세스의 `.env`에는 넣지 않는 것**을 권장합니다(서버는 이미 DB로 refresh). 스크립트·워커 전용입니다.
