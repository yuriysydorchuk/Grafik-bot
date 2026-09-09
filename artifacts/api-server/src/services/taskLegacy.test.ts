import { test } from "node:test";
import assert from "node:assert/strict";
import { isLegacyWorker } from "./taskLegacy.ts";

const before = new Date("2026-06-01T10:00:00Z");
const after = new Date("2026-09-20T10:00:00Z");

test("legacy: доданий до дати запуску без документів і умов → старий", () => {
  assert.equal(isLegacyWorker({ createdAt: before, hasDocs: false, hasContract: false }, "2026-09-08"), true);
});
test("legacy: перший документ або умова виводить з «старих»", () => {
  assert.equal(isLegacyWorker({ createdAt: before, hasDocs: true, hasContract: false }, "2026-09-08"), false);
  assert.equal(isLegacyWorker({ createdAt: before, hasDocs: false, hasContract: true }, "2026-09-08"), false);
});
test("legacy: доданий у день запуску або пізніше — не старий, навіть без документів", () => {
  assert.equal(isLegacyWorker({ createdAt: after, hasDocs: false, hasContract: false }, "2026-09-08"), false);
  assert.equal(isLegacyWorker({ createdAt: "2026-09-08", hasDocs: false, hasContract: false }, "2026-09-08"), false);
});
test("legacy: без дати в налаштуваннях гейт вимкнено", () => {
  assert.equal(isLegacyWorker({ createdAt: before, hasDocs: false, hasContract: false }, null), false);
  assert.equal(isLegacyWorker({ createdAt: null, hasDocs: false, hasContract: false }, "2026-09-08"), false);
});
