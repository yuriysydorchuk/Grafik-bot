// Разово: решта відрахувань травня з оригінальної таблиці → клітинки сайтової
// сводної (як ручний ввід): dojazd, kara, kara ES/клієнта, potrącenia,
// komornik, odzież. Після запису — той самий перерахунок, що при правці.
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

const JOBS = [
  ["lublin-2026-05", "L"], ["poznan-2026-05", "L"],
  ["lodz-es-2026-05", "Ł"], ["lodz-eso-2026-05", "Ł"], ["lodz-klinex-2026-05", "Ł"],
];
let updated = 0, missed = [];
for (const [name, kind] of JOBS) {
  const g = new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8"))));
  for (const [t, rows] of g) {
    if (SKIP.test(t.trim())) continue;
    const p = kind === "Ł" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!p) continue;
    for (const src of p.rows) {
      const core = {
        dojazd: src.dojazd, kara: src.kara, komornik: src.komornik,
        potracenia: src.potracenia, odziez: src.odziez, kaucja: src.kaucja,
      };
      const ex = {
        karaEs: src.extras.karaEs, karaKlient: src.extras.karaKlient,
        zadluzenie: src.extras.zadluzenie,
      };
      const hasAny = Object.values(core).some(v => v > 0) || Object.values(ex).some(v => typeof v === "number" && v > 0);
      if (!hasAny) continue;
      const w = matchSvodniName(cleanName(src.rawName), workers);
      const targets = w ? rowsByWorker.get(w.id) ?? [] : [];
      // якщо в людини кілька рядків — той, чия фабрика збігається зі вкладкою
      const target = targets.length > 1
        ? targets.find(x => key(x.factoryLabel) === key(t) || key(t).startsWith(key(x.factoryLabel)) || key(x.factoryLabel).startsWith(key(t))) ?? targets[0]
        : targets[0];
      if (!target) { missed.push(`${src.rawName} (${t})`); continue; }
      const merged = { ...target };
      for (const [k, v] of Object.entries(core)) if (v > 0) merged[k] = r2(v);
      const extras = { ...(merged.extras ?? {}) };
      for (const [k, v] of Object.entries(ex)) if (typeof v === "number" && v > 0) extras[k] = r2(v);
      merged.extras = extras;
      const payout = computePayout(merged, target.city);
      if (payout != null) merged.doWyplaty = payout;
      applyLegalDefaults(merged, true, wById.get(target.workerId)?.legalStatus ?? null);
      await db.update(svodniRowsTable).set({
        dojazd: merged.dojazd, kara: merged.kara, komornik: merged.komornik,
        potracenia: merged.potracenia, odziez: merged.odziez, kaucja: merged.kaucja,
        extras: merged.extras, doWyplaty: merged.doWyplaty,
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
const agg = await db.execute(
  (await import("drizzle-orm")).sql`
  SELECT round(sum(dojazd)::numeric,2) AS dojazd, round(sum(kara)::numeric,2) AS kara,
         round(sum(komornik)::numeric,2) AS komornik, round(sum(potracenia)::numeric,2) AS potracenia,
         round(sum(odziez)::numeric,2) AS odziez,
         round(sum((extras->>'karaEs')::real)::numeric,2) AS kara_es,
         round(sum((extras->>'karaKlient')::real)::numeric,2) AS kara_klient,
         round(sum(do_wyplaty)::numeric,2) AS do_wyplaty,
         round(sum(konto)::numeric,2) AS konto, round(sum(gotowka)::numeric,2) AS gotowka
  FROM svodni_rows WHERE period_month=${MONTH}`);
console.log(JSON.stringify(agg.rows[0], null, 1));
await pool.end();
