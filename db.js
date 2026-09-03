require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// Aiven/Railway 등은 보통 하나의 접속 URL(MYSQL_URL / DATABASE_URL)을 줍니다.
// 없으면 개별 환경변수(DB_HOST 등)로 접속합니다. 둘 다 없으면 로컬 기본값으로 접속을 시도합니다.
const connectionUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;

// Aiven은 SSL 접속을 요구하지만 자체 발급(self-signed) 인증서를 쓰기 때문에,
// Node의 기본 공인 인증서 목록으로는 체인 검증이 실패합니다(self-signed certificate in
// certificate chain). 통신 자체는 암호화하되 인증서 신원 검증만 생략(rejectUnauthorized: false)
// 하는 방식으로 접속합니다. 완전한 검증이 필요하면 Aiven 콘솔에서 CA 인증서를 내려받아
// ssl.ca 로 지정하는 방법도 있습니다.
function buildPoolConfig() {
  if (connectionUrl) {
    const u = new URL(connectionUrl);
    const useSsl = process.env.DB_SSL !== 'false';
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'defaultdb',
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 10,
    };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pds_diary',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
  };
}

const pool = mysql.createPool(buildPoolConfig());

// 기존 테이블에 user_id 컬럼이 없을 때만 추가합니다.
// MySQL 8.0.29 미만은 "ADD COLUMN IF NOT EXISTS"를 지원하지 않으므로
// information_schema를 직접 조회해서 존재 여부를 확인한 뒤 추가합니다.
async function addUserIdColumnIfMissing(tableName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = 'user_id'`,
    [tableName]
  );
  if (rows[0].cnt > 0) return; // 이미 있으면 건너뜀

  await pool.query(
    `ALTER TABLE \`${tableName}\` ADD COLUMN user_id VARCHAR(36) NULL`
  );

  // FK도 이미 있는지 확인 후 없을 때만 추가 (제약조건 이름 충돌 방지)
  const fkName = `fk_${tableName}_user`;
  const [fkRows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?`,
    [tableName, fkName]
  );
  if (fkRows[0].cnt === 0) {
    await pool.query(
      `ALTER TABLE \`${tableName}\`
       ADD CONSTRAINT \`${fkName}\` FOREIGN KEY (user_id) REFERENCES users(id)`
    );
  }
}

// users 테이블이 예전에 email 컬럼으로 이미 만들어져 있었다면 username으로 이름만 바꿉니다.
// (처음부터 새로 만드는 경우엔 CREATE TABLE에서 바로 username으로 생기므로 여긴 조용히 넘어갑니다)
async function renameEmailColumnToUsernameIfNeeded() {
  const [tableRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  if (tableRows[0].cnt === 0) return; // users 테이블 자체가 아직 없으면 이 뒤 CREATE TABLE에서 새로 만들어짐

  const [emailRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`
  );
  const [usernameRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username'`
  );
  if (emailRows[0].cnt > 0 && usernameRows[0].cnt === 0) {
    await pool.query('ALTER TABLE users CHANGE COLUMN email username VARCHAR(50) UNIQUE NOT NULL');
  }
}

async function initSchema() {
  await renameEmailColumnToUsernameIfNeeded();

  // 과제 6 — 기존 테이블 (변경 없음)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      period_start VARCHAR(10) NOT NULL,
      period_end VARCHAR(10) NOT NULL,
      priority VARCHAR(10) NOT NULL,
      success_criteria TEXT NOT NULL,
      estimated_minutes INT NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      updated_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(36) PRIMARY KEY,
      plan_id VARCHAR(36) NOT NULL,
      title VARCHAR(255) NOT NULL,
      due_date VARCHAR(10),
      priority VARCHAR(10) NOT NULL DEFAULT 'medium',
      tags VARCHAR(255) NOT NULL DEFAULT '',
      estimated_minutes INT NOT NULL DEFAULT 0,
      status VARCHAR(10) NOT NULL DEFAULT 'todo',
      created_at VARCHAR(30) NOT NULL,
      updated_at VARCHAR(30) NOT NULL,
      completed_at VARCHAR(30),
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      INDEX idx_tasks_plan (plan_id)
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id VARCHAR(36) PRIMARY KEY,
      task_id VARCHAR(36) NOT NULL,
      start_time VARCHAR(30) NOT NULL,
      end_time VARCHAR(30) NOT NULL,
      actual_minutes INT NOT NULL,
      blocked_reason VARCHAR(255) NOT NULL DEFAULT '',
      created_at VARCHAR(30) NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      INDEX idx_logs_task (task_id)
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_history (
      id VARCHAR(36) PRIMARY KEY,
      plan_id VARCHAR(36) NOT NULL,
      snapshot TEXT NOT NULL,
      edited_at VARCHAR(30) NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      INDEX idx_hist_plan (plan_id)
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id VARCHAR(36) PRIMARY KEY,
      period_start VARCHAR(10) NOT NULL,
      period_end VARCHAR(10) NOT NULL,
      next_plan_note TEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB
  `);

  // 과제 7 — 신규 테이블: 계정
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB
  `);

  // 과제 7 — 신규 테이블: 리프레시 토큰 화이트리스트
  // (httpOnly 쿠키로 발급하고, 로그아웃 시 이 테이블에서 삭제해 즉시 무효화)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      token VARCHAR(512) NOT NULL,
      expires_at VARCHAR(30) NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_refresh_user (user_id)
    ) ENGINE=InnoDB
  `);

  // 과제 7 — 기존 테이블에 소유자(user_id) 컬럼 추가 (카드 4 근거)
  // users 테이블이 먼저 만들어진 뒤에 실행되어야 FK가 걸립니다.
  await addUserIdColumnIfMissing('plans');
  await addUserIdColumnIfMissing('tasks');
  await addUserIdColumnIfMissing('logs');
  await addUserIdColumnIfMissing('plan_history');
  await addUserIdColumnIfMissing('reviews');
}

function uid() {
  return crypto.randomUUID();
}

module.exports = { pool, initSchema, uid };
