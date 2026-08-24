-- Ручні оверрайди місячного пробігу на /fuel: пара авто × місяць перекриває
-- авто-розрахунок (журнал Любліна / одометри бот-змін). Доступ — raw SQL у
-- routes/fuel.ts (без Drizzle-таблиці).
CREATE TABLE IF NOT EXISTS fuel_km_overrides (
  id serial PRIMARY KEY,
  plate text NOT NULL,       -- номер авто без пробілів, верхній регістр
  month text NOT NULL,       -- YYYY-MM
  km integer NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fuel_km_overrides_uq ON fuel_km_overrides (plate, month);
