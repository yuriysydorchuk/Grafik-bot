-- Умови з Gratyfikant nexo: знімок вивантаження по підмiоту (імпорт у
-- Налаштуваннях → Gratyfikant заміняє рядки своєї фірми). Живить попередження
-- експорту ліст на /svodni (нема умови / скінчилась / інша фірма).
CREATE TABLE IF NOT EXISTS gratyfikant_umowy (
  id serial PRIMARY KEY,
  firm text NOT NULL,
  nexo_name text NOT NULL,
  worker_id integer REFERENCES workers(id),
  umowa_nr text NOT NULL,
  od_dnia text,
  do_dnia text,
  dzial text,
  imported_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gratyfikant_umowy_firm_idx ON gratyfikant_umowy(firm);
CREATE INDEX IF NOT EXISTS gratyfikant_umowy_worker_idx ON gratyfikant_umowy(worker_id);
