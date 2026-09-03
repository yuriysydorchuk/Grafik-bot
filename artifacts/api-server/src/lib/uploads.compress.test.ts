import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { compressUploadImage, UPLOAD_IMAGE_MAX_SIDE } from "./uploads.ts";

// Фото з телефона (4000×3000) на диску має стати JPEG ≤2000 px по довшій стороні;
// PDF і невеликі JPEG лишаються як є.

test("велике PNG → JPEG, довша сторона 2000, ім'я .jpg", async () => {
  const src = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
  const out = await compressUploadImage(src, "image/png", "IMG_0001.PNG");
  assert.equal(out.mime, "image/jpeg");
  assert.equal(out.fileName, "IMG_0001.jpg");
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(Math.max(meta.width!, meta.height!), UPLOAD_IMAGE_MAX_SIDE);
  assert.ok(out.buffer.length < src.length);
});

test("EXIF-орієнтація застосовується (лежачий кадр стає портретним)", async () => {
  const src = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#888" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const out = await compressUploadImage(src, "image/jpeg", "a.jpg");
  const meta = await sharp(out.buffer).metadata();
  assert.ok(meta.height! > meta.width!, "після повороту на 90° висота більша за ширину");
  assert.equal(meta.orientation, undefined, "EXIF-тег знято");
});

test("PDF не чіпається", async () => {
  const src = Buffer.from("%PDF-1.7\n1 0 obj");
  const out = await compressUploadImage(src, "application/pdf", "umowa.pdf");
  assert.equal(out.buffer, src); assert.equal(out.mime, "application/pdf"); assert.equal(out.fileName, "umowa.pdf");
});

test("маленький JPEG ніколи не стає більшим", async () => {
  const src = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } }).jpeg({ quality: 50 }).toBuffer();
  const out = await compressUploadImage(src, "image/jpeg", "small.jpeg");
  assert.equal(out.mime, "image/jpeg");
  assert.ok(out.buffer.length <= src.length);
});

test("пошкоджене зображення → оригінал без винятку", async () => {
  const src = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const out = await compressUploadImage(src, "image/jpeg", "broken.jpg");
  assert.equal(out.buffer, src);
});
