import { db } from "@workspace/db";
import { adminsTable, workersTable, driversTable } from "@workspace/db";
import type { Worker, Driver } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import type { Context } from "telegraf";
import { loadRolesCache } from "../lib/auth";
import { hasCap, CAP_KEYS, type Capability, type NotifyType } from "../lib/roles";
import { adminMenu, managementMenu } from "./menus";
import { tb, type Lang } from "./i18n";

// The web-panel role "driver" grants site access only — it must NOT give the
// office/admin experience in the bot. Such people live in the drivers table
// (possibly as head driver), and that row governs their bot functionality.
export async function isAdmin(tid: string): Promise<boolean> {
  return (await getAdmin(tid)) !== undefined;
}

export async function getAdmin(tid: string) {
  const rows = await db.select().from(adminsTable)
    .where(and(eq(adminsTable.telegramId, tid), ne(adminsTable.role, "driver")));
  return rows[0];
}

// Only ACTIVE workers/drivers keep their bot role — a fired worker or deleted
// driver immediately loses their menu/functionality.
export async function getWorker(tid: string): Promise<Worker | undefined> {
  const rows = await db.select().from(workersTable)
    .where(and(eq(workersTable.telegramId, tid), eq(workersTable.isActive, true)));
  return rows[0];
}

export async function getDriver(tid: string): Promise<Driver | undefined> {
  const rows = await db.select().from(driversTable)
    .where(and(eq(driversTable.telegramId, tid), eq(driversTable.isActive, true)));
  return rows[0];
}

// Чи має роль адміна дію-capability (owner — завжди). Ролі кешовані в lib/auth —
// той самий кеш, що й у веб-панелі, тож правки ролей підхоплюються однаково.
export async function adminHasCap(admin: { role: string } | undefined, cap: Capability): Promise<boolean> {
  if (!admin) return false;
  const cache = await loadRolesCache();
  return hasCap(admin.role, cache.get(admin.role)?.caps ?? [], cap);
}

// Чи роль адміна підписана на цей тип бот-сповіщення. На відміну від
// adminHasCap — БЕЗ owner-байпасу: це плаский per-role список, власник теж
// сам вирішує, що отримувати (див. план «Гранулярний вибір сповіщень»).
export async function adminWantsNotify(admin: { role: string } | undefined, type: NotifyType): Promise<boolean> {
  if (!admin) return false;
  const cache = await loadRolesCache();
  return (cache.get(admin.role)?.notify ?? []).includes(type);
}

// Повний набір capability адміна одним зверненням до кешу ролей — база для
// побудови меню (adminMenuFor/managementMenuFor) і requireAdminCap.
export async function adminCapSet(admin: { role: string } | undefined): Promise<Set<Capability>> {
  const set = new Set<Capability>();
  if (!admin) return set;
  const cache = await loadRolesCache();
  const caps = cache.get(admin.role)?.caps ?? [];
  for (const cap of CAP_KEYS) if (hasCap(admin.role, caps, cap)) set.add(cap);
  return set;
}

// Гейт на вхід у дію бота, гранульований за capability (як requireCap на вебі).
// Пускає owner і будь-кого з хоч однією з переданих caps; інакше шле відмову
// й повертає адмінське меню, як зараз уже влаштовано для «📄 Фактура».
export async function requireAdminCap(
  ctx: Pick<Context, "reply">,
  admin: { role: string } | undefined,
  cap: Capability | Capability[],
  lang: Lang = "uk",
): Promise<boolean> {
  if (!admin) return false;
  const caps = Array.isArray(cap) ? cap : [cap];
  for (const c of caps) if (await adminHasCap(admin, c)) return true;
  await ctx.reply(
    tb(lang, "⛔️ Ця дія недоступна для твоєї ролі. Доступ вмикає головний адмін у налаштуваннях ролей."),
    await adminMenuFor(admin, lang),
  );
  return false;
}

// Головне меню офіс-адміна з урахуванням його капабіліті. Використовуй на
// головних входах у меню замість голого adminMenu.
export async function adminMenuFor(admin: { role: string } | undefined, lang: Lang = "uk") {
  const caps = await adminCapSet(admin);
  return adminMenu(lang, {
    invoice: caps.has("invoiceScan"),
    orders: caps.has("editData"),
    orderView: caps.has("editData") || caps.has("viewWorkers"),
    broadcast: caps.has("editData"),
    management: caps.has("editData") || caps.has("viewWorkers") || caps.has("assignDrivers") || caps.has("deleteWorkers"),
  });
}

// Підменю «👥 Управління» з урахуванням капабіліті.
export async function managementMenuFor(admin: { role: string } | undefined, lang: Lang = "uk") {
  const caps = await adminCapSet(admin);
  return managementMenu(lang, {
    editData: caps.has("editData"),
    viewWorkers: caps.has("editData") || caps.has("viewWorkers"),
    assignDrivers: caps.has("editData") || caps.has("assignDrivers"),
    deleteWorkers: caps.has("deleteWorkers"),
  });
}
