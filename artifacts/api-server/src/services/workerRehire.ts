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
};
export type RestoreResult = { ok: true; worker: Worker; clearedRehire: boolean } | { ok: false; error: string };

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
    const patch: Partial<typeof workersTable.$inferInsert> = { isActive: true, status: "active", firedAt: null, firstWorkDate: null };
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
      { workerId: w.id, field: "restored", oldValue: "fired", newValue: "active", effectiveDate: today, adminId: opts.adminId },
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
  // легальність: employerSince/обовʼязок powiadomienie тепер від дати повернення (legalityRecompute.employerSinceOf)
  import("./documentEvents").then(m => m.workerLegalityChanged(w.id)).catch(() => {});
  logger.info({ workerId: w.id, factoryChanged, positionChanged, tgChanged, clearedRehire, adminId: opts.adminId }, "worker restored");
  return { ok: true, worker: restored, clearedRehire };
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
