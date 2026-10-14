// Акаунти profilu zaufanego для робота praca.gov.pl (12.10.2026). Пароль зберігається лише
// шифротекстом (lib/secretBox, ключ PZ_SECRET) і відкривається виключно для робота в цьому
// процесі; API віддає рядок без password_enc. Власник акаунта — адмін, який його додав
// (йому ж бот надсилає запити на SMS-код); головний/owner бачать усі без секретів.
import { db, pzAccountsTable, adminsTable, type PzAccount } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { isSecretBoxReady, openSecret, sealSecret } from "../../lib/secretBox";
import { resetPzProfile } from "./paths";

export type PzAccountPublic = Omit<PzAccount, "passwordEnc"> & { adminName: string | null; hasPassword: true };

const strip = (a: PzAccount, adminName: string | null): PzAccountPublic => {
  const { passwordEnc: _p, ...rest } = a;
  void _p;
  return { ...rest, adminName, hasPassword: true };
};

export const pzReady = (): boolean => isSecretBoxReady();

export async function listPzAccounts(opts: { adminId?: number } = {}): Promise<PzAccountPublic[]> {
  const rows = await db.select({ a: pzAccountsTable, adminName: adminsTable.name }).from(pzAccountsTable)
    .leftJoin(adminsTable, eq(adminsTable.id, pzAccountsTable.adminId))
    .where(opts.adminId != null ? eq(pzAccountsTable.adminId, opts.adminId) : undefined)
    .orderBy(desc(pzAccountsTable.id));
  return rows.map(r => strip(r.a, r.adminName));
}

export async function pzAccountById(id: number): Promise<PzAccount | undefined> {
  if (!Number.isInteger(id)) return undefined;
  return (await db.select().from(pzAccountsTable).where(eq(pzAccountsTable.id, id)))[0];
}

export interface PzAccountInput { label?: string | null; login: string; password?: string; companyIds?: number[]; contextName?: string | null; signerFunction?: string | null; isActive?: boolean }

function cleanIds(v: unknown): number[] {
  return Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
}

export async function createPzAccount(adminId: number, input: PzAccountInput): Promise<PzAccountPublic> {
  if (!isSecretBoxReady()) throw new Error("PZ_SECRET не задано на сервері — збереження паролів вимкнене");
  const login = String(input.login ?? "").trim();
  const password = String(input.password ?? "");
  if (!login) throw new Error("Вкажіть логін profilu zaufanego");
  if (password.length < 4) throw new Error("Вкажіть пароль profilu zaufanego");
  const [row] = await db.insert(pzAccountsTable).values({
    adminId, login, passwordEnc: sealSecret(password),
    label: String(input.label ?? "").trim() || null,
    companyIds: cleanIds(input.companyIds),
    contextName: String(input.contextName ?? "").trim() || null,
    signerFunction: String(input.signerFunction ?? "").trim() || null,
  }).returning();
  const [adm] = await db.select({ name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, adminId));
  return strip(row!, adm?.name ?? null);
}

export async function updatePzAccount(id: number, input: Partial<PzAccountInput>): Promise<void> {
  const patch: Partial<typeof pzAccountsTable.$inferInsert> = { updatedAt: new Date() };
  if (input.label !== undefined) patch.label = String(input.label ?? "").trim() || null;
  let credsChanged = false;
  if (input.login !== undefined) { const l = String(input.login).trim(); if (!l) throw new Error("Логін не може бути порожнім"); patch.login = l; credsChanged = true; }
  if (input.password !== undefined && input.password !== "") {
    if (!isSecretBoxReady()) throw new Error("PZ_SECRET не задано на сервері");
    if (String(input.password).length < 4) throw new Error("Закороткий пароль");
    patch.passwordEnc = sealSecret(String(input.password)); credsChanged = true;
  }
  // зміна логіна/пароля = інша особа: стару сесію порталу (cookies у Chromium-профілі) стираємо
  if (credsChanged) resetPzProfile(id);
  if (input.companyIds !== undefined) patch.companyIds = cleanIds(input.companyIds);
  if (input.contextName !== undefined) patch.contextName = String(input.contextName ?? "").trim() || null;
  if (input.signerFunction !== undefined) patch.signerFunction = String(input.signerFunction ?? "").trim() || null;
  if (input.isActive !== undefined) patch.isActive = !!input.isActive;
  await db.update(pzAccountsTable).set(patch).where(eq(pzAccountsTable.id, id));
}

export async function setPzAccountPoa(id: number, relPath: string | null): Promise<void> {
  await db.update(pzAccountsTable).set({ poaFilePath: relPath, updatedAt: new Date() }).where(eq(pzAccountsTable.id, id));
}

export async function deletePzAccount(id: number): Promise<void> {
  await db.delete(pzAccountsTable).where(eq(pzAccountsTable.id, id));
  resetPzProfile(id);
}

// Лише для робота: відкритий пароль ніколи не виходить за межі процесу.
export function pzCredentials(a: PzAccount): { login: string; password: string } {
  return { login: a.login, password: openSecret(a.passwordEnc) };
}

export async function markPzLogin(id: number, ok: boolean, error: string | null = null): Promise<void> {
  await db.update(pzAccountsTable).set(ok ? { lastLoginAt: new Date(), lastError: null, updatedAt: new Date() } : { lastError: error, updatedAt: new Date() }).where(eq(pzAccountsTable.id, id));
}

// Активний акаунт адміна, що може подавати за фірму (порожній список фірм = будь-яка).
export async function pzAccountFor(adminId: number, companyId: number | null): Promise<PzAccount | undefined> {
  const rows = await db.select().from(pzAccountsTable).where(and(eq(pzAccountsTable.adminId, adminId), eq(pzAccountsTable.isActive, true))).orderBy(desc(pzAccountsTable.id));
  // без fallback на «будь-який»: акаунт з обмеженням по фірмах не має подавати за чужу
  return rows.find(a => companyId == null || a.companyIds.length === 0 || a.companyIds.includes(companyId));
}
