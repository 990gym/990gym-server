import { createClient } from '@supabase/supabase-js';
import { monthlyAmount } from './_pricing.js';
import { cors } from './_auth.js';

// 마이페이지: 이름 + 연락처로 내 구독 조회. 화면에 필요한 칸만 돌려준다.
// POST { name, phone }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const name = String((req.body || {}).name || '').trim();
  const digits = String((req.body || {}).phone || '').replace(/\D/g, '');
  if (!name || digits.length < 9 || digits.length > 11) return res.status(400).json({ error: '이름과 연락처를 확인해주세요.' });
  const dashed = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');

  const { data, error } = await supabase
    .from('subscribers')
    .select('name, plan, status, next_billing_date, created_at, addons')
    .eq('name', name)
    .in('phone', [digits, dashed])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: '서버 오류' });
  if (!data.length) {
    await new Promise((r) => setTimeout(r, 500));
    return res.status(404).json({ error: '구독 정보를 찾을 수 없어요.' });
  }

  const s = data[0];
  return res.status(200).json({
    subscriber: {
      name: s.name,
      plan: s.plan,
      status: s.status,
      next_billing_date: s.next_billing_date,
      created_at: s.created_at,
      amount: monthlyAmount(s.plan, s.addons),
    },
  });
}
