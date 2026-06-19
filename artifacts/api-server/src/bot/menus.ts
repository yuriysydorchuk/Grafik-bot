import { Markup } from "telegraf";
import { t, tb, type Lang } from "./i18n";

export const adminMenu = (lang: Lang = "uk") => Markup.keyboard([
  [tb(lang, "📋 Замовлення фабрик"), tb(lang, "📊 Читати таблицю")],
  [tb(lang, "🗓 Генерувати графік"), tb(lang, "✅ Перегляд графіків")],
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
  rows.push([t(lang, "menu.language")]);
  return Markup.keyboard(rows).resize();
};

export const headDriverMenu = (lang: Lang = "uk") => Markup.keyboard([
  [tb(lang, "📋 Призначити водіїв"), tb(lang, "📅 Графік тижня")],
  [tb(lang, "👥 Мій список водіїв")],
  [tb(lang, "📍 Моя зміна сьогодні"), tb(lang, "📅 Мій графік")],
  [tb(lang, "✅ Посадка / явка")],
  [tb(lang, "🏭 Прибув на фабрику")],
  [tb(lang, "🌐 Мова / Language")],
]).resize();

export const driverMenu = (lang: Lang = "uk") => Markup.keyboard([
  [tb(lang, "📍 Моя зміна сьогодні"), tb(lang, "📅 Мій графік")],
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
