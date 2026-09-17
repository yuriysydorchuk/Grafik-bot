// Рекрутинг-кампанія «приведи друга» (17.09.2026): персональна розсилка в бот усім
// працівникам (активним і звільненим — вони теж запрошують) їхньою мовою з власним
// реферальним кодом. Два повідомлення на людину: (1) пояснення умов працівнику,
// (2) готовий текст для пересилання другові з inline-кнопкою на deep-link
// ?start=ref<код> (кнопки-URL зберігаються при пересиланні в Telegram).
// Тексти — bot/i18n.ts camp.*; суми/телефони/дедлайн — параметри, щоб наступна
// кампанія не вимагала правок коду. Офісних (фабрика is_office) і людей з
// адмін-Telegram у типовій вибірці немає; фінальний список обирає офіс галочками.
import { db, workersTable, factoriesTable, adminsTable, settingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { bot } from "../bot/instance";
import { t, asLang, DATE_LOCALE, type Lang } from "../bot/i18n";
import { escapeHtml } from "../bot/display";
import { ensureReferralCode, referralLink } from "../lib/referral";
import { logger } from "../lib/logger";

export type ReferralCampaignParams = {
  rate: number;         // «до N zł/год»
  bonus1: number;       // за 1 друга
  bonus3: number;       // сумарно за 3 друзів
  bonus5: number;       // сумарно за 5 друзів
  minShifts: number;    // умова виплати: друг відпрацював N змін
  friendBonus: number;  // бонус самому другові після першого місяця
  deadline: string;     // YYYY-MM-DD — дедлайн набору (форматується мовою адресата)
  phoneUk: string;      // укр / рос
  phoneEn: string;      // англ / укр
  officeAddress: string;
  officeHours: string;
};

export const REFERRAL_CAMPAIGN_DEFAULTS: ReferralCampaignParams = {
  rate: 32, bonus1: 200, bonus3: 700, bonus5: 1350, minShifts: 10, friendBonus: 100,
  deadline: "2026-10-01",
  phoneUk: "+48 792 991 524", phoneEn: "+48 530 878 711",
  officeAddress: "ul. Krakowskie Przedmieście 55, Lublin", officeHours: "пн–пт 9:00–16:00",
};

// Умови кампанії живуть у settings (key referral_campaign, JSON поверх дефолтів): те, що
// офіс ввів у формі, далі читають бот («🎁 Запроси друга», бонус кандидата з deep-link) і
// POST /candidates — інакше в розсилці обіцяли б одне, а в картку писали б дефолтні 200.
const SETTINGS_KEY = "referral_campaign";
export async function loadCampaignParams(): Promise<ReferralCampaignParams> {
  const [row] = await db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, SETTINGS_KEY));
  if (!row) return { ...REFERRAL_CAMPAIGN_DEFAULTS };
  try { return parseCampaignParams(JSON.parse(row.value)); } catch { return { ...REFERRAL_CAMPAIGN_DEFAULTS }; }
}
export async function saveCampaignParams(p: ReferralCampaignParams): Promise<void> {
  await db.insert(settingsTable).values({ key: SETTINGS_KEY, value: JSON.stringify(p) })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(p), updatedAt: new Date() } });
}

const NUM_KEYS = ["rate", "bonus1", "bonus3", "bonus5", "minShifts", "friendBonus"] as const;
const STR_KEYS = ["deadline", "phoneUk", "phoneEn", "officeAddress", "officeHours"] as const;

// Параметри з тіла запиту поверх дефолтів; непридатне значення → дефолт (нічого не падає мовчки на 500).
export function parseCampaignParams(body: any): ReferralCampaignParams {
  const p: ReferralCampaignParams = { ...REFERRAL_CAMPAIGN_DEFAULTS };
  for (const k of NUM_KEYS) { const v = Number(body?.[k]); if (Number.isFinite(v) && v >= 0) p[k] = v; }
  for (const k of STR_KEYS) { const v = body?.[k]; if (typeof v === "string" && v.trim()) p[k] = v.trim(); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.deadline)) p.deadline = REFERRAL_CAMPAIGN_DEFAULTS.deadline;
  return p;
}

// Години офісу вводяться українською («пн–пт 9:00–16:00»); днями тижня перекладаємо самі.
const HOURS_DAYS: Record<Lang, string> = { uk: "пн–пт", en: "Mon–Fri", es: "lun–vie", ru: "пн–пт", pl: "pon–pt" };
export const localizeHours = (lang: Lang, hours: string) => hours.replace(/пн\s*[–-]\s*пт/i, HOURS_DAYS[lang]);

// Усі рядкові параметри (телефони, адреса, години) — з веб-форми, тож у Telegram-HTML
// ідуть лише екранованими: «&» чи «<» в адресі інакше валить усю розсилку (can't parse entities).
export function campaignVars(lang: Lang, p: ReferralCampaignParams): Record<string, string | number> {
  return {
    rate: p.rate, bonus1: p.bonus1, bonus3: p.bonus3, bonus5: p.bonus5, minShifts: p.minShifts, friendBonus: p.friendBonus,
    deadline: formatDeadline(lang, p.deadline),
    phoneUk: escapeHtml(p.phoneUk), phoneEn: escapeHtml(p.phoneEn),
    office: escapeHtml(p.officeAddress), hours: escapeHtml(localizeHours(lang, p.officeHours)),
  };
}

// «1 жовтня» / «1 October» — дата-рядок парситься як локальна опівнічна (без toISOString-зсуву).
export function formatDeadline(lang: Lang, ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(DATE_LOCALE[lang], { day: "numeric", month: "long" });
}

export type RenderedCampaign = { worker: string; friend: string; friendBtn: string; link: string };

export function renderCampaign(
  lang: Lang, p: ReferralCampaignParams,
  w: { fullName: string; firstName?: string | null; isActive: boolean }, code: string, botUsername?: string,
): RenderedCampaign {
  const link = referralLink(code, botUsername);
  const vars: Record<string, string | number> = {
    ...campaignVars(lang, p), code, link,
    name: escapeHtml(w.firstName?.trim() || w.fullName),
  };
  const intro = t(lang, w.isActive ? "camp.introActive" : "camp.introFired", vars);
  const status = t(lang, w.isActive ? "camp.statusActive" : "camp.statusFired");
  const outro = w.isActive ? "" : t(lang, "camp.outroFired", vars);
  return {
    worker: t(lang, "camp.worker", { ...vars, intro, status, outro }),
    friend: t(lang, "camp.friend", vars),
    friendBtn: t(lang, "camp.friendBtn"),
    link,
  };
}

// Inline-кнопки під повідомленням працівнику (і під «🎁 Запроси друга»): текст для друга
// приходить лише на запит (рішення 17.09.2026 — не спамити другим повідомленням),
// «копіювати» = той самий текст у <pre> (тап по блоку копіює), «подати кандидата» = діалог у боті.
export function campaignKeyboard(lang: Lang) {
  return { inline_keyboard: [
    [{ text: t(lang, "camp.btnFriend"), callback_data: "camp:friend" }],
    [{ text: t(lang, "camp.btnCopy"), callback_data: "camp:copy" }],
    [{ text: t(lang, "camp.btnSubmit"), callback_data: "camp:submit" }],
  ] };
}

// Текст для друга як plain-text у <pre>: HTML-теги прибираємо, сутності повертаємо, потім екрануємо заново.
export function friendCopyHtml(friendHtml: string): string {
  const plain = friendHtml.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return `<pre>${escapeHtml(plain)}</pre>`;
}

export type CampaignRecipient = {
  id: number; fullName: string; telegramId: string | null; language: string | null; isActive: boolean;
  factoryId: number | null; factoryName: string | null; isOffice: boolean; isAdmin: boolean; referralCode: string | null;
};

// Усі, кому фізично можна написати (є Telegram), з прапорцями для типових виключень.
export async function campaignRecipients(): Promise<CampaignRecipient[]> {
  const [workers, factories, admins] = await Promise.all([
    db.select({
      id: workersTable.id, fullName: workersTable.fullName, telegramId: workersTable.telegramId,
      language: workersTable.language, isActive: workersTable.isActive, factoryId: workersTable.factoryId,
      referralCode: workersTable.referralCode,
    }).from(workersTable),
    db.select({ id: factoriesTable.id, name: factoriesTable.name, isOffice: factoriesTable.isOffice }).from(factoriesTable),
    db.select({ telegramId: adminsTable.telegramId }).from(adminsTable),
  ]);
  const fMap = new Map(factories.map(f => [f.id, f]));
  const adminTids = new Set(admins.map(a => a.telegramId).filter((x): x is string => !!x));
  return workers
    .filter(w => !!w.telegramId)
    .map(w => {
      const f = w.factoryId != null ? fMap.get(w.factoryId) : undefined;
      return { ...w, factoryName: f?.name ?? null, isOffice: !!f?.isOffice, isAdmin: adminTids.has(w.telegramId!) };
    })
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.fullName.localeCompare(b.fullName, "pl"));
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type CampaignSendResult = { notified: number; skipped: number; failed: { id: number; fullName: string; error: string }[] };

// Одна кампанія за раз на процес: повторний клік/паралельний запит, поки триває відправка,
// дав би людям дублі (ревʼю 17.09.2026). Роут повертає 409, поки прапорець стоїть.
let campaignInProgress = false;
export const isCampaignInProgress = () => campaignInProgress;

// Відправка обраним: одне повідомлення з кнопками; збій одного адресата не зупиняє решту.
// ~20 msg/s (пауза 50 мс) — під лімітом Telegram (30/s); 200 людей ≈ 15 с.
export async function sendReferralCampaign(workerIds: number[], p: ReferralCampaignParams): Promise<CampaignSendResult> {
  const res: CampaignSendResult = { notified: 0, skipped: 0, failed: [] };
  if (!workerIds.length) return res;
  if (campaignInProgress) throw new Error("campaign_in_progress");
  campaignInProgress = true;
  try {
    return await sendCampaignInner(workerIds, p, res);
  } finally {
    campaignInProgress = false;
  }
}

async function sendCampaignInner(workerIds: number[], p: ReferralCampaignParams, res: CampaignSendResult): Promise<CampaignSendResult> {
  const rows = await db.select().from(workersTable).where(inArray(workersTable.id, workerIds));
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || (await bot.telegram.getMe()).username;
  const seen = new Set<string>();
  for (const w of rows) {
    if (!w.telegramId || seen.has(w.telegramId)) { res.skipped++; continue; }
    seen.add(w.telegramId);
    try {
      const code = await ensureReferralCode(w.id);
      const lang = asLang(w.language);
      const r = renderCampaign(lang, p, w, code, botUsername);
      // одне повідомлення з кнопками; текст для друга людина бере кнопкою (camp:friend / camp:copy)
      await bot.telegram.sendMessage(w.telegramId, r.worker, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: campaignKeyboard(lang) });
      res.notified++;
      await sleep(50);
    } catch (e: any) {
      res.skipped++;
      res.failed.push({ id: w.id, fullName: w.fullName, error: String(e?.description ?? e?.message ?? e) });
      logger.warn({ err: e, workerId: w.id }, "referral campaign: send failed");
    }
  }
  return res;
}
