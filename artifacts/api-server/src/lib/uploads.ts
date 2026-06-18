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
