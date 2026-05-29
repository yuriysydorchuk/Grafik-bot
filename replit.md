# Employment Agency Schedule Bot

A Telegram bot for employment agencies to manage daily worker schedules and driver delivery routes to factories.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Telegram bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: Telegraf (Telegram Bot SDK)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/index.ts` — All Telegram bot logic (commands, menus, flows)
- `lib/db/src/schema/workers.ts` — DB schema: workers, drivers, factories, schedules, admins
- `lib/db/src/schema/index.ts` — Schema barrel export

## Architecture decisions

- Bot runs in long-polling mode (no webhook) for simplicity in development/staging
- Multi-step conversation flows tracked in-memory via `pendingActions` Map (keyed by Telegram user ID)
- Admin must be registered first via `/adminsetup` (only first admin can self-register; subsequent admins must be added by existing admin)
- Workers/drivers must send `/getid` to share their Telegram ID, which admin then links to their record

## Product

- **Admin**: Add/manage workers, drivers, factories; create daily schedules; notify all workers/drivers; view summaries
- **Worker**: View today's and weekly schedule, factory address, driver info
- **Driver**: View today's and weekly route, pickup list with worker addresses, mark pickups done

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `drizzle-kit push` fails non-TTY — use raw `pg` SQL (`node --input-type=module` in `lib/db/`) for schema changes
- After changing lib schema, run `pnpm run typecheck:libs` to rebuild lib declarations before typechecking artifacts
- Bot uses polling — only one instance should run at a time
- Google Sheets must be shared with `grafik@grafik-bot-497821.iam.gserviceaccount.com`
- Sheets column 3 = "Surname Name" (combined) — used for worker matching; columns 6-12 = Mon-Sun availability
- Shift values in sheet: "1 shift (8h)", "2 shift (8h)", "3 shift (8h)", "day off"

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
