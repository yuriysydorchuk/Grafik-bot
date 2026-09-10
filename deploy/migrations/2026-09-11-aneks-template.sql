-- Aneks do umowy zlecenia — продовження терміну (kind=aneks). Рішення власника 10.09.2026: коли
-- умова закінчилась, графікова з задачі «звільнити або продовжити» обирає нову дату → документ
-- одразу на підпис працівнику; після підпису обома (працівник → фірма автоматично) date_to
-- оригінальної умови подовжується (services/contractEndDocs.ts createContractAnnex, finalize).
-- Текст — стандартний польський аннекс на зміну терміну (зразка від офісу не було — ПЕРЕВІРИТИ).
-- «Data zawarcia umowy» = початок оригінальної умови, «Poprzednia data zakończenia» = її старий кінець,
-- «Data zakończenia pracy» = нова дата. Ідемпотентно; документ польською.
INSERT INTO document_templates (kind, title, is_base, scope, scope_company_ids, scope_factory_ids, body, is_active)
SELECT 'aneks', 'Aneks do umowy zlecenia — przedłużenie', true, 'all', '[]'::jsonb, '[]'::jsonb,
  jsonb_build_object('pl', $html$
<style>
.sig-box img { max-height: 45px !important; max-width: 160px !important; width: auto !important; height: auto !important; object-fit: contain !important; }
.an p { margin: 0 0 8px 0; }
.an .sub { color: #555; font-size: 8.5pt; }
</style>
<div class="an" style="font-family: 'Times New Roman', Times, serif; font-size: 11pt; line-height: 1.5; color: #000; max-width: 800px; margin: 0 auto; text-align: left;">

<p style="text-align: right;">{%Miejscowość firmy%}, {%Data dzisiejsza data:(d.m.Y)%}</p>

<div style="text-align: center; font-weight: bold; font-size: 13pt; letter-spacing: 1px; margin: 16px 0 4px 0;">ANEKS DO UMOWY ZLECENIA</div>
<div style="text-align: center; margin: 0 0 18px 0;">zawartej dnia <strong>{%Data zawarcia umowy data:(d.m.Y)%}</strong></div>

<p>pomiędzy:</p>
<p><strong>{%Nazwa firmy%}</strong>, ul. {%Ulica firmy%} {%Numer domu firmy%}, {%Kod pocztowy firmy%} {%Miejscowość firmy%}, NIP {%NIP firmy%},
reprezentowaną przez {%Reprezentant firmy%} — zwaną dalej <strong>Zleceniodawcą</strong>,</p>
<p>a</p>
<p><strong>{%Imię%} {%Nazwisko%}</strong>, PESEL {%PESEL pracownika%}, zamieszkały/a: {%Pełny adres pracownika%} — zwanym/ą dalej <strong>Zleceniobiorcą</strong>.</p>

<p style="margin-top: 14px;"><strong>§ 1.</strong> Strony zgodnie postanawiają, że umowa zlecenia, o której mowa wyżej, zawarta na okres do dnia
<strong>{%Poprzednia data zakończenia data:(d.m.Y)%}</strong>, zostaje przedłużona i będzie obowiązywać
<strong>do dnia {%Data zakończenia pracy data:(d.m.Y)%}</strong>.</p>
<p><strong>§ 2.</strong> Pozostałe postanowienia umowy zlecenia pozostają bez zmian.</p>
<p><strong>§ 3.</strong> Aneks wchodzi w życie z dniem podpisania.</p>
<p><strong>§ 4.</strong> Aneks sporządzono w dwóch jednobrzmiących egzemplarzach, po jednym dla każdej ze stron.</p>

<table style="width: 100%; border-collapse: collapse; margin-top: 44px;">
  <tr>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracodawcy%}</div>
      <span class="sub">Zleceniodawca (pieczęć i podpis)</span>
    </td>
    <td style="width: 50%; text-align: center; vertical-align: top;">
      <div class="sig-box" style="width: 220px; height: 60px; margin: 0 auto; border: 1px dashed #999; background-color: #f7f7f7;">{%Podpis odręczny pracownika%}</div>
      <span class="sub">Zleceniobiorca</span>
    </td>
  </tr>
</table>
</div>
$html$),
  true
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE kind = 'aneks');
