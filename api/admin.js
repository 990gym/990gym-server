import { createClient } from '@supabase/supabase-js';
import { PLAN_PRICES, cleanAddons, monthlyAmount, orderName } from './_pricing.js';
import { cors, bearer, checkPassword, issueToken, verifyToken, passwordConfigured, setPassword } from './_auth.js';

// 관리자 페이지(admin · inquiry · stats)의 모든 데이터 작업은 여기를 거친다.
// POST { action, ...params }  /  Authorization: Bearer <로그인 토큰>
// 페이지에는 DB 열쇠도 비밀번호도 없다. 카드 결제용 billing_key 는 절대 내보내지 않는다.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HIDDEN = ['billing_key', 'customer_key'];
const hide = (row) => {
  const out = { ...row };
  HIDDEN.forEach((k) => delete out[k]);
  return out;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function kstDatePlusMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
}

async function selectAll(table, columns, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns);
    order.forEach(([col, asc]) => { q = q.order(col, { ascending: asc }); });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function getSub(id) {
  const { data, error } = await supabase.from('subscribers').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// ---------- 로그인 없이 되는 것 ----------

const slow = () => new Promise((r) => setTimeout(r, 800)); // 비밀번호 마구 넣어보기 늦추기

async function login({ password }) {
  if (!(await passwordConfigured(supabase))) return [500, { error: '서버에 관리자 비밀번호(ADMIN_PASSWORD)가 아직 설정되지 않았어요.' }];
  if (!(await checkPassword(supabase, password))) {
    await slow();
    return [401, { error: '비밀번호가 올바르지 않습니다.' }];
  }
  return [200, await issueToken(supabase)];
}

// 알림용 맥박: 관리자 화면을 켜 두기만 해도(로그아웃 상태여도) 새 가입·할 일을 알 수 있게.
// 로그인 안 돼 있으면 이름·연락처·플랜은 빼고 숫자와 날짜만 준다.
async function pulse(_, authed) {
  const [recent, todo] = await Promise.all([
    supabase.from('subscribers').select('id,name,plan,status,created_at,promo')
      .order('created_at', { ascending: false }).limit(30),
    supabase.from('subscribers').select('id,name,promo,status,next_billing_date,price_consent_at,consent_msg_sent_at')
      .not('promo', 'is', null).is('price_consent_at', null).eq('status', 'active'),
  ]);
  if (recent.error || todo.error) throw recent.error || todo.error;
  const strip = (r) => {
    if (authed) return r;
    const { name, plan, ...rest } = r;
    return rest;
  };
  return [200, { authed, signups: recent.data.map(strip), consentTodo: todo.data.map(strip) }];
}

// ---------- 로그인해야 되는 것 ----------

async function listSubscribers() {
  // 구독 이력도 함께 보내서, 관리자 화면에서 이름을 누르면 바로 열리게 한다
  const [rows, events] = await Promise.all([
    selectAll('subscribers', '*', [['created_at', false]]),
    selectAll('subscription_events', '*', [['occurred_at', true], ['id', true]]).catch(() => null),
  ]);
  return [200, { subscribers: rows.map(hide), events }];
}

async function inquiryCount() {
  const { count, error } = await supabase.from('inquiries')
    .select('id', { count: 'exact', head: true }).eq('contacted', false);
  if (error) throw error;
  return [200, { pending: count || 0 }];
}

async function listInquiries() {
  const rows = await selectAll('inquiries', '*', [['created_at', false]]);
  return [200, { inquiries: rows }];
}

async function setInquiryContacted({ id, contacted }) {
  if (!id) return [400, { error: '필수 정보 누락' }];
  const { error } = await supabase.from('inquiries').update({ contacted: !!contacted }).eq('id', id);
  if (error) throw error;
  return [200, { success: true }];
}

async function listEvents({ subscriberId }) {
  if (!subscriberId) return [400, { error: '필수 정보 누락' }];
  const { data, error } = await supabase.from('subscription_events').select('*')
    .eq('subscriber_id', subscriberId)
    .order('occurred_at', { ascending: true }).order('id', { ascending: true });
  if (error) return [200, { events: null, missing: true }];
  return [200, { events: data }];
}

async function statsData() {
  const subs = await selectAll('subscribers', 'id,name,plan,status,created_at,cancelled_at,churn_reason', [['created_at', true]]);
  let events = [];
  try {
    events = await selectAll('subscription_events', '*', [['occurred_at', true], ['id', true]]);
  } catch (e) { /* 이력 표가 없으면 빈 칸 */ }
  return [200, { subscribers: subs, events }];
}

// 관리자 비밀번호 변경 (지금 비밀번호 확인 후). 바뀌면 다른 컴퓨터의 로그인은 모두 풀린다.
async function changePassword({ current, next }) {
  if (!(await checkPassword(supabase, current))) {
    await slow();
    return [400, { error: '지금 비밀번호가 맞지 않아요.' }];
  }
  if (String(next) === String(current)) return [400, { error: '지금과 다른 비밀번호로 해주세요.' }];
  const problem = await setPassword(supabase, next);
  if (problem) return [400, { error: problem }];
  return [200, { success: true, ...(await issueToken(supabase)) }];
}

// 고칠 수 있는 칸만 받는다
async function updateSubscriber({ id, fields }) {
  if (!id || !fields || typeof fields !== 'object') return [400, { error: '필수 정보 누락' }];
  const sub = await getSub(id);
  if (!sub) return [404, { error: '회원 없음' }];
  const patch = {};

  if ('churn_reason' in fields) {
    const r = fields.churn_reason == null ? null : String(fields.churn_reason).trim().slice(0, 200);
    patch.churn_reason = r || null;
  }
  if ('plan' in fields) {
    if (!PLAN_PRICES[fields.plan]) return [400, { error: '플랜 오류' }];
    patch.plan = fields.plan;
    // 새 플랜에서 못 고르는 옵션은 정리 (예: 베이직 운동복 → 스탠다드는 이미 포함)
    patch.addons = cleanAddons(fields.plan, sub.addons);
  }
  if ('addons' in fields) {
    patch.addons = cleanAddons(patch.plan || sub.plan, fields.addons);
  }
  if ('next_billing_date' in fields) {
    const d = String(fields.next_billing_date || '');
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d))) return [400, { error: '날짜 형식 오류' }];
    patch.next_billing_date = d;
  }
  if (fields.consent_msg_sent) {
    patch.consent_msg_sent_at = new Date().toISOString();
  }
  if (!Object.keys(patch).length) return [400, { error: '바꿀 내용이 없어요' }];

  const { error } = await supabase.from('subscribers').update(patch).eq('id', id);
  if (error) throw error;
  return [200, { success: true, subscriber: hide({ ...sub, ...patch }) }];
}

// 해지 / 복구(복구는 바로 한 달치 결제)
async function setStatus({ id, status, churn_reason }) {
  if (!id || !status) return [400, { error: '필수 정보 누락' }];
  const sub = await getSub(id);
  if (!sub) return [404, { error: '회원 없음' }];

  if (status === 'cancelled') {
    const reason = churn_reason == null ? null : String(churn_reason).trim().slice(0, 200) || null;
    const { error } = await supabase.from('subscribers')
      .update({ status: 'cancelled', churn_reason: reason, cancelled_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    return [200, { success: true }];
  }

  if (status === 'active') {
    const amount = monthlyAmount(sub.plan, sub.addons);
    if (!amount) return [400, { error: '플랜 오류' }];
    if (!sub.billing_key) return [400, { error: '등록된 카드가 없어요' }];

    const tossRes = await fetch(`https://api.tosspayments.com/v1/billing/${sub.billing_key}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customerKey: sub.customer_key,
        amount,
        orderId: `order-restore-${sub.id}-${Date.now()}`,
        orderName: orderName(sub.plan, sub.addons),
        customerEmail: sub.email,
        customerName: sub.name,
      }),
    });
    const tossData = await tossRes.json().catch(() => ({}));
    if (!tossRes.ok) return [400, { error: tossData.message || '결제 실패' }];

    const patch = {
      status: 'active',
      next_billing_date: kstDatePlusMonth(),
      churn_reason: null,
      cancelled_at: null,
    };
    // 첫 달 할인 손님을 정가로 바로 결제해 복구했다면, 정가 이용을 원한 것이므로
    // 다음 달에 '동의 없음'으로 다시 자동 종료되지 않게 한다.
    if (sub.promo && !sub.price_consent_at) patch.price_consent_at = new Date().toISOString();

    const { error } = await supabase.from('subscribers').update(patch).eq('id', id);
    if (error) return [500, { error: '결제는 됐는데 DB 업데이트 실패 — 직접 확인해주세요' }];
    return [200, { success: true, amount }];
  }

  return [400, { error: '잘못된 status' }];
}

const PUBLIC = { login, pulse };
const PRIVATE = {
  listSubscribers, inquiryCount, listInquiries, setInquiryContacted,
  listEvents, statsData, updateSubscriber, setStatus, changePassword,
};

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const params = req.body || {};
  const { action } = params;
  const authed = await verifyToken(supabase, bearer(req));
  const fn = PUBLIC[action] || PRIVATE[action];
  if (!fn) return res.status(400).json({ error: '알 수 없는 요청' });
  if (PRIVATE[action] && !authed) return res.status(401).json({ error: '로그인이 필요해요' });

  try {
    const [code, body] = await fn(params, authed);
    return res.status(code).json(body);
  } catch (e) {
    console.error(action, e);
    return res.status(500).json({ error: '서버 오류' });
  }
}
