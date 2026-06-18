// Shared role + capability model (keep in sync with web/src/lib/roles.ts)
export type Role = "owner" | "scheduler" | "driver";
export const ROLES: Role[] = ["owner", "scheduler", "driver"];
export const ROLE_LABEL: Record<Role, string> = {
  owner: "Власник", scheduler: "Графікова", driver: "Водій",
};

// Page/route access (used for nav + route guards)
export const PAGE_ROLES: Record<string, Role[]> = {
  "/": ["owner", "scheduler", "driver"],
  "/schedule": ["owner", "scheduler", "driver"], // driver = read-only
  "/driver-shifts": ["owner", "scheduler", "driver"],
  "/orders": ["owner", "scheduler"],
  "/availability": ["owner", "scheduler"],
  "/reliability": ["owner", "scheduler"],
  "/hours": ["owner", "scheduler"],
  "/absences": ["owner", "scheduler"],
  "/trips": ["owner", "scheduler", "driver"],
  "/reports": ["owner", "scheduler"],
  "/finance": ["owner"],
  "/settings": ["owner", "scheduler"],
  "/workers": ["owner", "scheduler"],
  "/candidates": ["owner", "scheduler"],
  "/broadcast": ["owner", "scheduler"],
  "/drivers": ["owner", "scheduler"],
  "/factories": ["owner", "scheduler"],
  "/admins": ["owner"],
};

// Action capabilities
export const CAPS = {
  manageRoles: ["owner"],
  editSchedule: ["owner", "scheduler"],
  editOrders: ["owner", "scheduler"],
  editFactories: ["owner", "scheduler"],
  editAvailability: ["owner", "scheduler"],
  editWorkers: ["owner", "scheduler"],
  viewAnalytics: ["owner", "scheduler"],
  assignDrivers: ["owner", "scheduler", "driver"],
  live: ["owner", "scheduler", "driver"],
} as const satisfies Record<string, Role[]>;
export type Capability = keyof typeof CAPS;

export function can(role: Role | undefined | null, cap: Capability): boolean {
  return !!role && (CAPS[cap] as readonly Role[]).includes(role);
}
export function canAccessPage(role: Role | undefined | null, path: string): boolean {
  const allowed = PAGE_ROLES[path];
  return !allowed || (!!role && allowed.includes(role));
}
