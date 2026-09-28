-- Фабрика позапланового рейсу у записі пробігу водія: обирає водій у боті
-- («Почати зміну», коли рейс не покритий призначенням) або офіс у звіті по пробігу.
ALTER TABLE driver_workdays ADD COLUMN IF NOT EXISTS factory_id integer REFERENCES factories(id);
