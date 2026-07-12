import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { hashPassword, verifyPassword, createToken, verifyToken } from "./auth.ts";

// ─── Password hashing (scrypt) ───────────────────────────────────────────────

test("verifyPassword accepts the correct password against its own hash", () => {
  const stored = hashPassword("s3cret-π-Ω");
  assert.equal(verifyPassword("s3cret-π-Ω", stored), true);
});

test("verifyPassword rejects a wrong password", () => {
  const stored = hashPassword("correct horse");
  assert.equal(verifyPassword("wrong horse", stored), false);
});

test("hashPassword is salted — same password hashes differently each time", () => {
  const a = hashPassword("same");
  const b = hashPassword("same");
  assert.notEqual(a, b);
  // …yet both verify.
  assert.equal(verifyPassword("same", a), true);
  assert.equal(verifyPassword("same", b), true);
});

test("verifyPassword rejects null/empty/malformed stored hashes without throwing", () => {
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", undefined), false);
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "no-colon-here"), false);
  assert.equal(verifyPassword("x", "nothex:nothex"), false);
});

// ─── Session token (HMAC-signed) ─────────────────────────────────────────────

test("createToken → verifyToken round-trips the payload", () => {
  const token = createToken(42, "Yuriy", "owner", 3, "sid-abc");
  const p = verifyToken(token);
  assert.ok(p);
  assert.equal(p!.adminId, 42);
  assert.equal(p!.name, "Yuriy");
  assert.equal(p!.role, "owner");
  assert.equal(p!.tv, 3);
  assert.equal(p!.sid, "sid-abc");
});

test("verifyToken rejects a tampered signature", () => {
  const token = createToken(1, "A", "owner", 0, "s");
  const [body] = token.split(".");
  assert.equal(verifyToken(`${body}.deadbeef`), null);
});

test("verifyToken rejects a tampered payload (re-encoded body, stale signature)", () => {
  const token = createToken(1, "A", "owner", 0, "s");
  const [, sig] = token.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ adminId: 999, name: "A", role: "owner", exp: Date.now() + 1e6, tv: 0, sid: "s" }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyToken(`${forgedBody}.${sig}`), null);
});

test("verifyToken rejects garbage and shape-invalid strings", () => {
  assert.equal(verifyToken(undefined), null);
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken("no-dot"), null);
  assert.equal(verifyToken("a.b.c"), null);
});

test("verifyToken rejects an expired token even with a valid signature", () => {
  // Mint a correctly-signed token with a past exp using the same secret contract.
  const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
  const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = b64url(Buffer.from(JSON.stringify({ adminId: 1, name: "A", role: "owner", exp: Date.now() - 1000, tv: 0, sid: "s" })));
  const sig = b64url(createHmac("sha256", SECRET).update(body).digest());
  assert.equal(verifyToken(`${body}.${sig}`), null);
});
