// Thin fetch wrapper — same-origin, cookie session.
export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Requested-With": "grafik", ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    // session expired — bounce to login
    if (!location.pathname.startsWith("/login")) location.href = "/login";
    throw new Error("unauthorized");
  }
  const text = await res.text();
  // проксі може віддати HTML (502/504) — не-JSON не має вибухати SyntaxError-ом
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    // статус і тіло відповіді доступні обробникам (напр. 409 «схожий працівник»)
    const err: any = new Error(data?.error || `Помилка ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: any) => api<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) });
export const put = <T = any>(p: string, body?: any) => api<T>(p, { method: "PUT", body: JSON.stringify(body ?? {}) });
export const patch = <T = any>(p: string, body?: any) => api<T>(p, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const del = <T = any>(p: string) => api<T>(p, { method: "DELETE" });

// Multipart upload — let the browser set the multipart boundary itself, so we
// must omit the JSON Content-Type that `api()` sends by default.
export async function upload<T = any>(p: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${p}`, { method: "POST", credentials: "include", headers: { "X-Requested-With": "grafik" }, body: form });
  if (res.status === 401) {
    if (!location.pathname.startsWith("/login")) location.href = "/login";
    throw new Error("unauthorized");
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `Помилка ${res.status}`);
  return data as T;
}

// ─── Types ─────────────────────────────────────────────────────────────────
export type DayCode = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type ShiftCode = "1" | "2" | "3" | "4" | "5" | "6";

export interface Me { id: number; name: string; username: string; isMain: boolean; role: import("./roles").Role; roleLabel: string; caps: string[]; pages: string[]; lang?: "uk" | "en" | "ru" | null; prefs?: Record<string, unknown> }
export interface RoleDef { id: number; key: string; label: string; isSystem: boolean; pages: string[]; caps: string[]; inUse: number }
export interface AdvanceRequest {
  id: number; workerId: number; name: string | null; code: string | null; factory: string | null;
  factoryId: number | null; factoryFromRequest: boolean; // фабрика ЗАПИТУ (false = фолбек на фабрику профілю)
  city: string; company: string | null; iban: string | null;
  amount: number; comment: string | null; status: "pending" | "approved" | "rejected" | "paid";
  adminNote: string | null; decidedAt: string | null; decidedByName: string | null;
  payoutMonth: string | null; payoutGroup: "15" | "30" | null;
  paidAt: string | null; paidMethod: "transfer" | "cash" | null; paidTxnId: number | null;
  paidByName: string | null; // хто вручну позначив «виплачено» (сайт; бот-кнопка теж пише)
  svodniMonth: string | null; // YYYY-MM сводної, куди перенесено (вкладка «У сводну»)
  createdAt: string;
}
export interface Company { id: number; name: string; workerCount?: number }
export type Gender = "male" | "female";
export interface Position { id: number; name: string; color: string; sortOrder: number; isActive: boolean }
// One requirement line in a factory order: how many workers of a position/gender.
export interface OrderRequirement { positionId: number | null; gender: "any" | Gender; count: number }
export interface DocumentType { id: number; name: string; required: boolean; hasExpiry: boolean; sortOrder: number }
export interface WorkerDocument {
  id: number; workerId: number; docTypeId: number | null; title: string;
  status: string; number: string | null; expiresAt: string | null; fileUrl: string | null; note: string | null;
  fileName: string | null;
}
export interface Worker {
  id: number; fullName: string; workerCode: string | null; telegramId: string | null;
  factoryId: number | null; factoryName: string | null;
  companyId?: number | null; companyName?: string | null;
  positionId?: number | null; positionName?: string | null; positionColor?: string | null;
  gender?: Gender | null; fixedShift?: string | null; selfTransport?: boolean;
  selfTransportSince?: string | null; // «діє з»: дата чинності поточного значення selfTransport
  nationality?: string | null; // ukraine|belarus|africa|latin_america|central_asia|south_asia (lib/nationality.tsx)
  status: string; isActive: boolean; language?: string | null;
  gratyfikantName?: string | null; // точне написання в Gratyfikant nexo (лише для експорту naliczeń)
  pesel?: string | null; // 11 цифр текстом (з картотек nexo; матчинг ліст по PESEL)
  hourlyRate?: number; isStudent?: boolean; under26?: boolean; // owner only
}
export interface Driver {
  id: number; name: string; vehicle: string | null; phone: string | null; telegramId: string | null;
  seats: number | null; inviteCode: string | null; isHeadDriver: boolean; isActive: boolean;
}
export type GenMode = "availability" | "orders" | "all";
export interface FactoryPositionConf { positionId: number; name?: string | null; color?: string | null; rate?: number | null; invoiceRate?: number | null }
export interface Factory {
  id: number; name: string; address: string | null;
  companyId?: number | null; companyName?: string | null;
  shift1Start: string | null; shift2Start: string | null; shift3Start: string | null; clientEmail: string | null;
  shiftCount: number; usesAvailability: boolean;
  genMode: GenMode; usesPositions: boolean; usesGender: boolean;
  usesTransport: boolean; usesScheduling: boolean; showWorkerHours: boolean; showCode: boolean;
  positions: FactoryPositionConf[];
  shifts: { start: string; end: string }[];
  stops?: { name: string; time: string }[];
  invoiceRate?: number | null; // owner only — net PLN/hour billed to factory
}
export type CandidateStage = string; // stage key within the candidate's funnel
export interface Candidate {
  id: number; fullName: string; telegramId: string | null; phone: string | null; email?: string | null;
  funnelId: number | null; stage: CandidateStage; factoryId: number | null; factoryName: string | null;
  referrerWorkerId: number | null; referrerName: string | null;
  assignedAdminId?: number | null; assignedName?: string | null; nextActionAt?: string | null;
  workerId: number | null; workerActive: boolean; workerCode: string | null;
  bonusAmount: number | null; bonusPaid: boolean; notes: string | null; createdAt: string;
  activity?: Activity[];
}
export interface Activity { id: number; kind: string; detail: string | null; adminId: number | null; adminName: string | null; createdAt: string }
export interface Staff { id: number; name: string; role: string }
export interface FunnelStage { key: string; label: string; color: string }
export interface Funnel { id: number; name: string; kind: "referral" | "custom"; stages: FunnelStage[]; count: number }

export interface WeekRow { id: number; weekStart: string; status: string; label: string; entries: number }
export interface ScheduleEntry {
  id: number; day: DayCode; shift: ShiftCode; status: string;
  workerId: number; workerName: string | null; workerCode: string | null;
  positionId?: number | null; gender?: Gender | null; selfTransport?: boolean;
  factoryId: number; factoryName: string | null; pickedUpByName?: string | null;
}
export interface Dashboard {
  counts: { workers: number; workersLinked: number; drivers: number; driversLinked: number; factories: number };
  weeks: { weekStart: string; status: string; label: string }[];
  currentWeek: string; nextWeek: string;
}
export interface AvailRow {
  name: string; workerId: number | null; source: string; factoryId: number | null; factoryName: string | null;
  days: Record<string, string[]>; dayOff?: Record<string, string>;
  filledAt: string | null; // останнє Telegram-подання доступності
  hasLate?: boolean; // є подання ПІСЛЯ затвердження/розсилки тижня фабрики
  history?: { at: string; late?: boolean; pairs: { day: string; shift: string }[] }[]; // батчі подань (лише свіжі тижні, ~2 тижні)
}

export interface SessionRow {
  id: string; adminId: number; adminName: string | null;
  createdAt: string; lastSeenAt: string;
  ip: string | null; device: string | null; geo: string | null;
  revokedAt: string | null; active: boolean; current: boolean;
}
export interface LoginEventRow {
  id: number; adminId: number | null; adminName: string | null; usernameTried: string | null;
  at: string; ip: string | null; device: string | null; geo: string | null;
  event: "success" | "bad_password" | "bad_2fa" | "no_telegram" | "logout";
}

export const DAYS: DayCode[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_UK: Record<DayCode, string> = {
  mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Нд",
};
export const DAY_FULL: Record<DayCode, string> = {
  mon: "Понеділок", tue: "Вівторок", wed: "Середа", thu: "Четвер", fri: "П'ятниця", sat: "Субота", sun: "Неділя",
};
export const SHIFT_UK: Record<ShiftCode, string> = {
  "1": "1 зміна", "2": "2 зміна", "3": "3 зміна", "4": "4 зміна", "5": "5 зміна", "6": "6 зміна",
};
