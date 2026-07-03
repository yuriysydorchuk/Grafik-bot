import { Router, type IRouter } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { db } from "@workspace/db";
import {
  workersTable, driversTable, factoriesTable, factoryOrdersTable,
  availabilityTable, scheduleWeeksTable, scheduleEntriesTable,
  driverShiftAssignmentsTable, driverTripsTable, driverWorkdaysTable, adminsTable, settingsTable,
  scheduleApprovalsTable, notificationsTable, unplannedWorkersTable, candidatesTable,
  hoursDisputesTable, absenceRequestsTable, advanceRequestsTable, monthlyReportsTable, funnelsTable, candidateActivityTable, companiesTable,
  documentTypesTable, workerDocumentsTable, positionsTable, factoryPositionsTable, rolesTable,
  type DayOfWeek, type Shift, type FunnelStage, type OrderRequirement,
} from "@workspace/db";
import { eq, and, desc, gte, lt, inArray } from "drizzle-orm";
import { authRequired, requireRole, requireCap, requireMainAdmin, invalidateRolesCache, type AuthedRequest } from "../lib/auth";
import { hasCap, OWNER, CAP_KEYS, PAGE_KEYS, type Role } from "../lib/roles";
import { logger } from "../lib/logger";
import {
  generateSchedule, formatWeekStart, getNextMonday, getCurrentMonday,
} from "../services/scheduleGenerator";
import { exportScheduleToDrive, getDriveFolderLink } from "../services/drive";
import { factoryShiftHours, factoryShifts, nowWarsaw, warsawDayName, reportMonthFor } from "../bot/time";
import { hashPassword } from "../lib/auth";
import { calcPayroll, round2, DEFAULT_RATES, type FinanceRates } from "../lib/payroll";
import { WORKER_DOCS_DIR, UPLOADS_ROOT, makeStoredName, deleteStoredFile } from "../lib/uploads";

const DAYS: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Actual calendar date (YYYY-MM-DD) of a schedule entry = its week's Monday + day offset.
// Month-scoped reports must attribute each shift to the month of its real date, not the
// week's Monday — otherwise a week straddling the boundary (e.g. Mon 29 Jun–Sun 5 Jul)
// counts entirely under June and July shows empty until the next full week.
function entryDateStr(weekStart: string, day: string | null): string {
  const d = new Date(String(weekStart) + "T00:00:00");
  d.setDate(d.getDate() + Math.max(0, DAYS.indexOf(day as DayOfWeek)));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Lower bound for the week filter: any week whose Monday is up to 6 days before the month
// start can still contain days that fall inside the month.
function weekFromForMonth(monthStart: string): string {
  const d = new Date(monthStart + "T00:00:00");
  d.setDate(d.getDate() - 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const router: IRouter = Router();

// Everything here requires a valid session
router.use(authRequired);

// Read/write capability for owner + scheduler (driver is read-only / live-only)
const RW = requireCap("editData");
// Whether the requester's role may see/edit financial fields (rates, invoices).
const canFinance = (req: any) => hasCap((req as AuthedRequest).admin?.role, (req as AuthedRequest).admin?.caps, "viewFinance");

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

// Uploaded document files: held in memory (≤15 MB), then written to disk by the
// handler. Whitelist common document/image types.
const DOC_MIME_WHITELIST = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/webp", "image/heic",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, DOC_MIME_WHITELIST.has(file.mimetype)),
});

// ─── Dashboard (rich analytics) ────────────────────────────────────────────────
router.get("/dashboard", async (_req, res) => {
  const currentWeek = getCurrentMonday();
  const nextWeek = getNextMonday();

  const [workers, drivers, factories, allWeeks] = await Promise.all([
    db.select().from(workersTable).where(eq(workersTable.isActive, true)),
    db.select().from(driversTable).where(eq(driversTable.isActive, true)),
    db.select().from(factoriesTable).orderBy(factoriesTable.name),
    db.select().from(scheduleWeeksTable).orderBy(desc(scheduleWeeksTable.id)),
  ]);

  // Resolve the "primary" week row per weekStart: approved preferred, else latest id
  const weekByStart = new Map<string, typeof allWeeks[number]>();
  for (const w of allWeeks) {
    const cur = weekByStart.get(w.weekStart);
    if (!cur || (w.status === "approved" && cur.status !== "approved")) weekByStart.set(w.weekStart, w);
  }
  const entryCounts = new Map<number, number>();
  {
    const rows = await db.select({ weekId: scheduleEntriesTable.weekId }).from(scheduleEntriesTable);
    for (const r of rows) entryCounts.set(r.weekId, (entryCounts.get(r.weekId) ?? 0) + 1);
  }

  // ── Planning summary for the focus week (next week) ──
  const focusWeek = nextWeek;
  const focusWk = weekByStart.get(focusWeek);
  const orders = await db.select().from(factoryOrdersTable).where(eq(factoryOrdersTable.weekStart, focusWeek));
  const focusEntries = focusWk
    ? await db.select({ factoryId: scheduleEntriesTable.factoryId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift })
        .from(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, focusWk.id))
    : [];
  const avail = await db.select({ workerId: availabilityTable.workerId, wFactory: workersTable.factoryId })
    .from(availabilityTable).leftJoin(workersTable, eq(availabilityTable.workerId, workersTable.id))
    .where(eq(availabilityTable.weekStart, focusWeek));

  const orderedByFactory = new Map<number, number>();
  const neededBySlot = new Map<string, number>(); // factoryId|day|shift -> needed
  for (const o of orders) {
    orderedByFactory.set(o.factoryId, (orderedByFactory.get(o.factoryId) ?? 0) + o.workersNeeded);
    neededBySlot.set(`${o.factoryId}|${o.dayOfWeek}|${o.shift}`, o.workersNeeded);
  }
  const assignedByFactory = new Map<number, number>();
  const assignedBySlot = new Map<string, number>();
  for (const e of focusEntries) {
    assignedByFactory.set(e.factoryId, (assignedByFactory.get(e.factoryId) ?? 0) + 1);
    const k = `${e.factoryId}|${e.day}|${e.shift}`;
    assignedBySlot.set(k, (assignedBySlot.get(k) ?? 0) + 1);
  }
  const availByFactory = new Map<number, Set<number>>();
  for (const a of avail) {
    if (a.workerId == null) continue;
    for (const f of factories) {
      if (!a.wFactory || a.wFactory === f.id) {
        if (!availByFactory.has(f.id)) availByFactory.set(f.id, new Set());
        availByFactory.get(f.id)!.add(a.workerId);
      }
    }
  }

  const planning = factories.map(f => ({
    factoryId: f.id, name: f.name,
    ordered: orderedByFactory.get(f.id) ?? 0,
    assigned: assignedByFactory.get(f.id) ?? 0,
    available: availByFactory.get(f.id)?.size ?? 0,
    status: focusWk?.status ?? "none",
  }));

  // Shortages on the focus week (needed - assigned, where positive)
  const shortages: any[] = [];
  for (const [slot, needed] of neededBySlot) {
    const [fid, day, shift] = slot.split("|");
    const assigned = assignedBySlot.get(slot) ?? 0;
    if (needed - assigned > 0) {
      shortages.push({
        factory: factories.find(f => f.id === Number(fid))?.name ?? "—",
        day, shift, needed, assigned, short: needed - assigned,
      });
    }
  }

  // ── Attendance for the latest approved week ──
  const approved = allWeeks.find(w => w.status === "approved");
  let attendance: any = null;
  if (approved) {
    const rows = await db.select({ status: scheduleEntriesTable.status }).from(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, approved.id));
    const c = { present: 0, absent: 0, scheduled: 0 };
    for (const r of rows) { if (r.status === "present") c.present++; else if (r.status === "absent") c.absent++; else c.scheduled++; }
    attendance = { weekStart: approved.weekStart, label: formatWeekStart(approved.weekStart), ...c, total: rows.length };
  }

  const recentWeeks = [...weekByStart.values()]
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart)).slice(0, 8)
    .map(w => ({ weekStart: w.weekStart, status: w.status, label: formatWeekStart(w.weekStart), entries: entryCounts.get(w.id) ?? 0 }));

  ok(res, {
    counts: {
      workers: workers.length,
      workersLinked: workers.filter(w => w.telegramId).length,
      drivers: drivers.length,
      driversLinked: drivers.filter(d => d.telegramId).length,
      factories: factories.length,
    },
    currentWeek, nextWeek,
    focusWeek, focusWeekLabel: formatWeekStart(focusWeek),
    planning, shortages, attendance, recentWeeks,
  });
});

// ─── Workers ─────────────────────────────────────────────────────────────────
router.get("/workers", RW, async (req, res) => {
  const factoryId = req.query.factoryId ? Number(req.query.factoryId) : undefined;
  const companies = await db.select().from(companiesTable);
  const coMap = new Map(companies.map(c => [c.id, c.name]));
  const positions = await db.select().from(positionsTable);
  const posMap = new Map(positions.map(p => [p.id, p]));
  const rows = (await db
    .select({
      id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode,
      telegramId: workersTable.telegramId, factoryId: workersTable.factoryId, companyId: workersTable.companyId,
      positionId: workersTable.positionId, gender: workersTable.gender, fixedShift: workersTable.fixedShift,
      factoryName: factoriesTable.name, status: workersTable.status, isActive: workersTable.isActive,
      hourlyRate: workersTable.hourlyRate, isStudent: workersTable.isStudent, under26: workersTable.under26,
    })
    .from(workersTable)
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .orderBy(workersTable.fullName))
    .map(r => ({
      ...r,
      companyName: r.companyId ? (coMap.get(r.companyId) ?? null) : null,
      positionName: r.positionId ? (posMap.get(r.positionId)?.name ?? null) : null,
      positionColor: r.positionId ? (posMap.get(r.positionId)?.color ?? null) : null,
    }));
  const filtered = rows.filter(r => factoryId == null || r.factoryId === factoryId);
  // payroll fields are financial — owner only
  if (!canFinance(req)) {
    return ok(res, filtered.map(({ hourlyRate, isStudent, under26, ...rest }) => rest));
  }
  ok(res, filtered);
});

async function nextWorkerCode(): Promise<string> {
  const all = await db.select({ code: workersTable.workerCode }).from(workersTable);
  const max = all.map(r => parseInt(r.code ?? "0", 10)).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
  return String(max + 1).padStart(5, "0");
}

const normGender = (g: any): string | null => (g === "male" || g === "female") ? g : null;
const normFixedShift = (s: any): string | null => (s != null && /^[1-6]$/.test(String(s))) ? String(s) : null;

router.post("/workers", RW, async (req, res) => {
  const { fullName, factoryId, companyId, positionId, gender, fixedShift, telegramId, workerCode, hourlyRate, isStudent, under26 } = req.body ?? {};
  if (!fullName?.trim()) return fail(res, 400, "Вкажіть ім'я");
  let code = workerCode?.trim();
  if (code && !/^\d+$/.test(code)) return fail(res, 400, "Код — лише цифри");
  if (!code) code = await nextWorkerCode();
  const dup = await db.select().from(workersTable).where(eq(workersTable.workerCode, code));
  if (dup.length) return fail(res, 400, `Код ${code} вже зайнятий`);
  const values: any = {
    fullName: fullName.trim(), factoryId: factoryId ?? null, companyId: companyId ?? null,
    positionId: positionId ?? null, gender: normGender(gender), fixedShift: normFixedShift(fixedShift),
    telegramId: telegramId?.trim() || null, workerCode: code,
  };
  if (canFinance(req)) {
    if (hourlyRate !== undefined) { const r = parseRate(hourlyRate); if (r != null) values.hourlyRate = r; }
    if (isStudent !== undefined) values.isStudent = !!isStudent;
    if (under26 !== undefined) values.under26 = !!under26;
  }
  const [w] = await db.insert(workersTable).values(values).returning();
  ok(res, w);
});

router.patch("/workers/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const { fullName, factoryId, companyId, positionId, gender, fixedShift, telegramId, workerCode, language, hourlyRate, isStudent, under26 } = req.body ?? {};
  const patch: any = {};
  if (fullName !== undefined) patch.fullName = String(fullName).trim();
  if (factoryId !== undefined) patch.factoryId = factoryId ?? null;
  if (companyId !== undefined) patch.companyId = companyId ?? null;
  if (positionId !== undefined) patch.positionId = positionId ?? null;
  if (gender !== undefined) patch.gender = normGender(gender);
  if (fixedShift !== undefined) patch.fixedShift = normFixedShift(fixedShift);
  if (telegramId !== undefined) patch.telegramId = String(telegramId).trim() || null;
  if (workerCode !== undefined) {
    const code = String(workerCode).trim();
    if (code) {
      if (!/^\d+$/.test(code)) return fail(res, 400, "Код — лише цифри");
      const dup = await db.select().from(workersTable).where(eq(workersTable.workerCode, code));
      if (dup.some(d => d.id !== id)) return fail(res, 400, `Код ${code} вже зайнятий`);
      patch.workerCode = code;
    } else patch.workerCode = null;
  }
  if (language !== undefined) patch.language = String(language).trim() || null;
  // payroll fields — owner only
  if (canFinance(req)) {
    if (hourlyRate !== undefined) { const r = parseRate(hourlyRate); if (r != null) patch.hourlyRate = r; }
    if (isStudent !== undefined) patch.isStudent = !!isStudent;
    if (under26 !== undefined) patch.under26 = !!under26;
  }
  const [w] = await db.update(workersTable).set(patch).where(eq(workersTable.id, id)).returning();
  ok(res, w);
});

router.post("/workers/:id/fire", RW, async (req, res) => {
  const id = Number(req.params.id);
  const [w] = await db.update(workersTable).set({ isActive: false, status: "fired", firedAt: new Date() }).where(eq(workersTable.id, id)).returning();
  ok(res, w);
});

router.post("/workers/:id/restore", RW, async (req, res) => {
  const id = Number(req.params.id);
  const [w] = await db.update(workersTable).set({ isActive: true, status: "active", firedAt: null }).where(eq(workersTable.id, id)).returning();
  ok(res, w);
});

// Hard delete — owner only. Firing keeps the record (status="fired"); this wipes it
// together with all owned history (schedule, availability, absences, disputes, docs).
// References owned by OTHER entities are nulled, not deleted (e.g. a request where this
// worker stood in as a substitute, or a candidate they referred / were converted from).
router.delete("/workers/:id", requireCap("deleteWorkers"), async (req, res) => {
  const id = Number(req.params.id);
  const [worker] = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, id));
  if (!worker) return fail(res, 404, "Працівника не знайдено");
  // Files live outside the DB — collect paths before the rows go away, unlink after commit.
  const docs = await db.select({ filePath: workerDocumentsTable.filePath }).from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, id));
  await db.transaction(async (tx) => {
    // Owned history → delete.
    await tx.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.workerId, id));
    await tx.delete(availabilityTable).where(eq(availabilityTable.workerId, id));
    await tx.delete(absenceRequestsTable).where(eq(absenceRequestsTable.workerId, id));
    await tx.delete(hoursDisputesTable).where(eq(hoursDisputesTable.workerId, id));
    await tx.delete(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, id));
    // Pointers owned by other entities → unlink, keep the other entity.
    await tx.update(absenceRequestsTable).set({ substituteWorkerId: null }).where(eq(absenceRequestsTable.substituteWorkerId, id));
    await tx.update(unplannedWorkersTable).set({ workerId: null }).where(eq(unplannedWorkersTable.workerId, id));
    await tx.update(candidatesTable).set({ workerId: null }).where(eq(candidatesTable.workerId, id));
    await tx.update(candidatesTable).set({ referrerWorkerId: null }).where(eq(candidatesTable.referrerWorkerId, id));
    await tx.delete(workersTable).where(eq(workersTable.id, id));
  });
  for (const d of docs) deleteStoredFile(d.filePath);
  ok(res, { ok: true });
});

// Per-worker profile + analytics (for the worker detail page).
const DAY_OFFSET: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
router.get("/workers/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const w = (await db.select().from(workersTable).where(eq(workersTable.id, id)))[0];
  if (!w) return fail(res, 404, "Не знайдено");
  const isOwner = canFinance(req);
  const factories = await db.select().from(factoriesTable);
  const facMap = new Map(factories.map(f => [f.id, f]));
  const companies = await db.select().from(companiesTable);
  const coName = w.companyId ? (companies.find(c => c.id === w.companyId)?.name ?? null) : null;
  const pos = w.positionId ? (await db.select().from(positionsTable).where(eq(positionsTable.id, w.positionId)))[0] : null;
  // effective gross rate = per-(factory,position) override if set, else worker's own rate
  const fpRate = (w.factoryId != null && w.positionId != null)
    ? (await db.select({ rate: factoryPositionsTable.rate }).from(factoryPositionsTable)
        .where(and(eq(factoryPositionsTable.factoryId, w.factoryId), eq(factoryPositionsTable.positionId, w.positionId))))[0]?.rate ?? null
    : null;

  const rows = await db
    .select({
      day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, status: scheduleEntriesTable.status,
      hoursOverride: scheduleEntriesTable.hoursOverride, weekStart: scheduleWeeksTable.weekStart,
      factoryId: scheduleEntriesTable.factoryId, factoryName: factoriesTable.name,
    })
    .from(scheduleEntriesTable)
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(eq(scheduleEntriesTable.workerId, id));

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dateOf = (weekStart: string | null, day: string) => {
    if (!weekStart) return null;
    const d = new Date(weekStart + "T00:00:00"); d.setDate(d.getDate() + (DAY_OFFSET[day] ?? 0));
    return d;
  };
  const hoursOf = (r: typeof rows[number]) => r.hoursOverride ?? factoryShiftHours(r.factoryId ? facMap.get(r.factoryId) : undefined, r.shift as any);

  let allShifts = 0, allHours = 0, allAbsent = 0, monShifts = 0, monHours = 0, monAbsent = 0;
  const enriched = rows.map(r => {
    const dt = dateOf(r.weekStart, r.day);
    const ym = dt ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}` : "";
    if (r.status === "present") { allShifts++; allHours += hoursOf(r); if (ym === thisMonth) { monShifts++; monHours += hoursOf(r); } }
    if (r.status === "absent") { allAbsent++; if (ym === thisMonth) monAbsent++; }
    return { date: dt ? dt.toISOString().slice(0, 10) : null, ts: dt ? dt.getTime() : 0, factoryName: r.factoryName, shift: r.shift, status: r.status, hours: r.status === "present" ? Math.round(hoursOf(r) * 100) / 100 : 0 };
  });
  const recent = enriched.filter(e => e.date).sort((a, b) => b.ts - a.ts).slice(0, 15).map(({ ts, ...e }) => e);
  const rel = allShifts + allAbsent > 0 ? Math.round((allShifts / (allShifts + allAbsent)) * 100) : null;
  const referralCount = (await db.select({ id: candidatesTable.id }).from(candidatesTable).where(eq(candidatesTable.referrerWorkerId, id))).length;
  const round = (n: number) => Math.round(n * 100) / 100;

  ok(res, {
    id: w.id, fullName: w.fullName, workerCode: w.workerCode, telegramId: w.telegramId,
    factoryId: w.factoryId, factoryName: w.factoryId ? (facMap.get(w.factoryId)?.name ?? null) : null,
    companyId: w.companyId, companyName: coName,
    positionId: w.positionId, positionName: pos?.name ?? null, positionColor: pos?.color ?? null,
    gender: w.gender, fixedShift: w.fixedShift,
    status: w.status, isActive: w.isActive, createdAt: w.createdAt, firedAt: w.firedAt,
    language: w.language,
    ...(isOwner ? { hourlyRate: w.hourlyRate, positionRate: fpRate, effectiveRate: fpRate ?? w.hourlyRate, isStudent: w.isStudent, under26: w.under26 } : {}),
    stats: {
      month: thisMonth, monthShifts: monShifts, monthHours: round(monHours), monthAbsent: monAbsent,
      totalShifts: allShifts, totalHours: round(allHours), totalAbsent: allAbsent, reliability: rel, referralCount,
    },
    recent,
  });
});

// ─── Work positions (admin-managed roles catalogue) ────────────────────────────
router.get("/positions", async (_req, res) => {
  const rows = await db.select().from(positionsTable).orderBy(positionsTable.sortOrder, positionsTable.id);
  ok(res, rows);
});
router.post("/positions", RW, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return fail(res, 400, "Вкажіть назву посади");
  const maxOrder = (await db.select().from(positionsTable)).reduce((m, p) => Math.max(m, p.sortOrder), 0);
  const [p] = await db.insert(positionsTable).values({
    name, color: String(req.body?.color ?? "slate"), sortOrder: maxOrder + 1,
  }).returning();
  ok(res, p);
});
router.patch("/positions/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const patch: any = {};
  if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n) return fail(res, 400, "Назва не може бути порожньою"); patch.name = n; }
  if (req.body?.color !== undefined) patch.color = String(req.body.color);
  if (req.body?.isActive !== undefined) patch.isActive = !!req.body.isActive;
  if (req.body?.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder);
  const [p] = await db.update(positionsTable).set(patch).where(eq(positionsTable.id, id)).returning();
  ok(res, p);
});
router.delete("/positions/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const used = (await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.positionId, id))).length;
  if (used > 0) return fail(res, 400, `Посада використовується у ${used} працівників — спочатку приберіть`);
  await db.delete(positionsTable).where(eq(positionsTable.id, id));
  ok(res, { ok: true });
});

// ─── Document types (admin-managed required-docs catalogue) ─────────────────────
router.get("/document-types", RW, async (_req, res) => {
  const rows = await db.select().from(documentTypesTable).orderBy(documentTypesTable.sortOrder, documentTypesTable.id);
  ok(res, rows);
});
router.post("/document-types", RW, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return fail(res, 400, "Вкажіть назву документа");
  const maxOrder = (await db.select().from(documentTypesTable)).reduce((m, d) => Math.max(m, d.sortOrder), 0);
  const [d] = await db.insert(documentTypesTable).values({
    name, required: req.body?.required !== false, hasExpiry: !!req.body?.hasExpiry, sortOrder: maxOrder + 1,
  }).returning();
  ok(res, d);
});
router.patch("/document-types/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const patch: any = {};
  if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n) return fail(res, 400, "Назва не може бути порожньою"); patch.name = n; }
  if (req.body?.required !== undefined) patch.required = !!req.body.required;
  if (req.body?.hasExpiry !== undefined) patch.hasExpiry = !!req.body.hasExpiry;
  if (req.body?.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder);
  const [d] = await db.update(documentTypesTable).set(patch).where(eq(documentTypesTable.id, id)).returning();
  ok(res, d);
});
router.delete("/document-types/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const used = (await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable).where(eq(workerDocumentsTable.docTypeId, id))).length;
  if (used > 0) return fail(res, 400, `Документ використовується у ${used} працівників — спочатку приберіть`);
  await db.delete(documentTypesTable).where(eq(documentTypesTable.id, id));
  ok(res, { ok: true });
});

// ─── Per-worker documents ───────────────────────────────────────────────────────
router.get("/workers/:id/documents", RW, async (req, res) => {
  const id = Number(req.params.id);
  const docs = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, id)).orderBy(desc(workerDocumentsTable.id));
  ok(res, docs);
});
router.post("/workers/:id/documents", RW, async (req, res) => {
  const workerId = Number(req.params.id);
  const docTypeId = req.body?.docTypeId != null ? Number(req.body.docTypeId) : null;
  let title = String(req.body?.title ?? "").trim();
  if (!title && docTypeId != null) title = (await db.select({ name: documentTypesTable.name }).from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId)))[0]?.name ?? "";
  if (!title) return fail(res, 400, "Вкажіть назву документа");
  const [d] = await db.insert(workerDocumentsTable).values({
    workerId, docTypeId, title,
    status: String(req.body?.status ?? "present"),
    number: req.body?.number?.trim() || null,
    expiresAt: req.body?.expiresAt || null,
    fileUrl: req.body?.fileUrl?.trim() || null,
    note: req.body?.note?.trim() || null,
  }).returning();
  ok(res, d);
});
router.patch("/worker-documents/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const patch: any = { updatedAt: new Date() };
  for (const k of ["title", "status", "number", "fileUrl", "note"]) if (req.body?.[k] !== undefined) patch[k] = String(req.body[k]).trim() || null;
  if (patch.title === null) return fail(res, 400, "Назва не може бути порожньою");
  if (req.body?.expiresAt !== undefined) patch.expiresAt = req.body.expiresAt || null;
  const [d] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, id)).returning();
  ok(res, d);
});
router.delete("/worker-documents/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const [doc] = await db.select({ filePath: workerDocumentsTable.filePath }).from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  await db.delete(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  deleteStoredFile(doc?.filePath);
  ok(res, { ok: true });
});

// Upload (or replace) the file attached to an existing document.
router.post("/worker-documents/:id/file", RW, uploadDoc.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  if (!req.file) return fail(res, 400, "Файл не отримано (недопустимий тип або завеликий)");
  const [doc] = await db.select({ filePath: workerDocumentsTable.filePath }).from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  if (!doc) return fail(res, 404, "Документ не знайдено");

  const storedName = makeStoredName(req.file.originalname);
  const relPath = path.join("worker-documents", storedName);
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, storedName), req.file.buffer);
  // Original filename arrives latin1-encoded from multipart — decode to UTF-8.
  const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");

  const [d] = await db.update(workerDocumentsTable).set({
    filePath: relPath,
    fileName: originalName,
    fileMime: req.file.mimetype,
    updatedAt: new Date(),
  }).where(eq(workerDocumentsTable.id, id)).returning();
  deleteStoredFile(doc.filePath); // remove the previous file, if any
  ok(res, d);
});

// Stream an uploaded document file (behind auth — these are personal docs).
router.get("/worker-documents/:id/file", RW, async (req, res) => {
  const id = Number(req.params.id);
  const [doc] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  if (!doc?.filePath) return fail(res, 404, "Файл не прикріплено");
  const abs = path.resolve(UPLOADS_ROOT, doc.filePath);
  if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) return fail(res, 404, "Файл не знайдено");
  if (doc.fileMime) res.type(doc.fileMime);
  const downloadName = encodeURIComponent(doc.fileName || `document-${id}`);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${downloadName}`);
  fs.createReadStream(abs).pipe(res);
});

// Personal invite link for a worker — they tap it and the bot links their Telegram.
router.get("/workers/:id/invite", RW, async (req, res) => {
  const id = Number(req.params.id);
  const w = (await db.select().from(workersTable).where(eq(workersTable.id, id)))[0];
  if (!w) return fail(res, 404, "Не знайдено");
  let code = w.workerCode;
  if (!code) { code = await nextWorkerCode(); await db.update(workersTable).set({ workerCode: code }).where(eq(workersTable.id, id)); }
  const username = process.env.TELEGRAM_BOT_USERNAME || "";
  ok(res, { code, link: username ? `https://t.me/${username}?start=${code}` : `?start=${code}` });
});

// ─── Manual broadcast + chat cleanup ───────────────────────────────────────────
// Send a custom message to all workers / one factory's workers / selected workers.
router.post("/broadcast", RW, async (req, res) => {
  const { text, target, factoryId, workerIds } = req.body ?? {};
  if (!text?.trim()) return fail(res, 400, "Введіть текст повідомлення");
  const workers = await db.select({ id: workersTable.id, tid: workersTable.telegramId, factoryId: workersTable.factoryId })
    .from(workersTable).where(eq(workersTable.isActive, true));
  let targets = workers;
  if (target === "factory") {
    if (!factoryId) return fail(res, 400, "Оберіть фабрику");
    targets = workers.filter(w => w.factoryId === Number(factoryId));
  } else if (target === "selected") {
    const ids: number[] = Array.isArray(workerIds) ? workerIds.map(Number) : [];
    if (!ids.length) return fail(res, 400, "Оберіть працівників");
    targets = workers.filter(w => ids.includes(w.id));
  }
  try {
    const { sendBroadcast } = await import("../bot/notify");
    const r = await sendBroadcast(targets.map(w => w.tid), String(text));
    ok(res, r);
  } catch (e) {
    logger.error({ err: e }, "broadcast failed");
    fail(res, 500, "Помилка розсилки");
  }
});

// Delete recent (< 48h) tracked bot/user messages from all workers' private chats.
router.post("/chat/clear", RW, async (_req, res) => {
  try {
    const { clearRecentChats } = await import("../bot/chat");
    const r = await clearRecentChats();
    ok(res, r);
  } catch (e) {
    logger.error({ err: e }, "chat clear failed");
    fail(res, 500, "Помилка очищення");
  }
});

// ─── Recruitment funnels ───────────────────────────────────────────────────────
const slugifyStage = (label: string, i: number) =>
  (label.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, "").slice(0, 16) || `s${i + 1}`);

// Normalize an incoming stages array: ensure unique, non-empty keys + labels.
function normStages(input: any, existing: FunnelStage[] = []): FunnelStage[] {
  const exByLabel = new Map(existing.map(s => [s.label, s.key]));
  const seen = new Set<string>();
  const out: FunnelStage[] = [];
  for (const [i, raw] of (Array.isArray(input) ? input : []).entries()) {
    const label = String(raw?.label ?? "").trim();
    if (!label) continue;
    let key = String(raw?.key ?? "").trim() || exByLabel.get(label) || slugifyStage(label, i);
    while (seen.has(key)) key += "_";
    seen.add(key);
    out.push({ key, label, color: String(raw?.color ?? "slate") });
  }
  return out;
}

async function getFunnel(id: number) {
  return (await db.select().from(funnelsTable).where(eq(funnelsTable.id, id)))[0];
}

router.get("/funnels", RW, async (_req, res) => {
  const funnels = await db.select().from(funnelsTable).orderBy(funnelsTable.sortOrder, funnelsTable.id);
  const counts = await db.select().from(candidatesTable);
  const countBy = new Map<number, number>();
  for (const c of counts) if (c.funnelId != null) countBy.set(c.funnelId, (countBy.get(c.funnelId) ?? 0) + 1);
  ok(res, funnels.map(f => ({ id: f.id, name: f.name, kind: f.kind, stages: f.stages ?? [], count: countBy.get(f.id) ?? 0 })));
});

router.post("/funnels", RW, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return fail(res, 400, "Вкажіть назву воронки");
  const stages = normStages(req.body?.stages);
  const finalStages = stages.length ? stages : [
    { key: "new", label: "Нові", color: "blue" },
    { key: "inprogress", label: "В роботі", color: "amber" },
    { key: "done", label: "Готово", color: "emerald" },
  ];
  const maxOrder = (await db.select().from(funnelsTable)).reduce((m, f) => Math.max(m, f.sortOrder), 0);
  const [f] = await db.insert(funnelsTable).values({ name, kind: "custom", stages: finalStages, sortOrder: maxOrder + 1 }).returning();
  ok(res, f);
});

router.patch("/funnels/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const f = await getFunnel(id);
  if (!f) return fail(res, 404, "Воронку не знайдено");
  const patch: any = {};
  if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n) return fail(res, 400, "Назва не може бути порожньою"); patch.name = n; }
  if (req.body?.stages !== undefined) {
    const next = normStages(req.body.stages, f.stages ?? []);
    if (next.length === 0) return fail(res, 400, "Має бути хоча б один етап");
    // For the built-in referral funnel, keep the original stage KEYS (bonus/convert depend on them)
    if (f.kind === "referral") {
      const origKeys = (f.stages ?? []).map(s => s.key);
      const byKey = new Map(next.map(s => [s.key, s]));
      patch.stages = origKeys.map(k => byKey.get(k) ?? (f.stages ?? []).find(s => s.key === k)!);
    } else {
      patch.stages = next;
    }
  }
  const [updated] = await db.update(funnelsTable).set(patch).where(eq(funnelsTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/funnels/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const f = await getFunnel(id);
  if (!f) return fail(res, 404, "Воронку не знайдено");
  if (f.kind === "referral") return fail(res, 400, "Вбудовану воронку рефералів видалити не можна");
  const used = (await db.select({ id: candidatesTable.id }).from(candidatesTable).where(eq(candidatesTable.funnelId, id))).length;
  if (used > 0) return fail(res, 400, `У воронці ${used} кандидат(ів) — спочатку перенесіть або видаліть їх`);
  await db.delete(funnelsTable).where(eq(funnelsTable.id, id));
  ok(res, { ok: true });
});

// ─── Candidates / recruitment ──────────────────────────────────────────────────
async function referralFunnelId(): Promise<number | null> {
  const f = (await db.select({ id: funnelsTable.id }).from(funnelsTable).where(eq(funnelsTable.kind, "referral")))[0];
  return f?.id ?? null;
}

// CRM activity log helper. adminId = the acting user (from auth), or null for system events.
async function logActivity(candidateId: number, adminId: number | null, kind: string, detail?: string | null) {
  try { await db.insert(candidateActivityTable).values({ candidateId, adminId: adminId ?? null, kind, detail: detail ?? null }); }
  catch (e) { logger.error({ err: e }, "logActivity failed"); }
}
const actingAdminId = (req: any): number | null => (req as AuthedRequest).admin?.adminId ?? null;
// resolve a stage key to its human label within a funnel
async function stageLabelOf(funnelId: number | null, key: string): Promise<string> {
  if (funnelId == null) return key;
  const f = await getFunnel(funnelId);
  return (f?.stages ?? []).find(s => s.key === key)?.label ?? key;
}

const adminNameMap = async () => {
  const admins = await db.select({ id: adminsTable.id, name: adminsTable.name }).from(adminsTable);
  return new Map(admins.map(a => [a.id, a.name]));
};

router.get("/candidates", RW, async (req, res) => {
  const funnelId = req.query.funnelId ? Number(req.query.funnelId) : null;
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const rows = await db.select().from(candidatesTable).orderBy(desc(candidatesTable.id));
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, isActive: workersTable.isActive, code: workersTable.workerCode }).from(workersTable);
  const factories = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable);
  const aMap = await adminNameMap();
  const wMap = new Map(workers.map(w => [w.id, w]));
  const fMap = new Map(factories.map(f => [f.id, f.name]));
  let filtered = funnelId != null ? rows.filter(c => c.funnelId === funnelId) : rows;
  if (q) filtered = filtered.filter(c => {
    const refName = c.referrerWorkerId ? (wMap.get(c.referrerWorkerId)?.fullName ?? "") : "";
    const asgName = c.assignedAdminId ? (aMap.get(c.assignedAdminId) ?? "") : "";
    return [c.fullName, c.phone, c.telegramId, c.email, c.notes, refName, asgName].some(v => (v ?? "").toLowerCase().includes(q));
  });
  ok(res, filtered.map(c => ({
    id: c.id, fullName: c.fullName, telegramId: c.telegramId, phone: c.phone, email: c.email, funnelId: c.funnelId,
    stage: c.stage, factoryId: c.factoryId, factoryName: c.factoryId ? (fMap.get(c.factoryId) ?? null) : null,
    referrerWorkerId: c.referrerWorkerId,
    referrerName: c.referrerWorkerId ? (wMap.get(c.referrerWorkerId)?.fullName ?? null) : null,
    assignedAdminId: c.assignedAdminId, assignedName: c.assignedAdminId ? (aMap.get(c.assignedAdminId) ?? null) : null,
    nextActionAt: c.nextActionAt,
    workerId: c.workerId,
    workerActive: c.workerId ? !!wMap.get(c.workerId)?.isActive : false,
    workerCode: c.workerId ? (wMap.get(c.workerId)?.code ?? null) : null,
    bonusAmount: c.bonusAmount, bonusPaid: c.bonusPaid, notes: c.notes, createdAt: c.createdAt,
  })));
});

// Lightweight staff list for assignee pickers (owner+scheduler) — names only.
router.get("/staff", RW, async (_req, res) => {
  const admins = await db.select({ id: adminsTable.id, name: adminsTable.name, role: adminsTable.role }).from(adminsTable).orderBy(adminsTable.id);
  ok(res, admins);
});

// Full candidate detail + activity timeline.
router.get("/candidates/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const c = (await db.select().from(candidatesTable).where(eq(candidatesTable.id, id)))[0];
  if (!c) return fail(res, 404, "Не знайдено");
  const aMap = await adminNameMap();
  const wMap = new Map((await db.select({ id: workersTable.id, fullName: workersTable.fullName, isActive: workersTable.isActive, code: workersTable.workerCode }).from(workersTable)).map(w => [w.id, w]));
  const fName = c.factoryId ? (await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, c.factoryId)))[0]?.name ?? null : null;
  const acts = await db.select().from(candidateActivityTable).where(eq(candidateActivityTable.candidateId, id)).orderBy(desc(candidateActivityTable.id));
  ok(res, {
    id: c.id, fullName: c.fullName, telegramId: c.telegramId, phone: c.phone, email: c.email, funnelId: c.funnelId,
    stage: c.stage, factoryId: c.factoryId, factoryName: fName,
    referrerWorkerId: c.referrerWorkerId, referrerName: c.referrerWorkerId ? (wMap.get(c.referrerWorkerId)?.fullName ?? null) : null,
    assignedAdminId: c.assignedAdminId, assignedName: c.assignedAdminId ? (aMap.get(c.assignedAdminId) ?? null) : null,
    nextActionAt: c.nextActionAt,
    workerId: c.workerId, workerActive: c.workerId ? !!wMap.get(c.workerId)?.isActive : false, workerCode: c.workerId ? (wMap.get(c.workerId)?.code ?? null) : null,
    bonusAmount: c.bonusAmount, bonusPaid: c.bonusPaid, notes: c.notes, createdAt: c.createdAt,
    activity: acts.map(a => ({ id: a.id, kind: a.kind, detail: a.detail, adminId: a.adminId, adminName: a.adminId ? (aMap.get(a.adminId) ?? null) : null, createdAt: a.createdAt })),
  });
});

// Add a manual activity entry (note / call / message / meeting).
router.post("/candidates/:id/activity", RW, async (req, res) => {
  const id = Number(req.params.id);
  const kind = String(req.body?.kind ?? "note");
  const detail = String(req.body?.detail ?? "").trim();
  if (!["note", "call", "message", "meeting"].includes(kind)) return fail(res, 400, "Невірний тип дії");
  if (!detail && kind === "note") return fail(res, 400, "Порожня нотатка");
  await logActivity(id, actingAdminId(req), kind, detail || null);
  ok(res, { ok: true });
});

// Assign / take a candidate (adminId omitted = take it yourself).
router.post("/candidates/:id/assign", RW, async (req, res) => {
  const id = Number(req.params.id);
  const me = actingAdminId(req);
  const target = req.body?.adminId === null ? null : (req.body?.adminId != null ? Number(req.body.adminId) : me);
  const aMap = await adminNameMap();
  await db.update(candidatesTable).set({ assignedAdminId: target }).where(eq(candidatesTable.id, id));
  await logActivity(id, me, "assigned", target == null ? "Знято призначення" : `Призначено: ${aMap.get(target) ?? target}`);
  ok(res, { ok: true });
});

// Set / clear the next follow-up date.
router.post("/candidates/:id/followup", RW, async (req, res) => {
  const id = Number(req.params.id);
  const when = req.body?.when ? new Date(req.body.when) : null;
  await db.update(candidatesTable).set({ nextActionAt: when }).where(eq(candidatesTable.id, id));
  await logActivity(id, actingAdminId(req), "note", when ? `📅 Заплановано контакт: ${when.toLocaleString("uk-UA")}` : "Прибрано дату контакту");
  ok(res, { ok: true });
});

router.post("/candidates", RW, async (req, res) => {
  const { fullName, phone, factoryId, referrerWorkerId, stage, notes } = req.body ?? {};
  if (!fullName?.trim()) return fail(res, 400, "Вкажіть ім'я");
  const funnelId = req.body?.funnelId != null ? Number(req.body.funnelId) : await referralFunnelId();
  const funnel = funnelId != null ? await getFunnel(funnelId) : undefined;
  const keys = (funnel?.stages ?? []).map(s => s.key);
  const st = keys.includes(String(stage)) ? String(stage) : (keys[0] ?? "new");
  const [c] = await db.insert(candidatesTable).values({
    funnelId: funnelId ?? null,
    fullName: fullName.trim(), phone: phone?.trim() || null, email: req.body?.email?.trim() || null,
    factoryId: factoryId ? Number(factoryId) : null,
    referrerWorkerId: referrerWorkerId ? Number(referrerWorkerId) : null,
    assignedAdminId: req.body?.assignedAdminId != null ? Number(req.body.assignedAdminId) : null,
    stage: st, notes: notes?.trim() || null,
  }).returning();
  await logActivity(c!.id, actingAdminId(req), "created", `Кандидата створено${referrerWorkerId ? " (реферал)" : ""}`);
  ok(res, c);
});

router.patch("/candidates/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const { fullName, phone, factoryId, stage, notes, referrerWorkerId, funnelId } = req.body ?? {};
  const existing = (await db.select().from(candidatesTable).where(eq(candidatesTable.id, id)))[0];
  if (!existing) return fail(res, 404, "Не знайдено");
  const patch: any = {};
  if (fullName !== undefined) { if (!String(fullName).trim()) return fail(res, 400, "Ім'я не може бути порожнім"); patch.fullName = String(fullName).trim(); }
  if (phone !== undefined) patch.phone = String(phone).trim() || null;
  if (factoryId !== undefined) patch.factoryId = factoryId ? Number(factoryId) : null;
  if (referrerWorkerId !== undefined) patch.referrerWorkerId = referrerWorkerId ? Number(referrerWorkerId) : null;
  if (notes !== undefined) patch.notes = String(notes).trim() || null;
  if (req.body?.email !== undefined) patch.email = String(req.body.email).trim() || null;
  if (req.body?.assignedAdminId !== undefined) patch.assignedAdminId = req.body.assignedAdminId ? Number(req.body.assignedAdminId) : null;
  if (funnelId !== undefined) patch.funnelId = funnelId ? Number(funnelId) : null;
  if (stage !== undefined) {
    const fid = patch.funnelId ?? existing.funnelId;
    const funnel = fid != null ? await getFunnel(fid) : undefined;
    const keys = (funnel?.stages ?? []).map(s => s.key);
    if (keys.length && !keys.includes(String(stage))) return fail(res, 400, "Невірний етап");
    patch.stage = String(stage);
  }
  const [c] = await db.update(candidatesTable).set(patch).where(eq(candidatesTable.id, id)).returning();
  // CRM activity: log meaningful changes
  const who = actingAdminId(req);
  if (patch.stage !== undefined && patch.stage !== existing.stage) {
    const from = await stageLabelOf(existing.funnelId, existing.stage);
    const to = await stageLabelOf(patch.funnelId ?? existing.funnelId, patch.stage);
    await logActivity(id, who, "stage", `${from} → ${to}`);
  }
  if (patch.assignedAdminId !== undefined && patch.assignedAdminId !== existing.assignedAdminId) {
    const aMap = await adminNameMap();
    await logActivity(id, who, "assigned", patch.assignedAdminId == null ? "Знято призначення" : `Призначено: ${aMap.get(patch.assignedAdminId) ?? patch.assignedAdminId}`);
  }
  const editedFields = ["fullName", "phone", "email", "factoryId", "referrerWorkerId", "notes"].filter(f => patch[f] !== undefined && patch[f] !== (existing as any)[f]);
  if (editedFields.length) await logActivity(id, who, "updated", "Оновлено дані картки");
  ok(res, c);
});

// Convert a candidate into an active worker (after the interview/decision).
router.post("/candidates/:id/convert", RW, async (req, res) => {
  const id = Number(req.params.id);
  const c = (await db.select().from(candidatesTable).where(eq(candidatesTable.id, id)))[0];
  if (!c) return fail(res, 404, "Не знайдено");
  if (c.workerId) return fail(res, 400, "Кандидат вже переведений у працівники");
  const factoryId = req.body?.factoryId != null ? Number(req.body.factoryId) : c.factoryId;

  let workerId: number;
  // If this Telegram is already a worker, link to it; otherwise create a new worker.
  const existingWorker = c.telegramId
    ? (await db.select().from(workersTable).where(eq(workersTable.telegramId, c.telegramId)))[0]
    : undefined;
  if (existingWorker) {
    workerId = existingWorker.id;
    await db.update(workersTable).set({ isActive: true, status: "active", factoryId: factoryId ?? existingWorker.factoryId }).where(eq(workersTable.id, workerId));
  } else {
    const codeNew = await nextWorkerCode();
    const [w] = await db.insert(workersTable).values({
      fullName: c.fullName, factoryId: factoryId ?? null,
      telegramId: c.telegramId || null, workerCode: codeNew,
    }).returning();
    workerId = w!.id;
  }
  const [updated] = await db.update(candidatesTable)
    .set({ workerId, stage: "hired", factoryId: factoryId ?? c.factoryId })
    .where(eq(candidatesTable.id, id)).returning();

  // Notify the referrer their friend is now active.
  try {
    if (c.referrerWorkerId) {
      const ref = (await db.select().from(workersTable).where(eq(workersTable.id, c.referrerWorkerId)))[0];
      if (ref?.telegramId) {
        const { sendCandidateActive } = await import("../bot/notify");
        await sendCandidateActive(ref.telegramId, c.fullName, ref.language);
      }
    }
  } catch (e) { logger.error({ err: e }, "notify referrer (convert) failed"); }

  await logActivity(id, actingAdminId(req), "converted", "Переведено у працівники");
  ok(res, updated);
});

router.post("/candidates/:id/bonus", RW, async (req, res) => {
  const id = Number(req.params.id);
  const c = (await db.select().from(candidatesTable).where(eq(candidatesTable.id, id)))[0];
  if (!c) return fail(res, 404, "Не знайдено");
  const patch: any = {};
  if (req.body?.bonusAmount !== undefined) patch.bonusAmount = parseRate(req.body.bonusAmount);
  if (req.body?.bonusPaid !== undefined) patch.bonusPaid = !!req.body.bonusPaid;
  const [updated] = await db.update(candidatesTable).set(patch).where(eq(candidatesTable.id, id)).returning();
  // Notify the referrer when a bonus is marked paid.
  try {
    if (patch.bonusPaid === true && !c.bonusPaid && c.referrerWorkerId) {
      const ref = (await db.select().from(workersTable).where(eq(workersTable.id, c.referrerWorkerId)))[0];
      if (ref?.telegramId) {
        const { sendBonusPaid } = await import("../bot/notify");
        await sendBonusPaid(ref.telegramId, c.fullName, updated!.bonusAmount ?? null, ref.language);
      }
    }
  } catch (e) { logger.error({ err: e }, "notify referrer (bonus) failed"); }
  if (patch.bonusPaid === true && !c.bonusPaid) await logActivity(id, actingAdminId(req), "bonus", `💰 Бонус виплачено${updated?.bonusAmount != null ? ` — ${updated.bonusAmount} zł` : ""}`);
  ok(res, updated);
});

router.delete("/candidates/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(candidatesTable).where(eq(candidatesTable.id, id));
  ok(res, { ok: true });
});

// ─── Drivers ─────────────────────────────────────────────────────────────────
router.get("/drivers", async (_req, res) => {
  const rows = await db.select().from(driversTable).where(eq(driversTable.isActive, true)).orderBy(driversTable.name);
  ok(res, rows);
});

router.post("/drivers", RW, async (req, res) => {
  const { name, vehicle, phone, seats } = req.body ?? {};
  if (!name?.trim()) return fail(res, 400, "Вкажіть ім'я");
  // unique 5-digit invite code
  let code = "";
  for (let i = 0; i < 50; i++) {
    const c = String(Math.floor(10000 + Math.random() * 90000));
    if ((await db.select().from(driversTable).where(eq(driversTable.inviteCode, c))).length === 0) { code = c; break; }
  }
  const [d] = await db.insert(driversTable).values({
    name: name.trim(), vehicle: vehicle?.trim() || null,
    phone: phone?.trim() || null, inviteCode: code,
    seats: Number(seats) > 0 ? Math.floor(Number(seats)) : null,
  }).returning();
  ok(res, d);
});

router.patch("/drivers/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const { name, vehicle, phone, isHeadDriver } = req.body ?? {};
  // Promoting/demoting a head driver is a role assignment — head admin only.
  if (isHeadDriver !== undefined && !(req as AuthedRequest).admin?.isMain) {
    return fail(res, 403, "Лише головний адміністратор може призначати головного водія");
  }
  if (isHeadDriver === true) {
    await db.update(driversTable).set({ isHeadDriver: false });
  }
  const patch: any = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (vehicle !== undefined) patch.vehicle = String(vehicle).trim() || null;
  if (phone !== undefined) patch.phone = String(phone).trim() || null;
  if (req.body?.seats !== undefined) patch.seats = Number(req.body.seats) > 0 ? Math.floor(Number(req.body.seats)) : null;
  if (isHeadDriver !== undefined) patch.isHeadDriver = !!isHeadDriver;
  const [d] = await db.update(driversTable).set(patch).where(eq(driversTable.id, id)).returning();
  ok(res, d);
});

router.delete("/drivers/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  // Soft-delete + unlink Telegram/invite so the person loses bot access immediately
  // and the (unique) Telegram id is freed for a future re-invite.
  await db.update(driversTable).set({ isActive: false, telegramId: null, inviteCode: null, isHeadDriver: false }).where(eq(driversTable.id, id));
  ok(res, { ok: true });
});

router.get("/drivers/:id/invite", async (req, res) => {
  const id = Number(req.params.id);
  const d = (await db.select().from(driversTable).where(eq(driversTable.id, id)))[0];
  if (!d) return fail(res, 404, "Не знайдено");
  let code = d.inviteCode;
  if (!code) {
    code = String(Math.floor(10000 + Math.random() * 90000));
    await db.update(driversTable).set({ inviteCode: code }).where(eq(driversTable.id, id));
  }
  const username = process.env.TELEGRAM_BOT_USERNAME || "";
  ok(res, { code, link: username ? `https://t.me/${username}?start=drv${code}` : `?start=drv${code}` });
});

// ─── Companies (our agencies) ───────────────────────────────────────────────────
router.get("/companies", async (_req, res) => {
  const rows = await db.select().from(companiesTable).orderBy(companiesTable.name);
  const workers = await db.select({ companyId: workersTable.companyId }).from(workersTable).where(eq(workersTable.isActive, true));
  const cnt = new Map<number, number>();
  for (const w of workers) if (w.companyId != null) cnt.set(w.companyId, (cnt.get(w.companyId) ?? 0) + 1);
  ok(res, rows.map(c => ({ id: c.id, name: c.name, workerCount: cnt.get(c.id) ?? 0 })));
});
router.post("/companies", RW, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return fail(res, 400, "Вкажіть назву фірми");
  const [c] = await db.insert(companiesTable).values({ name }).returning();
  ok(res, c);
});
router.patch("/companies/:id", RW, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return fail(res, 400, "Назва не може бути порожньою");
  const [c] = await db.update(companiesTable).set({ name }).where(eq(companiesTable.id, Number(req.params.id))).returning();
  ok(res, c);
});
router.delete("/companies/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const usedW = (await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.companyId, id))).length;
  const usedF = (await db.select({ id: factoriesTable.id }).from(factoriesTable).where(eq(factoriesTable.companyId, id))).length;
  if (usedW + usedF > 0) return fail(res, 400, `Фірма використовується (${usedW} прац., ${usedF} фабрик) — спочатку переприв'яжіть`);
  await db.delete(companiesTable).where(eq(companiesTable.id, id));
  ok(res, { ok: true });
});

// ─── Factories ─────────────────────────────────────────────────────────────────
router.get("/factories", async (req, res) => {
  const rows = await db.select().from(factoriesTable).orderBy(factoriesTable.name);
  const companies = await db.select().from(companiesTable);
  const coMap = new Map(companies.map(c => [c.id, c.name]));
  const isOwner = canFinance(req);
  // per-factory positions (with the catalogue name/colour); rate is financial → owner only
  const fp = await db
    .select({ factoryId: factoryPositionsTable.factoryId, positionId: factoryPositionsTable.positionId, rate: factoryPositionsTable.rate, invoiceRate: factoryPositionsTable.invoiceRate, sortOrder: factoryPositionsTable.sortOrder, name: positionsTable.name, color: positionsTable.color })
    .from(factoryPositionsTable)
    .leftJoin(positionsTable, eq(factoryPositionsTable.positionId, positionsTable.id))
    .orderBy(factoryPositionsTable.sortOrder, factoryPositionsTable.id);
  const posByFactory = new Map<number, any[]>();
  for (const p of fp) {
    const entry: any = { positionId: p.positionId, name: p.name, color: p.color ?? "slate" };
    if (isOwner) { entry.rate = p.rate; entry.invoiceRate = p.invoiceRate; }
    (posByFactory.get(p.factoryId) ?? posByFactory.set(p.factoryId, []).get(p.factoryId)!).push(entry);
  }
  const withCo = rows.map(r => ({
    ...r,
    companyName: r.companyId ? (coMap.get(r.companyId) ?? null) : null,
    positions: posByFactory.get(r.id) ?? [],
  }));
  // invoiceRate is financial — only the owner sees it
  if (!isOwner) return ok(res, withCo.map(({ invoiceRate, ...rest }) => rest));
  ok(res, withCo);
});

// Replace a factory's position rows from a [{positionId, rate}] payload.
async function setFactoryPositions(factoryId: number, positions: any) {
  if (!Array.isArray(positions)) return;
  await db.delete(factoryPositionsTable).where(eq(factoryPositionsTable.factoryId, factoryId));
  const seen = new Set<number>();
  const rows = positions
    .map((p: any, i: number) => ({ positionId: Number(p?.positionId), rate: parseRate(p?.rate), invoiceRate: parseRate(p?.invoiceRate), sortOrder: i }))
    .filter(p => Number.isInteger(p.positionId) && p.positionId > 0 && !seen.has(p.positionId) && seen.add(p.positionId));
  if (rows.length) await db.insert(factoryPositionsTable).values(rows.map(r => ({ factoryId, ...r })));
}

// availability | orders | all  (kept in sync with the legacy usesAvailability boolean)
const normGenMode = (m: any): "availability" | "orders" | "all" =>
  (m === "orders" || m === "all") ? m : "availability";

// Validate/clean a shifts payload: [{start,end}] up to 6, "HH:MM" each
const isTime = (v: any) => typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim());
function cleanShifts(input: any): { start: string; end: string }[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter(s => s && isTime(s.start) && isTime(s.end))
    .slice(0, 6)
    .map(s => ({ start: s.start.trim(), end: s.end.trim() }));
}

const parseRate = (v: any): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
};

// Validate/clean pickup stops: [{name, time}], time optional "HH:MM"
function cleanStops(input: any): { name: string; time: string }[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter(s => s && typeof s.name === "string" && s.name.trim())
    .slice(0, 30)
    .map(s => ({ name: String(s.name).trim(), time: isTime(s.time) ? String(s.time).trim() : "" }));
}

router.post("/factories", RW, async (req, res) => {
  const { name, address, companyId, shifts, genMode, usesAvailability, usesPositions, usesGender, usesTransport, showWorkerHours, showCode, invoiceRate, stops, positions } = req.body ?? {};
  if (!name?.trim()) return fail(res, 400, "Вкажіть назву");
  const cs = cleanShifts(shifts);
  const values: any = { name: name.trim(), address: address?.trim() || null, companyId: companyId ?? null };
  if (cs && cs.length) { values.shifts = cs; values.shiftCount = cs.length; }
  const st = cleanStops(stops);
  if (st) values.stops = st;
  // gen mode: prefer explicit genMode; fall back to legacy usesAvailability boolean
  const gm = genMode !== undefined ? normGenMode(genMode) : (usesAvailability === false ? "orders" : "availability");
  values.genMode = gm; values.usesAvailability = gm === "availability";
  if (usesPositions !== undefined) values.usesPositions = !!usesPositions;
  if (usesGender !== undefined) values.usesGender = !!usesGender;
  if (usesTransport !== undefined) values.usesTransport = !!usesTransport;
  if (showWorkerHours !== undefined) values.showWorkerHours = !!showWorkerHours;
  if (showCode !== undefined) values.showCode = !!showCode;
  if (canFinance(req) && invoiceRate !== undefined) values.invoiceRate = parseRate(invoiceRate);
  const [f] = await db.insert(factoriesTable).values(values).returning();
  if (positions !== undefined) await setFactoryPositions(f!.id, positions);
  ok(res, f);
});

router.patch("/factories/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const { name, address, clientEmail, companyId, shifts, shiftCount, genMode, usesAvailability, usesPositions, usesGender, usesTransport, showWorkerHours, showCode, invoiceRate, positions } = req.body ?? {};
  const patch: any = {};
  for (const [k, v] of Object.entries({ name, address, clientEmail })) {
    if (v !== undefined) patch[k] = v === "" ? null : v;
  }
  if (companyId !== undefined) patch.companyId = companyId ?? null;
  // invoiceRate is financial — owner only
  if (canFinance(req) && invoiceRate !== undefined) patch.invoiceRate = parseRate(invoiceRate);
  const cs = cleanShifts(shifts);
  if (cs) {
    patch.shifts = cs;
    patch.shiftCount = Math.min(6, Math.max(1, cs.length || Number(shiftCount) || 1));
    // keep legacy start columns roughly in sync for any old readers
    patch.shift1Start = cs[0]?.start ?? null;
    patch.shift2Start = cs[1]?.start ?? null;
    patch.shift3Start = cs[2]?.start ?? null;
  } else if (shiftCount !== undefined) {
    patch.shiftCount = Math.min(6, Math.max(1, Number(shiftCount) || 1));
  }
  if (genMode !== undefined) { patch.genMode = normGenMode(genMode); patch.usesAvailability = patch.genMode === "availability"; }
  else if (usesAvailability !== undefined) { patch.usesAvailability = !!usesAvailability; patch.genMode = usesAvailability ? "availability" : "orders"; }
  if (usesPositions !== undefined) patch.usesPositions = !!usesPositions;
  if (usesGender !== undefined) patch.usesGender = !!usesGender;
  if (usesTransport !== undefined) patch.usesTransport = !!usesTransport;
  if (showWorkerHours !== undefined) patch.showWorkerHours = !!showWorkerHours;
  if (showCode !== undefined) patch.showCode = !!showCode;
  const st = cleanStops(req.body?.stops);
  if (st) patch.stops = st;
  const [f] = await db.update(factoriesTable).set(patch).where(eq(factoriesTable.id, id)).returning();
  if (positions !== undefined) await setFactoryPositions(id, positions);
  ok(res, f);
});

// Shared self-signup link for a factory — anyone who opens it registers themselves
// as a worker of that factory (enters their name in the bot). Admins review/edit after.
router.get("/factories/:id/join-link", RW, async (req, res) => {
  const id = Number(req.params.id);
  const f = (await db.select({ id: factoriesTable.id }).from(factoriesTable).where(eq(factoriesTable.id, id)))[0];
  if (!f) return fail(res, 404, "Не знайдено");
  const username = process.env.TELEGRAM_BOT_USERNAME || "";
  ok(res, { link: username ? `https://t.me/${username}?start=fac${id}` : `?start=fac${id}` });
});

// ─── Orders ─────────────────────────────────────────────────────────────────
router.get("/orders", RW, async (req, res) => {
  const factoryId = Number(req.query.factoryId);
  const weekStart = String(req.query.weekStart);
  if (!factoryId || !weekStart) return fail(res, 400, "factoryId та weekStart обовʼязкові");
  const [fac] = await db.select({ shiftCount: factoriesTable.shiftCount }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  const n = Math.min(6, Math.max(1, fac?.shiftCount ?? 3));
  const rows = await db.select().from(factoryOrdersTable)
    .where(and(eq(factoryOrdersTable.factoryId, factoryId), eq(factoryOrdersTable.weekStart, weekStart)));
  // `totals` = headcount per day×shift (legacy grid). `req` = optional position/gender breakdown keyed "day-shift".
  const totals: Record<string, number[]> = {};
  for (const d of DAYS) totals[d] = Array(n).fill(0);
  const reqs: Record<string, OrderRequirement[]> = {};
  for (const r of rows) {
    const i = Number(r.shift) - 1;
    if (totals[r.dayOfWeek] && i < n) totals[r.dayOfWeek]![i] = r.workersNeeded;
    if ((r.requirements ?? []).length) reqs[`${r.dayOfWeek}-${r.shift}`] = r.requirements;
  }
  ok(res, { totals, req: reqs });
});

// Sum requirement line counts → the slot's total headcount.
const reqTotal = (lines: OrderRequirement[]) => lines.reduce((s, l) => s + (Number(l.count) || 0), 0);
const normReq = (lines: any): OrderRequirement[] =>
  (Array.isArray(lines) ? lines : [])
    .map(l => ({
      positionId: l?.positionId != null ? Number(l.positionId) : null,
      gender: (l?.gender === "male" || l?.gender === "female") ? l.gender : "any",
      count: Math.max(0, Number(l?.count) || 0),
    } as OrderRequirement))
    .filter(l => l.count > 0);

router.put("/orders", RW, async (req, res) => {
  const { factoryId, weekStart, totals, req: reqMap } = req.body ?? {};
  if (!factoryId || !weekStart || !totals) return fail(res, 400, "Невірні дані");
  for (const day of DAYS) {
    const counts = (totals[day] ?? []) as number[];
    for (let s = 0; s < 6; s++) {
      const shift = String(s + 1) as Shift;
      const lines = normReq(reqMap?.[`${day}-${shift}`]);
      // breakdown present → headcount = sum of lines; otherwise use the plain number cell
      const needed = lines.length ? reqTotal(lines) : (counts[s] ?? 0);
      await db.delete(factoryOrdersTable).where(and(
        eq(factoryOrdersTable.factoryId, factoryId), eq(factoryOrdersTable.weekStart, weekStart),
        eq(factoryOrdersTable.dayOfWeek, day), eq(factoryOrdersTable.shift, shift),
      ));
      if (needed > 0) {
        await db.insert(factoryOrdersTable).values({
          factoryId, weekStart, dayOfWeek: day, shift, workersNeeded: needed, requirements: lines,
        });
      }
    }
  }
  ok(res, { ok: true });
});

// ─── Availability ─────────────────────────────────────────────────────────────
router.get("/availability", RW, async (req, res) => {
  const weekStart = String(req.query.weekStart);
  if (!weekStart) return fail(res, 400, "weekStart обовʼязковий");
  const rows = await db
    .select({
      workerId: availabilityTable.workerId, name: availabilityTable.fullNameRaw,
      day: availabilityTable.dayOfWeek, shift: availabilityTable.shift, source: availabilityTable.source,
      factoryId: workersTable.factoryId, factoryName: factoriesTable.name,
    })
    .from(availabilityTable)
    .leftJoin(workersTable, eq(availabilityTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .where(eq(availabilityTable.weekStart, weekStart));
  // group by worker (a worker can report several shifts per day → arrays)
  const byWorker = new Map<string, { name: string; workerId: number | null; source: string; factoryId: number | null; factoryName: string | null; days: Record<string, string[]> }>();
  for (const r of rows) {
    const key = r.workerId != null ? `w${r.workerId}` : `n:${r.name}`;
    if (!byWorker.has(key)) byWorker.set(key, { name: r.name, workerId: r.workerId, source: r.source, factoryId: r.factoryId, factoryName: r.factoryName, days: {} });
    const days = byWorker.get(key)!.days;
    (days[r.day] ??= []);
    if (!days[r.day]!.includes(r.shift)) days[r.day]!.push(r.shift);
  }
  // keep shifts sorted for stable display
  for (const w of byWorker.values()) for (const d of Object.keys(w.days)) w.days[d]!.sort();
  ok(res, [...byWorker.values()].sort((a, b) => a.name.localeCompare(b.name, "uk")));
});

// ─── Schedule ─────────────────────────────────────────────────────────────────
router.get("/weeks", async (_req, res) => {
  const weeks = await db.select().from(scheduleWeeksTable).orderBy(desc(scheduleWeeksTable.weekStart));
  const counts = await db.select({ weekId: scheduleEntriesTable.weekId, id: scheduleEntriesTable.id }).from(scheduleEntriesTable);
  const byWeek = new Map<number, number>();
  for (const c of counts) byWeek.set(c.weekId, (byWeek.get(c.weekId) ?? 0) + 1);
  ok(res, weeks.map(w => ({ id: w.id, weekStart: w.weekStart, status: w.status, label: formatWeekStart(w.weekStart), entries: byWeek.get(w.id) ?? 0 })));
});

router.get("/schedule", async (req, res) => {
  const weekStart = String(req.query.weekStart);
  const factoryId = req.query.factoryId ? Number(req.query.factoryId) : undefined;
  // A weekStart can have both an approved and a draft row — prefer approved, else latest id
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  // No week row yet (not generated). Still return reserve/available/factory so the
  // editor can show pools and let admins build the schedule (esp. manual factories).
  const conds = week ? [eq(scheduleEntriesTable.weekId, week.id)] : [];
  if (week && factoryId != null) conds.push(eq(scheduleEntriesTable.factoryId, factoryId));
  const entries = !week ? [] : await db
    .select({
      id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift,
      status: scheduleEntriesTable.status, workerId: scheduleEntriesTable.workerId,
      workerName: workersTable.fullName, workerCode: workersTable.workerCode,
      positionId: workersTable.positionId, gender: workersTable.gender,
      factoryId: scheduleEntriesTable.factoryId, factoryName: factoriesTable.name,
      pickedUpByName: driversTable.name,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(driversTable, eq(scheduleEntriesTable.pickedUpBy, driversTable.id))
    .where(and(...conds));

  // Reserve pool: workers who filled availability for a day+shift but aren't assigned that day
  const reserve: Record<string, { workerId: number; name: string; code: string | null; positionId: number | null; gender: string | null }[]> = {};
  const available: Record<string, { workerId: number; name: string; code: string | null; positionId: number | null; gender: string | null }[]> = {};
  let factoryInfo: { shiftCount: number; usesAvailability: boolean; genMode: string; usesPositions: boolean; usesGender: boolean } | null = null;
  if (factoryId != null) {
    // who is assigned each day (any shift)
    const assignedThatDay = new Map<string, Set<number>>(); // day -> workerIds
    for (const e of entries) {
      if (!assignedThatDay.has(e.day)) assignedThatDay.set(e.day, new Set());
      if (e.workerId) assignedThatDay.get(e.day)!.add(e.workerId);
    }

    const av = await db
      .select({ workerId: availabilityTable.workerId, day: availabilityTable.dayOfWeek, shift: availabilityTable.shift, name: workersTable.fullName, code: workersTable.workerCode, wFactory: workersTable.factoryId, positionId: workersTable.positionId, gender: workersTable.gender })
      .from(availabilityTable)
      .leftJoin(workersTable, eq(availabilityTable.workerId, workersTable.id))
      .where(eq(availabilityTable.weekStart, weekStart));
    const reserveThatDay = new Map<string, Set<number>>(); // day -> workerIds in reserve
    const seen = new Set<string>();
    for (const a of av) {
      if (a.workerId == null) continue;
      if (a.wFactory && a.wFactory !== factoryId) continue; // other factory's worker
      if (assignedThatDay.get(a.day)?.has(a.workerId)) continue; // already working that day
      const key = `${a.day}-${a.shift}`;
      const dedup = `${key}-${a.workerId}`;
      if (seen.has(dedup)) continue; seen.add(dedup);
      (reserve[key] ??= []).push({ workerId: a.workerId, name: a.name ?? "—", code: a.code, positionId: a.positionId, gender: a.gender });
      if (!reserveThatDay.has(a.day)) reserveThatDay.set(a.day, new Set());
      reserveThatDay.get(a.day)!.add(a.workerId);
    }

    // factory settings
    const [f] = await db.select({ shiftCount: factoriesTable.shiftCount, usesAvailability: factoriesTable.usesAvailability, genMode: factoriesTable.genMode, usesPositions: factoriesTable.usesPositions, usesGender: factoriesTable.usesGender }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
    if (f) factoryInfo = { shiftCount: f.shiftCount, usesAvailability: f.usesAvailability, genMode: f.genMode, usesPositions: f.usesPositions, usesGender: f.usesGender };

    // "available" pool: active workers of this factory who are NOT assigned and NOT in reserve that day
    const activeWorkers = await db
      .select({ id: workersTable.id, name: workersTable.fullName, code: workersTable.workerCode, positionId: workersTable.positionId, gender: workersTable.gender })
      .from(workersTable)
      .where(and(eq(workersTable.factoryId, factoryId), eq(workersTable.isActive, true)));
    for (const day of DAYS) {
      const assigned = assignedThatDay.get(day);
      const inReserve = reserveThatDay.get(day);
      available[day] = activeWorkers
        .filter(w => !assigned?.has(w.id) && !inReserve?.has(w.id))
        .map(w => ({ workerId: w.id, name: w.name, code: w.code, positionId: w.positionId, gender: w.gender }));
    }
  }

  // Per-factory approval state (approval is factory-scoped)
  let approved = false;
  if (week && factoryId != null) {
    const a = await db.select().from(scheduleApprovalsTable)
      .where(and(eq(scheduleApprovalsTable.weekId, week.id), eq(scheduleApprovalsTable.factoryId, factoryId)));
    approved = a.length > 0;
  }

  // Driver assignments for this week+factory (per day-shift → list of drivers) + picker list
  const assignments: Record<string, { driverId: number; driverName: string | null }[]> = {};
  if (week && factoryId != null) {
    const rows = await db
      .select({ day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, driverId: driverShiftAssignmentsTable.driverId, driverName: driversTable.name })
      .from(driverShiftAssignmentsTable)
      .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
      .where(and(eq(driverShiftAssignmentsTable.weekId, week.id), eq(driverShiftAssignmentsTable.factoryId, factoryId), eq(driverShiftAssignmentsTable.kind, "delivery")));
    for (const r of rows) (assignments[`${r.day}-${r.shift}`] ??= []).push({ driverId: r.driverId, driverName: r.driverName });
  }
  const drivers = await db.select({ id: driversTable.id, name: driversTable.name }).from(driversTable).where(eq(driversTable.isActive, true)).orderBy(driversTable.name);

  // Ordered headcount per day-shift (from client orders) so the grid can show "ordered vs scheduled".
  // orderReq carries the optional position/gender breakdown for the same slot.
  const orders: Record<string, number> = {};
  const orderReq: Record<string, OrderRequirement[]> = {};
  if (factoryId != null) {
    const orderRows = await db.select().from(factoryOrdersTable)
      .where(and(eq(factoryOrdersTable.factoryId, factoryId), eq(factoryOrdersTable.weekStart, weekStart)));
    for (const o of orderRows) {
      orders[`${o.dayOfWeek}-${o.shift}`] = o.workersNeeded;
      if ((o.requirements ?? []).length) orderReq[`${o.dayOfWeek}-${o.shift}`] = o.requirements;
    }
  }
  // Positions catalogue (for grouping/labels/colours on the schedule grid)
  const positions = await db.select({ id: positionsTable.id, name: positionsTable.name, color: positionsTable.color }).from(positionsTable).orderBy(positionsTable.sortOrder, positionsTable.id);

  // Unplanned workers drivers added on the spot (per day-shift) — shown for shifts that already happened
  const unplanned: Record<string, { name: string }[]> = {};
  if (week && factoryId != null) {
    const ur = await db.select({ day: unplannedWorkersTable.dayOfWeek, shift: unplannedWorkersTable.shift, name: unplannedWorkersTable.workerName })
      .from(unplannedWorkersTable)
      .where(and(eq(unplannedWorkersTable.weekId, week.id), eq(unplannedWorkersTable.factoryId, factoryId)));
    for (const u of ur) (unplanned[`${u.day}-${u.shift}`] ??= []).push({ name: u.name });
  }

  // Absence requests for this week → annotate planned chips: who asked off (pending /
  // confirmed) and who is covering for whom (substitute = "вийшов замість X").
  const absenceByWorker: Record<string, { status: string; reason: string | null }> = {};
  const substituteFor: Record<string, string> = {};
  if (week) {
    const reqs = await db.select({
      workerId: absenceRequestsTable.workerId, day: absenceRequestsTable.dayOfWeek, shift: absenceRequestsTable.shift,
      status: absenceRequestsTable.status, reason: absenceRequestsTable.reason, substituteWorkerId: absenceRequestsTable.substituteWorkerId,
    }).from(absenceRequestsTable).where(eq(absenceRequestsTable.weekStart, weekStart));
    if (reqs.length) {
      const ids = [...new Set(reqs.flatMap(r => [r.workerId, r.substituteWorkerId].filter((x): x is number => x != null)))];
      const names = await db.select({ id: workersTable.id, name: workersTable.fullName }).from(workersTable).where(inArray(workersTable.id, ids));
      const nameOf = new Map(names.map(n => [n.id, n.name]));
      for (const r of reqs) {
        absenceByWorker[`${r.workerId}-${r.day}-${r.shift}`] = { status: r.status, reason: r.reason };
        if (r.substituteWorkerId) substituteFor[`${r.substituteWorkerId}-${r.day}-${r.shift}`] = nameOf.get(r.workerId) ?? "?";
      }
    }
  }

  ok(res, { week: week ? { id: week.id, weekStart: week.weekStart, status: week.status } : null, entries, reserve, available, approved, factory: factoryInfo, assignments, drivers, orders, orderReq, positions, unplanned, absenceByWorker, substituteFor });
});

// Move an existing entry to another shift (drag between shifts)
router.patch("/schedule/entry/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const { shift } = req.body ?? {};
  if (!["1", "2", "3", "4", "5", "6"].includes(shift)) return fail(res, 400, "Невірна зміна");
  const [e] = await db.update(scheduleEntriesTable).set({ shift }).where(eq(scheduleEntriesTable.id, id)).returning();
  ok(res, e);
});

// Manually correct attendance (scheduler/owner) — present | absent | scheduled
router.patch("/schedule/entry/:id/status", RW, async (req, res) => {
  const id = Number(req.params.id);
  const status = String((req.body ?? {}).status);
  if (!["present", "absent", "scheduled"].includes(status)) return fail(res, 400, "Невірний статус");
  const patch: any = { status };
  if (status !== "present") patch.pickedUpBy = null; // clearing presence drops the pickup attribution
  const [e] = await db.update(scheduleEntriesTable).set(patch).where(eq(scheduleEntriesTable.id, id)).returning();
  if (!e) return fail(res, 404, "Не знайдено");
  import("../bot/notify").then(m => m.refreshExcelReports()).catch(err => logger.error({ err }, "refreshExcelReports after status edit failed"));
  ok(res, e);
});

router.post("/schedule/generate", RW, async (req, res) => {
  const { weekStart, factoryId } = req.body ?? {};
  if (!weekStart) return fail(res, 400, "weekStart обовʼязковий");
  try {
    const result = await generateSchedule(weekStart, factoryId ?? undefined);
    ok(res, result);
  } catch (e) {
    logger.error({ err: e }, "web generate failed");
    fail(res, 500, "Помилка генерації");
  }
});

// Approve a schedule. Scoped to a factory when factoryId is given (default: whole week).
// Email to client is opt-in via sendEmail.
router.post("/schedule/approve", RW, async (req, res) => {
  const { weekStart, factoryId, sendEmail } = req.body ?? {};
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) return fail(res, 404, "Тиждень не знайдено");

  // Which factories to approve: one, or all that have entries this week
  let factoryIds: number[];
  if (factoryId != null) factoryIds = [Number(factoryId)];
  else {
    const rows = await db.selectDistinct({ f: scheduleEntriesTable.factoryId }).from(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, week.id));
    factoryIds = rows.map(r => r.f);
  }
  if (factoryIds.length === 0) return fail(res, 400, "Немає графіку для затвердження");

  await db.update(scheduleWeeksTable).set({ status: "approved", approvedAt: new Date() }).where(eq(scheduleWeeksTable.id, week.id));

  const messages: string[] = [];
  for (const fId of factoryIds) {
    // record approval (idempotent)
    const exists = await db.select().from(scheduleApprovalsTable).where(and(eq(scheduleApprovalsTable.weekId, week.id), eq(scheduleApprovalsTable.factoryId, fId)));
    if (exists.length === 0) await db.insert(scheduleApprovalsTable).values({ weekId: week.id, factoryId: fId });
    else await db.update(scheduleApprovalsTable).set({ approvedAt: new Date() }).where(eq(scheduleApprovalsTable.id, exists[0]!.id));
    // Drive export (this factory only)
    try { await exportScheduleToDrive(week.id, week.weekStart, fId); } catch (e) { logger.error({ err: e }, "drive export"); messages.push("Drive: помилка"); }
    // optional email
    if (sendEmail) {
      const factory = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, fId)))[0];
      if (factory?.clientEmail) {
        try { const { sendScheduleEmail } = await import("../services/email"); const s = await sendScheduleEmail(fId, week.weekStart); messages.push(`Email (${factory.name}): ${s}`); }
        catch (e) { logger.error({ err: e }, "email"); messages.push(`Email (${factory.name}): помилка`); }
      } else messages.push(`Email (${factory?.name ?? fId}): немає адреси клієнта`);
    }
  }
  messages.unshift("Збережено на Google Drive");
  ok(res, { status: "approved", messages });
});

// Add a worker to a shift (manual edit)
router.post("/schedule/entry", RW, async (req, res) => {
  const { weekStart, workerId, factoryId, day, shift } = req.body ?? {};
  const week = (await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)))[0];
  if (!week) return fail(res, 404, "Тиждень не знайдено");
  // avoid duplicate / two shifts same day
  const existing = await db.select().from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, workerId), eq(scheduleEntriesTable.dayOfWeek, day)));
  if (existing.length) return fail(res, 400, "Працівник уже має зміну цього дня");
  const [e] = await db.insert(scheduleEntriesTable).values({ weekId: week.id, workerId, factoryId, dayOfWeek: day, shift, status: "scheduled" }).returning();
  ok(res, e);
});

router.delete("/schedule/entry/:id", RW, async (req, res) => {
  await db.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, Number(req.params.id)));
  ok(res, { ok: true });
});

// Download the Excel for one factory's week
router.get("/schedule/excel", RW, async (req, res) => {
  const weekStart = String(req.query.weekStart);
  const factoryId = Number(req.query.factoryId);
  const dayRaw = req.query.day ? String(req.query.day) : null;         // optional single-day download
  const day = dayRaw && (DAYS as string[]).includes(dayRaw) ? dayRaw : null;
  if (!weekStart || !factoryId) return fail(res, 400, "weekStart та factoryId обовʼязкові");
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) return fail(res, 404, "Графік не знайдено");
  const { buildScheduleExcelBuffer } = await import("../services/drive");
  const out = await buildScheduleExcelBuffer(week.id, factoryId, day);
  if (!out) return fail(res, 404, "Не вдалося сформувати файл");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.fileName)}"`);
  res.send(out.buffer);
});

// Send the factory's schedule to its workers + head driver via Telegram
router.post("/schedule/notify", RW, async (req, res) => {
  const { weekStart, factoryId, day } = req.body ?? {};
  if (!weekStart || !factoryId) return fail(res, 400, "weekStart та factoryId обовʼязкові");
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) return fail(res, 404, "Графік не знайдено");
  const dayCode = day && DAYS.includes(day) ? (day as DayOfWeek) : undefined;
  try {
    const { notifyFactorySchedule } = await import("../bot/notify");
    const result = await notifyFactorySchedule(week.id, week.weekStart, Number(factoryId), dayCode);
    // Mark these entries as sent — workers only see sent days in their bot schedule.
    await db.update(scheduleEntriesTable).set({ sentAt: new Date() }).where(and(
      eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.factoryId, Number(factoryId)),
      ...(dayCode ? [eq(scheduleEntriesTable.dayOfWeek, dayCode)] : []),
    ));
    ok(res, result);
  } catch (e) {
    logger.error({ err: e }, "notifyFactorySchedule failed");
    fail(res, 500, "Помилка розсилки");
  }
});

// ─── Drive link ─────────────────────────────────────────────────────────────
router.get("/drive/link", async (_req, res) => {
  ok(res, { link: await getDriveFolderLink() });
});

// ─── Reports / Google Drive links ──────────────────────────────────────────────
async function settingVal(key: string): Promise<string | null> {
  const r = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  return r[0]?.value ?? null;
}
const folderLink = (id: string | null) => id ? `https://drive.google.com/drive/folders/${id}` : null;
const fileLink = (id: string | null) => id ? `https://drive.google.com/file/d/${id}/view` : null;

router.get("/reports", RW, async (_req, res) => {
  const [root, sched, hours, trips, reports] = await Promise.all([
    settingVal("drive_root_folder_id"), settingVal("drive_schedules_folder_id"),
    settingVal("drive_hours_folder_id"), settingVal("drive_trips_folder_id"), settingVal("drive_reports_folder_id"),
  ]);
  // Per-week schedule Excel files (settings key: schedule_file_{weekId}_{factoryId})
  const allSettings = await db.select().from(settingsTable);
  const weeks = await db.select().from(scheduleWeeksTable);
  const factories = await db.select().from(factoriesTable);
  const wkById = new Map<number, typeof weeks[number]>(weeks.map(w => [w.id, w]));
  const facById = new Map<number, typeof factories[number]>(factories.map(f => [f.id, f]));
  const scheduleFiles = allSettings
    .filter(s => s.key.startsWith("schedule_file_"))
    .map(s => {
      const [, , weekId, factoryId] = s.key.split("_");
      const wk = wkById.get(Number(weekId));
      return {
        week: wk ? formatWeekStart(wk.weekStart) : weekId,
        weekStart: wk?.weekStart ?? "",
        factory: facById.get(Number(factoryId))?.name ?? factoryId,
        link: fileLink(s.value),
      };
    })
    .sort((a, b) => String(b.weekStart).localeCompare(String(a.weekStart)));
  ok(res, {
    folders: {
      root: folderLink(root), schedules: folderLink(sched),
      hours: folderLink(hours), trips: folderLink(trips), reports: folderLink(reports),
    },
    scheduleFiles,
  });
});

// ─── Reliability: per-worker attendance for a month ─────────────────────────────
router.get("/reliability", RW, async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`; // first day of next month (tz-safe)
  const rows = await db
    .select({
      workerId: scheduleEntriesTable.workerId, name: workersTable.fullName, code: workersTable.workerCode,
      factoryName: factoriesTable.name, status: scheduleEntriesTable.status, reason: scheduleEntriesTable.absenceReason,
      day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleWeeksTable.status, "approved"), gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)), lt(scheduleWeeksTable.weekStart, monthEnd)));
  const byWorker = new Map<number, any>();
  for (const r of rows) {
    if (!r.workerId) continue;
    const date = entryDateStr(String(r.weekStart), r.day);
    if (date < monthStart || date >= monthEnd) continue; // day falls outside the queried month
    if (!byWorker.has(r.workerId)) byWorker.set(r.workerId, { workerId: r.workerId, name: r.name, code: r.code, factory: r.factoryName, present: 0, absent: 0, cancelled: 0, scheduled: 0 });
    const s = byWorker.get(r.workerId);
    if (r.status === "present") s.present++;
    else if (r.status === "absent") { r.reason ? s.cancelled++ : s.absent++; }
    else s.scheduled++;
  }
  const list = [...byWorker.values()].map(s => {
    const done = s.present + s.absent + s.cancelled;
    s.rate = done > 0 ? Math.round((s.present / done) * 100) : null;
    s.shifts = s.present;
    s.hours = s.present * 8;
    return s;
  }).sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || b.absent - a.absent);
  ok(res, { month, workers: list });
});

// ─── Driver trips for a month ───────────────────────────────────────────────────
router.get("/trips", async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`; // first day of next month (tz-safe)
  const rows = await db
    .select({
      driverId: driverTripsTable.driverId, name: driversTable.name, vehicle: driversTable.vehicle,
      lateP: driverTripsTable.lateToPickup, lateF: driverTripsTable.lateToFactory,
    })
    .from(driverTripsTable)
    .leftJoin(driversTable, eq(driverTripsTable.driverId, driversTable.id))
    .where(and(gte(driverTripsTable.tripDate, monthStart), lt(driverTripsTable.tripDate, monthEnd)));
  const byDriver = new Map<number, any>();
  for (const r of rows) {
    if (!r.driverId) continue;
    if (!byDriver.has(r.driverId)) byDriver.set(r.driverId, { driverId: r.driverId, name: r.name, vehicle: r.vehicle, total: 0, latePickup: 0, lateFactory: 0 });
    const s = byDriver.get(r.driverId);
    s.total++; if (r.lateP) s.latePickup++; if (r.lateF) s.lateFactory++;
  }
  ok(res, { month, drivers: [...byDriver.values()].sort((a, b) => b.total - a.total) });
});

// ─── Mileage report (driver workdays with odometer readings) ────────────────────
// Any authed role may read (the head driver's web role sees all drivers).
router.get("/mileage", async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`; // first day of next month (tz-safe)
  const rows = await db
    .select({
      driverId: driverWorkdaysTable.driverId, name: driversTable.name, vehicle: driversTable.vehicle,
      workDate: driverWorkdaysTable.workDate, startedAt: driverWorkdaysTable.startedAt, endedAt: driverWorkdaysTable.endedAt,
      odoStart: driverWorkdaysTable.odometerStart, odoEnd: driverWorkdaysTable.odometerEnd,
    })
    .from(driverWorkdaysTable)
    .leftJoin(driversTable, eq(driverWorkdaysTable.driverId, driversTable.id))
    .where(and(gte(driverWorkdaysTable.workDate, monthStart), lt(driverWorkdaysTable.workDate, monthEnd)))
    .orderBy(driverWorkdaysTable.workDate, driverWorkdaysTable.id);
  const byDriver = new Map<number, any>();
  for (const r of rows) {
    if (!byDriver.has(r.driverId)) byDriver.set(r.driverId, { driverId: r.driverId, name: r.name, vehicle: r.vehicle, days: [], totalKm: 0, closedShifts: 0 });
    const s = byDriver.get(r.driverId);
    const km = r.odoEnd != null ? r.odoEnd - r.odoStart : null; // open workday → km unknown yet
    s.days.push({ date: r.workDate, startedAt: r.startedAt, endedAt: r.endedAt, odoStart: r.odoStart, odoEnd: r.odoEnd, km });
    if (km != null) { s.totalKm += km; s.closedShifts++; }
  }
  const drivers = [...byDriver.values()].map(d => ({ ...d, avgKm: d.closedShifts ? Math.round(d.totalKm / d.closedShifts) : null }));
  ok(res, { month, drivers: drivers.sort((a, b) => a.name.localeCompare(b.name)) });
});

// ─── Hours worked per worker for a month (payroll view, from approved schedule) ──
// ─── Hours disputes (worker-reported corrections) ──────────────────────────────
router.get("/hours-reports", RW, async (_req, res) => {
  const rows = await db
    .select({
      id: hoursDisputesTable.id, workerId: hoursDisputesTable.workerId, message: hoursDisputesTable.message,
      month: hoursDisputesTable.month, items: hoursDisputesTable.items,
      hasPhoto: hoursDisputesTable.photoFileId, status: hoursDisputesTable.status,
      createdAt: hoursDisputesTable.createdAt, resolvedAt: hoursDisputesTable.resolvedAt,
      workerName: workersTable.fullName, factoryName: factoriesTable.name,
    })
    .from(hoursDisputesTable)
    .leftJoin(workersTable, eq(hoursDisputesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .orderBy(desc(hoursDisputesTable.id));
  ok(res, rows.map(r => ({ ...r, hasPhoto: !!r.hasPhoto, items: r.items ?? [] })));
});

// Tell the worker which of their proposed corrections were accepted / not.
async function notifyWorkerDisputeResult(disputeId: number) {
  const d = (await db.select().from(hoursDisputesTable).where(eq(hoursDisputesTable.id, disputeId)))[0];
  if (!d) return;
  const w = (await db.select({ tid: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, d.workerId)))[0];
  if (!w?.tid) return;
  const { t, asLang } = await import("../bot/i18n");
  const lang = asLang(w.language);
  const items = (d.items ?? []) as any[];
  const label = (it: any) => it.kind === "add" ? t(lang, "notif.dispAdd", { date: it.date, shift: it.shift })
    : it.kind === "remove" ? t(lang, "notif.dispRemove", { date: it.date, shift: it.shift })
    : t(lang, "notif.dispChange", { date: it.date, shift: it.shift, hours: it.hours ?? "?" });
  const lines = items.map(it => `${it.applied ? t(lang, "notif.dispYes") : t(lang, "notif.dispNo")}: ${label(it)}`).join("\n");
  try {
    const { bot } = await import("../bot");
    await bot.telegram.sendMessage(w.tid, t(lang, "notif.dispHdr", { lines }), { parse_mode: "Markdown" });
  } catch (e) { logger.error({ err: e }, "notify worker dispute result failed"); }
}

router.post("/hours-reports/:id/resolve", RW, async (req, res) => {
  const id = Number(req.params.id);
  const resolved = req.body?.resolved !== false;
  const [r] = await db.update(hoursDisputesTable)
    .set({ status: resolved ? "resolved" : "new", resolvedAt: resolved ? new Date() : null })
    .where(eq(hoursDisputesTable.id, id)).returning();
  if (resolved) notifyWorkerDisputeResult(id).catch(() => {});
  ok(res, r);
});

router.delete("/hours-reports/:id", RW, async (req, res) => {
  await db.delete(hoursDisputesTable).where(eq(hoursDisputesTable.id, Number(req.params.id)));
  ok(res, { ok: true });
});

// Stream the attached photo via the bot (keeps the bot token server-side).
router.get("/hours-reports/:id/photo", RW, async (req, res) => {
  const d = (await db.select().from(hoursDisputesTable).where(eq(hoursDisputesTable.id, Number(req.params.id))))[0];
  if (!d?.photoFileId) return fail(res, 404, "Немає фото");
  try {
    const { bot } = await import("../bot");
    const link = await bot.telegram.getFileLink(d.photoFileId);
    const r = await fetch(link.href);
    if (!r.ok) return fail(res, 502, "Не вдалося завантажити фото");
    res.setHeader("Content-Type", r.headers.get("content-type") ?? "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    logger.error({ err: e }, "hours dispute photo fetch failed");
    fail(res, 500, "Помилка фото");
  }
});

router.get("/hours", RW, async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`; // first day of next month (tz-safe)
  // factory shift definitions (for actual per-shift durations + column counts)
  const facRows = await db.select().from(factoriesTable);
  const facById = new Map<number, typeof facRows[number]>(facRows.map(f => [f.id, f]));
  const isOwner = canFinance(req);
  const rates = await getFinanceRates();
  const posRates = await getPositionRates();
  const rows = await db
    .select({
      workerId: scheduleEntriesTable.workerId, name: workersTable.fullName, code: workersTable.workerCode,
      factoryId: scheduleEntriesTable.factoryId, factory: factoriesTable.name, shift: scheduleEntriesTable.shift,
      hoursOverride: scheduleEntriesTable.hoursOverride, positionId: workersTable.positionId,
      rate: workersTable.hourlyRate, isStudent: workersTable.isStudent, under26: workersTable.under26,
      day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleWeeksTable.status, "approved"), gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)), lt(scheduleWeeksTable.weekStart, monthEnd), eq(scheduleEntriesTable.status, "present")));
  const byWorker = new Map<number, any>();
  for (const r of rows) {
    if (!r.workerId) continue;
    const date = entryDateStr(String(r.weekStart), r.day);
    if (date < monthStart || date >= monthEnd) continue; // day falls outside the queried month
    const fac = r.factoryId != null ? facById.get(r.factoryId) : undefined;
    if (!byWorker.has(r.workerId)) byWorker.set(r.workerId, {
      workerId: r.workerId, name: r.name, code: r.code, factoryId: r.factoryId, factory: r.factory,
      factoryShiftCount: Math.min(6, Math.max(1, fac?.shiftCount ?? 3)),
      rate: effRate(posRates, r.factoryId, r.positionId, r.rate ?? rates.defaultRate), isStudent: !!r.isStudent, under26: !!r.under26,
      byShift: {} as Record<string, number>, shifts: 0, hours: 0,
    });
    const w = byWorker.get(r.workerId);
    w.shifts++;
    w.hours += r.hoursOverride ?? factoryShiftHours(fac, r.shift as any);
    w.byShift[r.shift] = (w.byShift[r.shift] ?? 0) + 1;
  }
  // Include ALL active workers, even those with 0 worked shifts this month.
  const activeWorkers = await db.select({
    id: workersTable.id, fullName: workersTable.fullName, code: workersTable.workerCode, positionId: workersTable.positionId,
    factoryId: workersTable.factoryId, rate: workersTable.hourlyRate, isStudent: workersTable.isStudent, under26: workersTable.under26,
  }).from(workersTable).where(eq(workersTable.isActive, true));
  for (const aw of activeWorkers) {
    if (byWorker.has(aw.id)) continue;
    const fac = aw.factoryId != null ? facById.get(aw.factoryId) : undefined;
    byWorker.set(aw.id, {
      workerId: aw.id, name: aw.fullName, code: aw.code, factoryId: aw.factoryId, factory: fac?.name ?? null,
      factoryShiftCount: Math.min(6, Math.max(1, fac?.shiftCount ?? 3)),
      rate: effRate(posRates, aw.factoryId, aw.positionId, aw.rate ?? rates.defaultRate), isStudent: !!aw.isStudent, under26: !!aw.under26,
      byShift: {} as Record<string, number>, shifts: 0, hours: 0,
    });
  }
  // worker-reported monthly hours (from the bot report) for this month
  const reports = await db.select({ workerId: monthlyReportsTable.workerId, hours: monthlyReportsTable.hoursReported, link: monthlyReportsTable.photoLink })
    .from(monthlyReportsTable).where(eq(monthlyReportsTable.month, month));
  const reportByWorker = new Map(reports.map(r => [r.workerId, r]));
  const workers = [...byWorker.values()]
    .map(w => {
      const hours = round2(w.hours);
      const rep = reportByWorker.get(w.workerId);
      const base: any = { ...w, hours, reportHours: rep?.hours ?? null, reportSubmitted: !!rep, reportLink: rep?.link ?? null };
      if (isOwner) {
        const p = calcPayroll(hours * (w.rate ?? rates.defaultRate), w.isStudent, w.under26, rates);
        base.gross = round2(p.gross); base.net = round2(p.net); base.laborCost = round2(p.laborCost);
      } else {
        delete base.rate; delete base.isStudent; delete base.under26;
      }
      return base;
    })
    .sort((a, b) => (a.factory ?? "").localeCompare(b.factory ?? "", "uk") || a.name.localeCompare(b.name, "uk"));
  ok(res, {
    month, workers,
    totalHours: Math.round(workers.reduce((s, w) => s + w.hours, 0) * 100) / 100,
    totalShifts: workers.reduce((s, w) => s + w.shifts, 0),
    ...(isOwner ? { totalNet: round2(workers.reduce((s, w) => s + (w.net ?? 0), 0)), totalGross: round2(workers.reduce((s, w) => s + (w.gross ?? 0), 0)) } : {}),
  });
});

// Remind active workers who haven't submitted their monthly report yet.
router.post("/hours/report-remind", RW, async (_req, res) => {
  // The report month follows the collection window (first 7 days of a month → previous
  // month), not the calendar month or the page selector — otherwise on the 1st we'd nag
  // people for a month that hasn't ended. Server-authoritative so it can't drift.
  const month = reportMonthFor();
  const active = await db.select({ id: workersTable.id, tid: workersTable.telegramId, lang: workersTable.language })
    .from(workersTable).where(eq(workersTable.isActive, true));
  const submitted = new Set((await db.select({ workerId: monthlyReportsTable.workerId }).from(monthlyReportsTable).where(eq(monthlyReportsTable.month, month))).map(r => r.workerId));
  const missing = active.filter(w => !submitted.has(w.id));
  const targets = missing.filter(w => w.tid);
  if (targets.length === 0) return ok(res, { notified: 0, skipped: missing.length, total: missing.length, month });
  let notified = 0, skipped = 0;
  try {
    const { bot } = await import("../bot");
    const { t, asLang } = await import("../bot/i18n");
    const label = new Date(`${month}-01`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    for (const w of targets) {
      const lang = asLang(w.lang);
      try { await bot.telegram.sendMessage(w.tid!, t(lang, "notif.reportRemind", { month: label, btn: t(lang, "menu.report") }), { parse_mode: "Markdown" }); notified++; }
      catch { skipped++; }
      await new Promise(r => setTimeout(r, 50));
    }
  } catch (e) { logger.error({ err: e }, "report remind failed"); return fail(res, 500, "Помилка розсилки"); }
  ok(res, { notified, skipped: skipped + (missing.length - targets.length), total: missing.length, month });
});

// Manually set/clear a worker's report hours for a month (admin fills it on the web).
// No photo is required for a manual entry. Empty/null hours clears the record.
router.post("/hours/report", RW, async (req, res) => {
  const workerId = Number(req.body?.workerId);
  const month = String(req.body?.month || "");
  if (!workerId || !/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, "workerId та month обовʼязкові");
  const raw = req.body?.hours;
  if (raw === null || raw === undefined || raw === "") {
    await db.delete(monthlyReportsTable).where(and(eq(monthlyReportsTable.workerId, workerId), eq(monthlyReportsTable.month, month)));
    return ok(res, { ok: true, cleared: true });
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 1 || hours > 400) return fail(res, 400, "Години: число від 1 до 400");
  const h = Math.round(hours * 100) / 100;
  const [w] = await db.select({ factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, workerId));
  await db.insert(monthlyReportsTable)
    .values({ workerId, month, factoryId: w?.factoryId ?? null, hoursReported: h, photoLink: null })
    .onConflictDoUpdate({ target: [monthlyReportsTable.workerId, monthlyReportsTable.month], set: { hoursReported: h } });
  ok(res, { ok: true, hours: h });
});

// Download an Excel of worker-reported monthly hours.
router.get("/hours/report-excel", RW, async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const { buildReportHoursExcel } = await import("../services/drive");
  const buffer = await buildReportHoursExcel(month);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Години з рапорту ${month}.xlsx`)}"`);
  res.send(buffer);
});

// ─── Finance (owner only): live invoice + labor cost + profit per factory ────────
async function getFinanceRates(): Promise<FinanceRates> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, "finance_rates"));
  if (!row) return DEFAULT_RATES;
  try { return { ...DEFAULT_RATES, ...JSON.parse(row.value) }; } catch { return DEFAULT_RATES; }
}

// Per-(factory, position) gross hourly rate overrides → effective rate resolver.
async function getPositionRates(): Promise<Map<string, number>> {
  const rows = await db.select({ factoryId: factoryPositionsTable.factoryId, positionId: factoryPositionsTable.positionId, rate: factoryPositionsTable.rate }).from(factoryPositionsTable);
  const m = new Map<string, number>();
  for (const r of rows) if (r.rate != null) m.set(`${r.factoryId}-${r.positionId}`, r.rate);
  return m;
}
// Per-(factory, position) CLIENT invoice rate overrides.
async function getPositionInvoiceRates(): Promise<Map<string, number>> {
  const rows = await db.select({ factoryId: factoryPositionsTable.factoryId, positionId: factoryPositionsTable.positionId, invoiceRate: factoryPositionsTable.invoiceRate }).from(factoryPositionsTable);
  const m = new Map<string, number>();
  for (const r of rows) if (r.invoiceRate != null) m.set(`${r.factoryId}-${r.positionId}`, r.invoiceRate);
  return m;
}
const effRate = (m: Map<string, number>, factoryId: number | null | undefined, positionId: number | null | undefined, base: number): number =>
  (factoryId != null && positionId != null && m.get(`${factoryId}-${positionId}`) != null) ? m.get(`${factoryId}-${positionId}`)! : base;

const ymdStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Compute finance for an arbitrary [start, end) range (week-start based, approved schedules only).
async function computeFinanceRange(start: string, end: string, rates: FinanceRates) {
  const facRows = await db.select().from(factoriesTable);
  const facById = new Map<number, typeof facRows[number]>(facRows.map(f => [f.id, f]));
  const posRates = await getPositionRates();
  const posInvoice = await getPositionInvoiceRates();
  const rows = await db
    .select({
      workerId: scheduleEntriesTable.workerId, factoryId: scheduleEntriesTable.factoryId, shift: scheduleEntriesTable.shift,
      positionId: workersTable.positionId,
      rate: workersTable.hourlyRate, isStudent: workersTable.isStudent, under26: workersTable.under26,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleWeeksTable.status, "approved"), gte(scheduleWeeksTable.weekStart, start), lt(scheduleWeeksTable.weekStart, end), eq(scheduleEntriesTable.status, "present")));
  // aggregate hours per (factory, worker, position) — payroll/invoice are linear so per-portion is exact.
  // position matters because both pay rate and client invoice rate can vary by position.
  const wf = new Map<string, { factoryId: number; workerId: number; positionId: number | null; rate: number; invoiceRate: number; isStudent: boolean; under26: boolean; hours: number }>();
  for (const r of rows) {
    if (!r.workerId || r.factoryId == null) continue;
    const fac = facById.get(r.factoryId);
    const key = `${r.factoryId}:${r.workerId}:${r.positionId ?? 0}`;
    if (!wf.has(key)) wf.set(key, {
      factoryId: r.factoryId, workerId: r.workerId, positionId: r.positionId ?? null,
      rate: effRate(posRates, r.factoryId, r.positionId, r.rate ?? rates.defaultRate),
      invoiceRate: effRate(posInvoice, r.factoryId, r.positionId, fac?.invoiceRate ?? 0),
      isStudent: !!r.isStudent, under26: !!r.under26, hours: 0,
    });
    wf.get(key)!.hours += factoryShiftHours(fac, r.shift as any);
  }
  const perFactory = new Map<number, any>();
  for (const f of facRows) perFactory.set(f.id, { factoryId: f.id, name: f.name, invoiceRate: f.invoiceRate ?? null, hours: 0, invoiceNet: 0, laborCost: 0, people: new Set<number>() });
  const allPeople = new Set<number>();
  for (const e of wf.values()) {
    const pf = perFactory.get(e.factoryId); if (!pf) continue;
    pf.hours += e.hours;
    pf.invoiceNet += e.hours * (e.invoiceRate ?? 0);
    pf.laborCost += calcPayroll(e.hours * e.rate, e.isStudent, e.under26, rates).laborCost;
    pf.people.add(e.workerId);
    allPeople.add(e.workerId);
  }
  const factories = [...perFactory.values()].filter(pf => pf.hours > 0).map(pf => {
    const invoiceNet = round2(pf.invoiceNet);
    const invoiceVat = round2(invoiceNet * (rates.vat / 100));
    const laborCost = round2(pf.laborCost);
    const profit = round2(invoiceNet - laborCost);
    return {
      factoryId: pf.factoryId, name: pf.name, invoiceRate: pf.invoiceRate, hasRate: pf.invoiceRate != null || pf.invoiceNet > 0,
      hours: round2(pf.hours), workers: pf.people.size, people: pf.people.size,
      invoiceNet, invoiceVat, invoiceGross: round2(invoiceNet + invoiceVat),
      laborCost, profit, margin: invoiceNet > 0 ? Math.round((profit / invoiceNet) * 100) : null,
    };
  }).sort((a, b) => b.profit - a.profit);
  const sum = (k: string) => round2(factories.reduce((s, f) => s + (f as any)[k], 0));
  const totals = {
    hours: sum("hours"), invoiceNet: sum("invoiceNet"), invoiceVat: sum("invoiceVat"),
    invoiceGross: sum("invoiceGross"), laborCost: sum("laborCost"), profit: sum("profit"),
    people: allPeople.size,
  };
  return { factories, totals };
}

// month range helper → [start, end)
function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: ymdStr(new Date(y!, m!, 1)) };
}

router.get("/finance", requireCap("viewFinance"), async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const rates = await getFinanceRates();
  const { start, end } = monthBounds(month);
  const cur = await computeFinanceRange(start, end, rates);
  const [y, m] = month.split("-").map(Number);
  const prevDate = new Date(y!, m! - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
  const pb = monthBounds(prevMonth);
  const prev = await computeFinanceRange(pb.start, pb.end, rates);
  ok(res, { month, ...cur, prev: { month: prevMonth, totals: prev.totals } });
});

// ─── Finance rate settings (owner) ───────────────────────────────────────────────
router.get("/finance/settings", requireCap("viewFinance"), async (_req, res) => {
  ok(res, await getFinanceRates());
});
router.put("/finance/settings", requireCap("viewFinance"), async (req, res) => {
  const body = req.body ?? {};
  const current = await getFinanceRates();
  const next: any = { ...current };
  for (const k of Object.keys(DEFAULT_RATES) as (keyof FinanceRates)[]) {
    const v = Number(body[k]);
    if (Number.isFinite(v) && v >= 0) next[k] = v;
  }
  await db.insert(settingsTable).values({ key: "finance_rates", value: JSON.stringify(next), updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(next), updatedAt: new Date() } });
  ok(res, next);
});

// ─── Finance comparison (owner): turnover/profit/hours/people, per factory + company ──
router.get("/finance/compare", requireCap("viewFinance"), async (req, res) => {
  const mode = String(req.query.mode || "mtd"); // mtd | mom | yoy_month | yoy
  const rates = await getFinanceRates();
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(); // m 0-based
  const day = now.getDate();
  let curStart: Date, curEnd: Date, cmpStart: Date, cmpEnd: Date, curLabel: string, cmpLabel: string;
  const monthName = (d: Date) => d.toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
  if (mode === "mom") {
    curStart = new Date(y, m, 1); curEnd = new Date(y, m + 1, 1);
    cmpStart = new Date(y, m - 1, 1); cmpEnd = new Date(y, m, 1);
    curLabel = monthName(curStart); cmpLabel = monthName(cmpStart);
  } else if (mode === "yoy_month") {
    curStart = new Date(y, m, 1); curEnd = new Date(y, m + 1, 1);
    cmpStart = new Date(y - 1, m, 1); cmpEnd = new Date(y - 1, m + 1, 1);
    curLabel = monthName(curStart); cmpLabel = monthName(cmpStart);
  } else if (mode === "yoy") {
    curStart = new Date(y, 0, 1); curEnd = new Date(y + 1, 0, 1);
    cmpStart = new Date(y - 1, 0, 1); cmpEnd = new Date(y, 0, 1);
    curLabel = String(y); cmpLabel = String(y - 1);
  } else { // mtd — month-to-date vs same day-span last month
    curStart = new Date(y, m, 1); curEnd = new Date(y, m, day + 1);
    cmpStart = new Date(y, m - 1, 1); cmpEnd = new Date(y, m - 1, day + 1);
    curLabel = `${monthName(curStart)} (1–${day})`; cmpLabel = `${monthName(cmpStart)} (1–${day})`;
  }
  const cur = await computeFinanceRange(ymdStr(curStart), ymdStr(curEnd), rates);
  const cmp = await computeFinanceRange(ymdStr(cmpStart), ymdStr(cmpEnd), rates);
  // merge per-factory (union of factories present in either period)
  const ids = new Set<number>([...cur.factories.map(f => f.factoryId), ...cmp.factories.map(f => f.factoryId)]);
  const curById = new Map(cur.factories.map(f => [f.factoryId, f]));
  const cmpById = new Map(cmp.factories.map(f => [f.factoryId, f]));
  const pick = (f: any) => f ? { turnover: f.invoiceNet, profit: f.profit, hours: f.hours, people: f.people } : { turnover: 0, profit: 0, hours: 0, people: 0 };
  const factories = [...ids].map(id => {
    const c = curById.get(id), p = cmpById.get(id);
    return { factoryId: id, name: (c ?? p)!.name, current: pick(c), compare: pick(p) };
  }).sort((a, b) => b.current.turnover - a.current.turnover);
  const companyOf = (t: any) => ({ turnover: t.invoiceNet, profit: t.profit, hours: t.hours, people: t.people });
  ok(res, {
    mode,
    current: { label: curLabel }, compare: { label: cmpLabel },
    company: { current: companyOf(cur.totals), compare: companyOf(cmp.totals) },
    factories,
  });
});

// ─── Absences with reasons for a month (from approved schedule) ──────────────────
router.get("/absences", RW, async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`; // first day of next month (tz-safe)
  const rows = await db
    .select({
      name: workersTable.fullName, code: workersTable.workerCode, factory: factoriesTable.name,
      day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, reason: scheduleEntriesTable.absenceReason,
      weekStart: scheduleWeeksTable.weekStart,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleWeeksTable.status, "approved"), gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)), lt(scheduleWeeksTable.weekStart, monthEnd), eq(scheduleEntriesTable.status, "absent")));
  const absences = rows
    .map(r => ({ name: r.name, code: r.code, factory: r.factory, date: entryDateStr(String(r.weekStart), r.day), day: r.day, shift: r.shift, reason: r.reason, excused: !!r.reason }))
    .filter(a => a.date >= monthStart && a.date < monthEnd) // keep only days that fall inside the queried month
    .sort((a, b) => b.date.localeCompare(a.date) || (a.name ?? "").localeCompare(b.name ?? "", "uk"));
  const noShow = absences.filter(a => !a.excused).length;
  ok(res, { month, absences, total: absences.length, excused: absences.length - noShow, noShow });
});

// ─── Absence requests (worker self-reported) — approve / reject on the site ──────
// Possible substitutes for a slot: same-factory active workers who reported availability
// for that day+shift and aren't already scheduled then.
async function substitutesFor(weekStart: string, day: DayOfWeek, shift: Shift, factoryId: number | null, requesterId: number) {
  if (!factoryId) return [];
  const avail = await db.select({ wid: availabilityTable.workerId }).from(availabilityTable)
    .where(and(eq(availabilityTable.weekStart, weekStart), eq(availabilityTable.dayOfWeek, day), eq(availabilityTable.shift, shift)));
  const availIds = new Set(avail.map(a => a.wid).filter((x): x is number => x != null));
  if (availIds.size === 0) return [];
  const week = (await db.select({ id: scheduleWeeksTable.id }).from(scheduleWeeksTable)
    .where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "approved"))))[0];
  let scheduled = new Set<number>();
  if (week) {
    const sch = await db.select({ wid: scheduleEntriesTable.workerId }).from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, shift)));
    scheduled = new Set(sch.map(s => s.wid));
  }
  const cands = await db.select({ id: workersTable.id, name: workersTable.fullName }).from(workersTable)
    .where(and(eq(workersTable.isActive, true), eq(workersTable.factoryId, factoryId)));
  return cands.filter(c => availIds.has(c.id) && !scheduled.has(c.id) && c.id !== requesterId)
    .map(c => ({ id: c.id, name: c.name })).slice(0, 8);
}

router.get("/absence-requests", RW, async (_req, res) => {
  const rows = await db
    .select({
      id: absenceRequestsTable.id, workerId: absenceRequestsTable.workerId, name: workersTable.fullName,
      factoryId: workersTable.factoryId, factory: factoriesTable.name, weekStart: absenceRequestsTable.weekStart, day: absenceRequestsTable.dayOfWeek,
      shift: absenceRequestsTable.shift, reason: absenceRequestsTable.reason, status: absenceRequestsTable.status,
      createdAt: absenceRequestsTable.createdAt,
    })
    .from(absenceRequestsTable)
    .leftJoin(workersTable, eq(absenceRequestsTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .orderBy(desc(absenceRequestsTable.id));
  const out = [];
  for (const r of rows) {
    const substitutes = r.status === "pending"
      ? await substitutesFor(String(r.weekStart), r.day as DayOfWeek, r.shift as Shift, r.factoryId, r.workerId)
      : [];
    out.push({ ...r, date: entryDate(String(r.weekStart), r.day), substitutes });
  }
  ok(res, out);
});

async function notifyAbsenceDecision(workerId: number, day: DayOfWeek, shift: Shift, accepted: boolean) {
  const w = (await db.select({ tid: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, workerId)))[0];
  if (!w?.tid) return;
  try {
    const { bot } = await import("../bot");
    const { t, asLang, dayShort } = await import("../bot/i18n");
    const lang = asLang(w.language);
    const params = { day: dayShort(lang, day), shift: t(lang, "hr.shiftN", { n: shift }) };
    const txt = accepted
      ? t(lang, "notif.absAccepted", params)
      : t(lang, "notif.absRejected", params);
    await bot.telegram.sendMessage(w.tid, txt, { parse_mode: "Markdown" });
  } catch (e) { logger.error({ err: e }, "notify absence decision failed"); }
}

router.post("/absence-requests/:id/approve", RW, async (req, res) => {
  const id = Number(req.params.id);
  const r = (await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, id)))[0];
  if (!r) return fail(res, 404, "Не знайдено");
  await db.update(absenceRequestsTable).set({ status: "accepted" }).where(eq(absenceRequestsTable.id, id));
  // mark the matching schedule entry absent
  const week = (await db.select({ id: scheduleWeeksTable.id }).from(scheduleWeeksTable)
    .where(and(eq(scheduleWeeksTable.weekStart, String(r.weekStart)), eq(scheduleWeeksTable.status, "approved"))))[0];
  if (week) {
    const [e] = await db.select({ id: scheduleEntriesTable.id }).from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, r.workerId), eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek), eq(scheduleEntriesTable.shift, r.shift)));
    if (e) await db.update(scheduleEntriesTable).set({ status: "absent", absenceReason: r.reason ?? undefined, pickedUpBy: null }).where(eq(scheduleEntriesTable.id, e.id));
  }
  notifyAbsenceDecision(r.workerId, r.dayOfWeek as DayOfWeek, r.shift as Shift, true).catch(() => {});
  import("../bot/notify").then(m => m.refreshExcelReports()).catch(() => {});
  ok(res, { ok: true });
});

router.post("/absence-requests/:id/reject", RW, async (req, res) => {
  const id = Number(req.params.id);
  const r = (await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, id)))[0];
  if (!r) return fail(res, 404, "Не знайдено");
  await db.update(absenceRequestsTable).set({ status: "rejected" }).where(eq(absenceRequestsTable.id, id));
  notifyAbsenceDecision(r.workerId, r.dayOfWeek as DayOfWeek, r.shift as Shift, false).catch(() => {});
  ok(res, { ok: true });
});

// Approve the absence AND put a substitute on that slot in one click.
router.post("/absence-requests/:id/substitute", RW, async (req, res) => {
  const id = Number(req.params.id);
  const subId = Number(req.body?.workerId);
  const r = (await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, id)))[0];
  if (!r) return fail(res, 404, "Не знайдено");
  if (!subId) return fail(res, 400, "Оберіть заміну");
  await db.update(absenceRequestsTable).set({ status: "substituted", substituteWorkerId: subId }).where(eq(absenceRequestsTable.id, id));
  const week = (await db.select({ id: scheduleWeeksTable.id }).from(scheduleWeeksTable)
    .where(and(eq(scheduleWeeksTable.weekStart, String(r.weekStart)), eq(scheduleWeeksTable.status, "approved"))))[0];
  let factoryId: number | null = null;
  if (week) {
    const [e] = await db.select().from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, r.workerId), eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek), eq(scheduleEntriesTable.shift, r.shift)));
    if (e) {
      factoryId = e.factoryId;
      await db.update(scheduleEntriesTable).set({ status: "absent", absenceReason: r.reason ?? undefined, pickedUpBy: null }).where(eq(scheduleEntriesTable.id, e.id));
    }
    // add the substitute on the same slot (skip if already there)
    if (factoryId) {
      const dup = (await db.select({ id: scheduleEntriesTable.id }).from(scheduleEntriesTable)
        .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, subId), eq(scheduleEntriesTable.dayOfWeek, r.dayOfWeek), eq(scheduleEntriesTable.shift, r.shift))))[0];
      if (dup) await db.update(scheduleEntriesTable).set({ status: "scheduled", factoryId }).where(eq(scheduleEntriesTable.id, dup.id));
      else await db.insert(scheduleEntriesTable).values({ weekId: week.id, workerId: subId, factoryId, dayOfWeek: r.dayOfWeek, shift: r.shift, status: "scheduled" });
    }
  }
  // notify requester (accepted) + substitute (assigned)
  notifyAbsenceDecision(r.workerId, r.dayOfWeek as DayOfWeek, r.shift as Shift, true).catch(() => {});
  try {
    const sub = (await db.select({ tid: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, subId)))[0];
    if (sub?.tid) {
      const { bot } = await import("../bot");
      const { t, asLang, dayShort } = await import("../bot/i18n");
      const lang = asLang(sub.language);
      await bot.telegram.sendMessage(sub.tid, t(lang, "notif.subAssigned", { day: dayShort(lang, r.dayOfWeek), shift: t(lang, "hr.shiftN", { n: r.shift }), btn: t(lang, "menu.schedule") }), { parse_mode: "Markdown" });
    }
  } catch (e) { logger.error({ err: e }, "notify substitute failed"); }
  import("../bot/notify").then(m => m.refreshExcelReports()).catch(() => {});
  ok(res, { ok: true });
});

// ─── Salary advances ──────────────────────────────────────────────────────────
router.get("/advances", RW, async (_req, res) => {
  const rows = await db
    .select({
      id: advanceRequestsTable.id, workerId: advanceRequestsTable.workerId,
      name: workersTable.fullName, code: workersTable.workerCode, factory: factoriesTable.name,
      amount: advanceRequestsTable.amount, comment: advanceRequestsTable.comment,
      status: advanceRequestsTable.status, adminNote: advanceRequestsTable.adminNote,
      decidedAt: advanceRequestsTable.decidedAt, paidAt: advanceRequestsTable.paidAt,
      createdAt: advanceRequestsTable.createdAt,
    })
    .from(advanceRequestsTable)
    .leftJoin(workersTable, eq(advanceRequestsTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .orderBy(desc(advanceRequestsTable.id));
  ok(res, rows);
});

// Approve / reject / mark-paid. Each notifies the worker of the new status.
async function decideAdvance(req: any, res: any, target: "approved" | "rejected" | "paid") {
  const id = Number(req.params.id);
  const r = (await db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.id, id)))[0];
  if (!r) return fail(res, 404, "Не знайдено");
  if (target === "paid" && r.status !== "approved") return fail(res, 400, "Виплатити можна лише затверджений аванс");
  const patch: any = { status: target };
  if (target === "paid") patch.paidAt = new Date();
  else { patch.decidedBy = (req as AuthedRequest).admin?.adminId ?? null; patch.decidedAt = new Date(); if (req.body?.note) patch.adminNote = String(req.body.note).trim() || null; }
  await db.update(advanceRequestsTable).set(patch).where(eq(advanceRequestsTable.id, id));
  import("../bot/notify").then(m => m.notifyWorkerAdvance(r.workerId, target, r.amount, patch.adminNote ?? null)).catch(err => logger.error({ err }, "notifyWorkerAdvance failed"));
  ok(res, { ok: true });
}
router.post("/advances/:id/approve", RW, (req, res) => decideAdvance(req, res, "approved"));
router.post("/advances/:id/reject", RW, (req, res) => decideAdvance(req, res, "rejected"));
router.post("/advances/:id/paid", RW, (req, res) => decideAdvance(req, res, "paid"));

// month range helper for drill-downs. monthEnd = first day of next month (tz-safe string).
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return { monthStart: `${month}-01`, monthEnd };
}
const entryDate = (weekStart: string, day: string) => {
  const d = new Date(String(weekStart) + "T00:00:00");
  d.setDate(d.getDate() + Math.max(0, DAYS.indexOf(day as DayOfWeek)));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ─── Per-worker day-by-day detail (drill-down for Hours / Reliability) ───────────
router.get("/worker-days/:id", RW, async (req, res) => {
  const workerId = Number(req.params.id);
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const { monthStart, monthEnd } = monthRange(month);
  const facRows = await db.select().from(factoriesTable);
  const facById = new Map<number, typeof facRows[number]>(facRows.map(f => [f.id, f]));
  const w = (await db.select({ name: workersTable.fullName, code: workersTable.workerCode, factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, workerId)))[0];
  const rows = await db
    .select({
      id: scheduleEntriesTable.id,
      factoryId: scheduleEntriesTable.factoryId, factory: factoriesTable.name, day: scheduleEntriesTable.dayOfWeek,
      shift: scheduleEntriesTable.shift, status: scheduleEntriesTable.status, reason: scheduleEntriesTable.absenceReason,
      pickedUpBy: scheduleEntriesTable.pickedUpBy, weekStart: scheduleWeeksTable.weekStart,
      hoursOverride: scheduleEntriesTable.hoursOverride,
    })
    .from(scheduleEntriesTable)
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, workerId), eq(scheduleWeeksTable.status, "approved"), gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)), lt(scheduleWeeksTable.weekStart, monthEnd)));
  const driverRows = await db.select({ id: driversTable.id, name: driversTable.name }).from(driversTable);
  const days = rows.map(r => {
    const fac = r.factoryId != null ? facById.get(r.factoryId) : undefined;
    const computed = Math.round(factoryShiftHours(fac, r.shift as any) * 100) / 100;
    return {
      entryId: r.id, date: entryDate(String(r.weekStart), r.day), day: r.day, factory: r.factory, factoryId: r.factoryId, shift: r.shift,
      status: r.status, reason: r.reason,
      computedHours: computed,
      hoursOverride: r.hoursOverride ?? null,
      hours: r.status === "present" ? (r.hoursOverride ?? computed) : 0,
      pickedUpBy: r.pickedUpBy ? (driverRows.find(d => d.id === r.pickedUpBy)?.name ?? null) : null,
    };
  }).filter(d => d.date >= monthStart && d.date < monthEnd) // attribute each shift to the month of its real date
    .sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
  // worker's unresolved proposed corrections for this month (structured items)
  const disp = (await db.select().from(hoursDisputesTable)
    .where(and(eq(hoursDisputesTable.workerId, workerId), eq(hoursDisputesTable.status, "new")))
    .orderBy(desc(hoursDisputesTable.id)));
  const relevant = disp.filter(d => !d.month || d.month === month);
  ok(res, {
    workerId, name: w?.name ?? "—", code: w?.code ?? null, workerFactoryId: w?.factoryId ?? null, days,
    disputes: relevant.map(d => ({ id: d.id, message: d.message, items: d.items, hasPhoto: !!d.photoFileId, createdAt: d.createdAt })),
  });
});

// Find the approved schedule week that contains a given date (YYYY-MM-DD).
async function weekForDate(date: string) {
  const weeks = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.status, "approved"));
  const d = new Date(date + "T00:00:00").getTime();
  return weeks.find(w => {
    const start = new Date(String(w.weekStart) + "T00:00:00");
    const end = new Date(start); end.setDate(start.getDate() + 7);
    return d >= start.getTime() && d < end.getTime();
  });
}
const DOW: DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayOfDate = (date: string): DayOfWeek => DOW[new Date(date + "T00:00:00").getDay()]!;

// Admin edits a single schedule entry's hours (override) or status (e.g. remove a shift).
router.patch("/worker-days/entry/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const { hoursOverride, status } = req.body ?? {};
  const patch: any = {};
  if (hoursOverride !== undefined) {
    patch.hoursOverride = (hoursOverride === null || hoursOverride === "") ? null : Number(hoursOverride);
    if (patch.hoursOverride != null && !Number.isFinite(patch.hoursOverride)) return fail(res, 400, "Невірні години");
  }
  if (status !== undefined) {
    if (!["present", "absent", "scheduled"].includes(String(status))) return fail(res, 400, "Невірний статус");
    patch.status = status;
    if (status !== "present") patch.pickedUpBy = null;
  }
  const [e] = await db.update(scheduleEntriesTable).set(patch).where(eq(scheduleEntriesTable.id, id)).returning();
  import("../bot/notify").then(m => m.refreshExcelReports()).catch(() => {});
  ok(res, e);
});

// Admin adds a (present) shift for a worker on a given date.
router.post("/worker-days/:id/add-shift", RW, async (req, res) => {
  const workerId = Number(req.params.id);
  const { date, factoryId, shift } = req.body ?? {};
  if (!date || !factoryId || !shift) return fail(res, 400, "Вкажіть дату, фабрику і зміну");
  const week = await weekForDate(String(date));
  if (!week) return fail(res, 400, "Немає затвердженого тижня для цієї дати");
  const day = dayOfDate(String(date));
  const existing = (await db.select().from(scheduleEntriesTable).where(and(
    eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, workerId),
    eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, String(shift) as Shift),
    eq(scheduleEntriesTable.factoryId, Number(factoryId)),
  )))[0];
  let row;
  if (existing) {
    [row] = await db.update(scheduleEntriesTable).set({ status: "present" }).where(eq(scheduleEntriesTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(scheduleEntriesTable).values({
      weekId: week.id, workerId, factoryId: Number(factoryId), dayOfWeek: day, shift: String(shift) as Shift, status: "present",
    }).returning();
  }
  import("../bot/notify").then(m => m.refreshExcelReports()).catch(() => {});
  ok(res, row);
});

// Apply one of a worker's proposed corrections (add / remove / corrected hours).
router.post("/hours-reports/:id/apply", RW, async (req, res) => {
  const id = Number(req.params.id);
  const index = Number(req.body?.index);
  const d = (await db.select().from(hoursDisputesTable).where(eq(hoursDisputesTable.id, id)))[0];
  if (!d) return fail(res, 404, "Не знайдено");
  const items = [...((d.items ?? []) as any[])];
  const it = items[index];
  if (!it) return fail(res, 400, "Немає такого пункту");
  try {
    if (it.kind === "wrong" && it.entryId && it.hours != null) {
      // worker proposed corrected hours → set the override
      await db.update(scheduleEntriesTable).set({ status: "present", hoursOverride: Number(it.hours) }).where(eq(scheduleEntriesTable.id, it.entryId));
    } else if (it.kind === "remove" && it.entryId) {
      await db.update(scheduleEntriesTable).set({ status: "scheduled", pickedUpBy: null }).where(eq(scheduleEntriesTable.id, it.entryId));
    } else if (it.kind === "add" && it.date && it.shift) {
      const week = await weekForDate(String(it.date));
      if (!week) return fail(res, 400, "Немає затвердженого тижня для дати додавання");
      const day = dayOfDate(String(it.date));
      const wRow = (await db.select({ factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, d.workerId)))[0];
      const facId = it.factoryId ?? wRow?.factoryId;
      if (!facId) return fail(res, 400, "Невідома фабрика для доданої зміни");
      const dup = (await db.select().from(scheduleEntriesTable).where(and(
        eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.workerId, d.workerId),
        eq(scheduleEntriesTable.dayOfWeek, day), eq(scheduleEntriesTable.shift, String(it.shift) as Shift),
      )))[0];
      if (dup) await db.update(scheduleEntriesTable).set({ status: "present" }).where(eq(scheduleEntriesTable.id, dup.id));
      else await db.insert(scheduleEntriesTable).values({ weekId: week.id, workerId: d.workerId, factoryId: Number(facId), dayOfWeek: day, shift: String(it.shift) as Shift, status: "present" });
    }
  } catch (e) { logger.error({ err: e }, "apply dispute item failed"); return fail(res, 500, "Помилка застосування"); }
  items[index] = { ...it, applied: true };
  // a "wrong" item with no proposed hours has no action → counts as done
  const allDone = items.every(x => x.applied || (x.kind === "wrong" && x.hours == null));
  const [upd] = await db.update(hoursDisputesTable)
    .set({ items, ...(allDone ? { status: "resolved", resolvedAt: new Date() } : {}) })
    .where(eq(hoursDisputesTable.id, id)).returning();
  import("../bot/notify").then(m => m.refreshExcelReports()).catch(() => {});
  if (allDone) notifyWorkerDisputeResult(id).catch(() => {});
  ok(res, upd);
});

// ─── Per-driver day-by-day trips (drill-down for Trips) ──────────────────────────
router.get("/driver-days/:id", async (req, res) => {
  const driverId = Number(req.params.id);
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const { monthStart, monthEnd } = monthRange(month);
  const d = (await db.select({ name: driversTable.name, vehicle: driversTable.vehicle }).from(driversTable).where(eq(driversTable.id, driverId)))[0];
  const rows = await db
    .select({
      factory: factoriesTable.name, day: driverTripsTable.dayOfWeek, shift: driverTripsTable.shift, tripDate: driverTripsTable.tripDate,
      pickup: driverTripsTable.pickupStartedAt, arrived: driverTripsTable.arrivedFactoryAt, lateP: driverTripsTable.lateToPickup, lateF: driverTripsTable.lateToFactory,
    })
    .from(driverTripsTable)
    .leftJoin(factoriesTable, eq(driverTripsTable.factoryId, factoriesTable.id))
    .where(and(eq(driverTripsTable.driverId, driverId), gte(driverTripsTable.tripDate, monthStart), lt(driverTripsTable.tripDate, monthEnd)));
  const days = rows.map(r => ({
    date: String(r.tripDate), day: r.day, factory: r.factory, shift: r.shift,
    pickupAt: r.pickup, arrivedAt: r.arrived, lateP: !!r.lateP, lateF: !!r.lateF,
    travelMin: r.pickup && r.arrived ? Math.round((new Date(r.arrived).getTime() - new Date(r.pickup).getTime()) / 60000) : null,
  })).sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
  ok(res, { driverId, name: d?.name ?? "—", vehicle: d?.vehicle ?? null, days });
});

// ─── Workers who haven't filled availability for a week ─────────────────────────
// Active workers who haven't filled availability for `weekStart` (manual-factory workers excluded — they don't fill)
async function missingAvailabilityWorkers(weekStart: string) {
  const filled = await db.select({ workerId: availabilityTable.workerId }).from(availabilityTable).where(eq(availabilityTable.weekStart, weekStart));
  const ids = new Set(filled.map(f => f.workerId).filter(Boolean));
  const manualFactoryIds = new Set(
    (await db.select({ id: factoriesTable.id }).from(factoriesTable).where(eq(factoriesTable.usesAvailability, false))).map(f => f.id),
  );
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, telegramId: workersTable.telegramId, language: workersTable.language, factoryId: workersTable.factoryId, factoryName: factoriesTable.name })
    .from(workersTable).leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .where(eq(workersTable.isActive, true)).orderBy(workersTable.fullName);
  return workers.filter(w => !ids.has(w.id) && !(w.factoryId && manualFactoryIds.has(w.factoryId)));
}

router.get("/availability/missing", async (req, res) => {
  ok(res, await missingAvailabilityWorkers(String(req.query.weekStart)));
});

// Send a Telegram availability reminder to everyone in the "missing" list (owner+scheduler)
router.post("/availability/remind", RW, async (req, res) => {
  const weekStart = String((req.body ?? {}).weekStart || "");
  if (!weekStart) return fail(res, 400, "weekStart обовʼязковий");
  const missing = await missingAvailabilityWorkers(weekStart);
  const withTg = missing.filter(w => w.telegramId);
  if (withTg.length === 0) return ok(res, { notified: 0, skipped: missing.length, total: missing.length });
  try {
    const { remindAvailability } = await import("../services/scheduler");
    const r = await remindAvailability(weekStart, withTg);
    ok(res, { ...r, skipped: r.skipped + (missing.length - withTg.length), total: missing.length });
  } catch (e) {
    logger.error({ err: e }, "availability remind failed");
    fail(res, 500, "Помилка розсилки");
  }
});

// ─── Admins (owner only) ──────────────────────────────────────────────────────
const adminInviteLink = (code: string) => {
  const u = process.env.TELEGRAM_BOT_USERNAME || "";
  return u ? `https://t.me/${u}?start=adm${code}` : `?start=adm${code}`;
};
async function uniqueAdminCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const c = Math.random().toString(36).slice(2, 8);
    if ((await db.select().from(adminsTable).where(eq(adminsTable.inviteCode, c))).length === 0) return c;
  }
  return Math.random().toString(36).slice(2, 10);
}
// The head admin is the row flagged is_main (set once in the DB; the bot can never grant it).
// Fall back to the lowest id only if the flag was somehow never set.
const mainAdminId = async () =>
  (await db.select({ id: adminsTable.id }).from(adminsTable).where(eq(adminsTable.isMain, true)).limit(1))[0]?.id
  ?? (await db.select({ id: adminsTable.id }).from(adminsTable).orderBy(adminsTable.id).limit(1))[0]?.id;

// Listing is visible to any owner; mutations below are head-admin-only.
async function roleExists(key: string): Promise<boolean> {
  const [r] = await db.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.key, key));
  return !!r;
}

router.get("/admins", requireRole("owner"), async (_req, res) => {
  const admins = await db.select({ id: adminsTable.id, name: adminsTable.name, username: adminsTable.username, telegramId: adminsTable.telegramId, role: adminsTable.role, isMain: adminsTable.isMain, inviteCode: adminsTable.inviteCode }).from(adminsTable).orderBy(adminsTable.id);
  ok(res, admins.map(a => ({
    id: a.id, name: a.name, username: a.username, role: a.role ?? "owner",
    isMain: !!a.isMain, hasWebLogin: !!a.username, hasTelegram: !!a.telegramId,
    pending: !a.telegramId, inviteLink: a.inviteCode && !a.telegramId ? adminInviteLink(a.inviteCode) : null,
  })));
});

// Create a new user (invite-only): name + role; returns invite link to share
router.post("/admins", requireMainAdmin, async (req, res) => {
  const { name, role } = req.body ?? {};
  if (!name?.trim()) return fail(res, 400, "Вкажіть ім'я");
  const r = (String(role) as Role);
  if (!(await roleExists(r))) return fail(res, 400, "Невірна роль");
  const code = await uniqueAdminCode();
  const [a] = await db.insert(adminsTable).values({ name: name.trim(), role: r, inviteCode: code }).returning();
  ok(res, { id: a!.id, name: a!.name, role: a!.role, inviteLink: adminInviteLink(code) });
});

// Edit name and/or role
router.patch("/admins/:id", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, role } = req.body ?? {};
  const mainId = await mainAdminId();
  const patch: any = {};
  if (name !== undefined) { if (!String(name).trim()) return fail(res, 400, "Ім'я не може бути порожнім"); patch.name = String(name).trim(); }
  if (role !== undefined) {
    const r = String(role) as Role;
    if (!(await roleExists(r))) return fail(res, 400, "Невірна роль");
    if (id === mainId && r !== "owner") return fail(res, 400, "Головний власник має лишатися власником");
    patch.role = r;
  }
  const [a] = await db.update(adminsTable).set(patch).where(eq(adminsTable.id, id)).returning();
  ok(res, a);
});

// Back-compat: role-only patch
router.patch("/admins/:id/role", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const role = String((req.body ?? {}).role) as Role;
  if (!(await roleExists(role))) return fail(res, 400, "Невірна роль");
  if (id === (await mainAdminId()) && role !== "owner") return fail(res, 400, "Головний власник має лишатися власником");
  const [a] = await db.update(adminsTable).set({ role }).where(eq(adminsTable.id, id)).returning();
  ok(res, a);
});

// (Re)generate an invite link — only while the user hasn't linked Telegram yet
router.post("/admins/:id/invite", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [a] = await db.select().from(adminsTable).where(eq(adminsTable.id, id));
  if (!a) return fail(res, 404, "Не знайдено");
  if (a.telegramId) return fail(res, 400, "Користувач вже приєднаний до Telegram");
  let code = a.inviteCode;
  if (!code) { code = await uniqueAdminCode(); await db.update(adminsTable).set({ inviteCode: code }).where(eq(adminsTable.id, id)); }
  ok(res, { inviteLink: adminInviteLink(code) });
});

// Reset web access (clears login + password so the user re-creates them in the bot)
router.post("/admins/:id/reset-web", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await db.update(adminsTable).set({ username: null, passwordHash: null }).where(eq(adminsTable.id, id));
  ok(res, { ok: true });
});

router.delete("/admins/:id", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === (await mainAdminId())) return fail(res, 400, "Не можна видалити головного власника");
  if (id === (req as AuthedRequest).admin?.adminId) return fail(res, 400, "Не можна видалити власний акаунт");
  await db.delete(adminsTable).where(eq(adminsTable.id, id));
  ok(res, { ok: true });
});

// ─── Roles (web access roles) — head admin only ───────────────────────────────
const slugify = (s: string) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const cleanKeys = (input: any, allowed: readonly string[]): string[] =>
  Array.isArray(input) ? [...new Set(input.map(String).filter(x => allowed.includes(x)))] : [];

router.get("/roles", requireMainAdmin, async (_req, res) => {
  const rows = await db.select().from(rolesTable).orderBy(rolesTable.sortOrder, rolesTable.id);
  const admins = await db.select({ role: adminsTable.role }).from(adminsTable);
  const inUse = new Map<string, number>();
  for (const a of admins) inUse.set(a.role ?? "", (inUse.get(a.role ?? "") ?? 0) + 1);
  ok(res, rows.map(r => ({
    id: r.id, key: r.key, label: r.label, isSystem: r.isSystem,
    pages: r.pages ?? [], caps: r.caps ?? [], inUse: inUse.get(r.key) ?? 0,
  })));
});

router.post("/roles", requireMainAdmin, async (req, res) => {
  const { label, key, pages, caps } = req.body ?? {};
  if (!label?.trim()) return fail(res, 400, "Вкажіть назву ролі");
  // key is internal (the label is what's shown); non-latin names slug to "" → auto-generate
  let k = slugify(key || label) || `role-${Date.now().toString(36).slice(-6)}`;
  if (await roleExists(k)) k = `${k}-${Date.now().toString(36).slice(-4)}`;
  const max = (await db.select({ s: rolesTable.sortOrder }).from(rolesTable)).reduce((a, r) => Math.max(a, r.s ?? 0), 0);
  const [r] = await db.insert(rolesTable).values({
    key: k, label: String(label).trim(), isSystem: false,
    pages: cleanKeys(pages, PAGE_KEYS), caps: cleanKeys(caps, CAP_KEYS), sortOrder: max + 1,
  }).returning();
  invalidateRolesCache();
  ok(res, r);
});

router.patch("/roles/:id", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id));
  if (!role) return fail(res, 404, "Роль не знайдено");
  if (role.key === OWNER) return fail(res, 400, "Роль «Власник» не можна змінювати");
  const { label, pages, caps } = req.body ?? {};
  const patch: any = {};
  if (label !== undefined) { if (!String(label).trim()) return fail(res, 400, "Назва не може бути порожньою"); patch.label = String(label).trim(); }
  if (pages !== undefined) patch.pages = cleanKeys(pages, PAGE_KEYS);
  if (caps !== undefined) patch.caps = cleanKeys(caps, CAP_KEYS);
  const [r] = await db.update(rolesTable).set(patch).where(eq(rolesTable.id, id)).returning();
  invalidateRolesCache();
  ok(res, r);
});

router.delete("/roles/:id", requireMainAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id));
  if (!role) return fail(res, 404, "Роль не знайдено");
  if (role.isSystem) return fail(res, 400, "Системну роль не можна видалити");
  const [used] = await db.select({ id: adminsTable.id }).from(adminsTable).where(eq(adminsTable.role, role.key)).limit(1);
  if (used) return fail(res, 400, "Роль використовується — спершу переназначте користувачів");
  await db.delete(rolesTable).where(eq(rolesTable.id, id));
  invalidateRolesCache();
  ok(res, { ok: true });
});

// ─── Live shifts (today) ──────────────────────────────────────────────────────
router.get("/live", async (_req, res) => {
  const weekStart = getCurrentMonday();
  const today = warsawDayName();
  const now = nowWarsaw();
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  const week = candidates.find(w => w.status === "approved") ?? candidates[0];
  const factories = await db.select().from(factoriesTable).orderBy(factoriesTable.name);
  const drivers = await db.select({ id: driversTable.id, name: driversTable.name }).from(driversTable).where(eq(driversTable.isActive, true)).orderBy(driversTable.name);
  // Name lookup for pickup attribution — include inactive drivers too
  const allDrivers = await db.select({ id: driversTable.id, name: driversTable.name }).from(driversTable);
  const driverName = (id: number | null) => id ? (allDrivers.find(d => d.id === id)?.name ?? null) : null;

  // Work in Warsaw "minutes since midnight" to keep timers tz-correct on any client
  const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const shiftsOut: any[] = [];
  if (week) {
    const entries = await db
      .select({ workerId: scheduleEntriesTable.workerId, name: workersTable.fullName, factoryId: scheduleEntriesTable.factoryId, shift: scheduleEntriesTable.shift, status: scheduleEntriesTable.status, pickedUpBy: scheduleEntriesTable.pickedUpBy })
      .from(scheduleEntriesTable)
      .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
      .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.dayOfWeek, today)));
    const trips = await db
      .select({ factoryId: driverTripsTable.factoryId, shift: driverTripsTable.shift, pickup: driverTripsTable.pickupStartedAt, arrived: driverTripsTable.arrivedFactoryAt })
      .from(driverTripsTable)
      .where(and(eq(driverTripsTable.weekId, week.id), eq(driverTripsTable.dayOfWeek, today)));
    const assigns = await db
      .select({ factoryId: driverShiftAssignmentsTable.factoryId, shift: driverShiftAssignmentsTable.shift, driverId: driverShiftAssignmentsTable.driverId, driverName: driversTable.name })
      .from(driverShiftAssignmentsTable)
      .leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
      .where(and(eq(driverShiftAssignmentsTable.weekId, week.id), eq(driverShiftAssignmentsTable.dayOfWeek, today), eq(driverShiftAssignmentsTable.kind, "delivery")));

    for (const f of factories) {
      const fShifts = factoryShifts(f);
      const fEntries = entries.filter(e => e.factoryId === f.id);
      if (!fEntries.length && !fShifts.length) continue;
      const n = Math.min(6, Math.max(1, f.shiftCount ?? fShifts.length ?? 1));
      for (let s = 1; s <= n; s++) {
        const sc = String(s) as Shift;
        const list = fEntries.filter(e => e.shift === sc);
        if (!list.length) continue;
        const st = fShifts[s - 1];
        const enRoute = trips.some(t => t.factoryId === f.id && t.shift === sc && t.pickup && !t.arrived);
        shiftsOut.push({
          factoryId: f.id, factory: f.name, shift: s,
          start: st?.start ?? null, end: st?.end ?? null,
          startMin: st ? toMin(st.start) : null, endMin: st ? toMin(st.end) : null,
          drivers: assigns.filter(a => a.factoryId === f.id && a.shift === sc).map(a => ({ id: a.driverId, name: a.driverName })),
          workers: list.map(e => ({
            workerId: e.workerId, name: e.name ?? "—",
            status: e.status, // present | absent | scheduled
            enRoute: e.status !== "present" && e.status !== "absent" && enRoute,
            pickedUpBy: driverName(e.pickedUpBy),
          })),
          present: list.filter(e => e.status === "present").length,
          absent: list.filter(e => e.status === "absent").length,
          total: list.length,
          enRoute,
        });
      }
    }
  }
  ok(res, { weekStart, day: today, nowMin, hasSchedule: !!week, shifts: shiftsOut, drivers });
});

// Bulk-save driver assignments for a week+factory. `slots`: { "day-shift": number[] }.
// Replaces the whole factory's week assignments in one go (supports several drivers per shift).
// Saving does NOT notify — notification is an explicit separate action.
router.put("/schedule/driver-assignments", requireCap("assignDrivers"), async (req, res) => {
  const { weekStart, factoryId, slots } = req.body ?? {};
  if (!weekStart || !factoryId || typeof slots !== "object") return fail(res, 400, "Невірні дані");
  const candidates = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  let week = candidates.find(w => w.status === "approved") ?? candidates[0];
  if (!week) { [week] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning(); } // allow assigning ahead
  // A pickup-unaware client (Schedule page) sends only "day-shift" keys — then
  // replace ONLY delivery rows and keep the pickups saved via DriverShifts.
  const hasPickupKeys = Object.keys(slots as object).some(k => k.split("-")[2] === "p");
  await db.delete(driverShiftAssignmentsTable).where(and(
    eq(driverShiftAssignmentsTable.weekId, week!.id), eq(driverShiftAssignmentsTable.factoryId, Number(factoryId)),
    ...(hasPickupKeys ? [] : [eq(driverShiftAssignmentsTable.kind, "delivery")]),
  ));
  const rows: any[] = [];
  for (const [key, ids] of Object.entries(slots as Record<string, number[]>)) {
    // "day-shift" = delivery, "day-shift-p" = pickup («Забрати зі зміни»)
    const [day, shift, p] = key.split("-");
    if (!day || !shift || !Array.isArray(ids)) continue;
    for (const id of [...new Set(ids.map(Number).filter(Boolean))]) {
      rows.push({ weekId: week!.id, factoryId: Number(factoryId), dayOfWeek: day as DayOfWeek, shift: shift as Shift, driverId: id, kind: p === "p" ? "pickup" : "delivery" });
    }
  }
  if (rows.length) await db.insert(driverShiftAssignmentsTable).values(rows);
  ok(res, { ok: true, count: rows.length });
});

// Notify each assigned driver of their shifts for this week+factory (explicit action)
router.post("/schedule/notify-drivers", requireCap("assignDrivers"), async (req, res) => {
  const { weekStart, factoryId } = req.body ?? {};
  if (!weekStart || !factoryId) return fail(res, 400, "Невірні дані");
  try {
    const { notifyDriversOfWeek } = await import("../bot/notify");
    const r = await notifyDriversOfWeek(String(weekStart), Number(factoryId));
    ok(res, r);
  } catch (e) {
    logger.error({ err: e }, "notify-drivers failed");
    fail(res, 500, "Помилка розсилки");
  }
});

// Send each scheduled worker their week schedule with the assigned driver per shift.
router.post("/schedule/notify-workers", requireCap("assignDrivers"), async (req, res) => {
  const { weekStart, factoryId } = req.body ?? {};
  if (!weekStart || !factoryId) return fail(res, 400, "Невірні дані");
  try {
    const { notifyWorkersScheduleWithDrivers } = await import("../bot/notify");
    const r = await notifyWorkersScheduleWithDrivers(String(weekStart), Number(factoryId));
    ok(res, r);
  } catch (e) {
    logger.error({ err: e }, "notify-workers failed");
    fail(res, 500, "Помилка розсилки");
  }
});

// ─── Driver board: all factories' shifts for a week + per-driver assignment ──────
const findWeekRow = async (weekStart: string) => {
  const c = await db.select().from(scheduleWeeksTable).where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
  return c.find(w => w.status === "approved") ?? c[0];
};

// Compact overview of every factory's running shifts (with hours + headcount + assigned drivers).
// Each cell also carries pickup («Забрати зі зміни») assignments and a `pickupGap`
// warning when nobody is set to take the shift's workers home (see gap rules below).
router.get("/driver-board", requireCap("assignDrivers"), async (req, res) => {
  const weekStart = String(req.query.weekStart);
  if (!weekStart) return fail(res, 400, "weekStart обовʼязковий");
  const week = await findWeekRow(weekStart);
  const factories = await db.select().from(factoriesTable).orderBy(factoriesTable.name);
  const drivers = await db.select({ id: driversTable.id, name: driversTable.name, seats: driversTable.seats, isHeadDriver: driversTable.isHeadDriver, telegramId: driversTable.telegramId })
    .from(driversTable).where(eq(driversTable.isActive, true)).orderBy(desc(driversTable.isHeadDriver), driversTable.name);
  const seatsOf = new Map(drivers.map(d => [d.id, d.seats]));

  let entries: { factoryId: number; day: string; shift: string }[] = [];
  let assigns: { factoryId: number; day: string; shift: string; driverId: number; driverName: string | null; kind: string }[] = [];
  if (week) {
    entries = await db.select({ factoryId: scheduleEntriesTable.factoryId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift })
      .from(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, week.id));
    assigns = await db.select({ factoryId: driverShiftAssignmentsTable.factoryId, day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, driverId: driverShiftAssignmentsTable.driverId, driverName: driversTable.name, kind: driverShiftAssignmentsTable.kind })
      .from(driverShiftAssignmentsTable).leftJoin(driversTable, eq(driverShiftAssignmentsTable.driverId, driversTable.id))
      .where(eq(driverShiftAssignmentsTable.weekId, week.id));
  }

  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h! * 60 + m!; };
  const out = factories.map(f => {
    const fShifts = factoryShifts(f);
    const n = Math.min(6, Math.max(1, f.shiftCount ?? fShifts.length ?? 1));
    const headcountOf = (day: string, sc: string) => entries.filter(e => e.factoryId === f.id && e.day === day && e.shift === sc).length;
    const cellAssigns = (day: string, sc: string, kind: string) =>
      assigns.filter(a => a.factoryId === f.id && a.day === day && a.shift === sc && a.kind === kind).map(a => ({ id: a.driverId, name: a.driverName }));

    // Who takes shift N's workers home if no explicit pickup is assigned?
    // The delivery drivers of the shift that STARTS when N ends (same day, or the
    // next day when N crosses midnight). Gap = no such drivers at all, or their
    // known seat total is smaller than the shift's headcount.
    const pickupGapFor = (day: string, idx: number): { reason: string; people: number; seats: number | null } | null => {
      const st = fShifts[idx];
      const people = headcountOf(day, String(idx + 1));
      if (!st || people === 0) return null;
      if (cellAssigns(day, String(idx + 1), "pickup").length > 0) return null; // explicitly covered
      const crossesMidnight = toMin(st.end) <= toMin(st.start);
      const coverDay = crossesMidnight ? DAYS[(DAYS.indexOf(day as any) + 1) % 7]! : day;
      const coverIdx = fShifts.findIndex(x => x.start === st.end);
      const covering = coverIdx >= 0 && headcountOf(coverDay, String(coverIdx + 1)) > 0
        ? cellAssigns(coverDay, String(coverIdx + 1), "delivery") : [];
      if (covering.length === 0) return { reason: "none", people, seats: null };
      const seatVals = covering.map(d => seatsOf.get(d.id));
      if (seatVals.some(s => s == null)) return null; // unknown capacity → don't guess
      const seats = seatVals.reduce<number>((a, b) => a + (b ?? 0), 0);
      return seats < people ? { reason: "capacity", people, seats } : null;
    };

    const cells: any[] = [];
    for (const day of DAYS) {
      for (let s = 1; s <= n; s++) {
        const sc = String(s);
        const headcount = headcountOf(day, sc);
        const cellDrivers = cellAssigns(day, sc, "delivery");
        const pickupDrivers = cellAssigns(day, sc, "pickup");
        if (headcount === 0 && cellDrivers.length === 0 && pickupDrivers.length === 0) continue; // only relevant shifts
        const st = fShifts[s - 1];
        cells.push({ day, shift: sc, start: st?.start ?? null, end: st?.end ?? null, headcount, drivers: cellDrivers, pickupDrivers, pickupGap: pickupGapFor(day, s - 1) });
      }
    }
    return { id: f.id, name: f.name, shiftCount: n, cells };
  }).filter(f => f.cells.length > 0);

  ok(res, { weekStart, hasWeek: !!week, factories: out, drivers });
});

// Save ONE driver's assignments across all factories for a week (full replace for that driver).
router.put("/schedule/driver-assignments/by-driver", requireCap("assignDrivers"), async (req, res) => {
  const { weekStart, driverId, slots } = req.body ?? {};
  if (!weekStart || !driverId || typeof slots !== "object") return fail(res, 400, "Невірні дані");
  let week = await findWeekRow(String(weekStart));
  if (!week) { [week] = await db.insert(scheduleWeeksTable).values({ weekStart: String(weekStart), status: "draft" }).returning(); }
  await db.delete(driverShiftAssignmentsTable).where(and(
    eq(driverShiftAssignmentsTable.weekId, week!.id), eq(driverShiftAssignmentsTable.driverId, Number(driverId)),
  ));
  const rows: any[] = [];
  for (const [factoryId, keys] of Object.entries(slots as Record<string, string[]>)) {
    if (!Array.isArray(keys)) continue;
    for (const key of [...new Set(keys)]) {
      // "day-shift" = delivery, "day-shift-p" = pickup («Забрати зі зміни»)
      const [day, shift, p] = String(key).split("-");
      if (!day || !shift) continue;
      rows.push({ weekId: week!.id, factoryId: Number(factoryId), dayOfWeek: day as DayOfWeek, shift: shift as Shift, driverId: Number(driverId), kind: p === "p" ? "pickup" : "delivery" });
    }
  }
  if (rows.length) await db.insert(driverShiftAssignmentsTable).values(rows);
  ok(res, { ok: true, count: rows.length });
});

// Notify ONE driver of their week (explicit action)
router.post("/schedule/notify-driver", requireCap("assignDrivers"), async (req, res) => {
  const { weekStart, driverId } = req.body ?? {};
  if (!weekStart || !driverId) return fail(res, 400, "Невірні дані");
  try {
    const { notifyDriverOfWeek } = await import("../bot/notify");
    const r = await notifyDriverOfWeek(String(weekStart), Number(driverId));
    ok(res, r);
  } catch (e) {
    logger.error({ err: e }, "notify-driver failed");
    fail(res, 500, "Помилка розсилки");
  }
});

// Copy all driver assignments from one week to another (full replace of target week)
router.post("/schedule/driver-assignments/copy-week", requireCap("assignDrivers"), async (req, res) => {
  const { fromWeekStart, toWeekStart } = req.body ?? {};
  if (!fromWeekStart || !toWeekStart) return fail(res, 400, "Невірні дані");
  const from = await findWeekRow(String(fromWeekStart));
  if (!from) return fail(res, 400, "У попередньому тижні немає графіку");
  const src = await db.select().from(driverShiftAssignmentsTable).where(eq(driverShiftAssignmentsTable.weekId, from.id));
  if (!src.length) return fail(res, 400, "У попередньому тижні немає призначень водіїв");
  let to = await findWeekRow(String(toWeekStart));
  if (!to) { [to] = await db.insert(scheduleWeeksTable).values({ weekStart: String(toWeekStart), status: "draft" }).returning(); }
  await db.delete(driverShiftAssignmentsTable).where(eq(driverShiftAssignmentsTable.weekId, to!.id));
  await db.insert(driverShiftAssignmentsTable).values(src.map(r => ({
    weekId: to!.id, factoryId: r.factoryId, dayOfWeek: r.dayOfWeek, shift: r.shift, driverId: r.driverId, kind: r.kind,
  })));
  ok(res, { ok: true, count: src.length });
});

// ─── Notifications (on-site bell) ─────────────────────────────────────────────
router.get("/notifications", async (req: AuthedRequest, res) => {
  const role = req.admin!.role;
  const myId = req.admin!.adminId;
  const rows = await db.select().from(notificationsTable).orderBy(desc(notificationsTable.id)).limit(50);
  const seesAll = role === "owner";
  const mine = rows.filter(n => seesAll || n.audience === "both" || n.audience === role);
  ok(res, mine.map(n => ({
    id: n.id, type: n.type, title: n.title, body: n.body, createdAt: n.createdAt,
    read: (n.readBy ?? []).includes(myId),
  })));
});

router.post("/notifications/read", async (req: AuthedRequest, res) => {
  const myId = req.admin!.adminId;
  const role = req.admin!.role;
  const { id } = req.body ?? {};
  const rows = await db.select().from(notificationsTable);
  for (const n of rows) {
    if (role !== "owner" && n.audience !== "both" && n.audience !== role) continue;
    if (id && n.id !== Number(id)) continue;
    const readBy = n.readBy ?? [];
    if (!readBy.includes(myId)) {
      await db.update(notificationsTable).set({ readBy: [...readBy, myId] }).where(eq(notificationsTable.id, n.id));
    }
  }
  ok(res, { ok: true });
});

export default router;
