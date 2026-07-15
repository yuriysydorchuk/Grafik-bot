// Разово: аванси (zaliczka/zaliczka BD) і хостели з оригінальної травневої
// google-сводної → системні таблиці (advance_requests зі статусом paid,
// hostel_deductions). Ідемпотентно: попередній імпорт цього скрипта зноситься.
import { readFileSync } from "node:fs";
import { db, pool, workersTable, factoriesTable, advanceRequestsTable, hostelDeductionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab } from "./src/services/svodni.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { key, cleanName } from "./src/services/payrollSummaries.ts";

const MONTH = "2026-05";
const TAG = `зі сводної ${MONTH}`;
const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const G = (n) => new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"))));
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;

const workers = dedupeWorkers(await db.select().from(workersTable));
const factories = await db.select().from(factoriesTable);
const facId = (label) => {
  const k = key(label) === "DEZYNFEKCJA" ? "SERWISPLUS" : key(label);
  const f = factories.find(x => key(x.name) === k) ?? factories.find(x => key(x.name).startsWith(k) || k.startsWith(key(x.name)));
  return f?.id ?? null;
};

// прибрати попередній прогін
await db.execute(sql`DELETE FROM hostel_deductions WHERE period_month = ${MONTH} AND note = ${TAG}`);
await db.execute(sql`DELETE FROM advance_requests WHERE comment LIKE ${"%" + TAG + "%"}`);

const JOBS = [
  { name: "lublin-2026-05", city: "Люблін" },
  { name: "poznan-2026-05", city: "Познань" },
  { name: "lodz-es-2026-05", city: "Лодзь" },
  { name: "lodz-eso-2026-05", city: "Лодзь" },
  { name: "lodz-klinex-2026-05", city: "Лодзь" },
];
let adv = 0, advBd = 0, hostel = 0, unmatched = [];
const paidAt = new Date("2026-05-31T12:00:00");
for (const j of JOBS) {
  for (const [t, rows] of G(j.name)) {
    if (SKIP.test(t.trim())) continue;
    const parsed = j.city === "Лодзь" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!parsed) continue;
    for (const r of parsed.rows) {
      if (!(r.zaliczka > 0) && !(r.zaliczkaBd > 0) && !(r.hostel > 0)) continue;
      const w = matchSvodniName(cleanName(r.rawName), workers);
      if (!w) { unmatched.push(`${r.rawName} (${t})`); continue; }
      if (r.zaliczka > 0) {
        await db.insert(advanceRequestsTable).values({
          workerId: w.id, amount: r2(r.zaliczka), status: "paid", paidAt,
          comment: `Zaliczka ${TAG} (${t})`,
        });
        adv++;
      }
      if (r.zaliczkaBd > 0) {
        await db.insert(advanceRequestsTable).values({
          workerId: w.id, amount: r2(r.zaliczkaBd), status: "paid", paidAt,
          comment: `Zaliczka BD ${TAG} (${t})`,
        });
        advBd++;
      }
      if (r.hostel > 0) {
        await db.insert(hostelDeductionsTable).values({
          periodMonth: MONTH, workerId: w.id, city: j.city,
          factoryId: facId(t), factoryLabel: t, amount: r2(r.hostel), note: TAG,
        });
        hostel++;
      }
    }
  }
}
console.log(`аванси: ${adv} zaliczka + ${advBd} zaliczka BD; хостели: ${hostel}; не зматчено: ${unmatched.length}`);
for (const u of unmatched) console.log("  ?", u);
const tot = await db.execute(sql`
  SELECT (SELECT round(sum(amount)::numeric,2) FROM advance_requests WHERE comment LIKE ${"%" + TAG + "%"}) AS аванси,
         (SELECT round(sum(amount)::numeric,2) FROM hostel_deductions WHERE period_month=${MONTH}) AS хостели`);
console.log("суми:", JSON.stringify(tot.rows[0]));
await pool.end();
