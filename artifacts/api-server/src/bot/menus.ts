import { Markup } from "telegraf";
import { t, tb, type Lang } from "./i18n";

export const adminMenu = (lang: Lang = "uk") => Markup.keyboard([
  // Test-only surface: the Mini App button in the OFFICE menu is opt-in via WEB_APP_ADMIN=1
  // (prod keeps it head-driver-only per owner's decision).
  ...(process.env.WEB_APP_ADMIN === "1" && webAppUrl() ? [[Markup.button.webApp(tb(lang, "🖥 Панель призначень"), `${webAppUrl()}/driver-shifts?tgapp=1`)]] : []),
  [tb(lang, "📋 Замовлення фабрик"), tb(lang, "🗓 Генерувати графік")],
  [tb(lang, "✅ Перегляд графіків")],
  [tb(lang, "📥 Імпорт графіку (Excel)"), tb(lang, "👥 Управління")],
  [tb(lang, "📢 Розсилки")],
  [tb(lang, "🌐 Мова / Language")],
]).resize();


// Worker menu rows are trimmed by the factory's settings: hide "Submit availability"
// when the factory doesn't collect it, and "My hours" when it's switched off.
export type WorkerMenuOpts = { availability?: boolean; hours?: boolean };
export const workerMenu = (lang: Lang = "uk", opts: WorkerMenuOpts = {}) => {
  const { availability = true, hours = true } = opts;
  const rows: string[][] = [[t(lang, "menu.schedule")]];
  if (availability) rows.push([t(lang, "menu.availability")]);
  rows.push(hours ? [t(lang, "menu.factoryInfo"), t(lang, "menu.myHours")] : [t(lang, "menu.factoryInfo")]);
  rows.push([t(lang, "menu.absence"), t(lang, "menu.myInfo")]);
  rows.push([t(lang, "menu.referral"), t(lang, "menu.report")]);
  rows.push([t(lang, "menu.advance"), t(lang, "menu.language")]);
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

export const managementMenu = (lang: Lang = "uk") => Markup.keyboard([
  [tb(lang, "➕ Додати працівника"), tb(lang, "📋 Список працівників")],
  [tb(lang, "📥 Імпорт працівників"), tb(lang, "🔗 Прив'язати Telegram")],
  [tb(lang, "🚗 Водії"), tb(lang, "🏭 Фабрики")],
  [tb(lang, "🔥 Звільнити працівника"), tb(lang, "👑 Адміни")],
  [tb(lang, "☁️ Google Drive"), tb(lang, "⬅️ Назад")],
]).resize();
