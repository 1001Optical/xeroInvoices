#!/bin/bash

# Xero Invoices 일일 실행 스크립트
# EC2에서 crontab으로 매일 저녁에 실행되도록 설정
# 
# 사용법:
# 1. 이 스크립트에 실행 권한 부여: chmod +x run-daily.sh
# 2. crontab에 등록: crontab -e
#    예: 0 18 * * * /path/to/xeroInvoices/run-daily.sh >> /path/to/xeroInvoices/logs/daily.log 2>&1

# 프로젝트 디렉토리 경로 설정 (실제 경로로 변경 필요)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 환경 변수 로드 (필요시 .env 파일 경로 지정)
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Node.js 경로 확인 (nvm을 사용하는 경우)
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use node  # 또는 특정 버전: nvm use 18
fi

# 로그 디렉토리 생성
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

# 실행 날짜 기록
DATE=$(date +"%Y-%m-%d %H:%M:%S")
echo "=========================================" >> "$LOG_DIR/daily.log"
echo "[$DATE] 일일 Xero Invoices 처리 시작" >> "$LOG_DIR/daily.log"
echo "=========================================" >> "$LOG_DIR/daily.log"

# 스크립트 실행
node index.js >> "$LOG_DIR/daily.log" 2>&1

# 실행 결과 확인
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo "[$(date +"%Y-%m-%d %H:%M:%S")] 처리 완료 (성공)" >> "$LOG_DIR/daily.log"
else
  echo "[$(date +"%Y-%m-%d %H:%M:%S")] 처리 실패 (종료 코드: $EXIT_CODE)" >> "$LOG_DIR/daily.log"
fi

echo "" >> "$LOG_DIR/daily.log"

exit $EXIT_CODE

