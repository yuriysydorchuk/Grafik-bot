// Тижневий облік годин (26.10.2026, factories.weekly_hours) — вкладки тижнів в Обліку годин:
// рядки тижня (записи/відмітки/рапорт/години фабрики), нагадування працівникам, години
// фабрики за тиждень (клітинка / імпорт), «все ок» по тижню, правка відміток офісом.
// Гейт — editData (як решта /hours); скоуп-адмін — SCOPE_RULES (фабрика в query/тілі,
// лог — по фабриці рядка). Місячні таблиці перераховує services/weeklyHours.ts.
import { Router, type IRouter } from "express";
import { db, factoriesTable, factoryWeekHoursTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import {
  buildWeekRows, sendWeeklyRequests, upsertFactoryWeekHours, deleteFactoryWeekHours, syncWeek,
} from "../services/weeklyHours";
import { officeSetLog, getLog } from "../services/shiftLogs";
import { weeksOverlappingMonth, weekLabel, weekDates, round2, dayValueTotal } from "../lib/weekMath";

const router: IRouter = Router();
router.use("/hours/weeks", authRequired, requireCap("editData"));
router.use("/hours/shift-logs", authRequired, requireCap("editData"));

const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });
const isWeek = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00").getDay() === 1;

// Тижні місяця фабрики з рядками: усі тижні, що мають хоч один день місяця (тиждень цілий Пн–Нд).
router.get("/hours/weeks", async (req, res) => {
  const factoryId = Number(req.query.factoryId);
  const month = String(req.query.month || "");
  if (!factoryId || !/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, "factoryId та month=YYYY-MM обовʼязкові");
  const [fac] = await db.select({ id: factoriesTable.id, name: factoriesTable.name, shiftCount: factoriesTable.shiftCount, weeklyHours: factoriesTable.weeklyHours })
    .from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!fac) return fail(res, 404, "Фабрику не знайдено");
  const weeks = [];
  for (const weekStart of weeksOverlappingMonth(month)) {
    const { rows, weekApproved } = await buildWeekRows(factoryId, weekStart);
    weeks.push({
      weekStart, label: weekLabel(weekStart), dates: weekDates(weekStart), weekApproved, rows,
      requested: rows.filter(r => r.report?.requestSentAt || r.report?.remindSentAt).length,
      submitted: rows.filter(r => r.report?.submittedAt).length,
    });
  }
  res.json({ factory: fac, month, weeks });
});

// Нагадати тим, хто не подав (або вибраним) — той самий текст, що понеділковий запит, з позначкою.
router.post("/hours/weeks/remind", async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const weekStart = req.body?.weekStart;
  if (!factoryId || !isWeek(weekStart)) return fail(res, 400, "factoryId та weekStart (понеділок) обовʼязкові");
  const workerIds = Array.isArray(req.body?.workerIds) ? req.body.workerIds.map(Number).filter((n: number) => n > 0) : undefined;
  const r = await sendWeeklyRequests({ weekStart, factoryId, remind: true, workerIds });
  res.json(r);
});

// Клітинка годин фабрики за тиждень: число, або повна розбивка по датах тижня, або null = прибрати.
router.post("/hours/weeks/factory", async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const workerId = Number(req.body?.workerId);
  const weekStart = req.body?.weekStart;
  if (!factoryId || !workerId || !isWeek(weekStart)) return fail(res, 400, "factoryId, workerId та weekStart обовʼязкові");
  const dates = new Set(weekDates(weekStart));
  if (req.body?.days && typeof req.body.days === "object") {
    const days: Record<string, number | Record<string, number>> = {};
    for (const [d, v] of Object.entries(req.body.days as Record<string, unknown>)) {
      if (!dates.has(d)) continue;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 24) { if (v > 0) days[d] = round2(v); continue; }
      if (v && typeof v === "object") {
        const m: Record<string, number> = {};
        for (const [s, h] of Object.entries(v as Record<string, unknown>)) if (/^[1-6]$/.test(s) && typeof h === "number" && Number.isFinite(h) && h > 0 && h <= 24) m[s] = round2(h);
        if (Object.keys(m).length) days[d] = m;
      }
    }
    const total = round2(Object.values(days).reduce<number>((s, v) => s + dayValueTotal(v), 0));
    if (!Object.keys(days).length) await deleteFactoryWeekHours(workerId, factoryId, weekStart);
    else await upsertFactoryWeekHours(workerId, factoryId, weekStart, total, "manual", days);
    return res.json({ ok: true, hours: total });
  }
  if (req.body?.hours == null || req.body.hours === "") {
    await deleteFactoryWeekHours(workerId, factoryId, weekStart);
    return res.json({ ok: true, hours: null });
  }
  const hours = Number(String(req.body.hours).replace(",", "."));
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) return fail(res, 400, "Години 0–168");
  await upsertFactoryWeekHours(workerId, factoryId, weekStart, round2(hours), "manual", null);
  res.json({ ok: true, hours: round2(hours) });
});

// «Все ок» по тижню (розбіжність перевірена вручну) — скидається при зміні годин.
router.post("/hours/weeks/confirm", async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const workerId = Number(req.body?.workerId);
  const weekStart = req.body?.weekStart;
  if (!factoryId || !workerId || !isWeek(weekStart)) return fail(res, 400, "factoryId, workerId та weekStart обовʼязкові");
  const [r] = await db.update(factoryWeekHoursTable).set({ confirmed: !!req.body?.confirmed, updatedAt: new Date() })
    .where(and(eq(factoryWeekHoursTable.factoryId, factoryId), eq(factoryWeekHoursTable.workerId, workerId), eq(factoryWeekHoursTable.weekStart, weekStart)))
    .returning({ id: factoryWeekHoursTable.id });
  if (!r) return fail(res, 404, "Годин фабрики за цей тиждень нема");
  await syncWeek(workerId, factoryId, weekStart);
  res.json({ ok: true });
});

// Імпорт тижня (після превʼю /hours/factory-parse з weekStart): рядки {workerId, hours, days?} —
// days по датах тижня; кілька рядків на людину зливаються (сума), як у місячному імпорті.
router.post("/hours/weeks/factory-apply", async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const weekStart = req.body?.weekStart;
  const source = ["excel", "paste"].includes(req.body?.source) ? String(req.body.source) : "excel";
  const rows: { workerId?: unknown; hours?: unknown; days?: unknown; name?: unknown }[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!factoryId || !isWeek(weekStart)) return fail(res, 400, "factoryId та weekStart обовʼязкові");
  if (!rows.length) return fail(res, 400, "Порожній список рядків");
  const dates = new Set(weekDates(weekStart));
  const skippedRows: { name: string; hours: number | null }[] = [];
  const byWorker = new Map<number, { hours: number; days: Record<string, number | Record<string, number>> | null; rows: number; names: string[] }>();
  for (const r of rows) {
    const workerId = Number(r.workerId);
    const hours = Number(r.hours);
    if (!workerId || !Number.isFinite(hours) || hours < 0 || hours > 168) { skippedRows.push({ name: String(r.name ?? "").trim(), hours: Number.isFinite(hours) ? hours : null }); continue; }
    let days: Record<string, number | Record<string, number>> | null = null;
    if (r.days && typeof r.days === "object") {
      days = {};
      for (const [d, v] of Object.entries(r.days as Record<string, unknown>)) {
        if (!dates.has(d)) continue;
        if (typeof v === "number" && Number.isFinite(v) && v > 0) days[d] = round2(v);
        else if (v && typeof v === "object") {
          const m: Record<string, number> = {};
          for (const [s, h] of Object.entries(v as Record<string, unknown>)) if (typeof h === "number" && Number.isFinite(h) && h > 0) m[s] = round2(h);
          if (Object.keys(m).length) days[d] = m;
        }
      }
      if (!Object.keys(days).length) days = null;
    }
    const acc = byWorker.get(workerId);
    if (!acc) { byWorker.set(workerId, { hours, days, rows: 1, names: [String(r.name ?? "")] }); continue; }
    acc.rows++; acc.hours += hours; acc.names.push(String(r.name ?? ""));
    if (days) {
      acc.days ??= {};
      for (const [d, v] of Object.entries(days)) {
        const cur = acc.days[d];
        acc.days[d] = cur == null ? v : round2(dayValueTotal(cur) + dayValueTotal(v));
      }
    }
  }
  let saved = 0;
  for (const [workerId, a] of byWorker) {
    await upsertFactoryWeekHours(workerId, factoryId, weekStart, round2(a.hours), source, a.days);
    saved++;
  }
  const merged = [...byWorker.entries()].filter(([, a]) => a.rows > 1).map(([workerId, a]) => ({ workerId, rows: a.rows, hours: round2(a.hours), names: a.names }));
  res.json({ saved, skipped: skippedRows.length, skippedRows, merged });
});

// Правка відмітки офісом: час старту/кінця (настінний «YYYY-MM-DD HH:MM») або години напряму;
// результат пишеться у запис графіку (present + hours_override).
router.patch("/hours/shift-logs/:id", async (req, res) => {
  const id = Number(req.params.id);
  const log = await getLog(id);
  if (!log) return fail(res, 404, "Відмітку не знайдено");
  const wall = (v: unknown): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const s = String(v).replace("T", " ");
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s : undefined;
  };
  const startedAt = wall(req.body?.startedAt), endedAt = wall(req.body?.endedAt);
  if ((req.body?.startedAt !== undefined && startedAt === undefined) || (req.body?.endedAt !== undefined && endedAt === undefined)) return fail(res, 400, "Час у форматі YYYY-MM-DD HH:MM");
  const hours = req.body?.hours == null ? undefined : Number(req.body.hours);
  if (hours !== undefined && (!Number.isFinite(hours) || hours < 0 || hours > 24)) return fail(res, 400, "Години 0–24");
  const upd = await officeSetLog(id, { startedAt, endedAt, hours: hours ?? null });
  res.json({ ok: true, log: upd });
});

export default router;
