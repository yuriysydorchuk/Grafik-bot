-- Зголошення #23 (рішення власника 05.11.2026): офіс-менеджер може обʼєднувати дублі профілів.
-- Нове право mergeWorkers існує в каталозі lib/roles.ts обох пакетів (гейт MERGE в admin-api:
-- editData | mergeWorkers; обидва профілі мають бути в скоупі адміна). Ідемпотентно.
UPDATE roles SET caps = caps || '["mergeWorkers"]'::jsonb WHERE key = 'office_manager' AND NOT caps ? 'mergeWorkers';
