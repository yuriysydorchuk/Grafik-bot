// Разово: фактичні години зі сводних місяця → облік годин (monthly_reports).
// Пише по парі (працівник, фабрика); наявні рапорти НЕ перезаписує.
import { db, pool, monthlyReportsTable, workersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const MONTH = process.argv[2] ?? "2026-05";
const rows = await db.execute(sql`
  SELECT worker_id, factory_id, round(sum(hours)::numeric, 2) AS hours
  FROM svodni_rows
  WHERE period_month = ${MONTH} AND worker_id IS NOT NULL AND hours IS NOT NULL AND hours > 0
    AND factory_label NOT ILIKE 'OFFICE%' AND factory_label NOT ILIKE 'ОФИС%' AND factory_label <> 'Додаткові студенти'
  GROUP BY worker_id, factory_id`);

let inserted = 0, skipped = 0, noFactory = 0;
for (const r of rows.rows) {
  let factoryId = r.factory_id;
  if (factoryId == null) {
    // фабрика сводної не в довіднику — рапорт чіпляємо до поточної фабрики профілю
    const [w] = await db.select({ f: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, r.worker_id));
    factoryId = w?.f ?? null;
    noFactory++;
  }
  const cond = factoryId != null
    ? and(eq(monthlyReportsTable.workerId, r.worker_id), eq(monthlyReportsTable.month, MONTH), eq(monthlyReportsTable.factoryId, factoryId))
    : and(eq(monthlyReportsTable.workerId, r.worker_id), eq(monthlyReportsTable.month, MONTH), sql`${monthlyReportsTable.factoryId} IS NULL`);
  const [existing] = await db.select({ id: monthlyReportsTable.id }).from(monthlyReportsTable).where(cond);
  if (existing) { skipped++; continue; }
  await db.insert(monthlyReportsTable).values({
    workerId: r.worker_id, month: MONTH, factoryId, hoursReported: Number(r.hours), photoLink: null,
  });
  inserted++;
}
console.log(`${MONTH}: вставлено ${inserted}, пропущено (вже були) ${skipped}, без фабрики-довідника ${noFactory}`);

// скільки рапортів не видно в /hours (фабрика рапорту ≠ поточна фабрика профілю і явок немає)
const orphan = await db.execute(sql`
  SELECT count(*) AS n FROM monthly_reports mr
  JOIN workers w ON w.id = mr.worker_id
  WHERE mr.month = ${MONTH} AND mr.factory_id IS NOT NULL
    AND mr.factory_id IS DISTINCT FROM w.factory_id`);
console.log(`рапортів по НЕ-поточній фабриці працівника: ${orphan.rows[0].n} (видимі в /hours лише за наявності явок цієї пари)`);
await pool.end();
