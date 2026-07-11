import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAnyCap } from "./auth.ts";

// Exercises the gate now applied to GET /drivers/:id/invite (DRIVER_RW). Regression for the
// missing-capability finding: an authenticated but capless admin must NOT reach the handler.
function runGate(admin: any) {
  const mw = requireAnyCap("editData", "assignDrivers");
  const res: any = {
    code: 0, body: null,
    status(c: number) { this.code = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
  let nexted = false;
  mw({ admin } as any, res, () => { nexted = true; });
  return { nexted, code: res.code, body: res.body };
}

test("driver-invite gate: capless role is forbidden", () => {
  const r = runGate({ role: "viewer", caps: [], isMain: false });
  assert.equal(r.nexted, false);
  assert.equal(r.code, 403);
});

test("driver-invite gate: assignDrivers passes", () => {
  const r = runGate({ role: "driver", caps: ["assignDrivers"], isMain: false });
  assert.equal(r.nexted, true);
});

test("driver-invite gate: editData passes", () => {
  const r = runGate({ role: "scheduler", caps: ["editData"], isMain: false });
  assert.equal(r.nexted, true);
});

test("driver-invite gate: owner always passes even with empty caps", () => {
  const r = runGate({ role: "owner", caps: [], isMain: true });
  assert.equal(r.nexted, true);
});

test("driver-invite gate: no session is unauthorized", () => {
  const r = runGate(undefined);
  assert.equal(r.nexted, false);
  assert.equal(r.code, 401);
});
