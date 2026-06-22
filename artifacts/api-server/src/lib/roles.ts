// Shared role + capability MODEL. Role MEMBERSHIP lives in the DB (roles table);
// this file defines the fixed CATALOGUES (capabilities + pages) and pure helpers.
// Keep the capability/page keys in sync with web/src/lib/roles.ts.

export type Role = string;        // role key stored in admins.role (owner | scheduler | driver | custom…)
export const OWNER = "owner";     // immutable superuser — always full access, never lockable

// Action capabilities a role can be granted (the "what can it do" catalogue).
export const CAP_KEYS = ["editData", "viewFinance", "assignDrivers", "deleteWorkers"] as const;
export type Capability = (typeof CAP_KEYS)[number];
export const CAP_LABEL: Record<Capability, string> = {
  editData: "Редагувати дані (графіки, замовлення, фабрики, працівники)",
  viewFinance: "Фінанси (ставки, рахунки)",
  assignDrivers: "Водійські дії (борд, призначення, посадка)",
  deleteWorkers: "Видаляти працівників назавжди",
};

// Nav/route paths a role can be granted access to (the "what can it see" catalogue).
export const PAGE_KEYS = [
  "/", "/schedule", "/driver-shifts", "/orders", "/availability", "/reliability",
  "/hours", "/absences", "/advances", "/trips", "/reports", "/finance", "/settings",
  "/workers", "/recruitment", "/broadcast", "/drivers", "/factories", "/admins",
] as const;

// owner is always allowed; otherwise check the resolved capability set.
export function hasCap(role: Role | null | undefined, caps: string[] | null | undefined, cap: Capability): boolean {
  if (role === OWNER) return true;
  return !!caps && caps.includes(cap);
}
