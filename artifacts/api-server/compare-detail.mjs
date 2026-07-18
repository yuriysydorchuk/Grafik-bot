// Деталі по людях з розбіжностями конто/готівка: рядки сайту і оригіналу поруч
import { readFileSync } from "node:fs";
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseLublinTab, parseLodzFullTab, overlayGotowka, applyLegalDefaults } from "./src/services/svodni.ts";
import { gotowkaRowsForMonth } from "./src/services/svodniSync.ts";
import { key, cleanName } from "./src/services/payrollSummaries.ts";

const DIR = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/grids";
const G = (n) => new Map(Object.entries(JSON.parse(readFileSync(`${DIR}/${n}.json`, "utf8"))));
const SKIP = /GODZIN.*MIES|TOTAL.*MIES|MAILE|WORK ?LIST|NOTATKA|^OFFICE|^ОФИС/i;
const r2 = (n) => Math.round(n * 100) / 100;
const WHO = process.argv.slice(2).map(s => s.toUpperCase());

const origRows = new Map(); // key → [{factory, row}]
const JOBS = [
  { name: "lublin-2026-05" }, { name: "poznan-2026-05" },
  { name: "lodz-es-2026-05", gotowka: "gotowka-es" },
  { name: "lodz-eso-2026-05", gotowka: "gotowka-eso" },
  { name: "lodz-klinex-2026-05", gotowka: "gotowka-klinex" },
];
for (const j of JOBS) {
  const grids = G(j.name);
  const got = j.gotowka ? gotowkaRowsForMonth(G(j.gotowka), "2026-05") : [];
  for (const [t, rows] of grids) {
    if (SKIP.test(t.trim())) continue;
    const parsed = j.name.startsWith("lodz") ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!parsed) continue;
    if (got.length) overlayGotowka(parsed, got.filter(g => key(g.factory) === key(t) || key(t).startsWith(key(g.factory))));
    for (const r of parsed.rows) {
      applyLegalDefaults(r, false, { factoryLabel: t });
      const k = key(cleanName(r.rawName));
      if (!k) continue;
      (origRows.get(k) ?? origRows.set(k, []).get(k)).push({ factory: t, r });
    }
  }
}
const site = await db.select({ r: svodniRowsTable, name: workersTable.fullName, ls: workersTable.legalStatus, nh: workersTable.notifyHours, stud: workersTable.isStudent, pk: workersTable.payoutPrefKind, pv: workersTable.payoutPrefValue })
  .from(svodniRowsTable).leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
  .where(eq(svodniRowsTable.periodMonth, "2026-05"));

for (const who of WHO) {
  console.log(`\n════ ${who} ════`);
  for (const { r, name, ls, nh, stud, pk, pv } of site) {
    const nm = (name ?? r.rawName).toUpperCase();
    if (!nm.includes(who)) continue;
    console.log(`САЙТ [${r.factoryLabel}] год=${r.hours} повід=${r.hoursNotified} декл=${r.hoursDeclared} ставкаN=${r.rateNetto} виплата=${r.doWyplaty} конто=${r.konto} готівка=${r.gotowka} | профіль: ls=${ls} notify=${nh} stud=${stud} pref=${pk ?? "—"}${pv ? ":" + pv : ""}`);
  }
  for (const [k, list] of origRows) {
    if (!k.includes(who.replace(/\s+/g, " ").split(" ")[0]) && !list.some(x => x.r.rawName.toUpperCase().includes(who))) continue;
    for (const { factory, r } of list) {
      if (!r.rawName.toUpperCase().includes(who)) continue;
      console.log(`ОРИГ [${factory}] год=${r.hours} повід=${r.hoursNotified} декл=${r.hoursDeclared} ставкаN=${r.rateNetto} виплата=${r.doWyplaty} конто=${r.konto ?? r.ksiegNetto} готівка=${r.gotowka} zus="${r.extras?.zusStatus ?? ""}"`);
    }
  }
}
await pool.end();
