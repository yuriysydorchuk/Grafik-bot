-- Поля Oświadczenie do celów ZUS / podatkowych (worker-docs-signing), відсутні
-- в первісній анкеті: NIP (опційний), PIT-0, 5 ZUS-декларацій (усі default false),
-- адреса податкової, гранульна адреса зальмедування й проживання.
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS nip text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS pit0 boolean NOT NULL DEFAULT false;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS ankieta_inny_pracodawca boolean NOT NULL DEFAULT false;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS ankieta_emeryt boolean NOT NULL DEFAULT false;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS ankieta_rencista boolean NOT NULL DEFAULT false;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS ankieta_niepelnosprawnosc boolean NOT NULL DEFAULT false;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS ankieta_skladka_chorobowa boolean NOT NULL DEFAULT false;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS tax_office_address text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_wojewodztwo text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_powiat text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_gmina text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_miejscowosc text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_ulica text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_numer_domu text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS reg_kod_pocztowy text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_wojewodztwo text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_powiat text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_gmina text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_miejscowosc text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_ulica text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_numer_domu text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS zam_kod_pocztowy text;
