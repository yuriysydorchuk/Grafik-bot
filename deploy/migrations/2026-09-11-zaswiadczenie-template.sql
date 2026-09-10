-- Zaświadczenie o zatrudnieniu na umowie zlecenie (kind=zaswiadczenie): за зразком офісу
-- (Downloads/ESO zaświadczenie.pdf, 10.09.2026). Генерується автоматично, коли умова
-- закінчилась (services/contractEndDocs.ts, нічний крон 06:30): фірма умови → плейсхолдери
-- фірми, печатка+підпис фірми ставляться одразу (stampDraftWithCompany), працівник підписує
-- за лінком. Подієвий kind — в автонабір «Згенерувати документи» не входить. Ідемпотентно.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'zaswiadczenie', 'Zaświadczenie o zatrudnieniu na umowie zlecenie', true, 'all', '[]'::jsonb, '[]'::jsonb,
  jsonb_build_object('pl', $html$
<style>
.sig-box img { max-height: 45px !important; max-width: 160px !important; width: auto !important; height: auto !important; object-fit: contain !important; }
.zz p { margin: 0 0 8px 0; }
.zz .sub { color: #555; font-size: 8.5pt; }
.zz .line { border-bottom: 1px solid #444; display: inline-block; min-width: 300px; padding: 0 6px; text-align: center; }
</style>
<div class="zz" style="font-family: 'Times New Roman', Times, serif; font-size: 11pt; line-height: 1.5; color: #000; max-width: 800px; margin: 0 auto; text-align: left;">

<p style="text-align: right;">{%Miejscowość firmy%}, {%Data dzisiejsza data:(d.m.Y)%}<br><span class="sub">(miejscowość, data)</span></p>

<p style="margin-top: 10px;"><strong>{%Nazwa firmy%}</strong><br>
ul. {%Ulica firmy%} {%Numer domu firmy%}, {%Kod pocztowy firmy%} {%Miejscowość firmy%}<br>
NIP {%NIP firmy%}<br><span class="sub">(pieczęć zakładu pracy)</span></p>

<div style="text-align: center; font-weight: bold; font-size: 14pt; letter-spacing: 1px; margin: 26px 0 4px 0;">ZAŚWIADCZENIE</div>
<div style="text-align: center; font-weight: bold; font-size: 12pt; margin: 0 0 22px 0;">O ZATRUDNIENIU NA UMOWIE ZLECENIE</div>

<p style="text-align: center;">Stwierdza się, że Pan/i</p>
<p style="text-align: center;"><span class="line"><strong>{%Nazwisko%} {%Imię%}</strong></span><br><span class="sub">(nazwisko i imię)</span></p>
<p style="text-align: center;">nr PESEL: <span class="line" style="min-width: 220px;">{%PESEL pracownika%}</span></p>

<p style="margin-top: 16px;">Wykonywał/a pracę na podstawie: <strong>umowy zlecenie</strong><br>
w okresie od dnia <strong>{%Data rozpoczęcia pracy data:(d.m.Y)%}</strong> do dnia <strong>{%Data zakończenia pracy data:(d.m.Y)%}</strong><br>
w firmie: <strong>{%Nazwa firmy%}</strong>, ul. {%Ulica firmy%} {%Numer domu firmy%}, {%Kod pocztowy firmy%} {%Miejscowość firmy%}<br>
<span class="sub">(nazwa zakładu pracy)</span></p>

<table style="width: 100%; border-collapse: collapse; margin-top: 40px;">
  <tr>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracodawcy%}</div>
      <span class="sub">(pieczęć i podpis pracodawcy lub osoby upoważnionej)</span>
    </td>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracownika%}</div>
      <span class="sub">(podpis pracownika)</span>
    </td>
  </tr>
</table>
</div>
$html$),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'zaswiadczenie');
