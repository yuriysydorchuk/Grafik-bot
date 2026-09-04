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
export interface Company {
  id: number; name: string; workerCount?: number;
  legalName?: string | null; nip?: string | null;
  krs?: string | null; regon?: string | null;
  street?: string | null; houseNumber?: string | null; postalCode?: string | null; city?: string | null;
  representative?: string | null;
}
export type Gender = "male" | "female";
export interface Position { id: number; name: string; color: string; sortOrder: number; isActive: boolean }
// One requirement line in a factory order: how many workers of a position/gender.
export interface OrderRequirement { positionId: number | null; gender: "any" | Gender; count: number }
export type DocCategory = "identity" | "stay" | "work" | "payroll" | "medical" | "other";
export interface DocumentType {
  id: number; name: string; required: boolean; hasExpiry: boolean; sortOrder: number; icon: string | null;
  // легалізація (02.09.2026): тип = каталог evidence; що документ «дає» — прапорці; code — стабільний ключ сіду (не правиться)
  code: string | null; category: DocCategory; grantsStay: boolean; grantsWork: boolean; requiresEmployerMatch: boolean;
  defaultValidityDays: number | null; renewalLeadDays: number | null; appliesToNationalities: string[] | null;
  isActive: boolean; isSystem: boolean;
}
export type CaseStatus = "to_submit" | "submitted" | "in_progress" | "decision_positive" | "decision_negative" | "withdrawn";
export interface WorkerDocument {
  id: number; workerId: number; docTypeId: number | null; title: string;
  status: string; number: string | null; expiresAt: string | null; fileUrl: string | null; note: string | null;
  fileName: string | null; fileMime: string | null;
  // легалізація: строки/справа/роботодавець/верифікація (PATCH /worker-documents/:id/legal, cap legalization)
  validFrom: string | null; issuedAt: string | null; issuer: string | null; employerCompanyId: number | null;
  caseStatus: CaseStatus | null; submittedAt: string | null; caseNumber: string | null; decisionAt: string | null;
  verifiedBy: number | null; verifiedAt: string | null; reviewNote: string | null;
  source: "office" | "worker_bot" | "ocr" | "import"; replacesDocumentId: number | null;
  requestedAt: string | null; requestedBy: number | null;
  attrs: Record<string, unknown> | null; // типоспецифічні атрибути (lib/documentFields.ts): TRC {laborMarketAccess}
}
export interface LegalizationGlobals { today: string; ukrStatusEnd: string | null; defaultLeadDays: number }
// Мапа «група виплат ↔ старий статус ↔ типи документів» (GET /legalization/status-map, services/legalStatusMap.ts)
export type PayrollGroupCode = "A_cash" | "B_student" | "C_registered" | "N_none";
export interface LegalStatusMap {
  groups: { code: PayrollGroupCode; label: string; money: string }[];
  statuses: { status: string; group: PayrollGroupCode; precedence: number; manualOnly: boolean; note: string; docTypes: { code: string; name: string }[] }[];
  docTypes: { typeCode: string; name: string; inCatalog: boolean; status: string | null; group: PayrollGroupCode; review: boolean; requiresEmployerMatch: boolean; condition: string | null }[];
}
// Результат движка легальності (кеш worker_legality; GET /workers/:id/legality — будь-яка роль)
export type LegalityStatus = "legal" | "pending" | "expiring" | "illegal" | "unknown";
export interface LegalityReason { code: string; axis: "stay" | "work" | "overall"; severity: "info" | "warn" | "block"; params?: Record<string, unknown> }
export interface LegalityAxis { basisDocId: number | null; basisRuleCode: string | null; expiresAt: string | null }
export interface WorkerLegality {
  workerId: number; stay: LegalityStatus; work: LegalityStatus; overall: LegalityStatus;
  reviewRequired: boolean; reasons: LegalityReason[];
  nextExpiryAt: string | null; nextExpiryDocId: number | null; requiredMissing: string[];
  axes: { stay?: LegalityAxis; work?: LegalityAxis } | null;
  obligations: { code: string; dueAt: string; overdue: boolean; satisfied: boolean; params?: Record<string, unknown> }[];
  derivedLegalStatus: string | null; derivedPayrollClass: string | null;
  legacyMappingRequiresReview: boolean; legacyMismatchKind: "none" | "within_class" | "cross_class" | "no_proposal";
  payrollHints: { studentByProfile: boolean; studentCertMissingOrExpired: boolean; notifyHoursWithoutBasis: boolean; hoursExceedNotify: boolean | null; workBasisMissing: boolean } | null;
  computedAt: string;
}
// Зріз умов (contracts) для списку /workers: umowa — останній факторі-пакет, чия фабрика належить
// фірмі працівника; package — сталий пакет (ZUS/PPK/BHP/wnioski). status: approved|sent|viewed|worker_signed|signed
export type ContractBriefStatus = "approved" | "sent" | "viewed" | "worker_signed" | "signed";
export interface WorkerContractsBrief {
  umowa: { id: number; status: ContractBriefStatus; dateTo: string | null; factoryName: string | null; expired: boolean } | null;
  package: { id: number; status: ContractBriefStatus } | null;
}
// Короткий зріз для списку /workers (усім ролям)
export interface WorkerLegalityBrief { overall: LegalityStatus; stay: LegalityStatus; work: LegalityStatus; nextExpiryAt: string | null; reviewRequired: boolean; derivedLegalStatus: string | null; legacyMismatchKind: string | null }
// Рядок дашборду GET /legalization (cap legalization)
export interface LegalizationRow {
  id: number; fullName: string; workerCode: string | null; nationality: string | null; legalStatus: string | null;
  factoryId: number | null; factoryName: string | null; companyId: number | null; companyName: string | null;
  legality: (Pick<WorkerLegality, "stay" | "work" | "overall" | "reviewRequired" | "nextExpiryAt" | "nextExpiryDocId" | "requiredMissing" | "derivedLegalStatus" | "legacyMismatchKind" | "legacyMappingRequiresReview" | "reasons" | "computedAt">) | null;
  stayBasis: { label: string | null; until: string | null; docId: number | null } | null;
  workBasis: { label: string | null; until: string | null; docId: number | null } | null;
  pendingDocs: number;
}
export interface LegalizationDashboard {
  today: string;
  summary: { total: number; legal: number; pending: number; expiring: number; illegal: number; unknown: number; notComputed: number; review: number; pendingDocs: number };
  rows: LegalizationRow[];
}
// Версійоване правило легальності (GET/POST/PATCH /legal-rules)
export interface LegalRule {
  id: number; code: string; kind: "basis_by_nationality" | "requirement" | "obligation" | "precedence" | "global";
  axis: "stay" | "work" | "both" | null; conditions: Record<string, unknown>;
  effectiveFrom: string; effectiveTo: string | null; source: string | null;
  verifiedAt: string | null; verifiedBy: number | null; note: string | null; isActive: boolean; createdBy: number | null; createdAt: string;
}
export interface DocumentAuditEntry { id: number; documentId: number; workerId: number; action: string; changes: { field: string; from?: unknown; to?: unknown }[] | null; adminId: number | null; adminName: string | null; source: string | null; createdAt: string }
export interface Worker {
  id: number; fullName: string; workerCode: string | null; telegramId: string | null;
  factoryId: number | null; factoryName: string | null;
  companyId?: number | null; companyName?: string | null;
  positionId?: number | null; positionName?: string | null; positionColor?: string | null;
  gender?: Gender | null; fixedShift?: string | null; selfTransport?: boolean;
  selfTransportSince?: string | null; // «діє з»: дата чинності поточного значення selfTransport
  nationality?: string | null; // ukraine|belarus|africa|latin_america|central_asia|south_asia (lib/nationality.tsx)
  legalStatus?: string | null; // форма легалізації (lib/legalStatus.ts); null = без форми
  legality?: WorkerLegalityBrief | null; // світлофори за документами (кеш worker_legality; null = ще не рахувалось)
  contracts?: WorkerContractsBrief; // зріз умов з модуля підпису: актуальна umowa на фірму працівника + сталий комплект
  student?: boolean; // похідне: is_student АБО legal_status='student' (усі ролі)
  stud26?: boolean; // похідне: студент І до 26 (вік з birth_date, фолбек under26)
  status: string; isActive: boolean; language?: string | null;
  gratyfikantName?: string | null; // точне написання в Gratyfikant nexo (лише для експорту naliczeń)
  pesel?: string | null; // 11 цифр текстом (з картотек nexo; матчинг ліст по PESEL)
  middleName?: string | null; // необов'язкове; {%Drugie imię%} в Umowa — порожньо не йде в документ
  firstName?: string | null; lastName?: string | null; // структуровані зі сканування паспорта/анкети; {%Imię%}/{%Nazwisko%} в Umowa
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
  requiresSanepid?: boolean; // фабрика вимагає książeczkę sanepidowską → плитка Sanepid у документах працівника
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
