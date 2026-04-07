import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLAN_PRICES = { '베이직': 39000, '스탠다드': 69000, '프리미엄': 99000 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, status } = req.body;
  if (!id || !status) return res.status(400).json({ error: '필수 정보 누락' });

  // 해지
  if (status === 'cancelled') {
    const { error } = await supabase
      .from('subscribers')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (error) return res.status(500).json({ error: '업데이트 실패' });
    return res.status(200).json({ success: true });
  }

  // 복구 - 즉시 결제 후 활성화
  if (status === 'active') {
    const { data: sub, error: fetchError } = await supabase
      .from('subscribers')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !sub) return res.status(404).json({ error: '회원 없음' });

    const amount = PLAN_PRICES[sub.plan];
    if (!amount) return res.status(400).json({ error: '플랜 오류' });

    // 즉시 결제
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
        orderName: `990짐 ${sub.plan} 월 구독`,
        customerEmail: sub.email,
        customerName: sub.name,
      }),
    });

    const tossData = await tossRes.json();
    if (!tossRes.ok) return res.status(400).json({ error: tossData.message || '결제 실패' });

    // 다음 결제일 오늘 기준 한달 후
    const nextDate = new Date();
    nextDate.setMonth(nextDate.getMonth() + 1);
    const nextBillingDate = nextDate.toISOString().split('T')[0];

    const { error: updateError } = await supabase
      .from('subscribers')
      .update({ status: 'active', next_billing_date: nextBillingDate })
      .eq('id', id);

    if (updateError) return res.status(500).json({ error: 'DB 업데이트 실패' });
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: '잘못된 status' });
}
