-- Cap `legalization` (перегляд+ведення легалізації: документи з номерами/файлами,
-- справи, правила) і сторінки /legalization, /tasks. Кому саме давати — рішення
-- головного адміна в Налаштуваннях → Користувачі та ролі; тут лише owner-подібні
-- системні ролі не чіпаємо (owner — суперюзер у коді). scheduler НЕ отримує cap
-- автоматично (бачитиме лише світлофори без номерів — рішення D6, 02.09.2026).
--
-- Заодно — гранти, яких бракувало модулю підпису (workerDocs / /contracts /
-- /document-templates існують у коді з 08.2026, але міграції грантів не було).
-- Обидва блоки нічого не роблять для ролей, де cap/page уже є.

-- Ролі-документи: якщо власник уже створив кастомну роль з workerDocs — їй же
-- даємо legalization (той самий офісний профіль «кадри»).
UPDATE roles SET caps = caps || '["legalization"]'::jsonb
  WHERE caps ? 'workerDocs' AND NOT caps ? 'legalization';
UPDATE roles SET pages = pages || '["/legalization"]'::jsonb
  WHERE caps ? 'legalization' AND NOT pages ? '/legalization';
