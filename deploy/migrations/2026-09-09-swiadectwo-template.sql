-- Шаблон «Świadectwo pracy» (kind=swiadectwo) для ланцюжка звільнення (08.09.2026):
-- структура за pomocniczym wzorem świadectwa pracy (rozporządzenie MRPiPS w sprawie świadectwa
-- pracy, t.j. Dz.U. 2024 poz. 1016): nagłówek, pkt 1–8, podpis, POUCZENIE. Дані підставляються
-- з профілю/анкети/фірми (buildContractData); пункти, що не стосуються zlecenia, — «nie dotyczy».
-- Ідемпотентно: не вставляє, якщо шаблон з таким kind уже є. Усі мови = PL (документ польською).
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'swiadectwo', 'Świadectwo pracy (przy zwolnieniu)', true, 'all', '[]'::jsonb, '[]'::jsonb,
  jsonb_build_object('pl', $html$
<style>
.sig-box img { max-height: 45px !important; max-width: 160px !important; width: auto !important; height: auto !important; object-fit: contain !important; }
.sp p { margin: 0 0 6px 0; }
.sp .sub { color: #555; font-size: 8.5pt; }
.sp ol { margin: 4px 0 8px 22px; padding: 0; }
.sp li { margin-bottom: 4px; }
</style>
<div class="sp" style="font-family: 'Times New Roman', Times, serif; font-size: 10.5pt; line-height: 1.4; color: #000; max-width: 800px; margin: 0 auto; text-align: left;">

<table style="width: 100%; border-collapse: collapse; margin-bottom: 18px;">
  <tr>
    <td style="width: 55%; vertical-align: top;">
      <strong>{%Nazwa firmy%}</strong><br>
      ul. {%Ulica firmy%} {%Numer domu firmy%}, {%Kod pocztowy firmy%} {%Miejscowość firmy%}<br>
      NIP {%NIP firmy%}<br>
      <span class="sub">(pracodawca oraz jego siedziba lub miejsce zamieszkania)</span><br>
      <span style="display:inline-block; margin-top:6px;">Nr REGON-PKD: <strong>{%REGON firmy%}</strong> – {%PKD firmy%}</span>
    </td>
    <td style="width: 45%; vertical-align: top; text-align: right;">
      {%Miejscowość firmy%}, {%Data dzisiejsza data:(d.m.Y)%}<br>
      <span class="sub">(miejscowość i data)</span>
    </td>
  </tr>
</table>

<div style="text-align: center; font-weight: bold; font-size: 15pt; letter-spacing: 2px; margin: 10px 0 18px 0;">ŚWIADECTWO PRACY</div>

<p><strong>1.</strong> Stwierdza się, że <strong>{%Imię%} {%Drugie imię%} {%Nazwisko%}</strong><br>
<span class="sub">(imię (imiona) i nazwisko pracownika)</span><br>
imiona rodziców: {%Imię ojca%}, {%Imię matki%}<br>
urodzony/a: <strong>{%Data urodzenia data:(d.m.Y)%}</strong><br>
był/a zatrudniony/a w: <strong>{%Nazwa firmy%}</strong>, ul. {%Ulica firmy%} {%Numer domu firmy%}, {%Kod pocztowy firmy%} {%Miejscowość firmy%}<br>
w okresie od <strong>{%Data rozpoczęcia pracy data:(d.m.Y)%}</strong> do <strong>{%Data zakończenia pracy data:(d.m.Y)%}</strong><br>
w wymiarze: zgodnie z umową (umowa zlecenie — praca w wymiarze wynikającym z grafiku).</p>

<p><strong>2.</strong> W okresie zatrudnienia pracownik wykonywał pracę tymczasową na rzecz: <strong>{%Nazwa Klienta%}</strong> (pracodawca użytkownik / podmiot, na rzecz którego świadczono pracę) w okresie od {%Data rozpoczęcia pracy data:(d.m.Y)%} do {%Data zakończenia pracy data:(d.m.Y)%}.</p>

<p><strong>3.</strong> W okresie zatrudnienia pracownik wykonywał pracę: <strong>{%Stanowisko%}</strong> — {%Czynności%}<br>
<span class="sub">(zajmowane stanowiska lub pełnione funkcje)</span></p>

<p><strong>4.</strong> Stosunek pracy ustał w wyniku:<br>
a) rozwiązania: <strong>rozwiązanie umowy z dniem {%Data zakończenia pracy data:(d.m.Y)%}</strong><br>
<span class="sub">(tryb i podstawa prawna rozwiązania stosunku pracy — uzupełnić w razie potrzeby: za porozumieniem stron / za wypowiedzeniem przez pracownika / przez pracodawcę)</span><br>
b) ……………………………… <span class="sub">(szczególne przypadki rozwiązania stosunku pracy)</span><br>
c) wygaśnięcia: nie dotyczy <span class="sub">(podstawa prawna wygaśnięcia stosunku pracy)</span></p>

<p><strong>5.</strong> Został zastosowany skrócony okres wypowiedzenia umowy o pracę na podstawie art. 36<sup>1</sup> § 1 Kodeksu pracy: nie dotyczy.</p>

<p><strong>6.</strong> W okresie zatrudnienia pracownik:</p>
<ol>
  <li>wykorzystał urlop wypoczynkowy w wymiarze: nie dotyczy <span class="sub">(urlop wypoczynkowy wykorzystany w roku kalendarzowym, w którym ustał stosunek pracy)</span>, w tym: nie dotyczy <span class="sub">(urlop wykorzystany na podstawie art. 167<sup>2</sup> Kodeksu pracy)</span>;</li>
  <li>korzystał z urlopu bezpłatnego: nie dotyczy <span class="sub">(okres trwania urlopu bezpłatnego i podstawa prawna jego udzielenia)</span>;</li>
  <li>wykorzystał urlop ojcowski: nie dotyczy;</li>
  <li>wykorzystał urlop rodzicielski: nie dotyczy;</li>
  <li>wykorzystał urlop wychowawczy: nie dotyczy;</li>
  <li>korzystał z ochrony stosunku pracy, o której mowa w art. 186<sup>8</sup> § 1 pkt 2 Kodeksu pracy, w okresie: nie dotyczy;</li>
  <li>wykorzystał zwolnienie od pracy przewidziane w art. 188 Kodeksu pracy w wymiarze: nie dotyczy;</li>
  <li>wykorzystał zwolnienie od pracy przewidziane w art. 148<sup>1</sup> Kodeksu pracy (siła wyższa) w wymiarze: nie dotyczy;</li>
  <li>wykorzystał urlop opiekuńczy, o którym mowa w art. 173<sup>1</sup> Kodeksu pracy, w wymiarze: nie dotyczy;</li>
  <li>wykonywał okazjonalnie pracę zdalną (art. 67<sup>33</sup> § 1 Kodeksu pracy) w wymiarze: nie dotyczy;</li>
  <li>był niezdolny do pracy przez okres: …… dni <span class="sub">(liczba dni, za które pracownik otrzymał wynagrodzenie zgodnie z art. 92 Kodeksu pracy, w roku kalendarzowym, w którym ustał stosunek pracy)</span>;</li>
  <li>odbył służbę wojskową w okresie: nie dotyczy;</li>
  <li>wykonywał pracę w szczególnych warunkach lub w szczególnym charakterze: nie dotyczy;</li>
  <li>wykorzystał dodatkowy urlop albo inne uprawnienia lub świadczenia przewidziane przepisami prawa pracy: nie dotyczy;</li>
  <li>okresy nieskładkowe: ……………………………… <span class="sub">(przypadające w okresie zatrudnienia, uwzględniane przy ustalaniu prawa do emerytury lub renty)</span>.</li>
</ol>

<p><strong>7.</strong> Informacja o zajęciu wynagrodzenia: nie dotyczy <span class="sub">(oznaczenie komornika i numer sprawy egzekucyjnej, wysokość potrąconych kwot)</span>.</p>

<p><strong>8.</strong> Informacje uzupełniające: ………………………………</p>

<table style="width: 100%; border-collapse: collapse; margin-top: 28px;">
  <tr>
    <td style="width: 50%;"></td>
    <td style="width: 50%; text-align: center;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracodawcy%}</div>
      <div style="font-size: 9pt; margin-top: 4px;">{%Reprezentant firmy%}</div>
      <div class="sub">(podpis pracodawcy lub osoby działającej w jego imieniu)</div>
    </td>
  </tr>
</table>

<div style="margin-top: 26px; border-top: 1px solid #333; padding-top: 8px; font-size: 9pt; text-align: justify;">
<strong>POUCZENIE</strong><br>
Pracownik może w ciągu 14 dni od dnia otrzymania świadectwa pracy wystąpić do pracodawcy z wnioskiem o sprostowanie tego świadectwa. W razie nieuwzględnienia wniosku pracownikowi przysługuje, w ciągu 14 dni od dnia otrzymania zawiadomienia o odmowie sprostowania świadectwa pracy, prawo wystąpienia z żądaniem sprostowania świadectwa pracy do Sądu Rejonowego – Sądu Pracy w {%Miejscowość firmy%} (podstawa prawna – art. 97 § 2<sup>1</sup> Kodeksu pracy). W przypadku niezawiadomienia przez pracodawcę o odmowie sprostowania świadectwa pracy, żądanie sprostowania świadectwa pracy wnosi się do sądu pracy.
</div>
</div>
$html$)
  || jsonb_build_object('en', '', 'es', '', 'ru', '', 'uk', ''),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'swiadectwo');
