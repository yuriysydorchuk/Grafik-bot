// «Календар працівників» (/workers-calendar, батч 4 модуля «Задачі»): зведені події по
// людях — строки документів, кінець умов, обовʼязки легалізації, пропуски, дні народження,
// початок/кінець роботи на фабриці, відкриті задачі з привʼязкою. Лише читання; задачу з
// події створює веб через POST /tasks (модалка з предзаповненням).
import { Router, type IRouter } from "express";
import { and, eq, gte, lte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db, workersTable, factoriesTable, workerDocumentsTable, documentTypesTable, contractsTable, workerLegalityTable,
  absenceRequestsTable, workerFactoriesTable, tasksTable,
} from "@workspace/db";
import { authRequired, requirePage, type AuthedRequest } from "../lib/auth";
import { addDaysStr } from "../lib/dates";
import { OPEN_STATUSES, warsawToday } from "../services/taskUtils";

const router: IRouter = Router();
router.use("/workers-calendar", authRequired, requirePage("/workers-calendar"));

export type CalKind = "doc" | "contract" | "obligation" | "absence" | "birthday" | "start" | "end" | "task";
export interface CalEvent {
  id: string; kind: CalKind; date: string; title: string; detail?: string | null;
  workerId: number; workerName: string; factoryId: number | null; factoryName: string | null;
  severity: "info" | "warn" | "danger"; taskId?: number; docId?: number;
}

const DAY_IDX: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const OBLIGATION_LABEL: Record<string, string> = {
  "obligation.ua_notification": "Powiadomienie PUP (UA)",
  "obligation.contract_signing": "Підписати умову",
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function collectWorkerEvents(opts: { from: string; to: string; factoryId?: number | null; workerId?: number | null; kinds?: Set<CalKind> | null }): Promise<CalEvent[]> {
  const { from, to } = opts;
  const today = warsawToday();
  const want = (k: CalKind) => !opts.kinds || opts.kinds.has(k);
  const wWhere = [eq(workersTable.isActive, true)] as any[];
  if (opts.workerId) wWhere.push(eq(workersTable.id, opts.workerId));
  if (opts.factoryId) wWhere.push(sql`(${workersTable.factoryId} = ${opts.factoryId} or exists (select 1 from worker_factories wf where wf.worker_id = ${workersTable.id} and wf.factory_id = ${opts.factoryId}))`);
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId, factoryName: factoriesTable.name, birthDate: workersTable.birthDate })
    .from(workersTable).leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id)).where(and(...wWhere));
  if (!workers.length) return [];
  const wmap = new Map(workers.map(w => [w.id, w]));
  const ids = [...wmap.keys()];
  const facs = new Map((await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable)).map(f => [f.id, f.name]));
  const sev = (d: string): CalEvent["severity"] => (d < today ? "danger" : d <= addDaysStr(today, 14) ? "warn" : "info");
  const out: CalEvent[] = [];
  const base = (w: { id: number; fullName: string; factoryId: number | null; factoryName: string | null }, factoryId?: number | null) =>
    ({ workerId: w.id, workerName: w.fullName, factoryId: factoryId ?? w.factoryId, factoryName: factoryId != null ? facs.get(factoryId) ?? null : w.factoryName });

  if (want("doc")) {
    const docs = await db.select({ id: workerDocumentsTable.id, workerId: workerDocumentsTable.workerId, title: workerDocumentsTable.title, typeName: documentTypesTable.name, expiresAt: workerDocumentsTable.expiresAt, status: workerDocumentsTable.status })
      .from(workerDocumentsTable).leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
      .where(and(inArray(workerDocumentsTable.workerId, ids), isNotNull(workerDocumentsTable.expiresAt), gte(workerDocumentsTable.expiresAt, from), lte(workerDocumentsTable.expiresAt, to), inArray(workerDocumentsTable.status, ["present", "pending"])));
    for (const d of docs) { const w = wmap.get(d.workerId)!; const date = String(d.expiresAt); out.push({ id: `doc:${d.id}`, kind: "doc", date, title: `${d.typeName ?? d.title} спливає`, detail: d.typeName && d.title !== d.typeName ? d.title : null, ...base(w), severity: sev(date), docId: d.id }); }
  }
  if (want("contract")) {
    const cs = await db.select().from(contractsTable).where(and(inArray(contractsTable.workerId, ids), isNotNull(contractsTable.dateTo), gte(contractsTable.dateTo, from), lte(contractsTable.dateTo, to), inArray(contractsTable.status, ["signed", "worker_signed", "sent", "viewed", "approved"])));
    for (const c of cs) { const w = wmap.get(c.workerId)!; const date = String(c.dateTo); out.push({ id: `contract:${c.id}`, kind: "contract", date, title: `Умова закінчується${c.factoryId ? ` · ${facs.get(c.factoryId) ?? ""}` : " · сталий пакет"}`, ...base(w, c.factoryId), severity: sev(date) }); }
  }
  if (want("obligation")) {
    const lg = await db.select({ workerId: workerLegalityTable.workerId, obligations: workerLegalityTable.obligations }).from(workerLegalityTable).where(inArray(workerLegalityTable.workerId, ids));
    for (const r of lg) for (const o of r.obligations ?? []) {
      const date = String(o.dueAt).slice(0, 10);
      if (date < from || date > to) continue;
      const w = wmap.get(r.workerId)!;
      out.push({ id: `obl:${r.workerId}:${o.code}`, kind: "obligation", date, title: String((o.params as any)?.label ?? OBLIGATION_LABEL[o.code] ?? o.code), ...base(w), severity: o.overdue ? "danger" : sev(date) });
    }
  }
  if (want("absence")) {
    const weekFrom = addDaysStr(from, -6);
    const abs = await db.select().from(absenceRequestsTable).where(and(inArray(absenceRequestsTable.workerId, ids), gte(absenceRequestsTable.weekStart, weekFrom), lte(absenceRequestsTable.weekStart, to), inArray(absenceRequestsTable.status, ["pending", "accepted", "substituted"])));
    for (const a of abs) {
      const date = addDaysStr(String(a.weekStart), DAY_IDX[a.dayOfWeek] ?? 0);
      if (date < from || date > to) continue;
      const w = wmap.get(a.workerId)!;
      out.push({ id: `abs:${a.id}`, kind: "absence", date, title: a.shift ? `Відпрошується (зміна ${a.shift})` : "Відпрошується (день)", detail: a.reason, ...base(w), severity: a.status === "pending" ? "warn" : "info" });
    }
  }
  if (want("birthday")) {
    const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
    for (const w of workers) {
      if (!w.birthDate) continue;
      const bd = String(w.birthDate);
      for (let y = y0; y <= y1; y++) {
        const date = `${y}-${bd.slice(5, 10)}`;
        if (date < from || date > to) continue;
        out.push({ id: `bd:${w.id}:${y}`, kind: "birthday", date, title: `День народження · ${y - Number(bd.slice(0, 4))} р.`, ...base(w), severity: "info" });
      }
    }
  }
  if (want("start") || want("end")) {
    const wf = await db.select().from(workerFactoriesTable).where(inArray(workerFactoriesTable.workerId, ids));
    for (const r of wf) {
      const w = wmap.get(r.workerId)!;
      if (want("start") && r.validFrom && String(r.validFrom) >= from && String(r.validFrom) <= to) out.push({ id: `start:${r.id}`, kind: "start", date: String(r.validFrom), title: `Початок роботи · ${facs.get(r.factoryId) ?? ""}`, ...base(w, r.factoryId), severity: "info" });
      if (want("end") && r.validTo && String(r.validTo) >= from && String(r.validTo) <= to) out.push({ id: `end:${r.id}`, kind: "end", date: String(r.validTo), title: `Кінець роботи · ${facs.get(r.factoryId) ?? ""}`, ...base(w, r.factoryId), severity: sev(String(r.validTo)) });
    }
  }
  if (want("task")) {
    const ts = await db.select().from(tasksTable).where(and(inArray(tasksTable.workerId, ids), isNotNull(tasksTable.dueAt), gte(tasksTable.dueAt, from), lte(tasksTable.dueAt, to), inArray(tasksTable.status, OPEN_STATUSES)));
    for (const t of ts) { const w = wmap.get(t.workerId!)!; const date = String(t.dueAt); out.push({ id: `task:${t.id}`, kind: "task", date, title: t.title, ...base(w, t.factoryId), severity: date < today ? "danger" : t.priority === "urgent" ? "warn" : "info", taskId: t.id }); }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.workerName.localeCompare(b.workerName, "pl"));
  return out;
}

router.get("/workers-calendar", async (req: AuthedRequest, res) => {
  const from = String(req.query.from ?? ""), to = String(req.query.to ?? "");
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return res.status(400).json({ error: "from/to (YYYY-MM-DD) обовʼязкові" });
  const kindsRaw = String(req.query.kinds ?? "").split(",").map(s => s.trim()).filter(Boolean) as CalKind[];
  const events = await collectWorkerEvents({
    from, to,
    factoryId: req.query.factoryId ? Number(req.query.factoryId) : null,
    workerId: req.query.workerId ? Number(req.query.workerId) : null,
    kinds: kindsRaw.length ? new Set(kindsRaw) : null,
  });
  return res.json({ from, to, events });
});

export default router;
