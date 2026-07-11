import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffDocMime } from "./uploads.ts";

// Regression for the stored-XSS finding: the served MIME must come from the file's real
// magic bytes, never from the client-declared multipart type.

test("real PDF is accepted", () => {
  assert.equal(sniffDocMime(Buffer.from("%PDF-1.7\n1 0 obj")), "application/pdf");
});

test("real JPEG is accepted", () => {
  assert.equal(sniffDocMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), "image/jpeg");
});

test("real PNG is accepted", () => {
  assert.equal(sniffDocMime(Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\x0d", "latin1")), "image/png");
});

test("docx (ZIP container) is accepted", () => {
  assert.equal(
    sniffDocMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("HTML payload mislabeled as a document is rejected", () => {
  assert.equal(sniffDocMime(Buffer.from("<html><script>alert(1)</script></html>")), null);
});

test("SVG payload is rejected", () => {
  assert.equal(sniffDocMime(Buffer.from("<svg onload=alert(1)></svg>")), null);
});

test("empty / truncated buffer is rejected", () => {
  assert.equal(sniffDocMime(Buffer.from([])), null);
  assert.equal(sniffDocMime(Buffer.from([0xff])), null);
});
