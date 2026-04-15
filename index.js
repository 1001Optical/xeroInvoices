/**
 * Xero identity(connect/token) 직접 호출은 1001server/utils/xero.js 에만 있습니다.
 * 다른 프로세스는 GET /api/internal/xero/access-token (XERO_INTERNAL_API_KEY) 을 사용하세요.
 */
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import mysql from 'mysql2/promise';
import pLimit from 'p-limit';
import { BRANCHES, STOCK_TYPES, CLEARING_ACCOUNT_CODE, PAYMENT_TYPES, CLEARING_ACCOUNT_CODES } from './constants.js';
import {
  initXeroTokenService,
  getAccessToken,
  getStoredRefreshTokenForEntity,
  ensureXeroTokensReady,
  DEFAULT_ENTITY,
  getTenantIdForEntity
} from './1001server/utils/xero.js';
import { registerInternalXeroBeforeApiGuard } from './1001server/server.js';
import { gmailPubSubRouter } from './1001server/routes/gmailPubSub.js';
import { rootEndpointsDocumentation } from './1001server/routes/index.js';

// 환경 변수 로드
dotenv.config();

const app = express();

// JSON 파싱 미들웨어
app.use(express.json());

const db = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3307'),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

initXeroTokenService(db);
app.use('/webhooks/gmail', gmailPubSubRouter);
registerInternalXeroBeforeApiGuard(app);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    endpoints: rootEndpointsDocumentation
  });
});

// # 모든 브랜치 처리 (날짜는 항상 당일)
// node index.js

// # 특정 브랜치만 처리 (날짜는 항상 당일)
// node index.js PA1


/**
 * xero_tokens 테이블 생성 (없으면 자동 생성)
 */
async function ensureTableExists() {
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
 * Manual Journal 라인과 Bank/Receive Money 라인을 저장하는 테이블
 */
async function ensureClearingTableExists() {
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

/**
 * Xero API 연결 테스트 (Tenant 정보 확인)
 * @param {string} accessToken - Access Token
 * @param {string} entityName - ENTITY_CONFIG 법인명
 * @returns {Promise<Object>} Tenant 정보
 */
async function testConnection(accessToken, entityName) {
  const tenantId = getTenantIdForEntity(entityName);
  try {
    const apiUrl = 'https://api.xero.com/api.xro/2.0/Organisation';

    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('❌ 연결 테스트 실패:');
    console.error('상태 코드:', error.response?.status);
    console.error('에러 응답:', JSON.stringify(error.response?.data, null, 2));

    if (error.response?.status === 401) {
      console.error('\n⚠️  401 에러 - 인증 실패!');
      console.error('가능한 원인:');
      console.error('1. Access Token이 유효하지 않음');
      console.error('2. Tenant ID가 잘못됨 (법인:', entityName, ', tenantId:', tenantId, ')');
      console.error('3. Refresh Token을 다시 발급받아야 함');
    }
    throw error;
  }
}

/**
 * Optomate API 인증 및 PatientReceipts 데이터 가져오기
 * @param {string} branchIdentifier - 브랜치 식별자 (예: 'PA1')
 * @param {string} startDate - 시작 날짜 (ISO 8601 형식)
 * @param {string} endDate - 종료 날짜 (ISO 8601 형식)
 * @returns {Promise<Array>} PatientReceipts 배열
 */
async function fetchOptomateReceipts(branchIdentifier, startDate, endDate) {
  try {
    const baseUrl = process.env.OPTOMATE_API_BASE;
    const username = process.env.OPTOMATE_USERNAME;
    const password = process.env.OPTOMATE_PASSWORD;

    if (!baseUrl || !username || !password) {
      throw new Error('Optomate API 환경 변수가 설정되지 않았습니다.');
    }

    // OData 필터 구성
    const filter = `BRANCH_IDENTIFIER eq '${branchIdentifier}' and RECEIPT_DATE ge ${startDate} and RECEIPT_DATE le ${endDate}`;
    const url = `${baseUrl}/PatientReceipts?$expand=RECEIPT_ITEMS&$filter=${encodeURIComponent(filter)}`;

    // Basic 인증
    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    return response.data.value || [];
  } catch (error) {
    console.error('Optomate Receipts API 호출 실패:', error.message);
    if (error.response) {
      console.error('상태 코드:', error.response.status);
      console.error('에러 응답:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

/**
 * Optomate API 인증 및 PatientInvoices 데이터 가져오기
 * @param {string} branchIdentifier - 브랜치 식별자 (예: 'PA1')
 * @param {string} startDate - 시작 날짜 (ISO 8601 형식, 예: '2025-10-31T10:00:00Z')
 * @param {string} endDate - 종료 날짜 (ISO 8601 형식, 예: '2025-11-01T10:00:00Z')
 * @returns {Promise<Array>} PatientInvoices 배열
 */
async function fetchOptomateInvoices(branchIdentifier, startDate, endDate) {
  try {
    const baseUrl = process.env.OPTOMATE_API_BASE;
    const username = process.env.OPTOMATE_USERNAME;
    const password = process.env.OPTOMATE_PASSWORD;

    if (!baseUrl || !username || !password) {
      throw new Error('Optomate API 환경 변수가 설정되지 않았습니다.');
    }

    // OData 필터 구성 (날짜는 따옴표 없이 사용)
    const filter = `BRANCH_IDENTIFIER eq '${branchIdentifier}' and SALE_DATE ge ${startDate} and SALE_DATE le ${endDate}`;
    const url = `${baseUrl}/PatientInvoices?$expand=ITEMS&$filter=${encodeURIComponent(filter)}`;

    // Basic 인증
    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    return response.data.value || [];
  } catch (error) {
    console.error('Optomate API 호출 실패:', error.message);
    if (error.response) {
      console.error('상태 코드:', error.response.status);
      console.error('에러 응답:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

/**
 * 브랜치별, 날짜별로 Invoice items 그룹화 및 계산
 * @param {Array} invoices - PatientInvoices 배열
 * @param {string} branchIdentifier - 브랜치 식별자
 * @returns {Object} STOCK_TYPE_ID별 netAmount 맵
 */
function calculateStockTypeAmounts(invoices, branchIdentifier) {
  const stockTypeMap = {};

  invoices.forEach(invoice => {
    // ITEMS 필드명 확인 (대문자)
    const items = invoice.ITEMS || invoice.Items || invoice.items || [];
    
    if (!items || !Array.isArray(items)) {
      return;
    }

    items.forEach(item => {
      // STOCK_TYPE_ID 확인
      const stockTypeId = item.STOCK_TYPE_ID || item.StockTypeId || item.stock_type_id;
      if (!stockTypeId) {
        return;
      }

      // 금액 계산
      const total = parseFloat(item.TOTAL || item.Total || item.total || 0);
      const gstAmount = parseFloat(item.GST_AMOUNT || item.GstAmount || item.gst_amount || 0);
      
      if (isNaN(total) && isNaN(gstAmount)) {
        return;
      }
      
      if (!stockTypeMap[stockTypeId]) {
        stockTypeMap[stockTypeId] = {
          totalPositive: 0,
          totalNegative: 0,
          gstPositive: 0,
          gstNegative: 0
        };
      }

      // TOTAL 계산 (양수/음수 분리)
      if (total > 0) {
        stockTypeMap[stockTypeId].totalPositive += total;
      } else if (total < 0) {
        stockTypeMap[stockTypeId].totalNegative += Math.abs(total);
      }

      // GST_AMOUNT 계산 (양수/음수 분리)
      if (gstAmount > 0) {
        stockTypeMap[stockTypeId].gstPositive += gstAmount;
      } else if (gstAmount < 0) {
        stockTypeMap[stockTypeId].gstNegative += Math.abs(gstAmount);
      }
    });
  });

  // netAmount 계산 (STOCK_TYPE_ID별)
  const result = {};
  Object.keys(stockTypeMap).forEach(stockTypeId => {
    const { totalPositive, totalNegative, gstPositive, gstNegative } = stockTypeMap[stockTypeId];
    
    const netTotal = totalPositive - totalNegative;
    const netGst = gstPositive - gstNegative;
    
    // netTotal 또는 netGst가 0이 아닌 경우만 포함
    if (Math.abs(netTotal) > 0.01 || Math.abs(netGst) > 0.01) {
      result[stockTypeId] = {
        netTotal: netTotal,
        netGst: netGst
      };
    }
  });

  return result;
}

/**
 * 브랜치 코드로 이름 찾기
 * @param {string} branchCode - 브랜치 코드 (예: 'PA1')
 * @returns {string} 브랜치 이름 (예: 'Parramatta')
 */
function getBranchName(branchCode) {
  const branch = BRANCHES.find(b => b.code === branchCode);
  return branch ? branch.name : branchCode;
}

/**
 * 
 * STOCK_TYPE_ID로 STOCK_TYPES 정보 찾기
 * @param {number} stockTypeId - STOCK_TYPE_ID
 * @returns {Object|null} STOCK_TYPES 정보
 */
function getStockTypeInfo(stockTypeId) {
  return STOCK_TYPES.find(st => st.id === stockTypeId) || null;
}

/**
 * PAYMENT_TYPE_CODE로 PAYMENT_TYPES 정보 찾기
 * @param {string} paymentTypeCode - PAYMENT_TYPE_CODE
 * @returns {Object|null} PAYMENT_TYPES 정보
 */
function getPaymentTypeInfo(paymentTypeCode) {
  return PAYMENT_TYPES.find(pt => pt.code === paymentTypeCode) || null;
}

/**
 * PatientReceipts에서 PAYMENT_TYPE_CODE별 금액 계산
 * @param {Array} receipts - PatientReceipts 배열
 * @returns {Object} PAYMENT_TYPE_CODE별 netAmount 맵
 */
function calculatePaymentTypeAmounts(receipts) {
  const paymentTypeMap = {};

  receipts.forEach(receipt => {
    const items = receipt.RECEIPT_ITEMS || receipt.ReceiptItems || receipt.receipt_items || [];
    
    if (!items || !Array.isArray(items)) {
      return;
    }

    items.forEach(item => {
      const paymentTypeCode = item.PAYMENT_TYPE_CODE || item.PaymentTypeCode || item.payment_type_code;
      if (!paymentTypeCode) {
        return;
      }

      const amount = parseFloat(item.AMOUNT || item.Amount || item.amount || 0);
      
      if (isNaN(amount)) {
        return;
      }

      if (!paymentTypeMap[paymentTypeCode]) {
        paymentTypeMap[paymentTypeCode] = {
          positiveSum: 0,
          negativeSum: 0
        };
      }

      if (amount > 0) {
        paymentTypeMap[paymentTypeCode].positiveSum += amount;
      } else {
        paymentTypeMap[paymentTypeCode].negativeSum += Math.abs(amount);
      }
    });
  });

  // netAmount 계산
  const result = {};
  Object.keys(paymentTypeMap).forEach(paymentTypeCode => {
    const { positiveSum, negativeSum } = paymentTypeMap[paymentTypeCode];
    const netAmount = positiveSum - negativeSum;
    
    if (Math.abs(netAmount) > 0.01) {
      result[paymentTypeCode] = netAmount;
    }
  });

  return result;
}

/**
 * PatientReceipts에서 JournalLines 생성
 * @param {Array} receipts - PatientReceipts 배열
 * @param {string} branchName - 브랜치 이름
 * @returns {Array} JournalLines 배열
 */
function buildReceiptJournalLines(receipts, branchName) {
  const journalLines = [];
  const paymentTypeAmounts = calculatePaymentTypeAmounts(receipts);
  
  if (Object.keys(paymentTypeAmounts).length === 0) {
    return journalLines;
  }

  let totalPaymentAmount = 0;

  // PAYMENT_TYPE_CODE별로 정렬
  const sortedPaymentCodes = Object.keys(paymentTypeAmounts).sort();

  sortedPaymentCodes.forEach(paymentTypeCode => {
    const netAmount = paymentTypeAmounts[paymentTypeCode];
    
    const paymentTypeInfo = getPaymentTypeInfo(paymentTypeCode);
    if (!paymentTypeInfo) {
      console.warn(`⚠️  PAYMENT_TYPE_CODE '${paymentTypeCode}'에 대한 정보를 찾을 수 없습니다.`);
      return;
    }

    // Payment Type 라인 (양수 - Debit)
    if (Math.abs(netAmount) > 0.01) {
      journalLines.push({
        Description: paymentTypeInfo.description,
        LineAmount: Math.abs(netAmount), // 양수 (Debit)
        AccountCode: paymentTypeInfo.accountCode,
        TaxType: "NONE",
        Tracking: [
          {
            Name: "Store",
            Option: branchName
          }
        ]
      });
      
      totalPaymentAmount += Math.abs(netAmount);
    }
  });

  // POS Clearing 라인: 모든 Payment Type 합계 (음수 - Credit)
  if (Math.abs(totalPaymentAmount) > 0.01) {
    journalLines.push({
      Description: "POS Clearing",
      LineAmount: -Math.abs(totalPaymentAmount), // 음수 (Credit)
      AccountCode: CLEARING_ACCOUNT_CODE,
      TaxType: "NONE",
      Tracking: [
        {
          Name: "Store",
          Option: branchName
        }
      ]
    });
  }

  return journalLines;
}

/**
 * Manual Journal JournalLines 생성
 * @param {Object} stockTypeAmounts - STOCK_TYPE_ID별 {netTotal, netGst} 맵
 * @param {string} branchName - 브랜치 이름
 * @returns {Array} JournalLines 배열
 */
function buildJournalLines(stockTypeAmounts, branchName) {
  const journalLines = [];
  let totalGstOnIncome = 0;  // 모든 STOCK_TYPE_ID의 GST ON INCOME 합계
  let totalGstFreeIncome = 0; // 모든 STOCK_TYPE_ID의 GST FREE INCOME 합계

  // STOCK_TYPE_ID별로 정렬 (1, 2, 3... 순서)
  const sortedStockTypeIds = Object.keys(stockTypeAmounts).sort((a, b) => parseInt(a) - parseInt(b));

  // 1단계: 모든 STOCK_TYPE_ID의 GST ON INCOME 라인들 먼저 생성
  sortedStockTypeIds.forEach(stockTypeId => {
    const { netTotal, netGst } = stockTypeAmounts[stockTypeId];
    
    const stockTypeInfo = getStockTypeInfo(parseInt(stockTypeId));
    if (!stockTypeInfo) {
      console.warn(`⚠️  STOCK_TYPE_ID ${stockTypeId}에 대한 정보를 찾을 수 없습니다.`);
      return;
    }

    // GST ON INCOME 계산: GST_AMOUNT * 11
    const gstOnIncome = netGst * 11;

    // GST ON INCOME 라인 (OUTPUT)
    if (Math.abs(gstOnIncome) > 0.01) {
      journalLines.push({
        Description: stockTypeInfo.description,
        LineAmount: Math.abs(gstOnIncome), // 양수 (Debit)
        AccountCode: stockTypeInfo.accountCode,
        TaxType: "OUTPUT",
        Tracking: [
          {
            Name: "Store",
            Option: branchName
          }
        ]
      });
      
      totalGstOnIncome += Math.abs(gstOnIncome);
    }
  });

  // 2단계: GST ON INCOME에 대한 POS Clearing
  if (Math.abs(totalGstOnIncome) > 0.01) {
    journalLines.push({
      Description: "POS Clearing",
      LineAmount: -Math.abs(totalGstOnIncome), // 음수 (Credit)
      AccountCode: CLEARING_ACCOUNT_CODE,
      TaxType: "NONE",
      Tracking: [
        {
          Name: "Store",
          Option: branchName
        }
      ]
    });
  }

  // 3단계: 모든 STOCK_TYPE_ID의 GST FREE INCOME 라인들 생성
  sortedStockTypeIds.forEach(stockTypeId => {
    const { netTotal, netGst } = stockTypeAmounts[stockTypeId];
    
    const stockTypeInfo = getStockTypeInfo(parseInt(stockTypeId));
    if (!stockTypeInfo) {
      return;
    }

    // GST ON INCOME 계산: GST_AMOUNT * 11
    const gstOnIncome = netGst * 11;
    
    // GST FREE INCOME 계산: TOTAL - (GST_AMOUNT * 11)
    const gstFreeIncome = netTotal - gstOnIncome;

    // GST FREE INCOME 라인 (EXEMPTOUTPUT)
    if (Math.abs(gstFreeIncome) > 0.01) {
      journalLines.push({
        Description: stockTypeInfo.description,
        LineAmount: Math.abs(gstFreeIncome), // 양수 (Debit)
        AccountCode: stockTypeInfo.accountCode,
        TaxType: "EXEMPTOUTPUT",
        Tracking: [
          {
            Name: "Store",
            Option: branchName
          }
        ]
      });
      
      totalGstFreeIncome += Math.abs(gstFreeIncome);
    }
  });

  // 4단계: GST FREE INCOME에 대한 POS Clearing
  if (Math.abs(totalGstFreeIncome) > 0.01) {
    journalLines.push({
      Description: "POS Clearing",
      LineAmount: -Math.abs(totalGstFreeIncome), // 음수 (Credit)
      AccountCode: CLEARING_ACCOUNT_CODE,
      TaxType: "NONE",
      Tracking: [
        {
          Name: "Store",
          Option: branchName
        }
      ]
    });
  }

  return journalLines;
}

/**
 * 날짜를 ISO 8601 형식으로 변환 (UTC 기준, +11:00 시간대 고려)
 * 현지 거래일 기준으로 UTC 시간 계산
 * 예: 2025-11-23 현지 거래일 = 2025-11-22T13:00:00Z ~ 2025-11-23T12:59:59Z (UTC)
 * @param {Date|string} date - 날짜
 * @param {number} hours - UTC 시간 (기본값: 13, 현지 00:00 = UTC 13:00 전날)
 * @returns {string} ISO 8601 형식 문자열
 */
function formatOptomateDate(date, hours = 13) {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  // +11:00 시간대 고려: 현지 00:00 = UTC 13:00 (전날)
  // 현지 거래일 시작: 전날 13:00 UTC
  // 현지 거래일 종료: 당일 12:59:59 UTC
  
  if (hours === 13) {
    // 시작 시간: 전날 13:00 UTC
    const prevDay = new Date(d);
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    const year = prevDay.getUTCFullYear();
    const month = String(prevDay.getUTCMonth() + 1).padStart(2, '0');
    const day = String(prevDay.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}T13:00:00Z`;
  } else {
    // 종료 시간: 당일 12:59:59 UTC
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}T12:59:59Z`;
  }
}

/**
 * Xero API에 Manual Journal을 생성하는 함수
 * @param {Object} manualJournalData - Manual Journal 데이터
 * @param {string} [entityName=DEFAULT_ENTITY] - ENTITY_CONFIG 키와 동일한 법인명
 * @returns {Promise<Object>} 생성된 Manual Journal 응답
 */
async function createManualJournal(manualJournalData, entityName = DEFAULT_ENTITY) {
  try {
    const tenantId = getTenantIdForEntity(entityName);
    if (!tenantId) {
      throw new Error(`법인 "${entityName}"에 대한 Tenant ID 환경 변수가 비어 있습니다.`);
    }

    const accessToken = await getAccessToken(entityName);

    await testConnection(accessToken, entityName);

    const apiUrl = 'https://api.xero.com/api.xro/2.0/ManualJournals';

    const requestBody = {
      ManualJournals: [manualJournalData]
    };

    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('\n❌ Manual Journal 생성 실패:');
    console.error('상태 코드:', error.response?.status);
    console.error('에러 응답:', JSON.stringify(error.response?.data, null, 2));
    console.error('에러 메시지:', error.message);

    if (error.response?.status === 401) {
      console.error('\n🔴 401 에러 - 인증 실패 원인:');
      console.error('1. Access Token이 유효하지 않거나 만료되었습니다');
      console.error('2. Tenant ID가 올바르지 않습니다 (법인:', entityName, ')');
      console.error('3. API 권한(scope)이 부족합니다 - accounting.transactions 권한 필요');
      console.error('4. Refresh Token이 만료되었을 수 있습니다');
      console.error('\n해결 방법:');
      console.error('- Xero 개발자 포털(https://developer.xero.com)에서 새로운 Refresh Token 발급');
      console.error('- 앱 권한(Scopes)에서 "accounting.transactions" 확인');
      console.error('- Tenant ID가 올바른지 확인');
    } else if (error.response?.status === 403) {
      console.error('\n🔴 403 에러 - 권한 부족:');
      console.error('Xero 앱에 Manual Journals 생성 권한이 없습니다');
      console.error('Xero 개발자 포털에서 스코프를 확인하세요');
    } else if (error.response?.status === 404) {
      console.error('\n🔴 404 에러 가능 원인:');
      console.error('1. API 엔드포인트 URL 확인 필요');
      console.error('2. Tenant ID가 올바른지 확인 필요');
    }
    
    throw error;
  }
}

/**
 * Xero Journals API에서 Clearing 계정 라인을 동기화하는 함수
 * 지정된 날짜 범위의 Journals를 가져와서 Clearing 계정 라인만 필터링하여 DB에 upsert
 * @param {string} fromDate - 시작 날짜 (YYYY-MM-DD 형식, 예: '2025-10-01')
 * @param {string} toDate - 종료 날짜 (YYYY-MM-DD 형식, 예: '2025-10-31')
 * @returns {Promise<Object>} 동기화 결과 (upsert된 라인 수 등)
 */
async function syncClearingLines(fromDate, toDate) {
  try {
    const entityName = DEFAULT_ENTITY;
    const tenantId = getTenantIdForEntity(entityName);
    if (!tenantId) {
      throw new Error('Clearing 동기화용 Tenant ID(XERO_TENANT_ID 등)가 비어 있습니다.');
    }

    const accessToken = await getAccessToken(entityName);

    // 날짜 형식 검증
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(fromDate) || !dateRegex.test(toDate)) {
      throw new Error('날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식을 사용하세요.');
    }
    
    // Xero where 파라미터 생성
    // YYYY-MM-DD를 DateTime(YYYY,MM,DD) 형식으로 변환
    const fromParts = fromDate.split('-');
    const toParts = toDate.split('-');
    const where = `JournalDate>=DateTime(${fromParts[0]},${parseInt(fromParts[1])},${parseInt(fromParts[2])})&&JournalDate<=DateTime(${toParts[0]},${parseInt(toParts[1])},${parseInt(toParts[2])})`;
    
    let offset = 0;
    const pageSize = 100;
    let totalUpserted = 0;
    let hasMore = true;
    
    console.log(`📥 Clearing 계정 라인 동기화 시작: ${fromDate} ~ ${toDate}`);
    
    // Pagination 루프
    while (hasMore) {
      const url = `https://api.xero.com/api.xro/2.0/Journals?offset=${offset}&where=${encodeURIComponent(where)}`;
      
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Xero-tenant-id': tenantId,
          Accept: 'application/json'
        }
      });
      
      const journals = response.data.Journals || [];
      
      if (journals.length === 0) {
        hasMore = false;
        break;
      }
      
      // 각 Journal 처리
      for (const journal of journals) {
        const journalId = journal.JournalID;
        const journalNumber = journal.JournalNumber || null;
        const journalDate = journal.JournalDate ? journal.JournalDate.split('T')[0] : null; // YYYY-MM-DD만 추출
        const sourceType = journal.SourceType || null;
        const reference = journal.Reference || null;
        
        // origin 분류
        let origin = 'OTHER';
        if (sourceType === 'MANUAL JOURNAL') {
          origin = 'MJ';
        } else if (sourceType === 'BANK' || sourceType === 'CASH') {
          origin = 'BANK';
        }
        
        const journalLines = journal.JournalLines || [];
        
        // 각 JournalLine 처리
        for (let i = 0; i < journalLines.length; i++) {
          const line = journalLines[i];
          const accountCode = line.AccountCode;
          
          // Clearing 계정 코드에 해당하는 라인만 처리
          if (!CLEARING_ACCOUNT_CODES.includes(accountCode)) {
            continue;
          }
          
          // 라인 번호 결정 (LineNumber가 있으면 사용, 없으면 index 기반)
          const lineNumber = line.LineNumber !== undefined ? line.LineNumber : (i + 1);
          
          // 금액 계산
          const debit = Number(line.Debit || 0);
          const credit = Number(line.Credit || 0);
          const signedAmount = debit - credit; // Debit은 +, Credit은 -
          
          const description = line.Description || null;
          
          // Upsert 실행
          // settled와 settled_at는 사용자가 체크하는 정보이므로 업데이트하지 않음
          await db.query(`
            INSERT INTO xero_clearing_lines (
              journal_id, line_number, journal_number, date, account_code,
              source_type, description, reference, debit, credit, signed_amount, origin
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              journal_number = VALUES(journal_number),
              date = VALUES(date),
              source_type = VALUES(source_type),
              description = VALUES(description),
              reference = VALUES(reference),
              debit = VALUES(debit),
              credit = VALUES(credit),
              signed_amount = VALUES(signed_amount),
              origin = VALUES(origin)
          `, [
            journalId,
            lineNumber,
            journalNumber,
            journalDate,
            accountCode,
            sourceType,
            description,
            reference,
            debit,
            credit,
            signedAmount,
            origin
          ]);
          
          totalUpserted++;
        }
      }
      
      // 다음 페이지 확인
      if (journals.length < pageSize) {
        hasMore = false;
      } else {
        offset += pageSize;
      }
    }
    
    console.log(`✅ Clearing 계정 라인 동기화 완료: ${totalUpserted}개 라인 upsert됨`);
    
    return {
      success: true,
      fromDate,
      toDate,
      totalUpserted
    };
    
  } catch (error) {
    console.error('\n❌ Clearing 계정 라인 동기화 실패:');
    console.error('상태 코드:', error.response?.status);
    console.error('에러 응답:', JSON.stringify(error.response?.data, null, 2));
    console.error('에러 메시지:', error.message);
    
    if (error.response?.status === 401) {
      console.error('\n🔴 401 에러 - 인증 실패 원인:');
      console.error('1. Access Token이 유효하지 않거나 만료되었습니다');
      console.error('2. Tenant ID가 올바르지 않습니다 (법인:', entityName, ')');
      console.error('3. API 권한(scope)이 부족합니다 - accounting.reports.read 권한 필요');
    } else if (error.response?.status === 403) {
      console.error('\n🔴 403 에러 - 권한 부족:');
      console.error('Xero 앱에 Journals 조회 권한이 없습니다');
      console.error('Xero 개발자 포털에서 스코프를 확인하세요');
    }
    
    throw error;
  }
}

/**
 * 특정 브랜치와 날짜에 대해 Manual Journal 생성
 * @param {string} branchCode - 브랜치 코드 (예: 'PA1')
 * @param {Date} date - 처리할 날짜 (formatOptomateDate가 전날을 반환하므로 하루 더한 날짜)
 * @param {string} dateStr - 실제 거래일 문자열 (YYYY-MM-DD 형식)
 * @param {Function} limitFn - concurrency 제어 함수 (p-limit)
 */
async function processBranchAndDate(branchCode, date, dateStr, limitFn) {
  const branch = BRANCHES.find((b) => b.code === branchCode);
  if (!branch) {
    throw new Error(`브랜치를 찾을 수 없습니다: ${branchCode}`);
  }
  const entityName = branch.entity;
  const branchName = getBranchName(branchCode);

  // UTC 날짜 범위 설정 (현지 거래일 기준, +11:00 시간대)
  // formatOptomateDate(date, 13)은 date의 전날 13:00 UTC를 반환
  // date가 하루 더해진 상태이므로, 실제로는 오늘 13:00 UTC ~ 내일 12:59:59 UTC 범위를 조회
  // 예: 오늘 2025-01-15 → date는 2025-01-16 → 2025-01-15T13:00:00Z ~ 2025-01-16T12:59:59Z (UTC)
  const startDate = formatOptomateDate(date, 13); // 오늘 13:00 UTC (현지 00:00)
  const endDate = formatOptomateDate(date, 12); // 내일 12:59:59 UTC (현지 23:59:59)

  // Optomate에서 Invoice와 Receipt 데이터를 concurrency=2로 병렬 가져오기
  // limitFn을 사용하여 동시 실행을 2개로 제한
  const [invoices, receipts] = await Promise.all([
    limitFn(() => fetchOptomateInvoices(branchCode, startDate, endDate)),
    limitFn(() => fetchOptomateReceipts(branchCode, startDate, endDate))
  ]);

  // Invoice에서 JournalLines 생성
  let journalLines = [];
  
  if (invoices && invoices.length > 0) {
    const stockTypeAmounts = calculateStockTypeAmounts(invoices, branchCode);
    if (Object.keys(stockTypeAmounts).length > 0) {
      journalLines = buildJournalLines(stockTypeAmounts, branchName);
    }
  }

  // Receipt에서 JournalLines 추가
  if (receipts && receipts.length > 0) {
    const receiptLines = buildReceiptJournalLines(receipts, branchName);
    journalLines = journalLines.concat(receiptLines);
  }

  if (journalLines.length === 0) {
    return null;
  }

  // Manual Journal 데이터 구성
  const manualJournalData = {
    Date: dateStr,
    Status: "DRAFT",
    Narration: "Daily Trading Sales and receipt",
    LineAmountTypes: "Inclusive",
    ShowOnCashBasisReports: false,
    JournalLines: journalLines
  };

  const result = await createManualJournal(manualJournalData, entityName);

  console.log(`✅ ${branchName} (${dateStr}) - Manual Journal 생성 완료 [${entityName}]`);
  return result;
}

// 메인 실행 로직
async function main() {
  try {
    // 환경 변수 확인
    if (!process.env.XERO_TENANT_ID) {
      throw new Error('XERO_TENANT_ID 환경 변수가 설정되지 않았습니다.');
    }

    if (!process.env.OPTOMATE_API_BASE || !process.env.OPTOMATE_USERNAME || !process.env.OPTOMATE_PASSWORD) {
      throw new Error('Optomate API 환경 변수가 설정되지 않았습니다.');
    }
    
    // MySQL 연결 테스트
    try {
      await db.query('SELECT 1');
    } catch (error) {
      console.error('❌ MySQL 연결 실패:', error.message);
      throw new Error('MySQL 연결에 실패했습니다. 설정을 확인하세요.');
    }
    
    // 테이블 생성 (없으면 자동 생성)
    await ensureTableExists();
    await ensureClearingTableExists();
    await ensureXeroTokensReady();

    // Refresh Token 확인
    const storedToken = await getStoredRefreshTokenForEntity(DEFAULT_ENTITY);
    if (!storedToken) {
      throw new Error('MySQL에 Refresh Token이 없습니다. 최초 설정을 진행하세요: npm run init');
    }

    // 날짜를 항상 당일(오늘)로 설정
    // 로컬 시간대의 오늘 날짜를 기준으로 처리
    // 예: 27일 저녁에 실행하면 27일 데이터를 가져옴
    const now = new Date();
    // 로컬 시간대의 오늘 날짜 (년-월-일만 추출)
    const localYear = now.getFullYear();
    const localMonth = now.getMonth();
    const localDate = now.getDate();
    
    // 로컬 시간대의 오늘 00:00:00으로 설정
    const processDate = new Date(localYear, localMonth, localDate, 0, 0, 0, 0);
    // formatOptomateDate가 전날 13:00 UTC를 반환하므로,
    // 오늘 데이터를 가져오려면 processDate를 하루 더해야 함
    processDate.setDate(processDate.getDate() + 1);
    
    // 명령줄 인자로 브랜치 코드만 받기
    let targetBranchCode = null;
    if (process.argv.length > 2) {
      targetBranchCode = process.argv[2].toUpperCase();
    }

    // 실제 처리할 날짜는 오늘 (로컬 시간대 기준)
    // toISOString()은 UTC 기준이므로 로컬 날짜를 직접 문자열로 변환
    const dateStr = `${localYear}-${String(localMonth + 1).padStart(2, '0')}-${String(localDate).padStart(2, '0')}`;
    console.log(`📅 처리 날짜: ${dateStr} (당일)`);
    
    // 처리할 브랜치 결정
    let branchesToProcess = [];
    if (targetBranchCode) {
      // 특정 브랜치만 처리 (테스트용)
      const branch = BRANCHES.find(b => b.code === targetBranchCode);
      if (!branch) {
        throw new Error(`브랜치 코드 '${targetBranchCode}'를 찾을 수 없습니다. 사용 가능한 코드: ${BRANCHES.map(b => b.code).join(', ')}`);
      }
      branchesToProcess = [branch];
    } else {
      // 모든 브랜치 처리
      branchesToProcess = BRANCHES;
    }

    // concurrency 제어: receipt/invoice 호출에 concurrency=2 적용
    const apiLimit = pLimit(2);
    
    // 브랜치 처리 (각 브랜치별로 receipt/invoice는 내부에서 concurrency=2로 처리됨)
    const results = [];
    for (const branch of branchesToProcess) {
      try {
        const result = await processBranchAndDate(branch.code, processDate, dateStr, apiLimit);
        if (result) {
          results.push({ branch: branch.code, success: true, result });
        }
      } catch (error) {
        console.error(`❌ ${branch.name} (${branch.code}) 처리 실패:`, error.message);
        results.push({ branch: branch.code, success: false, error: error.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    if (successCount > 0 || failCount > 0) {
      console.log(`처리 완료: 성공 ${successCount}개, 실패 ${failCount}개`);
    }
    
  } catch (error) {
    console.error('오류 발생:', error.message);
    process.exit(1);
  }
}

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

// 스크립트 실행
main();

const httpPort = process.env.HTTP_PORT || process.env.PORT;
if (httpPort) {
  app.listen(Number(httpPort), '0.0.0.0', () => {
    console.log(
      `HTTP 서버: ${httpPort} (Gmail Pub/Sub POST /webhooks/gmail/pubsub, GET /webhooks/gmail/health)`
    );
  });
}

export default app;
