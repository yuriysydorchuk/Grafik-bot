import {
  pgTable, serial, text, integer, timestamp, boolean, date, pgEnum
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const shiftEnum = pgEnum("shift", ["1", "2", "3"]);
export const dayEnum = pgEnum("day_of_week", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const scheduleStatusEnum = pgEnum("schedule_status", ["draft", "approved"]);
export const entryStatusEnum = pgEnum("entry_status", ["scheduled", "present", "absent"]);

export const workersTable = pgTable("workers", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  telegramId: text("telegram_id").unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const driversTable = pgTable("drivers", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  vehicle: text("vehicle"),
  isHeadDriver: boolean("is_head_driver").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const factoriesTable = pgTable("factories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Weekly orders from factories: how many workers needed per day per shift
export const factoryOrdersTable = pgTable("factory_orders", {
  id: serial("id").primaryKey(),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  weekStart: date("week_start").notNull(), // Monday date of the week
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  workersNeeded: integer("workers_needed").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Availability synced from Google Sheets (one row per worker per day per shift per week)
export const availabilityTable = pgTable("availability", {
  id: serial("id").primaryKey(),
  fullNameRaw: text("full_name_raw").notNull(),
  weekStart: date("week_start").notNull(),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  submittedAt: timestamp("submitted_at").notNull(),
});

// A generated/approved schedule for a week
export const scheduleWeeksTable = pgTable("schedule_weeks", {
  id: serial("id").primaryKey(),
  weekStart: date("week_start").notNull(),
  status: scheduleStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
});

// Individual worker assignments within a schedule week
export const scheduleEntriesTable = pgTable("schedule_entries", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  status: entryStatusEnum("status").notNull().default("scheduled"),
  absenceReason: text("absence_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Driver assignment per shift group
export const driverShiftAssignmentsTable = pgTable("driver_shift_assignments", {
  id: serial("id").primaryKey(),
  weekId: integer("week_id").notNull().references(() => scheduleWeeksTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  dayOfWeek: dayEnum("day_of_week").notNull(),
  shift: shiftEnum("shift").notNull(),
  driverId: integer("driver_id").notNull().references(() => driversTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const adminsTable = pgTable("admins", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Types
export type Worker = typeof workersTable.$inferSelect;
export type Driver = typeof driversTable.$inferSelect;
export type Factory = typeof factoriesTable.$inferSelect;
export type FactoryOrder = typeof factoryOrdersTable.$inferSelect;
export type Availability = typeof availabilityTable.$inferSelect;
export type ScheduleWeek = typeof scheduleWeeksTable.$inferSelect;
export type ScheduleEntry = typeof scheduleEntriesTable.$inferSelect;
export type Admin = typeof adminsTable.$inferSelect;

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Shift = "1" | "2" | "3";

export const insertWorkerSchema = createInsertSchema(workersTable).omit({ id: true, createdAt: true });
export const insertDriverSchema = createInsertSchema(driversTable).omit({ id: true, createdAt: true });
export const insertFactorySchema = createInsertSchema(factoriesTable).omit({ id: true, createdAt: true });
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
