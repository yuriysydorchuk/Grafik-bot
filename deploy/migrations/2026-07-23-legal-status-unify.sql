-- Уніфікація ключів форм легалізації: у профілях жили два покоління словників
-- (легасі: oswiadczenie/student_do26/student_po26/nieoformiony/zezwolenie).
-- Канонічний словник: student|dyplom|powiadomienie|zus|oczekuje|karta_pobytu|staly_pobyt|polak.
-- Вік (до/після 26) — НЕ частина статусу: він виводиться з birth_date/under_26.
UPDATE workers SET legal_status = 'powiadomienie' WHERE legal_status = 'oswiadczenie';
UPDATE workers SET legal_status = 'student', is_student = true WHERE legal_status IN ('student_do26', 'student_po26');
UPDATE workers SET legal_status = 'oczekuje' WHERE legal_status = 'nieoformiony';
UPDATE workers SET legal_status = 'zus' WHERE legal_status = 'zezwolenie';

-- сегменти сводної тримають статус вікна в extras.segLegal — ті самі правила
UPDATE svodni_rows SET extras = jsonb_set(extras, '{segLegal}', '"powiadomienie"') WHERE extras->>'segLegal' = 'oswiadczenie';
UPDATE svodni_rows SET extras = jsonb_set(extras, '{segLegal}', '"student"') WHERE extras->>'segLegal' IN ('student_do26', 'student_po26');
UPDATE svodni_rows SET extras = jsonb_set(extras, '{segLegal}', '"oczekuje"') WHERE extras->>'segLegal' = 'nieoformiony';
UPDATE svodni_rows SET extras = jsonb_set(extras, '{segLegal}', '"zus"') WHERE extras->>'segLegal' = 'zezwolenie';
