// 990짐 월구독 가격표 (플랜 + 애드온)
// (파일 이름이 _ 로 시작하면 Vercel이 API 주소로 공개하지 않음 — 다른 API들이 불러 쓰는 공용 파일)
// 서버의 모든 결제(첫 결제 · 월 자동결제 · 복구 결제)가 이 파일 하나로 금액을 계산한다.

export const PLAN_PRICES = {
  '베이직': 39000,
  '스탠다드': 69000,
  '프리미엄': 99000,
};

export const ADDONS = {
  locker: { name: '개인락커', price: 10000 },
  wear: { name: '운동복·수건', price: 10000 },
};

// 플랜별로 고를 수 있는 애드온 (스탠다드·프리미엄은 운동복·수건이 이미 포함)
export const PLAN_ADDONS = {
  '베이직': ['locker', 'wear'],
  '스탠다드': ['locker'],
  '프리미엄': ['locker'],
};

// 들어온 애드온 값을 정리: 배열/쉼표 문자열 모두 받고, 그 플랜에 허용된 것만 남긴다.
export function cleanAddons(plan, addons) {
  const allowed = PLAN_ADDONS[plan] || [];
  let list = [];
  if (Array.isArray(addons)) list = addons;
  else if (typeof addons === 'string') list = addons.split(',');
  return [...new Set(list.map((a) => String(a).trim()))].filter((a) => allowed.includes(a));
}

// 한 달 결제 금액. 플랜이 잘못됐으면 null.
export function monthlyAmount(plan, addons) {
  const base = PLAN_PRICES[plan];
  if (!base) return null;
  return cleanAddons(plan, addons).reduce((sum, a) => sum + ADDONS[a].price, base);
}

// 첫 달 할인 프로모션 (처음 구독하는 사람만)
// 둘째 달부터 정가로 오르는 건 전자상거래법상 '대금 증액'이라,
// 결제일 전 30일 안에 손님이 동의 링크(continue.html)에서 직접 동의해야만 정가 결제가 된다.
// 동의가 없으면 결제일에 결제 없이 자동 종료된다 (billing-charge.js).
export const PROMOS = {
  spinning_half: { plan: '프리미엄', firstAmount: 49500, label: '프리미엄 스피닝 첫 달 50%' },
};

export function getPromo(plan, promo) {
  const p = PROMOS[promo];
  return p && p.plan === plan ? p : null;
}

// 동의 받는 기간: 결제일 10일 전 ~ 결제일 당일 (손님에겐 "결제일 1주 전까지 문자 안내")
// (법: 증액 전 30일 이내에 동의. 가입 직후와 확실히 떨어뜨리려고 10일 전부터 연다)
export const CONSENT_OPEN_DAYS = 10;
export function consentWindowOpen(nextBillingDate, now = new Date()) {
  if (!nextBillingDate) return false;
  const due = new Date(`${String(nextBillingDate).slice(0, 10)}T00:00:00+09:00`);
  const opens = new Date(due.getTime() - CONSENT_OPEN_DAYS * 24 * 60 * 60 * 1000);
  return now >= opens && now < new Date(due.getTime() + 24 * 60 * 60 * 1000);
}

// 토스 주문명 예: "990짐 베이직 월 구독 + 개인락커 + 운동복·수건"
export function orderName(plan, addons, label = '월 구독') {
  const extras = cleanAddons(plan, addons).map((a) => ADDONS[a].name);
  return [`990짐 ${plan} ${label}`, ...extras].join(' + ');
}
