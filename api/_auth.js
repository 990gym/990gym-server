// 관리자 로그인 토큰 (서명된 12시간짜리 표)
// 비밀번호는 Vercel 환경변수 ADMIN_PASSWORD 에만 있다. 페이지 소스에는 없다.
// 비밀번호를 바꾸면 서명 열쇠도 바뀌어서, 예전에 받은 토큰은 모두 못 쓰게 된다.
import crypto from 'crypto';

const TOKEN_HOURS = 12;

function secret() {
  const pw = process.env.ADMIN_PASSWORD || '';
  const salt = process.env.ADMIN_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return crypto.createHash('sha256').update(`990gym-admin|${pw}|${salt}`).digest();
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export function passwordConfigured() {
  return (process.env.ADMIN_PASSWORD || '').length >= 8;
}

export function checkPassword(pw) {
  if (!passwordConfigured()) return false;
  return sameText(pw || '', process.env.ADMIN_PASSWORD);
}

export function issueToken() {
  const exp = Date.now() + TOKEN_HOURS * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt: exp };
}

export function verifyToken(token) {
  if (!passwordConfigured() || typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig || !sameText(sig, sign(body))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Number(exp) > Date.now();
  } catch (e) {
    return false;
  }
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// 990짐 홈페이지에서 오는 요청만 받는다
const ORIGINS = ['https://the990.co.kr', 'https://www.the990.co.kr'];
export function cors(req, res, methods = 'POST, OPTIONS') {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}
