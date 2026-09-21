// Загальний пошук по панелі (Ctrl+K / поле в шапці, рішення власника 21.09.2026):
// одним запитом — працівники, кандидати, водії, фабрики, хостели, відкриті задачі.
// Групи віддаються лише для сторінок, до яких у ролі є доступ (roles.pages, owner — усі),
// щоб пошук не став обходом гейтів. Лише читання, ліміт 8 на групу, ILIKE по імені/коду/PESEL.
import { Router, type IRouter } from "express";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, workersTable, factoriesTable, driversTable, candidatesTable, hostelsTable, tasksTable } from "@workspace/db";
import { authRequired, type AuthedRequest } from "../lib/auth";
import { OPEN_STATUSES } from "../services/taskUtils";

const router: IRouter = Router();
const OWNER = "owner";
const LIMIT = 8;

export interface SearchHit { kind: "worker" | "candidate" | "driver" | "factory" | "hostel" | "task"; id: number; title: string; subtitle: string | null; href: string; inactive?: boolean }

router.get("/search", authRequired, async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  if (q.length < 2) { res.json({ q, hits: [] as SearchHit[] }); return; }
  const can = (page: string) => req.admin!.role === OWNER || req.admin!.pages.includes(page);
  const like = `%${q.replace(/[%_\\]/g, ch => `\\${ch}`)}%`;
  const digits = q.replace(/\D/g, "");
  const hits: SearchHit[] = [];

  if (can("/workers")) {
    const ws = await db.select({ id: workersTable.id, fullName: workersTable.fullName, code: workersTable.workerCode, isActive: workersTable.isActive, factory: factoriesTable.name })
      .from(workersTable).leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
      .where(or(ilike(workersTable.fullName, like), ilike(workersTable.workerCode, like), ...(digits.length >= 4 ? [ilike(workersTable.pesel, `%${digits}%`), ilike(workersTable.telegramId, `%${digits}%`)] : [])))
      .orderBy(sql`${workersTable.isActive} desc`, workersTable.fullName).limit(LIMIT);
    for (const w of ws) hits.push({ kind: "worker", id: w.id, title: w.fullName, subtitle: [w.code, w.factory].filter(Boolean).join(" · ") || null, href: `/workers/${w.id}`, inactive: !w.isActive });
  }
  if (can("/recruitment")) {
    const cs = await db.select({ id: candidatesTable.id, fullName: candidatesTable.fullName, phone: candidatesTable.phone, stage: candidatesTable.stage })
      .from(candidatesTable).where(or(ilike(candidatesTable.fullName, like), ...(digits.length >= 4 ? [ilike(candidatesTable.phone, `%${digits}%`)] : []))).limit(LIMIT);
    for (const c of cs) hits.push({ kind: "candidate", id: c.id, title: c.fullName, subtitle: [c.stage, c.phone].filter(Boolean).join(" · ") || null, href: `/recruitment` });
  }
  if (can("/drivers")) {
    const ds = await db.select({ id: driversTable.id, name: driversTable.name, phone: driversTable.phone, isActive: driversTable.isActive })
      .from(driversTable).where(or(ilike(driversTable.name, like), ...(digits.length >= 4 ? [ilike(driversTable.phone, `%${digits}%`)] : []))).limit(LIMIT);
    for (const d of ds) hits.push({ kind: "driver", id: d.id, title: d.name, subtitle: d.phone ?? null, href: `/drivers`, inactive: !d.isActive });
  }
  if (can("/factories")) {
    const fs = await db.select({ id: factoriesTable.id, name: factoriesTable.name, city: factoriesTable.city }).from(factoriesTable)
      .where(or(ilike(factoriesTable.name, like), ilike(factoriesTable.city, like))).limit(LIMIT);
    for (const f of fs) hits.push({ kind: "factory", id: f.id, title: f.name, subtitle: f.city ?? null, href: `/factories` });
  }
  if (can("/hostels")) {
    const hs = await db.select({ id: hostelsTable.id, name: hostelsTable.name, city: hostelsTable.city, address: hostelsTable.address }).from(hostelsTable)
      .where(or(ilike(hostelsTable.name, like), ilike(hostelsTable.address, like), ilike(hostelsTable.city, like))).limit(LIMIT);
    for (const h of hs) hits.push({ kind: "hostel", id: h.id, title: h.name, subtitle: [h.city, h.address].filter(Boolean).join(", ") || null, href: `/hostels` });
  }
  if (can("/tasks")) {
    // задачі — по заголовку АБО по імені привʼязаного працівника; у підзаголовку людина й строк
    const ts = await db.select({ id: tasksTable.id, title: tasksTable.title, dueAt: tasksTable.dueAt, worker: workersTable.fullName })
      .from(tasksTable).leftJoin(workersTable, eq(tasksTable.workerId, workersTable.id))
      .where(and(or(ilike(tasksTable.title, like), ilike(workersTable.fullName, like)), inArray(tasksTable.status, OPEN_STATUSES))).orderBy(tasksTable.dueAt).limit(LIMIT);
    for (const t of ts) hits.push({ kind: "task", id: t.id, title: t.title, subtitle: [t.worker, t.dueAt ? `до ${String(t.dueAt).slice(0, 10)}` : null].filter(Boolean).join(" · ") || null, href: `/tasks?task=${t.id}` });
  }
  res.json({ q, hits });
});

export default router;
