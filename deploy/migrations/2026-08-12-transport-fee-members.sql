-- Вибірковий платний довіз (12.08.2026): список «хто платить» на фабриці з
-- paid_transport. Порожній список = платить уся фабрика (поведінка як досі);
-- є рядки — авторозрахунок знять тарифікує лише вибраних. Ціна/ліміт — фабричні.
CREATE TABLE IF NOT EXISTS transport_fee_members (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS transport_fee_members_uq ON transport_fee_members (factory_id, worker_id);
