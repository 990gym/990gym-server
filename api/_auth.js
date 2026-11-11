// 관리자 로그인 (비밀번호 확인 + 서명된 12시간짜리 토큰)
//
// 비밀번호는 페이지 소스에 없다. 순서:
//   1) 관리자 화면에서 바꾼 비밀번호 → DB admin_settings 에 '해시'로 저장 (원문은 어디에도 없음)
//   2) 그게 없으면 Vercel 환경변수 ADMIN_PASSWORD (처음 한 번 + 비밀번호를 잊었을 때 비상용)
// 비밀번호를 잊으면: Supabase 에서 admin_settings 의 admin_password_hash 줄을 지우면 2)로 돌아간다.
// 비밀번호가 바뀌면 서명 열쇠도 바뀌어서, 예전에 받은 토큰은 모두 못 쓰게 된다.
import crypto from 'crypto';

const TOKEN_HOURS = 12;
const HASH_KEY = 'admin_password_hash';
// 예전에 페이지 소스에 공개돼 있던 비밀번호 — 다시 쓰지 못하게 막는다
const LEAKED = ['990gym2026!'];

async function storedHash(supabase) {
  const { data, error } = await supabase.from('admin_settings').select('value').eq('key', HASH_KEY).maybeSingle();
  if (error) return null; // 표가 아직 없으면 환경변수만 사용
  return data ? data.value : null;
}

// 지금 유효한 비밀번호 정보: { kind: 'db', hash } | { kind: 'env', pw } | null
async function credential(supabase) {
  const hash = await storedHash(supabase);
  if (hash) return { kind: 'db', hash };
  const pw = process.env.ADMIN_PASSWORD || '';
  if (pw.length >= 8 && !LEAKED.includes(pw)) return { kind: 'env', pw };
  return null;
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(String(pw), salt, 32).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

function matchHash(pw, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  return sameText(crypto.scryptSync(String(pw), salt, 32).toString('base64url'), key);
}

function signingKey(cred) {
  const fp = cred.kind === 'db' ? cred.hash : cred.pw;
  const salt = process.env.ADMIN_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return crypto.createHash('sha256').update(`990gym-admin|${fp}|${salt}`).digest();
}

const sign = (cred, body) => crypto.createHmac('sha256', signingKey(cred)).update(body).digest('base64url');

export async function passwordConfigured(supabase) {
  return !!(await credential(supabase));
}

export async function checkPassword(supabase, pw) {
  const cred = await credential(supabase);
  if (!cred || !pw) return false;
  return cred.kind === 'db' ? matchHash(pw, cred.hash) : sameText(pw, cred.pw);
}

export async function issueToken(supabase) {
  const cred = await credential(supabase);
  const exp = Date.now() + TOKEN_HOURS * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return { token: `${body}.${sign(cred, body)}`, expiresAt: exp };
}

export async function verifyToken(supabase, token) {
  if (typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const cred = await credential(supabase);
  if (!cred || !sameText(sig, sign(cred, body))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Number(exp) > Date.now();
  } catch (e) {
    return false;
  }
}

// 새 비밀번호 저장. 문제가 있으면 안내 문구, 성공하면 null.
export async function setPassword(supabase, next) {
  const pw = String(next || '');
  if (pw.length < 8) return '새 비밀번호는 8자 이상으로 해주세요.';
  if (pw.length > 100) return '비밀번호가 너무 길어요.';
  if (LEAKED.includes(pw)) return '예전에 공개됐던 비밀번호라 쓸 수 없어요.';
  const { error } = await supabase.from('admin_settings')
    .upsert({ key: HASH_KEY, value: hashPassword(pw), updated_at: new Date().toISOString() });
  if (error) return '저장하지 못했어요. (Supabase에 admin_settings 표가 있는지 확인해주세요)';
  return null;
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
