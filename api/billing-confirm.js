import { createClient } from '@supabase/supabase-js';
import { cleanAddons, monthlyAmount, orderName, getPromo } from './_pricing.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://the990.co.kr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { authKey, customerKey, name, phone, email, plan } = req.body;

  if (!authKey || !customerKey || !name || !phone || !email || !plan) {
    return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
  }

  // 금액은 서버가 정한다 (플랜 + 그 플랜에 허용된 애드온만, 프로모션이면 첫 달 할인가)
  const promoKey = req.body.promo && getPromo(plan, req.body.promo) ? req.body.promo : null;
  const promo = promoKey ? getPromo(plan, promoKey) : null;
  const addons = promo ? [] : cleanAddons(plan, req.body.addons);
  const amount = promo ? promo.firstAmount : monthlyAmount(plan, addons);
  if (!amount) {
    return res.status(400).json({ error: '플랜 정보가 올바르지 않습니다.' });
  }

  // 첫 달 할인은 처음 구독하는 분만 (예전에 구독한 적 있는 번호는 불가)
  if (promo) {
    const digits = String(phone).replace(/\D/g, '');
    const dashed = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    const { data: prev, error: prevError } = await supabase
      .from('subscribers')
      .select('id')
      .in('phone', [phone, digits, dashed])
      .limit(1);
    if (prevError) return res.status(500).json({ error: '서버 오류' });
    if (prev && prev.length) {
      return res.status(400).json({ error: '첫 달 할인은 처음 구독하시는 분만 받을 수 있어요. 센터(02-371-2684)로 문의해주세요.' });
    }
  }

  try {
    // 1. 빌링키 발급
    const tossRes = await fetch('https://api.tosspayments.com/v1/billing/authorizations/issue', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ authKey, customerKey }),
    });

    const tossData = await tossRes.json();
    if (!tossRes.ok) {
      return res.status(400).json({ error: tossData.message || '빌링키 발급 실패' });
    }

    const billingKey = tossData.billingKey;

    // 2. 첫 결제 청구
    const orderId = 'order-' + Date.now();

    const chargeRes = await fetch(`https://api.tosspayments.com/v1/billing/${billingKey}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customerKey,
        amount,
        orderId,
        orderName: promo ? `990짐 ${promo.label}` : orderName(plan, addons, '구독'),
        customerEmail: email,
        customerName: name,
      }),
    });

    const chargeData = await chargeRes.json();
    if (!chargeRes.ok) {
      return res.status(400).json({ error: chargeData.message || '첫 결제 실패' });
    }

    // 3. DB 저장
    const { error: dbError } = await supabase.from('subscribers').upsert({
      name,
      phone,
      email,
      plan,
      addons,
      promo: promoKey,
      price_consent_at: null,
      customer_key: customerKey,
      billing_key: billingKey,
      status: 'active',
      created_at: new Date().toISOString(),
      next_billing_date: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString().split('T')[0],
    }, { onConflict: 'name,phone' });

    if (dbError) {
      return res.status(500).json({ error: 'DB 저장 실패' });
    }

    return res.status(200).json({ success: true, billingKey, amount, addons, promo: promoKey });
  } catch (err) {
    return res.status(500).json({ error: '서버 오류' });
  }
}
