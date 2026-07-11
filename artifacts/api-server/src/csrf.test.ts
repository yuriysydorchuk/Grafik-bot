import { test } from "node:test";
import assert from "node:assert/strict";

// Mirrors the CSRF guard predicate in app.ts. Keep in sync if the required header or the
// exempt route list changes. Regression for the "no CSRF token" finding: a state-changing
// request without the custom header must be rejected; login/2FA stay exempt.
function blocked(method: string, pth: string, xrw?: string): boolean {
  const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const authPost = pth === "/auth/login" || pth === "/auth/verify-2fa";
  return unsafe && !authPost && xrw !== "grafik";
}

test("cross-site POST without the header is blocked", () => {
  assert.equal(blocked("POST", "/workers"), true);
  assert.equal(blocked("DELETE", "/workers/5"), true);
  assert.equal(blocked("PATCH", "/schedule/entry/1/status"), true);
});

test("POST with the correct header passes", () => {
  assert.equal(blocked("POST", "/workers", "grafik"), false);
});

test("safe methods are never blocked", () => {
  assert.equal(blocked("GET", "/workers"), false);
  assert.equal(blocked("HEAD", "/dashboard"), false);
  assert.equal(blocked("OPTIONS", "/workers"), false);
});

test("login and 2FA are exempt (run before a session cookie exists)", () => {
  assert.equal(blocked("POST", "/auth/login"), false);
  assert.equal(blocked("POST", "/auth/verify-2fa"), false);
});

test("logout still requires the header (web client sends it)", () => {
  assert.equal(blocked("POST", "/auth/logout"), true);
  assert.equal(blocked("POST", "/auth/logout", "grafik"), false);
});
