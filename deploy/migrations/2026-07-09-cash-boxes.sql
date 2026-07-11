-- Cash boxes: office safe vs owner safes (Yuriy / Tetiana). Company cash, box-scoped.
ALTER TABLE cash_entries ADD COLUMN IF NOT EXISTS box text NOT NULL DEFAULT 'office';
CREATE INDEX IF NOT EXISTS cash_entries_box_month_idx ON cash_entries (box, period_month);
-- Transfers between boxes: two linked legs, internal (cancel out in consolidated totals)
ALTER TABLE cash_entries ADD COLUMN IF NOT EXISTS transfer_group text;
-- Manual category override for cash outflows (auto-classified from description otherwise)
ALTER TABLE cash_entries ADD COLUMN IF NOT EXISTS manual_category text;
