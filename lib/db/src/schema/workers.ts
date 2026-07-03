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
export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
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
  workerCode: text("worker_code").unique(),
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  companyId: integer("company_id").references(() => companiesTable.id), // our agency the worker is under
  positionId: integer("position_id").references(() => positionsTable.id), // work role (nullable = generic production)
  gender: text("gender"), // male | female | null (needed where factory orders split by gender)
  fixedShift: text("fixed_shift"), // "1".."6" — worker bound to this shift (for manual "give everyone" factories); null = flexible
  status: text("status").notNull().default("active"), // active | fired
  isActive: boolean("is_active").notNull().default(true),
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

export const adminsTable = pgTable("admins", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),  // nullable: set when an invited user joins the bot
  name: text("name").notNull(),
  username: text("username").unique(),       // web login
  passwordHash: text("password_hash"),       // scrypt hash for web login
  role: text("role").notNull().default("owner"), // owner | scheduler | driver
  isMain: boolean("is_main").notNull().default(false), // the one immutable head admin (only this account manages roles)
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

// Worker self-reports absence before their shift
export const absenceRequestsTable = pgTable("absence_requests", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  weekStart: date("week_start").notNull(),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
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
export type Candidate = typeof candidatesTable.$inferSelect;
export type AbsenceRequest = typeof absenceRequestsTable.$inferSelect;

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Shift = "1" | "2" | "3" | "4" | "5" | "6";

export const insertWorkerSchema = createInsertSchema(workersTable).omit({ id: true, createdAt: true });
export const insertDriverSchema = createInsertSchema(driversTable).omit({ id: true, createdAt: true });
export const insertFactorySchema = createInsertSchema(factoriesTable).omit({ id: true, createdAt: true });
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
