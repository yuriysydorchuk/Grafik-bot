// Local-disk storage for uploaded files (worker documents, etc.).
// Files live outside git in `uploads/` at the repo root (persistent across
// deploys; back it up). Served only via authenticated endpoints — never as
// static files, since these are personal documents.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

// Root of the uploads tree. Defaults to <cwd>/uploads (cwd is the repo root
// under pm2). Override with UPLOADS_DIR for a volume mount.
export const UPLOADS_ROOT = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(process.cwd(), "uploads");

export const WORKER_DOCS_DIR = path.join(UPLOADS_ROOT, "worker-documents");
export const INVOICES_DIR = path.join(UPLOADS_ROOT, "invoices"); // скани фактур (бот + сайт)
export const CONTRACTS_DIR = path.join(UPLOADS_ROOT, "contracts"); // згенеровані/підписані PDF умов
export const SIGNATURES_DIR = path.join(UPLOADS_ROOT, "signatures"); // PNG підписів (доказова база)
export const PASSPORT_SCAN_TMP_DIR = path.join(UPLOADS_ROOT, "passport-scan-tmp"); // /passport-scan/:token: між analyze() і confirm()

// Create the upload directories once at startup.
export function ensureUploadDirs(): void {
  fs.mkdirSync(WORKER_DOCS_DIR, { recursive: true });
  fs.mkdirSync(INVOICES_DIR, { recursive: true });
  fs.mkdirSync(CONTRACTS_DIR, { recursive: true });
  fs.mkdirSync(SIGNATURES_DIR, { recursive: true });
  fs.mkdirSync(PASSPORT_SCAN_TMP_DIR, { recursive: true });
}

// The multipart MIME is client-declared and NOT trustworthy. Sniff magic bytes so a
// mislabeled HTML/SVG payload can't be stored under an allowed type and later served
// inline into an admin's same-origin session (CSP is disabled app-wide). Returns the
// detected MIME, or null when the content matches none of the accepted document types.
export function sniffDocMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "%PDF") return "application/pdf";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && /hei[cf]|mif1|heix/.test(buf.toString("latin1", 8, 12))) return "image/heic";
  // .docx is a ZIP (PK) container; legacy .doc is an OLE compound file.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (buf.length >= 8 && buf.toString("hex", 0, 8) === "d0cf11e0a1b11ae1") return "application/msword";
  return null;
}

// Фото документів з телефона — 5–10 МБ на кадр; на диску такий розмір нічого не
// дає (читає людина або OCR, якому досить ~2000 px по довшій стороні). Перед
// записом: EXIF-поворот (щоб не лежало боком у переглядачі), довша сторона до
// 2000 px, JPEG 85 → типово 300–600 КБ. PDF/Word — без змін. HEIC prebuilt-sharp
// без HEVC-декодера не читає → лишається як є (Telegram і так шле JPEG).
// Ім'я файла отримує .jpg, якщо формат змінився.
export const UPLOAD_IMAGE_MAX_SIDE = 2000;
export async function compressUploadImage(
  buffer: Buffer, mime: string, originalName: string,
): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
  if (!/^image\/(jpeg|png|webp|heic)$/.test(mime)) return { buffer, mime, fileName: originalName };
  try {
    const out = await sharp(buffer).rotate()
      .resize({ width: UPLOAD_IMAGE_MAX_SIDE, height: UPLOAD_IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    // не міняємо файл, якщо «стиснення» його не зменшило (маленький PNG-скан тощо)
    if (out.length >= buffer.length && mime === "image/jpeg") return { buffer, mime, fileName: originalName };
    const fileName = originalName.replace(/\.[a-zA-Z0-9]{1,5}$/, "") + ".jpg";
    return { buffer: out, mime: "image/jpeg", fileName };
  } catch {
    return { buffer, mime, fileName: originalName }; // HEIC/пошкоджене — зберігаємо оригінал
  }
}

// A collision-proof on-disk name that preserves the original extension.
export function makeStoredName(originalName: string): string {
  const ext = path.extname(originalName).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, "");
  return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
}

// Delete a stored file by its relative path (best-effort, never throws).
export function deleteStoredFile(relPath: string | null | undefined): void {
  if (!relPath) return;
  // Guard against path traversal — only allow files inside the uploads root.
  const abs = path.resolve(UPLOADS_ROOT, relPath);
  if (!abs.startsWith(UPLOADS_ROOT)) return;
  fs.promises.rm(abs, { force: true }).catch(() => {});
}
