-- Бадання з датами + довідник типів одягу + національність (12.08.2026)
-- 1) залічка за бадання: коли вписано і коли знято (показ у профілі; повна
--    історія правок — журнал worker_changes)
ALTER TABLE workers ADD COLUMN IF NOT EXISTS badania_set_at date;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS badania_deducted_at date;
-- 2) національність: ukraine | belarus | africa | latin_america | central_asia | south_asia
ALTER TABLE workers ADD COLUMN IF NOT EXISTS nationality text;
-- 3) довідник типів одягу (склад/видача читають назви звідси; key лишається
--    в item_type існуючих рядків — сумісно з міграцією таблиць водія)
CREATE TABLE IF NOT EXISTS clothing_types (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
INSERT INTO clothing_types (key, label, sort_order) VALUES
  ('boots', 'Взуття', 10), ('coverall', 'Комбінезон', 20), ('jacket', 'Куртка', 30),
  ('hat', 'Шапка', 40), ('tshirt', 'Футболка', 50), ('set', 'Комплект', 60), ('other', 'Інше', 70)
ON CONFLICT (key) DO NOTHING;
