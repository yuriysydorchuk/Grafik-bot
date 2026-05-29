import { pgTable, serial, text, integer, timestamp, boolean, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const workersTable = pgTable("workers", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  address: text("address"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const driversTable = pgTable("drivers", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  vehicle: text("vehicle"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const factoriesTable = pgTable("factories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  contactPerson: text("contact_person"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const schedulesTable = pgTable("schedules", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  driverId: integer("driver_id").references(() => driversTable.id),
  scheduleDate: date("schedule_date").notNull(),
  shiftStart: text("shift_start").notNull().default("08:00"),
  shiftEnd: text("shift_end").notNull().default("17:00"),
  status: text("status").notNull().default("scheduled"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const adminsTable = pgTable("admins", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertWorkerSchema = createInsertSchema(workersTable).omit({ id: true, createdAt: true });
export const insertDriverSchema = createInsertSchema(driversTable).omit({ id: true, createdAt: true });
export const insertFactorySchema = createInsertSchema(factoriesTable).omit({ id: true, createdAt: true });
export const insertScheduleSchema = createInsertSchema(schedulesTable).omit({ id: true, createdAt: true });
export const insertAdminSchema = createInsertSchema(adminsTable).omit({ id: true, createdAt: true });

export type Worker = typeof workersTable.$inferSelect;
export type Driver = typeof driversTable.$inferSelect;
export type Factory = typeof factoriesTable.$inferSelect;
export type Schedule = typeof schedulesTable.$inferSelect;
export type Admin = typeof adminsTable.$inferSelect;
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
export type InsertDriver = z.infer<typeof insertDriverSchema>;
export type InsertFactory = z.infer<typeof insertFactorySchema>;
export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
