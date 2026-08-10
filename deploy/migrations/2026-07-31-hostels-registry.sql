-- Довідник хостелів + проживання працівників + привʼязка фактур до хостелу.
-- Етап 1 «правильного P&L»: місто → хостели (ціна, кауція, модель оренди),
-- hostel_stays = хто де живе і скільки платить, invoices.hostel_id = рахунки
-- за оренду/медіа конкретного хостелу.

CREATE TABLE IF NOT EXISTS hostels (
  id serial PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL,
  address text,
  rent_model text NOT NULL DEFAULT 'whole',      -- whole | per_place
  monthly_cost real,                             -- zł/міс, що платимо ми (per_place — за місце)
  places integer,
  kaucja real,
  kaucja_note text,
  worker_rate real,                              -- типове зняття з мешканця, zł/міс
  landlord text,
  company_id integer REFERENCES companies(id),
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hostel_stays (
  id serial PRIMARY KEY,
  hostel_id integer NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  from_date date NOT NULL,
  to_date date,                                  -- NULL = живе зараз
  monthly_rate real,                             -- NULL = worker_rate хостелу
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hostel_stays_hostel_idx ON hostel_stays(hostel_id);
CREATE INDEX IF NOT EXISTS hostel_stays_worker_idx ON hostel_stays(worker_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hostel_id integer REFERENCES hostels(id) ON DELETE SET NULL;
