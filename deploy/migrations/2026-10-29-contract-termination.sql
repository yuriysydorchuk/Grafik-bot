-- Виповідзення на умові (29.10.2026): дата/ініціатор/пакет wypowiedzenia на contracts; бекфіл з
-- профільних workers.termination_* на живі umowy тієї фабрики; шаблон wypowiedzenia від фірми.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS termination_date date;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS termination_by text;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS termination_doc_id integer;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS termination_set_at timestamp;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS termination_set_by integer REFERENCES admins(id);

-- Бекфіл (одноразово, лише де на умові ще нема дати): чинне профільне виповідзення → живі підписані
-- umowy тієї фабрики (або всіх фабрик, якщо виповідзення «з усіх»); подієві документи не чіпаємо.
UPDATE contracts c SET termination_date = w.termination_date, termination_by = 'worker', termination_set_at = now()
FROM workers w
WHERE c.worker_id = w.id AND w.is_active AND w.termination_date IS NOT NULL AND c.termination_date IS NULL
  AND c.status IN ('signed', 'worker_signed') AND c.factory_id IS NOT NULL
  AND (w.termination_factory_id IS NULL OR c.factory_id = w.termination_factory_id)
  AND (c.date_to IS NULL OR c.date_to >= w.termination_date)
  AND (c.data->>'_endedAtFactory') IS NULL
  AND NOT EXISTS (SELECT 1 FROM contract_files cf JOIN document_templates dt ON dt.id = cf.template_id
                  WHERE cf.contract_id = c.id AND dt.kind IN ('zaswiadczenie', 'wypowiedzenie', 'wypowiedzenie_firma', 'aneks', 'swiadectwo', 'zcna'));

-- Wypowiedzenie від фірми (kind=wypowiedzenie_firma): той самий бланк, сторона, що розриває, — фірма
-- (печатка + підпис фірми), адресат — працівник; працівник підписує отримання. Ідемпотентно.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'wypowiedzenie_firma', 'Wypowiedzenie umowy zlecenia (od zleceniodawcy)', true, 'all', '[]'::jsonb, '[]'::jsonb,
  jsonb_build_object('pl', $html$
<style>
.sig-box img { max-height: 45px !important; max-width: 160px !important; width: auto !important; height: auto !important; object-fit: contain !important; }
.wy p { margin: 0 0 8px 0; }
.wy .sub { color: #555; font-size: 8.5pt; }
</style>
<div class="wy" style="font-family: 'Times New Roman', Times, serif; font-size: 11pt; line-height: 1.5; color: #000; max-width: 800px; margin: 0 auto; text-align: left;">

<p style="text-align: right;">{%Miejscowość firmy%}, {%Data dzisiejsza data:(d.m.Y)%}<br><span class="sub">(miejscowość i data)</span></p>

<table style="width: 100%; border-collapse: collapse; margin: 10px 0 22px 0;">
  <tr>
    <td style="width: 50%; vertical-align: top;">
      <strong>{%Nazwa firmy%}</strong><br>
      ul. {%Ulica firmy%} {%Numer domu firmy%}<br>
      {%Kod pocztowy firmy%} {%Miejscowość firmy%}<br>
      <span class="sub">(dane strony wypowiadającej — Zleceniodawca)</span>
    </td>
    <td style="width: 50%; vertical-align: top; text-align: right;">
      {%Imię%} {%Nazwisko%}<br>
      {%Pełny adres pracownika%}<br>
      PESEL {%PESEL pracownika%}
    </td>
  </tr>
</table>

<div style="text-align: center; font-weight: bold; font-size: 13pt; letter-spacing: 1px; margin: 16px 0 20px 0;">WYPOWIEDZENIE UMOWY ZLECENIA</div>

<p>Niniejszym wypowiadamy umowę zlecenia zawartą w {%Miejscowość firmy%} dnia <strong>{%Data zawarcia umowy data:(d.m.Y)%}</strong>
między <strong>{%Nazwa firmy%}</strong> a <strong>{%Imię%} {%Nazwisko%}</strong>, dotyczącą umowy zlecenia,
ze skutkiem na dzień <strong>{%Data zakończenia pracy data:(d.m.Y)%}</strong>.</p>
<p><span class="sub">(data zawarcia umowy — oznaczenie stron)</span></p>

<table style="width: 100%; border-collapse: collapse; margin-top: 44px;">
  <tr>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracodawcy%}</div>
      <span class="sub">(pieczęć i podpis Zleceniodawcy)</span>
    </td>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracownika%}</div>
      <span class="sub">(potwierdzenie odbioru — podpis Zleceniobiorcy)</span>
    </td>
  </tr>
</table>
</div>
$html$),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'wypowiedzenie_firma');
