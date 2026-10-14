-- Сід довідкових даних форми PSZ-PPWPU (13.10.2026). Ідемпотентно: заповнює лише ПОРОЖНІ поля,
-- матч по назві без регістру (id і назви між базами різняться). TERYT-значення для відомих
-- населених пунктів Люблінщини та міст-повітів; перевірити на першій подачі по кожній фабриці.

-- Коди KZiS посад (лише очевидні; решту вписує офіс у Налаштуваннях → praca.gov.pl)
UPDATE positions SET kzis_code = '932990' WHERE kzis_code IS NULL AND lower(name) IN ('pracownik produkcji', 'pracownik', 'skoczek', 'reepack'); -- Robotnik przemysłowy gdzie indziej niesklasyfikowany
UPDATE positions SET kzis_code = '834401' WHERE kzis_code IS NULL AND lower(name) = 'wózkowy';            -- Kierowca operator wózków jezdniowych (widłowych)
UPDATE positions SET kzis_code = '932101' WHERE kzis_code IS NULL AND lower(name) LIKE '%pakow%' AND lower(name) NOT LIKE '%brygad%' AND lower(name) NOT LIKE '%lider%'; -- Pakowacz ręczny

-- Адреси фабрик (TERYT): індекс/вулиця/номер з вільного поля address, воєводство/повіт/гміна — за містом
WITH seed(fname, kod, woj, pow, gmina, miejsc, ulica, nr) AS (VALUES
  ('AGRAM MOTYCZ',   '21-030', 'lubelskie',     'lubelski',    'Konopnica',  'Motycz',        NULL,              '325D'),
  ('ALMIZ',          '08-530', 'lubelskie',     'rycki',       'Dęblin',     'Dęblin',        'ul. Stawska',     '231'),
  ('ANDROS',         '24-160', 'lubelskie',     'puławski',    'Wąwolnica',  'Łopatki',       NULL,              '37a'),
  ('BIMIZ',          '21-146', 'lubelskie',     'lubartowski', 'Jeziorzany', 'Jeziorzany',    'ul. Blizocka',    '33'),
  ('DORKO',          '24-170', 'lubelskie',     'puławski',    'Kurów',      'Klementowice',  NULL,              '153A'),
  ('LST',            '24-200', 'lubelskie',     'lubelski',    'Bełżyce',    'Bełżyce',       'ul. Przemysłowa', '50a'),
  ('PREMIUM FRUITS', '08-500', 'lubelskie',     'rycki',       'Ryki',       'Stara Dąbia',   NULL,              '44B'),
  ('EUROCASH BIAŁYSTOK', NULL, 'podlaskie',     'm. Białystok','Białystok',  'Białystok',     NULL,              NULL),
  ('EUROCASH KROSNO',    NULL, 'podkarpackie',  'm. Krosno',   'Krosno',     'Krosno',        NULL,              NULL),
  ('EUROCASH LUBLIN',    NULL, 'lubelskie',     'm. Lublin',   'Lublin',     'Lublin',        NULL,              NULL),
  ('AGRAM LUBLIN',       NULL, 'lubelskie',     'm. Lublin',   'Lublin',     'Lublin',        NULL,              NULL),
  ('KUŻNIA MATRYCOWA',   NULL, 'lubelskie',     'm. Lublin',   'Lublin',     'Lublin',        NULL,              NULL),
  ('MAKARUK',            NULL, 'lubelskie',     'm. Lublin',   'Lublin',     'Lublin',        NULL,              NULL),
  ('SUPERDROB',          NULL, 'lubelskie',     'm. Lublin',   'Lublin',     'Lublin',        NULL,              NULL),
  ('SERWIS PLUS (DEZYNFEKCJA)', NULL, 'lubelskie', 'm. Lublin','Lublin',     'Lublin',        NULL,              NULL),
  ('INPOST LDZ',         NULL, 'łódzkie',       'm. Łódź',     'Łódź',       'Łódź',          NULL,              NULL),
  ('AUNDE',              NULL, 'łódzkie',       'm. Łódź',     'Łódź',       'Łódź',          NULL,              NULL),
  ('NOWOPAK',            NULL, 'łódzkie',       'm. Łódź',     'Łódź',       'Łódź',          NULL,              NULL),
  ('PAK-SERWIS',         NULL, 'łódzkie',       'm. Łódź',     'Łódź',       'Łódź',          NULL,              NULL),
  ('TOP - 2',            NULL, 'łódzkie',       'm. Łódź',     'Łódź',       'Łódź',          NULL,              NULL),
  ('INPOST GD3',         NULL, 'pomorskie',     'm. Gdańsk',   'Gdańsk',     'Gdańsk',        NULL,              NULL),
  ('SUSHI&FOOD FACTORY', NULL, 'wielkopolskie', 'm. Poznań',   'Poznań',     'Poznań',        NULL,              NULL)
)
UPDATE factories f SET
  addr_postal_code  = COALESCE(f.addr_postal_code,  s.kod),
  addr_wojewodztwo  = COALESCE(f.addr_wojewodztwo,  s.woj),
  addr_powiat       = COALESCE(f.addr_powiat,       s.pow),
  addr_gmina        = COALESCE(f.addr_gmina,        s.gmina),
  addr_miejscowosc  = COALESCE(f.addr_miejscowosc,  s.miejsc),
  addr_street       = COALESCE(f.addr_street,       s.ulica),
  addr_house_no     = COALESCE(f.addr_house_no,     s.nr)
FROM seed s WHERE upper(f.name) = upper(s.fname);

-- Якщо в адресі фабрики вже є індекс у вільному полі — підхопити його, коли TERYT-індекс порожній
UPDATE factories SET addr_postal_code = substring(address from '\d{2}-\d{3}') WHERE addr_postal_code IS NULL AND address ~ '\d{2}-\d{3}';

-- Назва посади для 3.2 за замовчуванням: обовʼязки умови фабрики, якщо є
UPDATE factories SET ua_stanowisko = contract_duties WHERE ua_stanowisko IS NULL AND contract_duties IS NOT NULL AND length(contract_duties) <= 200;

-- Фірми: місто з реквізитів, PKD агенцій праці тимчасової
UPDATE companies SET pkd = '78.10.Z' WHERE pkd IS NULL AND employs_workers AND lower(name) IN ('es', 'eso');
