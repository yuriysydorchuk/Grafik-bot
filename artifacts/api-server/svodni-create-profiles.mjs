// Разово: профілі для всіх непривʼязаних людей сводної місяця (Познань/Лодзь/
// решта Любліна). Дані — зі сводної: ставки, студент, до-26, дата народження,
// форма легалізації, год. повідомлення, фабрика/фірма. Після створення —
// rematchSvodni() привʼязує їхні рядки в усіх місяцях.
import { db, pool, workersTable, factoriesTable, svodniRowsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { cleanName, key } from "./src/services/payrollSummaries.ts";
import { legalStatusOf } from "./src/services/svodni.ts";
import { parseSheetDate, isUnder26, rematchSvodni } from "./src/services/svodniSync.ts";

const MONTH = process.argv[2] ?? "2026-05";
const rows = await db.select().from(svodniRowsTable).where(and(
  eq(svodniRowsTable.periodMonth, MONTH),
  eq(svodniRowsTable.linkStatus, "unmatched"),
  isNull(svodniRowsTable.workerId),
));

// одна людина = один профіль: групуємо по нормалізованому імені,
// беремо рядок з найповнішими даними (є ставка → більше годин)
const byName = new Map();
for (const r of rows) {
  const k = key(cleanName(r.rawName));
  if (!k) continue;
  const cur = byName.get(k);
  const better = !cur
    || (r.rateBrutto != null && cur.rateBrutto == null)
    || (r.rateBrutto != null === (cur.rateBrutto != null) && (r.hours ?? 0) > (cur.hours ?? 0));
  if (better) byName.set(k, r);
}

// Імена в системі — Title Case латиницею (польська локаль)
const titleCase = (s) => cleanName(s).toLocaleLowerCase("pl")
  .replace(/(^|[\s\-'])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase("pl"))
  .replace(/\s+/g, " ").trim();

const factories = await db.select().from(factoriesTable);
const facById = new Map(factories.map(f => [f.id, f]));
const [codeRow] = await db.select({ max: sql`coalesce(max(worker_code::int), 0)` })
  .from(workersTable).where(sql`worker_code ~ '^[0-9]+$'`);
let nextCode = Number(codeRow.max) + 1;

let created = 0;
for (const [, r] of byName) {
  const fac = r.factoryId != null ? facById.get(r.factoryId) : null;
  const bd = parseSheetDate(r.hr?.dataUrodzenia);
  const under26 = bd ? isUnder26(bd) : r.under26 ?? false;
  const ls = legalStatusOf(r.extras?.zusStatus);
  await db.insert(workersTable).values({
    fullName: titleCase(r.rawName),
    workerCode: String(nextCode++).padStart(5, "0"),
    factoryId: r.factoryId ?? null,
    companyId: fac?.companyId ?? null,
    hourlyRate: r.rateBrutto ?? undefined,
    hourlyRateNetto: r.rateNetto ?? null,
    isStudent: r.isStudent ?? (ls === "student"),
    under26,
    birthDate: bd,
    legalStatus: ls,
    notifyHours: r.hoursNotified ?? null,
  });
  created++;
}
console.log(`${MONTH}: створено профілів ${created} (з ${rows.length} непривʼязаних рядків)`);

const rematch = await rematchSvodni();
console.log(`rematch: привʼязано рядків ${rematch.linked}`);
await pool.end();
