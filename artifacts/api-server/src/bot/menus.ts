import { Markup } from "telegraf";
import { t, tb, type Lang } from "./i18n";

export const adminMenu = (lang: Lang = "uk") => Markup.keyboard([
  [tb(lang, "📋 Замовлення фабрик"), tb(lang, "📊 Читати таблицю")],
  [tb(lang, "🗓 Генерувати графік"), tb(lang, "✅ Перегляд графіків")],
  [tb(lang, "📥 Імпорт графіку (Excel)"), tb(lang, "👥 Управління")],
  [tb(lang, "📢 Розсилки")],
  [tb(lang, "🌐 Мова / Language")],
]).resize();


export const workerMenu = (lang: Lang = "uk") => Markup.keyboard([
  [t(lang, "menu.schedule")],
  [t(lang, "menu.availability")],
  [t(lang, "menu.factoryInfo"), t(lang, "menu.myHours")],
  [t(lang, "menu.absence"), t(lang, "menu.myInfo")],
  [t(lang, "menu.referral"), t(lang, "menu.report")],
  [t(lang, "menu.language")],
]).resize();

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
