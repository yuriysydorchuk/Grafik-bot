-- Сід довідників модуля легалізації (фаза 1). Ідемпотентний: бекфіл code по
-- імені ДО вставок, вставки ON CONFLICT (code) DO NOTHING, правила — ON CONFLICT
-- (code, effective_from) DO NOTHING. Назви типів — польською (юридичні терміни;
-- документи в системі — польською за правилом CLAUDE.md). Юридичні строки —
-- сід-кандидати: рядки без verified_at дають reviewRequired у движку, доки
-- власник/юрист не підтвердить їх у Налаштуваннях.

-- 1) Бекфіл існуючих типів, які код шукав по імені (ensureDocumentType тепер іде по code).
UPDATE document_types SET code = 'passport', category = 'identity', is_system = true, icon = COALESCE(icon, 'passport')
  WHERE code IS NULL AND lower(name) = 'paszport';
UPDATE document_types SET code = 'student_cert', category = 'work', grants_work = true, has_expiry = true, is_system = true,
    icon = COALESCE(icon, 'student'), renewal_lead_days = COALESCE(renewal_lead_days, 30)
  WHERE code IS NULL AND lower(name) IN ('довідка студента', 'zaświadczenie studenta', 'zaswiadczenie studenta');

-- 2) Каталог типів. applies_to_nationalities: null = усі; групи "ua" | "eu" | "non_eu"
--    або коди каталогу національностей (EU = poland | romania | eu_other).
INSERT INTO document_types (code, name, required, has_expiry, sort_order, icon, category, grants_stay, grants_work, requires_employer_match, default_validity_days, renewal_lead_days, applies_to_nationalities, is_system) VALUES
  -- identity
  ('passport',              'Paszport',                                            true,  true,  10,  'passport',       'identity', false, false, false, null, 90,  null,                                   true),
  ('id_card_pl',            'Dowód osobisty (PL)',                                 false, true,  20,  'passport',       'identity', false, false, false, null, 90,  '["poland"]'::jsonb,                    true),
  ('id_card_eu',            'Dowód tożsamości UE/EOG',                             false, true,  30,  'passport',       'identity', false, false, false, null, 90,  '["eu"]'::jsonb,                        true),
  -- stay
  ('visa_d',                'Wiza krajowa (D)',                                    false, true,  100, 'residence_card', 'stay',     true,  false, false, null, 30,  '["non_eu"]'::jsonb,                    true),
  ('visa_c',                'Wiza Schengen (C)',                                   false, true,  110, 'residence_card', 'stay',     true,  false, false, null, 14,  '["non_eu"]'::jsonb,                    true),
  ('visa_free',             'Ruch bezwizowy (data „do” wpisywana ręcznie)',        false, true,  120, 'residence_card', 'stay',     true,  false, false, 90,   14,  '["non_eu"]'::jsonb,                    true),
  ('trc',                   'Karta pobytu czasowego',                              false, true,  130, 'residence_card', 'stay',     true,  false, false, null, 60,  '["non_eu"]'::jsonb,                    true),
  ('zezwolenie_jednolite',  'Zezwolenie jednolite na pobyt czasowy i pracę',       false, true,  140, 'decision',       'stay',     true,  true,  true,  null, 60,  '["non_eu"]'::jsonb,                    true),
  ('karta_stalego_pobytu',  'Karta stałego pobytu',                                false, true,  150, 'residence_card', 'stay',     true,  true,  false, null, 90,  '["non_eu"]'::jsonb,                    true),
  ('rezydent_ue',           'Karta rezydenta długoterminowego UE',                 false, true,  160, 'residence_card', 'stay',     true,  true,  false, null, 90,  '["non_eu"]'::jsonb,                    true),
  ('stay_case_certificate', 'Zaświadczenie o złożeniu wniosku (dawniej stempel)',  false, false, 170, 'decision',       'stay',     false, false, false, null, null,'["non_eu"]'::jsonb,                    true),
  ('status_ukr',            'Status UKR (PESEL UKR, specustawa)',                  false, false, 180, 'residence_card', 'stay',     true,  false, false, null, 90,  '["ua"]'::jsonb,                        true),
  -- work
  ('karta_polaka',          'Karta Polaka',                                        false, true,  190, 'karta_polaka',   'work',     false, true,  false, null, 90,  '["non_eu"]'::jsonb,                    true),
  ('oswiadczenie',          'Oświadczenie o powierzeniu wykonywania pracy',        false, true,  200, 'permit',         'work',     false, true,  true,  730,  30,  '["ukraine","belarus","moldova"]'::jsonb, true),
  ('zezwolenie_a',          'Zezwolenie na pracę typ A',                           false, true,  210, 'permit',         'work',     false, true,  true,  null, 60,  '["non_eu"]'::jsonb,                    true),
  ('powiadomienie_ua',      'Powiadomienie o powierzeniu pracy obywatelowi UA',    false, false, 220, 'notification',   'work',     false, true,  true,  null, null,'["ua"]'::jsonb,                        true),
  ('student_cert',          'Zaświadczenie studenta (studia stacjonarne)',         false, true,  230, 'student',        'work',     false, true,  false, null, 30,  null,                                   true),
  ('diploma',               'Dyplom ukończenia studiów stacjonarnych w PL',        false, false, 240, 'student',        'work',     false, true,  false, null, null, null,                                  true),
  -- (umowa zlecenie / PIT-2 / wnioski — НЕ тут: живуть у модулі підпису contracts/document_templates; рішення 03.09.2026)
  -- medical
  ('medical_exam',          'Badania lekarskie',                                   false, true,  400, 'medical',        'medical',  false, false, false, null, 30,  null,                                   true),
  ('sanepid',               'Książeczka sanepidowska',                             false, true,  410, 'medical',        'medical',  false, false, false, null, 30,  null,                                   true),
  ('bhp',                   'Szkolenie BHP',                                       false, false, 420, 'medical',        'medical',  false, false, false, null, null, null,                                  true),
  -- other
  ('other',                 'Inny dokument',                                       false, false, 900, null,             'other',    false, false, false, null, null, null,                                  true)
ON CONFLICT (code) DO NOTHING;
-- прибрати сід-типи умов/PIT з ранніх накатів (їх веде модуль підпису); лише якщо документів на них нема
DELETE FROM document_types t WHERE t.code IN ('umowa_zlecenie', 'oswiadczenie_podatkowe')
  AND NOT EXISTS (SELECT 1 FROM worker_documents d WHERE d.doc_type_id = t.id);

-- 3) Правила легальності. Джерела перевірені 02.09.2026 (див. звіт фази 0 §1.4);
--    verified_at стоїть лише там, де є публічне джерело або рішення власника.
INSERT INTO legal_rules (code, kind, axis, conditions, effective_from, effective_to, source, verified_at, note) VALUES
  ('stay.pl_citizen', 'basis_by_nationality', 'both',
    '{"nationalities":["poland"]}'::jsonb, '2000-01-01', null,
    'Obywatelstwo PL', now(), 'Громадянин PL — легальний побут і праця без документів'),
  ('stay.eu_citizen', 'basis_by_nationality', 'both',
    '{"nationalities":["eu"]}'::jsonb, '2004-05-01', null,
    'https://psz.praca.gov.pl/dla-pracodawcow-i-przedsiebiorcow/zatrudnianie-cudzoziemcow/praca-bez-zezwolenia', now(),
    'Громадяни UE/EOG — без zezwolenia; EU-група = poland|romania|eu_other'),
  ('global.ukr_status_end', 'global', 'stay',
    '{"date":"2027-03-04"}'::jsonb, '2026-03-05', null,
    'Ustawa z 23.01.2026 (w mocy od 05.03.2026); praca.gov.pl', now(),
    'Кінець легального побуту за spec-ustawą для status UKR'),
  ('obligation.ua_notification', 'obligation', 'work',
    '{"nationalities":["ua"],"days":7,"docCode":"powiadomienie_ua","hard":false}'::jsonb, '2025-06-01', null,
    'https://zielonalinia.gov.pl/en/-/powiadomienie-o-powierzeniu-wykonywania-pracy-obywatelowi-ukrainy-co-powinien-wiedziec-pracodawca-', now(),
    'Powiadomienie ≤ 7 днів від початку праці (з 2025). hard:false = лише reviewRequired до підтвердження юристом (рішення D5)'),
  ('precedence.work_during_case', 'precedence', 'work',
    '{"requiresPriorWorkBasis":true}'::jsonb, '2000-01-01', null,
    'https://www.biznes.gov.pl/pl/portal/004330', now(),
    'Праця під час провадження законна лише якщо безпосередньо перед поданням особа мала право на працю'),
  ('requirement.identity', 'requirement', null,
    '{"category":"identity","anyOf":["passport","id_card_pl","id_card_eu"]}'::jsonb, '2000-01-01', null,
    null, now(), 'Один документ тотожності обов''язковий для всіх'),
  ('requirement.stay_non_eu', 'requirement', 'stay',
    '{"nationalities":["non_eu"],"category":"stay"}'::jsonb, '2000-01-01', null,
    null, now(), 'Не-EU: потрібна підстава перебування'),
  ('requirement.work_non_eu', 'requirement', 'work',
    '{"nationalities":["non_eu"],"category":"work"}'::jsonb, '2000-01-01', null,
    null, now(), 'Не-EU: потрібна підстава праці'),
  ('defaults.lead_days', 'global', null,
    '{"documents":[60,30,14,7,0],"cases":30,"ukr":[90,30],"defaultLeadDays":30}'::jsonb, '2026-09-02', null,
    'Рішення власника D8, 02.09.2026', now(), 'Пороги нагадувань і дефолтний lead для expiring'),
  ('defaults.evidence', 'global', null,
    '{"unverifiedCountsAsBasis":false}'::jsonb, '2026-09-02', null,
    'Рішення власника D4, 02.09.2026', now(), 'Неверифікований аплоуд НЕ рахується підставою')
ON CONFLICT (code, effective_from) DO NOTHING;
