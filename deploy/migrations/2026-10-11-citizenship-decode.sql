-- 11.10.2026: сирі MRZ-коди країни зі сканів паспортів («UKR», «P0L») у вже
-- збережених анкетах → польська назва (як тепер пише docai.ts через
-- lib/countries.ts). Ідемпотентно: після заміни значення вже не 3-літерний код.
-- Невідомі/OCR-сміттєві коди (напр. «CHU») не чіпаємо — офіс поправить у профілі.
CREATE TEMP TABLE mrz_country_names(code text, name text);
INSERT INTO mrz_country_names VALUES
  ('UKR','Ukraina'),('BLR','Białoruś'),('POL','Polska'),('P0L','Polska'),('MDA','Mołdawia'),('ROU','Rumunia'),('ROM','Rumunia'),
  ('GEO','Gruzja'),('GE0','Gruzja'),('AZE','Azerbejdżan'),('TUR','Turcja'),('KAZ','Kazachstan'),('UZB','Uzbekistan'),('KGZ','Kirgistan'),
  ('TJK','Tadżykistan'),('TKM','Turkmenistan'),('IND','Indie'),('NPL','Nepal'),('BGD','Bangladesz'),('PAK','Pakistan'),('LKA','Sri Lanka'),
  ('LTU','Litwa'),('LVA','Łotwa'),('EST','Estonia'),('DEU','Niemcy'),('D<<','Niemcy'),('CZE','Czechy'),('SVK','Słowacja'),('HUN','Węgry'),
  ('BGR','Bułgaria'),('ITA','Włochy'),('ESP','Hiszpania'),('PRT','Portugalia'),('FRA','Francja'),('GBR','Wielka Brytania'),('RUS','Rosja'),
  ('ARM','Armenia'),('SRB','Serbia'),('5RB','Serbia'),('NGA','Nigeria'),('GHA','Ghana'),('KEN','Kenia'),('ZWE','Zimbabwe'),('CMR','Kamerun'),
  ('COL','Kolumbia'),('VEN','Wenezuela'),('PER','Peru'),('ARG','Argentyna'),('BRA','Brazylia'),('MEX','Meksyk'),('CUB','Kuba'),
  ('PHL','Filipiny'),('VNM','Wietnam'),('IDN','Indonezja'),('CHN','Chiny'),('MNG','Mongolia'),('USA','Stany Zjednoczone');
UPDATE worker_questionnaires q SET citizenship = m.name FROM mrz_country_names m WHERE upper(q.citizenship) = m.code;
UPDATE worker_questionnaires q SET passport_country = m.name FROM mrz_country_names m WHERE upper(q.passport_country) = m.code;
DROP TABLE mrz_country_names;
