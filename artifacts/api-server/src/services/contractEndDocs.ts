// Кінець умови й документи звільнення (рішення власника 10.09.2026):
//   • умова закінчилась (date_to настав), працівник активний, чинної наступної умови/аннексу на цю
//     фабрику нема → графіковій ЗАДАЧА-РІШЕННЯ (правило contract_end, taskAutoRules): «звільнити»
//     (fireWorker датою кінця умови) або «продовжити аннексом» (POST /contracts/:id/annex → документ
//     kind=aneks на підпис; після підпису date_to оригінальної умови подовжується — finalize);
//   • при ЗВІЛЬНЕННІ (terminationFlow) на кожну підписану умову: zaświadczenie o zatrudnieniu
//     (kind=zaswiadczenie, печатка фірми одразу → approved → задача «на підпис»); якщо звільнення
//     раніше кінця умови (або умова безстрокова) — ще wypowiedzenie umowy zlecenia від імені
//     ПРАЦІВНИКА (kind=wypowiedzenie, без печатки, працівник підписує). Świadectwo pracy не видаємо.
// Після підпису працівника фірма підписує автоматично (DATA_AUTO_FINALIZE, routes/sign.ts).
// Один документ на (умова, вид): sourceKey `<вид>:<contractId>` у задачі — замок (unique).
import { db, contractsTable, contractFilesTable, documentTemplatesTable, tasksTable, workersTable, factoriesTable, companiesTable } from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, lte, ne, or, isNull, gt, sql } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { createTask, resolveAssignee, warsawToday, dateStr, mdEsc, OPEN_STATUSES } from "./tasks";
import { normalizeChecklist } from "./taskUtils";
import { generateContract, stampDraftWithCompany, sendContractForSignature, EVENT_KINDS, DATA_AUTO_FINALIZE, DATA_SOURCE_CONTRACT, DATA_EXTENDS_CONTRACT } from "./contracts";
import { notifyAdminById } from "../bot/notify";
import { logger } from "../lib/logger";

export const ZASW_KIND = "zaswiadczenie";
export const WYPOW_KIND = "wypowiedzenie";
export const ANEKS_KIND = "aneks";
const LOOKBACK_DAYS = 30; // умови, що закінчились давніше, не бекфілимо (модуль запустився 08.09.2026)

type Tpl = typeof documentTemplatesTable.$inferSelect;
// найспецифічніший активний шаблон виду для фірми/фабрики умови (factory > company > all), як у
// resolveDocumentSet — generateContract з явними templateIds scope не фільтрує
export async function pickEventTemplate(kind: string, factoryId: number | null, companyId: number | null): Promise<Tpl | null> {
  const tpls = await db.select().from(documentTemplatesTable).where(and(eq(documentTemplatesTable.kind, kind), eq(documentTemplatesTable.isActive, true)));
  const score = (t: Tpl) =>
    t.scope === "factory" && factoryId != null && (t.scopeFactoryIds as number[]).includes(factoryId) ? 3
    : t.scope === "company" && companyId != null && (t.scopeCompanyIds as number[]).includes(companyId) ? 2
    : t.scope === "all" ? 1 : 0;
  return tpls.map(t => ({ t, s: score(t) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s)[0]?.t ?? null;
}

// id умов, чиї файли — подієві документи (самі не «умови»)
async function eventContractIds(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  return new Set((await db.select({ contractId: contractFilesTable.contractId })
    .from(contractFilesTable).innerJoin(documentTemplatesTable, eq(contractFilesTable.templateId, documentTemplatesTable.id))
    .where(and(inArray(contractFilesTable.contractId, ids), inArray(documentTemplatesTable.kind, [...EVENT_KINDS])))).map(r => r.contractId));
}

// ── Кандидати правила contract_end (для taskAutoRules.collectCandidates) ──────────────────
export interface ContractEndCandidate { contractId: number; workerId: number; workerName: string; factoryId: number; factoryName: string; dateTo: string; companyId: number | null }
export async function collectContractEndCandidates(today = warsawToday()): Promise<ContractEndCandidate[]> {
  const ended = await db.select({ c: contractsTable, workerName: workersTable.fullName, isActive: workersTable.isActive, factoryName: factoriesTable.name })
    .from(contractsTable).innerJoin(workersTable, eq(contractsTable.workerId, workersTable.id)).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(and(eq(contractsTable.status, "signed"), isNotNull(contractsTable.factoryId), isNotNull(contractsTable.dateTo),
      lte(contractsTable.dateTo, today), gte(contractsTable.dateTo, addDaysStr(today, -LOOKBACK_DAYS)), eq(workersTable.isActive, true)));
  if (!ended.length) return [];
  const events = await eventContractIds(ended.map(r => r.c.id));
  const out: ContractEndCandidate[] = [];
  for (const r of ended) {
    if (events.has(r.c.id)) continue;
    // чинна наступна умова на ту саму фабрику (нова умова або підписаний аннекс подовжив цю) → не кандидат
    const [successor] = await db.select({ id: contractsTable.id }).from(contractsTable).where(and(
      eq(contractsTable.workerId, r.c.workerId), eq(contractsTable.factoryId, r.c.factoryId!), eq(contractsTable.status, "signed"), ne(contractsTable.id, r.c.id),
      or(isNull(contractsTable.dateTo), gt(contractsTable.dateTo, today)))).limit(1);
    if (successor) continue;
    // аннекс уже в дорозі (згенеровано/надіслано, ще не підписано) — задача лишається, але без дубля
    out.push({ contractId: r.c.id, workerId: r.c.workerId, workerName: r.workerName, factoryId: r.c.factoryId!, factoryName: r.factoryName ?? `#${r.c.factoryId}`, dateTo: dateStr(r.c.dateTo)!, companyId: r.c.companyId ?? null });
  }
  return out;
}

// Правило власника 10.09.2026 для zaświadczenia ES GROUP: один клієнт у періоді → «u klienta: <фабрика>»,
// кілька → «w <фірма> (różni klienci)». Аутсорсингові фірми користуються шаблоном без цього
// плейсхолдера (лише okres zatrudnienia). Рахуємо по підписаних умовах працівника цієї фірми, що
// перетинають період (подієві документи не рахуються).
async function workplacePhrase(workerId: number, companyId: number | null, from: string | null, to: string): Promise<string> {
  const rows = await db.select({ id: contractsTable.id, factoryId: contractsTable.factoryId, dateFrom: contractsTable.dateFrom, dateTo: contractsTable.dateTo, fname: factoriesTable.name })
    .from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(and(eq(contractsTable.workerId, workerId), eq(contractsTable.status, "signed"), isNotNull(contractsTable.factoryId), companyId != null ? eq(contractsTable.companyId, companyId) : sql`true`));
  const events = await eventContractIds(rows.map(r => r.id));
  const names = new Set<string>();
  for (const r of rows) {
    if (events.has(r.id)) continue;
    const f = dateStr(r.dateFrom), t = dateStr(r.dateTo);
    if ((t && from && t < from) || (f && f > to)) continue; // не перетинається з періодом
    if (r.fname) names.add(r.fname);
  }
  if (names.size === 1) return `u klienta: ${[...names][0]}`;
  const [co] = companyId != null ? await db.select({ legalName: companiesTable.legalName, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId)) : [];
  return names.size > 1 ? `w ${co?.legalName ?? co?.name ?? "firmie"} (różni klienci)` : "";
}

// ── Документ звільнення для ОДНІЄЇ умови: zaświadczenie (з печаткою) або wypowiedzenie ──────
async function issueEventDoc(opts: {
  kind: string; contract: typeof contractsTable.$inferSelect; worker: { id: number; fullName: string }; dateTo: string;
  title: string; checklistFirst: string; stamp: boolean; actorAdminId: number | null;
}): Promise<boolean> {
  const { contract: c, worker } = opts;
  const key = `${opts.kind}:${c.id}`;
  const legacyKey = opts.kind === ZASW_KIND ? `zasw:${c.id}` : null; // ключ першої версії крону (10.09)
  const [exists] = await db.select({ id: tasksTable.id }).from(tasksTable).where(legacyKey ? inArray(tasksTable.sourceKey, [key, legacyKey]) : eq(tasksTable.sourceKey, key));
  if (exists) return false;
  const tpl = await pickEventTemplate(opts.kind, c.factoryId, c.companyId ?? null);
  if (!tpl) return false;
  const assignee = await resolveAssignee({ factoryId: c.factoryId, ruleCode: "termination_doc", useScheduler: true });
  // СПЕРШУ задача (unique source_key = замок), потім документ; збій генерації → задачу прибираємо
  let task: { id: number };
  try {
    task = await createTask({
      kind: "task", title: opts.title, priority: "normal", dueAt: addDaysStr(warsawToday(), 3), assigneeAdminId: assignee,
      workerId: worker.id, factoryId: c.factoryId, source: "auto:termination_doc", sourceKey: key,
      autoParams: { workerName: worker.fullName, forContractId: c.id, dateFrom: dateStr(c.dateFrom), dateTo: opts.dateTo, signRequired: true, docKind: opts.kind },
      checklist: normalizeChecklist([{ id: "", text: opts.checklistFirst, done: false }, { id: "", text: "Надіслати працівнику на підпис", done: false, auto: "sent" }]),
      notify: false,
    }, opts.actorAdminId);
  } catch { return false; }
  try {
    const doc = await generateContract({
      workerId: worker.id, factoryId: c.factoryId, companyId: c.companyId ?? null, templateIds: [tpl.id],
      dateFrom: dateStr(c.dateFrom), dateTo: opts.dateTo, allowUnverified: true,
      extraData: {
        "Data zawarcia umowy": dateStr(c.dateFrom) ?? "", // «umowę zawartą dnia …» — дата оригінальної умови
        "Miejsce pracy zaświadczenia": opts.kind === ZASW_KIND ? await workplacePhrase(worker.id, c.companyId ?? null, dateStr(c.dateFrom), opts.dateTo) : "",
      },
    });
    await db.update(contractsTable).set({
      data: sql`${contractsTable.data} || ${JSON.stringify({ [DATA_AUTO_FINALIZE]: "1", [DATA_SOURCE_CONTRACT]: String(c.id) })}::jsonb`, updatedAt: new Date(),
    }).where(eq(contractsTable.id, doc.id));
    let stamped = false;
    if (opts.stamp) stamped = (await stampDraftWithCompany(doc.id, opts.actorAdminId)).stamped;
    else await db.update(contractsTable).set({ status: "approved", updatedAt: new Date() }).where(eq(contractsTable.id, doc.id));
    await db.update(tasksTable).set({ contractId: doc.id, autoParams: sql`${tasksTable.autoParams} || ${JSON.stringify({ contractId: doc.id, stamped })}::jsonb`, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
    if (assignee) await notifyAdminById(assignee, "tasks", `📄 *${mdEsc(tpl.title)}* — ${mdEsc(worker.fullName)}: документ готовий, надішли на підпис (задача)`, { parse_mode: "Markdown" }).catch(() => {});
    return true;
  } catch (e: any) {
    await db.delete(tasksTable).where(eq(tasksTable.id, task.id)).catch(() => {});
    logger.warn({ err: e?.message, kind: opts.kind, contractId: c.id, workerId: worker.id }, "event document generation failed");
    return false;
  }
}

// При звільненні: для кожної підписаної факторі-умови працівника, що закінчилась не давніше LOOKBACK_DAYS
// (у т.ч. щойно закритої датою звільнення) — zaświadczenie; для умов, закритих РАНІШЕ їхнього кінця
// (earlyContractIds з fireWorker: date_to було порожнє або пізніше за дату) — ще wypowiedzenie.
export async function issueTerminationDocs(worker: { id: number; fullName: string }, fireDate: string, earlyContractIds: number[], actorAdminId: number | null): Promise<{ zaswiadczenie: number; wypowiedzenie: number }> {
  const stats = { zaswiadczenie: 0, wypowiedzenie: 0 };
  const rows = await db.select().from(contractsTable).where(and(
    eq(contractsTable.workerId, worker.id), eq(contractsTable.status, "signed"), isNotNull(contractsTable.factoryId), isNotNull(contractsTable.dateTo),
    gte(contractsTable.dateTo, addDaysStr(fireDate, -LOOKBACK_DAYS)), lte(contractsTable.dateTo, fireDate)));
  const events = await eventContractIds(rows.map(r => r.id));
  for (const c of rows) {
    if (events.has(c.id)) continue;
    if (await issueEventDoc({ kind: ZASW_KIND, contract: c, worker, dateTo: dateStr(c.dateTo)!, stamp: true, actorAdminId,
      title: `Zaświadczenie o zatrudnieniu — надіслати на підпис: ${worker.fullName}`, checklistFirst: "Переглянути zaświadczenie (PDF у задачі, печатка фірми вже стоїть)" })) stats.zaswiadczenie++;
    if (earlyContractIds.includes(c.id) && await issueEventDoc({ kind: WYPOW_KIND, contract: c, worker, dateTo: fireDate, stamp: false, actorAdminId,
      title: `Wypowiedzenie umowy zlecenia (від працівника) — надіслати на підпис: ${worker.fullName}`, checklistFirst: "Переглянути wypowiedzenie (PDF у задачі; підписує працівник)" })) stats.wypowiedzenie++;
  }
  return stats;
}

// ── Аннекс на продовження умови: документ на підпис одразу; після підпису date_to оригіналу
//    подовжується (finalizeContractSignature за DATA_EXTENDS_CONTRACT) ─────────────────────
export async function createContractAnnex(contractId: number, newDateTo: string, adminId: number | null): Promise<typeof contractsTable.$inferSelect & { link: string | null; notified: boolean }> {
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!c) throw new Error("Умову не знайдено");
  if (c.status !== "signed" || c.factoryId == null) throw new Error("Аннекс можна зробити лише до підписаної умови на фабрику");
  if ((await eventContractIds([c.id])).has(c.id)) throw new Error("Це подієвий документ (zaświadczenie/wypowiedzenie/aneks), а не умова — аннекс робиться до самої умови");
  const [wk] = await db.select({ isActive: workersTable.isActive }).from(workersTable).where(eq(workersTable.id, c.workerId));
  if (!wk?.isActive) throw new Error("Працівник звільнений — аннекс неможливий");
  const curTo = dateStr(c.dateTo);
  if (curTo && newDateTo <= curTo) throw new Error(`Нова дата має бути пізніша за поточний кінець умови (${curTo})`);
  const [pending] = await db.select({ id: contractsTable.id }).from(contractsTable).where(and(
    eq(contractsTable.workerId, c.workerId), sql`${contractsTable.data}->>${DATA_EXTENDS_CONTRACT} = ${String(c.id)}`,
    inArray(contractsTable.status, ["draft", "pending_approval", "approved", "sent", "viewed", "worker_signed"]))).limit(1);
  if (pending) throw new Error("Аннекс до цієї умови вже надіслано на підпис — дочекайтесь підпису або скасуйте його");
  const tpl = await pickEventTemplate(ANEKS_KIND, c.factoryId, c.companyId ?? null);
  if (!tpl) throw new Error("Немає активного шаблону «Aneks» у бібліотеці");
  const doc = await generateContract({
    workerId: c.workerId, factoryId: c.factoryId, companyId: c.companyId ?? null, templateIds: [tpl.id],
    dateFrom: dateStr(c.dateFrom), dateTo: newDateTo, allowUnverified: true,
    extraData: { "Data zawarcia umowy": dateStr(c.dateFrom) ?? "", "Poprzednia data zakończenia": curTo ?? "" },
  });
  await db.update(contractsTable).set({
    data: sql`${contractsTable.data} || ${JSON.stringify({ [DATA_AUTO_FINALIZE]: "1", [DATA_EXTENDS_CONTRACT]: String(c.id) })}::jsonb`, updatedAt: new Date(),
  }).where(eq(contractsTable.id, doc.id));
  await stampDraftWithCompany(doc.id, adminId); // печатка фірми одразу (як zaświadczenie) → approved
  const r = await sendContractForSignature(doc.id, adminId, { bundle: false });
  const [fresh] = await db.select().from(contractsTable).where(eq(contractsTable.id, doc.id));
  logger.info({ annexId: doc.id, contractId, newDateTo, adminId, notified: r.notified }, "contract annex sent for signature");
  return { ...fresh!, link: r.link, notified: r.notified };
}

// Відкриті задачі contract_end для працівника — закриваються синком taskAutoRules (кандидат зник),
// тут лише для дії «звільнити» з задачі: перевірити, що умова ще та сама.
export async function contractEndTaskContract(taskContractId: number | null) {
  if (!taskContractId) return null;
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, taskContractId));
  return c ?? null;
}
export { OPEN_STATUSES };
