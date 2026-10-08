// Shared role + capability MODEL. Role MEMBERSHIP lives in the DB (roles table);
// this file defines the fixed CATALOGUES (capabilities + pages) and pure helpers.
// Keep the capability/page keys in sync with web/src/lib/roles.ts.

export type Role = string;        // role key stored in admins.role (owner | scheduler | driver | custom…)
export const OWNER = "owner";     // immutable superuser — always full access, never lockable

// Action capabilities a role can be granted (the "what can it do" catalogue).
export const CAP_KEYS = ["editData", "viewFinance", "factoryRates", "assignDrivers", "deleteWorkers", "viewWorkers", "svodni", "svodniSensitive", "costInvoices", "invoiceScan", "fuel", "hostelOps", "cleaning", "workerDocs", "legalization", "tasksGroup", "tasksManage", "workerPay", "blacklist", "workerLifecycle", "advances"] as const;
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
  workerDocs: "Документи й підписання (паспортні дані, анкети, умови працівників)",
  legalization: "Легалізація (документи зі строками й номерами, справи, правила легальності)",
  tasksGroup: "Групові задачі та зустрічі (скликати зустрічі, ставити задачі кільком)",
  tasksManage: "Керувати задачами (перепризначати чужі, автоправила, контроль)",
  workerPay: "Зарплата працівника в профілі — лише перегляд (години, ставка нетто, премії, потрачення, до виплати; без konto/готівки)",
  blacklist: "Чорний список — вносити людей з причиною і прибирати з нього",
  workerLifecycle: "Запрошувати й звільняти працівників (лінк у бот, звільнення, виповідзення, повернення) — без решти редагування",
  advances: "Залічки (вносити, переносити між групами виплат, передавати до виплати) — без сводних і бадань",
};

// Режим ролі «лише перегляд» (08.10.2026, роль для власника-спостерігача фінансів).
// Живе в roles.caps як прапорець, але НЕ capability: у CAP_KEYS його нема, тож owner
// (отримує всі CAP_KEYS) ніколи не стає read-only, а hasCap/can() його не бачать.
// Гард — authRequired (lib/auth.ts): будь-яка мутація такої ролі → 403, крім білого списку.
export const READ_ONLY = "readOnly";
export const READ_ONLY_LABEL = "🔒 Лише перегляд — жодних змін (обрані сторінки й дії — тільки для читання; у боті без офісного меню)";
export function isReadOnly(role: Role | null | undefined, caps: string[] | null | undefined): boolean {
  return role !== OWNER && !!caps?.includes(READ_ONLY);
}
// Мутації, дозволені read-only ролі: особисті налаштування/позначки «прочитано» і
// «читальні» POST (АІ-аналіз CFO лише формує висновок, даних не змінює).
export const READ_ONLY_ALLOWED_PATHS = [
  "/auth/web-lang", "/auth/web-prefs", "/notifications/read", "/cost-invoices/new/ack", "/cfo/analyze",
] as const;

// Nav/route paths a role can be granted access to (the "what can it see" catalogue).
export const PAGE_KEYS = [
  "/", "/schedule", "/driver-shifts", "/orders", "/availability", "/reliability",
  "/hours", "/absences", "/advances", "/trips", "/mileage", "/reports", "/finance", "/bank", "/cash", "/cashflow", "/cfo", "/analytics", "/balance", "/obligations", "/cost-invoices", "/pnl", "/payroll", "/svodni", "/hostels", "/penalties", "/fuel", "/cleaning", "/settings",
  "/workers", "/recruitment", "/broadcast", "/sms-campaigns", "/drivers", "/fleet", "/transport", "/clothing", "/factories", "/admins",
  "/sushi", "/andros", "/contracts", "/document-templates", "/legalization", "/tasks", "/workers-calendar",
] as const;

// owner is always allowed; otherwise check the resolved capability set.
export function hasCap(role: Role | null | undefined, caps: string[] | null | undefined, cap: Capability): boolean {
  if (role === OWNER) return true;
  return !!caps && caps.includes(cap);
}

// Bot notification types a role can be subscribed to — independent of caps
// (a role may see a bot button via editData but not want every ping about it).
// Unlike caps, owner is NOT auto-included: it's a plain per-role list, same as
// everyone else (see plan "Гранулярний вибір типів сповіщень для кожної ролі").
export const NOTIFY_KEYS = [
  "no_show", "cancellation", "hours_correction", "advance", "substitution", "availability_change",
  "absence_warning", "weekly_summary", "finance_alerts", "tasks", "sms",
] as const;
export type NotifyType = (typeof NOTIFY_KEYS)[number];
export const NOTIFY_LABEL: Record<NotifyType, string> = {
  no_show: "🔴 Невихід на зміну",
  cancellation: "❌ Скасування зміни",
  hours_correction: "⚠️ Помилка в годинах фабрики",
  advance: "💰 Запит на аванс",
  substitution: "🔁 Заміна на зміні (графік)",
  availability_change: "📋 Зміна доступності працівника",
  absence_warning: "🟡 Повторні пропуски (попередження)",
  weekly_summary: "🤖 Тижневий звіт розсилки нагадувань",
  finance_alerts: "💳 Фінансові алерти (банк / KSeF / komornik)",
  tasks: "📋 Задачі (призначено мені, нагадування, дайджест, зустрічі)",
  sms: "📨 SMS-кампанії (денний звіт хвилі, завершення кампанії)",
};
