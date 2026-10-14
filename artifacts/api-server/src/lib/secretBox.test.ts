import { test } from "node:test";
import assert from "node:assert/strict";
process.env.PZ_SECRET = "unit-test-key-not-a-real-secret";
const { sealSecret, openSecret, isSecretBoxReady } = await import("./secretBox");

test("secretBox: round-trip, random iv, tamper detection", () => {
  assert.equal(isSecretBoxReady(), true);
  const s = sealSecret("pa$$wörd ✓");
  assert.notEqual(s, "pa$$wörd ✓");
  assert.equal(openSecret(s), "pa$$wörd ✓");
  assert.notEqual(sealSecret("x"), sealSecret("x"));
  const parts = s.split(".");
  parts[3] = parts[3]!.slice(0, -2) + "AA";
  assert.throws(() => openSecret(parts.join(".")));
});
