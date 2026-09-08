-- Згоди RODO в веб-анкеті працівника (короткі рядки з обов'язковими галочками, 08.09.2026)
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS consents jsonb;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS consents_at timestamp;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS consents_ip text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS consents_user_agent text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS consents_version text;
