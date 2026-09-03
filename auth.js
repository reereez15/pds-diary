const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, uid } = require('./db');

const router = express.Router();

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';           // 카드3: 짧은 만료
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7);

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  // 비밀키가 코드에 하드코딩되지 않도록 환경변수 필수화 (T07-C113)
  throw new Error('JWT_ACCESS_SECRET / JWT_REFRESH_SECRET 환경변수가 설정되어 있지 않습니다.');
}

const REFRESH_COOKIE_NAME = 'refresh_token';
const isProd = process.env.NODE_ENV === 'production';

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: 'refresh' }, REFRESH_SECRET, { expiresIn: `${REFRESH_TTL_DAYS}d` });
}

function refreshCookieOptions() {
  return {
    httpOnly: true,                 // T07-C112: JS/주소창에서 접근 불가
    secure: isProd,                 // Render 배포(HTTPS)에서는 true, 로컬 http 개발 중엔 false
    sameSite: 'strict',
    path: '/api/auth',              // 인증 라우트에만 실려가도록 범위 제한
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

// ---------- 회원가입 ----------
router.post('/register', ah(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  if (password.length < 8) return res.status(400).json({ error: 'weak_password' });

  const [existingRows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existingRows[0]) return res.status(409).json({ error: 'email_taken' });

  // 카드2: bcrypt로 되돌릴 수 없게 저장 (원문은 저장/로그 어디에도 남기지 않음)
  const passwordHash = await bcrypt.hash(password, 12);
  const id = uid();
  await pool.query(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)',
    [id, email, passwordHash, nowIso()]
  );

  res.status(201).json({ id, email });
}));

// ---------- 로그인 ----------
router.post('/login', ah(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];
  // 이메일이 없을 때와 비밀번호가 틀렸을 때를 구분하지 않음(계정 존재 여부 노출 방지)
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await pool.query(
    'INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)',
    [uid(), user.id, refreshToken, addDays(new Date(), REFRESH_TTL_DAYS).toISOString(), nowIso()]
  );

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  res.json({ accessToken, user: { id: user.id, email: user.email } });
}));

// ---------- 액세스 토큰 재발급 ----------
router.post('/refresh', ah(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'no_refresh_token' });

  // 화이트리스트 확인: 로그아웃 등으로 DB에서 지워졌으면 여기서 즉시 거절됨 (T07-C109)
  const [rows] = await pool.query('SELECT * FROM refresh_tokens WHERE token = ?', [token]);
  const stored = rows[0];
  if (!stored) return res.status(401).json({ error: 'refresh_token_revoked' });

  let payload;
  try {
    payload = jwt.verify(token, REFRESH_SECRET);
  } catch (e) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = ?', [token]);
    return res.status(401).json({ error: 'refresh_token_invalid' });
  }

  const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.sub]);
  const user = userRows[0];
  if (!user) return res.status(401).json({ error: 'user_not_found' });

  const accessToken = signAccessToken(user);
  res.json({ accessToken, user: { id: user.id, email: user.email } });
}));

// ---------- 로그아웃 ----------
router.post('/logout', ah(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = ?', [token]); // 즉시 무효화
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: 0 });
  res.json({ ok: true });
}));

// ---------- 내 정보 ----------
router.get('/me', ah(async (req, res, next) => {
  requireAuth(req, res, () => {
    res.json({ id: req.user.sub, email: req.user.email });
  });
}));

// ---------- 인증 미들웨어 ----------
// 데이터를 다루는 라우트(plans/tasks/logs/reviews)에 붙여서
// - 로그인하지 않은 요청은 401로 막고 (T07-C97)
// - req.user.sub 에 사용자 id를 넣어줘서 각 라우트가 소유자 필터링에 쓸 수 있게 함 (카드4)
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

module.exports = { router, requireAuth };
