// Автозапит документів у працівника (рішення власника 06.09.2026): система сама просить
// документ у бот перед кінцем строку (типи з document_types.self_service) і нагадує за
// драбиною; офіс отримує задачу лише перевірити файл або звʼязатись, коли людина мовчить.
// Лінк веде на публічну сторінку /docs/:token (routes/docRequests.ts) — камера/файл без сесії.
// Той самий sendDocumentRequest використовує і ручний запит офісу (профіль, «Як вирішити»).
import { db, workersTable, workerDocumentsTable, documentTypesTable, passportScanTokensTable, taskAutoRulesTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { bot } from "../bot/instance";
import { t as tw, asLang } from "../bot/i18n";
import { randomInviteCode } from "../lib/invite";
import { documentChanged } from "./documentEvents";
import { loadTaskSettings, warsawToday } from "./tasks";
import { loadLeadDays } from "./legalityRecompute";
import { dateStr, diffDays, fmtDate } from "./taskUtils";
import { logger } from "../lib/logger";

const DOCS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createDocsToken(workerId: number, docTypeId: number | null, language: string | null): Promise<string> {
  const token = randomInviteCode(24);
  await db.insert(passportScanTokensTable).values({ token, purpose: "docs", workerId, language, draftJson: docTypeId ? { docTypeId } : null, expiresAt: new Date(Date.now() + DOCS_TOKEN_TTL_MS) });
  return token;
}
export const docsLink = (token: string): string => {
  const base = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/docs/${token}` : `/docs/${token}`;
};

export type RequestKind = "office" | "auto" | "remind";
// Запит/нагадування одного типу документа. Оновлює рядок worker_documents (requested_at,
// лічильник нагадувань), пише журнал документа, шле повідомлення в бот мовою працівника.
export async function sendDocumentRequest(opts: { workerId: number; docTypeId: number; kind: RequestKind; actorAdminId?: number | null; actorName?: string | null }): Promise<{ sent: boolean; link: string | null; docId: number; typeName: string }> {
  const [w] = await db.select({ id: workersTable.id, telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, opts.workerId));
  if (!w) throw new Error("Працівника не знайдено");
  const [ty] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, opts.docTypeId));
  if (!ty) throw new Error("Тип документа не знайдено");
  let [doc] = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, w.id), eq(workerDocumentsTable.docTypeId, ty.id)));
  const now = new Date();
  const patch = opts.kind === "remind"
    ? { requestRemindCount: (doc?.requestRemindCount ?? 0) + 1, requestRemindedAt: now, updatedAt: now }
    : { requestedAt: now, requestedBy: opts.actorAdminId ?? null, requestRemindCount: 0, requestRemindedAt: null, updatedAt: now };
  if (doc) [doc] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, doc.id)).returning();
  else [doc] = await db.insert(workerDocumentsTable).values({ workerId: w.id, docTypeId: ty.id, title: ty.name, status: "missing", ...patch }).returning();
  await documentChanged({ id: doc!.id, workerId: w.id }, "requested", { adminId: opts.actorAdminId ?? null, name: opts.actorName ?? (opts.actorAdminId ? null : opts.kind === "remind" ? "Система (нагадування)" : "Система (автозапит)"), source: opts.actorAdminId ? "office" : "system" });
  if (!w.telegramId) return { sent: false, link: null, docId: doc!.id, typeName: ty.name };
  const link = docsLink(await createDocsToken(w.id, ty.id, w.language));
  const lang = asLang(w.language);
  const exp = dateStr(doc!.expiresAt);
  const until = exp ? tw(lang, "docs.requestUntil", { date: fmtDate(exp) }) : "";
  try {
    await bot.telegram.sendMessage(w.telegramId, tw(lang, opts.kind === "remind" ? "docs.remind" : "docs.request", { doc: ty.name, until, link }), { parse_mode: "Markdown", link_preview_options: { is_disabled: true } } as any);
    return { sent: true, link, docId: doc!.id, typeName: ty.name };
  } catch (e: any) {
    logger.warn({ err: e?.message, workerId: w.id }, "doc request send failed");
    return { sent: false, link, docId: doc!.id, typeName: ty.name };
  }
}

// Днів мовчання після запиту (null — не запитували). Скидається новим файлом (pending).
export const silenceDays = (doc: { requestedAt: Date | null; status: string }, today = warsawToday()): number | null =>
  doc.requestedAt && doc.status !== "pending" ? diffDays(today, dateStr(doc.requestedAt)!) : null;

export interface AutoRequestStats { requested: number; reminded: number }
// Нічний крок ПЕРЕД генерацією автозадач: запити й нагадування працівникам з Telegram по
// self-service типах — документ у вікні попередження (або прострочений) і відсутні обовʼязкові.
export async function autoRequestDocuments(today = warsawToday()): Promise<AutoRequestStats> {
  const stats: AutoRequestStats = { requested: 0, reminded: 0 };
  const s = await loadTaskSettings();
  if (!s.autoRequest) return stats;
  const types = await db.select().from(documentTypesTable).where(and(eq(documentTypesTable.selfService, true), eq(documentTypesTable.isActive, true)));
  if (!types.length) return stats;
  const tById = new Map(types.map(t => [t.id, t]));
  const [rule] = await db.select().from(taskAutoRulesTable).where(eq(taskAutoRulesTable.code, "doc_expiring"));
  const defaultLead = rule?.leadDays ?? (await loadLeadDays()).warn;
  const workers = await db.select({ id: workersTable.id, telegramId: workersTable.telegramId }).from(workersTable).where(and(eq(workersTable.isActive, true), isNotNull(workersTable.telegramId)));
  if (!workers.length) return stats;
  const wIds = workers.map(w => w.id);
  const docs = await db.select().from(workerDocumentsTable).where(and(inArray(workerDocumentsTable.workerId, wIds), inArray(workerDocumentsTable.docTypeId, [...tById.keys()])));
  const byWorkerType = new Map<string, typeof docs>();
  for (const d of docs) { const k = `${d.workerId}:${d.docTypeId}`; if (!byWorkerType.has(k)) byWorkerType.set(k, []); byWorkerType.get(k)!.push(d); }
  const ladder = (s.workerLadder ?? [3, 7]).slice().sort((a, b) => a - b);

  const handle = async (workerId: number, docTypeId: number) => {
    const rows = byWorkerType.get(`${workerId}:${docTypeId}`) ?? [];
    // уже є файл на перевірці або новіший підтверджений → нічого не просимо
    if (rows.some(d => d.status === "pending")) return;
    const cur = rows.sort((a, b) => (dateStr(b.expiresAt) ?? "").localeCompare(dateStr(a.expiresAt) ?? ""))[0];
    if (!cur || !cur.requestedAt) { // ще не просили → запит
      const r = await sendDocumentRequest({ workerId, docTypeId, kind: "auto" });
      if (r.sent) stats.requested++;
      return;
    }
    // просили → нагадати за драбиною (від дати запиту), не більше кроків драбини
    const n = cur.requestRemindCount ?? 0;
    if (n >= ladder.length) return;
    const since = diffDays(today, dateStr(cur.requestedAt)!);
    if (since >= ladder[n]!) { const r = await sendDocumentRequest({ workerId, docTypeId, kind: "remind" }); if (r.sent) stats.reminded++; }
  };

  // 1) документи, що спливають/прострочені
  for (const d of docs) {
    if (d.status !== "present" || !d.expiresAt) continue;
    const ty = tById.get(d.docTypeId!)!;
    const exp = dateStr(d.expiresAt)!;
    const daysLeft = diffDays(exp, today);
    const lead = ty.renewalLeadDays ?? defaultLead;
    if (daysLeft > lead) continue;
    const newer = (byWorkerType.get(`${d.workerId}:${d.docTypeId}`) ?? []).some(x => x.id !== d.id && (dateStr(x.expiresAt) ?? "") > exp);
    if (newer) continue;
    await handle(d.workerId, d.docTypeId!);
  }
  // Відсутні обовʼязкові документи система НЕ просить (рішення власника 07.09.2026) — це задача офісу «Бракує».
  if (stats.requested || stats.reminded) logger.info(stats, "doc auto-requests");
  return stats;
}

// Для генератора задач: чи тип self-service (по коду) і чи в працівника є Telegram — тоді офісна
// задача не потрібна, поки людина не мовчить довше silenceDays або строк не впритул.
export async function selfServiceTypeIds(): Promise<Set<number>> {
  return new Set((await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(and(eq(documentTypesTable.selfService, true), eq(documentTypesTable.isActive, true)))).map(r => r.id));
}
export const _sql = sql; // (утримання імпорту для майбутніх агрегатів)
