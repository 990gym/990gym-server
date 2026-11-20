import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { cors, bearer, verifyToken } from './_auth.js';

// 990 CRM (보기 전용) — the990.co.kr/crm.html 이 부른다.
// 로그인은 관리자 페이지와 같다 (/api/admin 의 login 토큰을 그대로 쓴다).
// 회원·결제·이용권은 읽기만 한다. 바꾸는 건 입실 기록·회원 사진(태블릿), 할 일 완료, 직원 명단, 비용·목표 설정뿐이다.
// POST { action, ...params }  /  Authorization: Bearer <로그인 토큰>

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DAY = 24 * 60 * 60 * 1000;
const todayKST = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY); // b - a

// 홈페이지 월구독 (subscribers) ↔ 회원 맞추기
// 순서: ① 회원에 직접 연결해 둔 구독(가족 결제 등) ② 번호+이름 같음 ③ 이름만 같음(한 명일 때) ④ 번호만 같고 결제 중인 구독
// 하나도 없으면 브로제이 구독 이용권으로 본다 (자동결제라 만료로 안 셈)
const digitsOf = (p) => String(p || '').replace(/\D/g, '');
async function subsMap() { return memo('subs', 60000, subsMapRaw); }
async function subsMapRaw() {
  const [subs, bj] = await Promise.all([
    supabase.from('subscribers').select('id,name,phone,plan,status,next_billing_date,cancelled_at,paused_at,created_at').order('created_at', { ascending: true }),
    selectAll(() => supabase.from('crm_passes').select('member_id').in('status', ['사용 중', '예정', '홀딩']).ilike('product_name', '%구독%')),
  ]);
  if (subs.error) throw subs.error;
  const S = { byId: {}, byPN: {}, byName: {}, byPhone: {}, bj: new Set(bj.map((r) => r.member_id)) };
  (subs.data || []).forEach((r) => {
    const p = digitsOf(r.phone), n = String(r.name || '').trim();
    S.byId[r.id] = r;
    if (p && n) S.byPN[`${p}|${n}`] = r;
    if (n) (S.byName[n] = S.byName[n] || []).push(r);
    if (p) S.byPhone[p] = r; // 같은 번호면 최근 가입 것
  });
  return S;
}
function subOf(m, S) {
  if (!S) return null;
  if (m.subscriber_id && S.byId[m.subscriber_id]) return S.byId[m.subscriber_id];
  const p = digitsOf(m.phone), n = String(m.name || '').trim();
  if (p && S.byPN[`${p}|${n}`]) return S.byPN[`${p}|${n}`];
  const byN = S.byName[n];
  if (byN && byN.length === 1) return byN[0];
  const byP = p && S.byPhone[p];
  if (byP && ['active', 'payment_failed'].includes(byP.status)) return byP;
  return null;
}
// 월구독 상태: 자동결제 중이면 만료 계산을 안 하고, 해지 신청·결제 실패만 끝나는 날을 본다
function subState(sub, today, m, S) {
  if (!sub) {
    // 홈페이지 구독과 못 맞춘 브로제이 구독 이용권: 자동결제로 보고, 이용권이 끝난 지 10일 넘으면 만료로 본다
    if (m && S && S.bj.has(m.id) && (!m.ends_on || daysBetween(m.ends_on, today) <= 10)) return { kind: '구독 중', next: m.ends_on, unlinked: true };
    return null;
  }
  if (sub.status === 'active') return { kind: sub.paused_at ? '쉬어가기' : '구독 중', next: sub.next_billing_date };
  if (sub.status === 'payment_failed') return { kind: '결제 실패', end: sub.next_billing_date };
  if (sub.status === 'cancelled') return { kind: '해지 신청', end: sub.next_billing_date };
  return null;
}

// 오늘 날짜 기준으로 단계를 다시 계산 (이관 때 정한 규칙과 같다)
function liveStage(m, today, ss) {
  const started0 = m.first_started_on ? daysBetween(m.first_started_on, today) : null;
  const absent0 = m.last_attended_on ? daysBetween(m.last_attended_on, today) : null;
  if (ss && ss.kind === '구독 중' || ss && ss.kind === '쉬어가기') { // 월구독은 만료 인원으로 안 센다
    if (!m.holding && ss.kind !== '쉬어가기' && (absent0 === null || absent0 >= 14) && !(started0 !== null && started0 < 14)) return '미출석';
    if (started0 !== null && started0 <= 28) return '체험·신규';
    return '정착';
  }
  if (ss && ss.kind === '결제 실패') return ss.end && daysBetween(ss.end, today) <= 14 ? '만료 예정' : '만료·이탈';
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

const MEMBER_COLS = 'id,name,phone,gender,usage_tag,stage,holding,first_started_on,ends_on,last_attended_on,total_visits,lifetime_paid,counselor,trainer,source,marketing_consent,memo,subscriber_id';

// 1000줄씩 나눠 받기. 서버(미국)와 DB(도쿄)가 멀어서 한 번에 4쪽씩 동시에 받는다.
async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += 4000) {
    const pages = await Promise.all([0, 1, 2, 3].map((i) => build().range(from + i * 1000, from + i * 1000 + 999)));
    for (const { data, error } of pages) {
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
}
// 같은 서버가 연달아 받으면 잠깐 기억해 둔 결과를 쓴다 (바꾸는 요청이 오면 지운다)
const CACHE = new Map();
async function memo(key, ms, fn) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.val;
  const val = await fn();
  CACHE.set(key, { at: Date.now(), val });
  return val;
}
const clearCache = () => CACHE.clear();

function decorate(m0, today, subs) {
  const ss = subState(subOf(m0, subs), today, m0, subs);
  // 해지 신청·결제 실패한 구독은 결제된 날까지 쓴다 (그 날이 이미 지났으면 브로제이 기간을 본다)
  const m = ss && ss.end && ss.end >= today ? { ...m0, ends_on: ss.end } : m0;
  const live = ss && (ss.kind === '구독 중' || ss.kind === '쉬어가기');
  const stage = liveStage(m, today, ss);
  return {
    ...m,
    holding: m.holding || (ss && ss.kind === '쉬어가기') || false,
    stage,
    sub: ss ? ss.kind : null, next_billing: live ? ss.next : null, sub_linked: ss ? !ss.unlinked : false,
    days_left: live ? null : m.ends_on ? daysBetween(today, m.ends_on) : null,
    days_absent: m.last_attended_on ? daysBetween(m.last_attended_on, today) : null,
  };
}

function lockerTotal(rows) {
  if (!rows || !rows.length) return 0;
  const nums = rows.map((l) => l.number);
  const first = Math.min(...nums);
  return Math.ceil((Math.max(...nums) - first + 1) / 8) * 8; // 배치도 칸 수 (세로 8칸씩)
}

// 매출 묶음: PT는 따로(+α), 나머지는 전부 회원권(헬스·월구독·GX·락커 등)
function salesGroup(name, cat) {
  const n = String(name || '');
  if (cat === 'PT' || /PT|피티/i.test(n)) return 'PT';
  if (cat === 'GX 무제한' || /GX|스피닝|줌바|요가|필라|VIP|V\.I\.P|올엑세스|올액세스/.test(n)) return 'GX';
  if (cat === '월구독' || /구독/.test(n)) return '월구독';
  if (cat === '헬스 기간권' || /헬스|개월/.test(n)) return '헬스';
  return '기타';
}
const MEMBERSHIP = ['헬스', '월구독', 'GX', '기타'];
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const kstHour = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).getUTCHours();

const DEFAULT_FINANCE = { profit: 5000000, costs: [] };
async function getFinance() {
  const { data, error } = await supabase.from('crm_settings').select('value').eq('key', 'finance').maybeSingle();
  if (error) throw error;
  const v = (data && data.value) || DEFAULT_FINANCE;
  const costs = (v.costs || []).filter((c) => c && c.name).map((c) => ({ name: String(c.name).slice(0, 40), amount: Math.max(0, Math.round(Number(c.amount) || 0)), note: c.note ? String(c.note).slice(0, 80) : '' }));
  const floor = costs.reduce((a, c) => a + c.amount, 0);
  const profit = Math.max(0, Math.round(Number(v.profit) || 0));
  // PT 강사비(트레이너·매니저 급여)는 매출 따라 움직이니 손익표 최근 3개월 평균으로 잡는다
  const pnl = await supabase.from('crm_pnl_monthly').select('ym,pt_pay').order('ym', { ascending: false }).limit(3);
  if (pnl.error) throw pnl.error;
  const ptAvg = pnl.data.length ? Math.round(pnl.data.reduce((a, r) => a + Number(r.pt_pay), 0) / pnl.data.length) : 0;
  const ptFrom = pnl.data.length ? `${pnl.data[pnl.data.length - 1].ym}~${pnl.data[0].ym}` : null;
  const ptManual = v.ptPay != null && v.ptPay !== '' ? Math.max(0, Math.round(Number(v.ptPay) || 0)) : null; // 직접 넣으면 그걸 쓴다
  const ptPay = ptManual != null ? ptManual : ptAvg;
  return { costs, profit, floor, ptPay, ptAvg, ptManual, ptFrom, breakeven: floor + ptPay, target: floor + ptPay + profit };
}

// 결제 + 상품 이름 (매출 묶음 계산용)
async function passesByIds(ids, known = {}) {
  const need = [...new Set(ids.filter((id) => id && !known[id]))];
  const chunks = [];
  for (let i = 0; i < need.length; i += 150) chunks.push(need.slice(i, i + 150));
  const res = await Promise.all(chunks.map((c) => supabase.from('crm_passes').select('id,product_name,category').in('id', c)));
  const out = { ...known };
  for (const { data, error } of res) { if (error) throw error; data.forEach((p) => { out[p.id] = p; }); }
  return out;
}
async function paymentsWithGroup(fromISO, known, toISO) {
  const pays = await selectAll(() => { let q = supabase.from('crm_payments').select('amount,paid_at,pass_id,member_id,kind').gte('paid_at', fromISO); if (toISO) q = q.lt('paid_at', toISO); return q; });
  const pm = await passesByIds(pays.map((p) => p.pass_id), known);
  return pays.map((p) => { const ps = pm[p.pass_id] || {}; return { ...p, day: kstDate(p.paid_at), group: salesGroup(ps.product_name, ps.category) }; });
}

// ---------- 오늘 할 일 ----------
// 할 일은 매일 회원 상태로 새로 만든다. key 에 기준 날짜가 들어가서, 재등록·출석하면 그 할 일은 저절로 사라진다.
function buildTasks(all, today, inGym, passByMember) {
  const out = [];
  const prod = (m) => passByMember[m.id] || m.usage_tag || '이용권';
  const lastTxt = (m) => (m.last_attended_on ? (m.days_absent === 0 ? '오늘 출석' : m.days_absent === 1 ? '어제 출석' : `마지막 출석 ${+m.last_attended_on.slice(5, 7)}.${+m.last_attended_on.slice(8)}`) : '방문 기록 없음');
  for (const m of all) {
    const base = { member_id: m.id, name: m.name, phone: m.phone, in_gym: inGym[m.id] || null };
    if (m.sub === '결제 실패' && m.stage === '만료 예정') {
      out.push({ ...base, key: `pay:${m.id}:${m.ends_on}`, kind: '결제 실패', stage: '만료 예정', tag: '결제 실패',
        title: '월구독 카드 결제가 실패했어요', sub: ['월구독', lastTxt(m)], action: '카드 변경 안내', group: '지금 바로' });
    } else if (m.stage === '만료 예정' && !m.holding && m.days_left >= 0) {
      const d = m.days_left, cancel = m.sub === '해지 신청';
      out.push({ ...base, key: `exp:${m.id}:${m.ends_on}`, kind: '재등록', stage: '만료 예정', tag: cancel ? `해지 신청 · D-${d}` : d === 0 ? '오늘 만료' : `D-${d}`,
        title: cancel ? (d === 0 ? '구독이 오늘 끝나요 (해지 신청)' : `구독이 ${d}일 뒤 끝나요 (해지 신청)`) : d === 0 ? '회원권이 오늘 끝나요' : `회원권이 ${d}일 뒤 끝나요`, sub: [cancel ? '월구독' : prod(m), lastTxt(m)],
        action: cancel ? '쉬어가기 안내' : d <= 7 ? '재등록 직접 안내' : '재등록 안내 문자', group: d <= 3 ? '지금 바로' : d <= 7 ? '오늘 안에' : '이번 주 안에' });
    } else if (m.stage === '미출석' && !m.holding) {
      const a = m.days_absent;
      if (a != null && a >= 14 && a <= 20) out.push({ ...base, key: `abs14:${m.id}:${m.last_attended_on}`, kind: '미출석', stage: '미출석', tag: '2주',
        title: `${a}일째 안 오셨어요`, sub: [prod(m), lastTxt(m)], action: '안부 문자', group: '이번 주 안에' });
      else if (a != null && a >= 30 && a <= 37) out.push({ ...base, key: `abs30:${m.id}:${m.last_attended_on}`, kind: '미출석', stage: '미출석', tag: '장기',
        title: `${a}일째 안 오셨어요`, sub: [prod(m), lastTxt(m)], action: '홀딩·연장 제안', group: '이번 주 안에' });
      else if (a == null && m.first_started_on) {
        const s = daysBetween(m.first_started_on, today);
        if (s >= 14 && s <= 30) out.push({ ...base, key: `nov:${m.id}:${m.first_started_on}`, kind: '미출석', stage: '미출석', tag: '첫 방문 없음',
          title: `등록 ${s}일째인데 한 번도 안 오셨어요`, sub: [prod(m), '방문 기록 없음'], action: '방문 날짜 잡기', group: '오늘 안에' });
      }
    } else if (m.stage === '체험·신규' && m.first_started_on) {
      const s = daysBetween(m.first_started_on, today);
      if (s >= 3 && s <= 13 && (m.days_absent == null || m.days_absent >= 5)) out.push({ ...base, key: `new:${m.id}:${m.first_started_on}`, kind: '신규', stage: '체험·신규', tag: m.days_absent == null ? '첫 방문 없음' : '신규',
        title: m.days_absent == null ? `등록 ${s}일째, 아직 첫 방문이 없어요` : `등록 ${s}일째인데 ${m.days_absent}일째 안 오세요`, sub: [prod(m), lastTxt(m)], action: m.days_absent == null ? '방문 날짜 잡기' : '안부 문자', group: '오늘 안에' });
    } else if (m.stage === '만료·이탈' && m.ends_on) {
      const e = daysBetween(m.ends_on, today);
      if (e >= 1 && e <= 14) out.push({ ...base, key: `lapse:${m.id}:${m.ends_on}`, kind: '복귀', stage: '만료·이탈', tag: `만료 ${e}일`,
        title: '만료 후 재등록을 안 하셨어요', sub: [prod(m), `총 ${m.total_visits || 0}회 출석`], action: '복귀 안내 문자', group: '이번 주 안에' });
    }
  }
  // 지금 센터에 계신 분은 맨 위로
  out.forEach((t) => { if (t.in_gym) t.group = '지금 바로'; });
  const G = { '지금 바로': 0, '오늘 안에': 1, '이번 주 안에': 2 };
  return out.sort((a, b) => G[a.group] - G[b.group] || String(a.title).localeCompare(String(b.title)));
}

// ---------- 대시보드 ----------
async function dashboard() { return memo('dashboard', 20000, dashboardRaw); }
async function dashboardRaw() {
  const today = todayKST();
  const month = today.slice(0, 7);
  const recentCut = new Date(Date.parse(today) - 400 * DAY).toISOString().slice(0, 10);
  const todayStartISO = new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString();
  const monthStartISO = new Date(Date.parse(`${month}-01T00:00:00+09:00`)).toISOString();
  const [members, allPasses, _pays, lockers, assigns, inq, totalCount, snap, att, attPast, finance, staff, subs, doneRows] = await Promise.all([
    Promise.all([
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).neq('stage', '만료·이탈')),
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).eq('stage', '만료·이탈').gte('ends_on', recentCut)),
    ]).then(([a, b]) => a.concat(b)),
    // 최근 200일 안에 끝나거나 아직 안 끝난 이용권만 (6개월 추이·이용권 구성에 충분)
    Promise.all([
      selectAll(() => supabase.from('crm_passes').select('id,member_id,category,product_name,status,starts_on,ends_on,remaining_count,total_count').gte('ends_on', new Date(Date.parse(today) - 200 * DAY).toISOString().slice(0, 10))),
      selectAll(() => supabase.from('crm_passes').select('id,member_id,category,product_name,status,starts_on,ends_on,remaining_count,total_count').is('ends_on', null)),
    ]).then(([a, b]) => a.concat(b)),
    null,
    supabase.from('crm_lockers').select('number'),
    selectAll(() => supabase.from('crm_locker_assignments').select('locker_no,member_id,status,ends_on').in('status', ['사용 중', '예정', '홀딩'])),
    supabase.from('crm_inquiries').select('id,name,phone,source,summary,staff_name,return_on,result,inquired_at,member_id').gte('inquired_at', new Date(Date.parse(today) - 30 * DAY).toISOString()),
    supabase.from('crm_members').select('id', { count: 'exact', head: true }),
    supabase.from('crm_members').select('created_at').order('created_at', { ascending: false }).limit(1),
    selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').gte('checked_at', todayStartISO)),
    selectAll(() => supabase.from('crm_attendance').select('checked_at').gte('checked_at', new Date(Date.parse(todayStartISO) - 28 * DAY).toISOString()).lt('checked_at', todayStartISO)),
    getFinance(),
    supabase.from('crm_staff').select('id,name,role').eq('active', true).order('created_at'),
    subsMap(),
    selectAll(() => supabase.from('crm_tasks').select('task_key,done_by,done_at,kind').gte('done_at', monthStartISO)),
  ]);
  for (const r of [lockers, inq, totalCount, snap, staff]) if (r.error) throw r.error;
  const pays = await paymentsWithGroup(monthStartISO, Object.fromEntries(allPasses.map((p) => [p.id, p])));

  const all = members.map((m) => decorate(m, today, subs));
  const active = all.filter((m) => m.stage !== '만료·이탈');
  const stages = { '체험·신규': 0, '정착': 0, '미출석': 0, '만료 예정': 0 };
  active.forEach((m) => { stages[m.stage] = (stages[m.stage] || 0) + 1; });
  const byId = Object.fromEntries(all.map((m) => [m.id, m]));

  // 이용권 구성: 한 사람당 하나로 (올엑세스 > 월구독 > 기간권)
  const live = allPasses.filter((p) => ['사용 중', '예정', '홀딩'].includes(p.status));
  const kinds = {}, ptLeft = {}, ptKind = {}, mainPass = {};
  live.forEach((p) => {
    const m = byId[p.member_id]; if (!m || m.stage === '만료·이탈') return;
    const g = salesGroup(p.product_name, p.category);
    (kinds[p.member_id] = kinds[p.member_id] || new Set()).add(g);
    if (g === 'PT') { ptLeft[p.member_id] = (ptLeft[p.member_id] || 0) + (p.remaining_count || 0); if (/체험/.test(p.product_name)) ptKind[p.member_id] = '체험'; }
    else if (!mainPass[p.member_id] || String(p.ends_on) > String(mainPass[p.member_id].ends_on)) mainPass[p.member_id] = p;
  });
  const comp = { '기간권': 0, '월구독': 0, '올엑세스': 0 };
  active.forEach((m) => { const k = kinds[m.id] || new Set(); comp[k.has('GX') ? '올엑세스' : (m.sub === '구독 중' || m.sub === '쉬어가기' || k.has('월구독')) ? '월구독' : '기간권']++; });
  const pt = { '진행 중': 0, '곧 끝남': 0, '쉬는 중': 0, '체험 PT': 0 };
  Object.entries(ptLeft).forEach(([id, left]) => {
    const m = byId[id];
    if (ptKind[id] === '체험') pt['체험 PT']++;
    else if (m && m.days_absent != null && m.days_absent >= 14) pt['쉬는 중']++;
    else if (left <= 3) pt['곧 끝남']++;
    else pt['진행 중']++;
  });

  // 최근 6개월 유효 회원 (각 달 마지막 날 기준, 오늘 달은 오늘)
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.parse(`${month}-01`)); d.setUTCMonth(d.getUTCMonth() - i + 1); d.setUTCDate(0);
    const at = i === 0 ? today : d.toISOString().slice(0, 10);
    const set = new Set();
    allPasses.forEach((p) => { if (!['무효', '환불'].includes(p.status) && p.starts_on && p.ends_on && p.starts_on <= at && p.ends_on >= at && salesGroup(p.product_name, p.category) !== 'PT') set.add(p.member_id); });
    trend.push({ month: at.slice(0, 7), count: set.size });
  }

  // 출석 (입실 체크 태블릿)
  const nowMs = Date.now();
  const inGym = {}, hours = Array(24).fill(0), seenToday = new Set();
  att.forEach((a) => {
    seenToday.add(a.member_id); hours[kstHour(a.checked_at)]++;
    if (nowMs - Date.parse(a.checked_at) < 2 * 3600e3) inGym[a.member_id] = new Date(Date.parse(a.checked_at) + 9 * 3600e3).toISOString().slice(11, 16);
  });
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const usual = Array(24).fill(0); const usualDays = new Set();
  attPast.forEach((a) => { const d = kstDate(a.checked_at); if (new Date(`${d}T00:00:00Z`).getUTCDay() === dow) { usual[kstHour(a.checked_at)]++; usualDays.add(d); } });
  const nUsual = usualDays.size || 1;

  // 이번 달 매출
  const days = Number(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate());
  const sales = { 헬스: 0, 월구독: 0, GX: 0, 기타: 0, PT: 0 };
  const daily = Array(days).fill(0);
  pays.forEach((p) => { if (p.day.slice(0, 7) !== month) return; sales[p.group] += p.amount; daily[+p.day.slice(8) - 1] += p.amount; });
  const membership = MEMBERSHIP.reduce((a, k) => a + sales[k], 0);
  const lastPay = pays.reduce((a, p) => (p.day > a ? p.day : a), '');

  // 할 일
  const passName = Object.fromEntries(Object.entries(mainPass).map(([id, p]) => [id, p.product_name]));
  const tasks = buildTasks(all, today, inGym, passName);
  // 문의 리턴 연락: 결과가 아직 없고 리턴 날짜가 오늘이거나 지난 문의 (7일 안)
  inq.data.filter((q) => !q.result && !q.member_id && q.return_on && q.return_on <= today && daysBetween(q.return_on, today) <= 7).forEach((q) => {
    const sm = parseInqSummary(q.summary);
    const late = daysBetween(q.return_on, today);
    tasks.push({ key: `inq:${q.id}:${q.return_on}`, member_id: null, inquiry_id: q.id, name: q.name, phone: q.phone, in_gym: null, kind: '유입', stage: '유입',
      tag: `리턴${late ? ` ${late}일 지남` : ' 오늘'}`, title: `상담 ${daysBetween(kstDate(q.inquired_at), today)}일째 · 리턴 연락할 날`,
      sub: [q.source || '문의', ...(sm.reason ? [`미등록 사유: ${sm.reason}`] : []), ...(q.staff_name ? [`상담 ${q.staff_name}`] : [])], action: '리턴 전화', group: '오늘 안에' });
  });
  const done = Object.fromEntries(doneRows.map((r) => [r.task_key, r]));
  const doneToday = doneRows.filter((r) => kstDate(r.done_at) === today);
  const list = tasks.filter((t) => !done[t.key] || kstDate(done[t.key].done_at) === today)
    .map((t) => (done[t.key] ? { ...t, done: true, done_by: done[t.key].done_by, done_at: done[t.key].done_at } : t));
  const staffStats = {};
  (staff.data || []).forEach((s) => { staffStats[s.name] = { today: 0, month: 0 }; });
  doneRows.forEach((r) => { const s = (staffStats[r.done_by] = staffStats[r.done_by] || { today: 0, month: 0 }); s.month++; if (kstDate(r.done_at) === today) s.today++; });

  const thisMonthLapsed = all.filter((m) => m.stage === '만료·이탈' && m.ends_on && m.ends_on.slice(0, 7) === month).length;
  return [200, {
    today, now: new Date().toISOString(),
    snapshotAt: snap.data[0] ? snap.data[0].created_at : null, lastPayDay: lastPay || null,
    totals: {
      members: totalCount.count, active: active.length, holding: active.filter((m) => m.holding).length,
      inquiries30: inq.data.filter((q) => !q.result || q.result === '상담 중').length, lapsedThisMonth: thisMonthLapsed,
      lockers: lockerTotal(lockers.data), lockersUsed: new Set(assigns.map((a) => a.locker_no)).size,
      lockerSoon: assigns.filter((a) => a.ends_on && daysBetween(today, a.ends_on) >= 0 && daysBetween(today, a.ends_on) <= 7).length,
      ptMembers: Object.keys(ptLeft).length, ptSessionsLeft: Object.values(ptLeft).reduce((a, b) => a + b, 0),
      endingToday: active.filter((m) => m.days_left === 0).length,
      subscribers: comp['월구독'], subCancel: all.filter((m) => m.sub === '해지 신청' && m.stage === '만료 예정').length, subFail: all.filter((m) => m.sub === '결제 실패' && m.stage === '만료 예정').length,
    },
    stages, comp, pt, trend,
    attendance: { now: Object.keys(inGym).length, today: seenToday.size, hours, usual: usual.map((v) => Math.round((v / nUsual) * 10) / 10), hasUsual: usualDays.size > 0 },
    sales: { month, days, byGroup: sales, membership, pt: sales.PT, total: membership + sales.PT, daily, target: finance.target, breakeven: finance.breakeven, floor: finance.floor, ptPay: finance.ptPay, profit: finance.profit },
    tasks: list, doneToday: doneToday.length,
    staff: (staff.data || []).map((s) => ({ ...s, ...(staffStats[s.name] || { today: 0, month: 0 }) })),
  }];
}

// ---------- 할 일 완료 ----------
const TASK_KEY = /^(exp|pay|abs14|abs30|nov|new|lapse|inq):[0-9a-f-]{36}:[0-9-]{0,10}$/;
async function taskDone({ key, staff, note }) {
  if (!TASK_KEY.test(String(key || ''))) return [400, { error: '할 일 정보가 맞지 않아요' }];
  const name = String(staff || '').trim();
  if (!name) return [400, { error: '처리한 직원을 골라주세요' }];
  const s = await supabase.from('crm_staff').select('id').eq('name', name).eq('active', true).maybeSingle();
  if (s.error) throw s.error;
  if (!s.data) return [400, { error: '직원 명단에 없는 이름이에요' }];
  const [kind, refId] = key.split(':');
  const isInq = kind === 'inq';
  const member_id = isInq ? null : refId;
  const ins = await supabase.from('crm_tasks').upsert({ task_key: key, member_id, inquiry_id: isInq ? refId : null, kind, due_on: todayKST(), done_at: new Date().toISOString(), done_by: name, result: note ? String(note).slice(0, 300) : null }, { onConflict: 'task_key' });
  if (ins.error) throw ins.error;
  if (isInq) return [200, { success: true }];
  await supabase.from('crm_events').insert({ member_id, kind: '할 일', body: `${({ exp: '재등록 안내', pay: '결제 실패 안내', abs14: '미출석 안부', abs30: '장기 미출석 연락', nov: '첫 방문 연락', new: '신규 안부', lapse: '복귀 안내' })[kind]} 완료${note ? ` · ${String(note).slice(0, 300)}` : ''}`, staff_name: name });
  return [200, { success: true }];
}
async function taskUndo({ key }) {
  if (!TASK_KEY.test(String(key || ''))) return [400, { error: '할 일 정보가 맞지 않아요' }];
  const del = await supabase.from('crm_tasks').delete().eq('task_key', key).gte('done_at', new Date(Date.parse(`${todayKST()}T00:00:00+09:00`)).toISOString());
  if (del.error) throw del.error;
  return [200, { success: true }];
}

// ---------- 문의 등록 (AI 정리는 나중에) ----------
// summary 에 미등록 사유·관심 상품·다음 할 일을 JSON 으로 담는다
function parseInqSummary(t) { try { const v = JSON.parse(t || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return t ? { note: t } : {}; } }
const INQ_SOURCES = ['워크인', '전화 문의', '네이버 검색', '인스타 DM', '지인소개', '990홈페이지', '전단지', '당근', '기타'];
async function inquiryAdd({ name, phone, source, staff, note, reason, interest, next, return_on }) {
  const n = String(name || '').trim().slice(0, 30);
  const digits = String(phone || '').replace(/\D/g, '');
  if (!n) return [400, { error: '이름을 적어주세요' }];
  const ph = digits.length === 11 ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}` : digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : (phone ? String(phone).slice(0, 20) : null);
  const ret = /^\d{4}-\d{2}-\d{2}$/.test(String(return_on || '')) ? return_on : new Date(Date.parse(todayKST()) + 3 * DAY).toISOString().slice(0, 10);
  // 이미 회원이면 알려준다
  let existing = null;
  if (ph) { const ex = await supabase.from('crm_members').select('id,name').eq('phone', ph).limit(3); if (ex.error) throw ex.error; existing = (ex.data || []).find((m) => m.name === n) || null; }
  const summary = JSON.stringify({ reason: reason ? String(reason).slice(0, 60) : '', interest: interest ? String(interest).slice(0, 60) : '', next: next ? String(next).slice(0, 200) : '' });
  const { data, error } = await supabase.from('crm_inquiries').insert({ name: n, phone: ph, source: INQ_SOURCES.includes(source) ? source : '기타', raw_note: note ? String(note).slice(0, 2000) : null, summary, staff_name: staff ? String(staff).slice(0, 20) : null, return_on: ret, result: null, member_id: existing ? existing.id : null, inquired_at: new Date().toISOString() }).select('id').maybeSingle();
  if (error) throw error;
  return [200, { success: true, id: data && data.id, existing, return_on: ret }];
}
async function inquiryList({ days = 60 }) {
  const { data, error } = await supabase.from('crm_inquiries').select('id,legacy_id,name,phone,source,raw_note,summary,staff_name,return_on,result,member_id,inquired_at').gte('inquired_at', new Date(Date.now() - Math.min(365, Number(days) || 60) * DAY).toISOString()).order('inquired_at', { ascending: false }).limit(200);
  if (error) throw error;
  return [200, { inquiries: data.map((q) => ({ ...q, ...parseInqSummary(q.summary), from_notion: String(q.legacy_id || '').startsWith('notion:'), legacy_id: undefined, summary: undefined })), sources: INQ_SOURCES, sync: await syncStatus() }];
}
async function inquiryUpdate({ id, result, reason, return_on }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const cur = await supabase.from('crm_inquiries').select('summary').eq('id', id).maybeSingle();
  if (cur.error) throw cur.error;
  if (!cur.data) return [404, { error: '문의를 찾을 수 없어요' }];
  const patch = {};
  if (result !== undefined) patch.result = ['등록', '미등록', '상담 중'].includes(result) ? result : null;
  if (return_on !== undefined) patch.return_on = /^\d{4}-\d{2}-\d{2}$/.test(String(return_on || '')) ? return_on : null;
  if (reason !== undefined) { const sm = parseInqSummary(cur.data.summary); sm.reason = String(reason || '').slice(0, 60); patch.summary = JSON.stringify(sm); }
  const { error } = await supabase.from('crm_inquiries').update(patch).eq('id', id);
  if (error) throw error;
  return inquiryList({});
}

// ---------- PT 현황 ----------
async function ptBoard({ period = 'month' }) {
  const today = todayKST();
  const month = period === 'lastmonth' ? new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1)).toISOString().slice(0, 7) : today.slice(0, 7);
  const from = period === 'year' ? `${today.slice(0, 4)}-01-01` : `${month}-01`;
  const to = period === 'year' ? today : new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
  const COLS = 'id,member_id,product_name,category,status,starts_on,ends_on,total_count,remaining_count,trainer,price_paid,registered_on';
  const [a, b] = await Promise.all([
    selectAll(() => supabase.from('crm_passes').select(COLS).eq('category', 'PT')),
    selectAll(() => supabase.from('crm_passes').select(COLS).ilike('product_name', '%PT%')),
  ]);
  const passes = [...new Map(a.concat(b).map((p) => [p.id, p])).values()];
  const pts = passes.filter((p) => salesGroup(p.product_name, p.category) === 'PT' && p.status !== '무효');
  const live = pts.filter((p) => ['사용 중', '예정', '홀딩'].includes(p.status));
  const ids = [...new Set(pts.map((p) => p.member_id))];
  const names = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('crm_members').select('id,name,phone,last_attended_on,trainer').in('id', ids.slice(i, i + 150));
    if (error) throw error;
    data.forEach((m) => { names[m.id] = m; });
  }
  const unit = (p) => (p.total_count ? Math.round((p.price_paid || 0) / p.total_count) : 0);
  const sess = await selectAll(() => supabase.from('crm_pt_sessions').select('pass_id,member_id,trainer,unit_price,at').gte('at', kstStart(from)).lt('at', kstEndEx(to))).catch(() => []);
  const dailySess = {}; sess.forEach((x) => { const d = kstDate(x.at); dailySess[d] = (dailySess[d] || 0) + 1; });
  const trainerOf = (p) => (p.trainer || (names[p.member_id] && names[p.member_id].trainer) || '미지정').replace(/쌤|선생님|T$/g, '').trim() || '미지정';
  const newOnes = pts.filter((p) => p.registered_on && p.registered_on >= from && p.registered_on <= to);
  const rows = live.map((p) => {
    const m = names[p.member_id] || {};
    const absent = m.last_attended_on ? daysBetween(m.last_attended_on, today) : null;
    const left = p.remaining_count || 0, total = p.total_count || 0, dl = p.ends_on ? daysBetween(today, p.ends_on) : null;
    const trial = /체험/.test(p.product_name || '');
    let state = '정상';
    if (trial) state = '체험';
    else if (left <= 3) state = '곧 끝남';
    else if (absent != null && absent >= 14) state = '수업 정체';
    else if (dl != null && dl <= 14 && left >= 4) state = `기간 D-${Math.max(dl, 0)}`;
    else if (p.registered_on && daysBetween(p.registered_on, today) <= 14) state = '신규';
    return { id: p.id, member_id: p.member_id, name: m.name || '-', phone: m.phone || null, trainer: trainerOf(p), product: p.product_name, total, left, used: Math.max(0, total - left), left_amount: left * unit(p), price: p.price_paid || 0, ends_on: p.ends_on, days_left: dl, absent, state };
  }).sort((a, b) => b.left - a.left);
  // 노션 PT회원관리가 연동돼 있으면 그쪽(선생님들이 매일 입력)을 기준으로 한다
  const [nrows, nlogs] = await Promise.all([
    selectAll(() => supabase.from('crm_pt_notion').select('*')),
    selectAll(() => supabase.from('crm_pt_notion_log').select('notion_id,trainer,member_id,delta,day').gte('day', from).lte('day', to)),
  ]);
  const source = nrows.length ? 'notion' : 'broj';
  if (nrows.length) {
    const miss = [...new Set(nrows.map((n) => n.member_id).filter((id) => id && !names[id]))];
    for (let i = 0; i < miss.length; i += 150) { const { data } = await supabase.from('crm_members').select('id,name,phone,last_attended_on,trainer').in('id', miss.slice(i, i + 150)); (data || []).forEach((m) => { names[m.id] = m; }); }
    const passOf = {}; live.forEach((p) => { if (!passOf[p.member_id] || String(p.ends_on) > String(passOf[p.member_id].ends_on)) passOf[p.member_id] = p; });
    rows.length = 0;
    nrows.filter((n) => n.status !== '완료').forEach((n) => {
      const p = passOf[n.member_id] || null, m = names[n.member_id] || {};
      const total = n.total || 0, used = n.used || 0, left = n.remaining != null ? n.remaining : Math.max(0, total - used);
      const u = p ? unit(p) : 0, dl = p && p.ends_on ? daysBetween(today, p.ends_on) : null;
      let state = n.status === '쉬는 중' ? '수업 정체' : left <= 3 ? '곧 끝남' : dl != null && dl <= 14 && left >= 4 ? `기간 D-${Math.max(dl, 0)}` : n.status === '시작 전' ? '시작 전' : '정상';
      rows.push({ id: n.notion_id, member_id: n.member_id, name: n.name, phone: m.phone || null, trainer: n.trainer, product: n.status || '', total, left, used, left_amount: left * u, price: p ? p.price_paid || 0 : 0, ends_on: p ? p.ends_on : null, days_left: dl, absent: m.last_attended_on ? daysBetween(m.last_attended_on, today) : null, state, matched: n.matched, edited: n.notion_edited_at });
    });
    rows.sort((a, b) => b.left - a.left);
  }
  const tr = {};
  rows.forEach((r) => { const t = (tr[r.trainer] = tr[r.trainer] || { trainer: r.trainer, members: new Set(), left: 0, used: 0, left_amount: 0, used_amount: 0, new_amount: 0, new_count: 0 }); t.members.add(r.member_id); t.left += r.left; t.used += r.used; t.left_amount += r.left_amount; t.used_amount += r.used * (r.total ? Math.round(r.price / r.total) : 0); });
  // 노션은 '진우'처럼 이름만, 브로제이·직원 명단은 '박진우'처럼 성까지 → 같은 사람으로 맞춘다
  const nTrainers = [...new Set(nrows.map((n) => n.trainer))];
  const tKey = (t) => (source === 'notion' && t && t !== '미지정' ? nTrainers.find((n) => t === n || t.endsWith(n)) || t : t);
  newOnes.forEach((p) => { const k = tKey(trainerOf(p)); const t = (tr[k] = tr[k] || { trainer: k, members: new Set(), left: 0, used: 0, left_amount: 0, used_amount: 0, new_amount: 0, new_count: 0 }); t.new_amount += p.price_paid || 0; t.new_count += p.total_count || 0; });
  if (source === 'notion') Object.keys(tr).forEach((k) => { const v = tr[k]; if (!v.members.size && !v.new_amount && !v.left) delete tr[k]; });
  const unitOfMember = {}; live.forEach((p) => { unitOfMember[p.member_id] = unit(p); });
  if (source === 'notion') { sess.length = 0; nlogs.filter((l) => l.delta > 0).forEach((l) => { for (let i = 0; i < l.delta; i++) sess.push({ trainer: l.trainer, member_id: l.member_id, unit_price: unitOfMember[l.member_id] || 0, at: `${l.day}T12:00:00+09:00` }); }); Object.keys(dailySess).forEach((k) => delete dailySess[k]); sess.forEach((x) => { const d = x.at.slice(0, 10); dailySess[d] = (dailySess[d] || 0) + 1; }); }
  sess.forEach((x) => { const k = (x.trainer || '미지정'); const t = (tr[k] = tr[k] || { trainer: k, members: new Set(), left: 0, used: 0, left_amount: 0, used_amount: 0, new_amount: 0, new_count: 0 }); t.period_used = (t.period_used || 0) + 1; t.period_amount = (t.period_amount || 0) + (x.unit_price || 0); });
  const trainers = Object.values(tr).map((t) => ({ ...t, members: t.members.size, period_used: t.period_used || 0, period_amount: t.period_amount || 0 })).sort((a, b) => b.members - a.members);
  const status = { '진행 중': 0, '쉬는 중': 0, '곧 끝남': 0, '체험 PT': 0 };
  const seen = new Set();
  rows.forEach((r) => { const k = r.member_id || r.id; if (seen.has(k)) return; seen.add(k); status[r.state === '체험' ? '체험 PT' : r.state === '수업 정체' ? '쉬는 중' : r.state === '곧 끝남' ? '곧 끝남' : '진행 중']++; });
  // 전체 PT 진행 속도(지금까지 쓴 횟수 ÷ 지난 기간)로 '다 쓰려면' 추정
  let usedSum = 0, monthsSum = 0;
  rows.forEach((r) => { const p = live.find((x) => x.id === r.id); if (p && p.starts_on && r.used) { usedSum += r.used; monthsSum += Math.max(0.5, daysBetween(p.starts_on, today) / 30); } });
  const perMonth = monthsSum ? usedSum / monthsSum * (rows.filter((r) => r.used).length || 1) : 0;
  const leftTotal = rows.reduce((a, r) => a + r.left, 0);
  const watch = [];
  rows.filter((r) => r.state === '수업 정체').slice(0, 3).forEach((r) => watch.push({ ...r, kind: '수업 정체', title: source === 'notion' ? `${r.left}회 남았는데 '쉬는 중'이에요` : `${r.left}회 남았는데 ${r.absent}일째 센터에 안 오셨어요`, sub: `남은 금액 ${r.left_amount.toLocaleString('ko-KR')}원 · 오래 끊기면 환불 요청으로 이어져요`, action: r.trainer === '미지정' ? '담당 정하고 스케줄 잡기' : `${r.trainer}쌤에게 스케줄 잡기 요청` }));
  rows.filter((r) => r.state === '곧 끝남').slice(0, 3).forEach((r) => watch.push({ ...r, kind: '곧 끝남', title: `${r.left}회 남았어요 · 재등록 상담 타이밍`, sub: `${r.total}회 중 ${r.used}회 진행`, action: r.trainer === '미지정' ? '재등록 상담 문구 복사' : `${r.trainer}쌤에게 재등록 상담 요청` }));
  rows.filter((r) => /^기간/.test(r.state)).slice(0, 3).forEach((r) => watch.push({ ...r, kind: '기간 임박', title: `${r.left}회 남았는데 기간은 ${r.days_left}일 남았어요`, sub: `남은 금액 ${r.left_amount.toLocaleString('ko-KR')}원 · 연장할지 몰아서 할지 정해야 해요`, action: '남은 횟수 안내 문자' }));
  const sync = await syncStatus();
  return [200, { today, period, from, to, source, sync, unmatched: rows.filter((r) => r.matched && r.matched !== '자동').length,
    registered: { members: new Set(newOnes.map((p) => p.member_id)).size, sessions: newOnes.reduce((a, p) => a + (p.total_count || 0), 0), amount: newOnes.reduce((a, p) => a + (p.price_paid || 0), 0) },
    remaining: { sessions: leftTotal, amount: rows.reduce((a, r) => a + r.left_amount, 0), months: sess.length >= 20 ? Math.round(leftTotal / (sess.length / Math.max(1, Math.round((Date.parse([to, today].sort()[0]) - Date.parse(from)) / DAY) + 1) * 30) * 10) / 10 : null },
    used: { sessions: sess.length, amount: sess.reduce((a, x) => a + (x.unit_price || 0), 0), perDay: Math.round(sess.length / Math.max(1, Math.round((Date.parse([to, today].sort()[0]) - Date.parse(from)) / DAY) + 1) * 10) / 10, daily: dailySess, lifetime: rows.reduce((a, r) => a + r.used, 0) },
    staff: (await supabase.from('crm_staff').select('name,role').eq('active', true)).data || [],
    status, trainers, rows, watch, members: seen.size }];
}

// PT 수업 체크: 남은 횟수 1 줄이고 기록을 남긴다
async function ptSession({ pass_id, staff }) {
  if (!pass_id) return [400, { error: '필수 정보 누락' }];
  const { data: p, error } = await supabase.from('crm_passes').select('id,member_id,product_name,total_count,remaining_count,price_paid,trainer').eq('id', pass_id).maybeSingle();
  if (error) throw error;
  if (!p) return [404, { error: '이용권을 찾을 수 없어요' }];
  if (!p.remaining_count || p.remaining_count <= 0) return [400, { error: '남은 횟수가 없어요' }];
  const u = await supabase.from('crm_passes').update({ remaining_count: p.remaining_count - 1 }).eq('id', pass_id).eq('remaining_count', p.remaining_count);
  if (u.error) throw u.error;
  const unit = p.total_count ? Math.round((p.price_paid || 0) / p.total_count) : 0;
  const ins = await supabase.from('crm_pt_sessions').insert({ pass_id, member_id: p.member_id, trainer: p.trainer || null, unit_price: unit, staff_name: staff ? String(staff).slice(0, 20) : null });
  if (ins.error) throw ins.error;
  await supabase.from('crm_events').insert({ member_id: p.member_id, kind: 'PT 수업', body: `${p.product_name} · ${p.total_count - p.remaining_count + 1}회차 (남은 ${p.remaining_count - 1}회)`, staff_name: p.trainer || staff || null });
  return [200, { success: true, left: p.remaining_count - 1 }];
}
async function ptAssign({ pass_id, trainer }) {
  if (!pass_id) return [400, { error: '필수 정보 누락' }];
  const t = trainer ? String(trainer).trim().slice(0, 20) : null;
  const { error } = await supabase.from('crm_passes').update({ trainer: t }).eq('id', pass_id);
  if (error) throw error;
  return [200, { success: true }];
}
async function ptSetLeft({ pass_id, left }) {
  const n = Math.round(Number(left));
  if (!pass_id || !(n >= 0)) return [400, { error: '남은 횟수를 숫자로 적어주세요' }];
  const { data: p, error } = await supabase.from('crm_passes').select('total_count,member_id,product_name,remaining_count').eq('id', pass_id).maybeSingle();
  if (error) throw error;
  if (!p) return [404, { error: '이용권을 찾을 수 없어요' }];
  if (p.total_count && n > p.total_count) return [400, { error: `전체 ${p.total_count}회보다 많을 수 없어요` }];
  const u = await supabase.from('crm_passes').update({ remaining_count: n }).eq('id', pass_id);
  if (u.error) throw u.error;
  await supabase.from('crm_events').insert({ member_id: p.member_id, kind: 'PT', body: `${p.product_name} 남은 횟수 ${p.remaining_count ?? '-'} → ${n}회로 맞춤` });
  return [200, { success: true }];
}

// ---------- 매출 (기간별) ----------
const PLAN_PRICE = { 베이직: 39000, 스탠다드: 69000, 프리미엄: 99000 };
async function revenue({ period = 'month' }) {
  const today = todayKST();
  let from, to, label;
  if (period === 'today') { from = to = today; label = '오늘'; }
  else if (period === 'lastmonth') { const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1)); from = d.toISOString().slice(0, 10); to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); label = '지난달'; }
  else { from = `${today.slice(0, 7)}-01`; to = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10); label = '이번 달'; }
  const [pays, finance, subs, recent] = await Promise.all([
    paymentsWithGroup(kstStart(from), {}, kstEndEx(to)),
    getFinance(),
    supabase.from('subscribers').select('name,plan,status,next_billing_date'),
    supabase.from('crm_payments').select('amount,paid_at,pass_id,member_id,kind').order('paid_at', { ascending: false }).limit(8),
  ]);
  if (subs.error || recent.error) throw subs.error || recent.error;
  const total = pays.reduce((a, p) => a + p.amount, 0);
  const groups = { PT: 0, 헬스: 0, GX: 0, 월구독: 0, 기타: 0 };
  pays.forEach((p) => { groups[p.group] += p.amount; });
  const daily = {}; pays.forEach((p) => { daily[p.day] = (daily[p.day] || 0) + p.amount; });
  const fails = (subs.data || []).filter((x) => x.status === 'payment_failed' && x.next_billing_date && daysBetween(x.next_billing_date, today) <= 30);
  // 목록: 오늘 결제, 없으면 최근 결제
  const listSrc = pays.filter((p) => p.day === today);
  const pick = listSrc.length ? listSrc : recent.data;
  const pm = await passesByIds(pick.map((p) => p.pass_id));
  const mids = [...new Set(pick.map((p) => p.member_id))];
  const nm = {};
  if (mids.length) { const { data, error } = await supabase.from('crm_members').select('id,name').in('id', mids); if (error) throw error; data.forEach((m) => { nm[m.id] = m.name; }); }
  const list = pick.map((p) => ({ name: nm[p.member_id] || '-', member_id: p.member_id, amount: p.amount, kind: p.kind, product: (pm[p.pass_id] || {}).product_name || '-', group: salesGroup((pm[p.pass_id] || {}).product_name, (pm[p.pass_id] || {}).category), at: p.paid_at }));
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  return [200, { period, label, from, to, today, days, total, count: pays.length, groups, daily, goal: period === 'today' ? Math.round(finance.target / 30) : finance.target,
    dailyGoal: Math.round(finance.target / 30), lastPayDay: pays.reduce((a, p) => (p.day > a ? p.day : a), '') || null,
    unpaid: { count: fails.length, amount: fails.reduce((a, x) => a + (PLAN_PRICE[x.plan] || 39000), 0) },
    routes: { 토스자동결제: { amount: groups.월구독, count: pays.filter((p) => p.group === '월구독').length }, 인포결제: { amount: total - groups.월구독, count: pays.filter((p) => p.group !== '월구독').length } },
    list, listIsToday: listSrc.length > 0 }];
}

// ---------- 자동 문자 규칙 (발송 업체 연결 전: 켜고 끄기와 대상 수만) ----------
const MSG_RULES = [
  { key: 'inq_price', stage: '유입', type: '자동 발송', title: '문의 즉시 가격 안내', body: '{이름}님, 990짐에 문의 주셔서 감사해요. 가격표와 시설 사진 → {링크}' },
  { key: 'inq_return', stage: '유입', type: '직원 할 일', title: '1차 리턴 (상담 3일 뒤)', body: '전화 → 안 받으면 문자' },
  { key: 'welcome', stage: '체험·신규', type: '자동 발송', title: '신규 등록 환영 (등록 당일)', body: '{이름}님 990짐 회원이 되신 걸 환영해요. 첫 4주는 저희가 같이 챙겨드릴게요.' },
  { key: 'absent14', stage: '미출석', type: '자동 + 할 일', title: '2주 안부 (14일 미출석)', body: '안부 문자 발송 → 3일 뒤에도 안 오면 직원 할 일 카드 생성' },
  { key: 'exp14', stage: '만료 예정', type: '자동 발송', title: '만료 2주 전 안내', body: '{이름}님 회원권이 {날짜}에 끝나요. 연장은 인포에서 도와드릴게요.' },
  { key: 'exp7', stage: '만료 예정', type: '자동 + 할 일', title: '만료 1주 전 안내', body: '안내 문자 발송 + 직원 할 일 등록 (재등록 직접 안내)' },
  { key: 'payfail', stage: '만료 예정', type: '자동 + 할 일', title: '구독 결제 실패 (실패 즉시)', body: '카드 변경 링크 알림톡 발송 + 직원 할 일 긴급 등록' },
  { key: 'after1', stage: '만료·이탈', type: '자동 발송', title: '만료 후 1·3·6개월 복귀 안내', body: '(광고) {이름}님, 990짐이 보고 싶어요. 복귀 혜택 → {링크}' },
  { key: 'after12', stage: '만료·이탈', type: '자동 발송', title: '만료 후 1년 안내', body: '광고 수신 동의한 분만' },
];
async function msgRules() {
  const [{ data, error }, dash] = await Promise.all([supabase.from('crm_settings').select('value').eq('key', 'msg_rules').maybeSingle(), dashboard()]);
  if (error) throw error;
  const on = (data && data.value) || {};
  const D = dash[1], t = D.tasks;
  const cnt = { inq_price: D.totals.inquiries30, inq_return: t.filter((x) => x.kind === '유입').length, welcome: D.stages['체험·신규'], absent14: t.filter((x) => x.key.startsWith('abs14')).length,
    exp14: t.filter((x) => x.key.startsWith('exp')).length, exp7: t.filter((x) => x.key.startsWith('exp') && /D-[0-7]$|오늘/.test(x.tag)).length, payfail: D.totals.subFail, after1: t.filter((x) => x.key.startsWith('lapse')).length, after12: 0 };
  return [200, { rules: MSG_RULES.map((r) => ({ ...r, enabled: on[r.key] !== false, now: cnt[r.key] || 0 })), attendNotice: on.attend_notice || 'meaningful', connected: false }];
}
async function msgRulesSave({ rules, attendNotice }) {
  const v = {};
  (Array.isArray(rules) ? rules : []).forEach((r) => { if (MSG_RULES.some((x) => x.key === r.key)) v[r.key] = !!r.enabled; });
  if (['every', 'meaningful', 'off'].includes(attendNotice)) v.attend_notice = attendNotice;
  const { error } = await supabase.from('crm_settings').upsert({ key: 'msg_rules', value: v, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  return msgRules();
}

// ---------- 노션 연동 (읽기만) ----------
// 노션 '워크인 로그' → crm_inquiries, 'PT회원관리'의 트레이너별 '회원 목록' → crm_pt_notion
// 서버 환경 변수 NOTION_TOKEN 이 있어야 하고, 두 페이지가 990crm 연결에 공유돼 있어야 한다.
const NOTION_WALKIN_DB = '2afb2efeb4e380f490adda87804061a7';
const NOTION_PT_ROOT = '163b2efeb4e3808a8d43fdca52b84401';
async function notion(path, body) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`notion ${res.status} ${j.code || ''} ${j.message || ''}`); e.status = res.status; e.code = j.code; throw e; }
  return j;
}
async function notionQueryAll(dbId, body = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const r = await notion(`databases/${dbId}/query`, { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out;
}
async function notionChildren(id) {
  const out = []; let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await notion(`blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out;
}
const nv = {
  text: (p) => (p ? (p.title || p.rich_text || []).map((t) => t.plain_text).join('').trim() : ''),
  sel: (p) => (p && p.select ? p.select.name : p && p.status ? p.status.name : ''),
  multi: (p) => (p && p.multi_select ? p.multi_select.map((x) => x.name) : []),
  date: (p) => (p && p.date ? p.date.start : null),
  num: (p) => (p && typeof p.number === 'number' ? p.number : p && p.formula && typeof p.formula.number === 'number' ? p.formula.number : null),
  check: (p) => !!(p && p.checkbox),
  phone: (p) => (p ? p.phone_number || nv.text(p) : ''),
};
const fmtPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (v ? String(v).slice(0, 20) : null); };
const SRC_MAP = { '전화 워크인': '전화 문의', '인스타DM': '인스타 DM', '당근 문의': '당근', '지도 검색': '네이버 검색', '네이버 블로그': '네이버 검색', '네이버톡톡': '네이버 검색', '네이버예약': '네이버 검색' };
const RESULT_MAP = { '등록완': '등록', '미전환': '미등록', '컨택 중': '상담 중', '체험 픽스': '상담 중', '예약완료': '상담 중' };
// 리턴 연락 시점: 문의 3일 뒤 → 7일 뒤 → 30일 뒤 (노션 워크인 로그 매뉴얼과 같음)
function returnOn(inquiredDay, today) {
  const ms = [3, 7, 30].map((n) => new Date(Date.parse(inquiredDay) + n * DAY).toISOString().slice(0, 10));
  const past = ms.filter((d) => d <= today);
  return past.length ? past[past.length - 1] : ms[0];
}
async function syncWalkins(today, phoneToMember) {
  const since = new Date(Date.parse(today) - 120 * DAY).toISOString().slice(0, 10);
  const pages = await notionQueryAll(NOTION_WALKIN_DB, { filter: { property: '유입날짜', date: { on_or_after: since } } });
  // CRM에서 이미 결과(등록/미등록)를 남긴 건 노션이 비어 있으면 그대로 둔다
  const ex = {};
  (await selectAll(() => supabase.from('crm_inquiries').select('legacy_id,result,member_id').like('legacy_id', 'notion:%'))).forEach((r) => { ex[r.legacy_id] = r; });
  let n = 0;
  for (const pg of pages) {
    const P = pg.properties || {};
    const name = nv.text(P['고객명']); if (!name) continue;
    const day = nv.date(P['유입날짜']) || pg.created_time.slice(0, 10);
    const status = nv.sel(P['전환여부']);
    const phone = fmtPhone(nv.phone(P['연락처']));
    const srcRaw = nv.multi(P['유입 경로'])[0] || '';
    const result = RESULT_MAP[status] || null;
    const summary = JSON.stringify({ reason: nv.sel(P['미등록 사유']), interest: nv.text(P['가입 상품']), next: nv.text(P['클로징']), status, visited: nv.check(P['방문여부']), returnVia: nv.sel(P['리턴']), registered_on: nv.date(P['등록날짜']), notion_url: pg.url });
    const row = { legacy_id: `notion:${pg.id}`, name: name.slice(0, 30), phone, source: srcRaw ? (SRC_MAP[srcRaw] || srcRaw) : null,
      raw_note: [nv.text(P['메모']), nv.text(P['특이사항'])].filter(Boolean).join(' / ').slice(0, 2000) || null, summary,
      staff_name: (nv.text(P['FC']) || nv.sel(P['담당쌤']) || '').slice(0, 20) || null,
      return_on: result === '등록' || result === '미등록' ? null : returnOn(day, today),
      result: result === '상담 중' ? null : result, member_id: phone && phoneToMember[phone] ? phoneToMember[phone] : null,
      inquired_at: new Date(Date.parse(`${day.slice(0, 10)}T12:00:00+09:00`)).toISOString() };
    const old = ex[row.legacy_id];
    if (old && old.result && !row.result) { row.result = old.result; row.return_on = null; }
    if (old && old.member_id && !row.member_id) row.member_id = old.member_id;
    const { error } = await supabase.from('crm_inquiries').upsert(row, { onConflict: 'legacy_id' });
    if (error) throw error;
    n++;
  }
  return n;
}
async function findPtDatabases() {
  const found = [];
  const walk = async (id, trainer, depth) => {
    if (depth > 7) return;
    for (const b of await notionChildren(id)) {
      if (b.type === 'child_page' && !trainer) await walk(b.id, b.child_page.title.replace(/트레이너|선생님|쌤/g, '').replace(/[^\p{L}\p{N}]/gu, '').trim() || trainer, depth + 1);
      else if (b.type === 'child_database' && /^회원 ?목록$/.test((b.child_database.title || '').trim()) && trainer) found.push({ id: b.id, trainer });
      else if (b.has_children && ['column_list', 'column', 'toggle', 'synced_block'].includes(b.type)) await walk(b.id, trainer, depth + 1);
    }
  };
  await walk(NOTION_PT_ROOT, null, 0);
  return found;
}
async function syncPT(today, members, ptMemberIds) {
  const dbs = await findPtDatabases();
  const prev = Object.fromEntries((await selectAll(() => supabase.from('crm_pt_notion').select('notion_id,used'))).map((r) => [r.notion_id, r.used]));
  const byName = {};
  members.forEach((m) => { const k = String(m.name || '').replace(/\s/g, ''); (byName[k] = byName[k] || []).push(m.id); });
  let n = 0; const logs = [];
  for (const db of dbs) {
    for (const pg of await notionQueryAll(db.id)) {
      const P = pg.properties || {};
      const name = nv.text(P['이름']).replace(/\(.*?\)/g, '').trim(); if (!name) continue;
      const total = nv.num(P['전체세션']), used = nv.num(P['진행세션']);
      const cands = byName[name.replace(/\s/g, '')] || [];
      const withPt = cands.filter((id) => ptMemberIds.has(id));
      const pick = withPt.length === 1 ? withPt[0] : cands.length === 1 ? cands[0] : null;
      const row = { notion_id: pg.id, trainer: db.trainer, name: name.slice(0, 30), status: nv.sel(P['상태']) || null, total: total == null ? null : Math.round(total), used: used == null ? null : Math.round(used),
        remaining: total != null && used != null ? Math.round(total - used) : null, member_id: pick, matched: pick ? '자동' : cands.length > 1 ? '확인 필요' : '없음',
        purpose: nv.multi(P['운동목적']).join(', ') || null, note: nv.text(P['비고']).slice(0, 300) || null, notion_edited_at: pg.last_edited_time, synced_at: new Date().toISOString() };
      const { error } = await supabase.from('crm_pt_notion').upsert(row, { onConflict: 'notion_id' });
      if (error) throw error;
      const before = prev[pg.id];
      if (row.used != null && before != null && row.used !== before) logs.push({ notion_id: pg.id, trainer: db.trainer, member_id: pick, delta: row.used - before, used_after: row.used, day: kstDate(pg.last_edited_time) });
      n++;
    }
  }
  if (logs.length) { const { error } = await supabase.from('crm_pt_notion_log').insert(logs); if (error) throw error; }
  return { members: n, trainers: dbs.map((d) => d.trainer), sessionsLogged: logs.reduce((a, l) => a + l.delta, 0) };
}
async function syncStatus() {
  const { data } = await supabase.from('crm_settings').select('value').eq('key', 'notion_sync').maybeSingle();
  return { connected: !!process.env.NOTION_TOKEN, ...((data && data.value) || {}) };
}
async function notionSync({ force } = {}) {
  if (!process.env.NOTION_TOKEN) return [200, { connected: false, message: '노션 연결 키가 아직 서버에 없어요' }];
  const st = await supabase.from('crm_settings').select('value').eq('key', 'notion_sync').maybeSingle();
  if (st.error) throw st.error;
  const last = st.data && st.data.value && st.data.value.at;
  if (!force && last && Date.now() - Date.parse(last) < 10 * 60 * 1000) return [200, { connected: true, skipped: true, at: last, ...(st.data.value || {}) }];
  const today = todayKST();
  const [members, ptPasses] = await Promise.all([
    selectAll(() => supabase.from('crm_members').select('id,name,phone')),
    selectAll(() => supabase.from('crm_passes').select('member_id,product_name,category').in('status', ['사용 중', '예정', '홀딩'])),
  ]);
  const phoneToMember = {}; members.forEach((m) => { if (m.phone) phoneToMember[m.phone] = m.id; });
  const ptIds = new Set(ptPasses.filter((p) => salesGroup(p.product_name, p.category) === 'PT').map((p) => p.member_id));
  const out = { at: new Date().toISOString() };
  try { out.walkins = await syncWalkins(today, phoneToMember); } catch (e) { out.walkinError = e.code === 'object_not_found' || e.status === 404 ? '워크인 로그가 990crm 연결에 공유되지 않았어요' : e.message; }
  try { out.pt = await syncPT(today, members, ptIds); } catch (e) { out.ptError = e.code === 'object_not_found' || e.status === 404 ? 'PT회원관리가 990crm 연결에 공유되지 않았어요' : e.message; }
  const { error } = await supabase.from('crm_settings').upsert({ key: 'notion_sync', value: out, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  clearCache();
  return [200, { connected: true, ...out }];
}

// ---------- 메모 ----------
async function memoAdd({ member_id, text, staff }) {
  const body = String(text || '').trim().slice(0, 500);
  if (!member_id || !body) return [400, { error: '메모를 적어주세요' }];
  const { error } = await supabase.from('crm_events').insert({ member_id, kind: '메모', body, staff_name: staff ? String(staff).slice(0, 20) : null });
  if (error) throw error;
  return member({ id: member_id });
}

// ---------- 월구독 연결 (가족 카드로 결제하는 회원 등) ----------
async function subSearch({ q }) {
  const t = String(q || '').trim().slice(0, 20);
  let query = supabase.from('subscribers').select('id,name,phone,plan,status,next_billing_date').order('created_at', { ascending: false }).limit(20);
  if (t) query = /^\d{3,}$/.test(t) ? query.ilike('phone', `%${t}%`) : query.ilike('name', `%${t.replace(/[%_,()]/g, '')}%`);
  const { data, error } = await query;
  if (error) throw error;
  return [200, { subscribers: data.map((r) => ({ id: r.id, name: r.name, plan: r.plan, status: r.status, next_billing_date: r.next_billing_date, phone4: digitsOf(r.phone).slice(-4) })) }];
}
async function subLink({ member_id, subscriber_id }) {
  if (!member_id) return [400, { error: '필수 정보 누락' }];
  if (subscriber_id) {
    const ex = await supabase.from('subscribers').select('id').eq('id', subscriber_id).maybeSingle();
    if (ex.error) throw ex.error;
    if (!ex.data) return [400, { error: '구독을 찾을 수 없어요' }];
  }
  const { error } = await supabase.from('crm_members').update({ subscriber_id: subscriber_id || null, updated_at: new Date().toISOString() }).eq('id', member_id);
  if (error) throw error;
  return member({ id: member_id });
}

// ---------- 직원 명단 · 직책 ----------
const DEFAULT_ROLES = ['대표', '매니저', '인포', '트레이너', 'FC'];
async function getRoles() {
  const { data, error } = await supabase.from('crm_settings').select('value').eq('key', 'roles').maybeSingle();
  if (error) throw error;
  const list = data && Array.isArray(data.value) ? data.value : DEFAULT_ROLES;
  return list.map((r) => String(r).trim().slice(0, 20)).filter(Boolean);
}
async function staffList() {
  const [{ data, error }, roles] = await Promise.all([supabase.from('crm_staff').select('id,name,role,active').eq('active', true).order('created_at'), getRoles()]);
  if (error) throw error;
  return [200, { staff: data, roles }];
}
const cleanRole = (role, roles) => (role && roles.includes(String(role).trim()) ? String(role).trim() : null);
async function staffAdd({ name, role }) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return [400, { error: '이름을 적어주세요' }];
  const r = cleanRole(role, await getRoles());
  const ex = await supabase.from('crm_staff').select('id').eq('name', n).maybeSingle();
  if (ex.error) throw ex.error;
  const q = ex.data ? supabase.from('crm_staff').update({ role: r, active: true }).eq('id', ex.data.id) : supabase.from('crm_staff').insert({ name: n, role: r, active: true });
  const { error } = await q;
  if (error) throw error;
  return staffList();
}
// 이름·직책 고치기. 이름을 바꾸면 이번 달 처리 기록의 이름도 같이 바꾼다.
async function staffUpdate({ id, name, role }) {
  const n = String(name || '').trim().slice(0, 20);
  if (!id || !n) return [400, { error: '이름을 적어주세요' }];
  const cur = await supabase.from('crm_staff').select('id,name').eq('id', id).maybeSingle();
  if (cur.error) throw cur.error;
  if (!cur.data) return [404, { error: '직원을 찾을 수 없어요' }];
  const dup = await supabase.from('crm_staff').select('id').eq('name', n).eq('active', true).maybeSingle();
  if (dup.error) throw dup.error;
  if (dup.data && dup.data.id !== id) return [400, { error: '같은 이름이 이미 있어요' }];
  const { error } = await supabase.from('crm_staff').update({ name: n, role: cleanRole(role, await getRoles()) }).eq('id', id);
  if (error) throw error;
  if (cur.data.name !== n) {
    const t = await supabase.from('crm_tasks').update({ done_by: n }).eq('done_by', cur.data.name);
    if (t.error) throw t.error;
  }
  return staffList();
}
async function staffRemove({ id }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const { error } = await supabase.from('crm_staff').update({ active: false }).eq('id', id);
  if (error) throw error;
  return staffList();
}
async function rolesSave({ roles }) {
  if (!Array.isArray(roles) || roles.length > 20) return [400, { error: '직책이 맞지 않아요' }];
  const list = [...new Set(roles.map((r) => String(r || '').trim().slice(0, 20)).filter(Boolean))];
  if (!list.length) return [400, { error: '직책을 하나 이상 남겨주세요' }];
  const { error } = await supabase.from('crm_settings').upsert({ key: 'roles', value: list, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  return staffList();
}

// ---------- 보고서 ----------
// 기간: week(이번 주) · lastweek · month(이번 달) · lastmonth. 같은 길이의 바로 전 기간과 비교한다.
function periodOf(kind, today) {
  const d = new Date(`${today}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  const add = (x, n) => { const y = new Date(x); y.setUTCDate(y.getUTCDate() + n); return y; };
  let from, to, label;
  if (kind === 'week' || kind === 'lastweek') {
    const mon = add(d, -((d.getUTCDay() + 6) % 7));
    from = kind === 'week' ? mon : add(mon, -7); to = add(from, 6);
    label = kind === 'week' ? '이번 주' : '지난 주';
    const pf = add(from, -7);
    return { kind, label, from: iso(from), to: iso(to), prevFrom: iso(pf), prevTo: iso(add(pf, 6)) };
  }
  if (kind === '6m') {
    const y6 = d.getUTCFullYear(), m6 = d.getUTCMonth();
    const f = new Date(Date.UTC(y6, m6 - 5, 1)), t = new Date(Date.UTC(y6, m6 + 1, 0));
    return { kind, label: '최근 6개월', from: iso(f), to: iso(t), prevFrom: iso(new Date(Date.UTC(y6, m6 - 11, 1))), prevTo: iso(new Date(Date.UTC(y6, m6 - 5, 0))) };
  }
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - (kind === 'lastmonth' ? 1 : 0);
  from = new Date(Date.UTC(y, m, 1)); to = new Date(Date.UTC(y, m + 1, 0));
  label = kind === 'lastmonth' ? '지난 달' : '이번 달';
  return { kind, label, from: iso(from), to: iso(to), prevFrom: iso(new Date(Date.UTC(y, m - 1, 1))), prevTo: iso(new Date(Date.UTC(y, m, 0))) };
}
const kstStart = (d) => new Date(Date.parse(`${d}T00:00:00+09:00`)).toISOString();
const kstEndEx = (d) => new Date(Date.parse(`${d}T00:00:00+09:00`) + DAY).toISOString();
async function report({ period = 'month' }) {
  const today = todayKST();
  const P = periodOf(['week', 'lastweek', 'month', 'lastmonth', '6m'].includes(period) ? period : 'month', today);
  const [pays, passes, att, tasks, inq, subs, finance, inqAll, pnl] = await Promise.all([
    paymentsWithGroup(kstStart(P.prevFrom), {}, kstEndEx(P.to)),
    selectAll(() => supabase.from('crm_passes').select('id,member_id,category,product_name,status,starts_on,ends_on').gte('ends_on', new Date(Date.parse(P.prevFrom) - 400 * DAY).toISOString().slice(0, 10))),
    selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').gte('checked_at', kstStart(P.prevFrom)).lt('checked_at', kstEndEx(P.to))),
    selectAll(() => supabase.from('crm_tasks').select('kind,done_by,done_at').gte('done_at', kstStart(P.prevFrom)).lt('done_at', kstEndEx(P.to))),
    supabase.from('crm_inquiries').select('inquired_at').gte('inquired_at', kstStart(P.prevFrom)).lt('inquired_at', kstEndEx(P.to)),
    supabase.from('subscribers').select('created_at,cancelled_at,status,churn_reason'),
    getFinance(),
    supabase.from('crm_inquiries').select('source,result,member_id,summary,inquired_at').gte('inquired_at', kstStart(P.from)).lt('inquired_at', kstEndEx(P.to)),
    supabase.from('crm_pnl_monthly').select('ym,revenue').order('ym'),
  ]);
  if (inqAll.error || pnl.error) throw inqAll.error || pnl.error;
  if (inq.error || subs.error) throw inq.error || subs.error;
  const inR = (d, a, b) => d >= a && d <= b;
  const side = (a, b) => {
    const ps = pays.filter((p) => inR(p.day, a, b));
    const sum = (f) => ps.filter(f).reduce((x, p) => x + p.amount, 0);
    const membership = sum((p) => MEMBERSHIP.includes(p.group)), pt = sum((p) => p.group === 'PT');
    const newM = new Set(ps.filter((p) => p.kind === '신규').map((p) => p.member_id)).size;
    const renewM = new Set(ps.filter((p) => p.kind === '재등록').map((p) => p.member_id)).size;
    // 재등록률: 이 기간에 끝난 회원권(PT·구독 제외) 중 다음 회원권을 산 비율
    const nonPT = passes.filter((x) => !['무효', '환불'].includes(x.status) && !['PT', '월구독'].includes(salesGroup(x.product_name, x.category)) && !/체험/.test(x.product_name || ''));
    const ended = nonPT.filter((x) => x.ends_on && inR(x.ends_on, a, b));
    const later = {};
    nonPT.forEach((x) => { (later[x.member_id] = later[x.member_id] || []).push(x); });
    const endedMembers = [...new Set(ended.map((x) => x.member_id))];
    const renewed = endedMembers.filter((mid) => { const mine = later[mid]; const lastEnd = ended.filter((x) => x.member_id === mid).map((x) => x.ends_on).sort().pop(); return mine.some((x) => x.ends_on > lastEnd && x.starts_on && x.starts_on <= new Date(Date.parse(lastEnd) + 45 * DAY).toISOString().slice(0, 10)); }).length;
    const at = att.filter((x) => inR(kstDate(x.checked_at), a, b));
    const days = Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;
    const hours = Array(24).fill(0); at.forEach((x) => hours[kstHour(x.checked_at)]++);
    const tk = tasks.filter((x) => inR(kstDate(x.done_at), a, b));
    const byStaff = {}; tk.forEach((x) => { byStaff[x.done_by] = (byStaff[x.done_by] || 0) + 1; });
    const subNew = (subs.data || []).filter((x) => x.created_at && inR(kstDate(x.created_at), a, b)).length;
    const subCancel = (subs.data || []).filter((x) => x.cancelled_at && inR(kstDate(x.cancelled_at), a, b)).length;
    const daily = {}; ps.forEach((p) => { daily[p.day] = (daily[p.day] || 0) + p.amount; });
    return { from: a, to: b, days, membership, pt, total: membership + pt, groups: Object.fromEntries(['헬스', '월구독', 'GX', '기타', 'PT'].map((g) => [g, sum((p) => p.group === g)])),
      payCount: ps.length, newMembers: newM, renewMembers: renewM, ended: endedMembers.length, renewed, renewRate: endedMembers.length ? Math.round(renewed / endedMembers.length * 100) : null,
      visits: at.length, visitors: new Set(at.map((x) => x.member_id)).size, perDay: Math.round(at.length / days * 10) / 10, peakHour: at.length ? hours.indexOf(Math.max(...hours)) : null,
      tasksDone: tk.length, byStaff, inquiries: (inq.data || []).filter((x) => inR(kstDate(x.inquired_at), a, b)).length, subNew, subCancel, daily };
  };
  // 아직 진행 중인 기간은 지난 기간도 같은 날짜 수만큼만 비교한다 (예: 1~19일 vs 1~19일)
  const lastPay = pays.reduce((a, p) => (p.day > a ? p.day : a), '');
  const dataEnd = [P.to, today, lastPay || today].sort()[0];
  const n = Math.max(1, Math.round((Date.parse(dataEnd) - Date.parse(P.from)) / DAY) + 1);
  const prevEnd = [P.prevTo, new Date(Date.parse(P.prevFrom) + (n - 1) * DAY).toISOString().slice(0, 10)].sort()[0];
  const partial = dataEnd < P.to;
  const cur = side(P.from, partial ? dataEnd : P.to), prev = side(P.prevFrom, partial ? prevEnd : P.prevTo);
  const isMonth = P.kind === 'month' || P.kind === 'lastmonth';
  const elapsed = P.to > today ? Math.round((Date.parse(today) - Date.parse(P.from)) / DAY) + 1 : cur.days;
  const goal = isMonth ? finance.target : Math.round(finance.target * 7 / 30);
  // ── 시안 보고서용 ──
  // 깔때기: 유입(문의) → 체험(체험권 결제) → 정규 등록(신규 결제) → 재등록
  const inP = (d) => d >= P.from && d <= P.to;
  const trialM = new Set(), regM = new Set();
  const passById = Object.fromEntries(passes.map((x) => [x.id, x]));
  pays.filter((p) => inP(p.day)).forEach((p) => {
    const nm = (passById[p.pass_id] || {}).product_name || '';
    if (/체험|^PT ?3회$/.test(nm)) trialM.add(p.member_id); else if (p.kind === '신규') regM.add(p.member_id);
  });
  const funnel = { inquiries: inqAll.data.length, trial: trialM.size, regular: regM.size, regularFromTrial: [...regM].filter((m) => trialM.has(m)).length, renewed: cur.renewed, ended: cur.ended };
  // 유입 경로별 문의 수 · 등록 비율
  const src = {};
  inqAll.data.forEach((q) => { const k = q.source || '기록 없음'; const o = (src[k] = src[k] || { source: k, count: 0, joined: 0 }); o.count++; if (q.result === '등록' || q.member_id) o.joined++; });
  // 왜 등록 안 했나 (문의 미등록 사유)
  const noReg = {};
  inqAll.data.forEach((q) => { let r = ''; try { r = JSON.parse(q.summary || '{}').reason || ''; } catch (e) { r = ''; } if (r) noReg[r] = (noReg[r] || 0) + 1; });
  // 왜 그만뒀나 (월구독 해지 사유 → 묶음)
  const CH = [['바빠짐·시간', /바빠|바쁘|일이|일 |회사|스케줄|공부|학교|수능|시간|자주못/], ['이사·지역 이동', /이사|지역|이동|멀어|파주|부산|연신내|캐나다|선교|파견|출장|근처/], ['부상·건강', /부상|통증|허리|손목|염증|임신|건강/],
    ['다른 곳으로', /타 ?센터|타 ?시설|아파트|옐로우|타 ?운동|혼자|직장근처|다른/], ['기간권 전환', /기간권/], ['군 입대·훈련', /군|훈련소|입대/], ['잠시 쉼·복귀 예정', /복귀|다시|휴식|쉬고|월에|월 말|월쯤|후 봐야|시작할/], ['개인 사정', /개인|사정|불화|케어|같이해지/]];
  const churn = {};
  (subs.data || []).filter((x) => x.status === 'cancelled' && x.cancelled_at && kstDate(x.cancelled_at) >= P.from && kstDate(x.cancelled_at) <= P.to && x.churn_reason && !/테스트|복구|수업때/.test(x.churn_reason)).forEach((x) => {
    const hit = CH.find(([, re]) => re.test(x.churn_reason)); const k = hit ? hit[0] : '기타'; churn[k] = (churn[k] || 0) + 1;
  });
  // 최근 6개월 매출(결제 기록) · 손익표 매출
  const m6 = []; for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1)); m6.push(d.toISOString().slice(0, 7)); }
  const pays6 = await paymentsWithGroup(kstStart(`${m6[0]}-01`), passById);
  const rev6 = m6.map((ym) => ({ ym, total: pays6.filter((p) => p.day.slice(0, 7) === ym).reduce((a, p) => a + p.amount, 0), pnl: (pnl.data.find((r) => r.ym === ym) || {}).revenue || null }));
  // 요일·시간대 평균 출석
  const heat = Array.from({ length: 7 }, () => Array(6).fill(0)); const dayCount = Array(7).fill(0); const seenDays = new Set();
  att.filter((x) => inP(kstDate(x.checked_at))).forEach((x) => { const d = kstDate(x.checked_at); const w = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; const h = kstHour(x.checked_at); const slot = h < 6 ? -1 : Math.min(5, Math.floor((h - 6) / 3)); if (slot >= 0) heat[w][slot]++; if (!seenDays.has(d)) { seenDays.add(d); dayCount[w]++; } });
  const heatAvg = heat.map((row, w) => row.map((v) => (dayCount[w] ? Math.round(v / dayCount[w]) : null)));
  const extra = { funnel, sources: Object.values(src).sort((a, b) => b.count - a.count), noReg: Object.entries(noReg).sort((a, b) => b[1] - a[1]), churn: Object.entries(churn).sort((a, b) => b[1] - a[1]), rev6, heat: heatAvg, heatDays: seenDays.size };
  return [200, { ...extra, period: { ...P, compareTo: partial ? dataEnd : P.to, prevCompareTo: partial ? prevEnd : P.prevTo, partial }, today, elapsed, goal, breakeven: isMonth ? finance.breakeven : Math.round(finance.breakeven * 7 / 30), cur, prev, lastPayDay: pays.reduce((a, p) => (p.day > a ? p.day : a), '') || null }];
}

// ---------- 비용·목표 ----------
async function financeGet() { return [200, { finance: await getFinance() }]; }
async function financeSave({ costs, profit, ptPay }) {
  if (!Array.isArray(costs) || costs.length > 30) return [400, { error: '비용 항목이 맞지 않아요' }];
  const clean = costs.map((c) => ({ name: String(c.name || '').trim().slice(0, 40), amount: Math.max(0, Math.round(Number(c.amount) || 0)), note: c.note ? String(c.note).slice(0, 80) : '' })).filter((c) => c.name);
  const p = Math.max(0, Math.round(Number(profit) || 0));
  const pt = ptPay == null || ptPay === '' ? null : Math.max(0, Math.round(Number(ptPay) || 0));
  const { error } = await supabase.from('crm_settings').upsert({ key: 'finance', value: { costs: clean, profit: p, ptPay: pt }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  return financeGet();
}

// ---------- 매출 (올해) ----------
async function salesYear({ year }) {
  const y = /^\d{4}$/.test(String(year)) ? String(year) : todayKST().slice(0, 4);
  const [pays, pnl, finance] = await Promise.all([
    paymentsWithGroup(new Date(Date.parse(`${y}-01-01T00:00:00+09:00`)).toISOString()),
    supabase.from('crm_pnl_monthly').select('*').gte('ym', `${y}-01`).lte('ym', `${y}-12`).order('ym'),
    getFinance(),
  ]);
  if (pnl.error) throw pnl.error;
  const months = {};
  for (let i = 1; i <= 12; i++) months[`${y}-${String(i).padStart(2, '0')}`] = { 헬스: 0, 월구독: 0, GX: 0, 기타: 0, PT: 0, count: 0 };
  pays.forEach((p) => { const k = p.day.slice(0, 7); if (months[k]) { months[k][p.group] += p.amount; months[k].count++; } });
  const P = Object.fromEntries(pnl.data.map((r) => [r.ym, r]));
  return [200, { year: y, target: finance.target, breakeven: finance.breakeven, months: Object.entries(months).map(([ym, g]) => {
    const r = P[ym];
    const cost_floor = r ? r.space + r.gx + r.ops_staff + r.marketing + r.other_fixed + r.dep + r.tax_reserve : null;
    return { ym, ...g, membership: MEMBERSHIP.reduce((a, k) => a + g[k], 0), pnl: r ? { revenue: r.revenue, net: r.net, pt_pay: r.pt_pay, floor: cost_floor, one_off: r.one_off } : null };
  }) }];
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
  const [{ data, error, count }, subs, expiredDb] = await Promise.all([
    big ? query.range(0, 999) : query.range(offset, offset + Math.min(limit, 100) - 1), subsMap(),
    supabase.from('crm_members').select('id', { count: 'exact', head: true }).eq('stage', '만료·이탈'),
  ]);
  if (error) throw error;
  const all = data.map((m) => decorate(m, today, subs));
  let rows = all;
  let counts = null;
  if (big) {
    const live = all.filter((m) => m.stage !== '만료·이탈');
    const isSub = (m) => m.sub === '구독 중' || m.sub === '쉬어가기';
    counts = { '': live.length, '월구독': live.filter(isSub).length, '홀딩': live.filter((m) => m.holding).length, '만료·이탈': (expiredDb.count || 0) + (all.length - live.length) };
    ['체험·신규', '정착', '미출석', '만료 예정'].forEach((k) => { counts[k] = live.filter((m) => m.stage === k).length; });
    if (stage === '월구독') rows = live.filter(isSub);
    else if (stage === '홀딩') rows = live.filter((m) => m.holding);
    else if (stage) rows = live.filter((m) => m.stage === stage);
    else rows = live;
  }
  const page = big ? rows.slice(offset, offset + Math.min(limit, 100)) : rows;
  // 표에 보일 이용권 이름과 이번 달 출석 횟수
  const ids = page.map((m) => m.id);
  const monthStart = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00+09:00`)).toISOString();
  const chunks = []; for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const [ps, at] = await Promise.all([
    Promise.all(chunks.map((c) => supabase.from('crm_passes').select('member_id,product_name,category,ends_on').in('member_id', c).in('status', ['사용 중', '예정', '홀딩']))),
    Promise.all(chunks.map((c) => supabase.from('crm_attendance').select('member_id').in('member_id', c).gte('checked_at', monthStart))),
  ]);
  const passName = {}, ptName = {}, visits = {};
  ps.forEach(({ data: d, error: e }) => { if (e) throw e; d.forEach((p) => {
    const g = salesGroup(p.product_name, p.category);
    if (g === 'PT') { ptName[p.member_id] = p.product_name; return; }
    if (!passName[p.member_id] || String(p.ends_on) > String(passName[p.member_id].ends_on)) passName[p.member_id] = p;
  }); });
  at.forEach(({ data: d, error: e }) => { if (e) throw e; d.forEach((a) => { visits[a.member_id] = (visits[a.member_id] || 0) + 1; }); });
  const out = page.map((m) => ({ ...m, pass_name: passName[m.id] ? passName[m.id].product_name : null, pt_name: ptName[m.id] || null, month_visits: visits[m.id] || 0 }));
  return [200, { members: out, total: big ? rows.length : count, counts }];
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
  const [events, att] = await Promise.all([
    supabase.from('crm_events').select('kind,body,staff_name,at').eq('member_id', id).order('at', { ascending: false }).limit(30),
    supabase.from('crm_attendance').select('checked_at').eq('member_id', id).gte('checked_at', new Date(Date.now() - 56 * DAY).toISOString()),
  ]);
  if (events.error || att.error) throw events.error || att.error;
  const weeks = Array(8).fill(0);
  att.data.forEach((a) => { const w = Math.floor((Date.now() - Date.parse(a.checked_at)) / (7 * DAY)); if (w >= 0 && w < 8) weeks[7 - w]++; });
  const err = m.error || passes.error || payments.error || lockers.error || inquiries.error;
  if (err) throw err;
  if (!m.data) return [404, { error: '회원을 찾을 수 없어요' }];
  const { checkin_code, photo_path, ...safe } = m.data; // 출석 번호는 화면에 안 보낸다
  const S = await subsMap();
  const sb = subOf(safe, S);
  return [200, {
    member: { ...decorate(safe, today, S), photo_url: await photoUrl(photo_path),
      subscription: sb ? { id: sb.id, name: sb.name, plan: sb.plan, status: sb.status, next_billing_date: sb.next_billing_date, phone4: digitsOf(sb.phone).slice(-4), linked: safe.subscriber_id === sb.id } : null },
    passes: passes.data, payments: payments.data,
    lockers: lockers.data.map(({ lock_code, ...l }) => l),
    inquiries: inquiries.data, events: events.data, weeks, attTotal: att.data.length, monthVisits: att.data.filter((x) => kstDate(x.checked_at).slice(0, 7) === today.slice(0, 7)).length,
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
  const [{ data, error }, subs] = await Promise.all([supabase.from('crm_members').select('id,name,phone,stage,holding,ends_on,first_started_on,last_attended_on,photo_path,subscriber_id').like('phone', `%-${d}`), subsMap()]);
  if (error) throw error;
  const list = data.map((m) => decorate(m, today, subs))
    .sort((a, b) => (a.stage === '만료·이탈') - (b.stage === '만료·이탈'));
  return [200, { matches: list.map((m) => ({ id: m.id, name: list.length > 1 ? maskName(m.name) : m.name, active: m.stage !== '만료·이탈', has_photo: !!m.photo_path })) }];
}

async function checkin({ id }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const today = todayKST();
  const { data: m, error } = await supabase.from('crm_members').select('id,name,phone,stage,holding,ends_on,first_started_on,last_attended_on,total_visits,photo_path,subscriber_id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!m) return [404, { error: '회원을 찾을 수 없어요' }];
  const d = decorate(m, today, await subsMap());
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
  return [200, { ...base, again, days_left: d.days_left, ends_on: d.ends_on, sub: d.sub, next_billing: d.next_billing, product: main ? main.product_name : null,
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

const ACTIONS = { dashboard, members, member, lockerBoard, kioskRegister, checkinFind, checkin, photoUpload,
  taskDone, taskUndo, staffList, staffAdd, staffRemove, financeGet, financeSave, salesYear, subSearch, subLink, staffUpdate, rolesSave, report, memoAdd, inquiryAdd, inquiryList, inquiryUpdate, ptBoard, revenue, msgRules, msgRulesSave, ptSession, ptAssign, ptSetLeft, notionSync };
const KIOSK_OK = ['checkinFind', 'checkin', 'photoUpload'];
const WRITES = ['checkin', 'photoUpload', 'taskDone', 'taskUndo', 'staffAdd', 'staffUpdate', 'staffRemove', 'financeSave', 'subLink', 'rolesSave', 'memoAdd', 'inquiryAdd', 'inquiryUpdate', 'msgRulesSave', 'ptSession', 'ptAssign', 'ptSetLeft', 'notionSync'];

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.cron === 'notion') {
    if (!process.env.CRON_SECRET || req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
    try { const [code, body] = await notionSync({ force: true }); return res.status(code).json(body); } catch (e) { console.error('notion cron', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const params = req.body || {};
  const fn = ACTIONS[params.action];
  if (!fn) return res.status(400).json({ error: '알 수 없는 요청' });
  const tk = bearer(req);
  const kiosk = KIOSK_OK.includes(params.action) && isKiosk(tk);
  if (!kiosk && !(await verifyToken(supabase, tk))) return res.status(401).json({ error: '로그인이 필요해요' });
  try {
    if (WRITES.includes(params.action)) clearCache();
    const [code, body] = await fn(params);
    if (WRITES.includes(params.action)) clearCache();
    return res.status(code).json(body);
  } catch (e) {
    console.error('crm', params.action, e);
    return res.status(500).json({ error: '서버 오류' });
  }
}
