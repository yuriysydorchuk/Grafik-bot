// Разово: премії (з складниками) і migawka з оригінальної травневої таблиці →
// клітинки сайтової сводної (як ручний ввід) + перерахунок формул.
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab, computePayout, applyLegalDefaults } from "./src/services/svodni.ts";
import { matchSvodniName, dedupeWorkers } from "./src/services/svodniSync.ts";
import { key, cleanName } from "./src/services/payrollSummaries.ts";

const MONTH = "2026-05";
const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;

const workers = dedupeWorkers(await db.select().from(workersTable));
const wById = new Map(workers.map(w => [w.id, w]));
const siteRows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, MONTH));
const rowsByWorker = new Map();
for (const r of siteRows) {
  if (r.workerId == null) continue;
  (rowsByWorker.get(r.workerId) ?? rowsByWorker.set(r.workerId, []).get(r.workerId)).push(r);
}

let updated = 0, missed = [];
for (const [name, kind] of [["lublin-2026-05","L"],["poznan-2026-05","L"],["lodz-es-2026-05","Ł"],["lodz-eso-2026-05","Ł"],["lodz-klinex-2026-05","Ł"]]) {
  const g = new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8"))));
  for (const [t, rows] of g) {
    if (SKIP.test(t.trim())) continue;
    const p = kind === "Ł" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!p) continue;
    for (const src of p.rows) {
      const migawka = typeof src.extras.migawka === "number" ? src.extras.migawka : 0;
      if (!(src.premia > 0) && !(migawka > 0)) continue;
      const w = matchSvodniName(cleanName(src.rawName), workers);
      const targets = w ? rowsByWorker.get(w.id) ?? [] : [];
      const target = targets.length > 1
        ? targets.find(x => key(x.factoryLabel) === key(t) || key(t).startsWith(key(x.factoryLabel)) || key(x.factoryLabel).startsWith(key(t))) ?? targets[0]
        : targets[0];
      if (!target) { missed.push(`${src.rawName} (${t})`); continue; }
      const merged = { ...target };
      if (src.premia > 0) merged.premia = r2(src.premia);
      const extras = { ...(merged.extras ?? {}) };
      for (const k of ["premiaBase", "premiaAgram", "premiaEs"]) {
        if (typeof src.extras[k] === "number" && src.extras[k] !== 0) extras[k] = r2(src.extras[k]);
      }
      if (migawka > 0) extras.migawka = r2(migawka);
      merged.extras = extras;
      const payout = computePayout(merged, target.city);
      if (payout != null) merged.doWyplaty = payout;
      applyLegalDefaults(merged, true, { profileLegal: wById.get(target.workerId)?.legalStatus ?? null, factoryLabel: target?.factoryLabel ?? r?.factory_label ?? null });
      await db.update(svodniRowsTable).set({
        premia: merged.premia, extras: merged.extras, doWyplaty: merged.doWyplaty,
        hoursDeclared: merged.hoursDeclared, ksiegBrutto: merged.ksiegBrutto,
        ksiegNetto: merged.ksiegNetto, konto: merged.konto, gotowka: merged.gotowka,
        manual: true, mismatch: null,
      }).where(eq(svodniRowsTable.id, target.id));
      updated++;
    }
  }
}
console.log(`оновлено рядків: ${updated}; без цілі: ${missed.length}`);
for (const m of missed) console.log("  ?", m);
const { sql } = await import("drizzle-orm");
const agg = await db.execute(sql`
  SELECT round(sum(premia)::numeric,2) AS premia,
         round(sum((extras->>'migawka')::real)::numeric,2) AS migawka,
         round(sum(do_wyplaty)::numeric,2) AS do_wyplaty,
         round(sum(konto)::numeric,2) AS konto, round(sum(gotowka)::numeric,2) AS gotowka
  FROM svodni_rows WHERE period_month=${MONTH}`);
console.log(JSON.stringify(agg.rows[0]));
await pool.end();
