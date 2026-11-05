// Звільнення з обліку годин — задачею графіковому, а не одразу (рішення власника 05.11.2026).
// Інцидент: на початку листопада з вікна «Люди без годин цього місяця» 29 людей звільнили однією
// датою 01.10, хоча останні зміни були 4–28.09 → 22 умови закрито не тією датою, 26 задач ZWUA з
// «виреєстрування 02.10», документи звільнення з неправильним періодом.
// Тепер «звільнити» на /hours (і з вікна «без годин», і для виділених рядків) нікого не звільняє:
//   • людина ховається з місяця (hours_month_exclusions.reason = fire_pending; реальні дані рядок
//     повернуть самі);
//   • графіковому фабрики (resolveAssignee, useScheduler) — групова задача на фабрику зі списком
//     людей в autoParams.workers. По кожній людині видно останній слід (services/lastActivity.ts)
//     і дії: «Звільнити з дати» (endWorkerAtFactory → fireWorker, якщо це єдина фабрика),
//     «Працює далі», «Відпустка», «Ще не приступив».
// Рядок з `check` — людина ВЖЕ звільнена, перевіряється сама дата: «Змінити дату»
// (changeFireDate — умови, задача ZWUA й ненадіслані документи оновлюються слідом) або «Дата правильна».
// Задача закривається, коли список порожній. Одна відкрита задача на фабрику (пошук за префіксом
// `fr:<фабрика>:`, виконавець міг змінитись); ключ нової — `fr:<фабрика>:<виконавець>:<суфікс>`
// (source_key глобально unique — урок UA-синку 18.09–08.10.2026).
import { db, tasksTable, workersTable, factoriesTable, workerChangesTable, hoursMonthExclusionsTable, type Task } from "@workspace/db";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { addDaysStr } from "../lib/dates";
import { createTask, logTaskEvent, resolveAssignee, adminName, warsawToday, fmtDate, mdEsc, taskPanelUrl, OPEN_STATUSES } from "./tasks";
import { normalizeChecklist } from "./taskUtils";
import { notifyAdminById } from "../bot/notify";
import { loadLastActivity, type LastActivity } from "./lastActivity";
import { logger } from "../lib/logger";

export const FR_RULE = "fire_review";
export const FR_SOURCE = `auto:${FR_RULE}`;
export const FIRE_PENDING = "fire_pending"; // причина виключення з місяця: «очікує звільнення»
const DUE_DAYS = 3;
const FR_LOCK_NS = 7405; // простір advisory-локів задач цього правила

// month — місяць обліку, з якого людину передано; months — ще місяці, якщо її передали повторно до рішення
export interface FrWorker { id: number; name: string; factoryId: number | null; month: string | null; months?: string[]; check?: boolean; addedAt: string }
const monthsOf = (w: FrWorker): string[] => [...new Set([w.month, ...(w.months ?? [])].filter((m): m is string => !!m))];
export interface FrDone { id: number; name: string; outcome: "fired" | "factory_end" | "keep" | "vacation" | "not_started" | "date" | "date_ok" | "gone"; date?: string | null; by?: number | null }
export type FrParams = { grouped: true; workers: FrWorker[]; done: FrDone[]; count: number; workerNames: string[]; workerIds: number[] };
export interface FrContextRow extends FrWorker { active: boolean; firedDate: string | null; last: LastActivity | null; otherFactories: number }

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const paramsOf = (t: Task): FrParams => {
  const p = (t.autoParams ?? {}) as Partial<FrParams>;
  return { grouped: true, workers: Array.isArray(p.workers) ? p.workers : [], done: Array.isArray(p.done) ? p.done : [], count: 0, workerNames: [], workerIds: [] };
};
const titleFor = (workers: FrWorker[], factoryName: string | null) => {
  const n = workers.length, where = factoryName ? ` — ${factoryName}` : "";
  return workers.every(w => w.check) ? `Перевірити дату звільнення: ${n} люд.${where}` : `Перевірити й звільнити: ${n} люд. без годин${where}`;
};
const DESCRIPTION = [
  "Цих людей передано на звільнення з обліку годин: за місяць у них немає ні годин з файлу фабрики, ні рапорту, ні явок.",
  "Перевірте по кожній людині, від коли вона точно не працює (останній слід — у списку), і звільніть датою ОСТАННЬОГО РОБОЧОГО ДНЯ.",
  "Якщо людина працює далі, у відпустці або ще не приступила — виберіть це замість звільнення.",
].join("\n");
const DESCRIPTION_CHECK = [
  "Цих людей уже звільнено з обліку годин однією спільною датою — її треба перевірити.",
  "Звірте з останнім слідом у списку і виправте дату звільнення на ОСТАННІЙ РОБОЧИЙ ДЕНЬ: кінець умов, задача ZWUA і ще не надіслані документи звільнення оновляться самі.",
].join("\n");

const keyPrefix = (factoryId: number | null, assigneeId: number | null) => `fr:${factoryId ?? 0}:${assigneeId ?? 0}`;
// Відкрита задача ФАБРИКИ — хто б не був її виконавцем: графікового фабрики могли змінити або
// задачу перепризначили, і нові люди мають доповнити той самий список, а не розійтись по двох.
async function openTaskFor(factoryId: number | null): Promise<Task | undefined> {
  const [ex] = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.source, FR_SOURCE), inArray(tasksTable.status, OPEN_STATUSES), like(tasksTable.sourceKey, `fr:${factoryId ?? 0}:%`)))
    .orderBy(desc(tasksTable.id)).limit(1);
  return ex;
}

async function factoryNameOf(factoryId: number | null): Promise<string | null> {
  if (factoryId == null) return null;
  const [f] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  return f?.name ?? null;
}

// «Знайти відкриту задачу фабрики або створити» — по одному запиту на фабрику за раз: два одночасні
// передавання інакше створили б дві задачі з незалежними списками.
async function withGroupLock<T>(factoryId: number | null, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FR_LOCK_NS + 1}, ${factoryId ?? 0})`);
    return fn();
  });
}

const paramsWith = (workers: FrWorker[], done: FrDone[]): FrParams => ({ grouped: true, workers, done, count: workers.length, workerNames: workers.map(w => w.name).slice(0, 15), workerIds: workers.map(w => w.id) });

// Атомарна зміна списку: він живе в jsonb, тож читання-зміна-запис іде під advisory-локом задачі —
// інакше два рішення поспіль (подвійний клік, двоє людей у задачі, нічний синк) затерли б одне одного.
// fn повертає новий список або null («нічого не міняти»). Закриту задачу не чіпаємо.
async function mutateList(taskId: number, fn: (p: FrParams) => { workers: FrWorker[]; done: FrDone[] } | null): Promise<{ task: Task; workers: FrWorker[]; done: FrDone[] } | null> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FR_LOCK_NS}, ${taskId})`);
    const [t] = await tx.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!t || !OPEN_STATUSES.includes(t.status as any)) return null;
    const next = fn(paramsOf(t));
    if (!next) return null;
    await tx.update(tasksTable).set({ autoParams: paramsWith(next.workers, next.done), updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
    return { task: t, ...next };
  });
}

// Після зміни списку: порожній → задача закрита (actor — «виконано», система — auto_resolved) +
// підсумок автору; непорожній — заголовок з новою кількістю.
async function afterWrite(t: Task, workers: FrWorker[], done: FrDone[], actorAdminId: number | null): Promise<void> {
  if (!workers.length) {
    const note = summaryOf(done);
    const to = actorAdminId != null ? "done" : "auto_resolved";
    const [closed] = await db.update(tasksTable).set({ status: to, completedAt: new Date(), completedById: actorAdminId, resolutionNote: note, updatedAt: new Date() })
      .where(and(eq(tasksTable.id, t.id), inArray(tasksTable.status, OPEN_STATUSES))).returning({ id: tasksTable.id });
    if (!closed) return; // уже закрита паралельним запитом
    await logTaskEvent(t.id, actorAdminId != null ? "status" : "auto_resolved", actorAdminId, { from: t.status, to, note });
    if (t.creatorAdminId && t.creatorAdminId !== actorAdminId) {
      await notifyAdminById(t.creatorAdminId, "tasks", `✅ *Звільнення перевірено*: ${mdEsc(t.title)}\n${mdEsc(note)}`, { parse_mode: "Markdown" }).catch(() => {});
    }
    return;
  }
  await db.update(tasksTable).set({ title: titleFor(workers, await factoryNameOf(t.factoryId)), updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
}

function summaryOf(done: FrDone[]): string {
  const n = (o: FrDone["outcome"][]) => done.filter(d => o.includes(d.outcome)).length;
  const parts = [
    n(["fired", "factory_end"]) && `звільнено ${n(["fired", "factory_end"])}`,
    n(["keep"]) && `працюють далі ${n(["keep"])}`,
    n(["vacation", "not_started"]) && `відпустка / не приступили ${n(["vacation", "not_started"])}`,
    n(["date"]) && `дату виправлено ${n(["date"])}`,
    n(["date_ok"]) && `дата правильна ${n(["date_ok"])}`,
    n(["gone"]) && `вирішено поза задачею ${n(["gone"])}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "по всіх людях прийнято рішення";
}

// factoryAllowed — скоуп автора (routes): задача ставиться лише на фабрику, до якої він має доступ
export interface FireReviewRequest { items: { workerId: number; factoryId?: number | null }[]; month: string | null; actorAdminId: number | null; check?: boolean; factoryAllowed?: (factoryId: number | null) => boolean }
export interface FireReviewTaskInfo { taskId: number; factoryId: number | null; factoryName: string | null; assigneeAdminId: number | null; assigneeName: string; added: number; mine: boolean }

// Передати людей на звільнення (check=false: активні, ховаються з місяця) або на перевірку дати
// вже звільнених (check=true). Одна відкрита задача на фабрику×виконавця — нові люди доповнюють її.
export async function requestFireReview(req: FireReviewRequest): Promise<FireReviewTaskInfo[]> {
  const check = !!req.check;
  const ids = [...new Set(req.items.map(i => i.workerId).filter(Boolean))];
  if (!ids.length) return [];
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, isActive: workersTable.isActive, status: workersTable.status, factoryId: workersTable.factoryId })
    .from(workersTable).where(inArray(workersTable.id, ids));
  const today = warsawToday();
  const { liveFactoriesOf } = await import("./workerFire");
  const byFactory = new Map<number | null, FrWorker[]>();
  for (const w of workers) {
    if (check ? (w.isActive || w.status !== "fired") : !w.isActive) continue;
    const asked = req.items.find(i => i.workerId === w.id)?.factoryId ?? null;
    // фабрика рядка — лише якщо людина справді там працює; інакше основна. Автор зі скоупом — лише
    // свої фабрики: чужа основна замінюється чинною фабрикою з його скоупу, а без такої людину пропускаємо
    let factoryId = w.factoryId;
    const allowed = req.factoryAllowed ?? (() => true);
    if (!check) {
      const live = (await liveFactoriesOf(w, today)).map(f => f.factoryId);
      if (asked != null && asked !== w.factoryId && live.includes(asked)) factoryId = asked;
      if (!allowed(factoryId)) { const mine = live.find(f => allowed(f)); if (mine == null) continue; factoryId = mine; }
    } else if (!allowed(factoryId)) continue;
    const list = byFactory.get(factoryId) ?? [];
    list.push({ id: w.id, name: w.fullName, factoryId, month: req.month, ...(check ? { check: true } : {}), addedAt: today });
    byFactory.set(factoryId, list);
  }
  const out: FireReviewTaskInfo[] = [];
  const who = await adminName(req.actorAdminId);
  for (const [factoryId, add] of byFactory) {
    const factoryName = await factoryNameOf(factoryId);
    const info = await withGroupLock(factoryId, async () => {
    const ex = await openTaskFor(factoryId);
    // наявна задача — її виконавець (могли перепризначити); нова — графіковий фабрики
    const assignee = ex ? ex.assigneeAdminId : await resolveAssignee({ factoryId, ruleCode: FR_RULE, useScheduler: true });
    let task: Task;
    let added = add.length;
    let merged: Awaited<ReturnType<typeof mutateList>> = null;
    let fresh: FrWorker[] = add;
    let stillOpen = false; // задачу могли закрити між пошуком і локом — тоді нова
    if (ex) {
      merged = await mutateList(ex.id, cur => {
        stillOpen = true;
        fresh = add.filter(a => !cur.workers.some(w => w.id === a.id));
        // людину вже передано за інший місяць — дописуємо місяць у її рядок (виключення ставиться нижче на обидва)
        let touched = false;
        const workers = cur.workers.map(w => {
          const again = add.find(a => a.id === w.id);
          if (!again?.month || monthsOf(w).includes(again.month)) return w;
          touched = true;
          return { ...w, months: [...(w.months ?? []), again.month] };
        });
        return fresh.length || touched ? { workers: [...workers, ...fresh], done: cur.done } : null;
      });
    }
    if (ex && stillOpen) {
      added = fresh.length;
      if (merged) {
        await afterWrite(merged.task, merged.workers, merged.done, req.actorAdminId);
        if (fresh.length) await logTaskEvent(ex.id, "action", req.actorAdminId, { code: "fr_add", message: `додано до списку: ${fresh.map(w => w.name).join(", ")}` });
      }
      task = ex;
    } else {
      task = await createTask({
        kind: "task", title: titleFor(add, factoryName), description: add.every(w => w.check) ? DESCRIPTION_CHECK : DESCRIPTION, priority: "high", dueAt: addDaysStr(today, DUE_DAYS),
        assigneeAdminId: assignee, factoryId, source: FR_SOURCE, sourceKey: `${keyPrefix(factoryId, assignee)}:${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
        autoParams: { grouped: true, workers: add, done: [], count: add.length, workerNames: add.map(w => w.name).slice(0, 15), workerIds: add.map(w => w.id) } satisfies FrParams,
        checklist: normalizeChecklist([{ id: "", text: "По кожній людині зі списку: перевірити останній робочий день і прийняти рішення (список «Чекають рішення»)", done: false, auto: "all_done" }]),
        notify: false,
      }, req.actorAdminId);
    }
    if (added && assignee && assignee !== req.actorAdminId) {
      const names = fresh.map(w => w.name);
      const text = `🔥 *${check ? "Перевірити дату звільнення" : "На звільнення з обліку годин"}*${factoryName ? ` — ${mdEsc(factoryName)}` : ""}\n${mdEsc(who)} передав(ла) ${fresh.length} люд.: ${mdEsc(names.slice(0, 10).join(", "))}${names.length > 10 ? ` і ще ${names.length - 10}` : ""}\n`
        + (check ? "Звірте останній робочий день і виправте дату звільнення." : "Нікого ще не звільнено — перевірте, від коли людина не працює, і звільніть датою останнього робочого дня.");
      const url = taskPanelUrl();
      await notifyAdminById(assignee, "tasks", text, { parse_mode: "Markdown", ...(url ? { reply_markup: { inline_keyboard: [[{ text: "🔗 Відкрити задачу", url: `${url}/tasks?task=${task.id}` }]] } } : {}) })
        .catch((e: any) => logger.warn({ err: e?.message, taskId: task.id }, "fire review notify failed"));
    }
    if (!check && req.month) {
      for (const w of add) {
        await db.insert(hoursMonthExclusionsTable).values({ workerId: w.id, month: req.month, reason: FIRE_PENDING })
          .onConflictDoUpdate({ target: [hoursMonthExclusionsTable.workerId, hoursMonthExclusionsTable.month], set: { reason: FIRE_PENDING } });
      }
    }
    return { taskId: task.id, factoryId, factoryName, assigneeAdminId: assignee, assigneeName: await adminName(assignee), added, mine: assignee != null && assignee === req.actorAdminId };
    });
    out.push(info);
  }
  logger.info({ check, month: req.month, actorAdminId: req.actorAdminId, tasks: out.map(o => ({ id: o.taskId, added: o.added })) }, "fire review requested");
  return out;
}

async function firedDates(workerIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!workerIds.length) return out;
  const rows = await db.select({ workerId: workerChangesTable.workerId, d: workerChangesTable.effectiveDate, id: workerChangesTable.id }).from(workerChangesTable)
    .where(and(inArray(workerChangesTable.workerId, workerIds), eq(workerChangesTable.field, "fired"))).orderBy(workerChangesTable.id);
  for (const r of rows) if (r.d) out.set(r.workerId, String(r.d).slice(0, 10)); // останній запис перемагає
  return out;
}

// Контекст задачі: живий стан кожної людини. Рядки, що втратили сенс (людину зі списку «на
// звільнення» вже звільнили з профілю / звільненого зі списку «перевірити дату» повернули), зникають
// самі; порожній список закриває задачу.
export async function frContext(task: Task): Promise<{ rows: FrContextRow[]; done: FrDone[] }> {
  const p = paramsOf(task);
  const ids = p.workers.map(w => w.id);
  if (!ids.length) return { rows: [], done: p.done };
  const ws = new Map((await db.select({ id: workersTable.id, isActive: workersTable.isActive, status: workersTable.status, factoryId: workersTable.factoryId, firedAt: workersTable.firedAt })
    .from(workersTable).where(inArray(workersTable.id, ids))).map(w => [w.id, w]));
  const keep: FrWorker[] = [], gone: FrDone[] = [];
  for (const r of p.workers) {
    const w = ws.get(r.id);
    const stale = !w || (r.check ? w.isActive : !w.isActive);
    if (stale) gone.push({ id: r.id, name: r.name, outcome: "gone" }); else keep.push(r);
  }
  if (gone.length && OPEN_STATUSES.includes(task.status as any)) {
    const goneIds = new Set(gone.map(g => g.id));
    const r = await mutateList(task.id, cur => ({ workers: cur.workers.filter(w => !goneIds.has(w.id)), done: [...cur.done, ...gone.filter(g => cur.workers.some(w => w.id === g.id))] }));
    if (r) { await afterWrite(r.task, r.workers, r.done, null); task.autoParams = paramsWith(r.workers, r.done); }
  }
  const fired = await firedDates(keep.filter(w => w.check).map(w => w.id));
  const { liveFactoriesOf } = await import("./workerFire");
  const today = warsawToday();
  const othersOf = new Map<number, number>();
  for (const r of keep) {
    const w = ws.get(r.id)!;
    othersOf.set(r.id, r.check ? 0 : (await liveFactoriesOf({ id: w.id, factoryId: w.factoryId }, today)).filter(f => f.factoryId !== r.factoryId).length);
  }
  // людина на кількох фабриках: слід лише з фабрики рядка (явки на іншій не кажуть, коли вона пішла з цієї)
  const onlyFactory = new Map(keep.filter(r => r.factoryId != null && (othersOf.get(r.id) ?? 0) > 0).map(r => [r.id, r.factoryId!]));
  const last = await loadLastActivity(keep.map(w => w.id), onlyFactory);
  const rows: FrContextRow[] = [];
  for (const r of keep) {
    const w = ws.get(r.id)!;
    const others = othersOf.get(r.id) ?? 0;
    rows.push({ ...r, active: w.isActive, firedDate: fired.get(r.id) ?? (w.firedAt ? w.firedAt.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }) : null), last: last.get(r.id) ?? null, otherFactories: others });
  }
  return { rows, done: [...p.done, ...gone] };
}

async function resolveRow(task: Task, workerId: number, actorAdminId: number, done: Omit<FrDone, "id" | "name" | "by">): Promise<void> {
  const r = await mutateList(task.id, cur => {
    const row = cur.workers.find(w => w.id === workerId);
    return row ? { workers: cur.workers.filter(w => w.id !== workerId), done: [...cur.done, { id: row.id, name: row.name, by: actorAdminId, ...done }] } : null;
  });
  if (r) await afterWrite(r.task, r.workers, r.done, actorAdminId);
}

// Задачу закрили вручну («Виконано» / «Скасувати» в панелі чи боті), а в списку лишились люди без
// рішення: їх ніхто не звільнив — повертаємо в облік місяця, інакше вони назавжди «очікують звільнення».
export async function frOnClosed(task: Task): Promise<void> {
  if (task.source !== FR_SOURCE) return;
  const left = paramsOf(task).workers.filter(w => !w.check && monthsOf(w).length);
  for (const w of left) {
    await db.delete(hoursMonthExclusionsTable).where(and(eq(hoursMonthExclusionsTable.workerId, w.id), inArray(hoursMonthExclusionsTable.month, monthsOf(w)), eq(hoursMonthExclusionsTable.reason, FIRE_PENDING)));
  }
  if (left.length) {
    await logTaskEvent(task.id, "action", null, { code: "fr_released", message: `задачу закрито без рішення по: ${left.map(w => w.name).join(", ")} — повернуто в облік місяця` });
    logger.info({ taskId: task.id, released: left.map(w => w.id) }, "fire review closed with undecided people");
  }
}

function rowOf(task: Task, workerId: number): FrWorker {
  const row = paramsOf(task).workers.find(w => w.id === workerId);
  if (!row) throw new Error("Цієї людини вже немає у списку задачі");
  return row;
}
function checkDate(date: unknown): string {
  if (!isDate(date)) throw new Error("Вкажіть дату — останній робочий день людини");
  if (date > warsawToday()) throw new Error("Дата звільнення не може бути в майбутньому");
  return date;
}

// «Звільнити з дати»: з фабрики рядка (інші фабрики людини лишаються); єдина фабрика = повне звільнення.
export async function frFire(task: Task, workerId: number, dateRaw: unknown, actor: { adminId: number }): Promise<string> {
  const row = rowOf(task, workerId);
  if (row.check) throw new Error("Людину вже звільнено — тут можна лише виправити дату");
  const date = checkDate(dateRaw);
  const { fireWorker, endWorkerAtFactory, liveFactoriesOf } = await import("./workerFire");
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) throw new Error("Працівника не знайдено");
  if (!w.isActive) { await resolveRow(task, workerId, actor.adminId, { outcome: "gone" }); return `${row.name}: уже звільнено раніше — прибрано зі списку`; }
  const live = await liveFactoriesOf(w, date);
  let whole = true;
  if (row.factoryId != null && live.some(f => f.factoryId === row.factoryId)) {
    const r = await endWorkerAtFactory({ workerId, factoryId: row.factoryId, date, adminId: actor.adminId, source: "hours" });
    if (!r.ok) throw new Error(r.error);
    whole = r.firedWhole;
  } else if (live.length) {
    throw new Error("Людина вже не працює на цій фабриці (перевели на іншу) — приберіть її зі списку кнопкою «Працює далі»");
  } else {
    const r = await fireWorker({ workerId, date, adminId: actor.adminId, source: "hours" });
    if (!r.ok) throw new Error(r.error);
  }
  // знято лише з цієї фабрики — людина активна на іншій, а виключення місяця діє на всі її фабрики
  // (unique worker×month): прибираємо, інакше вона зникла б і з обліку фабрики, де працює
  if (!whole && monthsOf(row).length) {
    await db.delete(hoursMonthExclusionsTable).where(and(eq(hoursMonthExclusionsTable.workerId, workerId), inArray(hoursMonthExclusionsTable.month, monthsOf(row)), eq(hoursMonthExclusionsTable.reason, FIRE_PENDING)));
  }
  await resolveRow(task, workerId, actor.adminId, { outcome: whole ? "fired" : "factory_end", date });
  return whole ? `${row.name}: звільнено з ${fmtDate(date)}` : `${row.name}: знято з фабрики з ${fmtDate(date)} — на інших фабриках працює далі`;
}

// «Працює далі» / «Відпустка» / «Ще не приступив»: нікого не звільняємо; позначка місяця — за вибором.
export async function frKeep(task: Task, workerId: number, reason: "keep" | "vacation" | "not_started", actor: { adminId: number }): Promise<string> {
  const row = rowOf(task, workerId);
  if (row.check) throw new Error("Людину вже звільнено — тут можна лише виправити дату");
  const months = monthsOf(row);
  if (months.length) {
    const mine = and(eq(hoursMonthExclusionsTable.workerId, workerId), inArray(hoursMonthExclusionsTable.month, months), eq(hoursMonthExclusionsTable.reason, FIRE_PENDING));
    if (reason === "keep") await db.delete(hoursMonthExclusionsTable).where(mine);
    else await db.update(hoursMonthExclusionsTable).set({ reason }).where(mine);
  }
  await resolveRow(task, workerId, actor.adminId, { outcome: reason });
  return reason === "keep" ? `${row.name}: працює далі — повернуто в облік місяця` : reason === "vacation" ? `${row.name}: відпустка — місяць поза обліком` : `${row.name}: ще не приступив — місяць поза обліком`;
}

// Уже звільнений: виправити дату (changeFireDate оновлює умови, ZWUA й ненадіслані документи) або підтвердити.
export async function frDate(task: Task, workerId: number, dateRaw: unknown, actor: { adminId: number }): Promise<string> {
  const row = rowOf(task, workerId);
  if (!row.check) throw new Error("Людину ще не звільнено — спершу «Звільнити з дати»");
  const date = checkDate(dateRaw);
  const { changeFireDate } = await import("./workerFire");
  const r = await changeFireDate(workerId, date, actor.adminId);
  if (!r.ok) throw new Error(r.error);
  await resolveRow(task, workerId, actor.adminId, { outcome: "date", date });
  const extra = [
    r.contracts ? `умов перенесено: ${r.contracts}` : "",
    r.zwuaTasks ? `задач ZWUA оновлено: ${r.zwuaTasks}` : "",
    r.docsRegenerated ? `документів перегенеровано: ${r.docsRegenerated}` : "",
    r.staleDocs.length ? `⚠ уже надіслані/підписані документи зі старою датою: ${r.staleDocs.length} — перевірте в профілі` : "",
  ].filter(Boolean).join("; ");
  return `${row.name}: дата звільнення ${r.from ? fmtDate(r.from) : "—"} → ${fmtDate(date)}${extra ? ` (${extra})` : ""}`;
}
export async function frDateOk(task: Task, workerId: number, actor: { adminId: number }): Promise<string> {
  const row = rowOf(task, workerId);
  if (!row.check) throw new Error("Людину ще не звільнено");
  await resolveRow(task, workerId, actor.adminId, { outcome: "date_ok" });
  return `${row.name}: дату звільнення підтверджено`;
}

// Нічний синк: рядки, що втратили сенс, зникають; порожні задачі закриваються самі.
export async function syncFireReviewTasks(): Promise<number> {
  const open = await db.select().from(tasksTable).where(and(eq(tasksTable.source, FR_SOURCE), inArray(tasksTable.status, OPEN_STATUSES)));
  let resolved = 0;
  for (const t of open) {
    try { const c = await frContext(t); if (!c.rows.length) resolved++; }
    catch (e: any) { logger.warn({ err: e?.message, taskId: t.id }, "fire review sync failed"); }
  }
  return resolved;
}
