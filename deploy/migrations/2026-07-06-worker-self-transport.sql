-- Workers who get to work on their own transport: hidden from drivers (boarding,
-- pickup counts, pre-shift driver reminder), never auto-marked absent — the
-- scheduler marks their presence/absence manually in the web schedule.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS self_transport boolean NOT NULL DEFAULT false;
