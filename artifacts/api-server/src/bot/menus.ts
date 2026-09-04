import { Markup } from "telegraf";
import { t, tb, type Lang } from "./i18n";

// Пункти меню фільтруються за capability адміна (opts.* — див. adminMenuFor у
// ./roles, єдине джерело правди, звідки ці прапорці рахуються). Дефолт кожного
// opts — true: рендери меню всередині флоу, які не проходять через adminMenuFor
// (напр. сирий adminMenu() у стані генерації графіку), лишаються з повним меню —
// вони вже за гейтованим флоу, capability там перевірена на вході.
export type AdminMenuOpts = { invoice?: boolean; orders?: boolean; orderView?: boolean; broadcast?: boolean; management?: boolean };
export const adminMenu = (lang: Lang = "uk", opts: AdminMenuOpts = {}) => {
  const { invoice = true, orders = true, orderView = true, broadcast = true, management = true } = opts;
  const rows: any[][] = [];
  if (process.env.WEB_APP_ADMIN === "1" && webAppUrl()) {
    // Test-only surface: the Mini App button in the OFFICE menu is opt-in via WEB_APP_ADMIN=1
    // (prod keeps it head-driver-only per owner's decision).
    rows.push([Markup.button.webApp(tb(lang, "🖥 Панель призначень"), `${webAppUrl()}/driver-shifts?tgapp=1`)]);
  }
  if (orders) rows.push([tb(lang, "📋 Замовлення фабрик"), tb(lang, "🗓 Генерувати графік")]);
  if (orderView) rows.push([tb(lang, "✅ Перегляд графіків")]);
  const bottomRow: string[] = [];
  if (orders) bottomRow.push(tb(lang, "📥 Імпорт графіку (Excel)"));
  if (management) bottomRow.push(tb(lang, "👥 Управління"));
  if (bottomRow.length) rows.push(bottomRow);
  const actionRow: string[] = [];
  if (broadcast) actionRow.push(tb(lang, "📢 Розсилки"));
  if (invoice) actionRow.push(tb(lang, "📄 Фактура"));
  if (actionRow.length) rows.push(actionRow);
  rows.push([tb(lang, "🌐 Мова / Language")]);
  return Markup.keyboard(rows).resize();
};


// Worker menu rows are trimmed by the factory's settings: hide "Submit availability"
// when the factory doesn't collect it, and "My hours" when it's switched off.
export type WorkerMenuOpts = { availability?: boolean; hours?: boolean };
export const workerMenu = (lang: Lang = "uk", opts: WorkerMenuOpts = {}) => {
  const { availability = true, hours = true } = opts;
  const rows: string[][] = [[t(lang, "menu.schedule")]];
  if (availability) rows.push([t(lang, "menu.availability")]);
  rows.push(hours ? [t(lang, "menu.factoryInfo"), t(lang, "menu.myHours")] : [t(lang, "menu.factoryInfo")]);
  rows.push([t(lang, "menu.absence"), t(lang, "menu.myAbsences")]);
  rows.push([t(lang, "menu.myInfo"), t(lang, "menu.referral")]);
  rows.push([t(lang, "menu.report"), t(lang, "menu.advance")]);
  rows.push([t(lang, "menu.language")]);
  return Markup.keyboard(rows).resize();
};

// Mini App button: opens the admin panel inside Telegram (auto-login via initData).
// Telegram rejects non-HTTPS web_app URLs, so the row appears only with a proper env.
const webAppUrl = () => {
  const base = process.env.WEB_APP_URL ?? "";
  return base.startsWith("https://") ? base.replace(/\/$/, "") : null;
};

// `onShift` swaps the workday button: start it when the driver leaves the base,
// finish it when they return (both ask for an odometer reading).
export const headDriverMenu = (lang: Lang = "uk", onShift = false) => Markup.keyboard([
  [tb(lang, "📋 Призначити водіїв"), tb(lang, "📅 Графік тижня")],
  ...(webAppUrl() ? [[Markup.button.webApp(tb(lang, "🖥 Панель призначень"), `${webAppUrl()}/driver-shifts?tgapp=1`)]] : []),
  [tb(lang, "👥 Мій список водіїв"), tb(lang, "🚙 Авто")],
  [tb(lang, "📍 Моя зміна сьогодні"), tb(lang, "📅 Мій графік")],
  [onShift ? tb(lang, "🏁 Закінчити зміну") : tb(lang, "🚗 Почати зміну")],
  [tb(lang, "✅ Посадка / явка")],
  [tb(lang, "🏭 Прибув на фабрику")],
  [tb(lang, "🌐 Мова / Language")],
]).resize();

export const driverMenu = (lang: Lang = "uk", onShift = false) => Markup.keyboard([
  [tb(lang, "📍 Моя зміна сьогодні"), tb(lang, "📅 Мій графік")],
  [onShift ? tb(lang, "🏁 Закінчити зміну") : tb(lang, "🚗 Почати зміну")],
  [tb(lang, "✅ Посадка / явка")],
  [tb(lang, "🏭 Прибув на фабрику")],
  [tb(lang, "🌐 Мова / Language")],
]).resize();

// Кнопки підменю фільтруються за capability (opts.* рахує managementMenuFor у
// ./roles). Дефолт кожного opts — true, з тих самих причин, що й у adminMenu.
export type ManagementMenuOpts = { editData?: boolean; viewWorkers?: boolean; assignDrivers?: boolean; deleteWorkers?: boolean };
export const managementMenu = (lang: Lang = "uk", opts: ManagementMenuOpts = {}) => {
  const { editData = true, viewWorkers = true, assignDrivers = true, deleteWorkers = true } = opts;
  const rows: any[][] = [];
  const row1: string[] = [];
  if (editData) row1.push(tb(lang, "➕ Додати працівника"));
  if (viewWorkers) row1.push(tb(lang, "📋 Список працівників"));
  if (row1.length) rows.push(row1);
  const row2: string[] = [];
  if (editData) row2.push(tb(lang, "📥 Імпорт працівників"), tb(lang, "🔗 Прив'язати Telegram"));
  if (row2.length) rows.push(row2);
  const row3: string[] = [];
  if (assignDrivers) row3.push(tb(lang, "🚗 Водії"));
  if (editData) row3.push(tb(lang, "🏭 Фабрики"));
  if (row3.length) rows.push(row3);
  const row4: string[] = [];
  if (deleteWorkers) row4.push(tb(lang, "🔥 Звільнити працівника"));
  row4.push(tb(lang, "👑 Адміни")); // завжди — внутрішньо гейтиться isMainAdmin
  rows.push(row4);
  const row5: string[] = [];
  if (editData) row5.push(tb(lang, "☁️ Google Drive"));
  row5.push(tb(lang, "⬅️ Назад"));
  rows.push(row5);
  return Markup.keyboard(rows).resize();
};
