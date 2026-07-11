// Local-disk storage for uploaded files (worker documents, etc.).
// Files live outside git in `uploads/` at the repo root (persistent across
// deploys; back it up). Served only via authenticated endpoints — never as
// static files, since these are personal documents.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Root of the uploads tree. Defaults to <cwd>/uploads (cwd is the repo root
// under pm2). Override with UPLOADS_DIR for a volume mount.
export const UPLOADS_ROOT = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(process.cwd(), "uploads");

export const WORKER_DOCS_DIR = path.join(UPLOADS_ROOT, "worker-documents");

// Create the upload directories once at startup.
export function ensureUploadDirs(): void {
  fs.mkdirSync(WORKER_DOCS_DIR, { recursive: true });
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
