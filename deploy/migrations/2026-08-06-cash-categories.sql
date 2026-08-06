-- Каса: власний довідник категорій (видатки + приходи) і фіксації розбіжностей звірок.
-- Категорії зарплат розбиті по містах/типах (payroll+city) — по них іде звірка
-- готівкових ЗП зі сводною. Гугл-таблиця STAN KASY виводиться з експлуатації.

CREATE TABLE IF NOT EXISTS cash_categories (
  id serial PRIMARY KEY,
  flow text NOT NULL DEFAULT 'out',
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  city text,
  payroll text,
  requires_desc boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cash_recon_acks (
  id serial PRIMARY KEY,
  side text NOT NULL,
  ref text NOT NULL,
  note text,
  created_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_recon_acks_uniq ON cash_recon_acks (side, ref);

-- Сід категорій (ON CONFLICT — міграцію можна накатувати повторно).
INSERT INTO cash_categories (flow, key, label, city, payroll, requires_desc, sort_order) VALUES
  -- видатки: зарплатна сімʼя
  ('out', 'salary_fab_lublin',    'Зарплата фабрики Люблін',        'Люблін',  'factory',  false, 10),
  ('out', 'salary_fab_lodz',      'Зарплата фабрики Лодзь',         'Лодзь',   'factory',  false, 11),
  ('out', 'salary_fab_poznan',    'Зарплата фабрики Познань',       'Познань', 'factory',  false, 12),
  ('out', 'salary_office_lublin', 'Зарплата офіс Люблін',           'Люблін',  'office',   false, 13),
  ('out', 'salary_office_lodz',   'Зарплата офіс Лодзь',            'Лодзь',   'office',   false, 14),
  ('out', 'salary_klinex',        'Зарплата Клінекс (прибирання)',  NULL,      'cleaning', false, 15),
  ('out', 'salary',               'Зарплати (без розбивки, історія)', NULL,    'legacy',   false, 16),
  ('out', 'worker_refund',        'Повернення коштів працівникам',  NULL,      NULL,       true,  20),
  -- видатки: решта (ключі спільні з банківськими категоріями — кешфлоу зливає по ключу)
  ('out', 'zaliczki',             'Аванси (zaliczki)',              NULL, NULL, false, 30),
  ('out', 'permits',              'Дозволи / уряд',                 NULL, NULL, false, 31),
  ('out', 'housing',              'Житло / готелі',                 NULL, NULL, false, 32),
  ('out', 'car_repair',           'Ремонт авто',                    NULL, NULL, false, 33),
  ('out', 'household',            'Госптовари / буд',               NULL, NULL, false, 34),
  ('out', 'services',             'Послуги (бух., юристи)',         NULL, NULL, false, 35),
  ('out', 'marketing',            'Маркетинг',                      NULL, NULL, false, 36),
  ('out', 'office_rent',          'Оренда офісу',                   NULL, NULL, false, 37),
  ('out', 'travel',               'Подорожі / відрядження',         NULL, NULL, false, 38),
  ('out', 'owner_roman',          'Особисте — Сидорчук Роман',      NULL, NULL, false, 40),
  ('out', 'owner_yuriy',          'Особисте — Сидорчук Юрій',       NULL, NULL, false, 41),
  ('out', 'owner_tetiana',        'Особисте — Сидорчук Тетяна',     NULL, NULL, false, 42),
  ('out', 'kokos_external',       'Кокос (чужий бізнес, поза P&L)', NULL, NULL, false, 50),
  ('out', 'deposit',              'Вплата на рахунок',              NULL, NULL, false, 60),
  ('out', 'other',                'Інше',                           NULL, NULL, false, 99),
  -- приходи
  ('in',  'card',                 'Знято з карти',                  NULL, NULL, false, 1),
  ('in',  'hostel_payment',       'Оплата хостела',                 NULL, NULL, false, 10),
  ('in',  'karta_pobytu',         'За карту побиту',                NULL, NULL, false, 11),
  ('in',  'zezwolenie',           'За дозволення (zezwolenie)',     NULL, NULL, false, 12),
  ('in',  'worker_return',        'Повернення від працівника',      NULL, NULL, false, 13),
  ('in',  'from_owner',           'Від власника',                   NULL, NULL, false, 14),
  ('in',  'other_income',         'Інший прихід',                   NULL, NULL, false, 99)
ON CONFLICT (key) DO NOTHING;
