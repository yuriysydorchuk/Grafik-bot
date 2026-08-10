-- Дублікат фабрики: id=6 «SERWIS PLUS» і id=16 «DEZYNFEKCJA» — одна фірма
-- (той самий NIP 5262891379, pnl_label «Dezynfekcja»; рядки — клони від 26.06.2026).
-- Зливаємо в id=6 під назвою «SERWIS PLUS (DEZYNFEKCJA)»: переносимо місто/ставки
-- з 16, працівників (18) і рядки сводної 2026-06 (20), дублікат видаляємо.
-- Data-fix (прод), схему не міняє.
BEGIN;

UPDATE factories
   SET name = 'SERWIS PLUS (DEZYNFEKCJA)',
       city = 'Люблін',
       rate_brutto = 31.4,
       rate_netto = 25.35
 WHERE id = 6;

UPDATE workers     SET factory_id = 6 WHERE factory_id = 16;
UPDATE svodni_rows SET factory_id = 6 WHERE factory_id = 16;

DELETE FROM factories WHERE id = 16;

COMMIT;
