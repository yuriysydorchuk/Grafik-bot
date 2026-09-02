ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS mother_name text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS father_name text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS school_name text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS is_registered_unemployed boolean NOT NULL DEFAULT false;
