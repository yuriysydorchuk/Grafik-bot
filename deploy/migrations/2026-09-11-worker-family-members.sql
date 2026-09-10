-- Члени родини для ZUS ZCNA (рішення власника 10.09.2026). Дзеркало lib/db/src/schema/workers.ts
-- (workerFamilyMembersTable). Ідемпотентно.
CREATE TABLE IF NOT EXISTS worker_family_members (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  action text NOT NULL DEFAULT 'zgloszenie',
  rights_date date,
  pesel text,
  doc_kind text,
  doc_number text,
  last_name text NOT NULL,
  first_name text NOT NULL,
  birth_date date,
  relation_code text NOT NULL,
  shared_household boolean NOT NULL DEFAULT true,
  disability_code text,
  address_differs boolean NOT NULL DEFAULT false,
  postal_code text, city text, gmina text, street text, house_no text, flat_no text, phone text, country_code text, foreign_postal text,
  source text NOT NULL DEFAULT 'worker',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_family_members_worker_idx ON worker_family_members(worker_id);
