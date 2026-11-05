// Пари ZUS (зголошення #16): чиста функція pairZusDocs — без БД.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairZusDocs, type ZusDocIn } from "../lib/zusPairs.ts";

const reg = (id: number, date: string, companyId: number | null = 1): ZusDocIn => ({ id, kind: "reg", companyId, date });
const dereg = (id: number, date: string, companyId: number | null = 1): ZusDocIn => ({ id, kind: "dereg", companyId, date });

test("ZUA → ZWUA → ZUA: перше зголошення закрите датою ZWUA, друге — чинне", () => {
  const s = pairZusDocs([reg(1, "2026-03-01"), dereg(2, "2026-06-11"), reg(3, "2026-09-01")]);
  assert.deepEqual(s.get(1), { kind: "reg", status: "closed", date: "2026-03-01", until: "2026-06-11", byId: 2, companyId: 1 });
  assert.deepEqual(s.get(2), { kind: "dereg", date: "2026-06-11", closesId: 1, regDate: "2026-03-01", companyId: 1 });
  assert.deepEqual(s.get(3), { kind: "reg", status: "open", date: "2026-09-01", companyId: 1 });
});

test("ZUA в день ZWUA — безперервно: ZWUA закриває старе, нове лишається чинним", () => {
  const s = pairZusDocs([reg(1, "2026-01-10"), reg(3, "2026-05-01"), dereg(2, "2026-05-01")]);
  assert.equal(s.get(1)!.kind === "reg" && s.get(1)!.status, "closed");
  assert.equal((s.get(2) as any).closesId, 1);
  assert.equal(s.get(3)!.kind === "reg" && s.get(3)!.status, "open");
});

test("фірми не змішуються: ZWUA однієї фірми не закриває зголошення іншої", () => {
  const s = pairZusDocs([reg(1, "2026-01-10", 1), reg(2, "2026-02-01", 2), dereg(3, "2026-04-01", 2)]);
  assert.equal((s.get(1) as any).status, "open");
  assert.equal((s.get(2) as any).status, "closed");
  assert.equal((s.get(3) as any).closesId, 2);
});

test("документ без фірми йде до єдиної відомої фірми; ZWUA без зголошення — без пари", () => {
  const s = pairZusDocs([reg(1, "2026-01-10", 7), dereg(2, "2026-03-01", null)]);
  assert.deepEqual([(s.get(1) as any).status, (s.get(2) as any).closesId, (s.get(2) as any).companyId], ["closed", 1, 7]);
  const orphan = pairZusDocs([dereg(5, "2026-03-01", null)]);
  assert.deepEqual(orphan.get(5), { kind: "dereg", date: "2026-03-01", closesId: null, regDate: null, companyId: null });
  // дві відомі фірми — документ без фірми окремою групою
  const two = pairZusDocs([reg(1, "2026-01-10", 1), reg(2, "2026-01-10", 2), dereg(3, "2026-03-01", null)]);
  assert.deepEqual([(two.get(1) as any).status, (two.get(2) as any).status, (two.get(3) as any).closesId], ["open", "open", null]);
});

test("ZZA → ZUA без ZWUA: старе «замінене», чинне — новіше; пізніша ZWUA закриває саме його", () => {
  const s = pairZusDocs([reg(1, "2026-01-10"), reg(2, "2026-02-15"), dereg(3, "2026-08-01")]);
  assert.deepEqual(s.get(1), { kind: "reg", status: "replaced", date: "2026-01-10", byId: 2, companyId: 1 });
  assert.deepEqual([(s.get(2) as any).status, (s.get(2) as any).until, (s.get(3) as any).closesId], ["closed", "2026-08-01", 2]);
});
