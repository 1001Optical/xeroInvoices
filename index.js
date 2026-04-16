/**
 * Xero identity(connect/token) 직접 호출은 1001server/utils/xero.js 에만 있습니다.
 * 다른 프로세스는 GET /api/internal/xero/access-token (XERO_INTERNAL_API_KEY 또는 BACKEND_API_TOKEN) 을 사용하세요.
 */
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { CLEARING_ACCOUNT_CODES } from './constants.js';
import {
  initXeroTokenService,
  initXeroTokenServiceEnvOnly,
  ensureXeroTokensReady
} from './1001server/utils/xero.js';
import { registerInternalXeroBeforeApiGuard } from './1001server/server.js';
import { gmailPubSubRouter } from './1001server/routes/gmailPubSub.js';
import { rootEndpointsDocumentation } from './1001server/routes/index.js';

// 환경 변수 로드 (PM2 등 cwd가 달라도 index.js 기준으로 .env 로드)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();

// JSON 파싱 미들웨어
app.use(express.json());

/** MYSQL_USER 미설정이면 풀을 만들지 않음 — Xero는 ENTITY_CONFIG 의 XERO_RT_* 환경 변수만 사용 */
const useMysql = Boolean(String(process.env.MYSQL_USER || '').trim());

/** @type {import('mysql2/promise').Pool | null} */
const db = useMysql
  ? mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT || '3307', 10),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    })
  : null;

if (useMysql && db) {
  initXeroTokenService(db);
} else {
  initXeroTokenServiceEnvOnly();
  console.log(
    '[xero] MYSQL_USER 없음 → xero_tokens DB 미사용, refresh token 은 .env 의 XERO_RT_* 만 사용'
  );
}

const internalXeroAuthKey =
  process.env.XERO_INTERNAL_API_KEY?.trim() ||
  process.env.BACKEND_API_TOKEN?.trim();
if (!internalXeroAuthKey) {
  console.warn(
    '[xero] XERO_INTERNAL_API_KEY / BACKEND_API_TOKEN 없음 → GET /api/internal/xero/access-token 는 의도적으로 HTTP 503 (이 서버 .env 에 키를 넣어야 함)'
  );
}

app.use('/webhooks/gmail', gmailPubSubRouter);
registerInternalXeroBeforeApiGuard(app);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    endpoints: rootEndpointsDocumentation
  });
});

/**
 * xero_tokens 테이블 생성 (없으면 자동 생성)
 */
async function ensureTableExists() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS xero_tokens (
        id INT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (error) {
    console.error('테이블 생성 실패:', error.message);
    throw error;
  }
}

/**
 * xero_clearing_lines 테이블 생성 (없으면 자동 생성)
 * Xero Journal에서 동기화한 Clearing 라인 저장
 */
async function ensureClearingTableExists() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS xero_clearing_lines (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        journal_id CHAR(36) NOT NULL,
        line_number INT NOT NULL,
        journal_number INT NULL,
        date DATE NOT NULL,
        account_code VARCHAR(10) NOT NULL,
        source_type VARCHAR(50) NULL,
        description VARCHAR(255) NULL,
        reference VARCHAR(255) NULL,
        debit DECIMAL(12,2) NOT NULL,
        credit DECIMAL(12,2) NOT NULL,
        signed_amount DECIMAL(12,2) NOT NULL,
        origin ENUM('MJ','BANK','OTHER') NULL,
        settled TINYINT(1) DEFAULT 0,
        settled_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_line (journal_id, line_number, account_code)
      )
    `);
  } catch (error) {
    console.error('xero_clearing_lines 테이블 생성 실패:', error.message);
    throw error;
  }
}

void (async () => {
  try {
    await ensureTableExists();
    await ensureClearingTableExists();
    await ensureXeroTokensReady();
  } catch (e) {
    console.error('기동 시 DB 준비 실패:', e.message);
  }
})();

/**
 * GET /api/clearing - Clearing 계정 라인 조회 API
 * 특정 Clearing 계정 + 날짜 범위에 대해 날짜별로 그룹핑하여 반환
 * 
 * 쿼리 파라미터:
 * - accountCode (필수): Clearing 계정 코드 (예: '18000')
 * - from (필수): 시작 날짜 (YYYY-MM-DD 형식)
 * - to (필수): 종료 날짜 (YYYY-MM-DD 형식)
 * - includeSettled (선택): true이면 settled=1도 포함, 기본값 false
 */
app.get('/api/clearing', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        error: 'MySQL 이 구성되지 않았습니다. Clearing API 는 MYSQL_USER 등을 설정해야 합니다.'
      });
    }
    // 쿼리 파라미터 추출
    const { accountCode, from, to, includeSettled } = req.query;
    
    // 필수 파라미터 검증
    if (!accountCode || !from || !to) {
      return res.status(400).json({
        error: '필수 파라미터가 누락되었습니다.',
        required: ['accountCode', 'from', 'to']
      });
    }
    
    // 날짜 형식 검증
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || !dateRegex.test(to)) {
      return res.status(400).json({
        error: '날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식을 사용하세요.'
      });
    }
    
    // includeSettled 파라미터 처리 (기본값 false)
    const includeSettledFlag = includeSettled === 'true' || includeSettled === true;
    
    // Clearing 계정 코드 검증
    if (!CLEARING_ACCOUNT_CODES.includes(accountCode)) {
      return res.status(400).json({
        error: '유효하지 않은 Clearing 계정 코드입니다.',
        validCodes: CLEARING_ACCOUNT_CODES
      });
    }
    
    // MySQL 쿼리 구성
    let query = `
      SELECT 
        id,
        journal_id,
        line_number,
        journal_number,
        date,
        account_code,
        source_type,
        description,
        reference,
        debit,
        credit,
        signed_amount,
        origin,
        settled
      FROM xero_clearing_lines
      WHERE account_code = ?
        AND date BETWEEN ? AND ?
    `;
    
    const queryParams = [accountCode, from, to];
    
    // includeSettled가 false이면 settled=0만 조회
    if (!includeSettledFlag) {
      query += ' AND settled = 0';
    }
    
    query += ' ORDER BY date ASC, id ASC';
    
    // 데이터 조회
    const [rows] = await db.query(query, queryParams);
    
    // 날짜별로 그룹핑
    const groupsMap = new Map();
    
    for (const row of rows) {
      const date = row.date.toISOString().split('T')[0]; // YYYY-MM-DD 형식
      
      if (!groupsMap.has(date)) {
        groupsMap.set(date, {
          date,
          totalDebit: 0,
          totalCredit: 0,
          net: 0,
          settled: 0,
          lines: []
        });
      }
      
      const group = groupsMap.get(date);
      
      // 합계 계산
      group.totalDebit += Number(row.debit || 0);
      group.totalCredit += Number(row.credit || 0);
      group.net += Number(row.signed_amount || 0);
      
      // settled는 그룹 내 라인 중 하나라도 settled=1이면 1
      if (row.settled === 1) {
        group.settled = 1;
      }
      
      // 라인 정보 추가
      group.lines.push({
        id: row.id,
        journalId: row.journal_id,
        journalNumber: row.journal_number,
        sourceType: row.source_type,
        origin: row.origin,
        description: row.description,
        reference: row.reference,
        debit: Number(row.debit || 0),
        credit: Number(row.credit || 0),
        signedAmount: Number(row.signed_amount || 0)
      });
    }
    
    // Map을 배열로 변환하고 autoBalanced 계산
    const groups = Array.from(groupsMap.values()).map(group => {
      // autoBalanced: net이 0에 가까우면 true (부동소수점 오차 허용)
      const autoBalanced = Math.abs(group.net) < 0.01;
      
      return {
        ...group,
        autoBalanced,
        // 숫자 정밀도 보정 (소수점 2자리)
        totalDebit: Math.round(group.totalDebit * 100) / 100,
        totalCredit: Math.round(group.totalCredit * 100) / 100,
        net: Math.round(group.net * 100) / 100
      };
    });
    
    // 응답 반환
    res.json({
      accountCode,
      from,
      to,
      groups
    });
    
  } catch (error) {
    console.error('Clearing 조회 API 오류:', error.message);
    res.status(500).json({
      error: '서버 오류가 발생했습니다.',
      message: error.message
    });
  }
});

/**
 * POST /api/clearing/settle - Clearing 계정 라인의 정산 상태 업데이트 API
 * 특정 Clearing 계정 + 날짜 그룹의 settled 상태를 업데이트
 * 
 * 요청 바디:
 * - accountCode (필수): Clearing 계정 코드 (예: '18000')
 * - date (필수): 날짜 (YYYY-MM-DD 형식)
 * - settled (필수): 정산 상태 (true = 정산 완료, false = 미정산)
 */
app.post('/api/clearing/settle', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        error: 'MySQL 이 구성되지 않았습니다. Clearing API 는 MYSQL_USER 등을 설정해야 합니다.'
      });
    }
    const { accountCode, date, settled } = req.body;
    
    // 필수 파라미터 검증
    if (!accountCode || !date || settled === undefined) {
      return res.status(400).json({
        error: '필수 파라미터가 누락되었습니다.',
        required: ['accountCode', 'date', 'settled']
      });
    }
    
    // 날짜 형식 검증
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        error: '날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식을 사용하세요.'
      });
    }
    
    // settled 값 검증 (boolean 또는 'true'/'false' 문자열)
    const settledValue = settled === true || settled === 'true' ? 1 : 0;
    
    // Clearing 계정 코드 검증
    if (!CLEARING_ACCOUNT_CODES.includes(accountCode)) {
      return res.status(400).json({
        error: '유효하지 않은 Clearing 계정 코드입니다.',
        validCodes: CLEARING_ACCOUNT_CODES
      });
    }
    
    // MySQL UPDATE 쿼리 실행
    // settled = 1이면 settled_at = NOW(), settled = 0이면 settled_at = NULL
    const [result] = await db.query(`
      UPDATE xero_clearing_lines
      SET settled = ?, settled_at = (CASE WHEN ? = 1 THEN NOW() ELSE NULL END)
      WHERE account_code = ? AND date = ?
    `, [settledValue, settledValue, accountCode, date]);
    
    // 업데이트된 행 수 확인
    const affectedRows = result.affectedRows;
    
    if (affectedRows === 0) {
      return res.status(404).json({
        error: '해당 조건의 데이터를 찾을 수 없습니다.',
        accountCode,
        date
      });
    }
    
    // 성공 응답
    res.json({
      success: true,
      accountCode,
      date,
      settled: settledValue === 1,
      affectedRows
    });
    
  } catch (error) {
    console.error('Clearing 정산 상태 업데이트 API 오류:', error.message);
    res.status(500).json({
      error: '서버 오류가 발생했습니다.',
      message: error.message
    });
  }
});

const httpPort = Number(process.env.PORT || 8080);
app.listen(httpPort, '0.0.0.0', () => {
  console.log(
    `HTTP 서버: ${httpPort} (Gmail Pub/Sub POST /webhooks/gmail/pubsub, GET /webhooks/gmail/health)`
  );
});

export default app;
