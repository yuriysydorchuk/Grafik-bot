---
name: DB migration approach for this project
description: How to safely apply schema changes when drizzle-kit push requires TTY
---

## Rule
`drizzle-kit push` fails in non-TTY environments (bash tool, CI) when there are conflicting/renamed tables. It asks interactive confirmation.

## How to apply
1. For NEW tables (no existing data): use raw `pg` SQL `CREATE TABLE` statements executed via `node --input-type=module` in the lib/db directory (which has pg in scope).
2. For EXISTING tables needing column changes: use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` via raw SQL.
3. Drop old tables first if doing a full redesign: `DROP TABLE IF EXISTS ... CASCADE` before recreating.
4. After raw SQL migration, update `lib/db/src/schema/workers.ts` to match, then `pnpm run typecheck:libs` to rebuild declarations.

**Why:** The CI/sandbox bash tool never has a TTY, so interactive prompts crash drizzle-kit push even with --force.

## Existing table quirks (as of last migration)
- `workers` table: originally had `name`, `phone`, `address` columns (old schema). Now has `full_name` added. Old columns still present but ignored by Drizzle schema.
- `drivers` table: had `is_head_driver` added via ALTER TABLE.
- All new tables (factory_orders, availability, schedule_weeks, schedule_entries, driver_shift_assignments) were created fresh.
