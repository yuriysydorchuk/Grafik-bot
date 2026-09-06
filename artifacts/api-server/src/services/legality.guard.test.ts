// C11 — grep-гард інваріанту payroll: код listy płac / сводних / обліку годин
// НЕ імпортує движок легальності. Поява імпорту = свідома зміна payroll-логіки,
// яка потребує окремого підтвердження власника (звіт фази 0, §3.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAYROLL_FILES = [
  "services/svodni.ts", "routes/svodni.ts", "services/svodniSync.ts", "services/hoursRows.ts",
  "lib/payroll.ts", "routes/admin-api.ts", "services/factoryRules.ts", "services/gratyfikantExport.ts",
  "services/effectiveStatus.ts", // резолвер виплат (06.09.2026): читає лише кеш worker_legality, не движок
];
const FORBIDDEN = /from\s+["'][^"']*\/(legality|legalityRecompute|legalizationSeed)["']/;

test("payroll-код не імпортує services/legality* (інваріант listy płac)", () => {
  for (const rel of PAYROLL_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, "utf8");
    assert.ok(!FORBIDDEN.test(src), `${rel} імпортує движок легальності — це зміна payroll-логіки, потрібне окреме рішення`);
  }
});

test("движок легальності сам не тягне БД (чиста функція)", () => {
  const src = fs.readFileSync(path.join(ROOT, "services/legality.ts"), "utf8");
  assert.ok(!/@workspace\/db/.test(src), "services/legality.ts не має імпортувати @workspace/db");
  assert.ok(!/from\s+["']\.\/svodni["']/.test(src), "services/legality.ts не має імпортувати svodni.ts");
});
