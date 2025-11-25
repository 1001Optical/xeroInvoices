import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

// 환경 변수 로드
dotenv.config();

/**
 * 최초 설정 스크립트
 * .env 파일에 XERO_REFRESH_TOKEN이 있으면 MySQL에 저장
 */
async function initToken() {
  try {
    console.log('초기 Refresh Token 설정 시작...\n');
    
    // 환경 변수 확인
    if (!process.env.XERO_REFRESH_TOKEN) {
      console.error('❌ .env 파일에 XERO_REFRESH_TOKEN이 설정되지 않았습니다.');
      console.log('\n사용법:');
      console.log('1. .env 파일에 XERO_REFRESH_TOKEN=your_token 설정');
      console.log('2. 또는 MySQL에 직접 실행:');
      console.log('   INSERT INTO xero_tokens (id, refresh_token) VALUES (1, "your_token");');
      process.exit(1);
    }
    
    // MySQL 연결
    const db = mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT || '3307'),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    });
    
    // 연결 테스트
    await db.query('SELECT 1');
    console.log('✅ MySQL 연결 성공\n');
    
    // 테이블 생성 (없으면 자동 생성)
    await db.query(`
      CREATE TABLE IF NOT EXISTS xero_tokens (
        id INT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ xero_tokens 테이블 확인 완료\n');
    
    // 기존 토큰 확인
    const [existing] = await db.query('SELECT id FROM xero_tokens WHERE id = 1');
    
    if (existing && existing.length > 0) {
      // 업데이트
      await db.query(
        'UPDATE xero_tokens SET refresh_token = ? WHERE id = 1',
        [process.env.XERO_REFRESH_TOKEN]
      );
      console.log('🔄 기존 Refresh Token 업데이트 완료');
    } else {
      // 최초 삽입
      await db.query(
        'INSERT INTO xero_tokens (id, refresh_token) VALUES (1, ?)',
        [process.env.XERO_REFRESH_TOKEN]
      );
      console.log('✅ Refresh Token 최초 저장 완료');
    }
    
    console.log('\n✅ 초기 설정 완료!');
    console.log('이제 .env 파일에서 XERO_REFRESH_TOKEN을 제거해도 됩니다.');
    console.log('MySQL에 저장된 Refresh Token이 자동으로 갱신됩니다.\n');
    
    await db.end();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ 초기 설정 실패:', error.message);
    console.error('\n확인 사항:');
    console.error('1. MySQL 서버가 실행 중인지 확인');
    console.error('2. .env 파일에 MySQL 연결 정보가 올바른지 확인');
    console.error('3. xero_tokens 테이블이 생성되었는지 확인');
    console.error('\n테이블 생성 SQL:');
    console.error('CREATE TABLE xero_tokens (');
    console.error('  id INT PRIMARY KEY,');
    console.error('  refresh_token TEXT NOT NULL,');
    console.error('  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    console.error(');');
    process.exit(1);
  }
}

// 실행
initToken();

