#!/bin/bash

# nvm 로드
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# 프로젝트 폴더 이동
cd /home/ubuntu/xeroInvoices || exit 1

# 시작 로그
echo "[$(date)] 🚀 Starting Xero daily job"

# 실제 작업 실행 (index.js)
node index.js

# 종료 로그
echo "[$(date)] ✅ Finished Xero daily job with exit code $?"

