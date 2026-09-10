-- Wypowiedzenie umowy zlecenia (kind=wypowiedzenie) — ЗАВЖДИ з ініціативи працівника (рішення
-- власника 10.09.2026), за зразком офісу (Downloads/ESO wypowiedzenie umowy zlecenia.pdf).
-- Генерується при звільненні раніше кінця умови або з безстрокової (services/contractEndDocs.ts):
-- сторона, що розриває = працівник (його дані й підпис), адресат = фірма умови. Без печатки фірми.
-- «Data zawarcia umowy» = дата початку оригінальної умови (extraData), «Data zakończenia pracy» =
-- дата звільнення. Ідемпотентно; документ польською.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'wypowiedzenie', 'Wypowiedzenie umowy zlecenia (od zleceniobiorcy)', true, 'all', '[]'::jsonb, '[]'::jsonb,
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
      {%Imię%} {%Nazwisko%}<br>
      {%Pełny adres pracownika%}<br>
      PESEL {%PESEL pracownika%}<br>
      <span class="sub">(dane strony wypowiadającej)</span>
    </td>
    <td style="width: 50%; vertical-align: top; text-align: right;">
      <strong>{%Nazwa firmy%}</strong><br>
      ul. {%Ulica firmy%} {%Numer domu firmy%}<br>
      {%Kod pocztowy firmy%} {%Miejscowość firmy%}
    </td>
  </tr>
</table>

<div style="text-align: center; font-weight: bold; font-size: 13pt; letter-spacing: 1px; margin: 16px 0 20px 0;">WYPOWIEDZENIE UMOWY ZLECENIA</div>

<p>Niniejszym wypowiadam umowę zlecenia zawartą w {%Miejscowość firmy%} dnia <strong>{%Data zawarcia umowy data:(d.m.Y)%}</strong>
między <strong>{%Imię%} {%Nazwisko%}</strong> a <strong>{%Nazwa firmy%}</strong>, dotyczącą umowy zlecenia,
ze skutkiem na dzień <strong>{%Data zakończenia pracy data:(d.m.Y)%}</strong>.</p>
<p><span class="sub">(data zawarcia umowy — oznaczenie stron)</span></p>

<p style="margin-top: 14px;">Przyczyną wypowiedzenia wyżej wspomnianej umowy zlecenia jest:<br>
<strong>z przyczyn osobistych</strong></p>
<p><span class="sub">(wskazanie ważnych przyczyn wypowiedzenia umowy)</span></p>

<table style="width: 100%; border-collapse: collapse; margin-top: 44px;">
  <tr>
    <td style="width: 50%;"></td>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracownika%}</div>
      <span class="sub">(podpis strony wypowiadającej)</span>
    </td>
  </tr>
</table>
</div>
$html$),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'wypowiedzenie');
