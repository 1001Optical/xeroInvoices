import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import mysql from 'mysql2/promise';
import pLimit from 'p-limit';
import { BRANCHES, STOCK_TYPES, CLEARING_ACCOUNT_CODE, PAYMENT_TYPES } from './constants.js';

// 환경 변수 로드
dotenv.config();

const app = express();

// JSON 파싱 미들웨어
app.use(express.json());

// MySQL 연결 풀 생성
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
 * MySQL에서 저장된 Refresh Token 가져오기
 * @returns {Promise<string|null>} Refresh Token 또는 null
 */
async function getStoredRefreshToken() {
  try {
    const [rows] = await db.query('SELECT refresh_token FROM xero_tokens WHERE id = 1');
    if (rows && rows.length > 0) {
      return rows[0].refresh_token;
    }
    return null;
  } catch (error) {
    console.error('MySQL에서 Refresh Token 조회 실패:', error.message);
    throw error;
  }
}

/**
 * MySQL에 Refresh Token 저장 또는 업데이트
 * @param {string} refreshToken - 새로운 Refresh Token
 */
async function saveRefreshToken(refreshToken) {
  try {
    // 먼저 id=1이 존재하는지 확인
    const [existing] = await db.query('SELECT id FROM xero_tokens WHERE id = 1');
    
    if (existing && existing.length > 0) {
      // 업데이트
      await db.query(
        'UPDATE xero_tokens SET refresh_token = ? WHERE id = 1',
        [refreshToken]
      );
    } else {
      // 최초 삽입
      await db.query(
        'INSERT INTO xero_tokens (id, refresh_token) VALUES (1, ?)',
        [refreshToken]
      );
    }
  } catch (error) {
    console.error('MySQL에 Refresh Token 저장 실패:', error.message);
    throw error;
  }
}

/**
 * Xero API Access Token을 Refresh Token으로부터 얻어오는 함수
 * MySQL에서 Refresh Token을 가져오고, 새 토큰이 있으면 저장함
 * @returns {Promise<string>} Access Token
 */
async function getAccessToken() {
  try {
    const tokenUrl = 'https://identity.xero.com/connect/token';
    
    // 환경 변수 확인
    if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
      throw new Error('필수 환경 변수가 설정되지 않았습니다. XERO_CLIENT_ID, XERO_CLIENT_SECRET을 확인하세요.');
    }
    
    // MySQL에서 Refresh Token 가져오기
    const refreshToken = await getStoredRefreshToken();
    
    if (!refreshToken) {
      throw new Error('MySQL에 Refresh Token이 없습니다. 최초 설정을 진행하세요.');
    }
    
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('client_id', process.env.XERO_CLIENT_ID);
    params.append('client_secret', process.env.XERO_CLIENT_SECRET);
    
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const accessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token;
    
    if (!accessToken) {
      throw new Error('Access Token이 응답에 포함되지 않았습니다.');
    }
    
    // 새로운 Refresh Token이 응답에 있으면 MySQL에 저장
    if (newRefreshToken && newRefreshToken !== refreshToken) {
      await saveRefreshToken(newRefreshToken);
    }
    
    return accessToken;
  } catch (error) {
    console.error('토큰 갱신 실패:');
    console.error('상태 코드:', error.response?.status);
    console.error('에러 응답:', JSON.stringify(error.response?.data, null, 2));
    console.error('에러 메시지:', error.message);
    
    if (error.response?.status === 401) {
      console.error('\n401 에러 - 인증 실패 원인:');
      console.error('1. MySQL에 저장된 Refresh Token이 만료되었거나 유효하지 않습니다');
      console.error('2. Client ID 또는 Client Secret이 잘못되었습니다');
      console.error('3. Xero 개발자 포털에서 새로운 Refresh Token을 발급받아 MySQL에 저장하세요');
    }
    
    throw error;
  }
}

/**
 * Xero API 연결 테스트 (Tenant 정보 확인)
 * @param {string} accessToken - Access Token
 * @returns {Promise<Object>} Tenant 정보
 */
async function testConnection(accessToken) {
  try {
    const apiUrl = 'https://api.xero.com/api.xro/2.0/Organisation';
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Xero-tenant-id': process.env.XERO_TENANT_ID,
        'Accept': 'application/json'
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
      console.error('2. Tenant ID가 잘못됨 (현재 값:', process.env.XERO_TENANT_ID, ')');
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

    // Payment Type 라인 (음수 - Credit)
    if (Math.abs(netAmount) > 0.01) {
      journalLines.push({
        Description: paymentTypeInfo.description,
        LineAmount: -Math.abs(netAmount), // 음수 (Credit)
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

  // POS Clearing 라인: 모든 Payment Type 합계 (양수 - Debit)
  if (Math.abs(totalPaymentAmount) > 0.01) {
    journalLines.push({
      Description: "POS Clearing",
      LineAmount: totalPaymentAmount, // 양수 (Debit)
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
        LineAmount: -Math.abs(gstOnIncome), // 음수 (Income)
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
      LineAmount: totalGstOnIncome, // 양수
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
        LineAmount: -Math.abs(gstFreeIncome), // 음수 (Income)
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
      LineAmount: totalGstFreeIncome, // 양수
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
 * @returns {Promise<Object>} 생성된 Manual Journal 응답
 */
async function createManualJournal(manualJournalData) {
  try {
    // Access Token 가져오기
    const accessToken = await getAccessToken();
    
    // 먼저 연결 테스트 (Tenant 확인)
    await testConnection(accessToken);
    
    const apiUrl = 'https://api.xero.com/api.xro/2.0/ManualJournals';
    
    // Xero API는 ManualJournals 배열로 감싸서 요청해야 함
    const requestBody = {
      ManualJournals: [manualJournalData]
    };
    
    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Xero-tenant-id': process.env.XERO_TENANT_ID,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
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
      console.error('2. Tenant ID가 올바르지 않습니다 (현재:', process.env.XERO_TENANT_ID, ')');
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
 * 특정 브랜치와 날짜에 대해 Manual Journal 생성
 * @param {string} branchCode - 브랜치 코드 (예: 'PA1')
 * @param {Date} date - 처리할 날짜 (formatOptomateDate가 전날을 반환하므로 하루 더한 날짜)
 * @param {string} dateStr - 실제 거래일 문자열 (YYYY-MM-DD 형식)
 * @param {Function} limitFn - concurrency 제어 함수 (p-limit)
 */
async function processBranchAndDate(branchCode, date, dateStr, limitFn) {
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

  // Xero API에 Manual Journal 생성
  const result = await createManualJournal(manualJournalData);
  
  console.log(`✅ ${branchName} (${dateStr}) - Manual Journal 생성 완료`);
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
    
    // Refresh Token 확인
    const storedToken = await getStoredRefreshToken();
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

// 스크립트 실행
main();

export default app;
