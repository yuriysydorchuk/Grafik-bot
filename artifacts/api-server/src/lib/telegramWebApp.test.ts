import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWebAppInitData, signWebAppInitData } from "./telegramWebApp.ts";

const TOKEN = "123456:TEST-FAKE-TOKEN";
const NOW = 1_750_000_000_000; // fixed clock for determinism
const fields = (over: Record<string, string> = {}) => ({
  auth_date: String(Math.floor(NOW / 1000) - 30),
  query_id: "AAF03QIrAAAAAPTdAitDoSBL",
  user: JSON.stringify({ id: 42, first_name: "Test", username: "tester" }),
  ...over,
});

test("valid signed initData passes and yields the user", () => {
  const initData = signWebAppInitData(fields(), TOKEN);
  const res = verifyWebAppInitData(initData, TOKEN, NOW);
  assert.equal(res?.user.id, 42);
  assert.equal(res?.user.username, "tester");
});

test("tampered field or wrong token is rejected", () => {
  const initData = signWebAppInitData(fields(), TOKEN);
  const forged = initData.replace("tester", "hacker");
  assert.equal(verifyWebAppInitData(forged, TOKEN, NOW), null);
  assert.equal(verifyWebAppInitData(initData, "999999:OTHER-TOKEN", NOW), null);
});

test("stale auth_date is rejected (replay window)", () => {
  const old = signWebAppInitData(fields({ auth_date: String(Math.floor(NOW / 1000) - 3600) }), TOKEN);
  assert.equal(verifyWebAppInitData(old, TOKEN, NOW), null);
});

test("missing hash / user / garbage input is rejected", () => {
  assert.equal(verifyWebAppInitData("", TOKEN, NOW), null);
  assert.equal(verifyWebAppInitData("auth_date=1&user=%7B%7D", TOKEN, NOW), null);
  const noUser = signWebAppInitData({ auth_date: String(Math.floor(NOW / 1000)) }, TOKEN);
  assert.equal(verifyWebAppInitData(noUser, TOKEN, NOW), null);
});
