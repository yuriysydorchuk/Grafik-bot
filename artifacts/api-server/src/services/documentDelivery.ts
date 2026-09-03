// Доставка файла працівнику з профілю: «Надіслати» для документа профілю або
// файла умови (рішення власника 03.09.2026: скачати / друк / вислати на мейл чи
// в бот). Канали: Telegram (бот, файлом) або email (SMTP, як графіки клієнту).
// Best-effort по Telegram, як sendSignLink; email кидає помилку, якщо SMTP не
// налаштований — офіс бачить це в тості й може скачати файл вручну.
import fs from "node:fs";
import path from "node:path";
import { db, workersTable, workerQuestionnairesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UPLOADS_ROOT } from "../lib/uploads";
import { sendEmailWithAttachments } from "./email";
import { logger } from "../lib/logger";

export type DeliveryVia = "telegram" | "email";

export interface DeliveryTargets { telegram: boolean; email: string | null; language: string }

// Куди можемо доставити: Telegram — якщо привʼязаний; email — з анкети працівника.
export async function deliveryTargets(workerId: number): Promise<DeliveryTargets | null> {
  const [w] = await db.select({ telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return null;
  const [q] = await db.select({ email: workerQuestionnairesTable.email }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  return { telegram: !!w.telegramId, email: q?.email?.trim() || null, language: w.language ?? "uk" };
}

export const isEmail = (s: unknown): s is string => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// Файл з uploads/ (шлях відносний, як у worker_documents.file_path / contract_files.*_path).
export function readUploadFile(relPath: string): Buffer | null {
  const abs = path.resolve(UPLOADS_ROOT, relPath);
  if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

export async function deliverFile(opts: {
  workerId: number; via: DeliveryVia; email?: string | null;
  buffer: Buffer; fileName: string; title: string;
}): Promise<{ to: string }> {
  const targets = await deliveryTargets(opts.workerId);
  if (!targets) throw new Error("Працівника не знайдено");
  if (opts.via === "telegram") {
    if (!targets.telegram) throw new Error("Працівник не привʼязаний до Telegram");
    const [w] = await db.select({ telegramId: workersTable.telegramId }).from(workersTable).where(eq(workersTable.id, opts.workerId));
    // lazy import — не тягнути інстанс бота в сервіси/тести, де він не потрібен
    const { bot } = await import("../bot/instance");
    const { t, asLang } = await import("../bot/i18n");
    await bot.telegram.sendDocument(w!.telegramId!, { source: opts.buffer, filename: opts.fileName }, {
      caption: t(asLang(targets.language), "docs.fileFromOffice", { title: opts.title }),
    });
    logger.info({ workerId: opts.workerId, fileName: opts.fileName }, "document delivered via telegram");
    return { to: "telegram" };
  }
  const to = (opts.email ?? targets.email ?? "").trim();
  if (!isEmail(to)) throw new Error("Немає адреси email — впиши адресу вручну");
  await sendEmailWithAttachments(to, opts.title, `W załączeniu: ${opts.title}.\n\nEuro Support`, [{ filename: opts.fileName, content: opts.buffer }]);
  logger.info({ workerId: opts.workerId, fileName: opts.fileName }, "document delivered via email");
  return { to };
}
