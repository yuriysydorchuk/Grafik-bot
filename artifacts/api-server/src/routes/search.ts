// Загальний пошук по панелі (Ctrl+K / поле в шапці, рішення власника 21.09.2026):
// одним запитом — працівники, кандидати, водії, фабрики, хостели, відкриті задачі.
// Групи віддаються лише для сторінок, до яких у ролі є доступ (roles.pages, owner — усі),
// щоб пошук не став обходом гейтів. Лише читання, ліміт 8 на групу, ILIKE по імені/коду/PESEL.
import { Router, type IRouter } from "express";
import { and, eq, ilike, inArray, or, sql, type AnyColumn } from "drizzle-orm";
import { db, workersTable, factoriesTable, driversTable, candidatesTable, hostelsTable, tasksTable } from "@workspace/db";
import { authRequired, type AuthedRequest } from "../lib/auth";
import { OPEN_STATUSES } from "../services/taskUtils";
import { workerInScopeSql, factoryInScopeSql, scopeTaskSql } from "../lib/scope";

const router: IRouter = Router();
const OWNER = "owner";
const LIMIT = 8;

export interface SearchHit { kind: "worker" | "candidate" | "driver" | "factory" | "hostel" | "task"; id: number; title: string; subtitle: string | null; href: string; inactive?: boolean }

router.get("/search", authRequired, async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  if (q.length < 2) { res.json({ q, hits: [] as SearchHit[] }); return; }
  const can = (page: string) => req.admin!.role === OWNER || req.admin!.pages.includes(page);
  // скоуп міст/фабрик (офіс-менеджер): кожна група звужується до своїх фабрик; водії/хостели скоупу не мають — ховаємо
  const scope = req.admin!.scope;
  const esc = (w: string) => `%${w.replace(/[%_\\]/g, ch => `\\${ch}`)}%`;
  const like = esc(q);
  // імʼя — по словах у будь-якому порядку («Sithole Tanatswa» має знайти «TANATSWA SITHOLE»): кожне слово ILIKE
  const words = q.split(/\s+/).filter(Boolean);
  const nameLike = (col: AnyColumn) => words.length > 1 ? and(...words.map(w => ilike(col, esc(w))))! : ilike(col, like);
  const digits = q.replace(/\D/g, "");
  const hits: SearchHit[] = [];

  if (can("/workers")) {
    const ws = await db.select({ id: workersTable.id, fullName: workersTable.fullName, code: workersTable.workerCode, isActive: workersTable.isActive, factory: factoriesTable.name })
      .from(workersTable).leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
      .where(and(
        or(nameLike(workersTable.fullName), ilike(workersTable.workerCode, like), ...(digits.length >= 4 ? [ilike(workersTable.pesel, `%${digits}%`), ilike(workersTable.telegramId, `%${digits}%`)] : [])),
        scope ? workerInScopeSql(scope) : undefined))
      .orderBy(sql`${workersTable.isActive} desc`, workersTable.fullName).limit(LIMIT);
    for (const w of ws) hits.push({ kind: "worker", id: w.id, title: w.fullName, subtitle: [w.code, w.factory].filter(Boolean).join(" · ") || null, href: `/workers/${w.id}`, inactive: !w.isActive });
  }
  if (can("/recruitment")) {
    const cs = await db.select({ id: candidatesTable.id, fullName: candidatesTable.fullName, phone: candidatesTable.phone, stage: candidatesTable.stage, workerId: candidatesTable.workerId })
      .from(candidatesTable).where(and(
        or(nameLike(candidatesTable.fullName), ...(digits.length >= 4 ? [ilike(candidatesTable.phone, `%${digits}%`)] : [])),
        scope ? factoryInScopeSql(scope, candidatesTable.factoryId) : undefined)).limit(LIMIT);
    // переведений у працівники кандидат веде одразу в профіль (якщо роль бачить /workers), не в CRM;
    // якщо той самий профіль уже знайдено як працівника — другий рядок на те саме місце не показуємо
    for (const c of cs) {
      const toProfile = !!c.workerId && can("/workers");
      if (toProfile && hits.some(h => h.kind === "worker" && h.id === c.workerId)) continue;
      hits.push({ kind: "candidate", id: c.id, title: c.fullName, subtitle: [c.stage, c.phone].filter(Boolean).join(" · ") || null, href: toProfile ? `/workers/${c.workerId}` : `/recruitment` });
    }
  }
  if (can("/drivers") && !scope) {
    const ds = await db.select({ id: driversTable.id, name: driversTable.name, phone: driversTable.phone, isActive: driversTable.isActive })
      .from(driversTable).where(or(nameLike(driversTable.name), ...(digits.length >= 4 ? [ilike(driversTable.phone, `%${digits}%`)] : []))).limit(LIMIT);
    for (const d of ds) hits.push({ kind: "driver", id: d.id, title: d.name, subtitle: d.phone ?? null, href: `/drivers`, inactive: !d.isActive });
  }
  if (can("/factories")) {
    const fs = await db.select({ id: factoriesTable.id, name: factoriesTable.name, city: factoriesTable.city }).from(factoriesTable)
      .where(and(or(ilike(factoriesTable.name, like), ilike(factoriesTable.city, like)), scope ? factoryInScopeSql(scope, factoriesTable.id) : undefined)).limit(LIMIT);
    for (const f of fs) hits.push({ kind: "factory", id: f.id, title: f.name, subtitle: f.city ?? null, href: `/factories` });
  }
  if (can("/hostels") && !scope) {
    const hs = await db.select({ id: hostelsTable.id, name: hostelsTable.name, city: hostelsTable.city, address: hostelsTable.address }).from(hostelsTable)
      .where(or(ilike(hostelsTable.name, like), ilike(hostelsTable.address, like), ilike(hostelsTable.city, like))).limit(LIMIT);
    for (const h of hs) hits.push({ kind: "hostel", id: h.id, title: h.name, subtitle: [h.city, h.address].filter(Boolean).join(", ") || null, href: `/hostels` });
  }
  if (can("/tasks")) {
    // задачі — по заголовку АБО по імені привʼязаного працівника; у підзаголовку людина й строк
    const ts = await db.select({ id: tasksTable.id, title: tasksTable.title, dueAt: tasksTable.dueAt, worker: workersTable.fullName })
      .from(tasksTable).leftJoin(workersTable, eq(tasksTable.workerId, workersTable.id))
      .where(and(or(ilike(tasksTable.title, like), nameLike(workersTable.fullName)), inArray(tasksTable.status, OPEN_STATUSES),
        scope ? scopeTaskSql(scope, req.admin!.adminId) : undefined)).orderBy(tasksTable.dueAt).limit(LIMIT);
    for (const t of ts) hits.push({ kind: "task", id: t.id, title: t.title, subtitle: [t.worker, t.dueAt ? `до ${String(t.dueAt).slice(0, 10)}` : null].filter(Boolean).join(" · ") || null, href: `/tasks?task=${t.id}` });
  }
  res.json({ q, hits });
});

export default router;
