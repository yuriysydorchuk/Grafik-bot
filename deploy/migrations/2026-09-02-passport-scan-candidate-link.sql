ALTER TABLE passport_scan_tokens ADD COLUMN IF NOT EXISTS candidate_id integer REFERENCES candidates(id);
