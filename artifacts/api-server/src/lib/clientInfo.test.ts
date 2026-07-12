import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDevice, isPrivateIp } from "./clientInfo.ts";

// parseDevice — best-effort "Browser на OS" label.
test("parseDevice: common browser/OS combinations", () => {
  assert.equal(parseDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0"), "Chrome на Windows");
  assert.equal(parseDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1"), "Safari на iOS");
  assert.equal(parseDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/121.0"), "Firefox на macOS");
});

test("parseDevice: Edge/Opera win over the Chrome token they embed", () => {
  assert.equal(parseDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120"), "Edge на Windows");
  assert.equal(parseDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 OPR/106"), "Opera на Windows");
});

test("parseDevice: null/empty and unknown UA fall back gracefully", () => {
  assert.equal(parseDevice(null), null);
  assert.equal(parseDevice(undefined), null);
  assert.equal(parseDevice("weird-bot/1.0"), "weird-bot/1.0"); // no browser/os → first 40 chars
});

// isPrivateIp — gates the outbound geo lookup; must catch every private / loopback range.
test("isPrivateIp: loopback and link-local", () => {
  for (const ip of ["127.0.0.1", "::1", "localhost", "169.254.1.1"]) assert.equal(isPrivateIp(ip), true, ip);
});

test("isPrivateIp: RFC1918 ranges (10/8, 192.168/16, 172.16-31/12)", () => {
  for (const ip of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "172.31.255.255"]) assert.equal(isPrivateIp(ip), true, ip);
  // 172.32.x is OUTSIDE the private block.
  assert.equal(isPrivateIp("172.32.0.1"), false);
});

test("isPrivateIp: IPv6 ULA and IPv4-mapped IPv6", () => {
  assert.equal(isPrivateIp("fd00::1"), true);          // unique local
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);  // mapped private
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);  // mapped public
});

test("isPrivateIp: public addresses are not private", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5"]) assert.equal(isPrivateIp(ip), false, ip);
});
