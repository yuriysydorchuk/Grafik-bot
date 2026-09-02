-- Реквізити KRS наших компаній — потрібні для генерації Umowa (§worker-docs-signing,
-- {%KRS firmy%}/{%REGON firmy%}/{%Ulica firmy%}/… раніше не мали джерела в даних).
-- Дані — з офіційного реєстру KRS (звірено 01.09.2026 через aleo.com/rejestr.io за NIP).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS krs text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS regon text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS street text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS house_number text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS representative text;

-- ES — Eurosupport Group Sp. z o.o. (NIP 9462698100)
UPDATE companies SET
  krs = '0000847164', regon = '386387801',
  street = 'Krakowskie Przedmieście', house_number = '55', postal_code = '20-076', city = 'Lublin',
  representative = 'Alona Kovalchuk – Prezes Zarządu'
WHERE nip = '9462698100';

-- ESO — Euro Support Outsourcing Sp. z o.o. (NIP 7123441567)
UPDATE companies SET
  krs = '0000992195', regon = '523130048',
  street = 'Krakowskie Przedmieście', house_number = '55', postal_code = '20-076', city = 'Lublin',
  representative = 'Tetiana Sydorchuk – Prezes Zarządu'
WHERE nip = '7123441567';

-- Klinex Sp. z o.o. (NIP 7123438022)
UPDATE companies SET
  krs = '0000981143', regon = '522523231',
  street = 'Krakowskie Przedmieście', house_number = '55', postal_code = '20-076', city = 'Lublin',
  representative = 'Alona Kovalchuk – Prezes Zarządu'
WHERE nip = '7123438022';
