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
  workerDocumentsTable, workerBadaniaTable, workerBankAccountsTable, contractsTable } from "@workspace/db";
import { eq, sql, type SQL } from "drizzle-orm";
import type { AuthedRequest } from "./auth";

export type AdminScope = { factoryIds: number[]; cities: string[] };

const normCity = (s: string) => s.trim().toLocaleLowerCase("pl");

// Обидва списки порожні → null (без обмежень). Інакше — множина дозволених фабрик
// (може бути порожньою, якщо місто без фабрик: тоді не видно нікого — fail closed).
export async function resolveScope(cities: string[] | null | undefined, factoryIds: number[] | null | undefined): Promise<AdminScope | null> {
  const cs = (cities ?? []).map(normCity).filter(Boolean);
  const ids = new Set((factoryIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0));
  if (!cs.length && !ids.size) return null;
  if (cs.length) {
    const rows = await db.select({ id: factoriesTable.id, city: factoriesTable.city }).from(factoriesTable);
    for (const r of rows) if (r.city && cs.includes(normCity(r.city))) ids.add(r.id);
  }
  return { factoryIds: [...ids], cities: cs };
}

export function factoryInScope(scope: AdminScope | null | undefined, factoryId: number | null | undefined): boolean {
  if (!scope) return true;
  return factoryId != null && scope.factoryIds.includes(Number(factoryId));
}

const idList = (ids: number[]) => sql.join(ids.map(i => sql`${i}`), sql`, `);

// Умова на workers.id: працівник належить дозволеним фабрикам — основна фабрика, будь-яка
// привʼязка worker_factories (і минула — офіс відповідає на питання по старих виплатах)
// або рядок сводної на цю фабрику. Порожній скоуп → false.
export function workerInScopeSql(scope: AdminScope, workerIdCol: SQL | typeof workersTable.id = workersTable.id): SQL {
  if (!scope.factoryIds.length) return sql`false`;
  const ids = idList(scope.factoryIds);
  return sql`(
    EXISTS (SELECT 1 FROM ${workersTable} sw WHERE sw.id = ${workerIdCol} AND sw.factory_id IN (${ids}))
    OR EXISTS (SELECT 1 FROM ${workerFactoriesTable} swf WHERE swf.worker_id = ${workerIdCol} AND swf.factory_id IN (${ids}))
    OR EXISTS (SELECT 1 FROM ${svodniRowsTable} ssr WHERE ssr.worker_id = ${workerIdCol} AND ssr.factory_id IN (${ids}))
  )`;
}

export async function workerInScope(scope: AdminScope | null | undefined, workerId: number | null | undefined): Promise<boolean> {
  if (!scope) return true;
  if (!workerId || !Number.isInteger(workerId)) return false;
  const r: any = await db.execute(sql`SELECT ${workerInScopeSql(scope, sql`${workerId}::int`)} AS ok`);
  return !!(r?.rows ?? r)?.[0]?.ok;
}

// ─── Гейт ──────────────────────────────────────────────────────────────────────
type Check =
  | { kind: "free" }                                  // довідник або список, що фільтрує сам
  | { kind: "worker" }                                // m[1] = id працівника
  | { kind: "lookup"; table: "doc" | "badania" | "bank" | "wf" | "contract" } // m[1] = id рядка → його worker_id
  | { kind: "factory" }                               // m[1] = id фабрики
  | { kind: "queryWorker" };                          // ?workerId= обовʼязковий і в скоупі

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
  // Делеговані запрошення (свої запрошені; права перевіряє хендлер)
  R(ANY, /^\/admin-invites(?:\/\d+(?:\/invite)?)?$/, { kind: "free" }),
  // Лінк самореєстрації фабрики
  R("GET", /^\/factories\/(\d+)\/join-link$/, { kind: "factory" }),
];

// Рядок → його працівник; для привʼязки до фабрики й умови — ще й фабрика рядка: працівник
// може бути у двох містах, а рядок чужої фабрики правити/читати не можна.
async function lookupAllowed(scope: AdminScope, table: "doc" | "badania" | "bank" | "wf" | "contract", id: number): Promise<boolean> {
  if (table === "wf" || table === "contract") {
    const t = table === "wf" ? workerFactoriesTable : contractsTable;
    const [r] = await db.select({ workerId: t.workerId, factoryId: t.factoryId }).from(t).where(eq(t.id, id));
    if (!r) return false;
    // умова без фабрики (сталий пакет документів) — достатньо працівника в скоупі
    if (r.factoryId != null && !factoryInScope(scope, r.factoryId)) return false;
    return workerInScope(scope, r.workerId);
  }
  const t = { doc: workerDocumentsTable, badania: workerBadaniaTable, bank: workerBankAccountsTable }[table];
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
    }
  } catch {
    return res.status(500).json({ error: "scope error" });
  }
}
