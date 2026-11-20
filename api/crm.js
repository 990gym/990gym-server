import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { cors, bearer, verifyToken } from './_auth.js';

// 990 CRM (보기 전용) — the990.co.kr/crm.html 이 부른다.
// 로그인은 관리자 페이지와 같다 (/api/admin 의 login 토큰을 그대로 쓴다).
// 회원·결제·이용권은 읽기만 한다. 바꾸는 건 입실 기록과 회원 사진뿐이다 (입실 체크 태블릿용).
// POST { action, ...params }  /  Authorization: Bearer <로그인 토큰>

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DAY = 24 * 60 * 60 * 1000;
const todayKST = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY); // b - a

// 오늘 날짜 기준으로 단계를 다시 계산 (이관 때 정한 규칙과 같다)
function liveStage(m, today) {
  if (m.stage === '만료·이탈' && (!m.ends_on || m.ends_on < today)) return '만료·이탈';
  if (m.ends_on && m.ends_on < today) return '만료·이탈';
  const left = m.ends_on ? daysBetween(today, m.ends_on) : null;
  if (left !== null && left <= 14) return '만료 예정';
  const started = m.first_started_on ? daysBetween(m.first_started_on, today) : null;
  const absent = m.last_attended_on ? daysBetween(m.last_attended_on, today) : null;
  if (!m.holding && (absent === null || absent >= 14) && !(started !== null && started < 14)) return '미출석';
  if (started !== null && started <= 28) return '체험·신규';
  return '정착';
}

const MEMBER_COLS = 'id,name,phone,gender,usage_tag,stage,holding,first_started_on,ends_on,last_attended_on,total_visits,lifetime_paid,counselor,trainer,source,marketing_consent,memo';

async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

function decorate(m, today) {
  const stage = liveStage(m, today);
  return {
    ...m,
    stage,
    days_left: m.ends_on ? daysBetween(today, m.ends_on) : null,
    days_absent: m.last_attended_on ? daysBetween(m.last_attended_on, today) : null,
  };
}

function lockerTotal(rows) {
  if (!rows || !rows.length) return 0;
  const nums = rows.map((l) => l.number);
  const first = Math.min(...nums);
  return Math.ceil((Math.max(...nums) - first + 1) / 8) * 8; // 배치도 칸 수 (세로 8칸씩)
}

// ---------- 대시보드 ----------
async function dashboard() {
  const today = todayKST();
  const recentCut = new Date(Date.parse(today) - 400 * DAY).toISOString().slice(0, 10);
  const [members, passes, payments, lockers, assigns, inq, totalCount, snap] = await Promise.all([
    // 유효 회원 + 최근 1년 안에 끝난 회원만 (만료 후 안내 대상까지)
    Promise.all([
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).neq('stage', '만료·이탈')),
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).eq('stage', '만료·이탈').gte('ends_on', recentCut)),
    ]).then(([a, b]) => a.concat(b)),
    selectAll(() => supabase.from('crm_passes').select('member_id,category,product_name,status,ends_on,remaining_count,total_count').in('status', ['사용 중', '예정', '홀딩'])),
    selectAll(() => supabase.from('crm_payments').select('amount,kind,paid_at,pass_id')),
    supabase.from('crm_lockers').select('number'),
    selectAll(() => supabase.from('crm_locker_assignments').select('locker_no,member_id,status,ends_on').in('status', ['사용 중', '예정', '홀딩'])),
    supabase.from('crm_inquiries').select('id', { count: 'exact', head: true }),
    supabase.from('crm_members').select('id', { count: 'exact', head: true }),
    supabase.from('crm_members').select('created_at').order('created_at', { ascending: false }).limit(1),
  ]);
  if (lockers.error || inq.error || totalCount.error || snap.error) throw lockers.error || inq.error || totalCount.error || snap.error;

  const all = members.map((m) => decorate(m, today));
  const active = all.filter((m) => m.stage !== '만료·이탈');
  const stages = { '체험·신규': 0, '정착': 0, '미출석': 0, '만료 예정': 0 };
  active.forEach((m) => { stages[m.stage] = (stages[m.stage] || 0) + 1; });
  const expiredTotal = totalCount.count - active.length;

  const byId = Object.fromEntries(all.map((m) => [m.id, m]));
  const pick = (m) => ({ id: m.id, name: m.name, phone: m.phone, usage_tag: m.usage_tag, stage: m.stage, holding: m.holding,
    ends_on: m.ends_on, days_left: m.days_left, last_attended_on: m.last_attended_on, days_absent: m.days_absent,
    first_started_on: m.first_started_on, counselor: m.counselor, trainer: m.trainer });

  // 유효 이용권 종류 (회원 수 기준)
  const passMix = {};
  const ptLeft = {};
  passes.forEach((p) => {
    if (!byId[p.member_id] || byId[p.member_id].stage === '만료·이탈') return;
    const key = p.category === '이전 상품' ? (/PT/.test(p.product_name) ? 'PT' : /구독/.test(p.product_name) ? '월구독' : /GX|VIP|V\.I\.P|줌바|요가|스피닝/.test(p.product_name) ? 'GX' : '헬스 기간권') : p.category;
    passMix[key] = passMix[key] || new Set();
    passMix[key].add(p.member_id);
    if (key === 'PT' && p.remaining_count) ptLeft[p.member_id] = (ptLeft[p.member_id] || 0) + p.remaining_count;
  });
  const mix = Object.fromEntries(Object.entries(passMix).map(([k, s]) => [k, s.size]));

  // 오늘 할 일 (보기 전용: 누구에게 무엇을)
  const sortBy = (arr, f) => arr.sort((a, b) => f(a) - f(b));
  const expiring = sortBy(active.filter((m) => m.stage === '만료 예정'), (m) => m.days_left).map(pick);
  const absent = sortBy(active.filter((m) => m.stage === '미출석'), (m) => (m.days_absent == null ? 1e6 : -m.days_absent)).map(pick);
  const fresh = sortBy(active.filter((m) => m.stage === '체험·신규'), (m) => -(Date.parse(m.first_started_on || today))).map(pick);
  const recentlyExpired = sortBy(all.filter((m) => m.stage === '만료·이탈' && m.ends_on && daysBetween(m.ends_on, today) <= 30), (m) => -Date.parse(m.ends_on)).map(pick);

  // 만료 후 안내 시점(1·3·6·12개월) 대상 수
  const after = { '1개월': 0, '3개월': 0, '6개월': 0, '12개월': 0 };
  all.filter((m) => m.stage === '만료·이탈' && m.ends_on).forEach((m) => {
    const d = daysBetween(m.ends_on, today);
    if (d >= 28 && d <= 35) after['1개월']++;
    else if (d >= 88 && d <= 95) after['3개월']++;
    else if (d >= 178 && d <= 185) after['6개월']++;
    else if (d >= 360 && d <= 370) after['12개월']++;
  });

  // 월별 결제 (브로제이에서 금액이 남아 있는 PT·GX·일부 기간권)
  const monthly = {};
  payments.forEach((p) => {
    const k = String(p.paid_at).slice(0, 7);
    monthly[k] = monthly[k] || { amount: 0, count: 0, renew: 0 };
    monthly[k].amount += p.amount; monthly[k].count++; if (p.kind === '재등록') monthly[k].renew++;
  });

  return [200, {
    today,
    snapshotAt: snap.data[0] ? snap.data[0].created_at : null,
    totals: {
      members: totalCount.count, active: active.length, expired: expiredTotal,
      holding: active.filter((m) => m.holding).length, inquiries: inq.count,
      lockers: lockerTotal(lockers.data), lockersUsed: new Set(assigns.map((a) => a.locker_no)).size,
      ptMembers: Object.keys(ptLeft).length, ptSessionsLeft: Object.values(ptLeft).reduce((a, b) => a + b, 0),
    },
    stages, mix, after,
    lists: { expiring, absent, fresh, recentlyExpired },
    lockerSoon: assigns.filter((a) => a.ends_on && daysBetween(today, a.ends_on) <= 7)
      .map((a) => ({ ...a, days_left: daysBetween(today, a.ends_on), name: byId[a.member_id] ? byId[a.member_id].name : null })),
    monthly,
  }];
}

// ---------- 회원 목록·검색 ----------
async function members({ q = '', stage = '', limit = 60, offset = 0 }) {
  const today = todayKST();
  const term = String(q).trim().slice(0, 30);
  let query = supabase.from('crm_members').select(MEMBER_COLS, { count: 'exact' });
  if (term) {
    const digits = term.replace(/\D/g, '');
    query = digits.length >= 3 && digits.length === term.length
      ? query.ilike('phone', `%${digits.slice(-4)}%`)
      : query.ilike('name', `%${term.replace(/[%_,()]/g, '')}%`);
  } else if (stage === '만료·이탈') {
    query = query.eq('stage', '만료·이탈');
  } else {
    query = query.neq('stage', '만료·이탈');
  }
  query = query.order('ends_on', { ascending: true, nullsFirst: false });
  // 단계는 오늘 기준으로 다시 계산하므로 유효 회원은 전부 받아서 거른다 (최대 수백 명)
  const big = !term && stage !== '만료·이탈';
  const { data, error, count } = big ? await query.range(0, 999) : await query.range(offset, offset + Math.min(limit, 100) - 1);
  if (error) throw error;
  let rows = data.map((m) => decorate(m, today));
  if (stage && stage !== '만료·이탈' && !term) rows = rows.filter((m) => m.stage === stage);
  if (stage === '홀딩') rows = data.map((m) => decorate(m, today)).filter((m) => m.holding);
  return [200, { members: big ? rows.slice(offset, offset + Math.min(limit, 100)) : rows, total: big ? rows.length : count }];
}

// ---------- 회원 상세 ----------
async function member({ id }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const today = todayKST();
  const [m, passes, payments, lockers, inquiries] = await Promise.all([
    supabase.from('crm_members').select('*').eq('id', id).maybeSingle(),
    supabase.from('crm_passes').select('id,product_name,category,status,starts_on,ends_on,total_count,remaining_count,trainer,price_paid,registered_on').eq('member_id', id).order('starts_on', { ascending: true }),
    supabase.from('crm_payments').select('amount,kind,method,staff_name,paid_at,pass_id').eq('member_id', id).order('paid_at', { ascending: true }),
    supabase.from('crm_locker_assignments').select('locker_no,status,starts_on,ends_on,price_paid,billing').eq('member_id', id).order('starts_on', { ascending: true }),
    supabase.from('crm_inquiries').select('inquired_at,raw_note,result').eq('member_id', id).order('inquired_at', { ascending: true }),
  ]);
  const err = m.error || passes.error || payments.error || lockers.error || inquiries.error;
  if (err) throw err;
  if (!m.data) return [404, { error: '회원을 찾을 수 없어요' }];
  const { checkin_code, subscriber_id, photo_path, ...safe } = m.data; // 출석 번호는 화면에 안 보낸다
  return [200, {
    member: { ...decorate(safe, today), photo_url: await photoUrl(photo_path) },
    passes: passes.data, payments: payments.data,
    lockers: lockers.data.map(({ lock_code, ...l }) => l),
    inquiries: inquiries.data,
  }];
}

// ---------- 락커 ----------
async function lockerBoard() {
  const today = todayKST();
  const [lockers, assigns] = await Promise.all([
    selectAll(() => supabase.from('crm_lockers').select('number,room,broken').order('number')),
    selectAll(() => supabase.from('crm_locker_assignments').select('locker_no,member_id,status,starts_on,ends_on').in('status', ['사용 중', '예정', '홀딩', '만료'])),
  ]);
  const ids = [...new Set(assigns.map((a) => a.member_id))];
  const names = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('crm_members').select('id,name').in('id', ids.slice(i, i + 200));
    if (error) throw error;
    data.forEach((m) => { names[m.id] = m.name; });
  }
  const by = {};
  assigns.forEach((a) => {
    const cur = by[a.locker_no];
    if (!cur || String(a.ends_on) > String(cur.ends_on)) by[a.locker_no] = a;
  });
  // 실제 배치도: 첫 번호부터 세로 8칸씩. 표에 없는 번호도 빈 칸으로 채운다.
  const nums = lockers.map((l) => l.number);
  const first = Math.min(...nums), last = first + Math.ceil((Math.max(...nums) - first + 1) / 8) * 8 - 1;
  const meta = Object.fromEntries(lockers.map((l) => [l.number, l]));
  const out = [];
  for (let n = first; n <= last; n++) {
    const a = by[n];
    if (!a) { out.push({ number: n, state: meta[n] && meta[n].broken ? '고장' : '미배정' }); continue; }
    const left = a.ends_on ? daysBetween(today, a.ends_on) : null;
    const state = a.status === '홀딩' ? '홀딩' : a.status === '예정' ? '예정' : left !== null && left < 0 ? '만료' : left !== null && left <= 14 ? '임박' : '활성';
    out.push({ number: n, state, name: names[a.member_id] || null, member_id: a.member_id, starts_on: a.starts_on, ends_on: a.ends_on, days_left: left });
  }
  return [200, { today, rows: 8, lockers: out }];
}

// ---------- 입실 체크 태블릿 ----------
// 태블릿은 관리자 비밀번호로 한 번 '기기 등록'을 하면 90일짜리 입실 전용 열쇠를 받는다.
// 이 열쇠로는 번호 찾기·입실·사진 저장만 되고, 회원 목록이나 매출은 볼 수 없다.
const PHOTO_BUCKET = 'member-photos';
const KIOSK_DAYS = 90;
const kioskKey = () => crypto.createHash('sha256').update(`990gym-kiosk|${process.env.ADMIN_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''}`).digest();
function kioskToken() {
  const body = Buffer.from(JSON.stringify({ scope: 'kiosk', exp: Date.now() + KIOSK_DAYS * DAY })).toString('base64url');
  return `k.${body}.${crypto.createHmac('sha256', kioskKey()).update(body).digest('base64url')}`;
}
function isKiosk(token) {
  if (typeof token !== 'string' || !token.startsWith('k.')) return false;
  const [, body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', kioskKey()).update(body || '').digest('base64url');
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try { const { scope, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()); return scope === 'kiosk' && exp > Date.now(); } catch (e) { return false; }
}

async function photoUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 10 * 60);
  return error ? null : data.signedUrl;
}
const maskName = (n) => { const s = String(n || ''); return s.length <= 1 ? s : s.length === 2 ? `${s[0]}○` : `${s[0]}${'○'.repeat(s.length - 2)}${s[s.length - 1]}`; };

async function kioskRegister() { return [200, { token: kioskToken(), days: KIOSK_DAYS }]; }

// 번호 뒷자리 4개로 찾기. 여러 명이면 이름 가운데를 가려서 고르게 한다.
async function checkinFind({ digits }) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length !== 4) return [400, { error: '번호 뒷자리 4개를 눌러주세요' }];
  const today = todayKST();
  const { data, error } = await supabase.from('crm_members').select('id,name,phone,stage,holding,ends_on,first_started_on,last_attended_on,photo_path').like('phone', `%-${d}`);
  if (error) throw error;
  const list = data.map((m) => decorate(m, today))
    .sort((a, b) => (a.stage === '만료·이탈') - (b.stage === '만료·이탈'));
  return [200, { matches: list.map((m) => ({ id: m.id, name: list.length > 1 ? maskName(m.name) : m.name, active: m.stage !== '만료·이탈', has_photo: !!m.photo_path })) }];
}

async function checkin({ id }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const today = todayKST();
  const { data: m, error } = await supabase.from('crm_members').select('id,name,stage,holding,ends_on,first_started_on,last_attended_on,total_visits,photo_path').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!m) return [404, { error: '회원을 찾을 수 없어요' }];
  const d = decorate(m, today);
  const [passes, recent] = await Promise.all([
    supabase.from('crm_passes').select('product_name,category,status,ends_on,remaining_count,total_count').eq('member_id', id).in('status', ['사용 중', '예정', '홀딩']),
    supabase.from('crm_attendance').select('checked_at').eq('member_id', id).gte('checked_at', new Date(Date.now() - 31 * DAY).toISOString()).order('checked_at', { ascending: false }),
  ]);
  if (passes.error || recent.error) throw passes.error || recent.error;
  const base = { name: m.name, photo_url: await photoUrl(m.photo_path), needs_photo: !m.photo_path };
  if (d.stage === '만료·이탈') return [200, { ...base, blocked: true, reason: '이용권이 끝났어요. 인포에 말씀해 주세요.' }];
  if (m.holding) return [200, { ...base, blocked: true, reason: '지금 홀딩 중이에요. 인포에 말씀해 주세요.' }];

  // 2시간 안에 이미 찍었으면 한 번으로 친다
  const last = recent.data[0] ? Date.parse(recent.data[0].checked_at) : 0;
  const again = Date.now() - last < 2 * 60 * 60 * 1000;
  if (!again) {
    const ins = await supabase.from('crm_attendance').insert({ member_id: id, via: '태블릿' });
    if (ins.error) throw ins.error;
    const up = await supabase.from('crm_members').update({ last_attended_on: today, total_visits: (m.total_visits || 0) + 1, updated_at: new Date().toISOString() }).eq('id', id);
    if (up.error) throw up.error;
  }
  const month = today.slice(0, 7);
  const thisMonth = recent.data.filter((r) => new Date(Date.parse(r.checked_at) + 9 * 3600e3).toISOString().slice(0, 7) === month).length + (again ? 0 : 1);
  const pt = passes.data.filter((p) => /PT/.test(p.product_name) || p.category === 'PT');
  const main = passes.data.filter((p) => !pt.includes(p)).sort((a, b) => String(b.ends_on).localeCompare(String(a.ends_on)))[0];
  return [200, { ...base, again, days_left: d.days_left, ends_on: m.ends_on, product: main ? main.product_name : null,
    pt_left: pt.reduce((a, p) => a + (p.remaining_count || 0), 0), pt_total: pt.reduce((a, p) => a + (p.total_count || 0), 0),
    this_month: thisMonth, first_time: !m.last_attended_on }];
}

// 첫 입실 사진 (태블릿 카메라). jpeg base64, 1MB 이하
async function photoUpload({ id, image }) {
  if (!id || typeof image !== 'string') return [400, { error: '필수 정보 누락' }];
  const b64 = image.replace(/^data:image\/jpeg;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 2000 || buf.length > 1024 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return [400, { error: '사진 형식이 맞지 않아요' }];
  const { data: m, error } = await supabase.from('crm_members').select('id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!m) return [404, { error: '회원을 찾을 수 없어요' }];
  const path = `${id}.jpg`;
  const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true });
  if (up.error) throw up.error;
  const u = await supabase.from('crm_members').update({ photo_path: path, photo_taken_at: new Date().toISOString() }).eq('id', id);
  if (u.error) throw u.error;
  return [200, { success: true, photo_url: await photoUrl(path) }];
}

const ACTIONS = { dashboard, members, member, lockerBoard, kioskRegister, checkinFind, checkin, photoUpload };
const KIOSK_OK = ['checkinFind', 'checkin', 'photoUpload'];

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const params = req.body || {};
  const fn = ACTIONS[params.action];
  if (!fn) return res.status(400).json({ error: '알 수 없는 요청' });
  const tk = bearer(req);
  const admin = await verifyToken(supabase, tk);
  if (!admin && !(KIOSK_OK.includes(params.action) && isKiosk(tk))) return res.status(401).json({ error: '로그인이 필요해요' });
  try {
    const [code, body] = await fn(params);
    return res.status(code).json(body);
  } catch (e) {
    console.error('crm', params.action, e);
    return res.status(500).json({ error: '서버 오류' });
  }
}
