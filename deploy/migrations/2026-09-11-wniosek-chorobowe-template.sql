-- Wniosek o objęcie dobrowolnym ubezpieczeniem chorobowym (kind=wniosek_chorobowe):
-- за зразком з офісу (Downloads/wniosekoobjciedobr.chorobowego.pdf, 10.09.2026). У сталий пакет
-- потрапляє ЛИШЕ коли в анкеті ankieta_skladka_chorobowa = true (services/contracts.ts
-- resolveDocumentSet). Ідемпотентно; документ польською.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'wniosek_chorobowe', 'Wniosek — dobrowolne ubezpieczenie chorobowe', true, 'all', '[]'::jsonb, '[]'::jsonb,
  jsonb_build_object('pl', $html$
<style>
.sig-box img { max-height: 45px !important; max-width: 160px !important; width: auto !important; height: auto !important; object-fit: contain !important; }
.wc p { margin: 0 0 6px 0; }
.wc .sub { color: #555; font-size: 8.5pt; }
.wc .line { border-bottom: 1px dotted #444; display: inline-block; min-width: 260px; padding: 0 4px; }
</style>
<div class="wc" style="font-family: 'Times New Roman', Times, serif; font-size: 11pt; line-height: 1.5; color: #000; max-width: 800px; margin: 0 auto; text-align: left;">

<p style="text-align: right;"><span class="line">{%Miejscowość firmy%}, {%Data dzisiejsza data:(d.m.Y)%}</span><br>
<span class="sub" style="display:inline-block; min-width: 260px; text-align: center;">Miejscowość, data</span></p>

<p style="margin-top: 18px;"><span class="line">{%Imię%} {%Nazwisko%}</span><br><span class="sub">imię i nazwisko</span></p>
<p><span class="line">{%Pełny adres pracownika%}</span><br><span class="sub">adres zameldowania/zamieszkania</span></p>
<p><span class="line">{%PESEL pracownika%}</span><br><span class="sub">nr PESEL</span></p>

<div style="text-align: center; font-weight: bold; font-size: 13pt; margin: 28px 0 18px 0;">Wniosek o objęcie dobrowolnym ubezpieczeniem chorobowym</div>

<p>Proszę o zgłoszenie mnie do dobrowolnego ubezpieczenia chorobowego od dnia
<strong>{%Data rozpoczęcia pracy data:(d.m.Y)%}</strong>.</p>

<table style="width: 100%; border-collapse: collapse; margin-top: 46px;">
  <tr>
    <td style="width: 50%;"></td>
    <td style="width: 50%; text-align: center;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracownika%}</div>
      <span class="sub">Podpis</span>
    </td>
  </tr>
</table>
</div>
$html$),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'wniosek_chorobowe');
