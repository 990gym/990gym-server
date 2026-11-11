import { createClient } from '@supabase/supabase-js';
import { PLAN_PRICES, PROMOS, consentWindowOpen } from './_pricing.js';

// 첫 달 할인 손님의 '다음 달부터 정가 결제' 동의
//   GET  ?t=<consent_token>  → 안내에 필요한 정보
//   POST { t }               → 동의 기록 (price_consent_at)
// 손님에게는 https://the990.co.kr/continue.html?t=<consent_token> 링크로 안내한다.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function view(sub) {
  const promo = PROMOS[sub.promo];
  const price = PLAN_PRICES[sub.plan];
  return {
    name: sub.name,
    plan: sub.plan,
    promoLabel: promo ? promo.label : null,
    firstAmount: promo ? promo.firstAmount : null,
    price,
    nextBillingDate: sub.next_billing_date,
    status: sub.status,
    consented: !!sub.price_consent_at,
    consentedAt: sub.price_consent_at,
    canConsent: !!promo && sub.status === 'active' && !sub.price_consent_at && consentWindowOpen(sub.next_billing_date),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://the990.co.kr');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const t = req.method === 'GET' ? req.query.t : (req.body || {}).t;
  if (!t || !UUID_RE.test(String(t))) return res.status(400).json({ error: '링크가 올바르지 않습니다.' });

  const { data: sub, error } = await supabase
    .from('subscribers')
    .select('id, name, plan, promo, status, next_billing_date, price_consent_at')
    .eq('consent_token', t)
    .maybeSingle();
  if (error) return res.status(500).json({ error: '서버 오류' });
  if (!sub || !sub.promo) return res.status(404).json({ error: '안내 대상이 아니에요. 센터로 문의해주세요.' });

  if (req.method === 'GET') return res.status(200).json(view(sub));
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const v = view(sub);
  if (v.consented) return res.status(200).json({ success: true, ...v });
  if (sub.status !== 'active') return res.status(400).json({ error: '이미 종료된 구독이에요. 센터로 문의해주세요.' });
  if (!v.canConsent) return res.status(400).json({ error: '아직 안내 기간이 아니에요. 결제일 2주 전부터 가능해요.' });

  const now = new Date().toISOString();
  const { error: upError } = await supabase
    .from('subscribers')
    .update({ price_consent_at: now })
    .eq('id', sub.id)
    .is('price_consent_at', null);
  if (upError) return res.status(500).json({ error: '저장에 실패했어요. 다시 시도해주세요.' });

  return res.status(200).json({ success: true, ...view({ ...sub, price_consent_at: now }) });
}
