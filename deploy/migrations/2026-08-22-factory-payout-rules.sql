-- Фабричні правила розкладу konto/готівка сводної — версійні, з датою «діє з»
-- (місяць цілком: правило чинне для сводної місяця, в який потрапляє
-- effective_from). Фабрика без записів працює за legacy-правилами, зашитими в
-- services/svodni.ts (стелі LST/DEZYNFEKCJA/SERWIS PLUS 60/70 і Sushi ES 80,
-- бонуси Agram/LST, Premia Agram готівкою) — свідомо без сіду: id фабрик
-- різняться між локальною і прод-базами.
CREATE TABLE IF NOT EXISTS factory_payout_rules (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  cap_h real,                                 -- стеля konto-годин (NULL = без стелі)
  cap_high_h real,                            -- підвищена стеля (від cap_threshold_h відпрацьованих)
  cap_threshold_h real,                       -- поріг відпрацьованих годин для підвищеної стелі
  cap_firm text,                              -- стеля лише для цієї фірми (ES на Sushi); NULL = усі
  cash_bonus real NOT NULL DEFAULT 0,         -- готівковий бонус до ставки, зл/год (гейт — галочка профілю)
  staz_bonus boolean NOT NULL DEFAULT false,  -- стажевий бонус увімкнено (галочка профілю + дата працевлаштування)
  staz_min_hours real,                        -- мін. годин/міс для стажевого (NULL = без порога)
  staz_steps jsonb,                           -- сходинки [{days, add}] за днями стажу на кінець місяця
  premia_cash boolean NOT NULL DEFAULT false, -- колонка Premia — завжди готівкою (крім студентів до 26)
  note text,
  created_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_payout_rules_uq ON factory_payout_rules (factory_id, effective_from);
