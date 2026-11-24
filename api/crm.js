import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { cors, bearer, verifyToken, checkPassword, issueToken, passwordConfigured } from './_auth.js';
import { monthlyAmount, getPromo } from './_pricing.js';

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
async function subsMap() { return memo('subs', 180000, subsMapRaw); }
async function subsMapRaw() {
  const [subs, bj, linked] = await Promise.all([
    supabase.from('subscribers').select('id,name,phone,plan,addons,status,next_billing_date,cancelled_at,paused_at,created_at').order('created_at', { ascending: true }),
    selectAll(() => supabase.from('crm_passes').select('member_id').in('status', ['사용 중', '예정', '홀딩']).ilike('product_name', '%구독%')),
    supabase.from('crm_members').select('subscriber_id').not('subscriber_id', 'is', null),
  ]);
  if (subs.error) throw subs.error;
  // 이미 어느 회원과 연결된 구독은 이름·번호만 같은 다른 회원(동명이인)에게 붙이지 않는다
  const S = { byId: {}, byPN: {}, byName: {}, byPhone: {}, bj: new Set(bj.map((r) => r.member_id)), linked: new Set(((linked && linked.data) || []).map((r) => r.subscriber_id)) };
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
  if (p && S.byPN[`${p}|${n}`] && !(S.linked && S.linked.has(S.byPN[`${p}|${n}`].id))) return S.byPN[`${p}|${n}`]; // 가족이 대신 내주는 구독: 실제 쓰는 회원에게 연결돼 있으면 결제한 사람에게는 안 붙인다
  const byN = S.byName[n];
  if (byN && byN.length === 1 && !(S.linked && S.linked.has(byN[0].id))) return byN[0];
  const byP = p && S.byPhone[p];
  if (byP && ['active', 'payment_failed'].includes(byP.status) && !(S.linked && S.linked.has(byP.id))) return byP;
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
    if (started0 !== null && started0 <= 28) return '신규';
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
  if (started !== null && started <= 28) return '신규';
  return '정착';
}

const ACTIVE_ST = ['사용 중', '예정', '홀딩'];
// 브로제이 이름 꼬리표 (PT+헬스 등)에 PT가 있으면 PT 이력이 있는 회원 (이용권 기록이 남지 않은 옛 PT 회원)
const hasPtTag = (m) => !!(m && m.pt_history) || /PT/i.test((m && m.usage_tag) || '');
const MEMBER_COLS = 'id,name,phone,gender,usage_tag,pt_history,stage,holding,first_started_on,ends_on,last_attended_on,total_visits,lifetime_paid,counselor,trainer,source,marketing_consent,memo,subscriber_id';

// 1000줄씩 나눠 받기. 서버(미국)와 DB(도쿄)가 멀어서 한 번에 8쪽씩 동시에 받는다 (8천 줄까지 한 번 왕복).
async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += 8000) {
    const pages = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => build().range(from + i * 1000, from + i * 1000 + 999)));
    for (const { data, error } of pages) {
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
}
// 결과를 기억해 두지 않는다 (항상 DB 최신 그대로 → 입실 체크도 바로 보인다).
// 한 요청 안에서 같은 걸 동시에 여러 군데서 찾을 때만 한 번으로 합친다.
const CACHE = new Map();
async function memo(key, ms, fn) {
  const hit = CACHE.get(key);
  if (hit) return hit;
  const p = Promise.resolve().then(fn);
  CACHE.set(key, p);
  p.finally(() => { if (CACHE.get(key) === p) CACHE.delete(key); }).catch(() => {});
  return p;
}
const clearCache = () => CACHE.clear();

// 체험권만 가진 회원은 '체험'으로 따로 (신규 = 정규 이용권으로 4주 안)
const allPassesCached = () => memo('passes_all', 300000, () => selectAll(() => supabase.from('crm_passes').select('id,member_id,product_name,category,status,starts_on,ends_on,total_count,registered_on,price_paid').neq('status', '무효')));
const trialOnlySet = () => memo('trial_set', 300000, async () => {
  const ps = await selectAll(() => supabase.from('crm_passes').select('member_id,product_name').in('status', ['사용 중', '예정', '홀딩']));
  const live = {}; ps.forEach((p) => { (live[p.member_id] = live[p.member_id] || []).push(p); });
  return new Set(Object.entries(live).filter(([, l]) => l.every((p) => /체험|^PT ?3회$/.test(p.product_name || ''))).map(([k]) => k));
});
function markTrial(list, set) { list.forEach((m) => { if (m.stage !== '만료·이탈' && set.has(m.id)) m.stage = '체험'; }); return list; }
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
  if (/^(락커|운동복|수건|양도|일일권)/.test(n.trim())) return '기타'; // '락커 · 10개월' 처럼 개월이 들어가도 헬스가 아니다
  if (cat === 'PT' || /PT|피티/i.test(n)) return 'PT';
  if (cat === 'GX 무제한' || /GX|스피닝|줌바|요가|필라|VIP|V\.I\.P|올엑세스|올액세스/.test(n)) return 'GX';
  if (cat === '월구독' || /구독/.test(n)) return '월구독';
  if (cat === '헬스 기간권' || /헬스|개월/.test(n)) return '헬스';
  return '기타';
}
const MEMBERSHIP = ['헬스', '월구독', 'GX', '기타'];
// 신규·재등록 기준: 예전에 등록한 적 있으면 재등록. PT는 처음 PT면 신규 (체험 PT 3회 9.9만은 셈에서 뺀다)
const isTrialPT = (name, price) => salesGroup(name) === 'PT' && (Number(price) === 99000 || /체험/.test(String(name || '')));
const isAddonName = (name, cat) => cat === '부가' || /락커|운동복|수건/.test(String(name || ''));
async function regKind(memberId, name, cat, price, beforeDay) {
  if (!memberId) return '신규';
  const isPT = salesGroup(name, cat) === 'PT';
  if (isPT && isTrialPT(name, price)) return '신규';
  const [ps, mm] = await Promise.all([
    supabase.from('crm_passes').select('product_name,category,price_paid,registered_on,starts_on').eq('member_id', memberId).not('status', 'in', '("무효","환불")'),
    supabase.from('crm_members').select('pt_history').eq('id', memberId).maybeSingle(),
  ]);
  if (ps.error) throw ps.error;
  const prev = ps.data.filter((x) => !isAddonName(x.product_name, x.category) && !isTrialPT(x.product_name, x.price_paid)
    && (!beforeDay || !(x.registered_on || x.starts_on) || (x.registered_on || x.starts_on) < beforeDay));
  if (isPT) return (mm.data && mm.data.pt_history) || prev.some((x) => salesGroup(x.product_name, x.category) === 'PT') ? '재등록' : '신규';
  return prev.length ? '재등록' : '신규';
}
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const kstHour = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).getUTCHours();

const DEFAULT_FINANCE = { profit: 5000000, costs: [] };
async function getFinance() {
  const [{ data, error }, pnl] = await Promise.all([
    supabase.from('crm_settings').select('value').eq('key', 'finance').maybeSingle(),
    supabase.from('crm_pnl_monthly').select('ym,pt_pay').order('ym', { ascending: false }).limit(3),
  ]);
  if (error) throw error;
  const v = (data && data.value) || DEFAULT_FINANCE;
  const costs = (v.costs || []).filter((c) => c && c.name).map((c) => ({ name: String(c.name).slice(0, 40), amount: Math.max(0, Math.round(Number(c.amount) || 0)), note: c.note ? String(c.note).slice(0, 80) : '' }));
  const floor = costs.reduce((a, c) => a + c.amount, 0);
  const profit = Math.max(0, Math.round(Number(v.profit) || 0));
  // PT 강사비(트레이너·매니저 급여)는 매출 따라 움직이니 손익표 최근 3개월 평균으로 잡는다
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
// 매출: '매출에서 뺌'(sales_excluded) 표시된 결제는 빼고 센다
const paymentsRaw = (fromISO, toISO) => selectAll(() => { let q = supabase.from('crm_payments').select('id,amount,paid_at,pass_id,member_id,kind,method,method_split,method_note,item').not('sales_excluded', 'is', true).gte('paid_at', fromISO); if (toISO) q = q.lt('paid_at', toISO); return q; });
async function paymentsWithGroup(fromISO, known, toISO, pre) {
  const pays = pre || await paymentsRaw(fromISO, toISO);
  const pm = await passesByIds(pays.map((p) => p.pass_id), known);
  return pays.map((p) => { const ps = pm[p.pass_id] || {}; return { ...p, day: kstDate(p.paid_at), group: salesGroup(ps.product_name || p.item, ps.category) }; }); // 이용권 없는 결제(매출장에서 넣은 것)는 항목 이름으로 나눈다
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
    } else if ((m.stage === '신규' || m.stage === '체험') && m.first_started_on) {
      const s = daysBetween(m.first_started_on, today);
      if (s >= 3 && s <= 13 && (m.days_absent == null || m.days_absent >= 5)) out.push({ ...base, key: `new:${m.id}:${m.first_started_on}`, kind: '신규', stage: m.stage, tag: m.days_absent == null ? '첫 방문 없음' : '신규',
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
  const [members, allPasses, paysPre, lockers, assigns, inq, totalCount, snap, att, attPast, finance, staff, subs, doneRows, smeta, sroles, trialSet] = await Promise.all([
    Promise.all([
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).neq('stage', '만료·이탈')),
      selectAll(() => supabase.from('crm_members').select(MEMBER_COLS).eq('stage', '만료·이탈').gte('ends_on', recentCut)),
    ]).then(([a, b]) => a.concat(b)),
    // 최근 200일 안에 끝나거나 아직 안 끝난 이용권만 (6개월 추이·이용권 구성에 충분)
    Promise.all([
      selectAll(() => supabase.from('crm_passes').select('id,member_id,category,product_name,status,starts_on,ends_on,remaining_count,total_count').gte('ends_on', new Date(Date.parse(today) - 200 * DAY).toISOString().slice(0, 10))),
      selectAll(() => supabase.from('crm_passes').select('id,member_id,category,product_name,status,starts_on,ends_on,remaining_count,total_count').is('ends_on', null)),
    ]).then(([a, b]) => a.concat(b)),
    paymentsRaw(monthStartISO),
    supabase.from('crm_lockers').select('number'),
    selectAll(() => supabase.from('crm_locker_assignments').select('locker_no,member_id,status,ends_on,billing').in('status', ['사용 중', '예정', '홀딩'])),
    supabase.from('crm_inquiries').select('id,name,phone,source,summary,staff_name,return_on,result,inquired_at,member_id').or(INQ_OK).gte('inquired_at', new Date(Date.parse(today) - 30 * DAY).toISOString()),
    supabase.from('crm_members').select('id', { count: 'exact', head: true }),
    supabase.from('crm_members').select('created_at').order('created_at', { ascending: false }).limit(1),
    selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').gte('checked_at', todayStartISO)),
    selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').gte('checked_at', new Date(Date.parse(todayStartISO) - 28 * DAY).toISOString()).lt('checked_at', todayStartISO)),
    getFinance(),
    supabase.from('crm_staff').select('id,name,role').eq('active', true).order('created_at'),
    subsMap(),
    selectAll(() => supabase.from('crm_tasks').select('task_key,done_by,done_at,kind,due_on,result').gte('done_at', new Date(Date.parse(monthStartISO) - 7 * DAY).toISOString())),
    staffMeta(), getRoles(), trialOnlySet(),
  ]);
  for (const r of [lockers, inq, totalCount, snap, staff]) if (r.error) throw r.error;
  const pays = await paymentsWithGroup(monthStartISO, Object.fromEntries(allPasses.map((p) => [p.id, p])), undefined, paysPre);

  const all = markTrial(members.map((m) => decorate(m, today, subs)), trialSet);
  const active = all.filter((m) => m.stage !== '만료·이탈');
  const stages = { '체험': 0, '신규': 0, '정착': 0, '미출석': 0, '만료 예정': 0 };
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
  uniqDays(attPast).forEach((a) => { const d = kstDate(a.checked_at); if (new Date(`${d}T00:00:00Z`).getUTCDay() === dow) { usual[kstHour(a.checked_at)]++; usualDays.add(d); } });
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
  // 기간 락커가 끝났는데 아직 정리(비우기·비밀번호 변경) 안 한 락커 (끝난 뒤 14일 안)
  const lx = await supabase.from('crm_locker_assignments').select('locker_no,member_id,ends_on,lock_code_changed_at').eq('status', '만료').eq('billing', '기간 결제').gte('ends_on', addDaysYMD(today, -14)).lt('ends_on', today);
  if (!lx.error) lx.data.forEach((x) => {
    const m = byId[x.member_id]; if (!m) return;
    if (assigns.some((a) => a.locker_no === x.locker_no)) return; // 다시 등록했거나 다른 분이 쓰는 중
    if (x.lock_code_changed_at && kstDate(x.lock_code_changed_at) >= x.ends_on) return;
    tasks.push({ key: `lockx:${m.id}:${x.ends_on}`, member_id: m.id, name: m.name, phone: m.phone, in_gym: inGym[m.id] || null, kind: '락커', stage: m.stage, tag: `${x.locker_no}번 락커`,
      title: '락커 기간이 끝났어요 · 짐을 비우고 비밀번호를 바꿔주세요', sub: [`${x.locker_no}번 락커`, `${+x.ends_on.slice(5, 7)}.${+x.ends_on.slice(8)} 만료`], action: '락커 정리 완료', group: '이번 주 안에' });
  });
  // 구독에 락커 애드온을 넣었는데 아직 락커 번호가 없는 분
  // 락커가 이미 배정돼 있으면(브로제이에서 가져온 '기간 결제' 락커 포함) 할 일에 안 띄운다
  const subLock = new Set(assigns.filter((a) => ['사용 중', '예정', '홀딩'].includes(a.status || '사용 중')).map((a) => a.member_id));
  all.forEach((m) => {
    const sb = subOf(m, subs);
    if (!sb || !['active', 'paused'].includes(sb.status) || !(sb.addons || []).includes('locker') || subLock.has(m.id)) return;
    tasks.push({ key: `lock:${m.id}:`, member_id: m.id, name: m.name, phone: m.phone, in_gym: inGym[m.id] || null, kind: '락커', stage: m.stage, tag: '구독 락커',
      title: '월구독에 락커를 추가했어요 · 락커 번호를 정해주세요', sub: ['월구독 · 락커 애드온', m.last_attended_on ? `마지막 출석 ${+m.last_attended_on.slice(5, 7)}.${+m.last_attended_on.slice(8)}` : '방문 기록 없음'], action: '락커 번호 배정', group: '오늘 안에' });
  });
  // 문의 리턴 연락: 결과가 아직 없고 리턴 날짜가 오늘이거나 지난 문의 (7일 안)
  inq.data.filter((q) => !q.result && !q.member_id && q.return_on && q.return_on <= today && daysBetween(q.return_on, today) <= 7).forEach((q) => {
    const sm = parseInqSummary(q.summary);
    const late = daysBetween(q.return_on, today);
    tasks.push({ key: `inq:${q.id}:${q.return_on}`, member_id: null, inquiry_id: q.id, name: q.name, phone: q.phone, in_gym: null, kind: '유입', stage: '유입',
      tag: `리턴${late ? ` ${late}일 지남` : ' 오늘'}`, title: `상담 ${daysBetween(kstDate(q.inquired_at), today)}일째 · 리턴 연락할 날`,
      sub: [q.source || '문의', ...(sm.reason ? [`미등록 사유: ${sm.reason}`] : []), ...(q.staff_name ? [`상담 ${q.staff_name}`] : [])], action: '리턴 전화', group: '오늘 안에' });
  });
  const done = Object.fromEntries(doneRows.filter((r) => !r.task_key.startsWith('snz:')).map((r) => [r.task_key, r]));
  // '안 받음'으로 미룬 일: due_on 전까지 숨기고, 그날 다시 올라온다
  const snz = Object.fromEntries(doneRows.filter((r) => r.task_key.startsWith('snz:') && r.due_on && r.due_on > today).map((r) => [r.task_key.slice(4), r]));
  const doneToday = doneRows.filter((r) => kstDate(r.done_at) === today);
  const list = tasks.filter((t) => !done[t.key] || kstDate(done[t.key].done_at) === today)
    .map((t) => (done[t.key] ? { ...t, done: true, done_by: done[t.key].done_by, done_at: done[t.key].done_at, result: done[t.key].result } : snz[t.key] ? { ...t, snoozed: snz[t.key].due_on, snoozed_by: snz[t.key].done_by } : t));
  const staffStats = {};
  (staff.data || []).forEach((s) => { staffStats[s.name] = { today: 0, month: 0 }; });
  doneRows.filter((r) => r.done_at >= monthStartISO).forEach((r) => { const s = (staffStats[r.done_by] = staffStats[r.done_by] || { today: 0, month: 0 }); s.month++; if (kstDate(r.done_at) === today) s.today++; });

  // 직원 퇴근 미기록 (지난 2주, 오늘 제외) → 매니저가 출근부에서 입력
  let workMissing = [];
  try {
    const wm = await supabase.from('crm_staff_attendance').select('id,staff_id,work_date,in_at').is('out_at', null).lt('work_date', today).gte('work_date', iso2(Date.parse(today) - 14 * DAY));
    if (!wm.error && wm.data && wm.data.length) {
      const nm = Object.fromEntries(((await supabase.from('crm_staff').select('id,name')).data || []).map((x) => [x.id, x.name]));
      workMissing = wm.data.map((r) => ({ id: r.id, name: nm[r.staff_id] || '-', day: r.work_date, in: kstHM(r.in_at) })).sort((a, b) => b.day.localeCompare(a.day));
    }
  } catch (e) { workMissing = []; }
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
    tasks: list, doneToday: doneToday.length, workMissing,
    staff: sortStaff(staff.data || [], smeta.order).map((s) => ({ ...s, ...(staffStats[s.name] || { today: 0, month: 0 }) })),
    roleColors: roleColorsOf(sroles, smeta.colors),
  }];
}

// ---------- 할 일 완료 ----------
const TASK_KEY = /^(exp|pay|abs14|abs30|nov|new|lapse|inq|lockx):[0-9a-f-]{36}:[0-9-]{0,10}$/;
const TASK_RESULTS = ['연락 완료', '문자 보냄', '직접 만남', '재등록 의사 있음', '거절', '안 받음'];
const TASK_LABEL = { exp: '재등록 안내', pay: '결제 실패 안내', abs14: '미출석 안부', abs30: '장기 미출석 연락', nov: '첫 방문 연락', new: '신규 안부', lapse: '복귀 안내', inq: '리턴 연락', lockx: '락커 정리' };
async function taskSnooze({ key, staff, days = 1 }) {
  if (!TASK_KEY.test(String(key || ''))) return [400, { error: '할 일 정보가 맞지 않아요' }];
  const name = String(staff || '').trim();
  if (!name) return [400, { error: '처리한 직원을 골라주세요' }];
  const n = Math.min(7, Math.max(1, Math.round(Number(days) || 1)));
  const [kind, refId] = key.split(':');
  const isInq = kind === 'inq';
  const until = new Date(Date.parse(todayKST()) + n * DAY).toISOString().slice(0, 10);
  const { error } = await supabase.from('crm_tasks').upsert({ task_key: `snz:${key}`, member_id: isInq ? null : refId, inquiry_id: isInq ? refId : null, kind: 'snooze', due_on: until, done_at: new Date().toISOString(), done_by: name, result: '안 받음 · 다시 연락' }, { onConflict: 'task_key' });
  if (error) throw error;
  if (!isInq) await supabase.from('crm_events').insert({ member_id: refId, kind: '할 일', body: `${TASK_LABEL[kind]} · 안 받음 → ${+until.slice(5, 7)}.${+until.slice(8)} 다시 연락`, staff_name: name });
  return [200, { success: true, until }];
}
async function taskDone({ key, staff, note, result }) {
  if (result && TASK_RESULTS.includes(result)) note = `${result}${note ? ` · ${note}` : ''}`;
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
  if (kind === 'lockx') await supabase.from('crm_locker_assignments').update({ lock_code_changed_at: new Date().toISOString() }).eq('member_id', member_id).eq('ends_on', key.split(':')[2]).eq('billing', '기간 결제');
  await supabase.from('crm_events').insert({ member_id, kind: '할 일', body: `${TASK_LABEL[kind]} 완료${note ? ` · ${String(note).slice(0, 300)}` : ''}`, staff_name: name });
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
const INQ_OK = 'legacy_id.is.null,legacy_id.like.notion:*';
async function inquiryList() {
  const [data, sync] = await Promise.all([
    selectAll(() => supabase.from('crm_inquiries').select('id,legacy_id,name,phone,source,raw_note,summary,staff_name,return_on,result,member_id,inquired_at').or(INQ_OK).order('inquired_at', { ascending: false })),
    syncStatus(),
  ]);
  return [200, { today: todayKST(), inquiries: data.map((q) => ({ ...q, ...parseInqSummary(q.summary), raw_note: q.raw_note ? q.raw_note.slice(0, 600) : null, from_notion: String(q.legacy_id || '').startsWith('notion:'), legacy_id: undefined, summary: undefined })), sources: INQ_SOURCES, sync }];
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
  // 필요한 걸 한 번에 같이 묻는다 (서버↔DB 왕복 줄이기)
  const [a, b, sess, nrows, nlogs, sync, staffRes] = await Promise.all([
    selectAll(() => supabase.from('crm_passes').select(COLS).eq('category', 'PT')),
    selectAll(() => supabase.from('crm_passes').select(COLS).ilike('product_name', '%PT%')),
    selectAll(() => supabase.from('crm_pt_sessions').select('pass_id,member_id,trainer,unit_price,at').gte('at', kstStart(from)).lt('at', kstEndEx(to))).catch(() => []),
    selectAll(() => supabase.from('crm_pt_notion').select('*')),
    selectAll(() => supabase.from('crm_pt_notion_log').select('notion_id,trainer,member_id,delta,day').gte('day', from).lte('day', to)),
    syncStatus(),
    supabase.from('crm_staff').select('name,role').eq('active', true),
  ]);
  const passes = [...new Map(a.concat(b).map((p) => [p.id, p])).values()];
  const pts = passes.filter((p) => salesGroup(p.product_name, p.category) === 'PT' && p.status !== '무효');
  const live = pts.filter((p) => ['사용 중', '예정', '홀딩'].includes(p.status));
  const ids = [...new Set(pts.map((p) => p.member_id).concat(nrows.map((n) => n.member_id)).filter(Boolean))];
  const names = {};
  const nchunks = []; for (let i = 0; i < ids.length; i += 150) nchunks.push(ids.slice(i, i + 150));
  for (const { data, error } of await Promise.all(nchunks.map((c) => supabase.from('crm_members').select('id,name,phone,last_attended_on,trainer').in('id', c)))) {
    if (error) throw error;
    data.forEach((m) => { names[m.id] = m; });
  }
  const unit = (p) => (p.total_count ? Math.round((p.price_paid || 0) / p.total_count) : 0);
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
  const source = nrows.length ? 'notion' : 'broj';
  let stale = 0;
  if (nrows.length) {
    const passOf = {}; live.forEach((p) => { if (!passOf[p.member_id] || String(p.ends_on) > String(passOf[p.member_id].ends_on)) passOf[p.member_id] = p; });
    rows.length = 0;
    const staleBefore = Date.now() - 90 * DAY;
    stale = nrows.filter((n) => n.status !== '완료' && n.notion_edited_at && Date.parse(n.notion_edited_at) < staleBefore).length;
    nrows.filter((n) => n.status !== '완료' && !(n.notion_edited_at && Date.parse(n.notion_edited_at) < staleBefore)).forEach((n) => {
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
  return [200, { today, period, from, to, source, sync, stale, unmatched: rows.filter((r) => r.matched && r.matched !== '자동').length,
    registered: { members: new Set(newOnes.map((p) => p.member_id)).size, sessions: newOnes.reduce((a, p) => a + (p.total_count || 0), 0), amount: newOnes.reduce((a, p) => a + (p.price_paid || 0), 0) },
    remaining: { sessions: leftTotal, amount: rows.reduce((a, r) => a + r.left_amount, 0), months: sess.length >= 20 ? Math.round(leftTotal / (sess.length / Math.max(1, Math.round((Date.parse([to, today].sort()[0]) - Date.parse(from)) / DAY) + 1) * 30) * 10) / 10 : null },
    used: { sessions: sess.length, amount: sess.reduce((a, x) => a + (x.unit_price || 0), 0), perDay: Math.round(sess.length / Math.max(1, Math.round((Date.parse([to, today].sort()[0]) - Date.parse(from)) / DAY) + 1) * 10) / 10, daily: dailySess, lifetime: rows.reduce((a, r) => a + r.used, 0) },
    staff: staffRes.data || [],
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
    // 결제와 이용권 이름을 동시에 받아서 한 번 더 묻지 않게
    Promise.all([paymentsRaw(kstStart(from), kstEndEx(to)), allPassesCached()]).then(([pr, ap]) => paymentsWithGroup(null, Object.fromEntries(ap.map((x) => [x.id, x])), null, pr)),
    getFinance(),
    supabase.from('subscribers').select('name,plan,status,next_billing_date'),
    supabase.from('crm_payments').select('id,amount,paid_at,pass_id,member_id,kind,method,method_split,method_note,item').not('sales_excluded', 'is', true).order('paid_at', { ascending: false }).limit(8),
  ]);
  if (subs.error || recent.error) throw subs.error || recent.error;
  const total = pays.reduce((a, p) => a + p.amount, 0);
  const groups = { PT: 0, 헬스: 0, GX: 0, 월구독: 0, 기타: 0 };
  pays.forEach((p) => { groups[p.group] += p.amount; });
  const daily = {}; pays.forEach((p) => { daily[p.day] = (daily[p.day] || 0) + p.amount; });
  // 결제 실패 후 2주가 지나면 이탈로 본다 (할 일의 '만료 예정' 14일과 같게)
  const fails = (subs.data || []).filter((x) => x.status === 'payment_failed' && x.next_billing_date && daysBetween(x.next_billing_date, today) <= 14);
  // 목록: 오늘 결제, 없으면 최근 결제
  const listSrc = pays.filter((p) => p.day === today);
  const pick = listSrc.length ? listSrc : recent.data;
  const mids = [...new Set(pick.map((p) => p.member_id).filter(Boolean))];
  const nm = {};
  const [pm, nres] = await Promise.all([passesByIds(pick.map((p) => p.pass_id)), mids.length ? supabase.from('crm_members').select('id,name').in('id', mids) : { data: [] }]);
  if (nres.error) throw nres.error;
  nres.data.forEach((m) => { nm[m.id] = m.name; });
  const list = pick.map((p) => ({ id: p.id, method: p.method || null, split: p.method_split || null, note: p.method_note || null, name: p.member_id ? nm[p.member_id] || '-' : '비회원', member_id: p.member_id || null, amount: p.amount, kind: p.kind, product: (pm[p.pass_id] || {}).product_name || p.item || '-', group: salesGroup((pm[p.pass_id] || {}).product_name || p.item, (pm[p.pass_id] || {}).category), at: p.paid_at }));
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  // 결제 방법 (월구독은 토스 자동결제라 뺀다)
  const methods = {}; PAY_METHODS.concat(['미입력']).forEach((k) => { methods[k] = { amount: 0, count: 0 }; });
  pays.filter((p) => p.group !== '월구독').forEach((p) => {
    const sp = p.method_split && typeof p.method_split === 'object' ? Object.entries(p.method_split).filter(([k]) => PAY_METHODS.includes(k)) : [];
    if (sp.length > 1) { sp.forEach(([k, v]) => { methods[k].amount += Number(v) || 0; methods[k].count++; }); return; }
    const k = PAY_METHODS.includes(p.method) ? p.method : '미입력'; methods[k].amount += p.amount; methods[k].count++;
  });
  return [200, { period, label, from, to, today, days, total, count: pays.length, groups, daily, methods, goal: period === 'today' ? Math.round(finance.target / 30) : finance.target,
    dailyGoal: Math.round(finance.target / 30), lastPayDay: pays.reduce((a, p) => (p.day > a ? p.day : a), '') || null,
    unpaid: { count: fails.length, amount: fails.reduce((a, x) => a + (PLAN_PRICE[x.plan] || 39000), 0) },
    routes: { 토스자동결제: { amount: groups.월구독, count: pays.filter((p) => p.group === '월구독').length }, 인포결제: { amount: total - groups.월구독, count: pays.filter((p) => p.group !== '월구독').length } },
    list, listIsToday: listSrc.length > 0 }];
}

// ---------- 날짜별 등록 내역 (최신 날짜부터, 하루 단위로 끊어서 '더 보기') ----------
// before: 이 날짜 '전'까지 (YYYY-MM-DD, 없으면 오늘까지) · date: 이 날짜부터 거꾸로 · filter: all | 신규 | 재등록 | 복귀 | 환불 | nosub(월구독 자동결제 빼기)
async function salesDays({ before = '', date = '', filter = 'all', maxDays = 0 } = {}) {
  const today = todayKST(), YMD = /^\d{4}-\d{2}-\d{2}$/;
  const end = YMD.test(date) ? addDaysYMD(date, 1) : YMD.test(before) ? before : addDaysYMD(today, 1); // 이 날 0시 전까지
  const LIMIT = 150;
  let q = supabase.from('crm_payments').select('id,amount,paid_at,pass_id,member_id,kind,method,method_split,method_note,item')
    .not('sales_excluded', 'is', true).lt('paid_at', kstStart(end)).order('paid_at', { ascending: false }).limit(LIMIT);
  if (['신규', '재등록', '복귀', '추가', '환불'].includes(filter)) q = q.eq('kind', filter);
  const { data, error } = await q;
  if (error) throw error;
  const dayOf = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
  let rows = data, next = null;
  if (data.length === LIMIT) {
    const last = dayOf(data[data.length - 1].paid_at);
    const cut = data.filter((x) => dayOf(x.paid_at) !== last);
    // 마지막 날은 잘렸을 수 있어서 다음 쪽에서 통째로 보여준다 (하루가 혼자 150건을 넘으면 그대로)
    if (cut.length) { rows = cut; next = addDaysYMD(last, 1); } else next = last;
  }
  if (filter === 'nosub') rows = rows.filter((x) => !/^토스 자동결제/.test(x.method_note || ''));
  const mids = [...new Set(rows.map((x) => x.member_id).filter(Boolean))];
  const [pm, mres] = await Promise.all([passesByIds(rows.map((x) => x.pass_id)),
    mids.length ? supabase.from('crm_members').select('id,name').in('id', mids) : { data: [] }]);
  if (mres.error) throw mres.error;
  const nm = Object.fromEntries((mres.data || []).map((m) => [m.id, m.name]));
  const days = [], byDay = {};
  rows.forEach((x) => {
    const d = dayOf(x.paid_at), ps = pm[x.pass_id] || {};
    // 월구독에 락커·운동복이 붙은 결제는 item 에 '베이직 구독권 + 락커' 처럼 적어 둔다
    const product = (x.item && /구독/.test(x.item)) ? x.item : (ps.product_name || x.item || '-');
    const group = salesGroup(product, ps.category);
    const auto = /^토스 자동결제/.test(x.method_note || '') || (group === '월구독' && (!x.method || x.method === '카드')); // 월구독 카드결제 = 자동결제 (카운터 현금·계좌는 아님)
    if (!byDay[d]) { byDay[d] = { day: d, total: 0, count: 0, items: [] }; days.push(byDay[d]); }
    byDay[d].total += x.amount; byDay[d].count++;
    // PT 3회 9.9만 = 체험 PT
    const trial = group === 'PT' && (x.amount === 99000 || /체험/.test(product));
    byDay[d].items.push({ id: x.id, name: x.member_id ? nm[x.member_id] || '-' : '비회원', member_id: x.member_id || null, kind: x.kind, product, trial,
      group, amount: x.amount, method: x.method || null, split: x.method_split || null, note: auto ? null : (x.method_note || null), auto });
  });
  let outDays = days;
  if (filter === 'nosub') outDays = days.map((d) => { const it = d.items.filter((x) => !x.auto); return { ...d, items: it, count: it.length, total: it.reduce((a, x) => a + x.amount, 0) }; }).filter((d) => d.items.length);
  const n = Math.max(0, Math.min(60, Number(maxDays) || 0));
  if (n && outDays.length > n) { outDays = outDays.slice(0, n); next = outDays[n - 1].day; } // 이 날 '전'부터 다음 쪽
  return [200, { today, days: outDays, next }];
}

// ---------- 보고서 v2 (월 + 주차, 크마스터처럼 보기 쉽게) ----------
const isTrialName = (nm) => /체험|^PT ?3회$/.test(nm || '');
function monthWeeks(ym) {
  const [y, m] = ym.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = []; for (let i = 0; i * 7 < last; i++) out.push({ n: i + 1, from: `${ym}-${String(i * 7 + 1).padStart(2, '0')}`, to: `${ym}-${String(Math.min(last, i * 7 + 7)).padStart(2, '0')}` });
  return out;
}
async function reportV2({ ym, week }) {
  const today = todayKST();
  const YM = /^\d{4}-\d{2}$/.test(String(ym || '')) && ym <= today.slice(0, 7) ? ym : today.slice(0, 7);
  const weeks = monthWeeks(YM), wk = weeks.find((w) => w.n === Number(week)) || null;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const [y, m] = YM.split('-').map(Number);
  let from, to, prevFrom, prevTo, label;
  if (wk) { from = wk.from; to = wk.to; prevFrom = iso(Date.parse(from) - 7 * DAY); prevTo = iso(Date.parse(from) - DAY); label = `${m}월 ${wk.n}주차`; }
  else { from = `${YM}-01`; to = weeks[weeks.length - 1].to; prevFrom = iso(Date.UTC(y, m - 2, 1)); prevTo = iso(Date.UTC(y, m - 1, 0)); label = `${y}년 ${m}월`; }
  // 진행 중인 기간은 지난 기간도 같은 날짜 수만큼만 비교
  const partial = to > today, end = partial ? today : to;
  const n = Math.round((Date.parse(end) - Date.parse(from)) / DAY) + 1;
  const prevEnd = partial ? [prevTo, iso(Date.parse(prevFrom) + (n - 1) * DAY)].sort()[0] : prevTo;
  const inR = (d, a, b) => d && d >= a && d <= b;
  const t12 = iso(Date.UTC(y, m - 12, 1));
  const [allPasses, pays, inqs, att, subs, members] = await Promise.all([
    allPassesCached(),
    paymentsWithGroup(kstStart(t12 < prevFrom ? t12 : prevFrom), {}, kstEndEx(to)),
    selectAll(() => supabase.from('crm_inquiries').select('id,name,phone,member_id,source,result,summary,raw_note,inquired_at').or(INQ_OK)),
    selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').gte('checked_at', kstStart(prevFrom)).lt('checked_at', kstEndEx(to))),
    supabase.from('subscribers').select('cancelled_at,status,churn_reason'),
    memo('members_min', 120000, () => selectAll(() => supabase.from('crm_members').select('id,name,phone'))),
  ]);
  if (subs.error) throw subs.error;
  const person = Object.fromEntries(members.map((x) => [x.id, x]));
  const passById = Object.fromEntries(allPasses.map((x) => [x.id, x]));
  const byMember = {}; allPasses.forEach((x) => { (byMember[x.member_id] = byMember[x.member_id] || []).push(x); });
  const firstReg = {}; allPasses.forEach((x) => { if (x.registered_on && (!firstReg[x.member_id] || x.registered_on < firstReg[x.member_id])) firstReg[x.member_id] = x.registered_on; });
  const isCount = (x) => salesGroup(x.product_name, x.category) === 'PT' || (x.total_count > 0 && !/개월|구독/.test(x.product_name || ''));
  // ① 회원 현황 (기간 마지막 날 기준)
  const snap = (d) => {
    const live = allPasses.filter((x) => x.starts_on && x.starts_on <= d && (!x.ends_on || x.ends_on >= d) && !isTrialName(x.product_name));
    const all = new Set(live.map((x) => x.member_id)), per = new Set(live.filter((x) => !isCount(x)).map((x) => x.member_id)), cnt = new Set(live.filter(isCount).map((x) => x.member_id));
    const hold = new Set(live.filter((x) => x.status === '홀딩').map((x) => x.member_id));
    return { total: all.size, period: per.size, count: cnt.size, holding: hold.size };
  };
  const sNow = snap(end), sPrev = snap(prevEnd);
  const trials = {}; allPasses.filter((x) => isTrialName(x.product_name) && inR(x.registered_on, from, end)).forEach((x) => { trials[x.product_name] = (trials[x.product_name] || 0) + 1; });
  // ② 매출 현황
  const pIn = pays.filter((p) => inR(p.day, from, end)), pPrev = pays.filter((p) => inR(p.day, prevFrom, prevEnd));
  const sum = (a) => a.reduce((x, p) => x + p.amount, 0);
  const groups = { 헬스: 0, GX: 0, 월구독: 0, PT: 0, 기타: 0 }; pIn.forEach((p) => { groups[p.group] = (groups[p.group] || 0) + p.amount; });
  const top = {}; pIn.forEach((p) => { const nm = (passById[p.pass_id] || {}).product_name || '기타'; const o = (top[nm] = top[nm] || { name: nm, count: 0, amount: 0 }); o.count++; o.amount += p.amount; });
  // ③ 고객 퍼널: 유입 → 체험 → 정규 등록(처음 오신 분) → 재등록
  const qIn = inqs.filter((q) => inR(kstDate(q.inquired_at), from, end));
  const bare = (v) => String(v || '').replace(/\(.*?\)|\s/g, '');
  const trialPeople = {}, newPeople = {};
  pIn.forEach((p) => {
    const nm = (passById[p.pass_id] || {}).product_name || '';
    if (isTrialName(nm)) { if (!trialPeople[p.member_id]) trialPeople[p.member_id] = { day: p.day, product: nm }; return; }
    if (p.kind === '신규' && firstReg[p.member_id] && firstReg[p.member_id] >= from && !newPeople[p.member_id]) newPeople[p.member_id] = { day: p.day, product: nm };
  });
  // 브로제이가 '신규'로 안 찍었어도 처음 등록이 이 기간이면 처음 오신 분
  allPasses.filter((x) => !isTrialName(x.product_name) && x.registered_on && inR(x.registered_on, from, end) && firstReg[x.member_id] === x.registered_on && !newPeople[x.member_id]).forEach((x) => { newPeople[x.member_id] = { day: x.registered_on, product: x.product_name }; });
  const returnedN = new Set(pIn.filter((p) => p.kind === '신규' && !isTrialName((passById[p.pass_id] || {}).product_name) && firstReg[p.member_id] && firstReg[p.member_id] < from).map((p) => p.member_id)).size;
  const inqOf = (mid, day) => {
    const ps = person[mid] || {}, until = iso(Date.parse(day) + DAY), since = iso(Date.parse(day) - 180 * DAY);
    let qs = inqs.filter((q) => (q.member_id === mid || (ps.phone && q.phone === ps.phone)) && kstDate(q.inquired_at) <= until);
    if (!qs.length && ps.name) qs = inqs.filter((q) => bare(q.name) === bare(ps.name) && kstDate(q.inquired_at) <= until && kstDate(q.inquired_at) >= since);
    return qs.map((q) => kstDate(q.inquired_at)).sort().pop() || null;
  };
  const regList = Object.entries(newPeople).map(([mid, v]) => { const q = inqOf(mid, v.day); return { member_id: mid, name: (person[mid] || {}).name || '-', day: v.day, product: v.product, origin: q && q >= from ? '이 기간 문의' : q ? '그 전 문의' : '워크인 로그에 없음', inq_day: q }; }).sort((a, b) => b.day.localeCompare(a.day));
  const fromInq = regList.filter((r) => r.origin === '이 기간 문의').length;
  const qState = (q) => (q.result === '등록' ? '전환 완료' : q.result === '미등록' ? '미전환' : '진행 중');
  const inqList = qIn.map((q) => { const sm = parseInqSummary(q.summary); return { member_id: q.member_id, name: q.name, day: kstDate(q.inquired_at), state: qState(q), source: q.source, memo: [sm.reason ? `사유 ${sm.reason}` : '', sm.interest ? `관심 ${sm.interest}` : '', (q.raw_note || '').slice(0, 80)].filter(Boolean).join(' · ') }; }).sort((a, b) => b.day.localeCompare(a.day));
  const trialList = Object.entries(trialPeople).map(([mid, v]) => { const conv = (byMember[mid] || []).some((x) => !isTrialName(x.product_name) && x.registered_on && x.registered_on >= v.day); return { member_id: mid, name: (person[mid] || {}).name || '-', day: v.day, product: v.product, state: conv ? '전환 완료' : '미전환' }; });
  // 재등록: 이 기간에 끝난 회원권(PT·체험·월구독 제외) 중 45일 안에 다음 걸 산 사람
  const nonPT = allPasses.filter((x) => !['PT', '월구독'].includes(salesGroup(x.product_name, x.category)) && !isTrialName(x.product_name));
  const endedBy = {}; nonPT.filter((x) => inR(x.ends_on, from, end)).forEach((x) => { if (!endedBy[x.member_id] || x.ends_on > endedBy[x.member_id].ends_on) endedBy[x.member_id] = x; });
  const renewList = Object.entries(endedBy).map(([mid, x]) => { const nx = (byMember[mid] || []).find((z) => z.id !== x.id && !isTrialName(z.product_name) && z.ends_on > x.ends_on && z.starts_on && z.starts_on <= iso(Date.parse(x.ends_on) + 45 * DAY)); return { member_id: mid, name: (person[mid] || {}).name || '-', day: x.ends_on, product: x.product_name, state: nx ? '재등록' : x.ends_on >= today ? '아직 남음' : '안 함', next: nx ? nx.product_name : null }; }).sort((a, b) => a.day.localeCompare(b.day));
  const renewed = renewList.filter((r) => r.state === '재등록').length, endedDone = renewList.filter((r) => r.state !== '아직 남음').length;
  // ④ 최근 12개월
  const months = []; for (let i = 11; i >= 0; i--) months.push(iso(Date.UTC(y, m - 1 - i, 1)).slice(0, 7));
  const trend = months.map((mo) => ({ ym: mo, revenue: pays.filter((p) => p.day.slice(0, 7) === mo).reduce((a, p) => a + p.amount, 0), newPeople: Object.values(firstReg).filter((d) => d.slice(0, 7) === mo).length, hasPays: mo >= '2025-12' }));
  // ⑤ 출석
  const attU = uniqDays(att);
  const aIn = attU.filter((x) => inR(kstDate(x.checked_at), from, end)), aPrev = attU.filter((x) => inR(kstDate(x.checked_at), prevFrom, prevEnd));
  const hours = Array(24).fill(0); aIn.forEach((x) => hours[kstHour(x.checked_at)]++);
  const dayCnt = new Set(aIn.map((x) => kstDate(x.checked_at))).size;
  // ⑥ 왜 그런가 (경로·미등록 사유·해지 사유)
  const src = {}; qIn.forEach((q) => { const k = q.source || '기록 없음'; const o = (src[k] = src[k] || { source: k, count: 0, joined: 0 }); o.count++; if (q.result === '등록') o.joined++; });
  // 노션에는 '등록'인데 CRM에 결제·이용권이 아직 없는 분 (브로제이 반영 전) — 보고서에서 빠지지 않게 따로 보여준다
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const nameKeys = (v) => { const raw = String(v || ''); const inner = (raw.match(/\(([^)]*)\)/) || [])[1]; return [bare(raw), bare(inner)].filter((k) => k && k.length >= 2); };
  const since120 = iso(Date.parse(end) - 120 * DAY);
  const pendingReg = inqs.filter((q) => q.result === '등록' && inR(kstDate(q.inquired_at), since120, end)).filter((q) => {
    const d = kstDate(q.inquired_at), ph = digits(q.phone), keys = nameKeys(q.name);
    const mids = members.filter((x) => x.id === q.member_id || (ph && digits(x.phone) === ph) || keys.includes(bare(x.name))).map((x) => x.id);
    const after = iso(Date.parse(d) - 3 * DAY);
    return !mids.some((mid) => (byMember[mid] || []).some((x) => (x.registered_on || x.starts_on || '') >= after)); // 체험 등록도 등록 확인으로 본다
  }).map((q) => ({ name: q.name, day: kstDate(q.inquired_at), source: q.source || null, interest: parseInqSummary(q.summary).interest || null }))
    .sort((a, b) => b.day.localeCompare(a.day));
  const noReg = {}; qIn.forEach((q) => { const r = parseInqSummary(q.summary).reason; if (r) noReg[r] = (noReg[r] || 0) + 1; });
  const churn = {}; (subs.data || []).filter((x) => x.status === 'cancelled' && x.cancelled_at && inR(kstDate(x.cancelled_at), from, end) && x.churn_reason && !/테스트|복구/.test(x.churn_reason)).forEach((x) => { const k = String(x.churn_reason).slice(0, 14); churn[k] = (churn[k] || 0) + 1; });
  return [200, {
    today, period: { ym: YM, week: wk ? wk.n : null, label, from, to, end, prevFrom, prevTo: prevEnd, partial, weeks, minYm: '2025-12', lastPayDay: pays.reduce((a, p) => (p.day > a ? p.day : a), '') || null },
    members: { now: sNow, prev: sPrev, trials: Object.entries(trials).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) },
    sales: { total: sum(pIn), prev: sum(pPrev), count: pIn.length, groups, refund: 0, top: Object.values(top).sort((a, b) => b.amount - a.amount).slice(0, 5) },
    funnel: { inquiries: qIn.length, trial: trialList.length, regular: regList.length, renewed, ended: endedDone, endedAll: renewList.length, fromInq, trialConv: trialList.filter((t) => t.state === '전환 완료').length, returned: returnedN,
      lists: { 유입: inqList, 체험: trialList, 정규: regList, 재등록: renewList }, pendingReg },
    trend,
    attendance: { visits: aIn.length, visitors: new Set(aIn.map((x) => x.member_id)).size, prevVisits: aPrev.length, perDay: dayCnt ? Math.round(aIn.length / dayCnt * 10) / 10 : 0, peakHour: aIn.length ? hours.indexOf(Math.max(...hours)) : null, days: dayCnt },
    why: { sources: Object.values(src).sort((a, b) => b.count - a.count), noReg: Object.entries(noReg).sort((a, b) => b[1] - a[1]), churn: Object.entries(churn).sort((a, b) => b[1] - a[1]).slice(0, 6) },
  }];
}

// ---------- 출석부 (하루 입장 순서) ----------
async function attendanceDay({ date }) {
  const today = todayKST();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) && date <= today ? date : today;
  const rows = await selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').gte('checked_at', kstStart(d)).lt('checked_at', kstEndEx(d)).order('checked_at', { ascending: true }));
  const ids = [...new Set(rows.map((r) => r.member_id))];
  const chunks = []; for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
  const monthStart = kstStart(`${d.slice(0, 7)}-01`);
  const [mres, pres, ares, subs, trial] = await Promise.all([
    Promise.all(chunks.map((c) => supabase.from('crm_members').select(MEMBER_COLS).in('id', c))),
    Promise.all(chunks.map((c) => selectAll(() => supabase.from('crm_passes').select('member_id,product_name,category,ends_on,status').in('member_id', c).not('status', 'in', '("무효","환불")')))),
    Promise.all(chunks.map((c) => selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').in('member_id', c).gte('checked_at', monthStart).lt('checked_at', kstEndEx(d))))),
    subsMap(), trialOnlySet(),
  ]);
  const mem = {}, pass = {}, pt = {}, monthN = {};
  mres.forEach(({ data, error }) => { if (error) throw error; markTrial(data.map((m) => decorate(m, today, subs)), trial).forEach((m) => { mem[m.id] = m; }); });
  pres.forEach((data) => { data.forEach((p) => { if (salesGroup(p.product_name, p.category) === 'PT') { if (!pt[p.member_id] || ACTIVE_ST.includes(p.status)) pt[p.member_id] = p.product_name; return; } if (!ACTIVE_ST.includes(p.status)) return; if (!pass[p.member_id] || String(p.ends_on) > String(pass[p.member_id].ends_on)) pass[p.member_id] = p; }); });
  ares.forEach((l) => uniqDays(l).forEach((a) => { monthN[a.member_id] = (monthN[a.member_id] || 0) + 1; }));
  // 한 사람이 여러 번 찍으면 처음 입장 기준 한 줄 + 횟수
  const seen = {}, list = [];
  rows.forEach((r) => {
    const t = new Date(Date.parse(r.checked_at) + 9 * 3600e3).toISOString().slice(11, 16);
    if (seen[r.member_id]) { seen[r.member_id].times.push(t); seen[r.member_id].last_at = r.checked_at; return; }
    const m = mem[r.member_id] || {};
    const row = { member_id: r.member_id, name: m.name || '-', stage: m.stage || null, sub: m.sub || null, holding: !!m.holding, days_left: m.days_left ?? null, next_billing: m.next_billing || null,
      pass: pass[r.member_id] ? pass[r.member_id].product_name : (m.usage_tag || null), pt: pt[r.member_id] || (hasPtTag(m) ? 'PT' : null), times: [t], first_at: r.checked_at, last_at: r.checked_at, month: monthN[r.member_id] || 1 };
    seen[r.member_id] = row; list.push(row);
  });
  const nowMs = Date.now();
  list.forEach((x, i) => { x.no = i + 1; x.in_gym = d === today && nowMs - Date.parse(x.last_at) < 2 * 3600e3; });
  const hours = Array(24).fill(0); rows.forEach((r) => hours[kstHour(r.checked_at)]++);
  return [200, { date: d, today, total: rows.length, people: list.length, now: list.filter((x) => x.in_gym).length, hours, list }];
}

// ---------- 브로제이 회원 사진 가져오기 (한 번) ----------
// items: [{ phone, name, image(jpeg base64) }]  전화번호로 회원을 찾고, 이미 사진이 있는 회원은 건드리지 않는다
async function photoImport({ key, items }) {
  const st = await supabase.from('crm_settings').select('value').eq('key', 'att_import').maybeSingle();
  if (st.error) throw st.error;
  const v = st.data && st.data.value;
  if (!v || !key || v.key !== key || Date.now() > Date.parse(v.expires)) return [401, { error: '가져오기 키가 맞지 않거나 끝났어요' }];
  if (!Array.isArray(items) || items.length > 30) return [400, { error: '한 번에 30장까지예요' }];
  const members = await selectAll(() => supabase.from('crm_members').select('id,name,phone,photo_path'));
  const byPhone = {}; members.forEach((m) => { const d = String(m.phone || '').replace(/\D/g, ''); if (d) (byPhone[d] = byPhone[d] || []).push(m); });
  const out = { saved: 0, had: 0, nomatch: 0, bad: 0, names: [] };
  for (const it of items) {
    const d = String(it.phone || '').replace(/\D/g, ''); const nm = String(it.name || '').replace(/\(.*?\)/g, '').trim();
    const list = byPhone[d] || [];
    const m = list.length === 1 ? list[0] : list.find((x) => String(x.name || '').replace(/\(.*?\)/g, '').trim() === nm);
    if (!m) { out.nomatch++; continue; }
    if (m.photo_path) { out.had++; continue; }
    const buf = Buffer.from(String(it.image || '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    if (buf.length < 2000 || buf.length > 1024 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) { out.bad++; continue; }
    const path = `${m.id}.jpg`;
    const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true });
    if (up.error) throw up.error;
    const u = await supabase.from('crm_members').update({ photo_path: path, photo_taken_at: new Date().toISOString() }).eq('id', m.id).is('photo_path', null);
    if (u.error) throw u.error;
    m.photo_path = path; out.saved++;
  }
  return [200, out];
}

// ---------- 브로제이 출석 가져오기 ----------
// rows: [[전화번호, 입장 시각(ms), 브로제이 출석 번호], ...]  같은 출석 번호는 한 번만 들어간다
async function attendanceImport({ key, rows }) {
  const st = await supabase.from('crm_settings').select('value').eq('key', 'att_import').maybeSingle();
  if (st.error) throw st.error;
  const v = st.data && st.data.value;
  if (!v || !key || v.key !== key || Date.now() > Date.parse(v.expires)) return [401, { error: '가져오기 키가 맞지 않거나 끝났어요' }];
  if (!Array.isArray(rows) || rows.length > 3000) return [400, { error: '한 번에 3000줄까지예요' }];
  const members = await memo('members_phone', 300000, () => selectAll(() => supabase.from('crm_members').select('id,phone')));
  const byPhone = {}; members.forEach((m) => { const d = String(m.phone || '').replace(/\D/g, ''); if (d) byPhone[d] = m.id; });
  const out = [], miss = {};
  rows.forEach((r) => {
    const ph = String(r[0] || '').replace(/\D/g, ''), at = Number(r[1]), bk = Number(r[2]);
    if (!ph || !at || !bk) return;
    const mid = byPhone[ph];
    if (!mid) { miss[ph] = (miss[ph] || 0) + 1; return; }
    out.push({ member_id: mid, checked_at: new Date(at).toISOString(), via: 'broj', broj_key: bk });
  });
  for (let i = 0; i < out.length; i += 500) {
    const { error } = await supabase.from('crm_attendance').upsert(out.slice(i, i + 500), { onConflict: 'broj_key', ignoreDuplicates: true });
    if (error) throw error;
  }
  clearCache();
  return [200, { saved: out.length, unmatched: Object.values(miss).reduce((a, b) => a + b, 0), unmatchedPhones: Object.keys(miss).length }];
}

// 토스 결제 기록 조회 (읽기 전용) — 같은 1회용 키 사용. 미국 서버에만 토스 키가 있다.
// 결과는 crm_settings 'toss_tx' 에 그대로 보관해 CRM 결제와 비교한다 (CRM 결제는 건드리지 않음)
async function tossTx({ key, from, to }) {
  const st = await supabase.from('crm_settings').select('value').eq('key', 'att_import').maybeSingle();
  if (st.error) throw st.error;
  const v = st.data && st.data.value;
  if (!v || !key || v.key !== key || Date.now() > Date.parse(v.expires)) return [401, { error: '가져오기 키가 맞지 않거나 끝났어요' }];
  if (!process.env.TOSS_SECRET_KEY) return [503, { error: '이 서버에는 토스 키가 없어요' }];
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(String(from)) || !ymd.test(String(to))) return [400, { error: '날짜 형식' }];
  const auth = `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`;
  const all = []; let after = null;
  for (let i = 0; i < 50; i++) {
    const qs = new URLSearchParams({ startDate: `${from}T00:00:00`, endDate: `${to}T23:59:59`, limit: '100' });
    if (after) qs.set('startingAfter', after);
    const r = await fetch(`https://api.tosspayments.com/v1/transactions?${qs}`, { headers: { Authorization: auth } });
    const d = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(d)) return [502, { error: (d && d.message) || '토스 조회 실패' }];
    d.forEach((t) => all.push({ tk: t.transactionKey, pk: t.paymentKey, order: t.orderId, ck: t.customerKey, method: t.method, status: t.status, at: t.transactionAt, amount: t.amount }));
    if (d.length < 100) break;
    after = d[d.length - 1].transactionKey;
  }
  const up = await supabase.from('crm_settings').upsert({ key: 'toss_tx', value: { from, to, fetched_at: new Date().toISOString(), rows: all }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (up.error) throw up.error;
  return [200, { count: all.length, sum: all.reduce((a, t) => a + (Number(t.amount) || 0), 0) }];
}

// 브로제이 원본 보관 (매출내역·회원·이용권·락커·메모 등) — 같은 1회용 키 사용
const BROJ_KINDS = ['sales', 'members', 'passes', 'lockers', 'memos', 'holds'];
async function brojImport({ key, kind, rows }) {
  const st = await supabase.from('crm_settings').select('value').eq('key', 'att_import').maybeSingle();
  if (st.error) throw st.error;
  const v = st.data && st.data.value;
  if (!v || !key || v.key !== key || Date.now() > Date.parse(v.expires)) return [401, { error: '가져오기 키가 맞지 않거나 끝났어요' }];
  if (!BROJ_KINDS.includes(kind)) return [400, { error: '종류가 맞지 않아요' }];
  if (!Array.isArray(rows) || rows.length > 3000) return [400, { error: '한 번에 3000줄까지예요' }];
  const out = rows.filter((r) => r && Number(r.k)).map((r) => ({ kind, broj_key: Number(r.k), data: r, fetched_at: new Date().toISOString() }));
  for (let i = 0; i < out.length; i += 500) {
    const { error } = await supabase.from('crm_broj_raw').upsert(out.slice(i, i + 500), { onConflict: 'kind,broj_key' });
    if (error) throw error;
  }
  return [200, { saved: out.length }];
}

// ---------- 자동 문자 규칙 (발송 업체 연결 전: 켜고 끄기와 대상 수만) ----------
const MSG_RULES = [
  { key: 'inq_price', stage: '유입', type: '자동 발송', title: '문의 즉시 가격 안내', body: '{이름}님, 990짐에 문의 주셔서 감사해요. 가격표와 시설 사진 → {링크}' },
  { key: 'inq_return', stage: '유입', type: '직원 할 일', title: '1차 리턴 (상담 3일 뒤)', body: '전화 → 안 받으면 문자' },
  { key: 'welcome', stage: '신규', type: '자동 발송', title: '신규 등록 환영 (등록 당일)', body: '{이름}님 990짐 회원이 되신 걸 환영해요. 첫 4주는 저희가 같이 챙겨드릴게요.' },
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
  const cnt = { inq_price: D.totals.inquiries30, inq_return: t.filter((x) => x.kind === '유입').length, welcome: D.stages['신규'], absent14: t.filter((x) => x.key.startsWith('abs14')).length,
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
// 서버 환경 변수 NOTION_TOKEN 이 있어야 하고, 두 페이지가 990crm 연결(읽기 전용)에 공유돼 있어야 한다.
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
  const pages = await notionQueryAll(NOTION_WALKIN_DB, { sorts: [{ timestamp: 'created_time', direction: 'descending' }] });
  // CRM에서 이미 결과(등록/미등록)를 남긴 건 노션이 비어 있으면 그대로 둔다
  const ex = {};
  (await selectAll(() => supabase.from('crm_inquiries').select('legacy_id,result,member_id').like('legacy_id', 'notion:%'))).forEach((r) => { ex[r.legacy_id] = r; });
  let n = 0; const out = [];
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
      return_on: result === '등록' || result === '미등록' || daysBetween(day.slice(0, 10), today) > 35 ? null : returnOn(day.slice(0, 10), today),
      result: result === '상담 중' ? null : result, member_id: phone && phoneToMember[phone] ? phoneToMember[phone] : null,
      inquired_at: new Date(Date.parse(`${day.slice(0, 10)}T12:00:00+09:00`)).toISOString() };
    const old = ex[row.legacy_id];
    if (old && old.result && !row.result) { row.result = old.result; row.return_on = null; }
    if (old && old.member_id && !row.member_id) row.member_id = old.member_id;
    out.push(row);
    n++;
  }
  for (let i = 0; i < out.length; i += 200) { const { error } = await supabase.from('crm_inquiries').upsert(out.slice(i, i + 200), { onConflict: 'legacy_id' }); if (error) throw error; }
  return n;
}
async function findPtDatabases() {
  const found = [];
  const walk = async (id, trainer, depth) => {
    if (depth > 7) return;
    for (const b of await notionChildren(id)) {
      if (b.type === 'child_page' && !trainer) await walk(b.id, b.child_page.title.replace(/트레이너|선생님|쌤/g, '').replace(/[^\p{L}\p{N}]/gu, '').trim() || trainer, depth + 1);
      else if (b.type === 'child_database' && /회원 ?목록/.test((b.child_database.title || '').trim()) && !/만료/.test(b.child_database.title || '') && trainer) found.push({ id: b.id, trainer });
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
  let n = 0; const logs = []; const out = [];
  const lists = await Promise.all(dbs.map((db) => notionQueryAll(db.id)));
  for (const [di, db] of dbs.entries()) {
    for (const pg of lists[di]) {
      const P = pg.properties || {};
      const name = nv.text(P['이름']).replace(/\(.*?\)/g, '').trim(); if (!name) continue;
      const total = nv.num(P['전체세션']), used = nv.num(P['진행세션']);
      const cands = byName[name.replace(/\s/g, '')] || [];
      const withPt = cands.filter((id) => ptMemberIds.has(id));
      const pick = withPt.length === 1 ? withPt[0] : cands.length === 1 ? cands[0] : null;
      const row = { notion_id: pg.id, trainer: db.trainer, name: name.slice(0, 30), status: nv.sel(P['상태']) || null, total: total == null ? null : Math.round(total), used: used == null ? null : Math.round(used),
        remaining: total != null && used != null ? Math.round(total - used) : null, member_id: pick, matched: pick ? '자동' : cands.length > 1 ? '확인 필요' : '없음',
        purpose: nv.multi(P['운동목적']).join(', ') || null, note: nv.text(P['비고']).slice(0, 300) || null, notion_edited_at: pg.last_edited_time, synced_at: new Date().toISOString() };
      out.push(row);
      const before = prev[pg.id];
      if (row.used != null && before != null && row.used !== before) logs.push({ notion_id: pg.id, trainer: db.trainer, member_id: pick, delta: row.used - before, used_after: row.used, day: kstDate(pg.last_edited_time) });
      n++;
    }
  }
  for (let i = 0; i < out.length; i += 200) { const { error } = await supabase.from('crm_pt_notion').upsert(out.slice(i, i + 200), { onConflict: 'notion_id' }); if (error) throw error; }
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
  if (!force && last && Date.now() - Date.parse(last) < 30 * 60 * 1000) return [200, { connected: true, skipped: true, at: last, ...(st.data.value || {}) }];
  const today = todayKST();
  const [members, ptPasses] = await Promise.all([
    selectAll(() => supabase.from('crm_members').select('id,name,phone')),
    selectAll(() => supabase.from('crm_passes').select('member_id,product_name,category').in('status', ['사용 중', '예정', '홀딩'])),
  ]);
  const phoneToMember = {}; members.forEach((m) => { if (m.phone) phoneToMember[m.phone] = m.id; });
  const ptIds = new Set(ptPasses.filter((p) => salesGroup(p.product_name, p.category) === 'PT').map((p) => p.member_id));
  const out = { at: new Date().toISOString() };
  await Promise.all([
    syncWalkins(today, phoneToMember).then((v) => { out.walkins = v; }, (e) => { out.walkinError = e.code === 'object_not_found' || e.status === 404 ? '워크인 로그가 990crm 연결에 공유되지 않았어요' : e.message; }),
    syncPT(today, members, ptIds).then((v) => { out.pt = v; }, (e) => { out.ptError = e.code === 'object_not_found' || e.status === 404 ? 'PT회원관리가 990crm 연결에 공유되지 않았어요' : e.message; }),
  ]);
  const { error } = await supabase.from('crm_settings').upsert({ key: 'notion_sync', value: out, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  clearCache();
  return [200, { connected: true, ...out }];
}

// ---------- 이용권 수정 · 결제 방법 ----------
const PAY_METHODS = ['카드', '현금', '계좌이체'];
const PASS_STATUS = ['사용 중', '예정', '홀딩', '만료', '무효'];
const iso2 = (t) => new Date(t).toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
async function passUpdate({ id, product_name, status, starts_on, ends_on, total_count, remaining_count, price_paid, method, staff }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const cur = await supabase.from('crm_passes').select('*').eq('id', id).maybeSingle();
  if (cur.error) throw cur.error;
  if (!cur.data) return [404, { error: '이용권을 찾을 수 없어요' }];
  const p = { ...cur.data }, patch = {};
  const intOrNull = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v))));
  if (product_name != null && String(product_name).trim()) patch.product_name = String(product_name).trim().slice(0, 60);
  if (status != null) { if (!PASS_STATUS.includes(status)) return [400, { error: '상태를 다시 골라주세요' }]; patch.status = status; }
  if (starts_on !== undefined) { if (starts_on && !isDate(starts_on)) return [400, { error: '시작일을 다시 확인해주세요' }]; patch.starts_on = starts_on || null; }
  if (ends_on !== undefined) { if (ends_on && !isDate(ends_on)) return [400, { error: '만료일을 다시 확인해주세요' }]; patch.ends_on = ends_on || null; }
  const s0 = patch.starts_on !== undefined ? patch.starts_on : p.starts_on, e0 = patch.ends_on !== undefined ? patch.ends_on : p.ends_on;
  if (s0 && e0 && e0 < s0) return [400, { error: '만료일이 시작일보다 빨라요' }];
  if (total_count !== undefined) patch.total_count = intOrNull(total_count);
  if (remaining_count !== undefined) patch.remaining_count = intOrNull(remaining_count);
  const t0 = patch.total_count !== undefined ? patch.total_count : p.total_count, r0 = patch.remaining_count !== undefined ? patch.remaining_count : p.remaining_count;
  if (t0 != null && r0 != null && r0 > t0) return [400, { error: '남은 횟수가 전체 횟수보다 많아요' }];
  if (price_paid !== undefined) patch.price_paid = intOrNull(price_paid) || 0;
  const LABEL = { product_name: '상품명', status: '상태', starts_on: '시작일', ends_on: '만료일', total_count: '전체 횟수', remaining_count: '남은 횟수', price_paid: '결제 금액' };
  const changes = Object.keys(patch).filter((k) => String(patch[k] ?? '') !== String(p[k] ?? ''));
  if (changes.length) {
    const upd = {}; changes.forEach((k) => { upd[k] = patch[k]; });
    const { error } = await supabase.from('crm_passes').update(upd).eq('id', id);
    if (error) throw error;
  }
  let methodNote = '';
  if (method !== undefined && method !== null) {
    if (method && !PAY_METHODS.includes(method)) return [400, { error: '결제 방법을 다시 골라주세요' }];
    const { error } = await supabase.from('crm_payments').update({ method: method || null, method_split: null, method_note: null }).eq('pass_id', id);
    if (error) throw error;
    methodNote = method ? `결제 방법 ${method}` : '';
  }
  // 회원의 만료일·단계도 맞춘다 (PT 제외, 쓰는 중인 이용권 중 가장 늦은 만료일)
  if (changes.some((k) => ['status', 'ends_on', 'product_name'].includes(k))) await syncMemberEnd(p.member_id);
  const body = changes.map((k) => `${LABEL[k]} ${p[k] ?? '-'} → ${patch[k] ?? '-'}`).concat(methodNote ? [methodNote] : []).join(', ');
  if (body) await supabase.from('crm_events').insert({ member_id: p.member_id, kind: '이용권 수정', body: `${p.product_name} · ${body}`.slice(0, 500), staff_name: staff ? String(staff).slice(0, 20) : null });
  return member({ id: p.member_id });
}
// 회원 만료일·첫 시작일·단계를 이용권에 맞춘다 (PT·부가 상품은 회원 기간에 안 넣는다)
const isAddon = (p) => p.category === '부가' || /락커|운동복|수건/.test(p.product_name || '');
async function syncMemberEnd(memberId, { allowEarlier = false, removedStart = null } = {}) {
  const [{ data: ps, error: e1 }, { data: m, error: e2 }] = await Promise.all([
    supabase.from('crm_passes').select('product_name,category,status,starts_on,ends_on').eq('member_id', memberId),
    supabase.from('crm_members').select('ends_on,stage,first_started_on').eq('id', memberId).maybeSingle(),
  ]);
  if (e1 || e2) throw e1 || e2;
  if (!m) return;
  const main = ps.filter((x) => salesGroup(x.product_name, x.category) !== 'PT' && !isAddon(x));
  const ends = main.filter((x) => ['사용 중', '예정', '홀딩'].includes(x.status) && x.ends_on).map((x) => x.ends_on).sort();
  const newEnd = ends.length ? ends[ends.length - 1] : null;
  const starts = ps.filter((x) => !isAddon(x) && !['무효', '환불'].includes(x.status) && x.starts_on).map((x) => x.starts_on).sort();
  const today = todayKST();
  const mp = {};
  if (newEnd && newEnd !== m.ends_on) mp.ends_on = newEnd;
  if (!newEnd && allowEarlier && m.ends_on) { const old = main.filter((x) => !['무효', '환불'].includes(x.status) && x.ends_on).map((x) => x.ends_on).sort(); mp.ends_on = old.length ? old[old.length - 1] : null; }
  if (newEnd && allowEarlier && newEnd < (m.ends_on || '')) mp.ends_on = newEnd;
  // 첫 시작일: 비어 있을 때만 채운다. 되돌릴 때는 지운 이용권이 첫 시작이었을 때만 다시 계산한다
  if (!m.first_started_on && starts.length) mp.first_started_on = starts[0];
  if (removedStart && m.first_started_on === removedStart) mp.first_started_on = starts.length ? starts[0] : null;
  if (m.stage === '만료·이탈' && newEnd && newEnd >= today) mp.stage = '정착';
  if (Object.keys(mp).length) { const { error } = await supabase.from('crm_members').update(mp).eq('id', memberId); if (error) throw error; }
}

// ---------- 월구독 자동결제 → CRM 기록 ----------
// 토스 결제 코드는 건드리지 않는다. 구독 DB(subscribers)의 다음 결제일이 넘어가면 그 달 결제가 된 것으로 보고
// CRM 매출·이용권에 기록한다. 금액은 결제 서버와 같은 가격표(_pricing.js)로 계산한다.
// enabled 가 꺼져 있으면(브로제이 전환 전) 기록은 안 하고 '어디까지 봤는지'만 따라간다 → 두 번 잡히지 않는다.
const SUB_SYNC_EVERY = 10 * 60 * 1000;
const addOneMonth = (d) => addDaysYMD(ymdAddMonths(d, 1), 1);
const addDaysYMD = (d, n) => { const x = new Date(Date.parse(d)); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function memberForSub(s, members) {
  const p = digitsOf(s.phone), n = String(s.name || '').trim();
  return members.find((m) => m.subscriber_id === s.id)
    || members.find((m) => p && digitsOf(m.phone) === p && String(m.name || '').trim() === n)
    || (() => { const c = members.filter((m) => p && digitsOf(m.phone) === p); return c.length === 1 ? c[0] : null; })();
}
async function subSync({ force = false } = {}) {
  const st = await supabase.from('crm_settings').select('value').eq('key', 'sub_sync').maybeSingle();
  if (st.error) throw st.error;
  const cfg = (st.data && st.data.value) || {};
  if (!force && cfg.at && Date.now() - Date.parse(cfg.at) < SUB_SYNC_EVERY) return { skipped: true };
  const { data: subs, error } = await supabase.from('subscribers').select('id,name,phone,plan,addons,status,promo,next_billing_date,created_at');
  if (error) throw error;
  const seen = { ...(cfg.seen || {}) }, seenSt = { ...(cfg.seenSt || {}) }, todo = [], today = todayKST();
  for (const s of subs) {
    const prev = seen[s.id], nb = s.next_billing_date;
    if (cfg.enabled) {
      if (prev === undefined) {
        if (cfg.from && kstDate(s.created_at) >= cfg.from) { const pr = getPromo(s.plan, s.promo); todo.push({ s, first: true, day: kstDate(s.created_at), at: s.created_at, amount: pr ? pr.firstAmount : monthlyAmount(s.plan, s.addons) }); }
      } else if (prev && nb && nb > prev && s.status !== 'paused') {
        // '복구'를 누르면 그날 한 번 결제되고 다음 결제일이 그날+1달이 된다 → 밀린 달까지 세지 말고 한 건만 기록.
        // 해지했던 분이 복구하거나 한 달 넘게 결제가 비었다가 복구 = '복귀'. 며칠 안 된 결제 실패(서버 문제 등) 후 복구는 평소 결제와 같게(재등록) 본다.
        const prevSt = (cfg.seenSt || {})[s.id];
        const restored = s.status === 'active' && ((prevSt && !['active', 'paused'].includes(prevSt)) || nb > addOneMonth(prev));
        if (restored) {
          const d = addDaysYMD(ymdAddMonths(nb, -1), 1);
          todo.push({ s, first: false, restored: true, comeback: prevSt === 'cancelled' || nb > addOneMonth(addOneMonth(prev)), day: d, at: new Date(Date.parse(`${d}T09:00:00+09:00`)).toISOString(), amount: monthlyAmount(s.plan, s.addons) });
        } else {
          for (let d = prev, i = 0; d < nb && i < 12; d = addOneMonth(d), i++) todo.push({ s, first: false, day: d, at: new Date(Date.parse(`${d}T09:00:00+09:00`)).toISOString(), amount: monthlyAmount(s.plan, s.addons) });
        }
      }
    }
    if (nb) seen[s.id] = nb;
    seenSt[s.id] = s.status;
  }
  let recorded = 0;
  const logs = [];
  if (todo.length) {
    const members = await selectAll(() => supabase.from('crm_members').select('id,name,phone,subscriber_id,lifetime_paid,legacy_id'));
    for (const t of todo) {
      if (!t.amount) continue;
      try { if (await recordSubPayment(t, members)) recorded++; } catch (e) { logs.push(`${t.s.id.slice(0, 8)} ${t.day}: ${e.message}`); }
    }
  }
  await subLockerSync(subs, today);
  const { error: e2 } = await supabase.from('crm_settings').upsert({ key: 'sub_sync', value: { ...cfg, at: new Date().toISOString(), seen, seenSt, last: { recorded, errors: logs.slice(0, 5) } }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (e2) throw e2;
  if (recorded) clearCache();
  return { recorded, errors: logs };
}
async function recordSubPayment(t, members) {
  const s = t.s, note = `토스 자동결제 · ${s.id.slice(0, 8)} · ${t.day}`;
  const ex = await supabase.from('crm_payments').select('id').eq('method_note', note).limit(1);
  if (ex.error) throw ex.error;
  if (ex.data.length) return false; // 이미 기록함
  let m = memberForSub(s, members);
  if (m && !m.subscriber_id) { await supabase.from('crm_members').update({ subscriber_id: s.id }).eq('id', m.id); m.subscriber_id = s.id; }
  if (!m) { // 홈페이지에서 처음 가입한 분 → CRM 회원으로 만든다
    const phone = normPhone(s.phone);
    const ins = await supabase.from('crm_members').insert({ name: String(s.name || '이름 없음').slice(0, 30), phone, stage: '체험·신규', checkin_code: digitsOf(phone).slice(-4), source: '990홈페이지', subscriber_id: s.id }).select('id,name,phone,subscriber_id,lifetime_paid,legacy_id').single();
    if (ins.error) throw ins.error;
    m = ins.data; members.push(m);
  }
  const kind = t.comeback ? '복귀' : await regKind(m.id, `${s.plan} 구독권`, '월구독', t.amount, t.day);
  const end = addDaysYMD(addOneMonth(t.day), -1), today = todayKST();
  const pass = await supabase.from('crm_passes').insert({ member_id: m.id, product_name: `${s.plan} 구독권`, category: '월구독', status: end < today ? '만료' : t.day > today ? '예정' : '사용 중', starts_on: t.day, ends_on: end, price_paid: t.amount, registered_on: t.day }).select('id').single();
  if (pass.error) throw pass.error;
  const addonTxt = (s.addons || []).map((a) => (a === 'locker' ? '락커' : a === 'wear' ? '운동복' : a)).join('·');
  const full = monthlyAmount(s.plan, s.addons) || t.amount;
  const promoTxt = t.first && full > t.amount ? `첫 달 ${Math.round((1 - t.amount / full) * 100)}% 할인 체험` : '';
  const label = `${s.plan} 구독권${addonTxt ? ` + ${addonTxt}` : ''}${promoTxt ? ` (${promoTxt})` : ''}`;
  const pay = await supabase.from('crm_payments').insert({ member_id: m.id, pass_id: pass.data.id, list_price: full, amount: t.amount, method: '카드', method_note: note, kind, paid_at: t.at,
    item: addonTxt || promoTxt ? label : null, discount_reason: promoTxt || null });
  if (pay.error) { await supabase.from('crm_passes').delete().eq('id', pass.data.id); throw pay.error; }
  const life = (Number(m.lifetime_paid) || 0) + t.amount;
  await supabase.from('crm_members').update({ lifetime_paid: life, updated_at: new Date().toISOString() }).eq('id', m.id);
  m.lifetime_paid = life;
  await syncMemberEnd(m.id);
  await supabase.from('crm_events').insert({ member_id: m.id, kind: '월구독 결제', body: `${t.first ? '첫 결제' : t.restored ? '복구 결제' : '자동결제'} · ${s.plan}${(s.addons || []).length ? ` + ${(s.addons || []).map((a) => (a === 'locker' ? '락커' : a === 'wear' ? '운동복' : a)).join('·')}` : ''} · ${t.amount.toLocaleString()}원 · ${t.day} ~ ${end}` });
  return true;
}
// 구독 락커(애드온): 결제된 날까지 쓰게 끝나는 날을 맞추고, 구독이 끝나면 락커도 끝낸다
async function subLockerSync(subs, today) {
  const { data: las, error } = await supabase.from('crm_locker_assignments').select('id,member_id,status,ends_on').eq('billing', '구독 애드온').in('status', ['사용 중', '예정', '홀딩']);
  if (error) throw error;
  if (!las.length) return;
  const { data: ms, error: e2 } = await supabase.from('crm_members').select('id,name,phone,subscriber_id').in('id', [...new Set(las.map((a) => a.member_id))]);
  if (e2) throw e2;
  for (const a of las) {
    const m = ms.find((x) => x.id === a.member_id); if (!m) continue;
    const s = subs.find((x) => x.id === m.subscriber_id) || subs.find((x) => memberForSub(x, [m]));
    if (!s || !s.next_billing_date) continue;
    const paidTo = addDaysYMD(s.next_billing_date, -1);
    const keep = ['active', 'paused'].includes(s.status) && (s.addons || []).includes('locker');
    const patch = {};
    if (keep && a.ends_on !== paidTo) patch.ends_on = paidTo;
    if (!keep && (!a.ends_on || a.ends_on > paidTo)) patch.ends_on = paidTo;
    const endNow = patch.ends_on || a.ends_on;
    if (!keep && endNow && endNow < today) patch.status = '만료';
    if (Object.keys(patch).length) { const { error: e3 } = await supabase.from('crm_locker_assignments').update(patch).eq('id', a.id); if (e3) throw e3; }
  }
}
// 구독 락커 번호 배정 (할 일 '락커 번호 배정' → 회원 상세에서)
async function subLocker({ member_id, locker_no, staff }) {
  const no = Math.round(Number(locker_no));
  if (!member_id || !no) return [400, { error: '락커 번호를 적어주세요' }];
  const [lk, busy, m, S] = await Promise.all([
    supabase.from('crm_lockers').select('number,broken').eq('number', no).maybeSingle(),
    supabase.from('crm_locker_assignments').select('member_id,ends_on').eq('locker_no', no).in('status', ['사용 중', '예정', '홀딩']),
    supabase.from('crm_members').select('*').eq('id', member_id).maybeSingle(),
    subsMap(),
  ]);
  if (lk.error || busy.error || m.error) throw lk.error || busy.error || m.error;
  if (!lk.data) return [400, { error: `${no}번 락커가 없어요` }];
  if (lk.data.broken) return [400, { error: `${no}번 락커는 고장으로 표시돼 있어요` }];
  const today = todayKST();
  const other = busy.data.find((x) => x.member_id !== member_id && (!x.ends_on || x.ends_on >= today));
  if (other) return [409, { error: `${no}번은 다른 회원이 쓰고 있어요` }];
  const sb = m.data ? subOf(m.data, S) : null;
  if (!sb || !(sb.addons || []).includes('locker')) return [400, { error: '이 회원 구독에 락커 애드온이 없어요' }];
  const { error } = await supabase.from('crm_locker_assignments').insert({ locker_no: no, member_id, status: '사용 중', starts_on: today, ends_on: sb.next_billing_date ? addDaysYMD(sb.next_billing_date, -1) : null, price_paid: 10000, billing: '구독 애드온' });
  if (error) throw error;
  await supabase.from('crm_events').insert({ member_id, kind: '락커', body: `구독 락커 ${no}번 배정`, staff_name: staff ? String(staff).slice(0, 20) : null });
  clearCache();
  return member({ id: member_id });
}

// ---------- 예약 작업 (서울 서버 예약 기능이 정해진 시간에 부른다) ----------
// tick(5분마다): 서버 깨워두기 + 월구독 자동결제 기록 / nightly(매일 0시 5분): 이용권·락커·회원 단계 정리
// report(매일 밤 10시): 하루 요약 알림 / weekly(월요일 아침 9시): 지난주 요약 알림
async function cronOk(key) {
  const { data, error } = await supabase.from('admin_settings').select('value').eq('key', 'cron_secret').maybeSingle();
  if (error || !data || !data.value || !key) return false;
  const want = String(data.value.k || data.value), got = String(key);
  return want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
async function cronRun({ job, key }) {
  if (!(await cronOk(key))) return [401, { error: 'unauthorized' }];
  const t0 = Date.now(); let out;
  if (job === 'tick') out = await subSync();
  else if (job === 'nightly') out = await statusSync();
  else if (job === 'report') out = await dailyReport();
  else if (job === 'weekly') out = await weeklyReport();
  else return [400, { error: '알 수 없는 작업' }];
  await supabase.from('crm_settings').upsert({ key: `cron_${job}`, value: { at: new Date().toISOString(), ms: Date.now() - t0, out }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return [200, { ok: true, job, ...(out || {}) }];
}
const STORED_STAGE = { '체험': '체험·신규', '신규': '체험·신규', '정착': '정착', '미출석': '미출석', '만료 예정': '만료 예정', '만료·이탈': '만료·이탈' };
async function statusSync() {
  const today = todayKST(), out = {};
  const upd = async (label, q) => { const { data, error } = await q.select('id'); if (error) throw error; out[label] = data.length; };
  // 이용권: 시작일이 되면 사용 중, 끝나는 날이 지나면 만료 (홀딩 중인 것은 그대로)
  await upd('passStart', supabase.from('crm_passes').update({ status: '사용 중' }).eq('status', '예정').lte('starts_on', today));
  await upd('passEnd', supabase.from('crm_passes').update({ status: '만료' }).eq('status', '사용 중').lt('ends_on', today));
  // 기간 락커 (구독 락커는 subSync 가 맞춘다)
  await upd('lockStart', supabase.from('crm_locker_assignments').update({ status: '사용 중' }).eq('status', '예정').eq('billing', '기간 결제').lte('starts_on', today));
  await upd('lockEnd', supabase.from('crm_locker_assignments').update({ status: '만료' }).eq('status', '사용 중').eq('billing', '기간 결제').lt('ends_on', today));
  // 회원 단계 저장값을 오늘 기준으로 (목록·대시보드가 빨라지고 정확해진다)
  const [ms, S, trialSet] = await Promise.all([selectAll(() => supabase.from('crm_members').select(MEMBER_COLS)), subsMap(), trialOnlySet()]);
  const live = markTrial(ms.map((m) => decorate(m, today, S)), trialSet);
  const groups = {};
  live.forEach((m, i) => { const want = STORED_STAGE[m.stage] || '정착'; if (ms[i].stage !== want) (groups[want] = groups[want] || []).push(m.id); });
  let changed = 0;
  for (const [st, ids] of Object.entries(groups)) for (let i = 0; i < ids.length; i += 200) { const { error } = await supabase.from('crm_members').update({ stage: st }).in('id', ids.slice(i, i + 200)); if (error) throw error; changed += Math.min(200, ids.length - i); }
  out.memberStage = changed;
  clearCache();
  return out;
}
// 요약 알림은 '설정 → 매일 요약 받기'를 켠 폰에만 보낸다 (매출이 있어서 직원 폰 전체에는 안 보낸다)
async function reportTargets() {
  const st = await supabase.from('crm_settings').select('value').eq('key', 'report_push').maybeSingle();
  const eps = (st.data && st.data.value && st.data.value.endpoints) || [];
  if (!eps.length) return [];
  const [{ data, error }, pp] = await Promise.all([supabase.from('crm_push_subs').select('endpoint,p256dh,auth,staff_name').in('endpoint', eps), pushPeople()]);
  if (error) throw error;
  return data.filter((x) => !x.staff_name || pp.leads.has(x.staff_name)); // 매출 요약은 대표·매니저 폰만
}
async function pushReport(msg) {
  const to = await reportTargets();
  let n = 0; for (const t of to) n += await pushSend(msg, t);
  return { sent: n, targets: to.length };
}
const wonShort = (v) => (v >= 10000 ? `${Math.round(v / 1000) / 10}만원` : `${(v || 0).toLocaleString()}원`);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
async function dailyReport() {
  const today = todayKST();
  const startISO = new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString();
  const [[, D], pays] = await Promise.all([dashboard(), paymentsRaw(startISO)]);
  const sum = pays.reduce((a, p) => a + (p.amount || 0), 0), nNew = pays.filter((p) => p.kind === '신규').length, nRe = pays.filter((p) => p.kind === '재등록').length;
  const open = D.tasks.filter((t) => !t.done).length, doneT = D.doneToday;
  const pct = D.sales.target ? Math.round(D.sales.total / D.sales.target * 100) : null;
  const lines = [
    `매출 ${sum.toLocaleString()}원 · 신규 ${nNew} · 재등록 ${nRe}`,
    `출석 ${D.attendance.today}명 · 할 일 ${doneT}건 처리, ${open}건 남음`,
    `이번 달 ${wonShort(D.sales.total)}${pct != null ? ` (목표의 ${pct}%)` : ''} · 만료 예정 ${D.stages['만료 예정'] || 0}명${D.totals.subFail ? ` · 결제 실패 ${D.totals.subFail}명` : ''}`,
  ];
  return pushReport({ title: `오늘 마감 · ${+today.slice(5, 7)}/${+today.slice(8)}(${DOW[new Date(`${today}T00:00:00Z`).getUTCDay()]})`, body: lines.join('\n'), tag: `report-${today}` });
}
async function weeklyReport() {
  const today = todayKST();
  const to = new Date(Date.parse(`${today}T00:00:00+09:00`)), from = new Date(to.getTime() - 7 * DAY);
  const [pays, inq, [, D]] = await Promise.all([
    paymentsRaw(from.toISOString(), to.toISOString()),
    supabase.from('crm_inquiries').select('id,result,member_id').gte('inquired_at', from.toISOString()).lt('inquired_at', to.toISOString()),
    dashboard(),
  ]);
  if (inq.error) throw inq.error;
  const sum = pays.reduce((a, p) => a + (p.amount || 0), 0), nNew = pays.filter((p) => p.kind === '신규').length, nRe = pays.filter((p) => p.kind === '재등록').length;
  const qn = inq.data.length, qj = inq.data.filter((q) => q.result === '등록' || q.member_id).length;
  const soon = D.tasks.filter((t) => t.kind === '재등록' && !t.done).length;
  const lines = [
    `매출 ${sum.toLocaleString()}원 · 신규 ${nNew}명 · 재등록 ${nRe}명`,
    `문의 ${qn}건 → 등록 ${qj}명${qn ? ` (${Math.round(qj / qn * 100)}%)` : ''}`,
    `이번 주 챙길 분: 만료 예정 ${soon}명 · 미출석 ${D.stages['미출석'] || 0}명`,
  ];
  return pushReport({ title: `지난주 요약 · ${+from.toISOString().slice(5, 7)}/${+addDaysYMD(today, -7).slice(8)}~${+addDaysYMD(today, -1).slice(5, 7)}/${+addDaysYMD(today, -1).slice(8)}`, body: lines.join('\n'), tag: `weekly-${today}` });
}
// 설정: 이 폰으로 매일 요약 받기
async function reportPush({ endpoint, on }) {
  const ep = String(endpoint || ''); if (!/^https:\/\//.test(ep)) return [400, { error: '알림을 먼저 켜 주세요 (위쪽 🔔)' }];
  const st = await supabase.from('crm_settings').select('value').eq('key', 'report_push').maybeSingle();
  if (st.error) throw st.error;
  const eps = new Set((st.data && st.data.value && st.data.value.endpoints) || []);
  if (on === true) {
    const [me, pp] = await Promise.all([supabase.from('crm_push_subs').select('staff_name').eq('endpoint', ep).maybeSingle(), pushPeople()]);
    const who = me.data && me.data.staff_name;
    if (who && !pp.leads.has(who)) return [403, { error: '매일 요약은 대표·매니저 폰만 받을 수 있어요' }];
  }
  if (on === true) eps.add(ep); else if (on === false) eps.delete(ep);
  if (on === true || on === false) { const { error } = await supabase.from('crm_settings').upsert({ key: 'report_push', value: { endpoints: [...eps] }, updated_at: new Date().toISOString() }, { onConflict: 'key' }); if (error) throw error; }
  if (on === 'test') { const sub = await supabase.from('crm_push_subs').select('endpoint,p256dh,auth').eq('endpoint', ep).maybeSingle(); if (sub.data) { const r = await dailyReportMsg(); await pushSend(r, sub.data); } }
  return [200, { on: eps.has(ep), count: eps.size }];
}
async function dailyReportMsg() { const to = await reportTargets(); return { title: '매일 요약 받기가 켜졌어요', body: '매일 밤 10시에 오늘 매출·출석·할 일을 보내드려요', tag: `report-test-${Date.now()}`, _n: to.length }; }

// ---------- 등록·결제 입력 ----------
async function products() {
  const { data, error } = await supabase.from('crm_products').select('id,category,name,list_price,months,sessions,on_sale,sort_order,note').eq('on_sale', true).order('sort_order');
  if (error) throw error;
  return [200, { products: data }];
}
const ymdAddMonths = (iso, n) => { const d = new Date(Date.parse(iso)); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const normPhone = (p) => { const d = digitsOf(p); return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : null; };
async function register({ inquiry_id, member_id, new_member, product_id, custom, starts_on, ends_on, sessions, trainer, locker_no, amount, discount_reason, method, split, method_note, kind, staff }) {
  const st = staff ? String(staff).slice(0, 20) : null;
  // 1) 상품
  let prod = null;
  if (product_id) {
    const { data, error } = await supabase.from('crm_products').select('*').eq('id', product_id).maybeSingle();
    if (error) throw error;
    if (!data) return [400, { error: '상품을 다시 골라주세요' }];
    prod = data;
  } else if (custom && String(custom.name || '').trim()) {
    const cat = ['헬스 기간권', 'GX 무제한', 'PT', '체험', '부가'].includes(custom.category) ? custom.category : '헬스 기간권';
    prod = { id: null, category: cat, name: String(custom.name).trim().slice(0, 60), list_price: null, months: custom.months ? Math.max(1, Math.min(36, Math.round(+custom.months))) : null, sessions: custom.sessions ? Math.max(1, Math.min(200, Math.round(+custom.sessions))) : null };
  } else return [400, { error: '상품을 골라주세요' }];
  if (prod.category === '월구독') return [400, { error: '월구독은 홈페이지에서 가입해요 (자동결제)' }];
  // 2) 날짜·횟수
  const today = todayKST();
  const s = starts_on || today;
  if (!isDate(s)) return [400, { error: '시작일을 다시 확인해주세요' }];
  const isPT = salesGroup(prod.name, prod.category) === 'PT';
  // 체험(체험 PT 3회 등)은 시작일부터 14일이 만료
  let e = ends_on || (prod.months ? ymdAddMonths(s, prod.months) : (prod.category === '체험' || isTrialPT(prod.name, Number(String(amount ?? '').replace(/[^\d]/g, ''))) ? addDaysYMD(s, 13) : null));
  if (e && !isDate(e)) return [400, { error: '만료일을 다시 확인해주세요' }];
  if (e && e < s) return [400, { error: '만료일이 시작일보다 빨라요' }];
  const cnt = sessions != null && sessions !== '' ? Math.max(1, Math.min(200, Math.round(+sessions))) : prod.sessions;
  if (isPT && !cnt) return [400, { error: 'PT 횟수를 적어주세요' }];
  const isLocker = /락커/.test(prod.name);
  const lockNo = locker_no != null && locker_no !== '' ? Math.round(+locker_no) : null;
  if (isLocker && lockNo != null) {
    const { data, error } = await supabase.from('crm_lockers').select('number,broken').eq('number', lockNo).maybeSingle();
    if (error) throw error;
    if (!data) return [400, { error: `${lockNo}번 락커가 없어요` }];
  }
  // 3) 금액·결제 방법
  const amt = Math.round(Number(String(amount ?? '').replace(/[^\d]/g, '')));
  if (!Number.isFinite(amt) || amt < 0 || amt > 50000000) return [400, { error: '금액을 다시 확인해주세요' }];
  let m0 = null, sp = null;
  if (method === '나눠서') {
    const parts = PAY_METHODS.map((k) => [k, Math.round(Number(String((split || {})[k] ?? '').replace(/[^\d]/g, '')) || 0)]).filter(([, v]) => v > 0);
    if (parts.length < 2) return [400, { error: '나눠서 낸 금액을 두 가지 이상 적어주세요' }];
    const sum = parts.reduce((a, [, v]) => a + v, 0);
    if (sum !== amt) return [400, { error: `나눠 낸 합계(${sum.toLocaleString()}원)가 결제 금액(${amt.toLocaleString()}원)과 달라요` }];
    m0 = parts.map(([k]) => k).join('+'); sp = Object.fromEntries(parts);
  } else if (amt > 0) {
    if (!PAY_METHODS.includes(method)) return [400, { error: '결제 방법을 골라주세요' }];
    m0 = method;
  }
  // 4) 회원 (새 회원이면 만든다)
  let mid = member_id, created = false;
  if (!mid) {
    const name = String((new_member || {}).name || '').trim().slice(0, 30);
    const phone = normPhone((new_member || {}).phone);
    if (!name) return [400, { error: '이름을 적어주세요' }];
    if (!phone) return [400, { error: '전화번호를 다시 확인해주세요 (010으로 시작하는 11자리)' }];
    const dup = await supabase.from('crm_members').select('id,name').eq('phone', phone).limit(3);
    if (dup.error) throw dup.error;
    for (const d of dup.data) { const again = await recentSame(d.id, prod.name, s, amt); if (again) return again; } // 방금 저장된 걸 다시 보낸 경우
    if (dup.data.length) return [409, { error: `이미 있는 번호예요 (${dup.data.map((x) => x.name).join(', ')}). 기존 회원을 골라주세요`, existing: dup.data }];
    const g = ['남', '여'].includes((new_member || {}).gender) ? new_member.gender : null;
    const ins = await supabase.from('crm_members').insert({ name, phone, gender: g, stage: '체험·신규', checkin_code: digitsOf(phone).slice(-4), counselor: st, source: (new_member || {}).source ? String(new_member.source).slice(0, 30) : null }).select('id').single();
    if (ins.error) throw ins.error;
    mid = ins.data.id; created = true;
  } else {
    const ex = await supabase.from('crm_members').select('id').eq('id', mid).maybeSingle();
    if (ex.error) throw ex.error;
    if (!ex.data) return [404, { error: '회원을 찾을 수 없어요' }];
    const again = await recentSame(mid, prod.name, s, amt); if (again) return again; // 두 번 눌렀거나 다시 보낸 경우
  }
  // 신규·재등록: 직원이 고르지 않으면 regKind 기준 (예전에 등록했으면 재등록, PT는 처음 PT면 신규·체험 PT 제외)
  let k = ['신규', '재등록'].includes(kind) ? kind : null;
  if (!k) k = created ? '신규' : await regKind(mid, prod.name, prod.category, amt, null);
  // 5) 이용권 → 결제 → 락커 (중간에 실패하면 만든 것을 지운다)
  const undo = [];
  try {
    const pass = await supabase.from('crm_passes').insert({
      member_id: mid, product_id: prod.id, product_name: prod.name,
      category: prod.category === 'GX 무제한' ? 'GX' : prod.category,
      status: s > today ? '예정' : '사용 중', starts_on: s, ends_on: e,
      total_count: cnt || null, remaining_count: cnt || null, trainer: isPT && trainer ? String(trainer).slice(0, 20) : null,
      price_paid: amt, registered_on: today,
    }).select('id').single();
    if (pass.error) throw pass.error;
    undo.push(() => supabase.from('crm_passes').delete().eq('id', pass.data.id));
    const note = method_note ? String(method_note).trim().slice(0, 100) : null;
    const pay = await supabase.from('crm_payments').insert({
      member_id: mid, pass_id: pass.data.id, list_price: prod.list_price, amount: amt,
      discount_reason: discount_reason ? String(discount_reason).slice(0, 100) : null,
      method: m0, method_split: sp, method_note: note, kind: k, staff_name: st,
    }).select('id').single();
    if (pay.error) throw pay.error;
    undo.push(() => supabase.from('crm_payments').delete().eq('id', pay.data.id));
    if (isLocker && lockNo != null) {
      const la = await supabase.from('crm_locker_assignments').insert({ locker_no: lockNo, member_id: mid, status: s > today ? '예정' : '사용 중', starts_on: s, ends_on: e, price_paid: amt, billing: '기간 결제' });
      if (la.error) throw la.error;
    }
    // 회원 정보 맞추기
    const cur = await supabase.from('crm_members').select('lifetime_paid,trainer').eq('id', mid).single();
    if (cur.error) throw cur.error;
    const mp = { lifetime_paid: (Number(cur.data.lifetime_paid) || 0) + amt, updated_at: new Date().toISOString() };
    if (isPT && trainer && !cur.data.trainer) mp.trainer = String(trainer).slice(0, 20);
    const up = await supabase.from('crm_members').update(mp).eq('id', mid);
    if (up.error) throw up.error;
    await syncMemberEnd(mid);
    try { const ph = await supabase.from('crm_members').select('phone').eq('id', mid).single(); await linkInquiries(mid, ph.data && ph.data.phone, inquiry_id); } catch (e) { console.error('linkInquiries', e.message); }
    const how = sp ? Object.entries(sp).map(([a, b]) => `${a} ${b.toLocaleString()}원`).join(' + ') : m0 || '';
    await supabase.from('crm_events').insert({ member_id: mid, kind: '등록', body: `${k} · ${prod.name} · ${amt.toLocaleString()}원${how ? ` (${how})` : ''}${note ? ` · ${note}` : ''}${lockNo != null && isLocker ? ` · ${lockNo}번 락커` : ''} · ${s}${e ? ` ~ ${e}` : ''}`.slice(0, 500), staff_name: st });
    clearCache();
    const [code, body] = await member({ id: mid });
    return [code, { ...body, registered: { pass_id: pass.data.id, payment_id: pay.data.id, created } }];
  } catch (err) {
    for (const f of undo.reverse()) { try { await f(); } catch (e2) {} }
    if (created) { try { await supabase.from('crm_members').delete().eq('id', mid); } catch (e2) {} }
    throw err;
  }
}
// 등록 창 '문의에서 불러오기': 아직 회원과 연결 안 된 문의. 검색어가 없으면 최근 60일, 있으면 기간 상관없이 이름·번호·메모에서 찾는다
async function regInquiries({ q = '' } = {}) {
  const key = String(q || '').trim().slice(0, 30), dg = key.replace(/\D/g, '');
  let query = supabase.from('crm_inquiries').select('id,legacy_id,name,phone,source,summary,raw_note,result,inquired_at').is('member_id', null);
  if (!key) query = query.gte('inquired_at', new Date(Date.now() - 60 * DAY).toISOString());
  else if (dg.length >= 3 && dg.length === key.replace(/[\s-]/g, '').length) query = query.ilike('phone', `%${dg.slice(-4)}%`);
  else query = query.or(`name.ilike.*${key.replace(/[,()*]/g, '')}*,raw_note.ilike.*${key.replace(/[,()*]/g, '')}*`);
  const { data, error } = await query.order('inquired_at', { ascending: false }).limit(60);
  if (error) throw error;
  return [200, { inquiries: data.filter((x) => x.result !== '등록' && (!x.legacy_id || String(x.legacy_id).startsWith('notion:'))).map((x) => ({ id: x.id, name: x.name, phone: x.phone, source: x.source, result: x.result, day: kstDate(x.inquired_at), interest: parseInqSummary(x.summary).interest || null, note: x.raw_note ? x.raw_note.slice(0, 80) : null })) }];
}
// 등록하면 그 사람의 문의를 '등록'으로 연결한다 (고른 문의 + 같은 번호의 문의)
async function linkInquiries(mid, phone, inquiryId) {
  const patch = { member_id: mid, result: '등록', return_on: null };
  if (inquiryId) { const { error } = await supabase.from('crm_inquiries').update(patch).eq('id', inquiryId).is('member_id', null); if (error) throw error; }
  if (phone) { const { error } = await supabase.from('crm_inquiries').update(patch).eq('phone', phone).is('member_id', null); if (error) throw error; }
}
// 같은 회원·상품·시작일·금액이 2분 안에 이미 저장됐으면 또 만들지 않는다
async function recentSame(mid, name, s, amt) {
  const { data, error } = await supabase.from('crm_passes').select('id').eq('member_id', mid).eq('product_name', name).eq('starts_on', s).eq('price_paid', amt).is('legacy_id', null).gte('created_at', new Date(Date.now() - 120000).toISOString()).limit(1);
  if (error) throw error;
  if (!data.length) return null;
  const [code, body] = await member({ id: mid });
  return [code, { ...body, registered: { pass_id: data[0].id, again: true } }];
}
// 990crm에서 잘못 넣은 등록 되돌리기 (브로제이에서 온 기록은 안 됨)
async function registerUndo({ pass_id, staff }) {
  if (!pass_id) return [400, { error: '필수 정보 누락' }];
  const p = await supabase.from('crm_passes').select('*').eq('id', pass_id).maybeSingle();
  if (p.error) throw p.error;
  if (!p.data) return [404, { error: '이용권을 찾을 수 없어요' }];
  if (p.data.legacy_id) return [400, { error: '브로제이에서 온 기록은 지울 수 없어요. 수정에서 상태를 바꿔주세요' }];
  const mid = p.data.member_id;
  const pays = await supabase.from('crm_payments').select('id,amount,broj_ppk').eq('pass_id', pass_id);
  if (pays.error) throw pays.error;
  if (pays.data.some((x) => x.broj_ppk)) return [400, { error: '브로제이 결제와 연결된 기록이라 지울 수 없어요' }];
  const paid = pays.data.reduce((a, x) => a + (x.amount || 0), 0);
  if (pays.data.length) { const { error } = await supabase.from('crm_payments').delete().in('id', pays.data.map((x) => x.id)); if (error) throw error; }
  if (/락커/.test(p.data.product_name)) {
    const { error } = await supabase.from('crm_locker_assignments').delete().eq('member_id', mid).eq('starts_on', p.data.starts_on).eq('price_paid', p.data.price_paid || 0).eq('billing', '기간 결제');
    if (error) throw error;
  }
  { const { error } = await supabase.from('crm_passes').delete().eq('id', pass_id); if (error) throw error; }
  // 990crm에서 만든 회원이고 남은 기록이 없으면 회원도 지운다 (테스트로 넣은 회원)
  const [left, att, m] = await Promise.all([
    supabase.from('crm_passes').select('id', { count: 'exact', head: true }).eq('member_id', mid),
    supabase.from('crm_attendance').select('member_id', { count: 'exact', head: true }).eq('member_id', mid),
    supabase.from('crm_members').select('legacy_id,lifetime_paid').eq('id', mid).maybeSingle(),
  ]);
  if (left.error || att.error || m.error) throw left.error || att.error || m.error;
  clearCache();
  if (m.data && !m.data.legacy_id && !left.count && !att.count) {
    await supabase.from('crm_inquiries').update({ member_id: null, result: null }).eq('member_id', mid); // 등록으로 바꿔 둔 문의를 되돌린다
    const { error } = await supabase.from('crm_members').delete().eq('id', mid);
    if (error) throw error;
    return [200, { deleted_member: true }];
  }
  if (m.data) { const { error } = await supabase.from('crm_members').update({ lifetime_paid: Math.max(0, (Number(m.data.lifetime_paid) || 0) - paid) }).eq('id', mid); if (error) throw error; }
  await syncMemberEnd(mid, { allowEarlier: true, removedStart: p.data.starts_on });
  await supabase.from('crm_events').insert({ member_id: mid, kind: '등록 취소', body: `${p.data.product_name} · ${(paid || 0).toLocaleString()}원 등록을 지웠어요`, staff_name: staff ? String(staff).slice(0, 20) : null });
  return member({ id: mid });
}

async function paymentMethod({ id, method }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  if (method && !PAY_METHODS.includes(method)) return [400, { error: '결제 방법을 다시 골라주세요' }];
  const { error } = await supabase.from('crm_payments').update({ method: method || null, method_split: null, method_note: null }).eq('id', id);
  if (error) throw error;
  return [200, { ok: true }];
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
// 직원 순서·직책 색은 설정에 저장 (staff_order: [id...], role_colors: {직책: 색 이름})
const ROLE_COLORS = ['파랑', '남색', '빨강', '하늘', '초록', '주황', '보라', '회색'];
async function staffMeta() {
  const { data, error } = await supabase.from('crm_settings').select('key,value').in('key', ['staff_order', 'role_colors']);
  if (error) throw error;
  const v = Object.fromEntries((data || []).map((x) => [x.key, x.value]));
  return { order: Array.isArray(v.staff_order) ? v.staff_order : [], colors: v.role_colors && typeof v.role_colors === 'object' ? v.role_colors : {} };
}
const sortStaff = (list, order) => list.slice().sort((a, b) => { const x = order.indexOf(a.id), y = order.indexOf(b.id); return (x < 0 ? 1e9 : x) - (y < 0 ? 1e9 : y); });
const roleColorsOf = (roles, colors) => Object.fromEntries(roles.map((r, i) => [r, ROLE_COLORS.includes(colors[r]) ? colors[r] : ROLE_COLORS[i % ROLE_COLORS.length]]));
async function staffList() {
  const [{ data, error }, roles, meta] = await Promise.all([supabase.from('crm_staff').select('id,name,role,active,phone').eq('active', true).order('created_at'), getRoles(), staffMeta()]);
  if (error) throw error;
  return [200, { staff: sortStaff(data, meta.order), roles, roleColors: roleColorsOf(roles, meta.colors), colorNames: ROLE_COLORS }];
}
async function staffOrder({ ids }) {
  if (!Array.isArray(ids) || ids.length > 100) return [400, { error: '순서가 맞지 않아요' }];
  const { error } = await supabase.from('crm_settings').upsert({ key: 'staff_order', value: ids.map(String).slice(0, 100), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  return staffList();
}
async function roleColor({ role, color }) {
  if (!role || !ROLE_COLORS.includes(color)) return [400, { error: '색을 다시 골라주세요' }];
  const meta = await staffMeta();
  const { error } = await supabase.from('crm_settings').upsert({ key: 'role_colors', value: { ...meta.colors, [String(role).slice(0, 20)]: color }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  return staffList();
}
const cleanRole = (role, roles) => (role && roles.includes(String(role).trim()) ? String(role).trim() : null);
// 직원 휴대폰 번호: 태블릿에서 11자리를 누르면 출퇴근이 찍힌다. 비워 두면 출퇴근을 안 쓰는 직원.
async function staffPhoneCheck(phone, selfId) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return { phone: null };
  if (!/^010\d{8}$/.test(d)) return { error: '휴대폰 번호 11자리(010…)를 적어주세요' };
  const { data, error } = await supabase.from('crm_staff').select('id,name,phone').eq('active', true);
  if (error) throw error;
  const dup = data.find((x) => x.id !== selfId && String(x.phone || '').replace(/\D/g, '') === d);
  if (dup) return { error: `${dup.name}님과 같은 번호예요` };
  return { phone: `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` };
}
async function staffAdd({ name, role, phone }) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return [400, { error: '이름을 적어주세요' }];
  const ph = await staffPhoneCheck(phone, null);
  if (ph.error) return [400, { error: ph.error }];
  const r = cleanRole(role, await getRoles());
  const ex = await supabase.from('crm_staff').select('id').eq('name', n).maybeSingle();
  if (ex.error) throw ex.error;
  const q = ex.data ? supabase.from('crm_staff').update({ role: r, active: true, ...(ph.phone ? { phone: ph.phone } : {}) }).eq('id', ex.data.id) : supabase.from('crm_staff').insert({ name: n, role: r, active: true, phone: ph.phone });
  const { error } = await q;
  if (error) throw error;
  return staffList();
}
// 이름·직책 고치기. 이름을 바꾸면 이번 달 처리 기록의 이름도 같이 바꾼다.
async function staffUpdate({ id, name, role, phone }) {
  const n = String(name || '').trim().slice(0, 20);
  if (!id || !n) return [400, { error: '이름을 적어주세요' }];
  const cur = await supabase.from('crm_staff').select('id,name').eq('id', id).maybeSingle();
  if (cur.error) throw cur.error;
  if (!cur.data) return [404, { error: '직원을 찾을 수 없어요' }];
  const dup = await supabase.from('crm_staff').select('id').eq('name', n).eq('active', true).maybeSingle();
  if (dup.error) throw dup.error;
  if (dup.data && dup.data.id !== id) return [400, { error: '같은 이름이 이미 있어요' }];
  const ph = phone === undefined ? null : await staffPhoneCheck(phone, id);
  if (ph && ph.error) return [400, { error: ph.error }];
  const { error } = await supabase.from('crm_staff').update({ name: n, role: cleanRole(role, await getRoles()), ...(ph ? { phone: ph.phone } : {}) }).eq('id', id);
  if (error) throw error;
  if (cur.data.name !== n) {
    const t = await supabase.from('crm_tasks').update({ done_by: n }).eq('done_by', cur.data.name);
    if (t.error) throw t.error;
    await supabase.from('crm_push_subs').update({ staff_name: n }).eq('staff_name', cur.data.name); // 알림 폰 주인 이름도 같이
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
    supabase.from('crm_inquiries').select('inquired_at').or(INQ_OK).gte('inquired_at', kstStart(P.prevFrom)).lt('inquired_at', kstEndEx(P.to)),
    supabase.from('subscribers').select('created_at,cancelled_at,status,churn_reason'),
    getFinance(),
    supabase.from('crm_inquiries').select('source,result,member_id,summary,inquired_at').or(INQ_OK).gte('inquired_at', kstStart(P.from)).lt('inquired_at', kstEndEx(P.to)),
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
    const at = uniqDays(att).filter((x) => inR(kstDate(x.checked_at), a, b));
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
  const trialM = new Set(), newPay = new Set(), regDay = {};
  const passById = Object.fromEntries(passes.map((x) => [x.id, x]));
  pays.filter((p) => inP(p.day)).forEach((p) => {
    const nm = (passById[p.pass_id] || {}).product_name || '';
    if (/체험|^PT ?3회$/.test(nm)) trialM.add(p.member_id);
    else if (p.kind === '신규') { newPay.add(p.member_id); if (!regDay[p.member_id] || p.day < regDay[p.member_id]) regDay[p.member_id] = p.day; }
  });
  // 정규 등록 = 처음 오신 분 (PT만 사도 포함). 브로제이가 '신규'로 찍었어도 이 기간 전에 이용권이 있던 분은 '복귀'로 따로 센다
  const cand = [...newPay];
  const chunks = []; for (let i = 0; i < cand.length; i += 150) chunks.push(cand.slice(i, i + 150));
  const [priorRes, peopleRes, allInq] = await Promise.all([
    Promise.all(chunks.map((c) => supabase.from('crm_passes').select('member_id').in('member_id', c).lt('registered_on', P.from).neq('status', '무효'))),
    Promise.all(chunks.map((c) => supabase.from('crm_members').select('id,name,phone').in('id', c))),
    selectAll(() => supabase.from('crm_inquiries').select('member_id,name,phone,inquired_at').or(INQ_OK)),
  ]);
  const prior = new Set(), person = {};
  priorRes.forEach(({ data, error }) => { if (error) throw error; data.forEach((x) => prior.add(x.member_id)); });
  peopleRes.forEach(({ data, error }) => { if (error) throw error; data.forEach((x) => { person[x.id] = x; }); });
  const regIds = cand.filter((m) => !prior.has(m)), returned = cand.length - regIds.length;
  const regM = new Set(regIds);
  const bare = (v) => String(v || '').replace(/\(.*?\)|\s/g, '');
  const origin = { thisPeriod: 0, earlier: 0, none: 0 }, lag = [];
  regIds.forEach((mid) => {
    const m = person[mid] || {}, rd = regDay[mid], until = new Date(Date.parse(rd) + DAY).toISOString().slice(0, 10), since = new Date(Date.parse(rd) - 180 * DAY).toISOString().slice(0, 10);
    // 연락처·회원 연결이 먼저, 없으면 같은 이름 (반년 안 문의만)
    let qs = allInq.filter((q) => (q.member_id === mid || (m.phone && q.phone === m.phone)) && kstDate(q.inquired_at) <= until);
    if (!qs.length && m.name) qs = allInq.filter((q) => bare(q.name) === bare(m.name) && kstDate(q.inquired_at) <= until && kstDate(q.inquired_at) >= since);
    const last = qs.map((q) => kstDate(q.inquired_at)).sort().pop();
    if (last && last >= P.from) origin.thisPeriod++;
    else if (last) { origin.earlier++; lag.push(daysBetween(last, rd)); }
    else origin.none++;
  });
  const funnel = { inquiries: inqAll.data.length, trial: trialM.size, regular: regM.size, regularFromTrial: regIds.filter((m) => trialM.has(m)).length, renewed: cur.renewed, ended: cur.ended,
    origin, returned, earlierLag: lag.length ? Math.round(lag.reduce((a, b) => a + b, 0) / lag.length) : null };
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
  uniqDays(att).filter((x) => inP(kstDate(x.checked_at))).forEach((x) => { const d = kstDate(x.checked_at); const w = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; const h = kstHour(x.checked_at); const slot = h < 6 ? -1 : Math.min(5, Math.floor((h - 6) / 3)); if (slot >= 0) heat[w][slot]++; if (!seenDays.has(d)) { seenDays.add(d); dayCount[w]++; } });
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
const SORTS = ['reg', 'name', 'status', 'pass', 'left', 'visits', 'last'];
const DB_SORT = { reg: 'first_started_on', name: 'name', left: 'ends_on', last: 'last_attended_on' };
// 회원 목록 표에 보일 이용권 이름·처음 등록일·이번 달 출석 횟수를 붙인다
async function withListExtras(rows, today) {
  const ids = rows.map((m) => m.id);
  const monthStart = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00+09:00`)).toISOString();
  const chunks = []; for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
  const [ps, at, firsts, ptPays] = await Promise.all([
    // PT는 만료가 없다(만료일 = 환불 기한, 남은 횟수는 계속 사용) → PT 이력이 있으면 모두 +PT 표시. 회원권 이름은 살아 있는 것만.
    Promise.all(chunks.map((c) => selectAll(() => supabase.from('crm_passes').select('member_id,product_name,category,ends_on,registered_on,status').in('member_id', c).not('status', 'in', '("무효","환불")')))),
    Promise.all(chunks.map((c) => selectAll(() => supabase.from('crm_attendance').select('member_id,checked_at').in('member_id', c).gte('checked_at', monthStart)))),
    // 처음 등록한 날 = 문의에서 회원으로 전환된 날 (나중에 PT를 사도 안 바뀜)
    Promise.all(chunks.map((c) => selectAll(() => supabase.from('crm_passes').select('member_id,registered_on').in('member_id', c).neq('status', '무효')))),
    // 이용권 없이 매출장에만 있는 PT 결제도 PT 이력으로 본다
    Promise.all(chunks.map((c) => selectAll(() => supabase.from('crm_payments').select('member_id,item').in('member_id', c).like('item', 'PT%')))),
  ]);
  const passName = {}, ptName = {}, visits = {}, regOn = {};
  firsts.forEach((d) => d.forEach((p) => { if (p.registered_on && p.registered_on <= today && (!regOn[p.member_id] || p.registered_on < regOn[p.member_id])) regOn[p.member_id] = p.registered_on; }));
  ps.forEach((d) => { d.forEach((p) => {
    const g = salesGroup(p.product_name, p.category);
    if (g === 'PT') { if (!ptName[p.member_id] || ACTIVE_ST.includes(p.status)) ptName[p.member_id] = p.product_name; return; }
    if (!ACTIVE_ST.includes(p.status)) return;
    if (!passName[p.member_id] || String(p.ends_on) > String(passName[p.member_id].ends_on)) passName[p.member_id] = p;
  }); });
  at.forEach((d) => uniqDays(d).forEach((a) => { visits[a.member_id] = (visits[a.member_id] || 0) + 1; }));
  ptPays.forEach((d) => d.forEach((p) => { if (!ptName[p.member_id]) ptName[p.member_id] = 'PT'; }));
  return rows.map((m) => ({ ...m, pass_name: passName[m.id] ? passName[m.id].product_name : null, pt_name: ptName[m.id] || (hasPtTag(m) ? 'PT' : null), month_visits: visits[m.id] || 0, registered_on: [regOn[m.id], m.first_started_on].filter(Boolean).sort()[0] || null }));
}
async function members({ q = '', stage = '', limit = 60, offset = 0, sort = '', dir = '' }) {
  const today = todayKST();
  const term = String(q).trim().slice(0, 30);
  // 기본: 유효 회원은 최근 등록한 순, 만료·이탈은 최근 만료 순
  const key = SORTS.includes(sort) ? sort : stage === '만료·이탈' ? 'left' : 'reg';
  const asc = dir === 'asc' ? true : dir === 'desc' ? false : key === 'name' || (key === 'left' && stage !== '만료·이탈');
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
  query = query.order(DB_SORT[key] || 'ends_on', { ascending: key === 'last' ? !asc : asc, nullsFirst: false });
  // 단계는 오늘 기준으로 다시 계산하므로 유효 회원은 전부 받아서 거르고 정렬한다 (최대 수백 명)
  const big = !term && stage !== '만료·이탈';
  let rows, counts = null, count = null;
  if (big) {
    // 유효 회원 전체(+이용권·출석)는 1분 동안 기억해 두고, 단계 칩·정렬을 바꿀 때는 다시 안 읽는다
    const base = await memo('members_big', 60000, async () => {
      const [{ data, error }, subs, expiredDb, trialSet] = await Promise.all([
        query.range(0, 1999), subsMap(),
        supabase.from('crm_members').select('id', { count: 'exact', head: true }).eq('stage', '만료·이탈'),
        trialOnlySet(),
      ]);
      if (error) throw error;
      const all = markTrial(data.map((m) => decorate(m, today, subs)), trialSet);
      const live = all.filter((m) => m.stage !== '만료·이탈');
      return { all, live: await withListExtras(live, today), expired: (expiredDb.count || 0) + (all.length - live.length) };
    });
    const live = base.live;
    const isSub = (m) => m.sub === '구독 중' || m.sub === '쉬어가기';
    counts = { '': live.length, '월구독': live.filter(isSub).length, '홀딩': live.filter((m) => m.holding).length, '만료·이탈': base.expired };
    ['체험', '신규', '정착', '미출석', '만료 예정'].forEach((k) => { counts[k] = live.filter((m) => m.stage === k).length; });
    if (stage === '월구독') rows = live.filter(isSub);
    else if (stage === '홀딩') rows = live.filter((m) => m.holding);
    else if (stage) rows = live.filter((m) => m.stage === stage);
    else rows = live;
  } else {
    const [r, subs, trialSet] = await Promise.all([query.range(offset, offset + Math.min(limit, 100) - 1), subsMap(), trialOnlySet()]);
    if (r.error) throw r.error;
    count = r.count;
    rows = await withListExtras(markTrial(r.data.map((m) => decorate(m, today, subs)), trialSet), today);
  }
  let out = rows.slice();
  const STAGE_ORDER = ['체험', '신규', '정착', '미출석', '만료 예정', '만료·이탈'];
  const val = (m) => key === 'reg' ? m.registered_on : key === 'name' ? m.name : key === 'status' ? (m.holding ? 9 : STAGE_ORDER.indexOf(m.stage)) : key === 'pass' ? (m.pass_name || m.usage_tag || '') : key === 'left' ? (m.sub === '구독 중' || m.sub === '쉬어가기' ? 9999 : m.days_left) : key === 'visits' ? m.month_visits : m.days_absent;
  out.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null || x === '') return y == null || y === '' ? 0 : 1;
    if (y == null || y === '') return -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko');
    return asc ? c : -c;
  });
  if (big) out = out.slice(offset, offset + Math.min(limit, 100));
  return [200, { members: out, total: big ? rows.length : count, counts, sort: key, dir: asc ? 'asc' : 'desc' }];
}

// ---------- 회원 상세 ----------
// 회원 한 명 출석부: 한 달 치 입실 기록 + 전체 횟수·첫 기록. 달을 안 정하면 마지막으로 온 달
async function memberAttendance({ id, month }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const [lastQ, firstQ, cnt] = await Promise.all([
    supabase.from('crm_attendance').select('checked_at').eq('member_id', id).order('checked_at', { ascending: false }).limit(1),
    supabase.from('crm_attendance').select('checked_at').eq('member_id', id).order('checked_at', { ascending: true }).limit(1),
    supabase.from('crm_attendance').select('member_id', { count: 'exact', head: true }).eq('member_id', id),
  ]);
  if (lastQ.error || firstQ.error || cnt.error) throw lastQ.error || firstQ.error || cnt.error;
  const last = lastQ.data[0] ? kstDate(lastQ.data[0].checked_at) : null, first = firstQ.data[0] ? kstDate(firstQ.data[0].checked_at) : null;
  const ym = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : (last || todayKST()).slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600e3).toISOString(), to = new Date(Date.UTC(y, m, 1) - 9 * 3600e3).toISOString();
  const { data, error } = await supabase.from('crm_attendance').select('checked_at,via').eq('member_id', id).gte('checked_at', from).lt('checked_at', to).order('checked_at', { ascending: false });
  if (error) throw error;
  return [200, { month: ym, rows: data.map((r) => ({ at: r.checked_at, via: r.via || null })), total: cnt.count || 0, first, last }];
}
async function member({ id }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const today = todayKST();
  const [m, passes, payments, lockers, inquiries, events, att, S] = await Promise.all([
    supabase.from('crm_members').select('*').eq('id', id).maybeSingle(),
    supabase.from('crm_passes').select('id,product_name,category,status,starts_on,ends_on,total_count,remaining_count,trainer,price_paid,registered_on,legacy_id').eq('member_id', id).order('starts_on', { ascending: true }),
    supabase.from('crm_payments').select('id,amount,list_price,discount_reason,kind,method,method_split,method_note,staff_name,paid_at,pass_id,item,sales_excluded').eq('member_id', id).order('paid_at', { ascending: true }),
    supabase.from('crm_locker_assignments').select('locker_no,status,starts_on,ends_on,price_paid,billing').eq('member_id', id).order('starts_on', { ascending: true }),
    supabase.from('crm_inquiries').select('inquired_at,raw_note,result').eq('member_id', id).order('inquired_at', { ascending: true }),
    supabase.from('crm_events').select('kind,body,staff_name,at').eq('member_id', id).order('at', { ascending: false }).limit(30),
    supabase.from('crm_attendance').select('checked_at').eq('member_id', id).gte('checked_at', new Date(Date.now() - 56 * DAY).toISOString()),
    subsMap(),
  ]);
  if (events.error || att.error) throw events.error || att.error;
  const weeks = Array(8).fill(0);
  uniqDays(att.data.map((a) => ({ ...a, member_id: id }))).forEach((a) => { const w = Math.floor((Date.now() - Date.parse(a.checked_at)) / (7 * DAY)); if (w >= 0 && w < 8) weeks[7 - w]++; });
  const err = m.error || passes.error || payments.error || lockers.error || inquiries.error;
  if (err) throw err;
  if (!m.data) return [404, { error: '회원을 찾을 수 없어요' }];
  const { checkin_code, photo_path, ...safe } = m.data; // 출석 번호는 화면에 안 보낸다
  const sb = subOf(safe, S);
  // 체험 여부는 이 회원 이용권만 보고 판단 (전체 이용권을 다시 안 읽는다)
  const livePs = (passes.data || []).filter((p) => ['사용 중', '예정', '홀딩'].includes(p.status));
  const trialSet = new Set(livePs.length && livePs.every((p) => /체험|^PT ?3회$/.test(p.product_name || '')) ? [id] : []);
  return [200, {
    member: { ...markTrial([decorate(safe, today, S)], trialSet)[0], photo_url: await photoUrl(photo_path),
      subscription: sb ? { id: sb.id, name: sb.name, plan: sb.plan, addons: sb.addons || [], status: sb.status, next_billing_date: sb.next_billing_date, phone4: digitsOf(sb.phone).slice(-4), linked: safe.subscriber_id === sb.id } : null },
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

// ---------- 직원 폰 출석 알림 (웹 푸시) ----------
// 열쇠(VAPID)는 처음 쓸 때 서버가 만들어 admin_settings 'vapid' 에 둔다 (밖으로 안 나간다)
async function vapid() {
  const read = async () => { const { data } = await supabase.from('admin_settings').select('value').eq('key', 'vapid').maybeSingle(); return data ? JSON.parse(data.value) : null; };
  let v = await read();
  if (!v) {
    const { default: webpush } = await import('web-push');
    const k = webpush.generateVAPIDKeys();
    await supabase.from('admin_settings').insert({ key: 'vapid', value: JSON.stringify(k), updated_at: new Date().toISOString() });
    v = await read(); // 동시에 만들었으면 먼저 저장된 걸 쓴다
  }
  return v;
}
async function pushKey() { return [200, { key: (await vapid()).publicKey }]; }
async function pushSubscribe({ sub, staff, device, off }) {
  const ep = sub && String(sub.endpoint || '');
  if (!/^https:\/\//.test(ep)) return [400, { error: '알림 정보가 맞지 않아요' }];
  if (off) { await supabase.from('crm_push_subs').delete().eq('endpoint', ep); return [200, { ok: true }]; }
  const k = sub.keys || {};
  if (!k.p256dh || !k.auth) return [400, { error: '알림 정보가 맞지 않아요' }];
  const { error } = await supabase.from('crm_push_subs').upsert({ endpoint: ep, p256dh: k.p256dh, auth: k.auth, staff_name: staff ? String(staff).slice(0, 20) : null, device: device ? String(device).slice(0, 60) : null }, { onConflict: 'endpoint' });
  if (error) throw error;
  return [200, { ok: true }];
}
// 이 폰이 누구 폰인지 (CRM 화면에서 확인용)
async function pushWho({ endpoint }) {
  const ep = String(endpoint || ''); if (!ep) return [200, { known: false }];
  const [me, pp] = await Promise.all([supabase.from('crm_push_subs').select('staff_name').eq('endpoint', ep).maybeSingle(), pushPeople()]);
  if (me.error) throw me.error;
  if (!me.data) return [200, { known: false }];
  const n = me.data.staff_name;
  return [200, { known: true, staff_name: n || null, lead: !n || pp.leads.has(n), active: !n || pp.active.has(n) }];
}
// 알림 받는 폰 구분: 폰 주인(직원 명단 이름)의 직책으로 나눈다.
// 대표·매니저 = 모든 알림, 다른 직원 = 입실 알림·직원 호출만, 명단에서 빠진 직원 = 안 보냄. 주인을 아직 안 고른 예전 폰은 모두 받는다.
const isLeadRole = (r) => /대표|매니저|실장/.test(r || '');
async function pushPeople() {
  const { data, error } = await supabase.from('crm_staff').select('name,role').eq('active', true);
  if (error) throw error;
  return { active: new Set(data.map((x) => x.name)), leads: new Set(data.filter((x) => isLeadRole(x.role)).map((x) => x.name)) };
}
// 알림 보내기: 등록된 폰 전부 (한 곳만 고르면 only). 2초 넘게 안 기다린다. 없어진 폰은 지운다.
async function pushSend(msg, only) {
  try {
    const [{ default: webpush }, v, subs] = await Promise.all([
      import('web-push'), vapid(),
      only ? Promise.resolve({ data: [only] }) : supabase.from('crm_push_subs').select('endpoint,p256dh,auth,staff_name'),
    ]);
    let list = (subs.data || []).filter((x) => x && x.endpoint);
    if (!only) { const pp = await pushPeople(); list = list.filter((x) => !x.staff_name || pp.active.has(x.staff_name)); } // 명단에서 빠진 직원 폰은 안 보냄
    if (!list.length) return 0;
    const body = JSON.stringify(msg);
    const opt = { vapidDetails: { subject: 'https://the990.co.kr', publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 3600, timeout: 2000 };
    const res = await Promise.allSettled(list.map((x) => webpush.sendNotification({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth } }, body, opt)));
    const gone = list.filter((x, i) => res[i].status === 'rejected' && [404, 410].includes(res[i].reason && res[i].reason.statusCode)).map((x) => x.endpoint);
    if (gone.length) await supabase.from('crm_push_subs').delete().in('endpoint', gone);
    return res.filter((r) => r.status === 'fulfilled').length;
  } catch (e) { console.error('push', e && e.message); return 0; }
}
async function pushTest({ sub }) {
  const ep = sub && sub.endpoint, k = (sub && sub.keys) || {};
  if (!ep || !k.p256dh || !k.auth) return [400, { error: '알림 정보가 맞지 않아요' }];
  const n = await pushSend({ title: '990crm 출석 알림', body: '이 폰으로 출석 알림이 와요 ✓', tag: 'test' }, { endpoint: ep, p256dh: k.p256dh, auth: k.auth });
  return n ? [200, { ok: true }] : [500, { error: '알림을 보내지 못했어요' }];
}
// 출석 횟수는 하루에 한 번으로 센다 (같은 날 여러 번 들어와도 기록은 다 남고, 세는 건 그날 첫 입장 하나)
function uniqDays(rows) {
  const m = new Map();
  rows.forEach((r) => { const k = `${r.member_id}|${kstDate(r.checked_at)}`; const o = m.get(k); if (!o || r.checked_at < o.checked_at) m.set(k, r); });
  return [...m.values()];
}
const hhmm = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16); // 한국 시각 19:45
function checkinMessage(name, r) {
  // 브로제이 운톡처럼 줄을 나눠서: 이용권 / 종료일(남은 날)
  const sub = r.sub === '구독 중' || r.sub === '쉬어가기';
  const lines = [];
  if (r.again) lines.push(`오늘 ${r.today_n}번째 입실`);
  if (r.product) lines.push(`이용권: ${r.product}`); // PT 남은 횟수는 아직 정확하지 않아 알림에 안 넣는다
  if (sub) lines.push(`월구독${r.next_billing ? ` · 다음 결제 ${r.next_billing}` : ''}`);
  else if (r.ends_on) lines.push(`종료일: ${r.ends_on}${r.days_left != null ? ` (${r.days_left}일 남음)` : ''}`);
  const head = r.again ? '다시 입실' : `출석${r.first_time ? ' · 첫 방문' : ''}`;
  return { title: `${name}님 ${head} · ${hhmm()}${r.day_total ? ` · 오늘 ${r.day_total}명째` : ''}`, body: lines.join('\n') || '정상 출석', tag: `att-${Date.now()}` };
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
  if (d.stage === '만료·이탈' || m.holding) {
    const reason = m.holding ? '지금 홀딩 중이에요. 인포에 말씀해 주세요.' : '이용권이 끝났어요. 인포에 말씀해 주세요.';
    await pushSend({ title: `⚠ ${m.name}님 입실 시도 · ${hhmm()}`, body: m.holding ? '홀딩 중인 회원이에요' : `이용권이 끝난 회원이에요${m.ends_on ? `\n종료일: ${m.ends_on}` : ''}`, tag: `att-${Date.now()}` });
    return [200, { ...base, blocked: true, reason }];
  }

  // 10분 안에 또 찍은 건 실수로 보고 무시. 같은 날 다시 들어오면 '다시 입실'로 기록은 남기되 출석 횟수는 하루 한 번.
  const last = recent.data[0] ? Date.parse(recent.data[0].checked_at) : 0;
  const dup = Date.now() - last < 10 * 60 * 1000;
  const todayN = recent.data.filter((r) => kstDate(r.checked_at) === today).length;
  const again = todayN > 0;
  if (!dup) {
    const ins = await supabase.from('crm_attendance').insert({ member_id: id, via: '태블릿' });
    if (ins.error) throw ins.error;
    if (!again) {
      const up = await supabase.from('crm_members').update({ last_attended_on: today, total_visits: (m.total_visits || 0) + 1, updated_at: new Date().toISOString() }).eq('id', id);
      if (up.error) throw up.error;
    }
  }
  const month = today.slice(0, 7);
  const thisMonth = new Set(recent.data.map((r) => kstDate(r.checked_at)).filter((d) => d.slice(0, 7) === month).concat([today])).size;
  const pt = passes.data.filter((p) => /PT/.test(p.product_name) || p.category === 'PT');
  const main = passes.data.filter((p) => !pt.includes(p)).sort((a, b) => String(b.ends_on).localeCompare(String(a.ends_on)))[0];
  const out = { ...base, again, days_left: d.days_left, ends_on: d.ends_on, sub: d.sub, next_billing: d.next_billing, product: main ? main.product_name : null,
    pt_left: pt.reduce((a, p) => a + (p.remaining_count || 0), 0), pt_total: pt.reduce((a, p) => a + (p.total_count || 0), 0),
    this_month: thisMonth, first_time: !m.last_attended_on, dup, today_n: todayN + (dup ? 0 : 1),
    // 태블릿 인사말용: 지난 운동 뒤 며칠 만인지, 오늘이 몇 번째 운동인지
    gap_days: m.last_attended_on && m.last_attended_on < today ? daysBetween(m.last_attended_on, today) : null,
    visits: (m.total_visits || 0) + (again || dup ? 0 : 1) };
  if (!dup) {
    // 오늘 입실한 회원 수 (하루 한 명은 한 번만)
    const dc = await supabase.from('crm_members').select('id', { count: 'exact', head: true }).eq('last_attended_on', today);
    await pushSend(checkinMessage(m.name, { ...out, day_total: dc.error ? null : dc.count })); // 직원 폰으로 (10분 안에 또 찍은 건 안 보냄)
  }
  return [200, out];
}

// ---------- 직원 출퇴근 (입실 태블릿에서 휴대폰 번호 11자리) ----------
// 그날 처음 = 출근, 출근 중에 또 = 퇴근. 2분 안에 또 누른 건 실수로 보고 무시. 퇴근을 안 찍은 날은 매니저가 출근부에서 고친다.
const minsTxt = (n) => (n >= 60 ? `${Math.floor(n / 60)}시간${n % 60 ? ` ${n % 60}분` : ''}` : `${n}분`);
const minsOf = (r) => (r.in_at && r.out_at ? Math.max(0, Math.round((Date.parse(r.out_at) - Date.parse(r.in_at)) / 60000)) : 0);
const kstHM = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(11, 16);
// 출퇴근 알림은 대표·매니저 폰으로 (폰 주인을 모르는 기존 등록 폰도 받는다)
async function pushToLeads(msg) {
  const [subs, pp] = await Promise.all([supabase.from('crm_push_subs').select('endpoint,p256dh,auth,staff_name'), pushPeople()]);
  const list = (subs.data || []).filter((x) => !x.staff_name || pp.leads.has(x.staff_name));
  await Promise.all(list.map((x) => pushSend(msg, x)));
}
async function staffPunch({ phone }) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!/^010\d{8}$/.test(d)) return [400, { error: '휴대폰 번호 11자리를 눌러주세요' }];
  const st = await supabase.from('crm_staff').select('id,name,role,phone').eq('active', true);
  if (st.error) throw st.error;
  const s = st.data.find((x) => String(x.phone || '').replace(/\D/g, '') === d);
  if (!s) return [404, { error: '직원 명단에 없는 번호예요. 매니저에게 말씀해 주세요.' }];
  const today = todayKST(), now = Date.now();
  const rows = await supabase.from('crm_staff_attendance').select('id,in_at,out_at').eq('staff_id', s.id).eq('work_date', today).order('in_at');
  if (rows.error) throw rows.error;
  const list = rows.data || [];
  let open = list.find((r) => !r.out_at);
  // 자정 넘겨 퇴근: 오늘 기록이 없고 어제 출근이 16시간 안이면 그 기록의 퇴근으로
  if (!list.length) {
    const y = await supabase.from('crm_staff_attendance').select('id,in_at,out_at').eq('staff_id', s.id).eq('work_date', addDaysYMD(today, -1)).is('out_at', null).order('in_at', { ascending: false }).limit(1);
    if (!y.error && y.data && y.data[0] && now - Date.parse(y.data[0].in_at) < 16 * 3600e3) { open = y.data[0]; list.push(open); }
  }
  const lastOut = list.filter((r) => r.out_at).map((r) => Date.parse(r.out_at)).sort().pop() || 0;
  let kind, at = new Date(now).toISOString(), dup = false;
  if (open && now - Date.parse(open.in_at) < 2 * 60000) { kind = '출근'; at = open.in_at; dup = true; }
  else if (!open && lastOut && now - lastOut < 2 * 60000) { kind = '퇴근'; at = new Date(lastOut).toISOString(); dup = true; }
  else if (open) {
    const u = await supabase.from('crm_staff_attendance').update({ out_at: at }).eq('id', open.id);
    if (u.error) throw u.error;
    open.out_at = at; kind = '퇴근';
  } else {
    const ins = await supabase.from('crm_staff_attendance').insert({ staff_id: s.id, work_date: today, in_at: at, via: '태블릿' });
    if (ins.error) throw ins.error;
    kind = '출근';
  }
  const worked = list.reduce((a, r) => a + minsOf(r), 0);
  if (!dup) await pushToLeads({ title: `${s.name}님 ${kind} · ${kstHM(at)}`, body: kind === '퇴근' ? `오늘 총 ${minsTxt(worked)}` : (s.role || '직원'), tag: `work-${now}` });
  return [200, { name: s.name, role: s.role || null, kind, at, dup, worked_min: worked }];
}
// 입실 태블릿 '직원 호출' → 직원 폰 전체로 알림. 20초 안에 또 누른 건 한 번으로 친다.
async function staffCall() {
  const prev = await supabase.from('crm_settings').select('value').eq('key', 'staff_call').maybeSingle();
  const last = prev.data && prev.data.value && Date.parse(prev.data.value.at) || 0;
  if (Date.now() - last < 20000) return [200, { ok: true, again: true }];
  const at = new Date().toISOString();
  await supabase.from('crm_settings').upsert({ key: 'staff_call', value: { at }, updated_at: at }, { onConflict: 'key' });
  await pushSend({ title: `🔔 직원 호출 · ${kstHM(at)}`, body: '입실 태블릿에서 직원을 찾고 있어요', tag: `call-${Date.now()}`, call: true });
  return [200, { ok: true, again: false }];
}
// 출근부: 한 달 치 기록 + 직원별 근무시간. 퇴근 안 찍은 지난 날 = missing (근무시간에 안 넣음)
async function staffAttendance({ month }) {
  const today = todayKST();
  const ym = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : today.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`, to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [st, rows] = await Promise.all([
    supabase.from('crm_staff').select('id,name,role,phone,active').order('created_at'),
    supabase.from('crm_staff_attendance').select('id,staff_id,work_date,in_at,out_at,note,edited_by').gte('work_date', from).lte('work_date', to).order('work_date', { ascending: false }).order('in_at', { ascending: false }),
  ]);
  if (st.error || rows.error) throw st.error || rows.error;
  const byId = Object.fromEntries(st.data.map((x) => [x.id, x]));
  const recs = rows.data.map((r) => ({ ...r, name: (byId[r.staff_id] || {}).name || '-', minutes: minsOf(r), missing: !r.out_at && r.work_date < today, working: !r.out_at && r.work_date === today }));
  const staff = st.data.filter((x) => (x.active && x.phone) || recs.some((r) => r.staff_id === x.id)).map((x) => {
    const mine = recs.filter((r) => r.staff_id === x.id);
    return { id: x.id, name: x.name, role: x.role, phone: x.phone, active: x.active, days: new Set(mine.map((r) => r.work_date)).size, minutes: mine.reduce((a, r) => a + r.minutes, 0), missing: mine.filter((r) => r.missing).length, working: mine.some((r) => r.working) };
  });
  return [200, { month: ym, today, staff, rows: recs }];
}
// 출근부 고치기·추가·지우기 (시각은 한국 시각 HH:MM)
async function staffAttendanceSave({ id, staff_id, work_date, in_time, out_time, remove, staff }) {
  const by = staff ? String(staff).slice(0, 20) : null;
  if (remove) {
    if (!id) return [400, { error: '필수 정보 누락' }];
    const { error } = await supabase.from('crm_staff_attendance').delete().eq('id', id);
    if (error) throw error;
    return [200, { ok: true }];
  }
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  let day = work_date, sid = staff_id;
  if (id) {
    const cur = await supabase.from('crm_staff_attendance').select('staff_id,work_date').eq('id', id).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) return [404, { error: '기록을 찾을 수 없어요' }];
    day = cur.data.work_date; sid = cur.data.staff_id;
  }
  if (!isDate(day) || !sid) return [400, { error: '날짜와 직원을 골라주세요' }];
  if (!hm.test(String(in_time || ''))) return [400, { error: '출근 시각을 확인해주세요' }];
  if (out_time && !hm.test(String(out_time))) return [400, { error: '퇴근 시각을 확인해주세요' }];
  const inAt = new Date(`${day}T${in_time}:00+09:00`).toISOString();
  let outAt = out_time ? new Date(`${day}T${out_time}:00+09:00`).toISOString() : null;
  if (outAt && outAt <= inAt) outAt = new Date(Date.parse(outAt) + DAY).toISOString(); // 자정 넘긴 퇴근
  const row = { in_at: inAt, out_at: outAt, edited_by: by };
  const q = id ? supabase.from('crm_staff_attendance').update(row).eq('id', id) : supabase.from('crm_staff_attendance').insert({ ...row, staff_id: sid, work_date: day, via: '직접 입력' });
  const { error } = await q;
  if (error) throw error;
  return [200, { ok: true }];
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

// 로그인 확인은 같은 서버에서 1분 동안 기억 (매번 DB에 비밀번호를 다시 묻지 않게)
const OK_TOKENS = new Map();
async function tokenOk(tk) {
  if (!tk) return false;
  const t = OK_TOKENS.get(tk);
  if (t && Date.now() - t < 60000) return true;
  const ok = await verifyToken(supabase, tk);
  if (ok) { if (OK_TOKENS.size > 200) OK_TOKENS.clear(); OK_TOKENS.set(tk, Date.now()); }
  return ok;
}

const ACTIONS = { dashboard, members, member, memberAttendance, salesDays, lockerBoard, kioskRegister, checkinFind, checkin, photoUpload, staffPunch, staffCall, staffAttendance, staffAttendanceSave,
  taskDone, taskUndo, staffList, staffAdd, staffRemove, financeGet, financeSave, salesYear, subSearch, subLink, staffUpdate, rolesSave, report, memoAdd, inquiryAdd, inquiryList, inquiryUpdate, ptBoard, revenue, msgRules, msgRulesSave, ptSession, ptAssign, ptSetLeft, notionSync, passUpdate, paymentMethod, staffOrder, roleColor, taskSnooze, reportV2, attendanceDay, pushKey, pushSubscribe, pushTest, pushWho, products, register, registerUndo, regInquiries, subLocker, reportPush };
const KIOSK_OK = ['checkinFind', 'checkin', 'photoUpload', 'staffPunch', 'staffCall'];
const WRITES = ['checkin', 'photoUpload', 'taskDone', 'taskUndo', 'staffAdd', 'staffUpdate', 'staffRemove', 'financeSave', 'subLink', 'rolesSave', 'memoAdd', 'inquiryAdd', 'inquiryUpdate', 'msgRulesSave', 'ptSession', 'ptAssign', 'ptSetLeft', 'notionSync', 'passUpdate', 'paymentMethod', 'staffOrder', 'roleColor', 'taskSnooze', 'pushSubscribe', 'pushTest', 'register', 'registerUndo', 'subLocker', 'reportPush'];

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.cron === 'notion') {
    if (!process.env.CRON_SECRET || req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
    try { const [code, body] = await notionSync({ force: true }); return res.status(code).json(body); } catch (e) { console.error('notion cron', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let params = req.body || {};
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch (e) { params = {}; } }
  // 브로제이 출석 가져오기: 브로제이 화면에서 바로 보내므로 로그인 대신 한 번 쓰는 가져오기 키로 확인
  if (params.action === 'brojImport') {
    try { const [code, body] = await brojImport(params); return res.status(code).json(body); } catch (e) { console.error('brojImport', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  // 로그인: 서울 서버에서도 바로 받는다 (미국 서버까지 안 가서 첫 화면이 빨라진다). 토큰은 두 서버가 같이 쓴다.
  if (params.action === 'login') {
    try {
      if (!(await passwordConfigured(supabase))) return res.status(503).json({ error: '비밀번호 설정 없음' });
      if (!(await checkPassword(supabase, params.password))) { await new Promise((r) => setTimeout(r, 800)); return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' }); }
      return res.status(200).json(await issueToken(supabase));
    } catch (e) { console.error('login', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  if (params.action === 'cron') {
    try { const [code, body] = await cronRun(params); return res.status(code).json(body); } catch (e) { console.error('cron', params.job, e); return res.status(500).json({ error: '서버 오류' }); }
  }
  if (params.action === 'photoImport') {
    try { const [code, body] = await photoImport(params); return res.status(code).json(body); } catch (e) { console.error('photoImport', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  if (params.action === 'tossTx') {
    try { const [code, body] = await tossTx(params); return res.status(code).json(body); } catch (e) { console.error('tossTx', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  if (params.action === 'attendanceImport') {
    try { const [code, body] = await attendanceImport(params); return res.status(code).json(body); } catch (e) { console.error('attendanceImport', e); return res.status(500).json({ error: '서버 오류' }); }
  }
  const fn = ACTIONS[params.action];
  if (!fn) return res.status(400).json({ error: '알 수 없는 요청' });
  const tk = bearer(req);
  const kiosk = KIOSK_OK.includes(params.action) && isKiosk(tk);
  if (!kiosk && !(await tokenOk(tk))) return res.status(401).json({ error: '로그인이 필요해요' });
  try {
    const t0 = Date.now();
    const [code, body] = await fn(params);
    console.log(`[시간] ${params.action} ${Date.now() - t0}ms`); // 어느 화면이 느린지 기록에서 본다
    return res.status(code).json(body);
  } catch (e) {
    console.error('crm', params.action, e);
    return res.status(500).json({ error: '서버 오류' });
  }
}
