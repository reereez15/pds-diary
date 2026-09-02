require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// Aiven/Railway 등은 보통 하나의 접속 URL(MYSQL_URL / DATABASE_URL)을 줍니다.
// 없으면 개별 환경변수(DB_HOST 등)로 접속합니다. 둘 다 없으면 로컬 기본값으로 접속을 시도합니다.
const connectionUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;

// 임시 진단 로그 — 문제 원인 확인 후 지울 예정
console.log('[진단] MYSQL_URL 존재?', !!process.env.MYSQL_URL, '/ 길이:', (process.env.MYSQL_URL || '').length);
console.log('[진단] DATABASE_URL 존재?', !!process.env.DATABASE_URL);
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

async function initSchema() {
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
}

function uid() {
  return crypto.randomUUID();
}

module.exports = { pool, initSchema, uid };
