-- Значки (емодзі) і кольори категорій витрат для UI (/bank, /cost-invoices, каса).
-- Дефолти проставляються лише де icon ще порожній — повторний прогін не затирає
-- правки власника. Нові категорії отримують колір автоматично при створенні.

ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS color text;

UPDATE expense_categories SET icon = '🏛️', color = 'indigo' WHERE key = 'zus' AND icon IS NULL;
UPDATE expense_categories SET icon = '🧾', color = 'purple' WHERE key = 'vat' AND icon IS NULL;
UPDATE expense_categories SET icon = '⚖️', color = 'rose' WHERE key = 'seizure' AND icon IS NULL;
UPDATE expense_categories SET icon = '💰', color = 'emerald' WHERE key = 'salary' AND icon IS NULL;
UPDATE expense_categories SET icon = '💸', color = 'teal' WHERE key = 'zaliczki' AND icon IS NULL;
UPDATE expense_categories SET icon = '🧮', color = 'slate' WHERE key = 'fees' AND icon IS NULL;
UPDATE expense_categories SET icon = '⛽', color = 'orange' WHERE key = 'fuel' AND icon IS NULL;
UPDATE expense_categories SET icon = '🏠', color = 'sky' WHERE key = 'housing' AND icon IS NULL;
UPDATE expense_categories SET icon = '🔧', color = 'amber' WHERE key = 'car_repair' AND icon IS NULL;
UPDATE expense_categories SET icon = '🏢', color = 'blue' WHERE key = 'office_rent' AND icon IS NULL;
UPDATE expense_categories SET icon = '👕', color = 'pink' WHERE key = 'clothing' AND icon IS NULL;
UPDATE expense_categories SET icon = '🏋️', color = 'lime' WHERE key = 'multisport' AND icon IS NULL;
UPDATE expense_categories SET icon = '🥋', color = 'green' WHERE key = 'trainer' AND icon IS NULL;
UPDATE expense_categories SET icon = '🚗', color = 'violet' WHERE key = 'leasing' AND icon IS NULL;
UPDATE expense_categories SET icon = '🏦', color = 'red' WHERE key = 'credit' AND icon IS NULL;
UPDATE expense_categories SET icon = '📑', color = 'cyan' WHERE key = 'services' AND icon IS NULL;
UPDATE expense_categories SET icon = '📣', color = 'fuchsia' WHERE key = 'marketing' AND icon IS NULL;
UPDATE expense_categories SET icon = '📜', color = 'yellow' WHERE key = 'permits' AND icon IS NULL;
UPDATE expense_categories SET icon = '🚕', color = 'yellow' WHERE key = 'taxi' AND icon IS NULL;
UPDATE expense_categories SET icon = '✈️', color = 'sky' WHERE key = 'travel' AND icon IS NULL;
UPDATE expense_categories SET icon = '🛒', color = 'green' WHERE key = 'shops' AND icon IS NULL;
UPDATE expense_categories SET icon = '💻', color = 'indigo' WHERE key = 'tech' AND icon IS NULL;
UPDATE expense_categories SET icon = '🧰', color = 'orange' WHERE key = 'household' AND icon IS NULL;
UPDATE expense_categories SET icon = '💳', color = 'gray' WHERE key = 'card' AND icon IS NULL;
UPDATE expense_categories SET icon = '🤝', color = 'gray' WHERE key = 'b2b' AND icon IS NULL;
