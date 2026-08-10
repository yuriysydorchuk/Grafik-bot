-- Пальне: фактури Orlen (флотові картки) — облік і аналітика витрат
-- по місяцях × місто / водій / авто. Див. services/orlenFuel.ts + routes/fuel.ts.

CREATE TABLE IF NOT EXISTS fuel_invoices (
  id            serial PRIMARY KEY,
  number        text NOT NULL UNIQUE,
  invoice_date  date NOT NULL,
  sale_date     date,
  ksef_number   text,
  net           real NOT NULL DEFAULT 0,
  vat           real NOT NULL DEFAULT 0,
  gross         real NOT NULL DEFAULT 0,
  file_name     text,
  imported_at   timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fuel_transactions (
  id                 serial PRIMARY KEY,
  invoice_id         integer NOT NULL REFERENCES fuel_invoices(id) ON DELETE CASCADE,
  lp                 integer NOT NULL,
  card_number        text NOT NULL,
  reg_number         text,
  product            text NOT NULL,
  is_fuel            boolean NOT NULL,
  station_city       text,
  station_no         text,
  tx_date            date NOT NULL,
  tx_time            text,
  qty                real NOT NULL,
  unit_price         real,
  price_after_rebate real,
  vat_rate           real,
  net                real NOT NULL,
  vat_amount         real NOT NULL,
  gross              real NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS fuel_tx_invoice_lp_uniq ON fuel_transactions (invoice_id, lp);
CREATE INDEX IF NOT EXISTS fuel_tx_date_idx ON fuel_transactions (tx_date);
CREATE INDEX IF NOT EXISTS fuel_tx_card_idx ON fuel_transactions (card_number);

CREATE TABLE IF NOT EXISTS fuel_cards (
  id          serial PRIMARY KEY,
  card_number text NOT NULL UNIQUE,
  label       text,
  city        text,
  driver_id   integer REFERENCES drivers(id),
  vehicle_id  integer REFERENCES vehicles(id),
  note        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamp NOT NULL DEFAULT now()
);
