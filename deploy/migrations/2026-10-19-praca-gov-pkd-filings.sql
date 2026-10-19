-- Powiadomienie PSZ-PPWPU (19.10.2026): звірка з трьома реальними подачами Влади (ESO/DAWTONA 12.10, Klinex/PREMIUM FRUITS 28.09,
-- ESG/AGRAM LUBLIN 12.10). Ідемпотентно; матч фабрик по назві без регістру (id і назви між базами різняться).
--  * factories.ua_pkd — PKD роботи, яку виконує cudzoziemiec (3.1), не PKD агенції; у подачах 1039Z (owoce i warzywa)
--  * посада/KZiS за подачами: «Przetwórca owoców i warzyw» 751402 на овочево-фруктових заводах — лише в порожні поля
--  * TERYT-адреси з подач і з вільного поля address; nr lokalu окремо (44 / B)
--  * контакти й чисельність фірм з подач (1.2/1.3/4, KRAZ ESG)
ALTER TABLE factories ADD COLUMN IF NOT EXISTS ua_pkd text;

-- овочево-фруктові заводи: PKD 1039Z + посада/KZiS як у подачах (лише де порожньо)
WITH fruit(fname) AS (VALUES ('DAWTONA'), ('PREMIUM FRUITS'), ('AGRAM LUBLIN'), ('AGRAM MOTYCZ'), ('ANDROS'), ('DORKO'), ('BIMIZ'), ('ALMIZ'), ('OSMOFROST'))
UPDATE factories f SET
  ua_pkd        = COALESCE(f.ua_pkd, '1039Z'),
  ua_stanowisko = COALESCE(f.ua_stanowisko, 'Przetwórca owoców i warzyw'),
  ua_kzis_code  = COALESCE(f.ua_kzis_code, '751402')
FROM fruit s WHERE upper(f.name) = upper(s.fname);

-- TERYT з подач і вільного поля address (лише порожні поля)
WITH seed(fname, kod, woj, pow, gmina, miejsc, ulica, nr, lok) AS (VALUES
  ('DAWTONA',              '21-020', 'lubelskie',     'łęczyński',   'Milejów',  'Milejów-Osada', NULL,                 '1',    NULL),
  ('AGRAM LUBLIN',         '20-234', 'lubelskie',     'm. Lublin',   'Lublin',   'Lublin',        'ul. Mełgiewska',     '104',  NULL),
  ('RECYKLING',            '20-234', 'lubelskie',     'm. Lublin',   'Lublin',   'Lublin',        'ul. Metalurgiczna',  '15C',  NULL),
  ('SCANDIC FOOD',         '27-300', 'mazowieckie',   'lipski',      'Lipsko',   'Lipsko',        'ul. Spacerowa',      '22',   NULL),
  ('INPOST- LLU LUBLIN 3', '21-040', 'lubelskie',     'świdnicki',   'Świdnik',  'Świdnik',       'ul. Kolonijna',      '10',   NULL),
  ('SUSHI&FOOD FACTOR',    '62-023', 'wielkopolskie', 'poznański',   'Kórnik',   'Robakowo',      'ul. Żernicka',       '22',   NULL)
)
UPDATE factories f SET
  addr_postal_code = COALESCE(f.addr_postal_code, s.kod),
  addr_wojewodztwo = COALESCE(f.addr_wojewodztwo, s.woj),
  addr_powiat      = COALESCE(f.addr_powiat,      s.pow),
  addr_gmina       = COALESCE(f.addr_gmina,       s.gmina),
  addr_miejscowosc = COALESCE(f.addr_miejscowosc, s.miejsc),
  addr_street      = COALESCE(f.addr_street,      s.ulica),
  addr_house_no    = COALESCE(f.addr_house_no,    s.nr),
  addr_apt_no      = COALESCE(f.addr_apt_no,      s.lok)
FROM seed s WHERE upper(f.name) = upper(s.fname) OR (s.fname = 'SUSHI&FOOD FACTOR' AND upper(f.name) LIKE 'SUSHI&FOOD FACTOR%');

-- PREMIUM FRUITS: у подачі nr budynku 44, nr lokalu B (у нас було «44B» одним полем)
UPDATE factories SET addr_house_no = '44', addr_apt_no = COALESCE(addr_apt_no, 'B') WHERE upper(name) = 'PREMIUM FRUITS' AND addr_house_no = '44B';
-- Lublin у довіднику TERYT: województwo малими, powiat «m. Lublin» (AGRO TRADE / JADAR вписані руками в іншому регістрі)
UPDATE factories SET addr_wojewodztwo = 'lubelskie' WHERE lower(addr_wojewodztwo) IN ('lubelskie', 'lubelski') AND addr_wojewodztwo <> 'lubelskie';
UPDATE factories SET addr_powiat = 'm. Lublin' WHERE addr_powiat = 'Lublin' AND addr_gmina = 'Lublin';
UPDATE factories SET addr_miejscowosc = 'Lublin' WHERE addr_miejscowosc = 'LUBLIN';
UPDATE factories SET addr_street = 'ul. Tokarska' WHERE addr_street = 'TOKARSKA';
UPDATE factories SET addr_street = 'ul. Metalurgiczna' WHERE addr_street = 'Metalurgiczna';

-- фірми: контакти (1.2/1.3), чисельність (4) і KRAZ — як у подачах 09–10.2026 (чисельність застаріває, правиться в Налаштуваннях).
-- ES: 40 на проді — тестове значення до звірки; одноразово замінюємо на 209 з подачі 12.10 (міграції на проді не повторюються)
UPDATE companies SET contact_email = COALESCE(contact_email, 'office.eurosupp@gmail.com') WHERE employs_workers AND lower(name) IN ('es', 'eso', 'klinex');
UPDATE companies SET contact_phone = COALESCE(contact_phone, '792182764') WHERE employs_workers AND lower(name) = 'eso';
UPDATE companies SET contact_phone = COALESCE(contact_phone, '530878711') WHERE employs_workers AND lower(name) = 'klinex';
UPDATE companies SET kraz = COALESCE(kraz, '24734') WHERE employs_workers AND lower(name) = 'es';
UPDATE companies SET headcount_employment = COALESCE(headcount_employment, 0),   headcount_civil = CASE WHEN headcount_civil IS NULL OR headcount_civil = 40 THEN 209 ELSE headcount_civil END WHERE employs_workers AND lower(name) = 'es';
UPDATE companies SET headcount_employment = COALESCE(headcount_employment, 3),   headcount_civil = COALESCE(headcount_civil, 131) WHERE employs_workers AND lower(name) = 'eso';
UPDATE companies SET headcount_employment = COALESCE(headcount_employment, 3),   headcount_civil = COALESCE(headcount_civil, 25)  WHERE employs_workers AND lower(name) = 'klinex';
