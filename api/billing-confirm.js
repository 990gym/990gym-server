import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLAN_PRICES = {
  '베이직': 39000,
  '스탠다드': 69000,
  '프리미엄': 99000,
};

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
    const amount = PLAN_PRICES[plan] || 39000;
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
        orderName: `990짐 ${plan} 구독`,
        customerEmail: email,
        customerName: name,
      }),
    });

    const chargeData = await chargeRes.json();
    if (!chargeRes.ok) {
      return res.status(400).json({ error: chargeData.message || '첫 결제 실패' });
    }

    // 3. DB 저장
    const { error: dbError } = await supabase.from('subscribers').insert({
      name,
      phone,
      email,
      plan,
      customer_key: customerKey,
      billing_key: billingKey,
      status: 'active',
      created_at: new Date().toISOString(),
      next_billing_date: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString().split('T')[0],
    });

    if (dbError) {
      return res.status(500).json({ error: 'DB 저장 실패' });
    }

    return res.status(200).json({ success: true, billingKey });
  } catch (err) {
    return res.status(500).json({ error: '서버 오류' });
  }
}
