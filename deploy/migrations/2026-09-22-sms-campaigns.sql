-- SMS-кампанії (узгоджено 21.09.2026, docs/tasks/2026-09-21-sms-campaigns.md):
-- кампанії, персональні отримувачі з токен-лінками, журнал подій; джерело кандидата.
-- Ідемпотентно.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS campaign_id integer;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS language text;

CREATE TABLE IF NOT EXISTS sms_campaigns (
  id serial PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'job',
  status text NOT NULL DEFAULT 'draft',
  provider text NOT NULL DEFAULT 'smsapi',
  sender text NOT NULL DEFAULT 'EuroSupport',
  texts jsonb NOT NULL DEFAULT '{}'::jsonb,
  landing jsonb NOT NULL DEFAULT '{}'::jsonb,
  offer jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule jsonb NOT NULL DEFAULT '{"days":[2,3,4],"from":"10:00","to":"14:00","dailyLimit":1500,"batchSize":200}'::jsonb,
  recruiter_admin_id integer REFERENCES admins(id),
  funnel_id integer REFERENCES funnels(id),
  created_by integer REFERENCES admins(id),
  started_at timestamp,
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_recipients (
  id serial PRIMARY KEY,
  campaign_id integer NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text,
  first_name text,
  lang text NOT NULL DEFAULT 'uk',
  segment text,
  year integer,
  source_file text,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued',
  skipped_reason text,
  worker_id integer REFERENCES workers(id),
  candidate_id integer REFERENCES candidates(id),
  provider_msg_id text,
  parts integer,
  sent_at timestamp,
  delivered_at timestamp,
  fail_reason text,
  viewed_at timestamp,
  bot_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_recipients_campaign_status_idx ON sms_recipients (campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS sms_recipients_campaign_phone_uq ON sms_recipients (campaign_id, phone);

CREATE TABLE IF NOT EXISTS sms_events (
  id serial PRIMARY KEY,
  recipient_id integer NOT NULL REFERENCES sms_recipients(id) ON DELETE CASCADE,
  kind text NOT NULL,
  at timestamp NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  device text,
  meta jsonb
);
CREATE INDEX IF NOT EXISTS sms_events_recipient_idx ON sms_events (recipient_id);
