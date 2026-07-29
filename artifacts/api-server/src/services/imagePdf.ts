// Фото рапорту → PDF. Сторінка = розмір самого зображення (full-bleed, без
// білих полів A4), а EXIF-орієнтація телефонних фото (збережене боком JPEG з
// тегом «поверни при показі», який pdf-lib ігнорує) застосовується поворотом
// при малюванні. Чистий модуль без Drive — під юніт-тестами.
import { PDFDocument, degrees } from "pdf-lib";

// Орієнтація з EXIF (тег 0x0112): 1 = нормально, 3 = 180°, 6 = 90° CW,
// 8 = 90° CCW. Дзеркальні (2/4/5/7) зводимо до найближчого повороту.
export function parseJpegOrientation(buf: Buffer): number {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) break;
      const marker = buf[off + 1]!;
      if (marker === 0xda || marker === 0xd9) break; // SOS/EOI — EXIF далі не буде
      const size = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && off + 10 <= buf.length && buf.toString("ascii", off + 4, off + 10) === "Exif\0\0") {
        const tiff = off + 10;
        const le = buf.toString("ascii", tiff, tiff + 2) === "II";
        const rd16 = (p: number) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
        const rd32 = (p: number) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        const ifd = tiff + rd32(tiff + 4);
        const n = rd16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > buf.length) break;
          if (rd16(e) === 0x0112) {
            const o = rd16(e + 8);
            return o >= 1 && o <= 8 ? o : 1;
          }
        }
        return 1;
      }
      off += 2 + size;
    }
  } catch { /* биті EXIF-дані → без повороту */ }
  return 1;
}

export async function imageToPdf(imageBuffer: Buffer, mimeType: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  // копія без byteOffset: pdf-lib читає DataView від початку ArrayBuffer,
  // а Buffer'и Node часто сидять у спільному пулі зі зсувом → «SOI not found»
  const bytes = new Uint8Array(imageBuffer);
  const image = mimeType === "image/png"
    ? await pdfDoc.embedPng(bytes)
    : await pdfDoc.embedJpg(bytes);
  const rawO = mimeType === "image/png" ? 1 : parseJpegOrientation(imageBuffer);
  const orientation = rawO === 2 ? 1 : rawO === 4 ? 3 : rawO === 5 ? 6 : rawO === 7 ? 8 : rawO;
  // не роздуваємо сторінку понад ~1200pt по довшій стороні
  const s = Math.min(1, 1200 / Math.max(image.width, image.height));
  const w = image.width * s, h = image.height * s;
  if (orientation === 6) {
    // збережено лежачи, показувати повернутим на 90° за годинниковою
    const page = pdfDoc.addPage([h, w]);
    page.drawImage(image, { x: 0, y: w, width: w, height: h, rotate: degrees(-90) });
  } else if (orientation === 8) {
    const page = pdfDoc.addPage([h, w]);
    page.drawImage(image, { x: h, y: 0, width: w, height: h, rotate: degrees(90) });
  } else if (orientation === 3) {
    const page = pdfDoc.addPage([w, h]);
    page.drawImage(image, { x: w, y: h, width: w, height: h, rotate: degrees(180) });
  } else {
    const page = pdfDoc.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await pdfDoc.save());
}
