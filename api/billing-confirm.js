import { createClient } from '@supabase/supabase-js';

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

  try {
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

    const { error: dbError } = await supabase.from('subscribers').insert({
      name,
      phone,
      email,
      plan,
      customer_key: customerKey,
      billing_key: billingKey,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    if (dbError) {
      return res.status(500).json({ error: 'DB 저장 실패' });
    }

    return res.status(200).json({ success: true, billingKey });
  } catch (err) {
    return res.status(500).json({ error: '서버 오류' });
  }
}
