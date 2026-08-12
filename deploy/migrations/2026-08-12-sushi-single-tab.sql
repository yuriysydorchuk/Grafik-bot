-- Sushi&Food: одна вкладка сводної замість двох фірмових (рішення 12.08.2026).
-- Раніше from-hours ділив вкладку суфіксом фірми («Sushi&Food Factory ESO» /
-- «Sushi&Food Factory EURO SUPORT»); тепер вкладка одна, фірма рядка живе в
-- svodni_rows.firm — веб/Excel малюють розділові рядки груп усередині таблиці.
-- Дата-міграція: legacy-рядки (і їх сегменти — WHERE ловить по label) та локи
-- перейменовуються на обʼєднану назву; дублікати локів згортаються.
-- Лише 2026-07+: фірмові суфікси зʼявились з рішення 06.08.2026 (липнева
-- сводна); старіші місяці з суфіксом — артефакти розробки, історію не чіпаємо
-- (мердж у місяць, де вже є несуфіксована вкладка, плодив би дублі людей).

BEGIN;

UPDATE svodni_rows SET
  firm = CASE
    WHEN factory_label ~ ' EURO SUPORT$' THEN 'ES'
    WHEN factory_label ~ ' ESO$'         THEN 'ESO'
    WHEN factory_label ~ ' KLINEX$'      THEN 'Klinex'
  END,
  factory_label = regexp_replace(factory_label, ' (EURO SUPORT|ESO|KLINEX)$', '')
WHERE factory_label ~ '^Sushi&Food Factory (EURO SUPORT|ESO|KLINEX)$'
  AND period_month >= '2026-07';

-- локи фірмових вкладок → один лок обʼєднаної вкладки
INSERT INTO svodni_locks (period_month, city, factory_label, locked_by, locked_at)
SELECT DISTINCT ON (period_month, city)
  period_month, city,
  regexp_replace(factory_label, ' (EURO SUPORT|ESO|KLINEX)$', ''),
  locked_by, locked_at
FROM svodni_locks
WHERE factory_label ~ '^Sushi&Food Factory (EURO SUPORT|ESO|KLINEX)$'
  AND period_month >= '2026-07'
ORDER BY period_month, city, locked_at
ON CONFLICT (period_month, city, factory_label) DO NOTHING;

DELETE FROM svodni_locks
WHERE factory_label ~ '^Sushi&Food Factory (EURO SUPORT|ESO|KLINEX)$'
  AND period_month >= '2026-07';

COMMIT;
