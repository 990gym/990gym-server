import { createClient } from '@supabase/supabase-js';
import { monthlyAmount, orderName } from './_pricing.js';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: subscribers, error } = await supabase
      .from('subscribers')
      .select('*')
      .eq('status', 'active')
      .eq('next_billing_date', today);
    if (error) throw error;
    const results = [];
    for (const sub of subscribers) {
      // 플랜 + 애드온 (플랜이 바뀌어 안 맞는 애드온은 자동으로 빠짐)
      const amount = monthlyAmount(sub.plan, sub.addons);
      if (!amount) continue;
      try {
        const tossRes = await fetch('https://api.tosspayments.com/v1/billing/' + sub.billing_key, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            customerKey: sub.customer_key,
            amount,
            orderId: `order-${sub.id}-${Date.now()}`,
            orderName: orderName(sub.plan, sub.addons),
            customerEmail: sub.email,
            customerName: sub.name,
          }),
        });
        const tossData = await tossRes.json();
        if (tossRes.ok) {
          // 다음 결제일 한 달 후로 업데이트
          const nextDate = new Date(today);
          nextDate.setMonth(nextDate.getMonth() + 1);
          await supabase.from('subscribers').update({
            next_billing_date: nextDate.toISOString().split('T')[0]
          }).eq('id', sub.id);
          results.push({ id: sub.id, success: true });
        } else {
          await supabase.from('subscribers').update({ status: 'payment_failed' }).eq('id', sub.id);
          results.push({ id: sub.id, success: false, error: tossData.message });
        }
      } catch (e) {
        results.push({ id: sub.id, success: false, error: e.message });
      }
    }
    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: '서버 오류' });
  }
}
