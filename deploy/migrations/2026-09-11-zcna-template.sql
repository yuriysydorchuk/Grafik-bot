-- ZUS ZCNA — zgłoszenie danych o członkach rodziny (kind=zcna), рішення власника 10.09.2026.
-- HTML-репліка розділів бланка ZUS ZCNA (I–VII; бланк з офісу — плоский PDF без форм-полів):
-- II płatnik (фірма), III ubezpieczony (працівник), IV/V члени родини — таблиця з
-- {%Członkowie rodziny format:html%} (services/zcna.ts), VI/VII oświadczenia + підписи.
-- Генерується лише на прохання працівника; в автонабір не входить (EVENT_KINDS). Ідемпотентно.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'zcna', 'ZUS ZCNA — zgłoszenie członków rodziny', true, 'all', '[]'::jsonb, '[]'::jsonb,
  jsonb_build_object('pl', $html$
<style>
.sig-box img { max-height: 45px !important; max-width: 160px !important; width: auto !important; height: auto !important; object-fit: contain !important; }
.zc p { margin: 0 0 5px 0; }
.zc .sec { font-weight: bold; font-size: 9.5pt; margin: 12px 0 4px 0; border-bottom: 1px solid #999; padding-bottom: 2px; }
.zc .sub { color: #555; font-size: 8pt; }
.zc .kv td { padding: 2px 8px 2px 0; font-size: 9.5pt; vertical-align: top; }
</style>
<div class="zc" style="font-family: 'Times New Roman', Times, serif; font-size: 10pt; line-height: 1.35; color: #000; max-width: 800px; margin: 0 auto; text-align: left;">

<table style="width:100%; border-collapse: collapse; margin-bottom: 8px;">
  <tr>
    <td style="width: 30%; vertical-align: top;"><strong style="font-size: 13pt;">ZUS ZCNA</strong><br><span class="sub">Zakład Ubezpieczeń Społecznych</span></td>
    <td style="width: 70%; vertical-align: top; text-align: right;"><strong>ZGŁOSZENIE DANYCH O CZŁONKACH RODZINY<br>DLA CELÓW UBEZPIECZENIA ZDROWOTNEGO</strong></td>
  </tr>
</table>
<p class="sub">Formularz przygotowany na podstawie ankiety zleceniobiorcy; dane przenosi do systemu ZUS płatnik składek. Liczba członków rodziny: {%Liczba członków rodziny%}.</p>

<div class="sec">I. DANE ORGANIZACYJNE</div>
<table class="kv"><tr><td>01. Data nadania:</td><td>{%Data dzisiejsza data:(d.m.Y)%}</td></tr></table>

<div class="sec">II. DANE IDENTYFIKACYJNE PŁATNIKA SKŁADEK</div>
<table class="kv">
  <tr><td>01. NIP:</td><td>{%NIP firmy%}</td><td>02. REGON:</td><td>{%REGON firmy%}</td></tr>
  <tr><td>06. Nazwa skrócona:</td><td colspan="3">{%Nazwa skrócona płatnika%}</td></tr>
  <tr><td>Pełna nazwa:</td><td colspan="3">{%Nazwa firmy%}, ul. {%Ulica firmy%} {%Numer domu firmy%}, {%Kod pocztowy firmy%} {%Miejscowość firmy%}</td></tr>
</table>

<div class="sec">III. DANE IDENTYFIKACYJNE OSOBY UBEZPIECZONEJ</div>
<table class="kv">
  <tr><td>01. PESEL:</td><td>{%PESEL pracownika%}</td><td>03. Rodzaj dokumentu (1 dowód / 2 paszport):</td><td>{%Rodzaj dokumentu ZCNA%}</td></tr>
  <tr><td>04. Seria i numer dokumentu:</td><td>{%Seria i numer dokumentu ZCNA%}</td><td>07. Data urodzenia:</td><td>{%Data urodzenia data:(d.m.Y)%}</td></tr>
  <tr><td>05. Nazwisko:</td><td>{%Nazwisko%}</td><td>06. Imię pierwsze:</td><td>{%Imię%}</td></tr>
</table>

<div class="sec">IV–V. DANE O CZŁONKACH RODZINY OSOBY UBEZPIECZONEJ UPRAWNIONYCH DO ŚWIADCZEŃ Z UBEZPIECZENIA ZDROWOTNEGO</div>
<p class="sub">A. dane identyfikacyjne (01 — 1 zgłoszenie / 2 wyrejestrowanie; 10 — kod stopnia pokrewieństwa; 11 — X = wspólne gospodarstwo domowe; 12 — kod stopnia niepełnosprawności); B. adres zamieszkania, jeśli inny niż ubezpieczonego.</p>
{%Członkowie rodziny format:html%}

<table style="width: 100%; border-collapse: collapse; margin-top: 14px;">
  <tr>
    <td style="width: 50%; vertical-align: top; padding-right: 12px;">
      <div class="sec">VI. OŚWIADCZENIE PŁATNIKA SKŁADEK</div>
      <p>01. Data wypełnienia: {%Data dzisiejsza data:(d.m.Y)%}</p>
      <p style="font-size: 9pt;">Oświadczam, że dane zawarte w formularzu są zgodne ze stanem prawnym i faktycznym. Jestem świadomy(-ma) odpowiedzialności karnej za zeznanie nieprawdy lub zatajenie prawdy.</p>
      <div class="sig-box" style="width: 220px; height: 60px; margin: 8px 0 0 0; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracodawcy%}</div>
      <span class="sub">02–03. Podpis i pieczątka płatnika składek lub osoby upoważnionej</span>
    </td>
    <td style="width: 50%; vertical-align: top; padding-left: 12px;">
      <div class="sec">VII. OŚWIADCZENIE OSOBY UBEZPIECZONEJ</div>
      <p style="font-size: 9pt; margin-top: 22px;">Oświadczam, że dane zawarte w formularzu są zgodne ze stanem prawnym i faktycznym. Jestem świadomy(-ma) odpowiedzialności karnej za zeznanie nieprawdy lub zatajenie prawdy.</p>
      <div class="sig-box" style="width: 220px; height: 60px; margin: 8px 0 0 0; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracownika%}</div>
      <span class="sub">01. Podpis osoby ubezpieczonej</span>
    </td>
  </tr>
</table>
</div>
$html$),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'zcna');
