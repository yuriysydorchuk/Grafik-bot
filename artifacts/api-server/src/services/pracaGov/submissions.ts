// Журнал подач робота praca.gov.pl (ua_submissions, 12.10.2026): рядок = стан-машина однієї
// подачі або тесту входу. Робот (robot.ts) пише сюди крок/статус/скріншоти; веб і бот читають.
import fs from "node:fs";
import path from "node:path";
import { db, uaSubmissionsTable, type UaSubmission } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { UPLOADS_ROOT } from "../../lib/uploads";

export const UA_SUBMISSIONS_DIR = path.join(UPLOADS_ROOT, "ua-submissions"); // скріншоти кроків (персональні дані — лише через auth-роут)
export type UaSubmissionStatus = "queued" | "running" | "awaiting_code" | "review" | "signing" | "submitted" | "done" | "failed" | "cancelled";
export const OPEN_SUBMISSION_STATUSES: UaSubmissionStatus[] = ["queued", "running", "awaiting_code", "review", "signing"];

export async function submissionById(id: number): Promise<UaSubmission | undefined> {
  if (!Number.isInteger(id)) return undefined;
  return (await db.select().from(uaSubmissionsTable).where(eq(uaSubmissionsTable.id, id)))[0];
}

export async function createSubmission(v: { kind: "login_test" | "submission"; accountId: number; adminId: number; workerId?: number | null; companyId?: number | null; taskId?: number | null; payload?: unknown }): Promise<UaSubmission> {
  const [row] = await db.insert(uaSubmissionsTable).values({
    kind: v.kind, accountId: v.accountId, adminId: v.adminId, workerId: v.workerId ?? null, companyId: v.companyId ?? null, taskId: v.taskId ?? null,
    payload: v.payload ?? null, status: "queued", step: "у черзі",
  }).returning();
  return row!;
}

export async function setSubmission(id: number, patch: { status?: UaSubmissionStatus; step?: string | null; error?: string | null; confirmationNo?: string | null; documentId?: number | null; previewFile?: string | null; finished?: boolean }): Promise<void> {
  const set: Partial<typeof uaSubmissionsTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.step !== undefined) set.step = patch.step;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.confirmationNo !== undefined) set.confirmationNo = patch.confirmationNo;
  if (patch.documentId !== undefined) set.documentId = patch.documentId;
  if (patch.previewFile !== undefined) set.previewFile = patch.previewFile;
  if (patch.finished) set.finishedAt = new Date();
  await db.update(uaSubmissionsTable).set(set).where(eq(uaSubmissionsTable.id, id));
}

// Скріншот кроку → файл під UPLOADS_ROOT/ua-submissions/<id>/NN-<slug>.png + запис у рядок.
export async function addScreenshot(id: number, slug: string, png: Uint8Array): Promise<string> {
  const dir = path.join(UA_SUBMISSIONS_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const n = fs.readdirSync(dir).filter(f => f.endsWith(".png")).length + 1;
  const name = `${String(n).padStart(2, "0")}-${slug.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40)}.png`;
  fs.writeFileSync(path.join(dir, name), png);
  const rel = path.posix.join("ua-submissions", String(id), name);
  await db.update(uaSubmissionsTable).set({ screenshots: sql`coalesce(screenshots, '[]'::jsonb) || ${JSON.stringify([rel])}::jsonb`, updatedAt: new Date() }).where(eq(uaSubmissionsTable.id, id));
  return rel;
}

export function previewPath(sub: UaSubmission): { abs: string; mime: string } | null {
  if (!sub.previewFile) return null;
  const abs = path.resolve(UPLOADS_ROOT, sub.previewFile);
  if (!abs.startsWith(UA_SUBMISSIONS_DIR + path.sep) || !fs.existsSync(abs)) return null;
  return { abs, mime: abs.endsWith(".pdf") ? "application/pdf" : "image/png" };
}

export function screenshotPath(sub: UaSubmission, idx: number): string | null {
  const rel = sub.screenshots?.[idx];
  if (!rel) return null;
  const abs = path.resolve(UPLOADS_ROOT, rel);
  return abs.startsWith(UA_SUBMISSIONS_DIR + path.sep) && fs.existsSync(abs) ? abs : null;
}

export async function openSubmissionsForAccount(accountId: number): Promise<UaSubmission[]> {
  return db.select().from(uaSubmissionsTable).where(and(eq(uaSubmissionsTable.accountId, accountId), inArray(uaSubmissionsTable.status, OPEN_SUBMISSION_STATUSES))).orderBy(desc(uaSubmissionsTable.id));
}

export async function recentSubmissions(opts: { adminId?: number; accountId?: number; limit?: number } = {}): Promise<UaSubmission[]> {
  const conds = [];
  if (opts.adminId != null) conds.push(eq(uaSubmissionsTable.adminId, opts.adminId));
  if (opts.accountId != null) conds.push(eq(uaSubmissionsTable.accountId, opts.accountId));
  return db.select().from(uaSubmissionsTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(uaSubmissionsTable.id)).limit(opts.limit ?? 20);
}

// Процес стартував заново — усе, що було «в роботі», браузера вже не має.
export async function failStaleSubmissions(): Promise<number> {
  const rows = await db.update(uaSubmissionsTable)
    .set({ status: "failed", error: "Сервер перезапущено під час подачі — запустіть ще раз", finishedAt: new Date(), updatedAt: new Date() })
    .where(inArray(uaSubmissionsTable.status, OPEN_SUBMISSION_STATUSES)).returning({ id: uaSubmissionsTable.id });
  return rows.length;
}
