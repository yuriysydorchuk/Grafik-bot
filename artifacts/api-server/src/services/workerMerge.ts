// Злиття двох профілів однієї людини (дублікат): усі звʼязані записи
// переїжджають на профіль keep, порожні поля keep заповнюються з drop,
// drop видаляється. Викликається ЛИШЕ після ручного затвердження адміном
// (кнопка в боті, «Обʼєднати з дублем» у профілі — 22.10.2026, разовий скрипт) —
// автоматичних злиттів у системі немає. Подія пишеться в журнал keep (`merged`).
import { db } from "@workspace/db";
import {
  workersTable, scheduleEntriesTable, monthlyReportsTable, svodniRowsTable,
  availabilityTable, absenceRequestsTable, advanceRequestsTable, candidatesTable,
  workerDocumentsTable, unplannedWorkersTable, hoursDisputesTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// manual — злиття з профілю (офіс сам обрав, хто лишається): два активні профілі з різними
// Telegram дозволені, лишається Telegram keep (Telegram дубля відвʼязується)
export async function mergeWorkers(keepId: number, dropId: number, opts: { adminId?: number | null; manual?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (keepId === dropId) return { ok: false, error: "той самий профіль" };
  const [keep] = await db.select().from(workersTable).where(eq(workersTable.id, keepId));
  const [drop] = await db.select().from(workersTable).where(eq(workersTable.id, dropId));
  if (!keep || !drop) return { ok: false, error: "профіль не знайдено" };
  // Telegram АКТИВНОГО профілю — пріоритетний: у звільненого дубля інший Telegram
  // просто відкидається (keep звільнений + drop активний → keep бере tg drop —
  // людина повернулась із новим акаунтом, а офіс уже завів дубль). Відмова —
  // лише коли обидва профілі активні з різними tg.
  if (!opts.manual && keep.telegramId && drop.telegramId && keep.telegramId !== drop.telegramId && drop.isActive && keep.isActive) {
    return { ok: false, error: "обидва профілі активні з різними Telegram — обʼєднувати треба вручну" };
  }
  const takeDropTg = !!drop.telegramId && (!keep.telegramId || (!keep.isActive && drop.isActive && drop.telegramId !== keep.telegramId));

  await db.transaction(async tx => {
    // порожні поля keep доповнюємо даними drop (Telegram — головне)
    const fill: Partial<typeof workersTable.$inferInsert> = {};
    if (takeDropTg) fill.telegramId = drop.telegramId;
    if (!keep.language && drop.language) fill.language = drop.language;
    if (!keep.birthDate && drop.birthDate) fill.birthDate = drop.birthDate;
    if (!keep.legalStatus && drop.legalStatus) fill.legalStatus = drop.legalStatus;
    if (keep.notifyHours == null && drop.notifyHours != null) fill.notifyHours = drop.notifyHours;
    // ставки переливаються ПАРОЮ — інакше вийшов би профіль «netto без brutto»
    // і резолюція зібрала б змішану пару (brutto з правила + чуже netto)
    if (keep.hourlyRate == null && drop.hourlyRate != null) fill.hourlyRate = drop.hourlyRate;
    if (keep.hourlyRateNetto == null && drop.hourlyRateNetto != null) fill.hourlyRateNetto = drop.hourlyRateNetto;
    if (!keep.gender && drop.gender) fill.gender = drop.gender;
    if (keep.positionId == null && drop.positionId != null) fill.positionId = drop.positionId;
    if (!keep.isActive && drop.isActive) { fill.isActive = true; fill.status = "active"; fill.firedAt = null; }
    // Telegram у drop прибираємо ПЕРШИМ — унікальність telegram_id
    if (drop.telegramId) await tx.update(workersTable).set({ telegramId: null }).where(eq(workersTable.id, dropId));
    if (Object.keys(fill).length) await tx.update(workersTable).set(fill).where(eq(workersTable.id, keepId));

    // рапорти: конфлікт (worker, month, factory) — лишаємо запис keep, дубль drop зникає
    const dropReports = await tx.select().from(monthlyReportsTable).where(eq(monthlyReportsTable.workerId, dropId));
    for (const r of dropReports) {
      const clash = await tx.select({ id: monthlyReportsTable.id }).from(monthlyReportsTable).where(and(
        eq(monthlyReportsTable.workerId, keepId), eq(monthlyReportsTable.month, r.month),
        // без фабрики — теж конфлікт (unique monthly_reports_worker_month_nofactory_uniq; раніше злиття падало)
        r.factoryId != null ? eq(monthlyReportsTable.factoryId, r.factoryId) : isNull(monthlyReportsTable.factoryId),
      ));
      if (clash.length) await tx.delete(monthlyReportsTable).where(eq(monthlyReportsTable.id, r.id));
      else await tx.update(monthlyReportsTable).set({ workerId: keepId }).where(eq(monthlyReportsTable.id, r.id));
    }
    // планові (scheduled) клітинки дубля, що повторюють клітинку keep того ж
    // дня і зміни — сміття з подвійного заведення, не переносимо
    await tx.execute(sql`
      DELETE FROM schedule_entries se
      WHERE se.worker_id = ${dropId} AND se.status = 'scheduled'
        AND EXISTS (
          SELECT 1 FROM schedule_entries k
          WHERE k.worker_id = ${keepId} AND k.week_id = se.week_id
            AND k.day_of_week = se.day_of_week AND k.shift = se.shift
        )`);
    await tx.update(scheduleEntriesTable).set({ workerId: keepId }).where(eq(scheduleEntriesTable.workerId, dropId));
    await tx.update(svodniRowsTable).set({ workerId: keepId }).where(eq(svodniRowsTable.workerId, dropId));
    await tx.update(availabilityTable).set({ workerId: keepId }).where(eq(availabilityTable.workerId, dropId));
    await tx.update(absenceRequestsTable).set({ workerId: keepId }).where(eq(absenceRequestsTable.workerId, dropId));
    await tx.update(absenceRequestsTable).set({ substituteWorkerId: keepId }).where(eq(absenceRequestsTable.substituteWorkerId, dropId));
    await tx.update(advanceRequestsTable).set({ workerId: keepId }).where(eq(advanceRequestsTable.workerId, dropId));
    await tx.update(candidatesTable).set({ workerId: keepId }).where(eq(candidatesTable.workerId, dropId));
    await tx.update(candidatesTable).set({ referrerWorkerId: keepId }).where(eq(candidatesTable.referrerWorkerId, dropId));
    await tx.update(hoursDisputesTable).set({ workerId: keepId }).where(eq(hoursDisputesTable.workerId, dropId));
    await tx.update(unplannedWorkersTable).set({ workerId: keepId }).where(eq(unplannedWorkersTable.workerId, dropId));
    await tx.update(unplannedWorkersTable).set({ replacesWorkerId: keepId }).where(eq(unplannedWorkersTable.replacesWorkerId, dropId));
    await tx.update(workerDocumentsTable).set({ workerId: keepId }).where(eq(workerDocumentsTable.workerId, dropId));

    // Решта таблиць з worker_id (21.09.2026, злиття Moyo падало на factory_hours: FK без
    // ON DELETE, а каскадні тихо втрачали рахунки/журнал/умови дубля). Прості FK — переносимо;
    // «один рядок на працівника» — лишаємо запис keep, дубль drop прибираємо.
    const plain = ["clothing_items", "contracts", "gratyfikant_umowy", "hostel_deductions", "hostel_payments", "hostel_stays",
      "passport_scan_tokens", "penalties", "transport_deductions", "tasks", "worker_changes", "worker_badania",
      "worker_family_members", "worker_self_transport", "absence_attachments", "absence_messages",
      // 22.10.2026: sms_recipients (FK без ON DELETE — delete дубля падав), ua_submissions (SET NULL —
      // подачі Powiadomienie відчіплялись), document_audit (без FK — журнал документів лишався сиротою)
      "sms_recipients", "ua_submissions", "document_audit"];
    for (const t of plain) await tx.execute(sql`UPDATE ${sql.identifier(t)} SET worker_id = ${keepId} WHERE worker_id = ${dropId}`);
    // години/нотатки фабрик: unique (worker, month, factory) — рядок keep за той самий місяць
    // і фабрику лишається, дубль drop видаляємо (FK без каскаду, інакше delete профілю впаде)
    for (const t of ["factory_hours", "hours_notes"]) {
      await tx.execute(sql`DELETE FROM ${sql.identifier(t)} d WHERE d.worker_id = ${dropId}
        AND EXISTS (SELECT 1 FROM ${sql.identifier(t)} k WHERE k.worker_id = ${keepId} AND k.month = d.month AND k.factory_id IS NOT DISTINCT FROM d.factory_id)`);
      await tx.execute(sql`UPDATE ${sql.identifier(t)} SET worker_id = ${keepId} WHERE worker_id = ${dropId}`);
    }
    // унікальні пари (worker, factory/month): переносимо лише ті, яких у keep ще нема
    for (const [t, col] of [["worker_factories", "factory_id"], ["worker_factory_codes", "factory_id"], ["transport_fee_members", "factory_id"], ["hours_month_exclusions", "month"], ["worker_notify_hours", "factory_id"]] as const) {
      await tx.execute(sql`UPDATE ${sql.identifier(t)} d SET worker_id = ${keepId} WHERE d.worker_id = ${dropId}
        AND NOT EXISTS (SELECT 1 FROM ${sql.identifier(t)} k WHERE k.worker_id = ${keepId} AND k.${sql.identifier(col)} = d.${sql.identifier(col)})`);
    }
    // рахунки: IBAN унікальний глобально, основний — один на профіль
    await tx.execute(sql`UPDATE worker_bank_accounts SET worker_id = ${keepId},
      is_primary = (is_primary AND NOT EXISTS (SELECT 1 FROM worker_bank_accounts k WHERE k.worker_id = ${keepId} AND k.is_primary)) WHERE worker_id = ${dropId}`);
    // анкета: keep без анкети бере анкету drop; інакше дубль зникне каскадом
    await tx.execute(sql`UPDATE worker_questionnaires SET worker_id = ${keepId} WHERE worker_id = ${dropId}
      AND NOT EXISTS (SELECT 1 FROM worker_questionnaires k WHERE k.worker_id = ${keepId})`);
    // кеш легальності drop — просто зникне каскадом (перерахується з подій)

    await tx.delete(workersTable).where(eq(workersTable.id, dropId));
    // історія keep: хто, коли і кого вклеїли (журнал drop уже переїхав вище)
    await tx.execute(sql`INSERT INTO worker_changes (worker_id, field, old_value, new_value, effective_date, admin_id)
      VALUES (${keepId}, 'merged', ${`${drop.fullName} · ${drop.workerCode ?? "—"} (#${drop.id})`}, ${`${keep.fullName} (#${keep.id})`},
        ${new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" })}, ${opts.adminId ?? null})`);
  });
  // документи дубля тепер у keep — світлофори легальності перераховуємо одразу
  try { const { workerLegalityChanged } = await import("./documentEvents"); await workerLegalityChanged(keepId); }
  catch (e) { logger.warn({ err: String(e), keepId }, "merge: legality recompute failed"); }
  return { ok: true };
}

// Превʼю злиття для веб-модалки: скільки записів дубля переїде, що загубиться/задвоїться.
// Нічого не пише. Таблиці — ті самі, що переносить mergeWorkers.
export interface MergePreview {
  keep: MergeSide; drop: MergeSide;
  moves: { label: string; count: number }[];
  warnings: string[];
}
interface MergeSide { id: number; fullName: string; workerCode: string | null; isActive: boolean; telegramId: string | null; factoryName: string | null; createdAt: string }
export async function mergePreview(keepId: number, dropId: number): Promise<MergePreview | { error: string }> {
  if (keepId === dropId) return { error: "той самий профіль" };
  const side = async (id: number): Promise<MergeSide | null> => {
    const r = await db.execute(sql`SELECT w.id, w.full_name, w.worker_code, w.is_active, w.telegram_id, w.created_at::date::text AS created_at, f.name AS factory_name
      FROM workers w LEFT JOIN factories f ON f.id = w.factory_id WHERE w.id = ${id}`);
    const x = r.rows[0] as Record<string, any> | undefined;
    return x ? { id: x.id, fullName: x.full_name, workerCode: x.worker_code, isActive: x.is_active, telegramId: x.telegram_id, factoryName: x.factory_name, createdAt: String(x.created_at) } : null;
  };
  const [keep, drop] = [await side(keepId), await side(dropId)];
  if (!keep || !drop) return { error: "профіль не знайдено" };
  const count = async (table: string, col = "worker_id") =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(col)} = ${dropId}`)).rows[0] as any)?.n ?? 0);
  const moves = [
    { label: "Записи графіку", count: await count("schedule_entries") },
    { label: "Рядки сводної", count: await count("svodni_rows") },
    { label: "Документи", count: await count("worker_documents") },
    { label: "Умови", count: await count("contracts") },
    { label: "Години фабрик", count: await count("factory_hours") },
    { label: "Аванси", count: await count("advance_requests") },
    { label: "Пропуски/відпрошування", count: await count("absence_requests") },
    { label: "Штрафи", count: await count("penalties") },
    { label: "Задачі", count: await count("tasks") },
    { label: "Історія змін", count: await count("worker_changes") },
  ].filter(m => m.count > 0);
  const warnings: string[] = [];
  // та сама логіка, що takeDropTg у mergeWorkers: звільнений keep + активний дубль → Telegram дубля
  const keepTakesDropTg = !keep.isActive && drop.isActive;
  if (keep.telegramId && drop.telegramId && keep.telegramId !== drop.telegramId)
    warnings.push(keepTakesDropTg
      ? `Різні Telegram: профіль, що лишається, звільнений — він візьме Telegram активного дубля (${drop.telegramId}); Telegram ${keep.telegramId} буде відвʼязано`
      : `Різні Telegram: лишиться Telegram профілю, що зберігається (${keep.telegramId}); Telegram дубля (${drop.telegramId}) буде відвʼязано`);
  if (keepTakesDropTg) warnings.push("Профіль, що лишається, звільнений — після злиття він стане активним (дубль активний)");
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)).rows[0] as any)?.n ?? 0);
  if (await one(sql`SELECT count(*)::int AS n FROM worker_questionnaires WHERE worker_id IN (${keepId}, ${dropId})`) === 2)
    warnings.push("Анкета є в обох профілях — лишиться анкета профілю, що зберігається, анкета дубля зникне");
  const svClash = await one(sql`SELECT count(*)::int AS n FROM svodni_rows d WHERE d.worker_id = ${dropId} AND d.segment_of IS NULL AND EXISTS (
    SELECT 1 FROM svodni_rows k WHERE k.worker_id = ${keepId} AND k.segment_of IS NULL AND k.period_month = d.period_month AND k.factory_label = d.factory_label)`);
  if (svClash) warnings.push(`Сводна: ${svClash} рядк(и) дубля за той самий місяць і фабрику, що вже є в профілі — перенесуться як є, після злиття в сводній буде два рядки людини (прибрати вручну)`);
  const hClash = await one(sql`SELECT count(*)::int AS n FROM factory_hours d WHERE d.worker_id = ${dropId} AND EXISTS (
    SELECT 1 FROM factory_hours k WHERE k.worker_id = ${keepId} AND k.month = d.month AND k.factory_id IS NOT DISTINCT FROM d.factory_id)`);
  if (hClash) warnings.push(`Години фабрик: ${hClash} місяць(і) є в обох — лишаться години профілю, що зберігається`);
  return { keep, drop, moves, warnings };
}
