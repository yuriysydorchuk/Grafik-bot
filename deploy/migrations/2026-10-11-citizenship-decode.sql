-- 11.10.2026: сирі MRZ-коди країни зі сканів паспортів («UKR», OCR-сміття «P0L»/«2WE»)
-- у вже збережених анкетах → польська назва (як тепер пише docai.ts через lib/countries.ts).
-- Список ЗГЕНЕРОВАНО з lib/countries.ts (COUNTRIES) — не правити вручну, перегенерувати.
-- Ідемпотентно: після заміни значення вже не 1–3-літерний код. OCR-плутанина
-- (0→O, 1→I, 5→S, 8→B, 2→Z) виправляється translate() перед пошуком.
-- Невідомі коди (напр. «NIE», «WIA») не чіпаємо — офіс поправить у профілі.
CREATE TEMP TABLE mrz_country_names(code text, name text);
INSERT INTO mrz_country_names VALUES
  ('UKR','Ukraina'), ('BLR','Białoruś'), ('POL','Polska'), ('MDA','Mołdawia'), ('ROU','Rumunia'), ('ROM','Rumunia'),
  ('GEO','Gruzja'), ('AZE','Azerbejdżan'), ('TUR','Turcja'), ('KAZ','Kazachstan'), ('UZB','Uzbekistan'), ('KGZ','Kirgistan'),
  ('TJK','Tadżykistan'), ('TKM','Turkmenistan'), ('IND','Indie'), ('NPL','Nepal'), ('BGD','Bangladesz'), ('PAK','Pakistan'),
  ('LKA','Sri Lanka'), ('BTN','Bhutan'), ('D','Niemcy'), ('DEU','Niemcy'), ('LTU','Litwa'), ('LVA','Łotwa'),
  ('EST','Estonia'), ('CZE','Czechy'), ('SVK','Słowacja'), ('HUN','Węgry'), ('BGR','Bułgaria'), ('HRV','Chorwacja'),
  ('SVN','Słowenia'), ('ITA','Włochy'), ('ESP','Hiszpania'), ('PRT','Portugalia'), ('FRA','Francja'), ('NLD','Holandia'),
  ('BEL','Belgia'), ('LUX','Luksemburg'), ('AUT','Austria'), ('IRL','Irlandia'), ('GRC','Grecja'), ('CYP','Cypr'),
  ('MLT','Malta'), ('SWE','Szwecja'), ('FIN','Finlandia'), ('DNK','Dania'), ('NOR','Norwegia'), ('ISL','Islandia'),
  ('LIE','Liechtenstein'), ('CHE','Szwajcaria'), ('GBR','Wielka Brytania'), ('GBD','Wielka Brytania'), ('GBN','Wielka Brytania'), ('GBO','Wielka Brytania'),
  ('GBS','Wielka Brytania'), ('SRB','Serbia'), ('BIH','Bośnia i Hercegowina'), ('MKD','Macedonia Północna'), ('ALB','Albania'), ('MNE','Czarnogóra'),
  ('RKS','Kosowo'), ('XKX','Kosowo'), ('RUS','Rosja'), ('ARM','Armenia'), ('NGA','Nigeria'), ('GHA','Ghana'),
  ('KEN','Kenia'), ('ZWE','Zimbabwe'), ('ZAF','Republika Południowej Afryki'), ('CMR','Kamerun'), ('EGY','Egipt'), ('MAR','Maroko'),
  ('TUN','Tunezja'), ('DZA','Algieria'), ('ETH','Etiopia'), ('UGA','Uganda'), ('TZA','Tanzania'), ('SEN','Senegal'),
  ('CIV','Wybrzeże Kości Słoniowej'), ('COD','Demokratyczna Republika Konga'), ('COG','Kongo'), ('AGO','Angola'), ('MOZ','Mozambik'), ('ZMB','Zambia'),
  ('RWA','Rwanda'), ('BDI','Burundi'), ('SDN','Sudan'), ('GIN','Gwinea'), ('MLI','Mali'), ('GMB','Gambia'),
  ('MWI','Malawi'), ('SSD','Sudan Południowy'), ('SOM','Somalia'), ('ERI','Erytrea'), ('DJI','Dżibuti'), ('LBY','Libia'),
  ('NAM','Namibia'), ('BWA','Botswana'), ('LSO','Lesotho'), ('SWZ','Eswatini'), ('NER','Niger'), ('TCD','Czad'),
  ('BFA','Burkina Faso'), ('TGO','Togo'), ('BEN','Benin'), ('SLE','Sierra Leone'), ('LBR','Liberia'), ('MDG','Madagaskar'),
  ('MUS','Mauritius'), ('GAB','Gabon'), ('GNQ','Gwinea Równikowa'), ('CAF','Republika Środkowoafrykańska'), ('MRT','Mauretania'), ('CPV','Republika Zielonego Przylądka'),
  ('COL','Kolumbia'), ('VEN','Wenezuela'), ('PER','Peru'), ('ARG','Argentyna'), ('BRA','Brazylia'), ('MEX','Meksyk'),
  ('CUB','Kuba'), ('ECU','Ekwador'), ('BOL','Boliwia'), ('CHL','Chile'), ('PRY','Paragwaj'), ('URY','Urugwaj'),
  ('DOM','Dominikana'), ('GTM','Gwatemala'), ('HND','Honduras'), ('SLV','Salwador'), ('NIC','Nikaragua'), ('CRI','Kostaryka'),
  ('PAN','Panama'), ('HTI','Haiti'), ('JAM','Jamajka'), ('TTO','Trynidad i Tobago'), ('GUY','Gujana'), ('SUR','Surinam'),
  ('PHL','Filipiny'), ('VNM','Wietnam'), ('IDN','Indonezja'), ('THA','Tajlandia'), ('MMR','Mjanma'), ('MYS','Malezja'),
  ('CHN','Chiny'), ('MNG','Mongolia'), ('KOR','Korea Południowa'), ('JPN','Japonia'), ('IRN','Iran'), ('IRQ','Irak'),
  ('SYR','Syria'), ('AFG','Afganistan'), ('ISR','Izrael'), ('JOR','Jordania'), ('LBN','Liban'), ('USA','Stany Zjednoczone'),
  ('CAN','Kanada'), ('AUS','Australia'), ('NZL','Nowa Zelandia'), ('KHM','Kambodża'), ('LAO','Laos'), ('SGP','Singapur'),
  ('TWN','Tajwan'), ('HKG','Hongkong'), ('SAU','Arabia Saudyjska'), ('ARE','Zjednoczone Emiraty Arabskie'), ('KWT','Kuwejt'), ('QAT','Katar'),
  ('YEM','Jemen'), ('PSE','Palestyna'), ('AND','Andora'), ('MCO','Monako'), ('SMR','San Marino'), ('VAT','Watykan');
UPDATE worker_questionnaires q SET citizenship = m.name FROM mrz_country_names m
  WHERE q.citizenship ~ '^[A-Za-z0-9<]{1,3}$' AND translate(upper(replace(q.citizenship,'<','')), '01582', 'OISBZ') = m.code;
UPDATE worker_questionnaires q SET passport_country = m.name FROM mrz_country_names m
  WHERE q.passport_country ~ '^[A-Za-z0-9<]{1,3}$' AND translate(upper(replace(q.passport_country,'<','')), '01582', 'OISBZ') = m.code;
DROP TABLE mrz_country_names;
