import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, status } = req.body;
  if (!id || !status) return res.status(400).json({ error: '필수 정보 누락' });

  const { error } = await supabase
    .from('subscribers')
    .update({ status })
    .eq('id', id);

  if (error) return res.status(500).json({ error: '업데이트 실패' });
  return res.status(200).json({ success: true });
}
