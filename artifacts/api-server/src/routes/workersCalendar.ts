// «Календар працівників» (/workers-calendar, батч 4 модуля «Задачі»): зведені події по
// людях — строки документів, кінець умов, обовʼязки легалізації, пропуски, дні народження,
// початок/кінець роботи на фабриці, відкриті задачі з привʼязкою. Лише читання; задачу з
// події створює веб через POST /tasks (модалка з предзаповненням).
import { Router, type IRouter } from "express";
import { and, eq, gte, lte, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  db, workersTable, factoriesTable, workerDocumentsTable, documentTypesTable, contractsTable, workerLegalityTable,
  absenceRequestsTable, workerFactoriesTable, tasksTable, hoursMonthExclusionsTable, hostelStaysTable, hostelsTable, scheduleEntriesTable, scheduleWeeksTable,
} from "@workspace/db";
import { authRequired, requirePage, type AuthedRequest } from "../lib/auth";
import { addDaysStr } from "../lib/dates";
import { OPEN_STATUSES, warsawToday } from "../services/taskUtils";
import { loadLeadDays } from "../services/legalityRecompute";

const router: IRouter = Router();
router.use("/workers-calendar", authRequired, requirePage("/workers-calendar"));

export type CalKind = "doc" | "contract" | "obligation" | "absence" | "vacation" | "hostel" | "birthday" | "start" | "end" | "task" | "shift";
// «зміни з графіку» — лише за явним запитом (kinds=…,shift): їх багато, у макеті фільтр вимкнений
const DEFAULT_KINDS: CalKind[] = ["doc", "contract", "obligation", "absence", "vacation", "hostel", "birthday", "start", "end", "task"];
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

export async function collectWorkerEvents(opts: { from: string; to: string; factoryId?: number | null; workerId?: number | null; city?: string | null; companyId?: number | null; kinds?: Set<CalKind> | null }): Promise<CalEvent[]> {
  const { from, to } = opts;
  const today = warsawToday();
  const want = (k: CalKind) => (opts.kinds ? opts.kinds.has(k) : DEFAULT_KINDS.includes(k));
  const wWhere = [eq(workersTable.isActive, true)] as any[];
  if (opts.workerId) wWhere.push(eq(workersTable.id, opts.workerId));
  if (opts.companyId) wWhere.push(eq(workersTable.companyId, opts.companyId));
  if (opts.city) wWhere.push(sql`exists (select 1 from factories f where f.id = ${workersTable.factoryId} and f.city = ${opts.city})`);
  if (opts.factoryId) wWhere.push(sql`(${workersTable.factoryId} = ${opts.factoryId} or exists (select 1 from worker_factories wf where wf.worker_id = ${workersTable.id} and wf.factory_id = ${opts.factoryId}))`);
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId, factoryName: factoriesTable.name, birthDate: workersTable.birthDate })
    .from(workersTable).leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id)).where(and(...wWhere));
  if (!workers.length) return [];
  const wmap = new Map(workers.map(w => [w.id, w]));
  const ids = [...wmap.keys()];
  const facs = new Map((await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable)).map(f => [f.id, f.name]));
  const ld = await loadLeadDays(); // жовта/червона зона з правила легальності
  const sev = (d: string): CalEvent["severity"] => (d < today || d <= addDaysStr(today, ld.urgent) ? "danger" : d <= addDaysStr(today, ld.warn) ? "warn" : "info");
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
  if (want("vacation")) {
    // виключення з обліку годин по місяцях (відпустка / ще не почав / ручне) — подія на 1-ше число місяця
    const m0 = from.slice(0, 7), m1 = to.slice(0, 7);
    const ex = await db.select().from(hoursMonthExclusionsTable).where(and(inArray(hoursMonthExclusionsTable.workerId, ids), gte(hoursMonthExclusionsTable.month, m0), lte(hoursMonthExclusionsTable.month, m1)));
    const label: Record<string, string> = { vacation: "Відпустка (місяць поза обліком)", not_started: "Ще не почав (місяць поза обліком)", manual: "Місяць поза обліком годин" };
    for (const e of ex) {
      const date = `${e.month}-01`; if (date < from || date > to) continue;
      const w = wmap.get(e.workerId)!;
      out.push({ id: `vac:${e.id}`, kind: "vacation", date, title: label[e.reason] ?? label.manual!, detail: e.month, ...base(w), severity: "info" });
    }
  }
  if (want("hostel")) {
    const st = await db.select({ s: hostelStaysTable, hostel: hostelsTable.name }).from(hostelStaysTable).leftJoin(hostelsTable, eq(hostelStaysTable.hostelId, hostelsTable.id)).where(inArray(hostelStaysTable.workerId, ids));
    for (const r of st) {
      const w = wmap.get(r.s.workerId!)!;
      const f = String(r.s.fromDate), tD = r.s.toDate ? String(r.s.toDate) : null;
      if (f >= from && f <= to) out.push({ id: `hostel-in:${r.s.id}`, kind: "hostel", date: f, title: `Заселення в хостел${r.hostel ? ` · ${r.hostel}` : ""}`, ...base(w), severity: "info" });
      if (tD && tD >= from && tD <= to) out.push({ id: `hostel-out:${r.s.id}`, kind: "hostel", date: tD, title: `Кінець проживання в хостелі${r.hostel ? ` · ${r.hostel}` : ""}`, ...base(w), severity: sev(tD) });
    }
  }
  if (want("shift")) {
    const weekFrom = addDaysStr(from, -6);
    const rows = await db.select({ e: scheduleEntriesTable, weekStart: scheduleWeeksTable.weekStart }).from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .where(and(inArray(scheduleEntriesTable.workerId, ids), gte(scheduleWeeksTable.weekStart, weekFrom), lte(scheduleWeeksTable.weekStart, to)));
    for (const r of rows) {
      const date = addDaysStr(String(r.weekStart), DAY_IDX[r.e.dayOfWeek] ?? 0);
      if (date < from || date > to) continue;
      const w = wmap.get(r.e.workerId)!;
      out.push({ id: `shift:${r.e.id}`, kind: "shift", date, title: `Зміна ${r.e.shift} · ${facs.get(r.e.factoryId) ?? ""}`, ...base(w, r.e.factoryId), severity: "info" });
    }
  }
  if (want("task")) {
    const ts = await db.select().from(tasksTable).where(and(inArray(tasksTable.workerId, ids), isNotNull(tasksTable.dueAt), gte(tasksTable.dueAt, from), lte(tasksTable.dueAt, to), inArray(tasksTable.status, OPEN_STATUSES)));
    for (const t of ts) { const w = wmap.get(t.workerId!)!; const date = String(t.dueAt); out.push({ id: `task:${t.id}`, kind: "task", date, title: t.title, ...base(w, t.factoryId), severity: date < today ? "danger" : t.priority === "urgent" ? "warn" : "info", taskId: t.id }); }
  }
  // «Відкрити задачу», якщо автозадача на цю подію вже є (документ / умова / обовʼязок)
  const docIds = out.filter(e => e.kind === "doc" && e.docId).map(e => e.docId!);
  const withWorker = [...new Set(out.filter(e => e.kind === "obligation" || e.kind === "contract").map(e => e.workerId))];
  if (docIds.length || withWorker.length) {
    const open = await db.select({ id: tasksTable.id, documentId: tasksTable.documentId, workerId: tasksTable.workerId, factoryId: tasksTable.factoryId, source: tasksTable.source, autoParams: tasksTable.autoParams })
      .from(tasksTable).where(and(inArray(tasksTable.status, OPEN_STATUSES), sql`${tasksTable.source} like 'auto:%'`, or(...[docIds.length ? inArray(tasksTable.documentId, docIds) : sql`false`, withWorker.length ? inArray(tasksTable.workerId, withWorker) : sql`false`])));
    for (const e of out) {
      if (e.taskId) continue;
      const hit = open.find(t => (e.kind === "doc" && e.docId && t.documentId === e.docId)
        || (e.kind === "contract" && t.source === "auto:contract" && t.workerId === e.workerId && (t.factoryId ?? null) === (e.factoryId ?? null))
        || (e.kind === "obligation" && t.source === "auto:obligation" && t.workerId === e.workerId && String((t.autoParams as any)?.code ?? "") === e.id.split(":").slice(2).join(":")));
      if (hit) e.taskId = hit.id;
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.workerName.localeCompare(b.workerName, "pl"));
  return out;
}

function parseOpts(q: Record<string, unknown>) {
  const from = String(q.from ?? ""), to = String(q.to ?? "");
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return null;
  const kindsRaw = String(q.kinds ?? "").split(",").map(s => s.trim()).filter(Boolean) as CalKind[];
  return { from, to, factoryId: q.factoryId ? Number(q.factoryId) : null, workerId: q.workerId ? Number(q.workerId) : null,
    city: q.city ? String(q.city) : null, companyId: q.companyId ? Number(q.companyId) : null, kinds: kindsRaw.length ? new Set(kindsRaw) : null };
}
router.get("/workers-calendar", async (req: AuthedRequest, res) => {
  const o = parseOpts(req.query as Record<string, unknown>);
  if (!o) return res.status(400).json({ error: "from/to (YYYY-MM-DD) обовʼязкові" });
  const events = await collectWorkerEvents(o);
  return res.json({ from: o.from, to: o.to, events });
});
// Excel поточного діапазону з тими самими фільтрами (макет: кнопка «Excel»); імена капсом (nameCaps)
router.get("/workers-calendar/export.xlsx", async (req: AuthedRequest, res) => {
  const o = parseOpts(req.query as Record<string, unknown>);
  if (!o) return res.status(400).json({ error: "from/to (YYYY-MM-DD) обовʼязкові" });
  const events = await collectWorkerEvents(o);
  const { nameCaps } = await import("../services/drive");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Kalendarz");
  const KIND_PL: Record<string, string> = { doc: "Dokument", contract: "Umowa", obligation: "Obowiązek", absence: "Nieobecność", vacation: "Urlop / poza ewidencją", hostel: "Hostel", birthday: "Urodziny", start: "Start pracy", end: "Koniec pracy", task: "Zadanie", shift: "Zmiana" };
  ws.addRow(["Data", "Pracownik", "Zakład", "Rodzaj", "Zdarzenie", "Szczegóły"]).font = { bold: true };
  for (const e of events) ws.addRow([e.date, nameCaps(e.workerName), e.factoryName ?? "", KIND_PL[e.kind] ?? e.kind, e.title, e.detail ?? ""]);
  ws.columns.forEach((c, i) => { c.width = [12, 32, 22, 16, 44, 30][i] ?? 16; });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Kalendarz pracownikow ${o.from}_${o.to}.xlsx`)}"`);
  return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

export default router;
