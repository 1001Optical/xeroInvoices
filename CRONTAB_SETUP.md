# EC2 Crontab 설정 가이드

이 문서는 EC2 인스턴스에서 Xero Invoices 스크립트를 매일 저녁에 자동 실행하도록 설정하는 방법을 설명합니다.

## 1. 스크립트에 실행 권한 부여

EC2 인스턴스에 접속한 후, 프로젝트 디렉토리로 이동하여 스크립트에 실행 권한을 부여합니다:

```bash
cd /path/to/xeroInvoices
chmod +x run-daily.sh
```

## 2. 스크립트 경로 확인

`run-daily.sh` 파일의 절대 경로를 확인합니다:

```bash
pwd
# 출력 예: /home/ec2-user/xeroInvoices
```

## 3. 로그 디렉토리 생성

로그 파일을 저장할 디렉토리를 생성합니다 (스크립트 내부에서 자동 생성되지만, 미리 생성해도 됩니다):

```bash
mkdir -p logs
```

## 4. Crontab 편집

crontab을 편집합니다:

```bash
crontab -e
```

만약 처음 사용하는 경우, 에디터를 선택하라는 메시지가 나올 수 있습니다. `nano`를 추천합니다.

## 5. Crontab 항목 추가

crontab 파일에 다음 줄을 추가합니다:

```bash
# 매일 저녁 6시 (18:00)에 실행
0 18 * * * /home/ec2-user/xeroInvoices/run-daily.sh >> /home/ec2-user/xeroInvoices/logs/cron.log 2>&1
```

**설명:**
- `0 18 * * *`: 매일 18시 0분에 실행
- `/home/ec2-user/xeroInvoices/run-daily.sh`: 실행할 스크립트의 절대 경로 (실제 경로로 변경)
- `>> /home/ec2-user/xeroInvoices/logs/cron.log 2>&1`: 로그 파일에 출력 저장 (표준 출력과 에러 모두)

**시간 조정 예시:**
- 매일 저녁 7시: `0 19 * * *`
- 매일 저녁 8시: `0 20 * * *`
- 매일 밤 10시: `0 22 * * *`

## 6. Crontab 저장 및 종료

- `nano` 에디터 사용 시: `Ctrl + O` (저장), `Enter` (확인), `Ctrl + X` (종료)
- `vi` 에디터 사용 시: `Esc`, `:wq`, `Enter`

## 7. Crontab 확인

등록된 crontab 항목을 확인합니다:

```bash
crontab -l
```

## 8. Cron 서비스 상태 확인

Cron 서비스가 실행 중인지 확인합니다:

```bash
# Amazon Linux 2, CentOS, RHEL
sudo systemctl status crond

# Ubuntu, Debian
sudo systemctl status cron
```

서비스가 실행되지 않은 경우 시작합니다:

```bash
# Amazon Linux 2, CentOS, RHEL
sudo systemctl start crond
sudo systemctl enable crond

# Ubuntu, Debian
sudo systemctl start cron
sudo systemctl enable cron
```

## 9. 테스트 실행

스크립트가 제대로 작동하는지 수동으로 테스트합니다:

```bash
cd /home/ec2-user/xeroInvoices
./run-daily.sh
```

로그를 확인합니다:

```bash
tail -f logs/daily.log
```

## 10. 로그 모니터링

실행 로그는 다음 위치에서 확인할 수 있습니다:

- `logs/daily.log`: 스크립트 실행 로그
- `logs/cron.log`: crontab 실행 로그 (crontab 설정에 따라)

로그 확인 명령어:

```bash
# 최근 50줄 확인
tail -n 50 logs/daily.log

# 실시간 로그 확인
tail -f logs/daily.log

# 에러만 확인
grep -i error logs/daily.log
```

## 11. 문제 해결

### 스크립트가 실행되지 않는 경우

1. **경로 확인**: 절대 경로가 정확한지 확인
   ```bash
   which node
   which npm
   ```

2. **환경 변수 확인**: `.env` 파일이 올바른 위치에 있는지 확인
   ```bash
   ls -la .env
   ```

3. **Node.js 경로 문제**: nvm을 사용하는 경우, `run-daily.sh`에서 Node.js 경로를 명시적으로 지정
   ```bash
   # run-daily.sh에서 수정
   /home/ec2-user/.nvm/versions/node/v18.17.0/bin/node index.js
   ```

4. **권한 확인**: 스크립트에 실행 권한이 있는지 확인
   ```bash
   ls -l run-daily.sh
   # 출력에 -rwxr-xr-x가 있어야 함 (x가 실행 권한)
   ```

5. **Crontab 로그 확인**: 시스템 로그에서 cron 실행 여부 확인
   ```bash
   # Amazon Linux 2, CentOS, RHEL
   sudo tail -f /var/log/cron
   
   # Ubuntu, Debian
   sudo tail -f /var/log/syslog | grep CRON
   ```

### 환경 변수가 로드되지 않는 경우

`.env` 파일의 경로를 `run-daily.sh`에서 절대 경로로 지정:

```bash
# run-daily.sh 수정
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(cat "$SCRIPT_DIR/.env" | grep -v '^#' | xargs)
fi
```

## 12. Crontab 제거

등록된 crontab을 제거하려면:

```bash
crontab -r
```

특정 항목만 제거하려면 `crontab -e`로 편집합니다.

## 참고사항

- **시간대**: EC2 인스턴스의 시간대가 올바른지 확인하세요. UTC 기준으로 설정되어 있을 수 있습니다.
- **디스크 공간**: 로그 파일이 계속 쌓이므로 주기적으로 정리하거나 로그 로테이션을 설정하세요.
- **알림 설정**: 실패 시 이메일 알림 등을 설정하려면 crontab에 `MAILTO` 환경 변수를 추가하세요:
  ```bash
  MAILTO=your-email@example.com
  0 18 * * * /path/to/run-daily.sh
  ```

## 예시: 완전한 Crontab 설정

```bash
# 환경 변수 설정
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=admin@example.com

# Xero Invoices 일일 처리 (매일 저녁 6시)
0 18 * * * /home/ec2-user/xeroInvoices/run-daily.sh >> /home/ec2-user/xeroInvoices/logs/cron.log 2>&1
```

