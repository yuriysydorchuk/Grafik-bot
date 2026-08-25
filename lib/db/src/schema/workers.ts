import {
  pgTable, serial, text, integer, timestamp, boolean, date, pgEnum, jsonb, real, uniqueIndex, index
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
  rateNetto: real("rate_netto"), // net PLN/hour pair (netto/brutto пари нестандартні — тримаємо обидві)
  invoiceRate: real("invoice_rate"), // net PLN/hour we bill the client for this position (null = factory default invoiceRate)
  sortOrder: integer("sort_order").notNull().default(0),
});

export const workersTable = pgTable("workers", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  // точне написання «Nazwisko Imię» з Gratyfikant nexo (кадрова система księgowej);
  // використовується ЛИШЕ в експорті naliczeń для Gratyfikanta (пріоритет над full_name);
  // NULL = імʼя профілю збігається з nexo або людини там ще нема
  gratyfikantName: text("gratyfikant_name"),
  // PESEL (11 цифр, текстом — провідні нулі!): найнадійніший ідентифікатор для
  // матчингу з Gratyfikant nexo (WartoscZArkusza P8="P"); джерело — картотеки nexo
  pesel: text("pesel"),
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
  selfTransportSince: date("self_transport_since"), // «діє з»: від якої дати чинне ПОТОЧНЕ значення selfTransport (генерація знять за довіз вирішує режим помісячно)
  createdSource: text("created_source"), // походження профілю: null = звичайне створення, "hours_import" = створений з імпорту годин фабрики (/hours) — таких можна швидко видалити зі списку обліку
  language: text("language"), // bot UI language: uk | en | es | ru | pl (null = not chosen yet)
  // Payroll (umowa zlecenie) — used by the finance module
  birthDate: date("birth_date"), // з дати народження виводиться «до 26» (податкова пільга)
  // Ставки — профільний override; NULL = «авто» за правилами фабрики
  // (пара посади factory_positions → найдешевша посада → базова пара фабрики)
  hourlyRate: real("hourly_rate"), // gross PLN/hour (null = авто з фабрики)
  hourlyRateNetto: real("hourly_rate_netto"), // net PLN/hour — пари brutto/netto нестандартні, з одного поля не виводяться; студенту до 26 нетто = брутто (виводиться)
  isStudent: boolean("is_student").notNull().default(false),
  under26: boolean("under_26").notNull().default(false),
  legalStatus: text("legal_status"), // форма легалізації: student | dyplom | do26 | zus | oczekuje | karta_pobytu | staly_pobyt | polak
  notifyHours: real("notify_hours"), // години в powiadomieniu (дозвіл на працю)
  note: text("note"), // примітка (видима лише з доступом svodniSensitive)
  payoutPrefKind: text("payout_pref_kind"), // побажання по виплаті: all_konto | hours | amount (найвищий пріоритет у розкладі konto/готівка)
  payoutPrefValue: real("payout_pref_value"), // N годин або сума — для kind hours|amount
  employmentStartDate: date("employment_start_date"), // дата працевлаштування (усі працівники; в Agram від неї рахується стаж-бонус)
  // Бонуси Аграму (лише працівники фабрик Agram; сводна додає до ставки нетто)
  agramStazBonus: boolean("agram_staz_bonus").notNull().default(false), // стаж: +1 зл/год після 30 днів, +1.5 після 60 (без дати +1); лише при 160+ год/міс
  agramCashBonus: boolean("agram_cash_bonus").notNull().default(false), // готівковий бонус: +1 зл/год (частина ЗП налом; на przelew — не належить; від годин не залежить)
  // національність: ukraine | belarus | africa | latin_america | central_asia | south_asia
  // (показ прапорцем біля імені: профіль, довози, сводна)
  nationality: text("nationality"),
  firedAt: timestamp("fired_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Залічки за бадання (медогляд): список записів на працівника — своя сума,
// дата «вписано» і статус/дата «знято з ЗП». Ведеться вручну в профілі.
export const workerBadaniaTable = pgTable("worker_badania", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  amount: real("amount").notNull(),
  enteredAt: date("entered_at").notNull(),
  deducted: boolean("deducted").notNull().default(false),
  deductedAt: date("deducted_at"),
  deductedMonth: text("deducted_month"), // YYYY-MM сводної, з якої знято (перенесення в Zaliczka BD)
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("worker_badania_worker_idx").on(t.workerId)]);

// Особисті номери працівників у системах фабрик (Nr Osobowy: Agram, Poznań…).
// Імпорт годин матчить рядок спершу по цьому ключу, потім fuzzy по імені.
// Код — digits-only рядок; порівнюється без провідних нулів ("0123" == "123").
export const workerFactoryCodesTable = pgTable("worker_factory_codes", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("worker_factory_codes_worker_factory_uniq").on(t.workerId, t.factoryId),
  uniqueIndex("worker_factory_codes_factory_code_uniq").on(t.factoryId, t.code),
]);

// Виключення працівника з місяця Обліку годин («прибрати зі списку», відпустка,
// ще не приступив): ховає лише авто-доданий нульовий рядок; реальні дані місяця
// (явки/рапорт/години фабрики) повертають рядок незалежно від виключення.
export const hoursMonthExclusionsTable = pgTable("hours_month_exclusions", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  month: text("month").notNull(), // YYYY-MM
  reason: text("reason").notNull().default("manual"), // manual | vacation | not_started
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("hours_month_exclusions_uniq").on(t.workerId, t.month)]);

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
  tripRate: real("trip_rate"), // зл/виїзд — базова ставка оплати водієві (NULL = не платиться); оверрайди — driver_trip_rates
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Оверрайд ставки «за виїзд» для пари водій × фабрика (рішення власника: базова
// ставка водія + фабричні винятки). Розрахунок виплат бере оверрайд ?? tripRate.
export const driverTripRatesTable = pgTable("driver_trip_rates", {
  id: serial("id").primaryKey(),
  driverId: integer("driver_id").notNull().references(() => driversTable.id),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  rate: real("rate").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("driver_trip_rates_uniq").on(t.driverId, t.factoryId)]);

// Архів логістичних таблиць головного водія («Контроль поездок по фабрикам»,
// 2022–2026): один рядок = один виїзд (дата × зміна × фабрика). Операційні
// driver_workdays не зачіпає; звʼязки до наших водіїв/авто/фабрик — де заматчилось.
export const driverTripLogTable = pgTable("driver_trip_log", {
  id: serial("id").primaryKey(),
  tripDate: date("trip_date").notNull(),
  factoryLabel: text("factory_label").notNull(),
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  shiftTime: text("shift_time"),
  driverName: text("driver_name"),
  driverId: integer("driver_id").references(() => driversTable.id),
  vehiclePlate: text("vehicle_plate"),
  vehicleId: integer("vehicle_id").references(() => vehiclesTable.id),
  odoFrom: integer("odo_from"),
  odoTo: integer("odo_to"),
  km: integer("km"),
  people: integer("people"),
  payAmount: real("pay_amount"), // оплата водієві за цей виїзд (з колонок імен у таблиці)
  note: text("note"),
  sourceRef: text("source_ref").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("driver_trip_log_date_idx").on(t.tripDate),
  index("driver_trip_log_factory_idx").on(t.factoryLabel),
  index("driver_trip_log_driver_idx").on(t.driverId),
]);

// Зняття з ЗП працівників за довіз (дзеркало hostel_deductions): місяць ×
// працівник × фабрика. Джерело — «Контроль поездок работника» + ручний CRUD.
export const transportDeductionsTable = pgTable("transport_deductions", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // YYYY-MM
  workerId: integer("worker_id").references(() => workersTable.id),
  workerName: text("worker_name"), // сирий підпис, коли не заматчилось
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  factoryLabel: text("factory_label"),
  tripsCount: integer("trips_count"),
  amount: real("amount").notNull().default(0),
  note: text("note"),
  sourceRef: text("source_ref"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("transport_deductions_month_idx").on(t.periodMonth),
  index("transport_deductions_worker_idx").on(t.workerId),
]);

// Вибірковий платний довіз: список «хто платить» на фабриці з paid_transport.
// Порожній список = платить уся фабрика (як досі); є рядки — генерація знять
// (/transport/deductions/generate) тарифікує ЛИШЕ вибраних. Ціна/ліміт — завжди
// фабричні (transport_fee_per_shift / transport_fee_month_cap).
export const transportFeeMembersTable = pgTable("transport_fee_members", {
  id: serial("id").primaryKey(),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id, { onDelete: "cascade" }),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("transport_fee_members_uq").on(t.factoryId, t.workerId)]);

// Fleet vehicles (managed by the head driver in the bot). Drivers pick one when
// starting a workday; the plate shows up in the mileage report.
export const vehiclesTable = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  plate: text("plate").notNull(),        // registration number, e.g. "WX 12345"
  brandModel: text("brand_model"),       // e.g. "Opel Vivaro"
  seats: integer("seats"),               // passenger capacity (null = unknown)
  isActive: boolean("is_active").notNull().default(true),
  // Fleet 2.0 (дані з таблиці головного водія «АВТОПАРК 2»):
  city: text("city"),                    // LUBLIN | POZNAN | LODZ | BIALYSTOK | …
  companyId: integer("company_id").references(() => companiesTable.id), // наша фірма-власник/лізингоотримувач
  ownerName: text("owner_name"),         // у кого орендуємо (приватна особа); NULL = власне/лізинг фірми
  fuel: text("fuel"),                    // B | D | B/G
  year: integer("year"),
  vin: text("vin"),
  ownership: text("ownership"),          // umowa | leasing | faktura | private
  insuranceUntil: date("insurance_until"),   // UBEZP (OC/AC) — крон-алерт при наближенні
  inspectionUntil: date("inspection_until"), // TO (przegląd techniczny) — крон-алерт при наближенні
  rentMonthly: real("rent_monthly"),         // оренда/міс — фінансове, owner-only
  purchasePrice: real("purchase_price"),     // фінансове, owner-only
  marketPrice: real("market_price"),         // фінансове, owner-only
  leaseTotal: real("lease_total"),           // повна вартість лізингового договору, зл (owner-only)
  leaseInitialPaid: real("lease_initial_paid"), // wstępna брутто, якщо її фактури нема в реєстрі (додається до сплаченого)
  leaseLessor: text("lease_lessor"),         // лізингодавець — нормалізований матч контрагента фактур
  leaseContractNo: text("lease_contract_no"), // № договору (розрізняє авто одного лізингодавця)
  purchasedAt: date("purchased_at"),
  soldAt: date("sold_at"),
  status: text("status").notNull().default("active"), // active | sold | scrapped
  kind: text("kind"),                    // car | bus (секції таблиці водія)
  personal: boolean("personal").notNull().default(false), // особисте авто власників — поза робочим флоу і підсумком парку
  equipment: jsonb("equipment").$type<Record<string, string>>().notNull().default({}), // інвентар: домкрат/насос/вогнегасник/аптечка/жилетка…
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Витрати на авто (ремонти/шини) по місяцях — міграція аркушів «Ремонт 2023–2026»
// + подальше ручне ведення. source_ref = провенанс міграції (файл|аркуш|рядок).
export const vehicleExpensesTable = pgTable("vehicle_expenses", {
  id: serial("id").primaryKey(),
  vehicleId: integer("vehicle_id").references(() => vehiclesTable.id),
  vehicleLabel: text("vehicle_label"), // сирий підпис авто, коли не заматчилось (напр. «audi i bmw И ПАНДА»)
  month: text("month").notNull(),      // YYYY-MM
  amount: real("amount").notNull(),
  kind: text("kind").notNull().default("repair"), // repair | tire | other
  service: text("service"),
  invoiceNo: text("invoice_no"),
  note: text("note"),                  // напр. «замена двигателя»
  sourceRef: text("source_ref"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("vehicle_expenses_month_idx").on(t.month), index("vehicle_expenses_vehicle_idx").on(t.vehicleId)]);

// Реєстр фактур автосервісів (FV… з аркушів «Ремонт NNNN»). Довідковий шар для звірки
// з банком/фактурами витрат; аналітика витрат іде по vehicle_expenses (не сумувати обидва!).
export const vehicleServiceInvoicesTable = pgTable("vehicle_service_invoices", {
  id: serial("id").primaryKey(),
  invoiceNo: text("invoice_no").notNull(),
  service: text("service"),
  month: text("month").notNull(),      // YYYY-MM
  amount: real("amount").notNull(),
  sourceRef: text("source_ref"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("vehicle_service_invoices_uniq").on(t.invoiceNo, t.month, t.amount)]);

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
  clientNip: text("client_nip"),   // NIP юрособи-клієнта: ключ матчингу фактур KSeF → P&L (кілька фабрик одного клієнта ділять один NIP)
  pnlLabel: text("pnl_label"),     // канонічний підпис клієнта в P&L (дохід і собівартість зливаються по ньому)
  usesAvailability: boolean("uses_availability").notNull().default(true), // kept in sync = (genMode === 'availability'); legacy reads
  // Schedule generation mode:
  //  • availability — workers self-report availability; generate by orders + availability
  //  • orders       — admin/manual; generate all active workers by orders
  //  • all          — release EVERYONE (no orders); bound→fixed shift, rest balanced across shifts
  genMode: text("gen_mode").notNull().default("availability"),
  usesPositions: boolean("uses_positions").notNull().default(false), // does this factory differentiate work positions?
  usesGender: boolean("uses_gender").notNull().default(false),        // does this factory split orders by gender?
  usesTransport: boolean("uses_transport").notNull().default(true),   // agency provides pickup → show stops/pickup to workers
  // Платний довіз: зняття з ЗП працівників за довіз (вкладка Транспорт → Зняття
  // за довіз, авторозрахунок по змінах місяця; сума = min(зміни × ціна, ліміт))
  paidTransport: boolean("paid_transport").notNull().default(false),
  transportFeePerShift: real("transport_fee_per_shift"), // ціна за зміну, zł
  transportFeeMonthCap: real("transport_fee_month_cap"), // максимум за місяць, zł (NULL = без ліміту)
  usesScheduling: boolean("uses_scheduling").notNull().default(true),  // false = фабрика лише зарплатна (Лодзь/Познань): без замовлень/графіків/доступності
  showWorkerHours: boolean("show_worker_hours").notNull().default(true), // show the "My hours" button to workers
  showCode: boolean("show_code").notNull().default(true),             // show the worker-code column in the Excel schedule
  clientEmail: text("client_email"), // where to send approved schedule
  invoiceRate: real("invoice_rate"), // net PLN/hour billed to this factory (finance module)
  city: text("city"),               // місто фабрики (групування сводної 2.0): Люблін | Познань | Лодзь | …
  fuelCommute: boolean("fuel_commute").notNull().default(false), // фабрика з доїздом: паливо ділиться по містах ∝ людей на таких фабриках
  multiFirm: boolean("multi_firm").notNull().default(false), // контракт клієнта з КІЛЬКОМА нашими фірмами (Sushi&Food: ES + ESO) — сводна пише фірму працівника в svodni_rows.firm (групи в одній вкладці)
  rateBrutto: real("rate_brutto"),  // базова ставка брутто PLN/год (для фабрик без посад)
  rateNetto: real("rate_netto"),    // базова ставка нетто PLN/год
  nightAddon: real("night_addon"),  // доплата за нічну годину, нетто PLN (null = нічних нема)
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
  // «Виправдана» відсутність: адмін визнав пропуск поважним — не рахується
  // у кількість пропусків працівника і не тягне штраф.
  absenceExcused: boolean("absence_excused").notNull().default(false),
  // Штраф за пропуск, zł: NULL = стандартний (200), число = override (0 = анульовано).
  absencePenalty: real("absence_penalty"),
  // Перенесення штрафу в Kara сводної: місяць/дата + сума на момент переносу
  // (undo віднімає саме зафіксоване, навіть якби штраф потім змінили).
  absenceDeductedMonth: text("absence_deducted_month"), // YYYY-MM, NULL = не перенесено
  absenceDeductedAt: date("absence_deducted_at"),
  absenceDeductedAmount: real("absence_deducted_amount"),
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

// A one-off shift for a specific factory DATE (e.g. an extra 3rd shift for a single
// action day). Carries its own start/end so time resolution works for a shift index
// outside the factory's regular `shifts` config; all shift surfaces (pushes, driver
// board, Excel, live) must consult these before falling back to factory shift times.
export const factoryShiftOverridesTable = pgTable("factory_shift_overrides", {
  id: serial("id").primaryKey(),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  date: date("date").notNull(),      // the calendar day the shift starts (YYYY-MM-DD)
  shift: shiftEnum("shift").notNull(),
  start: text("start").notNull(),    // "HH:MM"
  end: text("end").notNull(),        // "HH:MM" (may cross midnight)
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("factory_shift_overrides_uniq").on(t.factoryId, t.date, t.shift)]);

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
  // Web-panel language (uk | en | ru), persisted server-side: the Telegram Mini App webview
  // loses localStorage between openings, so a client-side choice alone keeps resetting.
  webLang: text("web_lang"),
  // Per-account UI preferences of the web panel (tab order for cities/factories, …),
  // key→value; server-side so they follow the user across browsers/devices.
  webPrefs: jsonb("web_prefs").$type<Record<string, unknown>>().notNull().default({}),
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
  rejectReason: text("reject_reason"),                  // чому відхилено (опційно; йде у сповіщення працівнику)
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

// Salary-advance requests: a worker asks via the bot, or office staff submit on the
// worker's behalf (then the row is approved immediately, decided_by = submitter).
// Approval assigns a payout group (lib/advancePayout.ts): decided 1–14 → the 15th,
// 15–29 → the 30th, 30–31 → the 15th of the next month. The worker sees the status.
export const advanceRequestsTable = pgTable("advance_requests", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  factoryId: integer("factory_id").references(() => factoriesTable.id), // з якої фабрики просили залічку; перенесення в сводну (apply-zaliczki) кладе суму в рядок саме цієї пари (NULL = історія → «основна» фабрика місяця)
  amount: real("amount").notNull(),                       // requested amount (PLN)
  comment: text("comment"),                               // worker's optional note
  status: text("status").notNull().default("pending"),   // pending | approved (= передано до виплати) | rejected | paid
  adminNote: text("admin_note"),                          // optional note on the decision
  decidedBy: integer("decided_by").references(() => adminsTable.id),
  decidedAt: timestamp("decided_at"),
  payoutMonth: text("payout_month"),                      // "YYYY-MM" of the payout group; manually movable
  payoutGroup: text("payout_group"),                      // "15" | "30" — payout on the 15th / 30th
  paidMethod: text("paid_method"),                        // transfer | cash (NULL = не вказано / стара історія)
  paidAt: timestamp("paid_at"),
  paidBy: integer("paid_by").references(() => adminsTable.id), // хто ВРУЧНУ позначив «виплачено» (сайт/бот); авто-помітка по переказу лишає NULL (її ознака — paid_txn_id)
  // авто-помітка «виплачено» по банківському переказу (services/advances.ts);
  // set null — MT940-імпорт заміщає api-рядки, статус авансу при цьому лишається
  paidTxnId: integer("paid_txn_id").references(() => bankTransactionsTable.id, { onDelete: "set null" }),
  // Перенесення в сводну — масова дія ПІСЛЯ звірки виплат (дзеркало worker_badania.deducted):
  // POST /svodni/apply-zaliczki пише суму в Zaliczka і ставить місяць+дату; from-hours
  // залічки НЕ чіпає. NULL = виплачений аванс ще не перенесено.
  svodniMonth: text("svodni_month"),                      // YYYY-MM сводної, куди перенесено
  svodniAppliedAt: date("svodni_applied_at"),
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

// Client-side hours for the month (factory's own attendance export) — the reconciliation
// counterpart of monthly_reports: report vs factory hours are compared on the Hours page.
// Filled by Excel import, pasted list, or manual cell edit. One record per worker+month+factory.
export const factoryHoursTable = pgTable("factory_hours", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  month: text("month").notNull(),                          // "YYYY-MM"
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id),
  hours: real("hours").notNull(),                          // factory-reported monthly total
  source: text("source").notNull().default("manual"),      // excel | paste | manual
  days: jsonb("days").$type<Record<string, number | Record<string, number>>>(), // "YYYY-MM-DD" → год АБО { "№зміни": год } (позмінна розбивка ewidencja I/II/III)
  // Розрахунковий файл Eurocash несе більше за години: нічні, продуктивність,
  // ставку агенції за порогом, потроненя (переносяться у сводну), korekta/końcowe
  // (агентський рівень, довідково) + NR OSOBOWY фабрики
  extras: jsonb("extras").$type<{
    nocneH?: number; produktywnosc?: number; stawkaAgencji?: number;
    potracenia?: number; innePotracenia?: number; korekta?: number; koncowe?: number; nrOsobowy?: string;
  } | null>(),
  confirmed: boolean("confirmed").notNull().default(false), // розбіжність рапорт↔фабрика перевірена вручну («все ок») — рядок зелений; скидається при зміні годин
  // запит підтвердження годин працівнику в бот і його відповідь
  askSentAt: timestamp("ask_sent_at"),        // коли надіслано запит у бот
  askHours: real("ask_hours"),                // які саме години надсилались (для звірки, якщо потім змінились)
  workerResponse: text("worker_response"),    // confirmed | dispute | null (ще не відповів)
  workerResponseAt: timestamp("worker_response_at"),
  workerNote: text("worker_note"),            // пояснення помилки від працівника
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("factory_hours_worker_month_factory_uniq").on(t.workerId, t.month, t.factoryId),
]);

// Ручні замітки Обліку годин: вільний текст графіка/офісу до пари
// (працівник, місяць, фабрика) — робоча нотатка, не фінансове поле.
// Дзеркало патерну monthly_reports: unique по парі + окремий unique для
// legacy-рядків без фабрики.
export const hoursNotesTable = pgTable("hours_notes", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  month: text("month").notNull(),                          // "YYYY-MM"
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  note: text("note").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("hours_notes_worker_month_factory_uniq").on(t.workerId, t.month, t.factoryId),
  uniqueIndex("hours_notes_worker_month_nofactory_uniq").on(t.workerId, t.month).where(sql`${t.factoryId} IS NULL`),
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
  source: text("source").notNull().default("mt940"), // mt940 (звітне, джерело правди) | api (оперативне, Enable Banking; заміщається витягом)
  counterpartyId: integer("counterparty_id").references(() => counterpartiesTable.id), // резолюція в довідник контрагентів (IBAN → NIP → аліас)
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

// ─── Open banking (Enable Banking PSD2 API) ────────────────────────────────────
// Consents: one row per authorized bank session (банк × логін юрособи). The consent
// lives ~180 days (PSD2 SCA); renewal creates a NEW session row and revokes the old
// one. Transactions synced through a consent land in bank_transactions with
// source='api' and are superseded by the MT940 import for the covered period.
export const bankApiConsentsTable = pgTable("bank_api_consents", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(), // Enable Banking session id
  aspspName: text("aspsp_name").notNull(),          // connector name, e.g. "BNP Paribas"
  aspspCountry: text("aspsp_country").notNull().default("PL"),
  companyId: integer("company_id").references(() => companiesTable.id), // юрособа логіна (null = не змапилась)
  validUntil: timestamp("valid_until").notNull(),
  revokedAt: timestamp("revoked_at"),
  expiryWarnedAt: timestamp("expiry_warned_at"),    // останнє бот-попередження «згода добігає кінця»
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Accounts visible through a consent. uid is session-scoped (changes on renewal);
// iban is the stable identity used to join with bank_transactions.account.
export const bankApiAccountsTable = pgTable("bank_api_accounts", {
  id: serial("id").primaryKey(),
  consentId: integer("consent_id").notNull().references(() => bankApiConsentsTable.id, { onDelete: "cascade" }),
  uid: text("uid").notNull(),
  iban: text("iban"),
  holderName: text("holder_name"),                  // назва власника з банку (KLINEX SP. Z O.O. …)
  product: text("product"),
  currency: text("currency"),
  companyId: integer("company_id").references(() => companiesTable.id),
  lastBookedBalance: real("last_booked_balance"),   // останній знятий booked-баланс (живий стан на /bank)
  lastAvailableBalance: real("last_available_balance"),
  balanceAt: timestamp("balance_at"),
  lastSyncAt: timestamp("last_sync_at"),
  lastTxDate: date("last_tx_date"),                 // найсвіжіша value_date серед синкнутих транзакцій
});

// ─── CFO-модуль ────────────────────────────────────────────────────────────────
// Збережені АІ-висновки фінансового директора (місячний аналіз через Claude API).
export const cfoReportsTable = pgTable("cfo_reports", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(),  // "YYYY-MM" — проаналізований місяць
  content: text("content").notNull(),           // текст висновку (markdown)
  model: text("model"),                         // якою моделлю згенеровано
  auto: boolean("auto").notNull().default(false), // true = крон 1-го числа, false = кнопка
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
  manualCategory: text("manual_category"),     // override for the auto text-based category (outflow: expense cat; inflow: income cat, 'card' = знято з карти)
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

// Категорії каси — окремий від банківського довідник (веде кадрова на /cash):
// flow=out — видатки, flow=in — приходи («знято з карти» / додаткові). Зарплатні
// категорії несуть payroll (factory | office | cleaning | legacy) і city — по них
// іде звірка готівкових ЗП зі сводною міста. requires_desc — запис із цією
// категорією мусить мати опис (напр. «Повернення коштів працівникам»).
export const cashCategoriesTable = pgTable("cash_categories", {
  id: serial("id").primaryKey(),
  flow: text("flow").notNull().default("out"), // out | in
  key: text("key").notNull().unique(),         // стабільний ключ, живе в cash_entries.manual_category
  label: text("label").notNull(),
  city: text("city"),                          // Люблін | Лодзь | Познань (для payroll-категорій)
  payroll: text("payroll"),                    // factory | office | cleaning | legacy → зарплатна категорія
  cleaning: boolean("cleaning").notNull().default(false), // видаткова категорія бізнесу прибирання (розділ /cleaning)
  requiresDesc: boolean("requires_desc").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Зафіксовані розбіжності звірок каси («передивилися, причина відома»):
// side=bank (зняття з банку без пари в касі) | cash (прихід каси без пари в банку)
// | month (відкриття місяця ≠ закриття попереднього) | payroll (готівка ЗП ≠ сводна).
// ref — id запису (bank/cash) або складений ключ області (month: box|companyId|month,
// payroll: kasaMonth|catKey). Зняття фіксації = видалення рядка.
export const cashReconAcksTable = pgTable("cash_recon_acks", {
  id: serial("id").primaryKey(),
  side: text("side").notNull(),
  ref: text("ref").notNull(),
  note: text("note"),
  createdBy: integer("created_by").references(() => adminsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("cash_recon_acks_uniq").on(t.side, t.ref)]);

// ─── Довідник контрагентів ─────────────────────────────────────────────────────
// Єдина ідентичність клієнтів/постачальників поверх трьох джерел: KSeF (NIP+назви),
// прив'язка клієнтів фабрик (factories.client_nip) і витяги (IBAN-и). Банки пишуть
// назви по-різному — резолюція йде IBAN → NIP у призначенні → аліас назви.
export const counterpartiesTable = pgTable("counterparties", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),                 // канонічна назва
  kind: text("kind").notNull().default("other"), // client | supplier | both | other
  nip: text("nip").unique(),                    // 10 цифр, без префікса країни
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Варіації написання назви (нормалізовані: upper + сквошнуті пробіли). Unique по
// аліасу — резолюція має бути детермінованою.
export const counterpartyAliasesTable = pgTable("counterparty_aliases", {
  id: serial("id").primaryKey(),
  counterpartyId: integer("counterparty_id").notNull().references(() => counterpartiesTable.id, { onDelete: "cascade" }),
  alias: text("alias").notNull().unique(),
});

// Відомі IBAN-и контрагента (з переказів, зматчених із фактурами, або вручну).
export const counterpartyAccountsTable = pgTable("counterparty_accounts", {
  id: serial("id").primaryKey(),
  counterpartyId: integer("counterparty_id").notNull().references(() => counterpartiesTable.id, { onDelete: "cascade" }),
  iban: text("iban").notNull().unique(),        // нормалізований (без пробілів, upper)
});

// IBAN-и працівників: перекази на ці рахунки — це ЗП/аванси незалежно від тексту
// призначення (щоб виплати без слова WYNAGRODZENIE не падали в «Інше»).
// is_primary — «номер рахунку» профілю: показується в авансах, іде у файл виплат.
export const workerBankAccountsTable = pgTable("worker_bank_accounts", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  iban: text("iban").notNull().unique(),
  source: text("source").notNull().default("manual"), // manual | auto (сідинг із ЗП-переказів)
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("worker_bank_accounts_primary_uniq").on(t.workerId).where(sql`${t.isPrimary}`),
]);

// Counterparty → category rules: re-categorize all (past and future) transactions
// of a counterparty at once. Never applied to owner-payout transactions.
export const counterpartyRulesTable = pgTable("counterparty_rules", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull(),          // uppercase substring matched against counterparty
  category: text("category").notNull(),        // expense category key
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Expense categories for bank/cash classification, editable by the owner in the web
// panel. Seeded from the historical hardcoded list (migration 2026-07-15). `pattern`
// is the auto-classification rule in a mini-DSL evaluated against the transaction
// text (see bankClassify.ts patternCondition): each line is an OR-alternative, terms
// joined by " + " within a line must ALL match, each term is a Postgres regex.
// NULL pattern = manual-only category (reachable via re-categorization or rules).
// "other" and owner_* are virtual keys and never live in this table.
export const expenseCategoriesTable = pgTable("expense_categories", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),         // stable slug referenced by manual_category & rules
  label: text("label").notNull(),
  pattern: text("pattern"),
  sortOrder: integer("sort_order").notNull().default(0), // classification priority: first match wins
  icon: text("icon"),                          // емодзі-значок для UI (напр. ⛽)
  color: text("color"),                        // ключ палітри web/src/lib/colors.ts (slate|red|…)
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
  // модуль «Фактури коштові» (/cost-invoices): ручне внесення і скан з бота
  source: text("source").notNull().default("sheet"), // sheet (синк з таблиці) | manual (сайт) | scan (бот-сканер)
  sellerNip: text("seller_nip"),               // NIP постачальника (для матчингу зі словником/KSeF)
  hostelId: integer("hostel_id").references(() => hostelsTable.id), // рахунок за оренду/медіа конкретного хостелу
  vehicleId: integer("vehicle_id").references(() => vehiclesTable.id), // лізингова/сервісна фактура конкретного авто (картка авто рахує виплачено/залишок)
  city: text("city"),                          // cost-center місто для P&L по містах (хостельні беруть місто хостелу)
  cleaning: boolean("cleaning").notNull().default(false), // видаток бізнесу прибирання (розділ /cleaning)
  cleaningProjectId: integer("cleaning_project_id").references(() => cleaningProjectsTable.id), // вспульнота (NULL = загальний видаток прибирання)
  note: text("note"),
  filePath: text("file_path"),                 // скан/фото фактури на диску (uploads/invoices/)
  createdBy: integer("created_by").references(() => adminsTable.id), // хто вніс (site/бот)
  paymentMethod: text("payment_method"),       // przelew | gotowka | NULL = авто (реєстр/банк)
  cashReport: boolean("cash_report").notNull().default(false), // «рапорт готівковий» — нотатка кшєнгової
  driveFileId: text("drive_file_id"),          // файл фактури на Google Drive (Faktury kosztowe)
  driveError: text("drive_error"),             // чому файла нема на Drive
  driveSyncedAt: timestamp("drive_synced_at"),
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

// Сводні — повне дзеркало зарплатних таблиць по містах (крок до ведення на
// сайті). Рядок = людина × фабрика × місяць з усіма колонками таблиці;
// чутливий шар (фактичні vs księgowość години, готівка) віддається лише з
// capability svodniSensitive. extras — фабричні нюанси (нічні, водійські,
// migawka, Ew.-години…), hr — кадрове, sheet_values/mismatch — звірка формул.
export const svodniRowsTable = pgTable("svodni_rows", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(),   // YYYY-MM
  city: text("city").notNull(),                  // Люблін | Познань | Лодзь
  firm: text("firm"),                            // ES | ESO | Klinex
  factoryLabel: text("factory_label").notNull(), // назва вкладки-фабрики
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  sourceId: integer("source_id").references(() => payrollSourcesTable.id),
  sortIdx: integer("sort_idx").notNull().default(0),
  section: text("section"),                      // секція вкладки (KOBIETY / NIE OPODATKOWANE / …)
  rawName: text("raw_name").notNull(),
  workerId: integer("worker_id").references(() => workersTable.id),
  linkStatus: text("link_status").notNull().default("unmatched"), // auto | confirmed | unmatched | external
  hoursNotified: real("hours_notified"),
  hours: real("hours"),                          // фактичні години (відкритий шар)
  shifts: real("shifts"),
  rateBrutto: real("rate_brutto"),
  rateNetto: real("rate_netto"),
  premia: real("premia"),
  zaliczka: real("zaliczka"),
  zaliczkaBd: real("zaliczka_bd"),
  hostel: real("hostel"),
  odziez: real("odziez"),
  dojazd: real("dojazd"),
  kara: real("kara"),
  komornik: real("komornik"),
  kaucja: real("kaucja"),
  potracenia: real("potracenia"),
  doWyplaty: real("do_wyplaty"),                 // повне netto до виплати
  brutto: real("brutto"),
  // закритий шар (лише svodniSensitive)
  hoursDeclared: real("hours_declared"),
  ksiegBrutto: real("ksieg_brutto"),
  ksiegNetto: real("ksieg_netto"),
  gotowka: real("gotowka"),
  konto: real("konto"),
  isStudent: boolean("is_student"),
  under26: boolean("under_26"),
  extras: jsonb("extras").notNull().default({}),
  hr: jsonb("hr").notNull().default({}),
  sheetValues: jsonb("sheet_values").notNull().default({}),
  mismatch: jsonb("mismatch"),                   // null = наш перерахунок збігся з таблицею
  manual: boolean("manual").notNull().default(false), // рядок правлений на сайті → синк його не перезаписує
  rowColor: text("row_color"),                   // фон рядка з таблиці Google (ручні позначки)
  note: text("note"),                            // ручна замітка «для себе»; не фінансове поле, переживає синк (carry-over), не робить рядок manual
  // Сегменти всередині місяця (зміна умов з дати: посада/ставка/статус).
  // segment_of = id батьківського рядка (NULL = звичайний/батьківський);
  // сегмент несе свої години/ставки/base, місячний розклад konto/готівки — на батькові
  segmentOf: integer("segment_of"),
  segmentFrom: date("segment_from"),
  segmentTo: date("segment_to"),
  segmentLabel: text("segment_label"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Контроль сум по вкладці: сума наших рядків vs рядок SUMA у вкладці vs
// зведення (GODZIN MIESIĘCZNIE / Total Miesiąc) — розбіжність видно одразу.
export const svodniTabChecksTable = pgTable("svodni_tab_checks", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(),
  city: text("city").notNull(),
  firm: text("firm"),
  factoryLabel: text("factory_label").notNull(),
  metric: text("metric").notNull(),              // hours | do_wyplaty | gotowka | …
  ours: real("ours"),
  sheetSuma: real("sheet_suma"),
  summaryTab: real("summary_tab"),
  ok: boolean("ok").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Мапінг обслуговуючого персоналу (рядки OFFICE-вкладок зведених ЗП) на міста
// для P&L по містах. person_key = нормалізоване імʼя (cleanName). allocations =
// [{city, pct}] із сумою 100; людина без рядка тут → місто своєї сводної на 100%.
export const staffAllocationsTable = pgTable("staff_allocations", {
  id: serial("id").primaryKey(),
  personKey: text("person_key").notNull().unique(),
  personName: text("person_name"),
  allocations: jsonb("allocations").$type<{ city: string; pct: number }[]>().notNull().default([]),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Довідник хостелів: місто → хостел з умовами оренди. Фінансовий шар
// (monthly_cost, kaucja) віддається лише з viewFinance; список/мешканці — svodni.
export const hostelsTable = pgTable("hostels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  city: text("city").notNull(),
  address: text("address"),
  rentModel: text("rent_model").notNull().default("whole"), // whole (цілий будинок) | per_place (платимо за місце)
  monthlyCost: real("monthly_cost"),           // zł/міс, що платимо МИ (per_place — за одне місце)
  places: integer("places"),                   // місткість (місць)
  kaucja: real("kaucja"),                      // внесена кауція, zł
  kaucjaNote: text("kaucja_note"),
  workerRate: real("worker_rate"),             // типове зняття з мешканця, zł/міс (fallback для stays)
  landlord: text("landlord"),                  // орендодавець
  companyId: integer("company_id").references(() => companiesTable.id), // фірма-платник
  monthlyTarget: real("monthly_target"),       // ціль доходу zł/міс («Цель» з таблиць водія)
  active: boolean("active").notNull().default(true),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Кімнати хостела: місткість, тип («сімейний»), ціна кімнати. Основа шахматки
// занятості; проживання привʼязуються через hostel_stays.room_id.
export const hostelRoomsTable = pgTable("hostel_rooms", {
  id: serial("id").primaryKey(),
  hostelId: integer("hostel_id").notNull().references(() => hostelsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),      // «Номер 1», «Чердак», «2 этаж Номер 3»
  capacity: integer("capacity"),
  roomType: text("room_type"),         // family | regular
  basePrice: real("base_price"),       // ціна кімнати zł/міс
  sort: integer("sort").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("hostel_rooms_hostel_idx").on(t.hostelId)]);


// Проживання: хто в якому хостелі живе і скільки платить (NULL = worker_rate
// хостелу). to_date NULL = живе зараз. Джерело генерації hostel_deductions.
export const hostelStaysTable = pgTable("hostel_stays", {
  id: serial("id").primaryKey(),
  hostelId: integer("hostel_id").notNull().references(() => hostelsTable.id, { onDelete: "cascade" }),
  // NULL = історичний мешканець без профілю в базі (сире імʼя в residentName)
  workerId: integer("worker_id").references(() => workersTable.id, { onDelete: "cascade" }),
  residentName: text("resident_name"),
  roomId: integer("room_id").references(() => hostelRoomsTable.id),
  fromDate: date("from_date").notNull(),
  toDate: date("to_date"),
  monthlyRate: real("monthly_rate"),           // індивідуальна плата мешканця, zł/міс
  payer: text("payer"),                        // self (готівка) | payroll (зняття з ЗП)
  deposit: real("deposit"),                    // кауція при заселенні (200 зл)
  keyDeposit: real("key_deposit"),             // застава за ключ (50 зл)
  sourceRef: text("source_ref"),               // провенанс міграції
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("hostel_stays_hostel_idx").on(t.hostelId),
  index("hostel_stays_worker_idx").on(t.workerId),
]);

// Облік спецодягу: видача працівникам (наш/свій/на продаж), ціна зняття з ЗП.
// Джерело — таблиці водія «Учёт рабочей одежды» / «Forma» (мігровано 07.2026).
// Довідник типів одягу: key живе в item_type складу/видач (сумісно з міграцією
// таблиць водія), label редагується; нові типи додаються з веб-панелі.
export const clothingTypesTable = pgTable("clothing_types", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Склад магазину одягу: позиція = тип+назва+розмір+стан; видача мінусує qty,
// повернення плюсує (новий після повернення стає БУ — окремий рядок used).
export const clothingStockTable = pgTable("clothing_stock", {
  id: serial("id").primaryKey(),
  itemType: text("item_type").notNull(),           // boots | coverall | jacket | hat | tshirt | set | other
  name: text("name"),                              // уточнення назви (опційно)
  size: text("size"),
  condition: text("condition").notNull().default("new"), // new | used
  price: real("price"),                            // ціна зняття з ЗП при видачі
  qty: integer("qty").notNull().default(0),
  note: text("note"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const clothingItemsTable = pgTable("clothing_items", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").references(() => workersTable.id),
  workerName: text("worker_name"), // сире імʼя, коли не заматчилось (історія)
  itemType: text("item_type").notNull(), // boots | coverall | jacket | hat | tshirt | set | other
  ownership: text("ownership"),          // ours (видано наш) | own (своє) | sold (продано — зняти з ЗП)
  price: real("price"),                  // ціна зняття з ЗП («маємо зняти»)
  deducted: boolean("deducted").notNull().default(false), // «вже знято»
  writtenOff: boolean("written_off").notNull().default(false), // списано (не входить у «до зняття»)
  periodMonth: text("period_month"),     // YYYY-MM, де відомий
  note: text("note"),
  sourceRef: text("source_ref"),
  // Магазин одягу (08.2026): видача зі складу і життєвий цикл
  stockId: integer("stock_id").references(() => clothingStockTable.id), // з якої позиції складу видано
  size: text("size"),
  condition: text("condition"),          // new | used на момент видачі
  issuedAt: date("issued_at"),           // коли видано
  returnedAt: date("returned_at"),       // коли повернуто (повернене до зняття не входить; новий → на склад як БУ)
  deductedAmount: real("deducted_amount"), // скільки ФАКТИЧНО зняли (може відрізнятись від price)
  deductedMonth: text("deducted_month"), // YYYY-MM сводної, з якої зняли
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("clothing_items_worker_idx").on(t.workerId)]);

// Платежі мешканців по місяцях: готівка/картка «платит сам» + payroll-історія
// з таблиць водія. Готівкові рухи дублюються записами каси (box hostel).
export const hostelPaymentsTable = pgTable("hostel_payments", {
  id: serial("id").primaryKey(),
  hostelId: integer("hostel_id").notNull().references(() => hostelsTable.id, { onDelete: "cascade" }),
  stayId: integer("stay_id").references(() => hostelStaysTable.id, { onDelete: "set null" }),
  workerId: integer("worker_id").references(() => workersTable.id),
  residentName: text("resident_name"), // сире імʼя, коли не заматчилось
  periodMonth: text("period_month").notNull(), // YYYY-MM
  amount: real("amount").notNull(),
  method: text("method").notNull().default("cash"), // cash | card | payroll
  note: text("note"),
  sourceRef: text("source_ref"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("hostel_payments_month_idx").on(t.periodMonth), index("hostel_payments_hostel_idx").on(t.hostelId)]);

// Хостели: зняття з ЗП за місяць. Джерело колонки Hostel у сводній —
// «Години підтверджені → до сводної» тягне суму по (місяць, працівник).
export const hostelDeductionsTable = pgTable("hostel_deductions", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // YYYY-MM
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  city: text("city"),
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  factoryLabel: text("factory_label"),
  amount: real("amount").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Затвердження сводної: лок на фабрику (factoryLabel) або на ціле місто
// (factoryLabel = ""). Залочені рядки не редагуються і не перезаписуються
// імпортом/синком, доки лок не знімуть.
export const svodniLocksTable = pgTable("svodni_locks", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // YYYY-MM
  city: text("city").notNull(),
  factoryLabel: text("factory_label").notNull().default(""), // "" = усе місто
  lockedBy: integer("locked_by").references(() => adminsTable.id),
  lockedAt: timestamp("locked_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("svodni_locks_scope_uq").on(t.periodMonth, t.city, t.factoryLabel)]);

// Журнал змін профілю працівника з датою набуття (effective_date): форма
// легалізації, ставки, посада, бонуси Agram, дата народження/працевлаштування,
// звільнення/поновлення. Історія станів людини — фундамент для пропагації змін
// у сводні заднім числом і майбутніх сегментів усередині місяця.
export const workerChangesTable = pgTable("worker_changes", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id").notNull().references(() => workersTable.id, { onDelete: "cascade" }),
  field: text("field").notNull(),          // ключ поля профілю (legalStatus | hourlyRateNetto | positionId | fired | …)
  oldValue: text("old_value"),
  newValue: text("new_value"),
  effectiveDate: date("effective_date").notNull(), // від якої дати діє зміна
  appliedRows: jsonb("applied_rows"),      // куди пропагували: [{month, city, factoryLabel}]
  skippedLocked: jsonb("skipped_locked"),  // залочені місця, які зміна зачіпає, але не оновила
  // явне відхилення в ревʼю розблокування: показана, але не прийнята зміна.
  // Раніше відхилення детектилось «createdAt < нового lockedAt» — це ховало
  // незастосовані зміни, зроблені під старішим (заміненим) локом, назавжди.
  reviewDismissedAt: timestamp("review_dismissed_at"),
  adminId: integer("admin_id").references(() => adminsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("worker_changes_worker_idx").on(t.workerId, t.effectiveDate)]);

// Метадані вкладки сводної: порядок колонок як у таблиці Google + інформаційні
// блоки (напр. «STAWKA EUROCASH» — ставки за діапазонами годин).
export const svodniTabMetaTable = pgTable("svodni_tab_meta", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(),
  city: text("city").notNull(),
  firm: text("firm"),
  factoryLabel: text("factory_label").notNull(),
  colOrder: jsonb("col_order").notNull().default([]), // ключі колонок у порядку таблиці
  info: jsonb("info").notNull().default({}),          // { stawkaEurocash: [[...]] }
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Фабричні правила розкладу konto/готівка сводної — версійні, «діє з» (місяць
// цілком: правило чинне для сводної місяця, в який потрапляє effectiveFrom;
// вибирається найсвіжіша версія з effective_from ≤ кінець місяця). Фабрика без
// записів працює за legacy-правилами в services/svodni.ts (legacyPayoutRule).
export const factoryPayoutRulesTable = pgTable("factory_payout_rules", {
  id: serial("id").primaryKey(),
  factoryId: integer("factory_id").notNull().references(() => factoriesTable.id, { onDelete: "cascade" }),
  effectiveFrom: date("effective_from").notNull(),
  capH: real("cap_h"),                       // стеля konto-годин (NULL = без стелі)
  capHighH: real("cap_high_h"),              // підвищена стеля (від capThresholdH відпрацьованих)
  capThresholdH: real("cap_threshold_h"),    // поріг відпрацьованих годин для підвищеної стелі
  capFirm: text("cap_firm"),                 // стеля лише для цієї фірми (ES на Sushi); NULL = усі
  cashBonus: real("cash_bonus").notNull().default(0),           // готівковий бонус до ставки, зл/год (гейт — галочка профілю)
  stazBonus: boolean("staz_bonus").notNull().default(false),    // стажевий бонус увімкнено
  stazMinHours: real("staz_min_hours"),      // мін. годин/міс для стажевого (NULL = без порога)
  stazSteps: jsonb("staz_steps"),            // сходинки [{days, add}] за днями стажу на кінець місяця
  premiaCash: boolean("premia_cash").notNull().default(false),  // колонка Premia — завжди готівкою (крім студентів до 26)
  note: text("note"),
  createdBy: integer("created_by").references(() => adminsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("factory_payout_rules_uq").on(t.factoryId, t.effectiveFrom)]);

// ── Штрафи (kary) ───────────────────────────────────────────────────────────
// Рахується наживо: години з обліку (рапорт → підтверджені явки), ставки з
// налаштувань фабрик, аванси/штрафи/хостели зі своїх вкладок. У БД живе лише
// ручний шар (правки безформульних колонок, додані вручну люди) і локи-заморозки.

// Штрафи: зняття з ЗП за місяць (аналог hostel_deductions)
export const penaltiesTable = pgTable("penalties", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // YYYY-MM
  workerId: integer("worker_id").notNull().references(() => workersTable.id),
  city: text("city"),
  factoryId: integer("factory_id").references(() => factoriesTable.id),
  factoryLabel: text("factory_label"),
  amount: real("amount").notNull(),
  note: text("note"),
  // Перенесення в Kara сводної (дзеркало worker_badania.deducted)
  deducted: boolean("deducted").notNull().default(false),
  deductedAt: date("deducted_at"),
  deductedMonth: text("deducted_month"), // YYYY-MM сводної, з якої знято
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
  cleaningProjectId: integer("cleaning_project_id").references(() => cleaningProjectsTable.id), // вспульнота: sale — override NIP-матчу, purchase (segment=cleaning) — атрибуція видатку
  invoiceHash: text("invoice_hash"),            // KSeF metadata hash
  correctedHash: text("corrected_hash"),        // korekta → hash of the corrected invoice
  paidDate: date("paid_date"),                  // from bank matching (by invoice number in title)
  paidTxnId: integer("paid_txn_id"),            // bank_transactions.id
  paidVia: text("paid_via"),                    // bank | register | korekta (how auto-paid was decided)
  manualStatus: text("manual_status"),          // paid | unpaid | NULL (auto)
  manualPaidDate: date("manual_paid_date"),
  dueDate: date("due_date"),                    // термін оплати (з XML фактури; можна правити вручну)
  paymentMethod: text("payment_method"),        // przelew | gotowka | NULL = авто (банк/XML)
  paymentMethodXml: text("payment_method_xml"), // метод з XML (FormaPlatnosci) — авто-фолбек
  cashReport: boolean("cash_report").notNull().default(false), // «рапорт готівковий»
  manualCategory: text("manual_category"),      // ручна категорія витрат (expense_categories.key; NULL = авто по правилах/патернах)
  xmlPath: text("xml_path"),                    // локальна копія XML (uploads/ksef-xml/)
  driveFileId: text("drive_file_id"),           // XML на Google Drive (Faktury kosztowe/sprzedażowe)
  drivePdfId: text("drive_pdf_id"),             // PDF-візуалізація поряд з XML (лінк веб-панелі веде сюди)
  driveError: text("drive_error"),              // чому файла нема на Drive
  driveSyncedAt: timestamp("drive_synced_at"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("ksef_invoices_number_kind_uniq").on(t.ksefNumber, t.kind),
]);

// P&L, блок «Фактичні платежі»: ручні суми VAT/ZUS по фірмах за місяць
// (платяться в M+1 за M; вносить власник руками).
export const pnlManualItemsTable = pgTable("pnl_manual_items", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(), // YYYY-MM — місяць, ЗА який податок
  kind: text("kind").notNull(),                // vat | zus
  firm: text("firm").notNull(),
  amount: real("amount").notNull().default(0),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("pnl_manual_items_uniq").on(t.periodMonth, t.kind, t.firm),
]);

// ── Пальне: фактури Orlen (флотові картки) ─────────────────────────────────
// Zbiorcze «Rozliczenie» від ORLEN S.A.: шапка фактури + детальний wykaz
// транзакцій по картках — паливо в літрах і непаливні позиції (автострада,
// AdBlue, товари). Аналітика місто/водій/авто йде через довідник fuel_cards.
// Повторний імпорт фактури з тим самим номером замінює її транзакції.
export const fuelInvoicesTable = pgTable("fuel_invoices", {
  id: serial("id").primaryKey(),
  number: text("number").notNull().unique(),      // «Rozliczenie Nr 0491322177»
  invoiceDate: date("invoice_date").notNull(),    // Płock, dnia
  saleDate: date("sale_date"),                    // Data sprzedaży (кінець періоду)
  ksefNumber: text("ksef_number"),
  net: real("net").notNull().default(0),          // рядок «Ogółem»
  vat: real("vat").notNull().default(0),
  gross: real("gross").notNull().default(0),
  fileName: text("file_name"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

export const fuelTransactionsTable = pgTable("fuel_transactions", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => fuelInvoicesTable.id, { onDelete: "cascade" }),
  lp: integer("lp").notNull(),                    // порядковий № рядка у wykaz-і фактури
  cardNumber: text("card_number").notNull(),
  regNumber: text("reg_number"),                  // номер авто з фактури (буває порожній)
  product: text("product").notNull(),             // EFECTA DIESEL, VERVA ON, PRZEJAZD AUTOSTRADĄ A2…
  isFuel: boolean("is_fuel").notNull(),           // секція wykaz-у: паливо (літри) чи товар/послуга (шт)
  stationCity: text("station_city"),              // місто станції з фактури (де фізично заправились)
  stationNo: text("station_no"),
  txDate: date("tx_date").notNull(),              // дата транзакції — місяць аналітики рахується з неї
  txTime: text("tx_time"),                        // HH:MM:SS
  qty: real("qty").notNull(),                     // літри (паливо) або штуки
  unitPrice: real("unit_price"),
  priceAfterRebate: real("price_after_rebate"),   // ціна/л після рабату (лише паливо)
  vatRate: real("vat_rate"),                      // null = ND
  net: real("net").notNull(),
  vatAmount: real("vat_amount").notNull(),
  gross: real("gross").notNull(),
}, t => [
  uniqueIndex("fuel_tx_invoice_lp_uniq").on(t.invoiceId, t.lp),
]);

// Довідник флотових карток: мапінг картка → місто команди / водій / авто.
// Місто тут — основний розріз «кошти на місто» (не місто станції).
export const fuelCardsTable = pgTable("fuel_cards", {
  id: serial("id").primaryKey(),
  cardNumber: text("card_number").notNull().unique(),
  label: text("label"),                           // хто користується / призначення
  city: text("city"),
  driverId: integer("driver_id").references(() => driversTable.id),
  vehicleId: integer("vehicle_id").references(() => vehiclesTable.id),
  note: text("note"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
export type VehicleExpense = typeof vehicleExpensesTable.$inferSelect;
export type VehicleServiceInvoice = typeof vehicleServiceInvoicesTable.$inferSelect;
export type DriverTripLog = typeof driverTripLogTable.$inferSelect;
export type DriverTripRate = typeof driverTripRatesTable.$inferSelect;
export type TransportDeduction = typeof transportDeductionsTable.$inferSelect;
export type HostelRoom = typeof hostelRoomsTable.$inferSelect;
export type HostelPayment = typeof hostelPaymentsTable.$inferSelect;
export type ClothingItem = typeof clothingItemsTable.$inferSelect;
export type ShiftCancellation = typeof shiftCancellationsTable.$inferSelect;
export type FactoryShiftOverride = typeof factoryShiftOverridesTable.$inferSelect;
export type Candidate = typeof candidatesTable.$inferSelect;
export type AbsenceRequest = typeof absenceRequestsTable.$inferSelect;
export type Company = typeof companiesTable.$inferSelect;
export type BankTransaction = typeof bankTransactionsTable.$inferSelect;
export type BankStatementRow = typeof bankStatementsTable.$inferSelect;
export type BankApiConsent = typeof bankApiConsentsTable.$inferSelect;
export type BankApiAccount = typeof bankApiAccountsTable.$inferSelect;
export type Counterparty = typeof counterpartiesTable.$inferSelect;
export type WorkerBankAccount = typeof workerBankAccountsTable.$inferSelect;
export type CashEntry = typeof cashEntriesTable.$inferSelect;
export type CashCategory = typeof cashCategoriesTable.$inferSelect;
export type CashReconAck = typeof cashReconAcksTable.$inferSelect;
export type AdminSession = typeof adminSessionsTable.$inferSelect;
export type LoginEvent = typeof loginEventsTable.$inferSelect;
export type Penalty = typeof penaltiesTable.$inferSelect;
export type FuelInvoice = typeof fuelInvoicesTable.$inferSelect;
export type FuelTransaction = typeof fuelTransactionsTable.$inferSelect;
export type FuelCard = typeof fuelCardsTable.$inferSelect;

// Умови (umowy cywilnoprawne) з Gratyfikant nexo — знімок вивантаження по
// підмiоту (файл зі списком умов у Налаштуваннях → Gratyfikant). Кожен імпорт
// ЗАМІНЮЄ всі рядки своєї фірми. Живить попередження експорту ліст на /svodni:
// «умови немає», «умова скінчилась до місяця праці», «умова в іншій фірмі».
export const gratyfikantUmowyTable = pgTable("gratyfikant_umowy", {
  id: serial("id").primaryKey(),
  firm: text("firm").notNull(),                  // підмiot nexo: ES | ESO | Klinex
  nexoName: text("nexo_name").notNull(),         // Pracownik як записаний у nexo
  workerId: integer("worker_id").references(() => workersTable.id), // NULL = не зматчено з профілем
  umowaNr: text("umowa_nr").notNull(),
  odDnia: text("od_dnia"),                       // YYYY-MM-DD
  doDnia: text("do_dnia"),
  dzial: text("dzial"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});
export type GratyfikantUmowa = typeof gratyfikantUmowyTable.$inferSelect;

// ── Прибирання (окремий бізнес, розділ /cleaning, cap `cleaning`) ─────────────
// Вспульноти мешканьові (проєкти прибирання). Дохід = KSeF-продажі сегмента
// cleaning; матч фактури до проєкту — по NIP покупця (?? ручна привʼязка
// ksef_invoices.cleaning_project_id). Реєстр сідиться кнопкою з KSeF + ручний CRUD.
export const cleaningProjectsTable = pgTable("cleaning_projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  nip: text("nip").unique(),                    // NIP вспульноти (10 цифр) — ключ авто-матчу доходу
  active: boolean("active").notNull().default(true),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Винагродження прибирання: вільний список людей (без привʼязки до workers) по
// місяцях. Разом = podstawa (base) + додаткові години×ставка + Σ складових
// (доплати/відрахування з підписами, як у власника: plewienie, krew, zastępstwo,
// komornik −300 …). konto — частина на рахунок; готівка = разом − konto (типово
// все готівкою).
export const cleaningPayrollsTable = pgTable("cleaning_payrolls", {
  id: serial("id").primaryKey(),
  periodMonth: text("period_month").notNull(),  // YYYY-MM
  name: text("name").notNull(),
  base: real("base").notNull().default(0),      // podstawa — базова місячна сума (окремо від додаткових годин)
  hours: real("hours"),                         // додаткові години
  rate: real("rate"),
  components: jsonb("components").notNull().default([]), // [{label, amount}] — amount може бути відʼємним (komornik)
  total: real("total").notNull().default(0),    // підсумок; сервер перераховує при кожному записі
  konto: real("konto").notNull().default(0),    // частина на конто; готівка = total − konto
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ЗП людини ділиться ПОРІВНУ між привʼязаними вспульнотами (P&L по проєктах);
// без привʼязок — «нерозподілене» у P&L.
export const cleaningPayrollProjectsTable = pgTable("cleaning_payroll_projects", {
  id: serial("id").primaryKey(),
  payrollId: integer("payroll_id").notNull().references(() => cleaningPayrollsTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => cleaningProjectsTable.id),
}, t => [uniqueIndex("cleaning_payroll_projects_uniq").on(t.payrollId, t.projectId)]);

export type CleaningProject = typeof cleaningProjectsTable.$inferSelect;
export type CleaningPayroll = typeof cleaningPayrollsTable.$inferSelect;

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Shift = "1" | "2" | "3" | "4" | "5" | "6";

export const insertWorkerSchema = createInsertSchema(workersTable).omit({ id: true, createdAt: true });
export const insertDriverSchema = createInsertSchema(driversTable).omit({ id: true, createdAt: true });
export const insertFactorySchema = createInsertSchema(factoriesTable).omit({ id: true, createdAt: true });
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
