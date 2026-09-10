-- Рішення власника 10.09.2026: świadectwo pracy при звільненні НЕ видаємо (помилка 08.09).
-- Шаблон вимикаємо (ланцюжок звільнення його більше не бере — код перебудовано на
-- zaświadczenie/wypowiedzenie, services/contractEndDocs.ts). Ідемпотентно.
UPDATE document_templates SET is_active = false, updated_at = now() WHERE kind = 'swiadectwo' AND is_active;
