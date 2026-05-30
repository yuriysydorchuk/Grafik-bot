# Employment Agency Schedule Bot

A Telegram bot for employment agencies to manage daily worker schedules and driver delivery routes to factories.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Telegram bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- Required secret: `GOOGLE_SERVICE_ACCOUNT_JSON` — service account JSON for Sheets + Drive
- Required secret: `GOOGLE_SHEETS_ID` — the availability spreadsheet ID

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: Telegraf (Telegram Bot SDK)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)
- Google APIs: googleapis (Sheets + Drive)
- Excel: xlsx (schedule export, hours tracking)
- Scheduler: node-cron (weekly reminders)

## Where things live

- `artifacts/api-server/src/bot/index.ts` — All Telegram bot logic (~1700 lines)
- `artifacts/api-server/src/services/drive.ts` — Google Drive integration
- `artifacts/api-server/src/services/sheets.ts` — Google Sheets reader
- `artifacts/api-server/src/services/scheduleGenerator.ts` — Schedule generation algorithm
- `artifacts/api-server/src/services/scheduler.ts` — Cron scheduler for reminders
- `lib/db/src/schema/workers.ts` — Full DB schema

## DB Tables

- `workers` — fullName, telegramId, workerCode (4-digit auto-generated), status (active/fired)
- `drivers` — name, telegramId, isHeadDriver
- `factories` — name, address
- `factory_orders` — weekly orders per factory/day/shift
- `availability` — worker availability from Google Sheets
- `schedule_weeks` — weekly schedules (draft/approved), driveFileId for Drive link
- `schedule_entries` — individual assignments (worker × factory × day × shift × status)
- `driver_shift_assignments` — which driver handles which shift
- `absence_requests` — worker self-reported absences + substitute tracking
- `driver_trips` — trip start/arrive timestamps for lateness tracking
- `unplanned_workers` — extra workers driver adds at runtime
- `settings` — key-value store (Drive folder IDs, hours file IDs, etc.)
- `admins` — admin Telegram IDs

## Architecture decisions

- Bot runs in long-polling mode (no webhook)
- Multi-step conversation flows tracked in-memory via `pending` Map (keyed by Telegram user ID)
- Admin must be registered first via `/adminsetup`
- Workers self-register via invite link (`?start=join`) or direct code link (`?start=CODE`)
- Worker codes are 4-digit auto-incremented (0001, 0042, etc.)
- Google Drive folder structure auto-created at first ☁️ Google Drive button press
- Drive folder IDs cached in `settings` table to avoid redundant API calls
- Schedule approval automatically exports Excel to Drive
- Callback query inline buttons used for absence approval (approve/substitute/reject)
- Shift expected times: pickup 1h before start, factory 15min before start

## Shift times

- Shift 1: 06:00–14:00 → pickup 05:00, factory 05:45
- Shift 2: 14:00–22:00 → pickup 13:00, factory 13:45
- Shift 3: 22:00–06:00 → pickup 21:00, factory 21:45

## Product features by role

**Admin:**
- Add/manage workers (auto-generates code + invite link)
- Fire workers (sets status=fired, isActive=false)
- Link Telegram IDs to workers/drivers
- Manage factories + driver assignments
- Create factory orders, read Google Sheets, generate/approve schedule
- Approve schedule → auto-exports Excel to Google Drive
- Broadcast schedule to all workers/drivers
- Weekly reminders for sheet filling (configurable time, cron)
- Google Drive folder structure + links
- Receives absence requests with inline substitute buttons
- Receives absent-at-pickup notifications from drivers

**Worker:**
- View weekly schedule (factory, shift)
- Declare absence for a shift (reason → admin notified + substitutes listed)
- View own info + code + invite link
- Submit monthly report photo → saved to Drive per factory/month folder

**Head Driver:**
- Assign drivers to shifts
- View full weekly schedule

**Driver:**
- View today's shift + full week
- Mark attendance (present/absent per worker)
- Report trip start → records pickup time + lateness check
- Report factory arrival → records arrival time + lateness check
- Report workers who didn't show up (separate from attendance flow)
- Add unplanned workers to a shift

## Gotchas

- `drizzle-kit push` fails non-TTY — use raw `pg` SQL (`node --input-type=module` in `lib/db/`) for schema changes
- After changing lib schema, run `pnpm run typecheck:libs` to rebuild lib declarations before typechecking artifacts
- Bot uses polling — only one instance should run at a time
- Google Sheets must be shared with `grafik@grafik-bot-497821.iam.gserviceaccount.com`
- Same service account needs Google Drive access (drive scope added to auth)
- Sheets column 3 = "Surname Name" (combined) — used for worker matching; columns 6-12 = Mon-Sun availability
- Shift values in sheet: "1 shift (8h)", "2 shift (8h)", "3 shift (8h)", "day off"
- Drive folders are created owned by service account; shared with anyone-with-link (reader)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
