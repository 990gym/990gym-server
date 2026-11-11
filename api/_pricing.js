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

// 토스 주문명 예: "990짐 베이직 월 구독 + 개인락커 + 운동복·수건"
export function orderName(plan, addons, label = '월 구독') {
  const extras = cleanAddons(plan, addons).map((a) => ADDONS[a].name);
  return [`990짐 ${plan} ${label}`, ...extras].join(' + ');
}
