-- Zaświadczenie для ES GROUP (рішення власника 10.09.2026): вказуємо клієнта, де працював; кілька
-- клієнтів → «w Eurosupport Group (różni klienci)». Плейсхолдер {%Miejsce pracy zaświadczenia%}
-- рахує services/contractEndDocs.ts. Шаблон scope=company для фірми з name='ES'; аутсорсингові фірми
-- (ESO/Klinex) лишаються на базовому шаблоні без клієнта. Ідемпотентно; без фірми 'ES' — нічого.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'zaswiadczenie', 'Zaświadczenie o zatrudnieniu — ES GROUP (z klientem)', false, 'company', jsonb_build_array((SELECT id FROM companies WHERE name = 'ES' LIMIT 1)), '[]'::jsonb,
  jsonb_build_object('pl', replace(
    (SELECT body->>'pl' FROM document_templates WHERE kind = 'zaswiadczenie' AND is_base LIMIT 1),
    '<span class="sub">(nazwa zakładu pracy)</span></p>',
    '<span class="sub">(nazwa zakładu pracy)</span><br>{%Miejsce pracy zaświadczenia%}</p>'
  )),
  true
WHERE EXISTS (SELECT 1 FROM companies WHERE name = 'ES')
  AND EXISTS (SELECT 1 FROM document_templates WHERE kind = 'zaswiadczenie' AND is_base)
  AND NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'zaswiadczenie' AND scope = 'company');
