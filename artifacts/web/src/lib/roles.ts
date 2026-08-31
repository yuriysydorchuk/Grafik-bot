// Role + capability CATALOGUES (mirror of api-server/src/lib/roles.ts). Role MEMBERSHIP
// comes from the API per-user (me.caps / me.pages); this file only holds the fixed
// capability/page keys + labels and the pure access helpers. Keep keys in sync with the backend.
export type Role = string;
export const OWNER = "owner";

// Action capabilities a role can be granted.
export const CAP_KEYS = ["editData", "viewFinance", "factoryRates", "assignDrivers", "deleteWorkers", "viewWorkers", "svodni", "svodniSensitive", "costInvoices", "invoiceScan", "fuel", "hostelOps", "cleaning"] as const;
export type Capability = (typeof CAP_KEYS)[number];
export const CAP_LABEL: Record<Capability, string> = {
  editData: "Редагувати дані (графіки, замовлення, фабрики, працівники)",
  viewFinance: "Фінанси (ставки, рахунки)",
  factoryRates: "Ставки фабрик (оплата працівникам і ставка клієнту; без NIP/P&L)",
  assignDrivers: "Водійські дії (борд, призначення, посадка)",
  deleteWorkers: "Видаляти працівників назавжди",
  viewWorkers: "Переглядати працівників (лише перегляд, без editData — без редагування)",
  svodni: "Сводні (офіційна частина: фактичні години, ставки, до виплати)",
  svodniSensitive: "Сводні — закритий шар (księgowość, готівка)",
  costInvoices: "Фактури коштові (внесення і оплати — для бухгалтерії)",
  invoiceScan: "Сканування фактур у боті (кнопка «📄 Фактура»)",
  fuel: "Пальне (фактури Orlen, аналітика по містах/водіях/авто)",
  hostelOps: "Хостели — операційне ведення (кімнати, проживання, платежі мешканців)",
  cleaning: "Прибирання — окремий бізнес (вспульноти: дохід, винагродження, видатки, P&L)",
};

// Pages a role can be granted access to (nav + route guards).
export const PAGE_LABEL: Record<string, string> = {
  "/": "Огляд", "/schedule": "Графік", "/driver-shifts": "Зміни водіїв",
  "/orders": "Замовлення", "/availability": "Доступність", "/reliability": "Надійність",
  "/hours": "Облік годин", "/absences": "Відсутності", "/advances": "Аванси", "/trips": "Поїздки",
  "/mileage": "Звіт по пробігу",
  "/reports": "Звіти", "/finance": "Фінанси", "/bank": "Витяги", "/cash": "Каса", "/cashflow": "Кешфлоу", "/cfo": "CFO", "/analytics": "Аналітика", "/balance": "Баланс", "/obligations": "Належності", "/cost-invoices": "Фактури", "/pnl": "P&L", "/payroll": "Зарплати", "/svodni": "Сводні", "/hostels": "Хостели", "/penalties": "Штрафи", "/fuel": "Пальне", "/cleaning": "Прибирання", "/settings": "Налаштування",
  "/workers": "Працівники", "/recruitment": "Рекрутинг", "/broadcast": "Розсилка",
  "/drivers": "Водії", "/fleet": "Автопарк", "/transport": "Транспорт", "/clothing": "Одяг", "/factories": "Фабрики", "/admins": "Адміни",
  "/sushi": "Суші (проєкт)", "/andros": "Андрос (проєкт)",
};
export const PAGE_KEYS = Object.keys(PAGE_LABEL);

// The resolved access carried on the current user (from /auth/me).
export type Access = { role?: string | null; isMain?: boolean; caps?: string[]; pages?: string[] } | null | undefined;

// owner is the immutable superuser → always allowed.
export function can(me: Access, cap: Capability): boolean {
  if (!me) return false;
  if (me.role === OWNER) return true;
  return !!me.caps?.includes(cap);
}
export function canAccessPage(me: Access, path: string): boolean {
  if (!me) return false;
  if (path === "/admins" || path === "/security") return !!me.isMain; // user/role mgmt + sessions — head admin only
  if (me.role === OWNER) return true;
  return !!me.pages?.includes(path);
}
