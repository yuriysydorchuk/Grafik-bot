// Повернення звільненого працівника на роботу — ЄДИНА точка активації профілю
// (веб POST /workers/:id/restore, кнопка «✅ Відновити» офіса в боті, «Відновити
// його» у модалці дубля). Старий профіль лишається (історія, №, документи,
// рапорти) — новий НЕ створюється; фабрика/посада/Telegram оновлюються за
// потреби, кожна зміна йде в журнал worker_changes (старий Telegram — «архів»
// саме там, окремої колонки немає).
import { db, workersTable, workerChangesTable, workerQuestionnairesTable, candidatesTable, factoriesTable, workerFactoriesTable } from "@workspace/db";
import type { Worker } from "@workspace/db";
import { and, asc, eq, gte, isNotNull, isNull, ne, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { findLikelyDuplicate } from "../bot/workerMatch";

const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

export type RestoreOpts = {
  workerId: number;
  factoryId?: number | null;   // undefined = не чіпати
  positionId?: number | null;  // undefined = не чіпати
  telegramId?: string | null;  // undefined/null = не чіпати; інший tg = перепривʼязати
  adminId: number | null;      // хто відновив (журнал)
  force?: boolean;             // зняти «чорний список» (лише cap deleteWorkers у веб-панелі; бот не передає)
  // «Звільнили помилково» (зголошення #19, рішення власника 05.11.2026): людина роботу не припиняла —
  // це НЕ новий найм: перший робочий день і старе powiadomienie лишаються чинними (журнал `fireUndone`,
  // а не `restored`, від якого рахується «повернений = новий найм»), умови, закриті звільненням,
  // відкриваються назад, задачі й ненадіслані документи звільнення скасовуються.
  mistaken?: boolean;
};
export type FireUndoSummary = { contractsReopened: number; contractsLeftClosed: number; tasksCancelled: number; docsCancelled: number; docsAlreadySent: number };
export type RestoreResult = { ok: true; worker: Worker; clearedRehire: boolean; undo?: FireUndoSummary; undoFailed?: boolean } | { ok: false; error: string };

export async function restoreWorker(opts: RestoreOpts): Promise<RestoreResult> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, opts.workerId));
  if (!w) return { ok: false, error: "Працівника не знайдено" };
  if (w.isActive) return { ok: false, error: "Профіль уже активний" };
  // чорний список: повернути можна лише свідомо з веб-панелі (force) — бот і звичайне
  // «Відновити» відмовляють, щоб дубль не проліз повз рішення власника
  if (w.doNotHire && !opts.force) return { ok: false, error: `Чорний список${w.doNotHireReason ? `: ${w.doNotHireReason}` : ""} — повернути можна лише з веб-панелі з підтвердженням` };

  const tg = opts.telegramId?.trim() || null;
  const tgChanged = !!tg && tg !== w.telegramId;
  // Новий Telegram уже в іншого профілю: активного — відмова (не переписуємо
  // чужу привʼязку), неактивного — знімаємо там (унікальність telegram_id).
  let tgOwner: Worker | undefined;
  if (tgChanged) {
    [tgOwner] = await db.select().from(workersTable).where(and(eq(workersTable.telegramId, tg!), ne(workersTable.id, w.id)));
    if (tgOwner?.isActive) return { ok: false, error: `Цей Telegram уже привʼязаний до активного працівника ${tgOwner.fullName}` };
  }
  const today = warsawToday();
  // Куди повертаємо. Явна фабрика (бот, веб-модалка) має пріоритет; якщо її не передали, а в профілю
  // є чинна додаткова фабрика — людину звільнили з основної, нову вже додали рядком worker_factories
  // (Nina Hryhorian 29.10.2026: Dawtona лишилась основною, Agro Trade — «додатковою») — основною стає
  // вона. Обрана додаткова прибирається з worker_factories: основна й додаткова не можуть збігатись.
  const extras = await db.select({ id: workerFactoriesTable.id, factoryId: workerFactoriesTable.factoryId, companyId: workerFactoriesTable.companyId, validFrom: workerFactoriesTable.validFrom, validTo: workerFactoriesTable.validTo })
    .from(workerFactoriesTable)
    .where(and(eq(workerFactoriesTable.workerId, w.id), or(isNull(workerFactoriesTable.validTo), gte(workerFactoriesTable.validTo, today))))
    .orderBy(asc(workerFactoriesTable.validFrom), asc(workerFactoriesTable.id));
  let targetFactoryId = opts.factoryId;
  if (targetFactoryId === undefined && extras.length) {
    const started = extras.filter(e => !e.validFrom || String(e.validFrom) <= today);
    targetFactoryId = (started.find(e => !e.validTo) ?? started[0] ?? extras.find(e => !e.validTo) ?? extras[0])!.factoryId;
  }
  const factoryChanged = targetFactoryId !== undefined && (targetFactoryId ?? null) !== (w.factoryId ?? null);
  const extraRow = targetFactoryId != null ? extras.find(e => e.factoryId === targetFactoryId) : undefined;
  const positionChanged = opts.positionId !== undefined && (opts.positionId ?? null) !== (w.positionId ?? null);

  const restored = await db.transaction(async tx => {
    if (tgOwner) {
      await tx.update(workersTable).set({ telegramId: null }).where(eq(workersTable.id, tgOwner.id));
      await tx.insert(workerChangesTable).values({ workerId: tgOwner.id, field: "telegramId", oldValue: tg, newValue: null, effectiveDate: today, adminId: opts.adminId });
    }
    // перший робочий день — від нового найму: обнуляємо, бекфіл/явка поставлять дату після повернення
    // (services/firstWorkDate.ts рахує лише дати після журналу `restored`)
    // (помилкове звільнення — не новий найм: перший робочий день лишається)
    const patch: Partial<typeof workersTable.$inferInsert> = { isActive: true, status: "active", firedAt: null, ...(opts.mistaken ? {} : { firstWorkDate: null }) };
    if (factoryChanged) patch.factoryId = targetFactoryId ?? null;
    // фірма додаткової фабрики (worker_factories.company_id) їде в профіль разом із фабрикою — інакше
    // після видалення рядка роботодавцем лишалась би стара фірма профілю (ревʼю codex 29.10.2026)
    if (extraRow?.companyId != null && extraRow.companyId !== w.companyId) patch.companyId = extraRow.companyId;
    if (extraRow) await tx.delete(workerFactoriesTable).where(eq(workerFactoriesTable.id, extraRow.id));
    if (positionChanged) patch.positionId = opts.positionId ?? null;
    if (tgChanged) patch.telegramId = tg;
    if (w.doNotHire && opts.force) { patch.doNotHire = false; patch.doNotHireReason = null; patch.doNotHireAt = null; patch.doNotHireBy = null; }
    const [row] = await tx.update(workersTable).set(patch).where(eq(workersTable.id, w.id)).returning();
    const journal: (typeof workerChangesTable.$inferInsert)[] = [
      { workerId: w.id, field: opts.mistaken ? "fireUndone" : "restored", oldValue: "fired", newValue: "active", effectiveDate: today, adminId: opts.adminId },
    ];
    if (w.doNotHire && opts.force) journal.push({ workerId: w.id, field: "doNotHire", oldValue: "1", newValue: "0", effectiveDate: today, adminId: opts.adminId });
    if (factoryChanged) journal.push({ workerId: w.id, field: "factoryId", oldValue: w.factoryId != null ? String(w.factoryId) : null, newValue: targetFactoryId != null ? String(targetFactoryId) : null, effectiveDate: today, adminId: opts.adminId });
    if (patch.companyId !== undefined) journal.push({ workerId: w.id, field: "companyId", oldValue: w.companyId != null ? String(w.companyId) : null, newValue: String(patch.companyId), effectiveDate: today, adminId: opts.adminId });
    if (positionChanged) journal.push({ workerId: w.id, field: "positionId", oldValue: w.positionId != null ? String(w.positionId) : null, newValue: opts.positionId != null ? String(opts.positionId) : null, effectiveDate: today, adminId: opts.adminId });
    if (tgChanged) journal.push({ workerId: w.id, field: "telegramId", oldValue: w.telegramId, newValue: tg, effectiveDate: today, adminId: opts.adminId });
    await tx.insert(workerChangesTable).values(journal);
    return row!;
  });
  // Заявка на повернення через бот тримає стан «rehire:pending» у user_states; відновлення
  // з ВЕБ-ПАНЕЛІ його не знімало → /start назавжди відповідав «запит уже в офісі» без меню
  // (інцидент 02.10.2026, 3 застряглих на проді). Знімаємо будь-який rehire:* стан і в
  // заявника (opts.telegramId), і в tg профілю; інші діалогові стани не чіпаємо.
  let clearedRehire = false;
  try {
    const { getState, clearState, findStateIds } = await import("../bot/state");
    // + заявки на ЦЕЙ профіль з будь-якого Telegram (заявник міг писати з нового акаунта — ревʼю codex 02.10.2026)
    const byWorker = findStateIds(st => st.action.startsWith("rehire:") && Number(st.data?.workerId) === w.id);
    for (const tid of new Set([restored.telegramId, opts.telegramId?.trim() || null, ...byWorker].filter((x): x is string => !!x))) {
      if (getState(tid)?.action?.startsWith("rehire:")) { clearState(tid); clearedRehire = true; }
    }
  } catch (e) { logger.warn({ err: String(e), workerId: w.id }, "rehire state clear failed"); }
  // профіль уже активний; якщо відкат наслідків упав — кажемо про це явно (undoFailed), бо повторити
  // «відновити» вже не можна, і умови/задачі доведеться перевірити руками
  let undo: FireUndoSummary | undefined, undoFailed = false;
  if (opts.mistaken) {
    try { undo = await undoFiringEffects(w, opts.adminId); }
    catch (e) { undoFailed = true; logger.error({ err: String(e), workerId: w.id }, "fire undo effects failed"); }
  }
  // легальність: employerSince/обовʼязок powiadomienie тепер від дати повернення (legalityRecompute.employerSinceOf)
  import("./documentEvents").then(m => m.workerLegalityChanged(w.id)).catch(() => {});
  logger.info({ workerId: w.id, factoryChanged, positionChanged, tgChanged, clearedRehire, mistaken: !!opts.mistaken, undo, adminId: opts.adminId }, "worker restored");
  return { ok: true, worker: restored, clearedRehire, undo, undoFailed };
}

// Наслідки помилкового звільнення — назад: умови, закриті ЦИМ звільненням, отримують попередній кінець
// (маркер fireWorker `_closedByFire`; звільнення до 05.11.2026 маркера не мають — такі умови лишаються
// закритими й рахуються в contractsLeftClosed: дату кінця треба виправити вручну або зробити аннекс);
// відкриті задачі ZWUA й «документ звільнення» скасовуються разом з ще не надісланими документами.
async function undoFiringEffects(w: Worker, adminId: number | null): Promise<FireUndoSummary> {
  const { contractsTable, tasksTable } = await import("@workspace/db");
  const { sql, inArray, desc } = await import("drizzle-orm");
  const { eventContractIds } = await import("./contractEndDocs");
  const fireDate = w.firedAt ? w.firedAt.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }) : null;
  // лише наслідки ЦЬОГО звільнення: задачі, створені від моменту запису `fired` (раніші — зі справжнього
  // виходу людини з іншої фабрики, startFactoryEndFlow — їх не чіпаємо)
  const [fj] = await db.select({ at: workerChangesTable.createdAt }).from(workerChangesTable)
    .where(and(eq(workerChangesTable.workerId, w.id), eq(workerChangesTable.field, "fired"))).orderBy(desc(workerChangesTable.id)).limit(1);
  const firedSince = fj?.at ? new Date(fj.at.getTime() - 60_000) : null;
  const out: FireUndoSummary = { contractsReopened: 0, contractsLeftClosed: 0, tasksCancelled: 0, docsCancelled: 0, docsAlreadySent: 0 };
  const signed = await db.select().from(contractsTable).where(and(eq(contractsTable.workerId, w.id), eq(contractsTable.status, "signed")));
  const events = await eventContractIds(signed.map(c => c.id));
  for (const c of signed) {
    if (events.has(c.id)) continue;
    const data = (c.data ?? {}) as Record<string, unknown>;
    const closedAt = c.dateTo ? String(c.dateTo).slice(0, 10) : null;
    if (data._closedByFire != null && closedAt === fireDate) {
      const prev = typeof data._dateToBeforeFire === "string" && data._dateToBeforeFire ? data._dateToBeforeFire.slice(0, 10) : null;
      // передумова — в UPDATE: якщо кінець умови тим часом виправили руками, не затираємо
      const [re] = await db.update(contractsTable).set({ dateTo: prev, data: sql`${contractsTable.data} - '_closedByFire' - '_dateToBeforeFire'`, updatedAt: new Date() })
        .where(and(eq(contractsTable.id, c.id), eq(contractsTable.dateTo, fireDate!))).returning({ id: contractsTable.id });
      if (re) out.contractsReopened++; else out.contractsLeftClosed++;
    } else if (fireDate && closedAt === fireDate) out.contractsLeftClosed++;
  }
  const open = await db.select().from(tasksTable).where(and(eq(tasksTable.workerId, w.id), inArray(tasksTable.source, ["auto:termination_zus", "auto:termination_doc"]), inArray(tasksTable.status, ["open", "in_progress", "review"])));
  for (const t of open) {
    if (firedSince && t.createdAt < firedSince) continue;                       // задача старша за це звільнення
    if ((t.autoParams as { factoryEnd?: boolean } | null)?.factoryEnd) continue;    // вихід з однієї фабрики — окрема історія
    if (t.source === "auto:termination_doc" && t.contractId) {
      // скасовуємо лише ще НЕ надісланий документ — умова в самому UPDATE (його могли надіслати щойно)
      const [cancelled] = await db.update(contractsTable).set({ status: "cancelled", declineReason: "звільнення скасовано (помилкове)", updatedAt: new Date() })
        .where(and(eq(contractsTable.id, t.contractId), inArray(contractsTable.status, ["draft", "pending_approval", "approved"]))).returning({ id: contractsTable.id });
      if (cancelled) out.docsCancelled++; else out.docsAlreadySent++;
    }
    // ключ звільняємо суфіксом: нове (справжнє) звільнення має отримати свої задачі й документи
    await db.update(tasksTable).set({ status: "cancelled", completedAt: new Date(), completedById: adminId, resolutionNote: "звільнення скасовано (помилкове)", sourceKey: sql`${tasksTable.sourceKey} || ':undone:' || ${tasksTable.id}::text`, updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
    out.tasksCancelled++;
  }
  return out;
}

export type FormerWorkerHit = { id: number; fullName: string; workerCode: string | null; firedAt: Date | null; factoryName: string | null; by: "phone" | "name" };

// Звільнений профіль тієї самої людини для картки кандидата (рекрутинг «У працівники»):
// той самий телефон (анкета або картка, з якої людина колись прийшла) або впевнений
// тезка — той самий матчер, що «Це я?» на скані паспорта: шукаємо серед УСІХ профілів,
// і якщо найкращий збіг активний — це не повернення (інцидент Ndlovu 10.2026:
// скан для колишньої працівниці закінчувався заявкою на повернення в боті, картка — «переведений»).
export async function findFormerWorker(input: { fullName: string; phone?: string | null }): Promise<FormerWorkerHit | null> {
  const all = await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, isActive: workersTable.isActive, firedAt: workersTable.firedAt, factoryId: workersTable.factoryId })
    .from(workersTable);
  const inactive = all.filter(w => !w.isActive);
  if (!inactive.length) return null;
  let hit: (typeof all)[number] | undefined;
  let by: FormerWorkerHit["by"] = "phone";
  const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-9);
  const phone = digits(input.phone);
  if (phone.length === 9) {
    const q = await db.select({ workerId: workerQuestionnairesTable.workerId, phone: workerQuestionnairesTable.phone }).from(workerQuestionnairesTable);
    const c = await db.select({ workerId: candidatesTable.workerId, phone: candidatesTable.phone }).from(candidatesTable).where(isNotNull(candidatesTable.workerId));
    const ids = new Set([...q, ...c].filter(x => x.workerId != null && digits(x.phone) === phone).map(x => x.workerId!));
    const matched = all.filter(w => ids.has(w.id));
    // той самий номер у АКТИВНОГО — людина вже працює, це не повернення (ревʼю codex 19.10.2026)
    if (matched.some(w => w.isActive)) return null;
    hit = matched[0];
  }
  if (!hit && input.fullName.trim()) {
    const dup = findLikelyDuplicate(input.fullName, all);
    if (dup && !dup.isActive) { hit = dup; by = "name"; }
  }
  if (!hit) return null;
  const [fac] = hit.factoryId != null ? await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, hit.factoryId)) : [];
  return { id: hit.id, fullName: hit.fullName, workerCode: hit.workerCode, firedAt: hit.firedAt, factoryName: fac?.name ?? null, by };
}
