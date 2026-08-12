-- Бадання: список залічок замість одного поля (12.08.2026, друга ітерація).
-- Одне поле не давало додати нову залічку після зняття старої і тягнуло
-- статус «знято» на змінену суму. Кожен запис — своя сума/дати/статус.
CREATE TABLE IF NOT EXISTS worker_badania (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  amount real NOT NULL,
  entered_at date NOT NULL,          -- коли вписано
  deducted boolean NOT NULL DEFAULT false,
  deducted_at date,                  -- коли знято з ЗП
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_badania_worker_idx ON worker_badania(worker_id);
-- перенесення наявних одиночних значень (ідемпотентно: лише поки старі колонки існують)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workers' AND column_name = 'badania_zaliczka') THEN
    INSERT INTO worker_badania (worker_id, amount, entered_at, deducted, deducted_at)
      SELECT id, badania_zaliczka, coalesce(badania_set_at, CURRENT_DATE), badania_deducted, badania_deducted_at
      FROM workers WHERE badania_zaliczka IS NOT NULL;
  END IF;
END $$;
ALTER TABLE workers DROP COLUMN IF EXISTS badania_zaliczka;
ALTER TABLE workers DROP COLUMN IF EXISTS badania_deducted;
ALTER TABLE workers DROP COLUMN IF EXISTS badania_set_at;
ALTER TABLE workers DROP COLUMN IF EXISTS badania_deducted_at;
-- з якої сводної знято (перенесення «Бадання до зняття» → колонка Zaliczka BD)
ALTER TABLE worker_badania ADD COLUMN IF NOT EXISTS deducted_month text;
