// Разово: становіска Sushi&Food Factory з червневої познанської сводної
// (колонка Stanowisko) → positions + factory_positions + workers.position_id.
// Запуск: node --env-file=../../.env --import ./test-hooks.mjs import-sushi-stanowiska.mjs
import { readFileSync } from "node:fs";
import { db, pool, workersTable, factoriesTable, positionsTable, factoryPositionsTable } from "@workspace/db";
import { eq, and, ilike } from "drizzle-orm";
import { matchWorker } from "./src/bot/workerMatch.ts";

const MAP_FILE = "/private/tmp/claude-501/-Users-yuriysydorchuk-PycharmProjects-Grafik-bot/19c4e53e-7655-416e-94d0-7cf02b1528ea/scratchpad/sushi-stanowiska.json";
const FIX = { "Brygadzista Skladanie": "Brygadzista Składanie" }; // одрук у таблиці
const entries = JSON.parse(readFileSync(MAP_FILE, "utf8"))
  .map(([name, st]) => [name, FIX[st] ?? st]);

const sushi = (await db.select().from(factoriesTable).where(ilike(factoriesTable.name, "%sushi%")))[0];
if (!sushi) throw new Error("Sushi factory not found");

// 1) позиції: створити відсутні
const stanowiska = [...new Set(entries.map(([, st]) => st))];
const existing = await db.select().from(positionsTable);
const posByName = new Map(existing.map(p => [p.name.toLowerCase(), p]));
const COLORS = ["red", "amber", "emerald", "sky", "violet", "rose", "teal"];
let order = Math.max(0, ...existing.map(p => p.sortOrder)) + 1;
for (const [i, st] of stanowiska.entries()) {
  if (posByName.has(st.toLowerCase())) continue;
  const [row] = await db.insert(positionsTable)
    .values({ name: st, color: COLORS[i % COLORS.length], sortOrder: order++, isActive: true }).returning();
  posByName.set(st.toLowerCase(), row);
  console.log(`+ позиція: ${st}`);
}

// 2) причепити до фабрики + uses_positions
const fps = await db.select().from(factoryPositionsTable).where(eq(factoryPositionsTable.factoryId, sushi.id));
const have = new Set(fps.map(f => f.positionId));
let so = Math.max(0, ...fps.map(f => f.sortOrder)) + 1;
for (const st of stanowiska) {
  const p = posByName.get(st.toLowerCase());
  if (have.has(p.id)) continue;
  await db.insert(factoryPositionsTable).values({ factoryId: sushi.id, positionId: p.id, sortOrder: so++ });
  console.log(`+ фабрична позиція: ${st}`);
}
if (!sushi.usesPositions) {
  await db.update(factoriesTable).set({ usesPositions: true }).where(eq(factoriesTable.id, sushi.id));
  console.log("+ uses_positions = true");
}

// 3) проставити профілям (матчинг по імені серед працівників Sushi, потім всіх)
const all = await db.select().from(workersTable);
const sushiWorkers = all.filter(w => w.factoryId === sushi.id);
let set = 0, skip = 0, miss = [];
for (const [name, st] of entries) {
  const p = posByName.get(st.toLowerCase());
  const m = matchWorker(name, sushiWorkers).confident ?? matchWorker(name, all).confident;
  if (!m) { miss.push(name); continue; }
  if (m.positionId === p.id) { skip++; continue; }
  await db.update(workersTable).set({ positionId: p.id }).where(eq(workersTable.id, m.id));
  set++;
}
console.log(`профілі: проставлено ${set}, вже було ${skip}, не знайдено ${miss.length}`);
for (const m of miss) console.log(`  ? ${m}`);
await pool.end();
