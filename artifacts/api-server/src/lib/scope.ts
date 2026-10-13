// Доступ адміна по містах/фабриках (01.10.2026, роль «Офіс-менеджер»).
//
// Скоуп живе на людині (admins.scope_cities / scope_factory_ids); обидва порожні =
// без обмежень (req.admin.scope = null). Місто резолвиться через factories.city, тож
// нова фабрика в місті потрапляє в доступ сама.
//
// Модель — «заборонено, поки не дозволено»: адмін зі скоупом проходить ЛИШЕ ендпойнти
// з білого списку нижче (scopeGate). Ендпойнти з id працівника/документа/умови
// перевіряють, що працівник у скоупі; спискові (GET /workers, /legalization,
// /factories) фільтрують самі через workerInScopeSql / factoryIds. Новий ендпойнт,
// потрібний офіс-менеджеру, = рядок у SCOPE_RULES + фільтр у хендлері, якщо він
// повертає список. Сap-гейти діють як і раніше — скоуп їх лише звужує.
import type { Response, NextFunction } from "express";
import { db, factoriesTable, workersTable, workerFactoriesTable, svodniRowsTable,
  workerDocumentsTable, workerBadaniaTable, workerBankAccountsTable, contractsTable,
  advanceRequestsTable, tasksTable, taskAssigneesTable, clothingItemsTable,
  scheduleEntriesTable, unplannedWorkersTable, workerFactoryCodesTable, hoursDisputesTable, absenceRequestsTable,
  svodniClearsTable, workerChangesTable, factoryPayoutRulesTable } from "@workspace/db";
import { and, eq, isNull, or, sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { AuthedRequest } from "./auth";

// cities — нормалізовані (lower pl) для порівнянь у JS; cityNames — «як написано» (скоуп адміна ∪
// factories.city, що збіглися) для точних SQL-порівнянь зі снапшотами міста у сводній (без lower() у
// Postgres — поведінка на кирилиці залежить від колації).
export type AdminScope = { factoryIds: number[]; cities: string[]; cityNames: string[] };

const normCity = (s: string) => s.trim().toLocaleLowerCase("pl");

// Обидва списки порожні → null (без обмежень). Інакше — множина дозволених фабрик
// (може бути порожньою, якщо місто без фабрик: тоді не видно нікого — fail closed).
export async function resolveScope(cities: string[] | null | undefined, factoryIds: number[] | null | undefined): Promise<AdminScope | null> {
  const cs = (cities ?? []).map(normCity).filter(Boolean);
  const ids = new Set((factoryIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0));
  if (!cs.length && !ids.size) return null;
  const names = new Set((cities ?? []).map(c => String(c).trim()).filter(Boolean));
  if (cs.length) {
    const rows = await db.select({ id: factoriesTable.id, city: factoriesTable.city }).from(factoriesTable);
    for (const r of rows) if (r.city && cs.includes(normCity(r.city))) { ids.add(r.id); names.add(r.city.trim()); }
  }
  return { factoryIds: [...ids], cities: cs, cityNames: [...names] };
}

export function factoryInScope(scope: AdminScope | null | undefined, factoryId: number | null | undefined): boolean {
  if (!scope) return true;
  return factoryId != null && scope.factoryIds.includes(Number(factoryId));
}

const idList = (ids: number[]) => sql.join(ids.map(i => sql`${i}`), sql`, `);

// Умова на workers.id: працівник належить дозволеним фабрикам — основна фабрика, будь-яка
// привʼязка worker_factories (і минула — офіс відповідає на питання по старих виплатах)
// або рядок сводної на цю фабрику. Порожній скоуп → false.
export function workerInScopeSql(scope: AdminScope, workerIdCol: SQL | AnyColumn = workersTable.id): SQL {
  if (!scope.factoryIds.length) return sql`false`;
  const ids = idList(scope.factoryIds);
  return sql`(
    EXISTS (SELECT 1 FROM ${workersTable} sw WHERE sw.id = ${workerIdCol} AND sw.factory_id IN (${ids}))
    OR EXISTS (SELECT 1 FROM ${workerFactoriesTable} swf WHERE swf.worker_id = ${workerIdCol} AND swf.factory_id IN (${ids}))
    OR EXISTS (SELECT 1 FROM ${svodniRowsTable} ssr WHERE ssr.worker_id = ${workerIdCol} AND ssr.factory_id IN (${ids}))
  )`;
}

// SQL-умова «фабрика (колонка/вираз) у скоупі»; порожній скоуп → false
export function factoryInScopeSql(scope: AdminScope, factoryCol: SQL | AnyColumn): SQL {
  return scope.factoryIds.length ? sql`${factoryCol} IN (${idList(scope.factoryIds)})` : sql`false`;
}

// Усі id у скоупі (одним запитом); порожній список → true
export async function workersInScope(scope: AdminScope | null | undefined, ids: number[]): Promise<boolean> {
  if (!scope) return true;
  const clean = [...new Set(ids.filter(n => Number.isInteger(n) && n > 0))];
  if (!clean.length) return true;
  if (!scope.factoryIds.length) return false;
  const r: any = await db.execute(sql`SELECT count(*)::int AS n FROM ${workersTable} WHERE ${workersTable.id} IN (${idList(clean)}) AND ${workerInScopeSql(scope)}`);
  return Number((r?.rows ?? r)?.[0]?.n ?? 0) === clean.length;
}

export async function workerInScope(scope: AdminScope | null | undefined, workerId: number | null | undefined): Promise<boolean> {
  if (!scope) return true;
  if (!workerId || !Number.isInteger(workerId)) return false;
  const r: any = await db.execute(sql`SELECT ${workerInScopeSql(scope, sql`${workerId}::int`)} AS ok`);
  return !!(r?.rows ?? r)?.[0]?.ok;
}

// Чинні фабрики працівника поза скоупом (основна ∪ worker_factories без valid_to або з valid_to у
// майбутньому): якщо є — скоуп-адмін не може звільнити людину «з усіх», лише виповідзення по фабриці.
export async function factoriesOutsideScope(scope: AdminScope | null | undefined, workerId: number): Promise<number[]> {
  if (!scope) return [];
  const [w] = await db.select({ factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, workerId));
  const wf = await db.select({ factoryId: workerFactoriesTable.factoryId }).from(workerFactoriesTable)
    .where(and(eq(workerFactoriesTable.workerId, workerId), or(isNull(workerFactoriesTable.validTo), sql`${workerFactoriesTable.validTo} > current_date`)));
  const ids = new Set<number>();
  if (w?.factoryId != null) ids.add(w.factoryId);
  for (const r of wf) ids.add(r.factoryId);
  return [...ids].filter(id => !factoryInScope(scope, id));
}

// ─── Сводна (13.10.2026, роль «Dyrektor» регіону) ──────────────────────────────
// Сводна організована по містах: рядок/лок/очищення живуть у координатах місяць × місто × вкладка-фабрика.
// Область у скоупі = місто рядка серед міст адміна, або фабрика рядка серед його фабрик (скоуп лише по id).
export function svodniCityAllowed(scope: AdminScope, city: string | null | undefined): boolean {
  return !!city && scope.cities.includes(normCity(city));
}
// Скоуп по містах — ЛИШЕ місто рядка (factory_id рядка — матч по назві вкладки й може влучити у фабрику
// іншого міста, ревʼю codex 13.10.2026); скоуп лише по фабриках — factory_id рядка.
export function svodniRowAllowed(scope: AdminScope, row: { city: string | null; factoryId: number | null }): boolean {
  if (scope.cities.length) return svodniCityAllowed(scope, row.city);
  return row.factoryId != null && factoryInScope(scope, row.factoryId);
}
// SQL-умова на svodni_rows (місто — точним рядком зі скоупу, без lower() на кирилиці)
export function svodniRowInScopeSql(scope: AdminScope): SQL {
  if (scope.cities.length) {
    return scope.cityNames.length ? sql`${svodniRowsTable.city} IN (${sql.join(scope.cityNames.map(c => sql`${c}`), sql`, `)})` : sql`false`;
  }
  return scope.factoryIds.length ? sql`${svodniRowsTable.factoryId} IN (${idList(scope.factoryIds)})` : sql`false`;
}
export async function svodniRowIdAllowed(scope: AdminScope, rowId: number): Promise<boolean> {
  if (!Number.isInteger(rowId)) return false;
  const [r] = await db.select({ city: svodniRowsTable.city, factoryId: svodniRowsTable.factoryId }).from(svodniRowsTable).where(eq(svodniRowsTable.id, rowId));
  return !!r && svodniRowAllowed(scope, r);
}
// Область (лок/очищення/новий рядок): скоуп по містах — місто в скоупі; скоуп лише по фабриках — вкладка,
// ВСІ рядки якої в місяці мають factory_id зі скоупу (один збіг не авторизує очищення цілої вкладки;
// лок цілого міста "" такому адміну недоступний).
export async function svodniAreaAllowed(scope: AdminScope, month: string, city: string, factoryLabel: string): Promise<boolean> {
  if (scope.cities.length) return svodniCityAllowed(scope, city);
  if (!factoryLabel || !scope.factoryIds.length) return false;
  const a = await areaRowsMine(scope, month, city, factoryLabel);
  return a.total > 0 && a.total === a.mine;
}
// рядки області (місяць × місто × вкладка): скільки всього і скільки з factory_id зі скоупу (factory_id NULL = не мій)
async function areaRowsMine(scope: AdminScope, month: string, city: string, factoryLabel: string): Promise<{ total: number; mine: number }> {
  const r: any = await db.execute(sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE ${svodniRowsTable.factoryId} IN (${idList(scope.factoryIds)}))::int AS mine
    FROM ${svodniRowsTable} WHERE ${svodniRowsTable.periodMonth} = ${month} AND ${svodniRowsTable.city} = ${city} AND ${svodniRowsTable.factoryLabel} = ${factoryLabel}`);
  const row = (r?.rows ?? r)?.[0];
  return { total: Number(row?.total ?? 0), mine: Number(row?.mine ?? 0) };
}
// Знімок очищення (перегляд у журналі / відновлення): по місту — місто знімка; скоуп лише по фабриках —
// усі рядки ЗНІМКА з factory_id зі скоупу (NULL = не мій; поточних рядків після очищення вже нема) І поточні
// рядки області, якщо є, теж мої (restore витісняє їх у журнал — ревʼю codex 13.10.2026).
export async function svodniClearAllowed(scope: AdminScope, clearId: number): Promise<boolean> {
  if (!Number.isInteger(clearId)) return false;
  const [c] = await db.select({ month: svodniClearsTable.periodMonth, city: svodniClearsTable.city, factoryLabel: svodniClearsTable.factoryLabel })
    .from(svodniClearsTable).where(eq(svodniClearsTable.id, clearId));
  if (!c) return false;
  if (scope.cities.length) return svodniCityAllowed(scope, c.city);
  if (!scope.factoryIds.length) return false;
  const r: any = await db.execute(sql`SELECT coalesce(bool_and(coalesce((x->>'factoryId') ~ '^[0-9]+$' AND (x->>'factoryId')::int IN (${idList(scope.factoryIds)}), false)), false) AS ok
    FROM ${svodniClearsTable} c, jsonb_array_elements(c.rows) x WHERE c.id = ${clearId}`);
  if (!(r?.rows ?? r)?.[0]?.ok) return false;
  const a = await areaRowsMine(scope, c.month, c.city, c.factoryLabel);
  return a.total === 0 || a.total === a.mine;
}
// Усі рядки сводної людини — у скоупі (журнальні зміни профілю перераховують усі її незалочені рядки,
// тож людині з двох міст їх з-під скоупу не застосовують/не відкочують — ревʼю codex 13.10.2026)
export async function svodniRowsAllInScope(scope: AdminScope, workerId: number): Promise<boolean> {
  const [r] = await db.select({ id: svodniRowsTable.id }).from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.workerId, workerId), sql`(${svodniRowInScopeSql(scope)}) IS NOT TRUE`)).limit(1); // NULL factory_id = не мій
  return !r;
}

// ─── Гейт ──────────────────────────────────────────────────────────────────────
type Check =
  | { kind: "free" }                                  // довідник або список, що фільтрує сам
  | { kind: "worker" }                                // m[1] = id працівника
  | { kind: "lookup"; table: LookupTable }            // m[1] = id рядка → його worker_id / factory_id
  | { kind: "factory" }                               // m[1] = id фабрики
  | { kind: "queryWorker" }                           // ?workerId= обовʼязковий і в скоупі
  | { kind: "task" }                                  // m[1] = id задачі: учасник/автор або працівник/фабрика задачі в скоупі
  | { kind: "taskBulk" }                              // body.ids — кожна задача за правилом task
  | { kind: "queryFactory" }                          // ?factoryId= обовʼязковий (значення звіряє загальний гейт query)
  | { kind: "bodyFactory" }                           // body.factoryId обовʼязковий (значення звіряє гейт тіла)
  // сводна (13.10.2026): область/рядок/знімок/місто в тілі — див. svodni*Allowed
  | { kind: "svodniArea" }                            // body.month|periodMonth + city + factoryLabel ("" = місто)
  | { kind: "svodniRow" }                             // m[1] = id рядка сводної
  | { kind: "svodniClear" }                           // m[1] = id знімка очищення
  | { kind: "svodniCity" }                            // body.city обовʼязковий і в скоупі
  | { kind: "svodniRowIds" }                          // body.rowIds — кожен рядок у скоупі
  | { kind: "requireIds"; field: string };            // body[field] — непорожній масив (вибіркова дія; людей звіряє хендлер)

type LookupTable = "doc" | "badania" | "bank" | "wf" | "contract" | "advance" | "clothing" | "entry" | "unplanned" | "factoryCode" | "dispute" | "absenceReq" | "change" | "payoutRule";
type Rule = { methods: string[]; re: RegExp; check: Check };
const R = (methods: string, re: RegExp, check: Check): Rule => ({ methods: methods.split(","), re, check });
const ANY = "GET,POST,PUT,PATCH,DELETE";

const SCOPE_RULES: Rule[] = [
  // Довідники (без персональних даних) і списки з фільтрацією в хендлері
  R("GET", /^\/(companies|positions|document-types|document-templates|clothing\/stock|clothing\/types)$/, { kind: "free" }),
  // дзвіночок: хендлер віддає скоуп-адміну порожній список
  R("GET", /^\/notifications$/, { kind: "free" }),
  R("GET", /^\/legalization\/(globals|status-map)$/, { kind: "free" }),
  R("GET", /^\/(workers|legalization|factories)$/, { kind: "free" }),
  // глобальний пошук (routes/search.ts) — групи фільтрує сам хендлер по скоупу (до 13.10.2026 скоуп-адмін діставав 403 → порожній пошук)
  R("GET", /^\/search$/, { kind: "free" }),
  // Лінк скану для нового кандидата — factoryId у тілі обовʼязковий (перевіряє body-гейт)
  R("POST", /^\/workers\/scan-invite$/, { kind: "free" }),
  // Профіль і все під ним
  R(ANY, /^\/workers\/(\d+)(?:\/.*)?$/, { kind: "worker" }),
  R("GET", /^\/hostels\/worker\/(\d+)$/, { kind: "worker" }),
  R(ANY, /^\/worker-documents\/(\d+)(?:\/.*)?$/, { kind: "lookup", table: "doc" }),
  R(ANY, /^\/worker-badania\/(\d+)$/, { kind: "lookup", table: "badania" }),
  R(ANY, /^\/worker-bank-accounts\/(\d+)(?:\/.*)?$/, { kind: "lookup", table: "bank" }),
  R(ANY, /^\/worker-factories\/(\d+)$/, { kind: "lookup", table: "wf" }),
  R(ANY, /^\/contracts\/(\d+)(?:\/.*)?$/, { kind: "lookup", table: "contract" }),
  R("GET", /^\/clothing$/, { kind: "queryWorker" }),
  // Бадання й одяг (08.10.2026, cap advances): списки «до зняття» фільтрує хендлер; видача/ручний запис —
  // workerId у тілі (гейт тіла); повернення/правка — через працівника запису
  R("GET", /^\/badania\/(?:pending|deducted)$/, { kind: "free" }),
  R("GET", /^\/clothing\/pending$/, { kind: "free" }),
  R("POST", /^\/clothing(?:\/issue)?$/, { kind: "free" }),
  R(ANY, /^\/clothing\/(\d+)(?:\/return)?$/, { kind: "lookup", table: "clothing" }),
  // Делеговані запрошення (свої запрошені; права перевіряє хендлер)
  R(ANY, /^\/admin-invites(?:\/\d+(?:\/invite|\/web-access-prompt)?)?$/, { kind: "free" }),
  // Лінк самореєстрації фабрики
  R("GET", /^\/factories\/(\d+)\/join-link$/, { kind: "factory" }),
  // Персональні лінки реєстрації (routes/signupLinks.ts, 11.10.2026): свої — хендлер віддає лише власні,
  // новий — фабрика у тілі (гейт тіла), рядок — власність перевіряє хендлер (чужий → 404)
  R("GET", /^\/signup-links$/, { kind: "free" }),
  R("POST", /^\/signup-links$/, { kind: "bodyFactory" }),
  R(ANY, /^\/signup-links\/(\d+)\/(?:rotate|workers|qr\.png)$/, { kind: "free" }),
  // Залічки (08.10.2026, cap advances): список фільтрує хендлер, нова — workerId у тілі (гейт тіла), рядок — його працівник
  R("GET,POST", /^\/advances$/, { kind: "free" }),
  R(ANY, /^\/advances\/(\d+)(?:\/(?:balance|approve|reject|paid))?$/, { kind: "lookup", table: "advance" }),
  // Задачі (routes/tasks.ts): списки/календар/«мій день» фільтрує хендлер (scopeTaskCond), нова — workerId/factoryId
  // у тілі (гейт тіла), картка й дії — учасник або задача про людину/фабрику зі скоупу; шаблони — лише читати
  R("GET", /^\/tasks(?:\/(?:company-counts|ical-link|export\.xlsx|my-day|counters|calendar|admins))?$/, { kind: "free" }),
  R("POST", /^\/tasks$/, { kind: "free" }),
  R("POST", /^\/tasks\/bulk$/, { kind: "taskBulk" }),
  R(ANY, /^\/tasks\/(\d+)(?:\/.*)?$/, { kind: "task" }),
  R("GET", /^\/task-templates$/, { kind: "free" }),
  // Календар працівників (routes/workersCalendar.ts) — фільтрує хендлер по фабриках скоупу
  R("GET", /^\/workers-calendar(?:\/export\.xlsx)?$/, { kind: "free" }),
  // ── Графік / замовлення / доступність / години (11.10.2026, скоуп-адмін з editData веде свої фабрики) ──
  // Списки без фабрики — фільтрує хендлер; довідники тижнів/шаблонів листів — лише читання
  R("GET", /^\/(?:dashboard|attention|weeks|email-templates|reliability|absences|absence-requests|hours|hours-reports|availability|availability\/missing)$/, { kind: "free" }),
  // Без factoryId ці дії йдуть по ВСІХ фабриках — для скоуп-адміна фабрика обовʼязкова
  R("GET", /^\/(?:schedule|schedule\/excel|orders|hours\/factory-codes|hours\/day-compare|hours\/report-excel)$/, { kind: "queryFactory" }),
  R("DELETE", /^\/schedule\/shift-override$/, { kind: "queryFactory" }),
  R("POST", /^\/schedule\/(?:generate|approve|entry|shift-cancel|shift-restore|copy-day|clear|shift-override|email|notify)$/, { kind: "bodyFactory" }),
  R("PUT", /^\/orders$/, { kind: "bodyFactory" }),
  R("POST", /^\/hours\/(?:factory|factory-clear|factory-notify|factory-confirm|factory-apply|factory-codes-parse|factory-codes-apply|discrepancy-email|statement-email)$/, { kind: "bodyFactory" }),
  R("POST", /^\/workers$/, { kind: "bodyFactory" }),
  // workerId/масиви id звіряє гейт тіла; фабрику-фолбек, multipart і «всім» — хендлери
  R("POST", /^\/hours\/(?:report|note|factory-parse|exclusions|exclusions-remove|last-activity|report-remind)$/, { kind: "free" }),
  R("POST", /^\/(?:availability\/remind|absences\/remind|broadcast)$/, { kind: "free" }),
  R("PATCH,DELETE", /^\/schedule\/entry\/(\d+)(?:\/status)?$/, { kind: "lookup", table: "entry" }),
  R("POST", /^\/unplanned\/(\d+)\/link$/, { kind: "lookup", table: "unplanned" }),
  R("DELETE", /^\/hours\/factory-codes\/(\d+)$/, { kind: "lookup", table: "factoryCode" }),
  R(ANY, /^\/hours-reports\/(\d+)(?:\/(?:resolve|photo|apply))?$/, { kind: "lookup", table: "dispute" }),
  R("POST,PATCH", /^\/absences\/(\d+)(?:\/message)?$/, { kind: "lookup", table: "entry" }),
  R("POST", /^\/absence-requests\/(\d+)\/(?:approve|reject|substitute)$/, { kind: "lookup", table: "absenceReq" }),
  // Сводна (13.10.2026, роль «Dyrektor» регіону зі скоупом міст): читання фільтрують хендлери по
  // svodniRowAllowed; мутації — лише у своїй області. Поза списком свідомо: rematch, apply-rates,
  // PUT settings, gratyfikant-лісти, apply-clothing (дії «по всіх містах»/бухгалтерські) — лишаються власнику.
  R("GET", /^\/svodni(?:\/(?:months|unmatched|excel|clears|settings|factory-rules))?$/, { kind: "free" }),
  R("POST", /^\/svodni\/(?:lock|lock-pending|clear|rows)$/, { kind: "svodniArea" }),
  R("POST", /^\/svodni\/(?:link|sync)$/, { kind: "svodniCity" }),
  R("PATCH,DELETE", /^\/svodni\/rows\/(\d+)$/, { kind: "svodniRow" }),
  R("POST", /^\/svodni\/rows\/(\d+)\/unsplit$/, { kind: "svodniRow" }),
  R("POST", /^\/svodni\/clears\/(\d+)\/restore$/, { kind: "svodniClear" }),
  R("POST", /^\/svodni\/profile-impact$/, { kind: "free" }), // workerId у тілі звіряє загальний гейт
  R("POST", /^\/svodni\/profile-apply$/, { kind: "svodniRowIds" }),
  R("POST,DELETE", /^\/svodni\/profile-change\/(\d+)(?:\/(?:dismiss|restore))?$/, { kind: "lookup", table: "change" }),
  R("POST", /^\/svodni\/(?:from-hours|apply-transport-deductions|factory-rules|factory-rules\/impact|factory-rules\/recompute)$/, { kind: "bodyFactory" }),
  R("PATCH,DELETE", /^\/svodni\/factory-rules\/(\d+)$/, { kind: "lookup", table: "payoutRule" }),
  R("POST", /^\/svodni\/(?:apply-penalty-deductions|apply-badania-deductions|apply-zaliczki)$/, { kind: "requireIds", field: "ids" }),
  R("POST", /^\/svodni\/apply-absence-deductions$/, { kind: "requireIds", field: "entryIds" }),
  R("POST", /^\/svodni\/undo-(?:penalty-deduction|badania-deduction|absence-deduction|zaliczka)$/, { kind: "free" }), // джерело/рядок звіряє хендлер
];

// Задача доступна скоуп-адміну, якщо він її учасник/автор/спостерігач (її йому дали свідомо)
// або вона про працівника чи фабрику з його скоупу. Задачі «ні про кого» чужих людей — ні.
export async function taskAllowed(scope: AdminScope, adminId: number, taskId: number): Promise<boolean> {
  if (!Number.isInteger(taskId)) return false;
  const [t] = await db.select({ id: tasksTable.id, assignee: tasksTable.assigneeAdminId, creator: tasksTable.creatorAdminId, workerId: tasksTable.workerId, factoryId: tasksTable.factoryId })
    .from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!t) return false;
  if (t.assignee === adminId || t.creator === adminId) return true;
  const [part] = await db.select({ id: taskAssigneesTable.id }).from(taskAssigneesTable).where(and(eq(taskAssigneesTable.taskId, taskId), eq(taskAssigneesTable.adminId, adminId)));
  if (part) return true;
  if (t.factoryId != null && factoryInScope(scope, t.factoryId)) return true;
  return workerInScope(scope, t.workerId);
}

// SQL-умова для списків задач скоуп-адміна (той самий зміст, що taskAllowed)
export function scopeTaskSql(scope: AdminScope, adminId: number): SQL {
  const fac = factoryInScopeSql(scope, tasksTable.factoryId);
  return sql`(${tasksTable.assigneeAdminId} = ${adminId} OR ${tasksTable.creatorAdminId} = ${adminId}
    OR EXISTS (SELECT 1 FROM ${taskAssigneesTable} sta WHERE sta.task_id = ${tasksTable.id} AND sta.admin_id = ${adminId})
    OR ${fac} OR (${tasksTable.workerId} IS NOT NULL AND ${workerInScopeSql(scope, tasksTable.workerId)}))`;
}

// Рядок → його працівник; для привʼязки до фабрики й умови — ще й фабрика рядка: працівник
// може бути у двох містах, а рядок чужої фабрики правити/читати не можна.
async function lookupAllowed(scope: AdminScope, table: LookupTable, id: number): Promise<boolean> {
  if (table === "entry" || table === "unplanned" || table === "factoryCode") {
    // рядок, привʼязаний до фабрики — лише фабрика рядка
    const t = { entry: scheduleEntriesTable, unplanned: unplannedWorkersTable, factoryCode: workerFactoryCodesTable }[table];
    const [r] = await db.select({ factoryId: t.factoryId }).from(t).where(eq(t.id, id));
    return !!r && factoryInScope(scope, r.factoryId);
  }
  if (table === "dispute" || table === "absenceReq") {
    const t = table === "dispute" ? hoursDisputesTable : absenceRequestsTable;
    const [r] = await db.select({ workerId: t.workerId }).from(t).where(eq(t.id, id));
    return workerInScope(scope, r?.workerId ?? null);
  }
  if (table === "wf" || table === "contract") {
    const t = table === "wf" ? workerFactoriesTable : contractsTable;
    const [r] = await db.select({ workerId: t.workerId, factoryId: t.factoryId }).from(t).where(eq(t.id, id));
    if (!r) return false;
    // умова без фабрики (сталий пакет документів) — достатньо працівника в скоупі
    if (r.factoryId != null && !factoryInScope(scope, r.factoryId)) return false;
    return workerInScope(scope, r.workerId);
  }
  if (table === "change") {
    const [r] = await db.select({ workerId: workerChangesTable.workerId }).from(workerChangesTable).where(eq(workerChangesTable.id, id));
    if (!r || !(await workerInScope(scope, r.workerId))) return false;
    return svodniRowsAllInScope(scope, r.workerId);
  }
  if (table === "payoutRule") {
    const [r] = await db.select({ factoryId: factoryPayoutRulesTable.factoryId }).from(factoryPayoutRulesTable).where(eq(factoryPayoutRulesTable.id, id));
    return !!r && factoryInScope(scope, r.factoryId);
  }
  if (table === "advance") {
    // залічка — ще й по фабриці запиту (без неї — поточна фабрика профілю, як у списку /advances):
    // людина з двох міст — її залічку чужої фабрики не читати й не правити
    const [r] = await db.select({ workerId: advanceRequestsTable.workerId, factoryId: advanceRequestsTable.factoryId, profileFactoryId: workersTable.factoryId })
      .from(advanceRequestsTable).leftJoin(workersTable, eq(advanceRequestsTable.workerId, workersTable.id)).where(eq(advanceRequestsTable.id, id));
    if (!r || !factoryInScope(scope, r.factoryId ?? r.profileFactoryId)) return false;
    return workerInScope(scope, r.workerId);
  }
  const t = { doc: workerDocumentsTable, badania: workerBadaniaTable, bank: workerBankAccountsTable, clothing: clothingItemsTable }[table];
  const [r] = await db.select({ workerId: t.workerId }).from(t).where(eq(t.id, id));
  return workerInScope(scope, r?.workerId ?? null);
}

const deny = (res: Response) => res.status(403).json({ error: "Немає доступу до даних цього міста/фабрики", code: "scope" });

export async function scopeGate(req: AuthedRequest, res: Response, next: NextFunction) {
  const scope = req.admin?.scope;
  if (!scope) return next();
  try {
    // Будь-який factoryId у JSON-тілі мусить бути в скоупі (не дати привʼязати/створити поза ним).
    // multipart-тіло тут ще не розібране (multer у хендлері) — такі хендлери з factoryId
    // перевіряють його самі (POST /workers/:id/contracts/import);
    // для лінка скану нового кандидата він обовʼязковий — інакше людина «нічия».
    const bodyFactory = req.body && typeof req.body === "object" ? (req.body as any).factoryId : undefined;
    if (bodyFactory != null && bodyFactory !== "" && !factoryInScope(scope, Number(bodyFactory))) return deny(res);
    // Так само працівники в тілі: workerId, масиви workerIds/attachWorkerIds і rows[]/items[].workerId — лише люди зі скоупу
    const b: any = req.body && typeof req.body === "object" ? req.body : {};
    const bodyWorkers: number[] = [];
    if (b.workerId != null && b.workerId !== "") bodyWorkers.push(Number(b.workerId));
    for (const k of ["workerIds", "attachWorkerIds"]) if (Array.isArray(b[k])) bodyWorkers.push(...b[k].map(Number));
    for (const k of ["rows", "items"]) if (Array.isArray(b[k])) for (const it of b[k]) if (it && typeof it === "object" && it.workerId != null && it.workerId !== "") bodyWorkers.push(Number(it.workerId));
    if (bodyWorkers.some(n => !Number.isInteger(n) || n <= 0)) return deny(res);
    if (bodyWorkers.length && !(await workersInScope(scope, bodyWorkers))) return deny(res);
    // ?factoryId= у query (графік, Excel, замовлення, коди фабрики) — так само лише фабрика зі скоупу
    const qf = req.query?.factoryId;
    if (qf != null && qf !== "" && !factoryInScope(scope, Number(qf))) return deny(res);
    if (req.method === "POST" && req.path === "/workers/scan-invite" && bodyFactory == null) return deny(res);

    const rule = SCOPE_RULES.find(r => r.methods.includes(req.method) && r.re.test(req.path));
    if (!rule) return deny(res);
    const m = req.path.match(rule.re);
    const id = m?.[1] ? Number(m[1]) : NaN;
    switch (rule.check.kind) {
      case "free": return next();
      case "worker": return (await workerInScope(scope, id)) ? next() : deny(res);
      case "lookup": return (await lookupAllowed(scope, rule.check.table, id)) ? next() : deny(res);
      case "factory": return factoryInScope(scope, id) ? next() : deny(res);
      case "queryWorker": return (await workerInScope(scope, Number(req.query.workerId))) ? next() : deny(res);
      case "task": return (await taskAllowed(scope, req.admin!.adminId, id)) ? next() : deny(res);
      case "queryFactory": return req.query?.factoryId != null && req.query.factoryId !== "" ? next() : deny(res);
      case "bodyFactory": return bodyFactory != null && bodyFactory !== "" ? next() : deny(res);
      case "taskBulk": {
        const ids = Array.isArray((req.body as any)?.ids) ? ((req.body as any).ids as unknown[]).map(Number) : [];
        for (const tid of ids) if (!(await taskAllowed(scope, req.admin!.adminId, tid))) return deny(res);
        return next();
      }
      case "svodniArea": {
        const month = String(b.month ?? b.periodMonth ?? "");
        const city = String(b.city ?? "").trim();
        if (!city) return deny(res);
        return (await svodniAreaAllowed(scope, month, city, String(b.factoryLabel ?? "").trim())) ? next() : deny(res);
      }
      case "svodniRow": return (await svodniRowIdAllowed(scope, id)) ? next() : deny(res);
      case "svodniClear": return (await svodniClearAllowed(scope, id)) ? next() : deny(res);
      case "svodniCity": return svodniCityAllowed(scope, String(b.city ?? "").trim()) ? next() : deny(res);
      case "svodniRowIds": {
        const ids = Array.isArray(b.rowIds) ? (b.rowIds as unknown[]).map(Number) : [];
        for (const rid of ids) if (!(await svodniRowIdAllowed(scope, rid))) return deny(res);
        return next();
      }
      case "requireIds": {
        const arr = b[rule.check.field];
        return Array.isArray(arr) && arr.length > 0 ? next() : deny(res);
      }
    }
  } catch {
    return res.status(500).json({ error: "scope error" });
  }
}
