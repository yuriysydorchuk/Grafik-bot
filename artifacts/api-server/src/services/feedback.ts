// Зголошення проблем і побажань з веб-панелі (docs/tasks/2026-10-29-feedback-module.md).
// Користувач панелі зголошує через віджет, контекст (сторінка, фільтри, «хлібні крихти»
// дій/запитів/помилок, версія збірки) збирається автоматично. Головний адмін отримує пуш
// у бот (тип `feedback` у ролях), автор — особисті пуші про статус/відповідь (без гейта типу).
// Сесія Claude (/feedback-triage) читає відкриті зголошення read-only (deploy/feedback-pack.sql
// або ZIP з панелі) і повертає статуси файлом результату → applyTriageResult.
import { db, adminsTable, rolesTable, settingsTable, feedbackReportsTable, feedbackAttachmentsTable, feedbackCommentsTable, feedbackVotesTable, type FeedbackReport, type FeedbackBreadcrumb, type FeedbackContext } from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bot } from "../bot/instance";
import { notifyAdminById } from "../bot/notify";
import { tb, oLang, type Lang } from "../bot/i18n";
import { createTask, mainAdminId, warsawToday, fmtDate, mdEsc, OPEN_STATUSES as TASK_OPEN } from "./tasks";
import { tasksTable } from "@workspace/db";
import { logger } from "../lib/logger";

export type FeedbackKind = "bug" | "wish" | "question";
export type FeedbackSeverity = "blocks" | "hinders" | "minor";
export type FeedbackStatus = "new" | "review" | "clarify" | "planned" | "in_progress" | "fixed" | "confirmed" | "rejected" | "duplicate" | "exists";

export const KINDS: FeedbackKind[] = ["bug", "wish", "question"];
export const SEVERITIES: FeedbackSeverity[] = ["blocks", "hinders", "minor"];
export const STATUSES: FeedbackStatus[] = ["new", "review", "clarify", "planned", "in_progress", "fixed", "confirmed", "rejected", "duplicate", "exists"];
export const OPEN_STATUSES: FeedbackStatus[] = ["new", "review", "clarify", "planned", "in_progress", "fixed"];
export const CLOSED_STATUSES: FeedbackStatus[] = ["confirmed", "rejected", "duplicate", "exists"];
export const KIND_LABEL: Record<FeedbackKind, string> = { bug: "проблема", wish: "побажання", question: "питання" };
export const SEVERITY_LABEL: Record<FeedbackSeverity, string> = { blocks: "блокує роботу", hinders: "заважає", minor: "дрібниця" };
export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: "нове", review: "на розгляді", clarify: "треба уточнити", planned: "у плані", in_progress: "в роботі",
  fixed: "виправлено", confirmed: "підтверджено", rejected: "відхилено", duplicate: "дубль", exists: "уже є",
};
const KIND_ICON: Record<FeedbackKind, string> = { bug: "🐞", wish: "💡", question: "❓" };

export const panelUrl = () => (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");

// ── налаштування (settings kv) ──────────────────────────────────────────────
export type FeedbackSettings = { instantKinds: string[]; remindDays: number; confirmDays: number; widgetOffRoles: string[]; dedupHint: boolean; packWarn: boolean };
const DEFAULTS: FeedbackSettings = { instantKinds: ["blocks"], remindDays: 3, confirmDays: 7, widgetOffRoles: [], dedupHint: true, packWarn: true };
// сторінки з фінансовими даними: скріншот без замазки звідси → попередження перед пакетом для Claude
export const FINANCE_PAGES = ["/finance", "/bank", "/cash", "/cashflow", "/cfo", "/analytics", "/balance", "/obligations", "/cost-invoices", "/pnl", "/payroll", "/svodni", "/hostels", "/penalties", "/fuel", "/cleaning", "/sushi", "/andros", "/advances"];
async function getSetting(key: string): Promise<string | null> {
  const [r] = await db.select({ v: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, key));
  return r?.v ?? null;
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}
const parseList = (v: string | null, dflt: string[]) => { try { const a = v ? JSON.parse(v) : null; return Array.isArray(a) ? a.map(String) : dflt; } catch { return dflt; } };
export async function loadFeedbackSettings(): Promise<FeedbackSettings> {
  const [ik, rd, cd, wo, dh, pw] = await Promise.all([
    getSetting("feedback.instant_kinds"), getSetting("feedback.remind_days"), getSetting("feedback.confirm_days"),
    getSetting("feedback.widget_off_roles"), getSetting("feedback.dedup_hint"), getSetting("feedback.pack_warn"),
  ]);
  return {
    instantKinds: parseList(ik, DEFAULTS.instantKinds),
    remindDays: rd != null && Number.isFinite(Number(rd)) ? Math.max(0, Math.floor(Number(rd))) : DEFAULTS.remindDays, // 0 = не нагадувати
    confirmDays: cd != null && Number.isFinite(Number(cd)) && Number(cd) >= 1 ? Math.floor(Number(cd)) : DEFAULTS.confirmDays,
    widgetOffRoles: parseList(wo, DEFAULTS.widgetOffRoles),
    dedupHint: dh == null ? DEFAULTS.dedupHint : dh !== "0" && dh !== "false",
    packWarn: pw == null ? DEFAULTS.packWarn : pw !== "0" && pw !== "false",
  };
}
export async function saveFeedbackSettings(s: Partial<FeedbackSettings>): Promise<FeedbackSettings> {
  if (s.instantKinds) await setSetting("feedback.instant_kinds", JSON.stringify(s.instantKinds.filter(k => ["blocks", "hinders", "minor", "wish", "question"].includes(k))));
  if (s.remindDays != null) await setSetting("feedback.remind_days", String(Math.max(0, Math.floor(s.remindDays))));
  if (s.confirmDays != null) await setSetting("feedback.confirm_days", String(Math.max(1, Math.floor(s.confirmDays))));
  if (s.widgetOffRoles) await setSetting("feedback.widget_off_roles", JSON.stringify(s.widgetOffRoles.map(String)));
  if (s.dedupHint != null) await setSetting("feedback.dedup_hint", s.dedupHint ? "1" : "0");
  if (s.packWarn != null) await setSetting("feedback.pack_warn", s.packWarn ? "1" : "0");
  return loadFeedbackSettings();
}

// ── автор / адмін ───────────────────────────────────────────────────────────
type AdminRow = typeof adminsTable.$inferSelect;
// Перевірка авторства по telegram_id (НЕ адмін-гейт: readOnly/скоуп-адміни теж автори зголошень,
// getAdmin їх свідомо не бачить). Деактивовані — ні.
export async function adminByTelegramId(tid: string): Promise<AdminRow | undefined> {
  const [a] = await db.select().from(adminsTable).where(and(eq(adminsTable.telegramId, tid), isNull(adminsTable.deactivatedAt)));
  return a;
}
async function adminById(id: number): Promise<AdminRow | undefined> {
  const [a] = await db.select().from(adminsTable).where(eq(adminsTable.id, id));
  return a;
}
async function roleLabelOf(key: string | null): Promise<string> {
  if (!key) return "owner";
  const [r] = await db.select({ label: rolesTable.label }).from(rolesTable).where(eq(rolesTable.key, key));
  return r?.label ?? key;
}

// ── створення ───────────────────────────────────────────────────────────────
export interface CreateFeedbackInput {
  kind: FeedbackKind; severity?: FeedbackSeverity | null;
  description: string; steps?: string | null; expected?: string | null;
  aboutPage: boolean; pagePath?: string | null; pageLabel?: string | null; pageUrl?: string | null; pageFilters?: Record<string, unknown> | null;
  origin?: "widget" | "error" | "api5xx"; clientError?: { message: string; stack?: string; source?: string } | null;
  context?: FeedbackContext; breadcrumbs?: FeedbackBreadcrumb[]; recorded?: boolean; buildVersion?: string | null;
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export function titleFromDescription(desc: string): string {
  const first = desc.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? "";
  return clip(first || "Без назви", 120);
}
export async function createReport(input: CreateFeedbackInput, author: { adminId: number; role: string; isMain: boolean }): Promise<FeedbackReport> {
  const kind: FeedbackKind = KINDS.includes(input.kind) ? input.kind : "bug";
  const severity = kind === "bug" ? (SEVERITIES.includes(input.severity as FeedbackSeverity) ? (input.severity as FeedbackSeverity) : "hinders") : null;
  const description = String(input.description ?? "").trim();
  const roleLabel = await roleLabelOf(author.role);
  const context: FeedbackContext = { ...(input.context ?? {}), role: author.role, roleLabel };
  const [row] = await db.insert(feedbackReportsTable).values({
    kind, severity, status: "new",
    title: titleFromDescription(description), description,
    steps: input.steps?.trim() || null, expected: input.expected?.trim() || null,
    aboutPage: !!input.aboutPage,
    pagePath: input.pagePath?.trim() || null, pageLabel: input.pageLabel?.trim() || null, pageUrl: input.pageUrl?.trim() || null,
    pageFilters: input.pageFilters ?? null,
    origin: input.origin === "error" || input.origin === "api5xx" ? input.origin : "widget",
    clientError: input.clientError ?? null,
    context, breadcrumbs: (input.breadcrumbs ?? []).slice(-300), recorded: !!input.recorded,
    buildVersion: input.buildVersion?.slice(0, 60) || null,
    authorAdminId: author.adminId,
  }).returning();
  await addComment(row!.id, null, "system", `створено (${KIND_LABEL[kind]}${severity ? `, ${SEVERITY_LABEL[severity]}` : ""})`, "web");
  notifyNewReport(row!).catch(e => logger.warn({ err: e?.message, id: row!.id }, "feedback notify failed"));
  return row!;
}

export async function addComment(reportId: number, adminId: number | null, kind: "comment" | "answer" | "question" | "system", body: string, via: "web" | "bot" | "triage"): Promise<void> {
  await db.insert(feedbackCommentsTable).values({ reportId, adminId, kind, body, via });
}

export async function loadReport(id: number): Promise<FeedbackReport | undefined> {
  if (!Number.isInteger(id)) return undefined;
  const [r] = await db.select().from(feedbackReportsTable).where(eq(feedbackReportsTable.id, id));
  return r;
}

// ── сповіщення ──────────────────────────────────────────────────────────────
function reportHeader(r: FeedbackReport): string {
  const sev = r.severity ? ` · ${SEVERITY_LABEL[r.severity as FeedbackSeverity]}` : "";
  return `${KIND_ICON[r.kind as FeedbackKind] ?? "🐞"} *Зголошення #${r.id} · ${KIND_LABEL[r.kind as FeedbackKind] ?? r.kind}${sev}*`;
}
function pageLine(r: FeedbackReport): string {
  const parts = [r.pageLabel ?? r.pagePath ?? "загальне"];
  const f = (r.pageFilters ?? {}) as Record<string, unknown>;
  const sel = f.selects && typeof f.selects === "object" ? Object.values(f.selects as Record<string, string>).slice(0, 3) : [];
  for (const s of sel) if (s) parts.push(String(s));
  return parts.map(p => mdEsc(String(p))).join(" · ");
}
async function attachmentsSummary(id: number): Promise<string> {
  const rows = await db.select({ kind: feedbackAttachmentsTable.kind }).from(feedbackAttachmentsTable).where(eq(feedbackAttachmentsTable.reportId, id));
  const parts: string[] = [];
  if (rows.some(r => r.kind === "screenshot")) parts.push("📸 скріншот");
  if (rows.some(r => r.kind === "pin")) parts.push("👆 пін");
  if (rows.some(r => r.kind === "upload")) parts.push("📎 файл");
  return parts.join(" · ");
}
function recordedMark(r: FeedbackReport): string {
  return r.recorded ? "⏺ запис" : "";
}
function failedLine(r: FeedbackReport): string {
  const f = (r.context?.failedRequests ?? [])[0];
  return f ? `${f.method} ${f.path} ${f.status}${f.reqId ? ` · req ${f.reqId}` : ""}` : "";
}

function mainKb(r: FeedbackReport, lang: Lang) {
  const rows: any[][] = [];
  if (panelUrl()) rows.push([{ text: tb(lang, "🔗 Відкрити"), url: `${panelUrl()}/feedback?id=${r.id}` }]);
  rows.push([
    { text: tb(lang, "✔ Прийняти"), callback_data: `fb:accept:${r.id}` },
    { text: tb(lang, "❔ Уточнити"), callback_data: `fb:ask:${r.id}` },
    { text: tb(lang, "✖ Відхилити"), callback_data: `fb:reject:${r.id}` },
  ]);
  return { inline_keyboard: rows };
}

// Текст картки для головного (миттєвий пуш і бот-кнопки). Вкладення підтягуються окремо,
// бо на момент створення файли ще не завантажені — пуш іде з затримкою (див. notifyNewReport).
export async function buildMainText(r: FeedbackReport, lang: Lang): Promise<string> {
  const author = await adminById(r.authorAdminId);
  const lines = [reportHeader(r), `${mdEsc(author?.name ?? "?")} (${mdEsc(r.context?.roleLabel ?? "")}) · ${pageLine(r)}`, `«${mdEsc(clip(r.title, 160))}»`];
  const att = await attachmentsSummary(r.id);
  const fl = failedLine(r);
  if (att || fl || r.recorded) lines.push([att, recordedMark(r), fl ? mdEsc(fl) : ""].filter(Boolean).join(" · "));
  if (r.origin !== "widget") lines.push(`⚡ ${tb(lang, "автоматично після помилки на сторінці")}`);
  return lines.join("\n");
}

// Миттєвий пуш головному: вага зі списку instantKinds, або падіння сторінки з вагою «блокує».
// Решта — у вечірній підсумок. Затримка 20 с — щоб вкладення (скріншот/пін) уже були в БД.
export async function notifyNewReport(r: FeedbackReport): Promise<void> {
  const s = await loadFeedbackSettings();
  const key = r.kind === "bug" ? (r.severity ?? "hinders") : r.kind;
  if (!s.instantKinds.includes(key)) return;
  const main = await mainAdminId();
  if (!main) return;
  await new Promise(res => setTimeout(res, 20_000));
  const fresh = (await loadReport(r.id)) ?? r;
  const a = await adminById(main);
  const lang = oLang(a?.language);
  await notifyAdminById(main, "feedback", await buildMainText(fresh, lang), { parse_mode: "Markdown", reply_markup: mainKb(fresh, lang) });
}

// Особистий пуш автору (без гейта типу сповіщень — це відповідь на його ж зголошення).
// Автори зголошень, позначених дублем цього, отримують те саме повідомлення (їм обіцяно
// «відповідь по оригіналу»); кнопки підтвердження — лише автору оригіналу.
export async function notifyAuthor(r: FeedbackReport, build: (lang: Lang) => { text: string; kb?: any[][] }, opts: { withDuplicates?: boolean } = {}): Promise<boolean> {
  const send = async (adminId: number, withKb: boolean) => {
    const a = await adminById(adminId);
    if (!a?.telegramId) return false;
    const lang = oLang(a.language);
    const { text, kb } = build(lang);
    const kbUse = withKb ? kb : kb?.filter(row => row.every((b: any) => b.url));
    try {
      await bot.telegram.sendMessage(a.telegramId, text, { parse_mode: "Markdown", ...(kbUse?.length ? { reply_markup: { inline_keyboard: kbUse } } : {}) } as any);
      return true;
    } catch (e: any) { logger.warn({ err: e?.message, id: r.id }, "feedback author notify failed"); return false; }
  };
  const ok = await send(r.authorAdminId, true);
  if (opts.withDuplicates !== false) {
    const dups = await db.select({ authorAdminId: feedbackReportsTable.authorAdminId }).from(feedbackReportsTable).where(eq(feedbackReportsTable.duplicateOfId, r.id));
    for (const d of new Set(dups.map(x => x.authorAdminId))) if (d !== r.authorAdminId) await send(d, false);
  }
  return ok;
}
// Автор дубля може читати оригінал (картку без контексту/крихт — як свою).
export async function isDuplicateAuthor(reportId: number, adminId: number): Promise<boolean> {
  const [d] = await db.select({ id: feedbackReportsTable.id }).from(feedbackReportsTable)
    .where(and(eq(feedbackReportsTable.duplicateOfId, reportId), eq(feedbackReportsTable.authorAdminId, adminId))).limit(1);
  return !!d;
}
const authorLink = (r: FeedbackReport, lang: Lang) => (panelUrl() ? [[{ text: tb(lang, "🔗 Відкрити в панелі"), url: `${panelUrl()}/?feedback=${r.id}` }]] : []);

// ── зміна статусу / відповідь ───────────────────────────────────────────────
export interface SetStatusOpts { reply?: string | null; duplicateOfId?: number | null; via?: "web" | "bot" | "triage"; triage?: Record<string, unknown> | null; deployedCommit?: string | null; notify?: boolean }
export async function setStatus(r: FeedbackReport, status: FeedbackStatus, adminId: number | null, opts: SetStatusOpts = {}): Promise<FeedbackReport> {
  if (!STATUSES.includes(status)) throw new Error("Невідомий статус");
  const now = new Date();
  const via = opts.via ?? "web";
  const patch: Partial<typeof feedbackReportsTable.$inferInsert> = {
    status, statusByAdminId: adminId, statusChangedAt: now, updatedAt: now, lastAdminActivityAt: now,
  };
  if (opts.reply !== undefined) patch.reply = opts.reply?.trim() || null;
  if (opts.duplicateOfId !== undefined) patch.duplicateOfId = opts.duplicateOfId ?? null;
  if (opts.triage !== undefined) patch.triage = (opts.triage as any) ?? null;
  if (opts.deployedCommit !== undefined) patch.deployedCommit = opts.deployedCommit ?? null;
  if (status === "fixed") { patch.confirmRequestedAt = now; patch.confirmRemindedAt = null; patch.confirmedAt = null; }
  if (status === "confirmed") patch.confirmedAt = now;
  if (status === "duplicate" && !opts.duplicateOfId && !r.duplicateOfId) throw new Error("Для дубля вкажіть оригінал");
  const [next] = await db.update(feedbackReportsTable).set(patch).where(eq(feedbackReportsTable.id, r.id)).returning();
  if (r.status !== status) await addComment(r.id, adminId, "system", `статус: ${STATUS_LABEL[r.status as FeedbackStatus] ?? r.status} → ${STATUS_LABEL[status]}`, via);
  if (opts.reply?.trim()) await addComment(r.id, adminId, "answer", opts.reply.trim(), via);
  if (opts.notify !== false && r.status !== status) await notifyStatusToAuthor(next!, opts.reply?.trim() || null);
  return next!;
}

async function notifyStatusToAuthor(r: FeedbackReport, reply: string | null): Promise<void> {
  const st = r.status as FeedbackStatus;
  if (st === "new" || st === "review" || st === "confirmed") return; // прийняття/підтвердження — без пушу (шум)
  await notifyAuthor(r, lang => {
    const head = `${KIND_ICON[r.kind as FeedbackKind] ?? "🐞"} *${tb(lang, "Ваше зголошення")} #${r.id}: ${mdEsc(tb(lang, STATUS_LABEL[st]))}*`;
    const lines = [head, `«${mdEsc(clip(r.title, 120))}»${r.pageLabel ? ` · ${mdEsc(r.pageLabel)}` : ""}`];
    if (st === "fixed") lines.push(tb(lang, "Оновіть панель (Ctrl+F5) і перевірте, будь ласка."));
    if (st === "duplicate" && r.duplicateOfId) lines.push(tb(lang, "Це те саме, що №{n} — ви отримаєте відповідь по ньому.", { n: r.duplicateOfId }));
    if (reply) lines.push(`💬 ${mdEsc(reply)}`);
    const kb: any[][] = [];
    if (st === "fixed") kb.push([{ text: tb(lang, "✔ Працює"), callback_data: `fb:ok:${r.id}` }, { text: tb(lang, "✖ Досі ні"), callback_data: `fb:no:${r.id}` }]);
    if (st === "clarify") kb.push([{ text: tb(lang, "💬 Відповісти"), callback_data: `fb:reply:${r.id}` }]);
    kb.push(...authorLink(r, lang));
    return { text: lines.join("\n"), kb };
  });
}

// Головний пише автору (відповідь без зміни статусу або запитання «уточнити»).
export async function replyToAuthor(r: FeedbackReport, adminId: number, body: string, kind: "answer" | "question", via: "web" | "bot"): Promise<FeedbackReport> {
  const text = body.trim();
  if (!text) throw new Error("Порожній текст");
  await addComment(r.id, adminId, kind, text, via);
  const now = new Date();
  const patch: Partial<typeof feedbackReportsTable.$inferInsert> = { lastAdminActivityAt: now, updatedAt: now };
  if (kind === "answer") patch.reply = text;
  let next = r;
  if (kind === "question" && r.status !== "clarify") next = await setStatus(r, "clarify", adminId, { via, notify: false });
  const [row] = await db.update(feedbackReportsTable).set(patch).where(eq(feedbackReportsTable.id, r.id)).returning();
  next = row!;
  await notifyAuthor(next, lang => ({
    text: `${kind === "question" ? "❔" : "💬"} *${tb(lang, kind === "question" ? "Запитання по зголошенню" : "Відповідь по зголошенню")} #${r.id}*\n«${mdEsc(clip(r.title, 120))}»\n${mdEsc(text)}`,
    kb: [...(kind === "question" ? [[{ text: tb(lang, "💬 Відповісти"), callback_data: `fb:reply:${r.id}` }]] : []), ...authorLink(next, lang)],
  }));
  return next;
}

// Автор відповідає (коментар з панелі або бота): у статусі «уточнити» → назад «на розгляді» + пуш головному.
export async function authorComment(r: FeedbackReport, adminId: number, body: string, via: "web" | "bot"): Promise<FeedbackReport> {
  const text = body.trim();
  if (!text) throw new Error("Порожній текст");
  await addComment(r.id, adminId, "comment", text, via);
  let next = r;
  if (r.status === "clarify") next = await setStatus(r, "review", adminId, { via, notify: false });
  await db.update(feedbackReportsTable).set({ updatedAt: new Date() }).where(eq(feedbackReportsTable.id, r.id));
  const main = await mainAdminId();
  if (main) {
    const a = await adminById(main); const lang = oLang(a?.language);
    const author = await adminById(adminId);
    await notifyAdminById(main, "feedback", `💬 *${tb(lang, "Коментар автора до зголошення")} #${r.id}* · ${mdEsc(author?.name ?? "")}\n«${mdEsc(clip(r.title, 100))}»\n${mdEsc(clip(text, 500))}`, { parse_mode: "Markdown", reply_markup: mainKb(next, lang) });
  }
  return next;
}

// Автор підтверджує виправлення або каже «досі ні».
export async function authorConfirm(r: FeedbackReport, adminId: number, ok: boolean, note: string | null, via: "web" | "bot"): Promise<FeedbackReport> {
  if (r.status !== "fixed") throw new Error("Зголошення не в статусі «виправлено»");
  if (ok) return setStatus(r, "confirmed", adminId, { via, notify: false });
  if (note?.trim()) await addComment(r.id, adminId, "comment", note.trim(), via);
  const next = await setStatus(r, "in_progress", adminId, { via, notify: false });
  const main = await mainAdminId();
  if (main) {
    const a = await adminById(main); const lang = oLang(a?.language);
    const author = await adminById(adminId);
    await notifyAdminById(main, "feedback", `↩️ *${tb(lang, "Автор каже, що не виправлено")}: #${r.id}* · ${mdEsc(author?.name ?? "")}\n«${mdEsc(clip(r.title, 100))}»${note?.trim() ? `\n${mdEsc(clip(note.trim(), 500))}` : ""}`, { parse_mode: "Markdown", reply_markup: mainKb(next, lang) });
  }
  return next;
}

// ── голоси, підказка дубля, лічильники ──────────────────────────────────────
export async function toggleVote(reportId: number, adminId: number, on: boolean): Promise<number> {
  if (on) await db.insert(feedbackVotesTable).values({ reportId, adminId }).onConflictDoNothing();
  else await db.delete(feedbackVotesTable).where(and(eq(feedbackVotesTable.reportId, reportId), eq(feedbackVotesTable.adminId, adminId)));
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(feedbackVotesTable).where(eq(feedbackVotesTable.reportId, reportId));
  return c?.n ?? 0;
}

const openSql = inArray(feedbackReportsTable.status, OPEN_STATUSES);

// Підказка дубля: відкриті зголошення з тими ж словами (≥4 символи), спершу та ж сторінка.
// `allowedPage(path)` — чи бачить глядач цю сторінку (lib/roles pages; null-сторінка = загальне → так).
// Без цього графікова з одного скоупу бачила б заголовки зголошень із /finance (витік, ревʼю codex 29.10).
export async function similar(pagePath: string | null, q: string, excludeAdmin: number | null, allowedPage: (p: string | null) => boolean, limit = 5) {
  const tokens = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 4))].slice(0, 8);
  if (!tokens.length) return [];
  const conds = tokens.map(t => sql`(lower(${feedbackReportsTable.title}) like ${"%" + t + "%"} or lower(${feedbackReportsTable.description}) like ${"%" + t + "%"})`);
  const score = sql<number>`(${sql.join(conds.map(c => sql`(case when ${c} then 1 else 0 end)`), sql` + `)})`;
  const samePage = sql<number>`(case when ${feedbackReportsTable.pagePath} = ${pagePath ?? ""} then 1 else 0 end)`;
  const rows = await db.select({
    id: feedbackReportsTable.id, kind: feedbackReportsTable.kind, status: feedbackReportsTable.status, title: feedbackReportsTable.title,
    pagePath: feedbackReportsTable.pagePath, pageLabel: feedbackReportsTable.pageLabel, authorAdminId: feedbackReportsTable.authorAdminId,
    votes: sql<number>`(select count(*)::int from feedback_votes v where v.report_id = ${feedbackReportsTable.id})`,
    score, samePage,
  }).from(feedbackReportsTable).where(and(openSql, sql`${score} >= ${Math.min(2, tokens.length)}`))
    .orderBy(sql`${samePage} desc, ${score} desc, ${feedbackReportsTable.id} desc`).limit(limit * 4);
  return rows.filter(r => allowedPage(r.pagePath)).slice(0, limit).map(r => ({ ...r, mine: r.authorAdminId === excludeAdmin }));
}

export async function counters(today = warsawToday()) {
  const staleBefore = new Date(`${today}T00:00:00`); staleBefore.setDate(staleBefore.getDate() - 7);
  const [c] = await db.select({
    new: sql<number>`count(*) filter (where status = 'new')::int`,
    stale: sql<number>`count(*) filter (where status in ('new','review') and coalesce(last_admin_activity_at, created_at) < ${staleBefore})::int`,
    awaiting: sql<number>`count(*) filter (where status = 'fixed')::int`,
    open: sql<number>`count(*) filter (where status in ('new','review','clarify','planned','in_progress','fixed'))::int`,
    blocks: sql<number>`count(*) filter (where status in ('new','review') and severity = 'blocks')::int`,
    // закрито за 30 днів і середній час від створення до закриття (дашборд)
    closed30: sql<number>`count(*) filter (where status in ('confirmed','rejected','duplicate','exists') and status_changed_at >= now() - interval '30 days')::int`,
    avgDays: sql<number | null>`round((avg(extract(epoch from (status_changed_at - created_at)) / 86400) filter (where status in ('confirmed','rejected','duplicate','exists') and status_changed_at >= now() - interval '30 days'))::numeric, 1)::float`,
  }).from(feedbackReportsTable);
  return c ?? { new: 0, stale: 0, awaiting: 0, open: 0, blocks: 0, closed30: 0, avgDays: null };
}

// ── крони (без нових розкладів: вечірній тік задач, добовий тік 00:05, тижневий звіт) ──
export async function sendFeedbackEveningSummary(today = warsawToday()): Promise<boolean> {
  if ((await getSetting("feedback.evening.sent")) === today) return false;
  await setSetting("feedback.evening.sent", today);
  const main = await mainAdminId();
  if (!main) return false;
  const c = await counters(today);
  const [t] = await db.select({
    n: sql<number>`count(*)::int`,
    bugs: sql<number>`count(*) filter (where kind = 'bug')::int`,
    blocks: sql<number>`count(*) filter (where severity = 'blocks')::int`,
    wishes: sql<number>`count(*) filter (where kind = 'wish')::int`,
    questions: sql<number>`count(*) filter (where kind = 'question')::int`,
  }).from(feedbackReportsTable).where(sql`created_at::date = ${today}::date`);
  if (!t?.n && !c.stale) return false;
  const a = await adminById(main); const lang = oLang(a?.language);
  const lines = [`💡 *${tb(lang, "Вечірній підсумок зголошень")} · ${fmtDate(today)}*`];
  if (t?.n) lines.push(`${tb(lang, "Нових за день")}: *${t.n}* (${t.bugs} ${tb(lang, "проблем")}${t.blocks ? `, ${t.blocks} ${tb(lang, "блокує")}` : ""}, ${t.wishes} ${tb(lang, "побажань")}, ${t.questions} ${tb(lang, "питань")})`);
  if (c.stale) {
    const ids = await db.select({ id: feedbackReportsTable.id }).from(feedbackReportsTable)
      .where(and(inArray(feedbackReportsTable.status, ["new", "review"]), sql`coalesce(last_admin_activity_at, created_at) < now() - interval '7 days'`)).orderBy(feedbackReportsTable.id).limit(8);
    lines.push(`${tb(lang, "Без відповіді понад 7 дн")}: ${ids.map(x => `#${x.id}`).join(", ")}`);
  }
  if (c.awaiting) lines.push(`${tb(lang, "Чекають підтвердження авторів")}: ${c.awaiting}`);
  const kb = panelUrl() ? [[{ text: tb(lang, "🔗 Відкрити зголошення"), url: `${panelUrl()}/feedback` }]] : [];
  return notifyAdminById(main, "feedback", lines.join("\n"), { parse_mode: "Markdown", ...(kb.length ? { reply_markup: { inline_keyboard: kb } } : {}) });
}

// Добовий тік: нагадати автору про підтвердження (раз, через remindDays) і автопідтвердити через confirmDays.
export async function feedbackDailyTick(now = new Date()): Promise<{ reminded: number; autoConfirmed: number }> {
  const s = await loadFeedbackSettings();
  const remindBefore = new Date(now.getTime() - s.remindDays * 86400_000);
  const confirmBefore = new Date(now.getTime() - s.confirmDays * 86400_000);
  let reminded = 0, autoConfirmed = 0;
  const fixed = await db.select().from(feedbackReportsTable).where(eq(feedbackReportsTable.status, "fixed"));
  for (const r of fixed) {
    const req = r.confirmRequestedAt ?? r.statusChangedAt ?? r.createdAt;
    // гард від гонки з «досі ні» автора: оновлюємо лише якщо рядок ДОСІ fixed, а строк рахуємо в SQL
    // (повторне «виправлено» після «досі ні» дає новий confirm_requested_at → під умову не підпадає)
    const stillFixed = and(eq(feedbackReportsTable.id, r.id), eq(feedbackReportsTable.status, "fixed"));
    if (req <= confirmBefore) {
      const done = await db.update(feedbackReportsTable).set({ status: "confirmed", confirmedAt: now, statusChangedAt: now, updatedAt: now })
        .where(and(stillFixed, sql`coalesce(${feedbackReportsTable.confirmRequestedAt}, ${feedbackReportsTable.statusChangedAt}, ${feedbackReportsTable.createdAt}) <= ${confirmBefore}`)).returning({ id: feedbackReportsTable.id });
      if (!done.length) continue;
      await addComment(r.id, null, "system", `підтверджено автоматично (без відповіді ${s.confirmDays} дн.)`, "web");
      autoConfirmed++;
    } else if (s.remindDays > 0 && !r.confirmRemindedAt && req <= remindBefore) {
      const marked = await db.update(feedbackReportsTable).set({ confirmRemindedAt: now }).where(and(stillFixed, isNull(feedbackReportsTable.confirmRemindedAt))).returning({ id: feedbackReportsTable.id });
      if (!marked.length) continue;
      await notifyAuthor(r, lang => ({
        text: `🔔 *${tb(lang, "Нагадування")}: ${tb(lang, "зголошення")} #${r.id} ${tb(lang, "виправлено")}*\n«${mdEsc(clip(r.title, 120))}»\n${tb(lang, "Перевірте, будь ласка, чи все працює.")}`,
        kb: [[{ text: tb(lang, "✔ Працює"), callback_data: `fb:ok:${r.id}` }, { text: tb(lang, "✖ Досі ні"), callback_data: `fb:no:${r.id}` }], ...authorLink(r, lang)],
      }));
      reminded++;
    }
  }
  return { reminded, autoConfirmed };
}

// Рядок для тижневого звіту контролю (пн 08:00, services/taskDigest.ts).
export async function feedbackWeeklyLine(from: string, to: string): Promise<string | null> {
  const [w] = await db.select({
    created: sql<number>`count(*) filter (where created_at::date between ${from}::date and ${to}::date)::int`,
    closed: sql<number>`count(*) filter (where status in ('confirmed','rejected','duplicate','exists') and status_changed_at::date between ${from}::date and ${to}::date)::int`,
  }).from(feedbackReportsTable);
  const c = await counters(to);
  if (!w?.created && !w?.closed && !c.open) return null;
  const [top] = await db.select({ label: sql<string>`coalesce(page_label, page_path, 'загальне')`, n: sql<number>`count(*)::int` })
    .from(feedbackReportsTable).where(openSql).groupBy(sql`1`).orderBy(sql`2 desc`).limit(1);
  return `🐞 Зголошення: нових ${w?.created ?? 0} · закрито ${w?.closed ?? 0} · відкрито ${c.open}${c.stale ? ` · без відповіді >7 дн *${c.stale}*` : ""}${top ? ` · найбільше з «${mdEsc(top.label)}» (${top.n})` : ""}`;
}

// ── задача зі зголошення ────────────────────────────────────────────────────
export async function createTaskFromReport(r: FeedbackReport, adminId: number) {
  if (r.taskId) {
    const [t] = await db.select({ id: tasksTable.id, status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.id, r.taskId));
    if (t && (TASK_OPEN as string[]).includes(t.status)) return t.id;
  }
  const author = await adminById(r.authorAdminId);
  const task = await createTask({
    title: clip(`${KIND_ICON[r.kind as FeedbackKind] ?? ""} ${r.title}`.trim(), 200),
    description: [r.steps ? `Що робили: ${r.steps}` : "", r.description, r.expected ? `Очікували: ${r.expected}` : "", `Автор: ${author?.name ?? "?"} · ${r.pageLabel ?? r.pagePath ?? "загальне"}`].filter(Boolean).join("\n\n"),
    priority: r.severity === "blocks" ? "urgent" : r.severity === "hinders" ? "high" : "normal",
    source: "feedback", sourceKey: `feedback:${r.id}:${Date.now()}`, autoParams: { feedbackId: r.id },
    assigneeAdminId: adminId,
  }, adminId);
  await db.update(feedbackReportsTable).set({ taskId: task.id, updatedAt: new Date() }).where(eq(feedbackReportsTable.id, r.id));
  await addComment(r.id, adminId, "system", `створено задачу #${task.id}`, "web");
  return task.id;
}

// Задача зі зголошення виконана (services/tasks.ts setTaskStatus): системний рядок + головному «відповісти автору?».
export async function onFeedbackTaskDone(task: { id: number; title: string; autoParams: unknown }, actorAdminId: number | null): Promise<void> {
  const fid = Number((task.autoParams as any)?.feedbackId);
  const r = fid ? await loadReport(fid) : undefined;
  if (!r) return;
  await addComment(r.id, actorAdminId, "system", `задачу #${task.id} виконано`, "web");
  if (CLOSED_STATUSES.includes(r.status as FeedbackStatus)) return;
  const main = await mainAdminId();
  if (!main) return;
  const a = await adminById(main); const lang = oLang(a?.language);
  const kb: any[][] = panelUrl() ? [[{ text: tb(lang, "💬 Відповісти автору"), url: `${panelUrl()}/feedback?id=${r.id}` }]] : [];
  kb.push([{ text: tb(lang, "✔ Виправлено"), callback_data: `fb:fixed:${r.id}` }]);
  await notifyAdminById(main, "feedback", `✅ *${tb(lang, "Задачу по зголошенню виконано")}: #${r.id}*
«${mdEsc(clip(r.title, 100))}» · ${tb(lang, "задача")} #${task.id}
${tb(lang, "Відповісти автору або позначити «виправлено»?")}`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
}

// Попередження перед пакетом: скріншоти з фінансових сторінок без замазки (правило «не слати дані агентам»).
export async function packWarnings(f: PackFilter = {}): Promise<{ id: number; page: string; attachments: number }[]> {
  return packWarningsFor(await buildPack(f));
}
export async function packWarningsFor(pack: Awaited<ReturnType<typeof buildPack>>): Promise<{ id: number; page: string; attachments: number }[]> {
  const s = await loadFeedbackSettings();
  if (!s.packWarn) return [];
  const out: { id: number; page: string; attachments: number }[] = [];
  for (const r of pack.reports) {
    if (!r.page.path || !FINANCE_PAGES.some(p => r.page.path === p || r.page.path!.startsWith(p + "/"))) continue;
    const n = r.attachments.filter(a => a.kind === "screenshot" && !(a.meta as any)?.blurred).length;
    if (n) out.push({ id: r.id, page: r.page.label ?? r.page.path, attachments: n });
  }
  return out;
}

// ── пакет для Claude та імпорт результату тріажу ────────────────────────────
export interface PackFilter { status?: string[]; kind?: string[]; pagePath?: string | null; since?: string | null; ids?: number[] }
export async function buildPack(f: PackFilter = {}) {
  const conds = [] as any[];
  conds.push(f.status?.length ? inArray(feedbackReportsTable.status, f.status) : openSql);
  if (f.kind?.length) conds.push(inArray(feedbackReportsTable.kind, f.kind));
  if (f.pagePath) conds.push(eq(feedbackReportsTable.pagePath, f.pagePath));
  if (f.since) conds.push(sql`${feedbackReportsTable.createdAt} >= ${f.since}::date`);
  if (f.ids?.length) conds.push(inArray(feedbackReportsTable.id, f.ids));
  const rows = await db.select().from(feedbackReportsTable).where(and(...conds)).orderBy(desc(feedbackReportsTable.id)).limit(500);
  const ids = rows.map(r => r.id);
  const [att, com, votes, admins] = ids.length ? await Promise.all([
    db.select().from(feedbackAttachmentsTable).where(inArray(feedbackAttachmentsTable.reportId, ids)),
    db.select().from(feedbackCommentsTable).where(inArray(feedbackCommentsTable.reportId, ids)).orderBy(feedbackCommentsTable.id),
    db.select({ reportId: feedbackVotesTable.reportId, n: sql<number>`count(*)::int` }).from(feedbackVotesTable).where(inArray(feedbackVotesTable.reportId, ids)).groupBy(feedbackVotesTable.reportId),
    db.select({ id: adminsTable.id, name: adminsTable.name, role: adminsTable.role }).from(adminsTable),
  ]) : [[], [], [], []];
  const nameOf = (id: number | null) => (id == null ? "система" : admins.find(a => a.id === id)?.name ?? `#${id}`);
  const reports = rows.map(r => ({
    id: r.id, kind: r.kind, severity: r.severity, status: r.status, title: r.title,
    description: r.description, steps: r.steps, expected: r.expected,
    page: { path: r.pagePath, label: r.pageLabel, url: r.pageUrl, filters: r.pageFilters, aboutPage: r.aboutPage },
    origin: r.origin, clientError: r.clientError, context: r.context, breadcrumbs: r.breadcrumbs, recorded: r.recorded,
    buildVersion: r.buildVersion, author: { id: r.authorAdminId, name: nameOf(r.authorAdminId), role: r.context?.roleLabel ?? null },
    createdAt: r.createdAt, reply: r.reply, duplicateOfId: r.duplicateOfId, taskId: r.taskId, triage: r.triage,
    votes: votes.find(v => v.reportId === r.id)?.n ?? 0,
    attachments: att.filter(a => a.reportId === r.id).map(a => ({ id: a.id, kind: a.kind, file: `shots/${r.id}-${a.id}${extOf(a.mime)}`, name: a.name, mime: a.mime, meta: a.meta })),
    comments: com.filter(c => c.reportId === r.id).map(c => ({ at: c.createdAt, by: nameOf(c.adminId), kind: c.kind, via: c.via, body: c.body })),
  }));
  return { generatedAt: new Date().toISOString(), build: process.env.APP_VERSION ?? "dev", count: reports.length, reports, attachmentsRaw: att };
}
export const extOf = (mime: string) => (mime === "image/png" ? ".png" : mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : mime === "application/pdf" ? ".pdf" : "");

// Формат файлу результату тріажу (docs/feedback/README.md):
// { commit?: string, items: [{ id, status?, reply?, duplicateOfId?, triage?: {verdict, effort, risk, note, batch} }] }
export interface TriageItem { id: number; status?: FeedbackStatus; reply?: string | null; duplicateOfId?: number | null; triage?: Record<string, unknown> | null }
export async function applyTriageResult(input: { commit?: string | null; items: TriageItem[] }, adminId: number) {
  const applied: number[] = []; const skipped: { id: number; reason: string }[] = [];
  for (const it of input.items ?? []) {
    const id = Number(it.id);
    const r = await loadReport(id);
    if (!r) { skipped.push({ id, reason: "не знайдено" }); continue; }
    try {
      const status = it.status && STATUSES.includes(it.status) ? it.status : null;
      if (status && status !== r.status) {
        await setStatus(r, status, adminId, { via: "triage", reply: it.reply ?? undefined, duplicateOfId: it.duplicateOfId ?? undefined, triage: it.triage ?? undefined, deployedCommit: status === "fixed" ? (input.commit ?? null) : undefined });
      } else {
        // той самий статус — лише тріаж/відповідь
        const patch: Partial<typeof feedbackReportsTable.$inferInsert> = { updatedAt: new Date() };
        if (it.triage !== undefined) patch.triage = (it.triage as any) ?? null;
        if (it.duplicateOfId !== undefined) patch.duplicateOfId = it.duplicateOfId ?? null;
        await db.update(feedbackReportsTable).set(patch).where(eq(feedbackReportsTable.id, id));
        if (it.reply?.trim()) await replyToAuthor(r, adminId, it.reply, "answer", "web");
      }
      applied.push(id);
    } catch (e: any) { skipped.push({ id, reason: e?.message ?? "помилка" }); }
  }
  return { applied, skipped };
}

// Непрочитане для автора: остання дія головного пізніша за «бачив».
export const unreadSql = sql<boolean>`(${feedbackReportsTable.lastAdminActivityAt} is not null and ${feedbackReportsTable.lastAdminActivityAt} > coalesce(${feedbackReportsTable.authorSeenAt}, ${feedbackReportsTable.createdAt}))`;
