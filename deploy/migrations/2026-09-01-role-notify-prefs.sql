-- Per-role bot notification preferences (granular, independent of caps).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS notify jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill every existing role (incl. owner) with the full catalog so nothing
-- goes silent at deploy time — narrowing is a conscious later action via /admins.
-- Scoped to still-default rows so an accidental re-run never clobbers a role
-- someone has since narrowed via the UI.
UPDATE roles SET notify = '["no_show","cancellation","hours_correction","advance","substitution","availability_change","absence_warning","weekly_summary","finance_alerts"]'::jsonb
WHERE notify = '[]'::jsonb;
