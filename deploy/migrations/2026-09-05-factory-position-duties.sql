-- Обов'язки в умові по посадах фабрики (05.09.2026): {%Czynności%} резолвиться
-- посада на фабриці → factories.contract_duties → назва посади.
ALTER TABLE factory_positions ADD COLUMN IF NOT EXISTS contract_duties text;
