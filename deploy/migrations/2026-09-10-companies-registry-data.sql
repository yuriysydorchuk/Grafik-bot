-- Реквізити наших фірм для документів (Umowa/Regulamin/świadectwo: KRS, REGON, адреса,
-- представник). Джерело — публічний реєстр KRS (звірено 01.09.2026 при заповненні локальної
-- бази). Ключ — NIP (id фірм збігаються локально/прод, але NIP надійніший). Ідемпотентно:
-- COALESCE не затирає значення, які офіс уже вписав у Налаштуваннях фірми. Без цих полів
-- генерація пакета падає «Бракує даних для генерації: KRS firmy …».
UPDATE companies SET
  legal_name     = COALESCE(legal_name,     'Klinex Sp. z o.o.'),
  krs            = COALESCE(krs,            '0000981143'),
  regon          = COALESCE(regon,          '522523231'),
  street         = COALESCE(street,         'Krakowskie Przedmieście'),
  house_number   = COALESCE(house_number,   '55'),
  postal_code    = COALESCE(postal_code,    '20-076'),
  city           = COALESCE(city,           'Lublin'),
  representative = COALESCE(representative, 'Alona Kovalchuk – Prezes Zarządu')
WHERE nip = '7123438022';

UPDATE companies SET
  legal_name     = COALESCE(legal_name,     'Eurosupport Group Sp. z o.o.'),
  krs            = COALESCE(krs,            '0000847164'),
  regon          = COALESCE(regon,          '386387801'),
  street         = COALESCE(street,         'Krakowskie Przedmieście'),
  house_number   = COALESCE(house_number,   '55'),
  postal_code    = COALESCE(postal_code,    '20-076'),
  city           = COALESCE(city,           'Lublin'),
  representative = COALESCE(representative, 'Alona Kovalchuk – Prezes Zarządu')
WHERE nip = '9462698100';

UPDATE companies SET
  legal_name     = COALESCE(legal_name,     'Euro Support Outsourcing Sp. z o.o.'),
  krs            = COALESCE(krs,            '0000992195'),
  regon          = COALESCE(regon,          '523130048'),
  street         = COALESCE(street,         'Krakowskie Przedmieście'),
  house_number   = COALESCE(house_number,   '55'),
  postal_code    = COALESCE(postal_code,    '20-076'),
  city           = COALESCE(city,           'Lublin'),
  representative = COALESCE(representative, 'Tetiana Sydorchuk – Prezes Zarządu')
WHERE nip = '7123441567';
