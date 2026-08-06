-- Eurocash: розрахунковий файл фабрики несе більше за години — нічні,
-- продуктивність, ставка агенції за порогом, потроненя, korekta/końcowe.
-- Зберігаємо в extras jsonb рядка factory_hours (пара працівник×місяць×фабрика).
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS extras jsonb;
