# Xero Invoices 자동화 스크립트

Optomate API에서 일일 거래 데이터(Invoice, Receipt)를 가져와 Xero API에 Manual Journal로 자동 생성하는 스크립트입니다.

## 주요 기능

- ✅ **자동 날짜 처리**: 항상 당일(오늘) 날짜로 처리
- ✅ **모든 스토어 처리**: 16개 스토어의 일일 거래 데이터 자동 수집
- ✅ **동시성 제어**: Receipt와 Invoice API 호출에 concurrency=2 적용
- ✅ **자동 실행**: EC2 crontab을 통한 매일 저녁 자동 실행 지원

## 설치 및 설정

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env` 파일을 생성하고 다음 환경 변수를 설정하세요:

```env
# Xero API 설정
XERO_CLIENT_ID=your_client_id
XERO_CLIENT_SECRET=your_client_secret
XERO_TENANT_ID=your_tenant_id

# MySQL 설정
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307
MYSQL_USER=your_user
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=your_database

# Optomate API 설정
OPTOMATE_API_BASE=https://your-optomate-api.com
OPTOMATE_USERNAME=your_username
OPTOMATE_PASSWORD=your_password
```

### 3. Xero Refresh Token 초기화

```bash
npm run init
```

## 사용법

### 모든 스토어 처리 (당일 날짜)

```bash
node index.js
```

### 특정 스토어만 처리 (테스트용)

```bash
node index.js PA1
```

## EC2 Crontab 설정

매일 저녁에 자동으로 실행되도록 설정하려면 `CRONTAB_SETUP.md` 파일을 참고하세요.

간단한 설정 방법:

1. 스크립트에 실행 권한 부여:
```bash
chmod +x run-daily.sh
```

2. Crontab 편집:
```bash
crontab -e
```

3. 다음 줄 추가 (매일 저녁 6시 실행):
```bash
0 18 * * * /path/to/xeroInvoices/run-daily.sh >> /path/to/xeroInvoices/logs/cron.log 2>&1
```

자세한 내용은 `CRONTAB_SETUP.md` 파일을 참고하세요.

## 변경 이력

### 2025-01-XX
- ✅ 날짜를 항상 당일(오늘)로 자동 설정 (하드코딩 제거)
- ✅ Receipt와 Invoice API 호출에 concurrency=2 적용
- ✅ EC2 crontab용 실행 스크립트 추가 (`run-daily.sh`)
- ✅ Crontab 설정 가이드 문서 추가 (`CRONTAB_SETUP.md`)

## 프로젝트 구조

```
xeroInvoices/
├── index.js              # 메인 스크립트
├── constants.js          # 상수 정의 (스토어, 계정 코드 등)
├── init-token.js         # Xero Refresh Token 초기화 스크립트
├── run-daily.sh          # EC2 crontab용 실행 스크립트
├── CRONTAB_SETUP.md      # Crontab 설정 가이드
├── package.json          # 프로젝트 설정 및 의존성
└── .env                  # 환경 변수 (git에 커밋하지 않음)
```

## 로그

실행 로그는 `logs/` 디렉토리에 저장됩니다:
- `logs/daily.log`: 스크립트 실행 로그
- `logs/cron.log`: crontab 실행 로그

## 문제 해결

자세한 문제 해결 방법은 `CRONTAB_SETUP.md`의 "문제 해결" 섹션을 참고하세요.
