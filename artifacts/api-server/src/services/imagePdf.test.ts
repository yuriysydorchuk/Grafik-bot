import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { parseJpegOrientation, imageToPdf, appendImageToPdf } from "./imagePdf.ts";

// Мінімальний валідний JPEG 1×1 (біле), без EXIF.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

// APP1-сегмент з EXIF-тегом орієнтації (TIFF little-endian, 1 запис IFD).
function exifApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(2 + 4 + 2 + 12 + 4);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4);          // офсет IFD0
  tiff.writeUInt16LE(1, 8);          // 1 запис
  tiff.writeUInt16LE(0x0112, 10);    // Orientation
  tiff.writeUInt16LE(3, 12);         // SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

const jpegWithOrientation = (o: number): Buffer =>
  Buffer.concat([TINY_JPEG.subarray(0, 2), exifApp1(o), TINY_JPEG.subarray(2)]);

test("parseJpegOrientation: без EXIF → 1, з тегом → значення тега", () => {
  assert.equal(parseJpegOrientation(TINY_JPEG), 1);
  assert.equal(parseJpegOrientation(jpegWithOrientation(6)), 6);
  assert.equal(parseJpegOrientation(jpegWithOrientation(8)), 8);
  assert.equal(parseJpegOrientation(jpegWithOrientation(3)), 3);
  assert.equal(parseJpegOrientation(Buffer.from("not a jpeg")), 1);
});

test("imageToPdf: сторінка = розмір фото (без білих полів A4), PDF валідний", async () => {
  const pdf = await imageToPdf(TINY_JPEG, "image/jpeg");
  const doc = await PDFDocument.load(pdf);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 1);
  assert.equal(height, 1);
});

test("imageToPdf: EXIF-повернуте фото не падає і дає валідний PDF", async () => {
  for (const o of [3, 6, 8]) {
    const pdf = await imageToPdf(jpegWithOrientation(o), "image/jpeg");
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1);
  }
});

// Повторні здачі рапорту: кожне нове фото — окрема сторінка того самого PDF.
test("appendImageToPdf: дописує сторінки, попередні лишаються; сміття → помилка (фолбек колера)", async () => {
  const first = await imageToPdf(TINY_JPEG, "image/jpeg");
  const second = await appendImageToPdf(first, jpegWithOrientation(6), "image/jpeg");
  const third = await appendImageToPdf(second, TINY_JPEG, "image/jpeg");
  const doc = await PDFDocument.load(third);
  assert.equal(doc.getPageCount(), 3);
  const p0 = doc.getPage(0).getSize();
  assert.equal(p0.width, 1); // перша сторінка не зіпсована дозаписами
  await assert.rejects(() => appendImageToPdf(Buffer.from("not a pdf"), TINY_JPEG, "image/jpeg"));
});
