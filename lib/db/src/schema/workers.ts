import {
  pgTable, serial, text, integer, timestamp, boolean, date, pgEnum, jsonb, real, uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const shiftEnum = pgEnum("shift", ["1", "2", "3", "4", "5", "6"]);
export const dayEnum = pgEnum("day_of_week", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const scheduleStatusEnum = pgEnum("schedule_status", ["draft", "approved"]);
export const entryStatusEnum = pgEnum("entry_status", ["scheduled", "present", "absent"]);

// Our agencies/companies that workers are employed through to staff client factories
// (e.g. ES, ESO, Klinex). Factories and workers each belong to one company.
// Also the legal entities of the economics module: each has its own NIP and (later)
// KSeF credentials; finance documents/payments are booked per company.
export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  legalName: text("legal_name"),  // full registered name (e.g. "Eurosupport Group Sp. z o.o.")
  nip: text("nip"),               // Polish tax id (10 digits) — used for KSeF auth & invoice matching
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Admin-managed catalogue of work positions/roles a worker can hold
// (e.g. Pracownik produkcji, Wózkowy, Brygadista, Lider, Kontrola jakości).
// Editable because new roles can appear over time.
export const positionsTable = pgTable("positions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull().default("slate"), // tailwind color key for badges/grouping
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Which positions a factory uses + the pay rate (gross PLN/hour) for that position there.
export const factoryPositionsTable = pgTable("factory_positions", {
  id: serial("id").primaryKey(),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id, { onDelete: "cascade" }),
  positionId: integer("position_id").notNull().references(() => positionsTable.id),
  rate: real("rate"), // gross PLN/hour we pay a worker in this position here (null = use worker's own rate)
  invoiceRate: real("invoice_rate"), // net PLN/hour we bill the client for this position (null = factory default invoiceRate)
  sortOrder: integer("sort_order").notNull().default(0),
});

export const workersTable = pgTable("workers", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  telegramId: text("telegram_id").unique(),
  workerCode: text("worker_code").unique(), // public sequential id (shown in lists/reports) — NOT a binding secret
  inviteCode: text("invite_code").unique(), // unguessable token for ?start=emp<code> Telegram binding
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  companyId: integer("company_id").references(() => companiesTable.id), // our agency the worker is under
  positionId: integer("position_id").references(() => positionsTable.id), // work role (nullable = generic production)
  gender: text("gender"), // male | female | null (needed where factory orders split by gender)
  fixedShift: text("fixed_shift"), // "1".."6" — worker bound to this shift (for manual "give everyone" factories); null = flexible
  status: text("status").notNull().default("active"), // active | fired
  isActive: boolean("is_active").notNull().default(true),
  selfTransport: boolean("self_transport").notNull().default(false), // gets to work on their own → hidden from drivers, presence marked manually by the scheduler
  language: text("language"), // bot UI language: uk | en | es | ru | pl (null = not chosen yet)
  // Payroll (umowa zlecenie) — used by the finance module
  hourlyRate: real("hourly_rate").notNull().default(31.5), // gross PLN/hour
  isStudent: boolean("is_student").notNull().default(false),
  under26: boolean("under_26").notNull().default(false),
  firedAt: timestamp("fired_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const driversTable = pgTable("drivers", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),
  username: text("username"), // @username captured from Telegram, for t.me/<username> links
  name: text("name").notNull(),
  phone: text("phone"),
  vehicle: text("vehicle"),
  seats: integer("seats"), // passenger capacity — used by the pickup-gap detector (null = unknown)
  inviteCode: text("invite_code").unique(), // for ?start=drv<code> invite links
  isHeadDriver: boolean("is_head_driver").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  language: text("language"), // uk | en | ru (null = not chosen, defaults to uk)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Fleet vehicles (managed by the head driver in the bot). Drivers pick one when
// starting a workday; the plate shows up in the mileage report.
export const vehiclesTable = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  plate: text("plate").notNull(),        // registration number, e.g. "WX 12345"
  brandModel: text("brand_model"),       // e.g. "Opel Vivaro"
  seats: integer("seats"),               // passenger capacity (null = unknown)
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const factoriesTable = pgTable("factories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  companyId: integer("company_id").references(() => companiesTable.id), // which of our agencies staffs this factory
  address: text("address"),
  shift1Start: text("shift1_start"), // legacy (start only) — superseded by `shifts`
  shift2Start: text("shift2_start"),
  shift3Start: text("shift3_start"),
  // Per-shift start+end times, index 0 = shift 1. Supports 1–6 shifts.
  shifts: jsonb("shifts").$type<{ start: string; end: string }[]>().notNull().default([]),
  // Pickup stops where drivers collect workers: name + time they must be there.
  stops: jsonb("stops").$type<{ name: string; time: string }[]>().notNull().default([]),
  shiftCount: integer("shift_count").notNull().default(3), // how many shifts are active (1–6)
  usesAvailability: boolean("uses_availability").notNull().default(true), // kept in sync = (genMode === 'availability'); legacy reads
  // Schedule generation mode:
  //  • availability — workers self-report availability; generate by orders + availability
  //  • orders       — admin/manual; generate all active workers by orders
  //  • all          — release EVERYONE (no orders); bound→fixed shift, rest balanced across shifts
  genMode: text("gen_mode").notNull().default("availability"),
  usesPositions: boolean("uses_positions").notNull().default(false), // does this factory differentiate work positions?
  usesGender: boolean("uses_gender").notNull().default(false),        // does this factory split orders by gender?
  usesTransport: boolean("uses_transport").notNull().default(true),   // agency provides pickup → show stops/pickup to workers
  showWorkerHours: boolean("show_worker_hours").notNull().default(true), // show the "My hours" button to workers
  showCode: boolean("show_code").notNull().default(true),             // show the worker-code column in the Excel schedule
  clientEmail: text("client_email"), // where to send approved schedule
  invoiceRate: real("invoice_rate"), // net PLN/hour billed to this factory (finance module)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One requirement line within an order: how many workers of a given position+gender.
// positionId null = any/generic; gender "any" = no gender split.
export type OrderRequirement = { positionId: number | null; gender: "any" | "male" | "female"; count: number };
export const factoryOrdersTable = pgTable("factory_orders", {
  id: serial("id").primaryKey(),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  weekStart: date("week_start").notNull(),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  workersNeeded: integer("workers_needed").notNull().default(0), // total = sum of requirement counts (kept in sync)
  // Optional breakdown by position/gender. Empty = plain "workersNeeded of anyone".
  requirements: jsonb("requirements").$type<OrderRequirement[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const availabilityTable = pgTable("availability", {
  id: serial("id").primaryKey(),
  fullNameRaw: text("full_name_raw").notNull(),
  workerId: integer("worker_id").references(() => workersTable.id), // resolved worker (nullable for unmatched sheet rows)
  source: text("source").notNull().default("sheets"), // "sheets" | "telegram"
  weekStart: date("week_start").notNull(),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  submittedAt: timestamp("submitted_at").notNull(),
});

// Persisted conversation state (survives bot restarts)
export const userStatesTable = pgTable("user_states", {
  telegramId: text("telegram_id").primaryKey(),
  action: text("action").notNull(),
  data: jsonb("data").notNull().default({}),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scheduleWeeksTable = pgTable("schedule_weeks", {
  id: serial("id").primaryKey(),
  weekStart: date("week_start").notNull(),
  status: scheduleStatusEnum("status").notNull().default("draft"),
  driveFileId: text("drive_file_id"), // Google Drive Excel file ID
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
});

export const scheduleEntriesTable = pgTable("schedule_entries", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  status: entryStatusEnum("status").notNull().default("scheduled"),
  absenceReason: text("absence_reason"),
  pickedUpBy: integer("picked_up_by").references(() => driversTable.id), // driver who boarded this worker
  hoursOverride: real("hours_override"), // manual hours for this shift (overrides computed shift duration)
  sentAt: timestamp("sent_at"), // when this entry was sent to the worker — they only see sent entries
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Per-factory approval of a week's schedule (approval is factory-scoped, not week-wide)
export const scheduleApprovalsTable = pgTable("schedule_approvals", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  approvedAt: timestamp("approved_at").notNull().defaultNow(),
});

export const driverShiftAssignmentsTable = pgTable("driver_shift_assignments", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  driverId: integer("driver_id").notNull().references(() => driversTable.id),
  // delivery = завозить людей НА зміну (default, historical rows are deliveries);
  // pickup = «Забрати зі зміни» — waits at the factory at the END of this shift.
  kind: text("kind").notNull().default("delivery"), // delivery | pickup
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A whole factory shift (day+shift cell) cancelled by the scheduler. Entries stay
// "scheduled" (so reliability ignores them); driver assignments for the cell are
// deleted on cancel; bot boarding & pre-shift pushes skip cancelled cells.
export const shiftCancellationsTable = pgTable("shift_cancellations", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  cancelledBy: text("cancelled_by"), // admin name (informational)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const adminsTable = pgTable("admins", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),  // nullable: set when an invited user joins the bot
  name: text("name").notNull(),
  username: text("username").unique(),       // web login
  passwordHash: text("password_hash"),       // scrypt hash for web login
  role: text("role").notNull().default("owner"), // owner | scheduler | driver
  isMain: boolean("is_main").notNull().default(false), // the one immutable head admin (only this account manages roles)
  tokenVersion: integer("token_version").notNull().default(0), // bumped on logout / password change → invalidates all older session tokens
  inviteCode: text("invite_code").unique(),  // for ?start=adm<code> invite links
  language: text("language"), // uk | en (null = not chosen, defaults to uk)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Web-panel access roles. `key` is what admins.role stores. `owner` is the immutable
// superuser (always full access in code). `pages`/`caps` are the configurable access
// sets, chosen from code-defined catalogues (lib/roles.ts). Managed only by is_main.
export const rolesTable = pgTable("roles", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),               // slug stored in admins.role
  label: text("label").notNull(),
  isSystem: boolean("is_system").notNull().default(false), // owner/scheduler/driver — not deletable
  pages: jsonb("pages").$type<string[]>().notNull().default([]),  // allowed page paths
  caps: jsonb("caps").$type<string[]>().notNull().default([]),    // allowed capability keys
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// On-site notification center (no-show / shift cancellation), shown via the header bell
export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),              // no_show | cancellation
  title: text("title").notNull(),
  body: text("body"),
  audience: text("audience").notNull(),      // scheduler | driver | both
  readBy: jsonb("read_by").$type<number[]>().notNull().default([]), // admin ids who read it
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Worker self-reports absence: for a concrete assigned shift (shift set) or a whole
// day off (shift NULL — requested before the schedule was made, e.g. from filled
// availability or just a calendar day). Scheduler approves/rejects both kinds.
export const absenceRequestsTable = pgTable("absence_requests", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  weekStart: date("week_start").notNull(),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift"),                            // NULL = whole day off
  reason: text("reason"),
  status: text("status").notNull().default("pending"), // pending | substituted | rejected | accepted
  substituteWorkerId: integer("substitute_worker_id").references(() => workersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Driver trip tracking (pickup start / factory arrival)
export const driverTripsTable = pgTable("driver_trips", {
  id: serial("id").primaryKey(),
  driverId: integer("driver_id").notNull().references(() => driversTable.id),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  tripDate: date("trip_date").notNull(),
  pickupStartedAt: timestamp("pickup_started_at"),
  arrivedFactoryAt: timestamp("arrived_factory_at"),
  lateToPickup: boolean("late_to_pickup").default(false),
  lateToFactory: boolean("late_to_factory").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Driver working day with odometer readings: opened when the driver leaves the
// base/home ("Почати зміну", start odometer) and closed on return ("Закінчити
// зміну", end odometer). Feeds the web "Звіт по пробігу" (mileage report);
// per-shift km = odometer_end − odometer_start (computed, not stored).
export const driverWorkdaysTable = pgTable("driver_workdays", {
  id: serial("id").primaryKey(),
  driverId: integer("driver_id").notNull().references(() => driversTable.id),
  workDate: date("work_date").notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  odometerStart: integer("odometer_start").notNull(), // km
  vehicleId: integer("vehicle_id").references(() => vehiclesTable.id), // null = skipped (no fleet yet)
  endedAt: timestamp("ended_at"),
  odometerEnd: integer("odometer_end"),               // km
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Workers driver added who weren't in the original schedule
export const unplannedWorkersTable = pgTable("unplanned_workers", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  driverId: integer("driver_id").notNull().references(() => driversTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  workerName: text("worker_name").notNull(),
  workerId: integer("worker_id").references(() => workersTable.id),
  // Substitution: this person came instead of a scheduled worker (the replaced
  // worker's entry goes absent with reason "заміна", which reliability counts
  // as cancelled, not a no-show).
  replacesWorkerId: integer("replaces_worker_id").references(() => workersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Recruitment funnels (pipelines). The built-in "referral" funnel keeps bonus/referral
// mechanics; admins can also create custom funnels with their own stages.
export type FunnelStage = { key: string; label: string; color: string };
export const funnelsTable = pgTable("funnels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("custom"), // referral (built-in) | custom
  stages: jsonb("stages").$type<FunnelStage[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Referral program: candidates invited by a worker. Move through recruitment stages,
// then convert to an active worker; the referrer earns a bonus once paid.
export const candidatesTable = pgTable("candidates", {
  id: serial("id").primaryKey(),
  funnelId: integer("funnel_id").references(() => funnelsTable.id), // which recruitment funnel
  referrerWorkerId: integer("referrer_worker_id").references(() => workersTable.id), // who invited (null = added by admin)
  fullName: text("full_name").notNull(),
  telegramId: text("telegram_id"),   // the invited person's Telegram (captured at signup)
  phone: text("phone"),
  factoryId: integer("factory_id").references(() => factoriesTable.id), // intended factory
  stage: text("stage").notNull().default("new"), // stage key within the funnel
  workerId: integer("worker_id").references(() => workersTable.id), // set once converted to an active worker
  bonusAmount: real("bonus_amount"),
  bonusPaid: boolean("bonus_paid").notNull().default(false),
  notes: text("notes"),
  assignedAdminId: integer("assigned_admin_id").references(() => adminsTable.id), // recruiter handling this candidate
  nextActionAt: timestamp("next_action_at"), // scheduled follow-up
  email: text("email"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// CRM activity log for a candidate: who did what and when.
export const candidateActivityTable = pgTable("candidate_activity", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull().references(() => candidatesTable.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => adminsTable.id), // who performed it (null = system)
  kind: text("kind").notNull(), // created | stage | assigned | note | call | message | meeting | converted | bonus | updated | funnel
  detail: text("detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Admin-managed catalogue of document types every worker should have
// (editable so it can track legislation changes).
export const documentTypesTable = pgTable("document_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  required: boolean("required").notNull().default(true),
  hasExpiry: boolean("has_expiry").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A document record attached to a worker (optionally linked to a catalogue type).
export const workerDocumentsTable = pgTable("worker_documents", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  docTypeId: integer("doc_type_id").references(() => documentTypesTable.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("present"), // present | missing | expired | pending
  number: text("number"),
  expiresAt: date("expires_at"),
  fileUrl: text("file_url"),               // external link (e.g. Google Drive)
  filePath: text("file_path"),             // uploaded file: relative path on disk
  fileName: text("file_name"),             // uploaded file: original name (download)
  fileMime: text("file_mime"),             // uploaded file: MIME type
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Worker-reported corrections to the bot's (approximate) hours/shifts calc.
// `items` holds the structured proposed changes the worker flagged in the bot.
export type HoursDisputeItem = {
  kind: "wrong" | "remove" | "add";
  entryId?: number;          // for wrong/remove (existing present shift)
  date?: string;             // YYYY-MM-DD
  shift?: string;            // "1".."6"
  factoryId?: number | null;
  factoryName?: string | null;
  applied?: boolean;
};
export const hoursDisputesTable = pgTable("hours_disputes", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  month: text("month"),                                   // "YYYY-MM" the report concerns
  message: text("message"),                               // optional free comment
  items: jsonb("items").$type<HoursDisputeItem[]>().notNull().default([]),
  photoFileId: text("photo_file_id"),
  status: text("status").notNull().default("new"),        // new | resolved
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// Salary-advance requests: a worker asks for an advance via the bot; office staff
// review on the web (approve/reject) and mark paid. The worker sees the status.
export const advanceRequestsTable = pgTable("advance_requests", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  amount: real("amount").notNull(),                       // requested amount (PLN)
  comment: text("comment"),                               // worker's optional note
  status: text("status").notNull().default("pending"),   // pending | approved | rejected | paid
  adminNote: text("admin_note"),                          // optional note on the decision
  decidedBy: integer("decided_by").references(() => adminsTable.id),
  decidedAt: timestamp("decided_at"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Monthly worker report: the worker submits a photo of their report AND types their
// total hours for the month (1–400). One record per worker+month+factory (a worker
// transferred mid-month files one report per factory; re-submit for the same factory upserts).
// Surfaced in the Hours module ("години з рапорту"); missing record = not submitted yet.
export const monthlyReportsTable = pgTable("monthly_reports", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  month: text("month").notNull(),                          // "YYYY-MM"
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  hoursReported: real("hours_reported").notNull(),         // worker-entered monthly total
  photoLink: text("photo_link"),                           // Google Drive link to the report photo
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("monthly_reports_worker_month_factory_uniq").on(t.workerId, t.month, t.factoryId),
  // Legacy/manual rows without a factory: still at most one per worker+month.
  uniqueIndex("monthly_reports_worker_month_nofactory_uniq").on(t.workerId, t.month).where(sql`${t.factoryId} IS NULL`),
]);

// Tracks messages the bot exchanges in private chats so it can bulk-delete recent
// ones (Telegram only allows deleting messages < 48h old). Pruned on clear.
export const botMessagesTable = pgTable("bot_messages", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),   // = worker/user Telegram id
  messageId: integer("message_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Key-value settings store (Drive folder IDs, etc.)
export const settingsTable = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Bank statements (raw MT940 lines) ────────────────────────────────────────
// Faithful, one row per statement transaction, parsed from the monthly Drive uploads
// (one folder per legal entity). This is the clean foundation of the finance rework;
// economics (income/costs/P&L) is layered on top of it separately.
export const bankTransactionsTable = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id), // matched from the entity subfolder (null = unmatched)
  entityFolder: text("entity_folder"),   // raw subfolder name, for traceability
  account: text("account"),              // :25: account id / IBAN
  statementNo: text("statement_no"),     // :28C:
  fileName: text("file_name"),           // source Drive file
  valueDate: date("value_date").notNull(),
  bookingDate: date("booking_date"),
  direction: text("direction").notNull(),// "in" (credit) | "out" (debit)
  amount: real("amount").notNull(),      // positive magnitude
  currency: text("currency").notNull().default("PLN"),
  counterparty: text("counterparty"),    // ^32/^33 name
  counterpartyAccount: text("counterparty_account"), // ^38 IBAN
  title: text("title"),                  // ^20–^29 remittance / merchant
  txType: text("tx_type"),               // ^00 description + transaction code
  bankRef: text("bank_ref"),             // reference after //
  manualCategory: text("manual_category"), // owner's override: expense-category key or owner_roman/tetiana/yuriy (null = auto)
  dedupHash: text("dedup_hash").notNull(),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("bank_transactions_dedup_uniq").on(t.dedupHash),
]);

// One row per parsed statement, holding the opening/closing balances (:60F:/:62F:).
// Used to show the account balance at any point in time (sum of each account's latest
// closing on or before a date).
export const bankStatementsTable = pgTable("bank_statements", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id),
  account: text("account"),
  statementNo: text("statement_no"),
  fileName: text("file_name"),
  openingDate: date("opening_date"),
  openingBalance: real("opening_balance"),
  closingDate: date("closing_date"),
  closingBalance: real("closing_balance"),
  closingDerived: boolean("closing_derived").notNull().default(false), // :62F: had no amount → computed (chain-corrected after import)
  dedupHash: text("dedup_hash").notNull(),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("bank_statements_dedup_uniq").on(t.dedupHash),
]);

// Office cash box (сейф) ledger, synced from the "STAN KASY" Google Sheet the office
// maintains (one tab per month+entity). kind: opening (stan na początek) | in (знято
// з карти в касу) | out (витрачено готівкою). Re-synced per tab (wipe & insert).
export const cashEntriesTable = pgTable("cash_entries", {
  id: serial("id").primaryKey(),
  box: text("box").notNull().default("office"), // office | yuriy | tetiana — which physical safe
  companyId: integer("company_id").references(() => companiesTable.id), // NULL for owner safes (company cash, not firm-specific)
  periodMonth: text("period_month").notNull(), // "YYYY-MM" from the tab name
  entryDate: date("entry_date"),               // may be missing in the sheet
  kind: text("kind").notNull(),                // opening | in | out
  amount: real("amount").notNull(),
  description: text("description"),
  note: text("note"),
  tabName: text("tab_name").notNull(),         // source sheet tab, for traceability
  sortIdx: integer("sort_idx").notNull().default(0), // original row order within the tab
  transferGroup: text("transfer_group"),       // links the two legs of a box↔box transfer (internal move, cancels out in totals)
  manualCategory: text("manual_category"),     // override for the auto text-based category of an outflow
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

// Counterparty → category rules: re-categorize all (past and future) transactions
// of a counterparty at once. Never applied to owner-payout transactions.
export const counterpartyRulesTable = pgTable("counterparty_rules", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull(),          // uppercase substring matched against counterparty
  category: text("category").notNull(),        // expense category key
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Receivables / payables («Належності»): who owes us and what we owe, per firm.
// Manual for now; invoice sync and KSeF will feed this later.
export const obligationsTable = pgTable("obligations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id),
  direction: text("direction").notNull(),      // receivable (нам винні) | payable (ми винні)
  counterparty: text("counterparty").notNull(),
  description: text("description"),
  amount: real("amount").notNull(),
  dueDate: date("due_date"),
  arisenDate: date("arisen_date").notNull().defaultNow(), // when the debt economically arose (for month-end positions)
  status: text("status").notNull().default("open"), // open | settled
  settledAt: date("settled_at"),
  note: text("note"),
  source: text("source").notNull().default("manual"), // manual | invoices | ksef
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Cost invoices («Фактури») — mirror of the three Faktury Kosztowe sheets
// (ES / ESO / Klinex), one row per invoice. Unpaid ones feed the net position.
export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id),
  periodMonth: text("period_month").notNull(), // "YYYY-MM" from the tab name
  docType: text("doc_type"),                   // PROFORMA | FAKTURA | null (col A)
  issueDate: date("issue_date"),
  number: text("number"),
  amount: real("amount").notNull(),
  statusRaw: text("status_raw"),               // sheet text: Przelew / Nie oplacona / …
  unpaid: boolean("unpaid").notNull().default(false), // derived: status ~ nie opłacona
  dueDate: date("due_date"),
  counterparty: text("counterparty"),
  category: text("category"),                  // their own category text (Hostele, Inne, …)
  paidDate: date("paid_date"),
  // panel-side overrides — OUR metadata, carried over across sheet re-syncs
  manualStatus: text("manual_status"),         // paid | unpaid | NULL (= as in the sheet)
  manualPaidDate: date("manual_paid_date"),
  manualCategory: text("manual_category"),
  tabName: text("tab_name").notNull(),         // "{company}:{MM.YYYY}" for sheet rows, "manual" for panel rows
  sortIdx: integer("sort_idx").notNull().default(0),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

// P&L accrual lines («P&L», /pnl): revenue/cogs per client + fixed costs per month.
// History imported from the owner's financial-report workbook; new months arrive
// from KSeF (revenue), payroll summaries (cogs) and manual entry (VAT/ZUS).
export const pnlEntriesTable = pgTable("pnl_entries", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // "YYYY-MM"
  section: text("section").notNull(),          // revenue | cogs | fixed
  label: text("label").notNull(),              // client name or fixed-cost line
  amount: real("amount").notNull(),            // revenue: netto (без VAT); cogs: повна вартість ЗП (брутто + податки)
  amountGross: real("amount_gross"),           // revenue only: brutto фактур (з VAT)
  segment: text("segment").notNull().default("main"), // main | cleaning (wspólnoty — окремий під-бізнес)
  source: text("source").notNull().default("manual"), // manual | import | ksef | payroll
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Payroll summaries («Зведені ЗП») — one workbook per month per region
// (e.g. «05.2026 Люблін Сводна»). Registry of source spreadsheets + parsed
// per-factory aggregates, the ZUS/cash split rows and office payroll rows.
export const payrollSourcesTable = pgTable("payroll_sources", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // "YYYY-MM" from the workbook title
  region: text("region").notNull(),            // місто: Люблін / Познань / Лодзь
  firm: text("firm"),                          // ES | ESO | Klinex — коли весь файл однієї фірми (Лодзь)
  spreadsheetId: text("spreadsheet_id").notNull().unique(),
  kind: text("kind").notNull().default("gsheet"), // gsheet | xlsx (Office file → read via temp conversion)
  title: text("title"),
  lastSyncAt: timestamp("last_sync_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Drive folders with payroll workbooks: scanned on every sync, new monthly
// workbooks («07.2026 Люблін Сводна» …) are registered automatically.
export const payrollFoldersTable = pgTable("payroll_folders", {
  id: serial("id").primaryKey(),
  folderId: text("folder_id").notNull().unique(),
  title: text("title"),
  lastSyncAt: timestamp("last_sync_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per factory per month: GODZIN MIESIĘCZNIE aggregates + what the
// factory tab itself reveals (declared brutto/netto vs cash on the side).
export const payrollFactoryMonthsTable = pgTable("payroll_factory_months", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull().references(() => payrollSourcesTable.id),
  periodMonth: text("period_month").notNull(),
  region: text("region").notNull(),
  factory: text("factory").notNull(),          // row label in GODZIN MIESIĘCZNIE
  firm: text("firm"),                          // ES | ESO | Klinex (attribution per factory)
  tabName: text("tab_name"),                   // matched per-factory tab, if found
  // GODZIN MIESIĘCZNIE columns
  hours: real("hours"),
  doZaplaty: real("do_zaplaty"),               // netto to pay out, full month
  zaliczki: real("zaliczki"),
  zaliczkaBd: real("zaliczka_bd"),
  premia: real("premia"),
  odziez: real("odziez"),
  hostel: real("hostel"),
  dojazd: real("dojazd"),
  kary: real("kary"),
  workers: integer("workers"),
  students: integer("students"),
  over26: integer("over26"),
  // main payroll table of the factory tab (what księgowość/ZUS sees)
  mainBrutto: real("main_brutto"),
  mainNetto: real("main_netto"),
  mainTaxedBrutto: real("main_taxed_brutto"),  // Σ brutto of rows where netto < brutto (non-students)
  // bottom «godz fakt / godz księgowość / gotówka» block, when present
  blockBrutto: real("block_brutto"),
  blockNetto: real("block_netto"),
  blockTaxedBrutto: real("block_taxed_brutto"),
  gotowka: real("gotowka"),                    // Σ cash payouts on the side
  blockHoursActual: real("block_hours_actual"),
  blockHoursDeclared: real("block_hours_declared"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

// Per-worker payroll rows (main table merged with the ZUS/cash block):
// drill-downs, kasa reconciliation and per-person bank matching.
export const payrollCashRowsTable = pgTable("payroll_cash_rows", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull().references(() => payrollSourcesTable.id),
  periodMonth: text("period_month").notNull(),
  region: text("region").notNull(),
  tabName: text("tab_name").notNull(),
  name: text("name").notNull(),
  hoursActual: real("hours_actual"),
  hoursDeclared: real("hours_declared"),
  brutto: real("brutto"),                    // declared brutto (ZUS base)
  netto: real("netto"),                      // declared netto (goes to the bank account)
  gotowka: real("gotowka"),
  fullNetto: real("full_netto"),             // total pay (Do wypłaty / RAZEM)
  konto: real("konto"),                      // expected bank transfer = declared netto, or full netto if no cash part
  sortIdx: integer("sort_idx").notNull().default(0),
});

// Manually confirmed «bank counterparty = payroll person» pairs for the salary
// reconciliation (typos in names that the fuzzy matcher can't safely confirm).
export const payrollNameMatchesTable = pgTable("payroll_name_matches", {
  id: serial("id").primaryKey(),
  bankKey: text("bank_key").notNull().unique(), // normalized bank counterparty
  counterparty: text("counterparty"),           // raw, for display
  personKey: text("person_key").notNull(),      // normalized person name from сводна
  personName: text("person_name"),
  kind: text("kind").notNull().default("worker"), // worker | office
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Office payroll rows (OFFICE ES / OFFICE KLINEX / …) — kept as a raw mirror,
// deliberately NOT linked to P&L or anything else yet.
export const payrollOfficeRowsTable = pgTable("payroll_office_rows", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull().references(() => payrollSourcesTable.id),
  periodMonth: text("period_month").notNull(),
  region: text("region").notNull(),
  firm: text("firm").notNull(),                // from the tab name: ES / KLINEX / ES OUTSOURCING
  section: text("section"),                    // sheet grouping, e.g. STUDENTY
  name: text("name").notNull(),
  status: text("status"),                      // ZUS | STUD | …
  hours: text("hours"),                        // may be «ETAT», kept as text
  stawka: text("stawka"),
  brutto: real("brutto"),
  umowaOd: text("umowa_od"),
  umowaDo: text("umowa_do"),
  koniecStudiow: text("koniec_studiow"),
  zaswiadczenie: text("zaswiadczenie"),
  sortIdx: integer("sort_idx").notNull().default(0),
});

// Sales invoices mirrored from KSeF (Krajowy System e-Faktur), per firm.
// Revenue accrual: an invoice issued in June for May's work belongs to May's
// P&L (revenue_month = issue month − 1). Payment status: matched strictly by
// invoice number in incoming bank transfers + manual override.
export const ksefInvoicesTable = pgTable("ksef_invoices", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id),
  // sale = ми виставили (Subject1), purchase = виставили нам (Subject2). Inter-firm
  // invoices legally appear twice (seller's sale + buyer's purchase) → unique is
  // (ksef_number, kind), not ksef_number alone.
  kind: text("kind").notNull().default("sale"),
  ksefNumber: text("ksef_number").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  issueDate: date("issue_date").notNull(),
  invoicingDate: date("invoicing_date"),        // accepted by KSeF
  buyerNip: text("buyer_nip"),
  buyerName: text("buyer_name"),
  sellerNip: text("seller_nip"),                // purchases: who invoiced us
  sellerName: text("seller_name"),
  net: real("net").notNull(),
  vat: real("vat").notNull().default(0),
  gross: real("gross").notNull(),
  currency: text("currency").notNull().default("PLN"),
  invoiceType: text("invoice_type"),            // Vat | Korekta | Zal | …
  revenueMonth: text("revenue_month").notNull(),// "YYYY-MM" — P&L month (issue − 1)
  clientLabel: text("client_label"),            // mapped P&L client name
  segment: text("segment").notNull().default("main"), // main | cleaning (wspólnoty)
  invoiceHash: text("invoice_hash"),            // KSeF metadata hash
  correctedHash: text("corrected_hash"),        // korekta → hash of the corrected invoice
  paidDate: date("paid_date"),                  // from bank matching (by invoice number in title)
  paidTxnId: integer("paid_txn_id"),            // bank_transactions.id
  paidVia: text("paid_via"),                    // bank | register | korekta (how auto-paid was decided)
  manualStatus: text("manual_status"),          // paid | unpaid | NULL (auto)
  manualPaidDate: date("manual_paid_date"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("ksef_invoices_number_kind_uniq").on(t.ksefNumber, t.kind),
]);

// Web-panel login sessions — one row per successful web login. The session id is embedded
// in the HMAC token (sid); authRequired looks it up so a single device can be revoked
// (revoked_at) without touching the others. Kept for audit even after revocation/expiry.
export const adminSessionsTable = pgTable("admin_sessions", {
  id: text("id").primaryKey(),                 // random session id, also the `sid` inside the token
  adminId: integer("admin_id").notNull().references(() => adminsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  device: text("device"),                      // parsed short label, e.g. "Chrome на Windows"
  geo: text("geo"),                            // best-effort "City, Country" from IP (null if unknown/disabled)
  revokedAt: timestamp("revoked_at"),          // set → token stops working immediately
  revokedBy: integer("revoked_by"),            // admin id who revoked (null = self/logout/password change)
});

// Immutable audit trail of web sign-in attempts (success + failures) for breach forensics.
export const loginEventsTable = pgTable("login_events", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id"),                // null when the username was unknown
  usernameTried: text("username_tried"),
  at: timestamp("at").notNull().defaultNow(),
  ip: text("ip"),
  device: text("device"),
  geo: text("geo"),
  event: text("event").notNull(),              // success | bad_password | bad_2fa | no_telegram | logout
  sessionId: text("session_id"),               // links to admin_sessions.id on success/logout
});

// Types
export type Worker = typeof workersTable.$inferSelect;
export type Position = typeof positionsTable.$inferSelect;
export type FactoryPosition = typeof factoryPositionsTable.$inferSelect;
export type Driver = typeof driversTable.$inferSelect;
export type Factory = typeof factoriesTable.$inferSelect;
export type FactoryOrder = typeof factoryOrdersTable.$inferSelect;
export type Availability = typeof availabilityTable.$inferSelect;
export type ScheduleWeek = typeof scheduleWeeksTable.$inferSelect;
export type ScheduleEntry = typeof scheduleEntriesTable.$inferSelect;
export type Admin = typeof adminsTable.$inferSelect;
export type DriverWorkday = typeof driverWorkdaysTable.$inferSelect;
export type Vehicle = typeof vehiclesTable.$inferSelect;
export type ShiftCancellation = typeof shiftCancellationsTable.$inferSelect;
export type Candidate = typeof candidatesTable.$inferSelect;
export type AbsenceRequest = typeof absenceRequestsTable.$inferSelect;
export type Company = typeof companiesTable.$inferSelect;
export type BankTransaction = typeof bankTransactionsTable.$inferSelect;
export type BankStatementRow = typeof bankStatementsTable.$inferSelect;
export type CashEntry = typeof cashEntriesTable.$inferSelect;
export type AdminSession = typeof adminSessionsTable.$inferSelect;
export type LoginEvent = typeof loginEventsTable.$inferSelect;

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Shift = "1" | "2" | "3" | "4" | "5" | "6";

export const insertWorkerSchema = createInsertSchema(workersTable).omit({ id: true, createdAt: true });
export const insertDriverSchema = createInsertSchema(driversTable).omit({ id: true, createdAt: true });
export const insertFactorySchema = createInsertSchema(factoriesTable).omit({ id: true, createdAt: true });
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
