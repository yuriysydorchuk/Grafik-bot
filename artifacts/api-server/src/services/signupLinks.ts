// Персональні лінки реєстрації (11.10.2026): рекрутер/офіс-менеджер × фабрика → сталий
// криптотокен ?start=rec<токен>. Бот веде людину тим самим скан-флоу, що й лінк фабрики
// (facs: мова → скан паспорта + анкета на вебі), але профіль отримує workers.signup_link_id —
// «хто привів» для бонусів рекрутерам. Один рядок на пару адмін×фабрика (unique), токен
// можна перевипустити — атрибуція старих реєстрацій лишається на рядку.
import { db, signupLinksTable, adminsTable, factoriesTable, workersTable, type SignupLink } from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { randomInviteCode } from "../lib/invite";

export const signupLinkUrl = (token: string): string => {
  const username = process.env.TELEGRAM_BOT_USERNAME || "";
  return username ? `https://t.me/${username}?start=rec${token}` : `?start=rec${token}`;
};

// Префікс deep-link + base32-токен (randomInviteCode): Telegram зберігає регістр payload,
// але при ручному наборі люди пишуть як завгодно — звіряємо у верхньому регістрі.
export const normalizeSignupToken = (raw: string): string => raw.trim().toUpperCase();

async function uniqueToken(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const c = randomInviteCode();
    if (!(await db.select({ id: signupLinksTable.id }).from(signupLinksTable).where(eq(signupLinksTable.token, c))).length) return c;
  }
  return randomInviteCode(16);
}

// Get-or-create: лінк пари адмін×фабрика сталий — його можна друкувати на QR-плакатах.
export async function getOrCreateSignupLink(adminId: number, factoryId: number): Promise<SignupLink> {
  const find = async () => (await db.select().from(signupLinksTable)
    .where(and(eq(signupLinksTable.adminId, adminId), eq(signupLinksTable.factoryId, factoryId))))[0];
  const existing = await find();
  if (existing) return existing;
  const token = await uniqueToken();
  // паралельний клік з двох пристроїв: unique (admin_id, factory_id) → перечитуємо
  await db.insert(signupLinksTable).values({ adminId, factoryId, token }).onConflictDoNothing();
  return (await find())!;
}

export async function rotateSignupLink(id: number): Promise<SignupLink | undefined> {
  const token = await uniqueToken();
  const [row] = await db.update(signupLinksTable).set({ token, rotatedAt: new Date() }).where(eq(signupLinksTable.id, id)).returning();
  return row;
}

export async function signupLinkById(id: number): Promise<SignupLink | undefined> {
  return (await db.select().from(signupLinksTable).where(eq(signupLinksTable.id, id)))[0];
}

// Deep-link бота: токен → лінк з фабрикою й рекрутером (null = недійсний/невідомий).
// Лінк деактивованого адміна мертвий: людина не має реєструватись «за» тим, кому доступ закрили.
export async function resolveSignupLink(rawToken: string): Promise<{ link: SignupLink; factory: { id: number; name: string }; adminName: string } | null> {
  const token = normalizeSignupToken(rawToken);
  if (!token) return null;
  const [r] = await db.select({ link: signupLinksTable, factoryId: factoriesTable.id, factoryName: factoriesTable.name, adminName: adminsTable.name })
    .from(signupLinksTable)
    .innerJoin(factoriesTable, eq(signupLinksTable.factoryId, factoriesTable.id))
    .innerJoin(adminsTable, eq(signupLinksTable.adminId, adminsTable.id))
    .where(and(eq(signupLinksTable.token, token), isNull(adminsTable.deactivatedAt)));
  if (!r) return null;
  return { link: r.link, factory: { id: r.factoryId, name: r.factoryName }, adminName: r.adminName };
}

export async function signupLinkQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: "png", margin: 1, width: 512, errorCorrectionLevel: "M" });
}

export interface SignupLinkRow {
  id: number; token: string; url: string; factoryId: number; factoryName: string;
  adminId: number; adminName: string; createdAt: Date; rotatedAt: Date | null;
  registered: number; // профілів створено за лінком (усі)
  active: number;     // з них активних зараз
  started: number;    // з них уже з першим робочим днем (база для бонусу рекрутеру)
}

// Список лінків (свої — adminId; усі — для головного/owner) з лічильниками реєстрацій.
export async function listSignupLinks(opts: { adminId?: number } = {}): Promise<SignupLinkRow[]> {
  const rows = await db.select({
    id: signupLinksTable.id, token: signupLinksTable.token, factoryId: signupLinksTable.factoryId, factoryName: factoriesTable.name,
    adminId: signupLinksTable.adminId, adminName: adminsTable.name, createdAt: signupLinksTable.createdAt, rotatedAt: signupLinksTable.rotatedAt,
    registered: sql<number>`(select count(*) from ${workersTable} w where w.signup_link_id = ${signupLinksTable.id})`.mapWith(Number),
    active: sql<number>`(select count(*) from ${workersTable} w where w.signup_link_id = ${signupLinksTable.id} and w.is_active)`.mapWith(Number),
    started: sql<number>`(select count(*) from ${workersTable} w where w.signup_link_id = ${signupLinksTable.id} and w.first_work_date is not null)`.mapWith(Number),
  }).from(signupLinksTable)
    .innerJoin(factoriesTable, eq(signupLinksTable.factoryId, factoriesTable.id))
    .innerJoin(adminsTable, eq(signupLinksTable.adminId, adminsTable.id))
    .where(opts.adminId != null ? eq(signupLinksTable.adminId, opts.adminId) : undefined)
    .orderBy(adminsTable.name, factoriesTable.name);
  return rows.map(r => ({ ...r, url: signupLinkUrl(r.token) }));
}

// Хто зареєструвався за лінком — для бонусів: перший робочий день і поточний статус.
export async function signupLinkWorkers(linkId: number) {
  return db.select({
    id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode,
    factoryId: workersTable.factoryId, factoryName: factoriesTable.name,
    createdAt: workersTable.createdAt, firstWorkDate: workersTable.firstWorkDate, isActive: workersTable.isActive, firedAt: workersTable.firedAt,
  }).from(workersTable)
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .where(eq(workersTable.signupLinkId, linkId))
    .orderBy(desc(workersTable.createdAt));
}

// Для профілю працівника: «Зареєстрований за лінком: <рекрутер> · <фабрика>».
export async function workerSignupInfo(signupLinkId: number | null | undefined): Promise<{ linkId: number; adminId: number; adminName: string; factoryId: number; factoryName: string } | null> {
  if (signupLinkId == null) return null;
  const [r] = await db.select({ linkId: signupLinksTable.id, adminId: adminsTable.id, adminName: adminsTable.name, factoryId: factoriesTable.id, factoryName: factoriesTable.name })
    .from(signupLinksTable)
    .innerJoin(adminsTable, eq(signupLinksTable.adminId, adminsTable.id))
    .innerJoin(factoriesTable, eq(signupLinksTable.factoryId, factoriesTable.id))
    .where(eq(signupLinksTable.id, signupLinkId));
  return r ?? null;
}
