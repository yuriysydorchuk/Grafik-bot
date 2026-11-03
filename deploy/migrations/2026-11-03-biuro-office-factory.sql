-- Офіс «Biuro» як фабрика (рішення власника 03.11.2026, зголошення #12): офісні працівники наших фірм
-- (ES / ESO / Klinex) — умова на неї як на будь-яку фабрику (рішення 05.09: «посади без фабрики не буває»).
-- multi_firm: фірма умови — з працівника; без планування, довозу й доступності (не в графіку/Sheets/самореєстрації).
-- Ідемпотентно: лише якщо офісної фабрики ще нема. Місто не ставимо — власник вкаже у Фабриках.
INSERT INTO factories (name, is_office, multi_firm, uses_scheduling, uses_transport, uses_availability, gen_mode, uses_positions)
SELECT 'Biuro', true, true, false, false, false, 'all', true
WHERE NOT EXISTS (SELECT 1 FROM factories WHERE is_office);

-- шаблон «Umowa — BIURO» (досі «лише ручний вибір»: scope factory без фабрик) — тепер підбирається для Biuro сам
UPDATE document_templates t
SET scope_factory_ids = (SELECT jsonb_agg(f.id ORDER BY f.id) FROM factories f WHERE f.is_office),
    title = 'Umowa — BIURO (офісні)', updated_at = now()
WHERE t.kind = 'umowa' AND t.title ILIKE 'Umowa — BIURO%' AND t.scope = 'factory' AND t.scope_factory_ids = '[]'::jsonb
  AND EXISTS (SELECT 1 FROM factories WHERE is_office);
