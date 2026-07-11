// Expense category labels — shared by Витяги (/bank) and Каса (/cash).
// Keys mirror EXPENSE_CATS in api-server/src/services/bankClassify.ts.
export const CAT_LABELS: Record<string, string> = {
  zus: "ZUS", vat: "Податки (VAT, US)", seizure: "Зайняття (komornik)", salary: "Зарплати", zaliczki: "Аванси (zaliczki)",
  fees: "Комісії банку (перекази, вплати, зняття)", fuel: "Паливо", housing: "Житло / готелі",
  car_repair: "Ремонт авто", office_rent: "Оренда офісу", clothing: "Одяг", multisport: "Мультиспорт (Benefit)",
  trainer: "Тренер (Palusiński)", leasing: "Лізинг / авто",
  credit: "Кредит", services: "Послуги (бух., юристи)", marketing: "Маркетинг", permits: "Дозволи / уряд",
  b2b: "Підрядники B2B", taxi: "Таксі (Bolt, Uber)", travel: "Подорожі / відрядження", shops: "Магазини (продукти)",
  tech: "Техніка / електроніка", household: "Госптовари / буд", card: "Інші карткові", other: "Інше",
};

// options for manual re-categorization: all expense categories + owners' personal
export const RECAT_OPTIONS: { value: string; label: string }[] = [
  ...Object.entries(CAT_LABELS).map(([value, label]) => ({ value, label })),
  { value: "owner_roman", label: "Особисте — Сидорчук Роман" },
  { value: "owner_tetiana", label: "Особисте — Сидорчук Тетяна" },
  { value: "owner_yuriy", label: "Особисте — Сидорчук Юрій" },
];
export const recatLabel = (key: string) => RECAT_OPTIONS.find(o => o.value === key)?.label ?? key;

// cash-only pseudo-categories (internal moves, excluded from expenses)
export const CASH_ONLY_LABELS: Record<string, string> = {
  deposit: "Вплата на рахунок",
  transfer: "Переміщення",
};
export const cashCatLabel = (key: string) => CASH_ONLY_LABELS[key] ?? recatLabel(key);
