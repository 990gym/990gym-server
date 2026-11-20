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
async function subsMap() {
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

async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

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
async function paymentsWithGroup(fromISO) {
  const [pays, passes] = await Promise.all([
    selectAll(() => supabase.from('crm_payments').select('amount,paid_at,pass_id,member_id,kind').gte('paid_at', fromISO)),
    selectAll(() => supabase.from('crm_passes').select('id,product_name,category')),
  ]);
  const pm = Object.fromEntries(passes.map((p) => [p.id, p]));
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
async function dashboard() {
  const today = todayKST();
  const month = today.slice(0, 7);
  const recentCut = new Date(Date.parse(today) - 400 * DAY).toISOString().slice(0, 10);
  const todayStartISO = new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString();
  const monthStartISO = new Date(Date.parse(`${month}-01T00:00:00+09:00`)).toISOString();
  const [members, allPasses, pays, lockers, assigns, inq, totalCount, snap, att, attPast, finance, staff, subs, doneRows] = await Promise.all([
    Promise.all([
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).neq('stage', '만료·이탈')),
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).eq('stage', '만료·이탈').gte('ends_on', recentCut)),
    ]).then(([a, b]) => a.concat(b)),
    selectAll(() => supabase.from('crm_passes').select('member_id,category,product_name,status,starts_on,ends_on,remaining_count,total_count')),
    paymentsWithGroup(monthStartISO),
    supabase.from('crm_lockers').select('number'),
    selectAll(() => supabase.from('crm_locker_assignments').select('locker_no,member_id,status,ends_on').in('status', ['사용 중', '예정', '홀딩'])),
    supabase.from('crm_inquiries').select('id,inquired_at,member_id').gte('inquired_at', new Date(Date.parse(today) - 30 * DAY).toISOString()),
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
      inquiries30: inq.data.length, lapsedThisMonth: thisMonthLapsed,
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
const TASK_KEY = /^(exp|pay|abs14|abs30|nov|new|lapse):[0-9a-f-]{36}:[0-9-]{0,10}$/;
async function taskDone({ key, staff, note }) {
  if (!TASK_KEY.test(String(key || ''))) return [400, { error: '할 일 정보가 맞지 않아요' }];
  const name = String(staff || '').trim();
  if (!name) return [400, { error: '처리한 직원을 골라주세요' }];
  const s = await supabase.from('crm_staff').select('id').eq('name', name).eq('active', true).maybeSingle();
  if (s.error) throw s.error;
  if (!s.data) return [400, { error: '직원 명단에 없는 이름이에요' }];
  const [kind, member_id] = key.split(':');
  const ins = await supabase.from('crm_tasks').upsert({ task_key: key, member_id, kind, due_on: todayKST(), done_at: new Date().toISOString(), done_by: name, result: note ? String(note).slice(0, 300) : null }, { onConflict: 'task_key' });
  if (ins.error) throw ins.error;
  await supabase.from('crm_events').insert({ member_id, kind: '할 일', body: `${({ exp: '재등록 안내', pay: '결제 실패 안내', abs14: '미출석 안부', abs30: '장기 미출석 연락', nov: '첫 방문 연락', new: '신규 안부', lapse: '복귀 안내' })[kind]} 완료${note ? ` · ${String(note).slice(0, 300)}` : ''}`, staff_name: name });
  return [200, { success: true }];
}
async function taskUndo({ key }) {
  if (!TASK_KEY.test(String(key || ''))) return [400, { error: '할 일 정보가 맞지 않아요' }];
  const del = await supabase.from('crm_tasks').delete().eq('task_key', key).gte('done_at', new Date(Date.parse(`${todayKST()}T00:00:00+09:00`)).toISOString());
  if (del.error) throw del.error;
  return [200, { success: true }];
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

// ---------- 직원 명단 ----------
async function staffList() {
  const { data, error } = await supabase.from('crm_staff').select('id,name,role,active').eq('active', true).order('created_at');
  if (error) throw error;
  return [200, { staff: data }];
}
async function staffAdd({ name, role }) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return [400, { error: '이름을 적어주세요' }];
  const r = ['대표', '매니저', '인포', '트레이너', 'FC'].includes(role) ? role : null;
  const ex = await supabase.from('crm_staff').select('id').eq('name', n).maybeSingle();
  if (ex.error) throw ex.error;
  const q = ex.data ? supabase.from('crm_staff').update({ role: r, active: true }).eq('id', ex.data.id) : supabase.from('crm_staff').insert({ name: n, role: r, active: true });
  const { error } = await q;
  if (error) throw error;
  return staffList();
}
async function staffRemove({ id }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const { error } = await supabase.from('crm_staff').update({ active: false }).eq('id', id);
  if (error) throw error;
  return staffList();
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
  const [{ data, error, count }, subs] = await Promise.all([big ? query.range(0, 999) : query.range(offset, offset + Math.min(limit, 100) - 1), subsMap()]);
  if (error) throw error;
  let rows = data.map((m) => decorate(m, today, subs));
  if (stage === '월구독') rows = rows.filter((m) => m.sub === '구독 중' || m.sub === '쉬어가기');
  else if (stage === '홀딩') rows = rows.filter((m) => m.holding);
  else if (stage && stage !== '만료·이탈' && !term) rows = rows.filter((m) => m.stage === stage);
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
  const { checkin_code, photo_path, ...safe } = m.data; // 출석 번호는 화면에 안 보낸다
  const S = await subsMap();
  const sb = subOf(safe, S);
  return [200, {
    member: { ...decorate(safe, today, S), photo_url: await photoUrl(photo_path),
      subscription: sb ? { id: sb.id, name: sb.name, plan: sb.plan, status: sb.status, next_billing_date: sb.next_billing_date, phone4: digitsOf(sb.phone).slice(-4), linked: safe.subscriber_id === sb.id } : null },
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
  taskDone, taskUndo, staffList, staffAdd, staffRemove, financeGet, financeSave, salesYear, subSearch, subLink };
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
