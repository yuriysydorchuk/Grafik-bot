import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaceholder, extractPlaceholderKeys, substitutePlaceholders, missingFields } from "./contracts.ts";

// Чисті юніти рушія підстановки {%Плейсхолдер%} (формат реального архіву
// HrAppka, план worker-docs-signing Додаток A) — без БД.

test("parsePlaceholder: розділяє ключ і модифікатор (останній «токен» data:/format:/język:)", () => {
  assert.deepEqual(parsePlaceholder("Data urodzenia"), { key: "Data urodzenia", modifier: null });
  assert.deepEqual(parsePlaceholder("Data urodzenia data:(d.m.Y)"), { key: "Data urodzenia", modifier: "data:(d.m.Y)" });
  assert.deepEqual(parsePlaceholder("Ankieta student format:tak_nie"), { key: "Ankieta student", modifier: "format:tak_nie" });
  assert.deepEqual(parsePlaceholder("Czynności język:en"), { key: "Czynności", modifier: "język:en" });
  assert.deepEqual(parsePlaceholder("Rachunek pracownika format:iban"), { key: "Rachunek pracownika", modifier: "format:iban" });
});

test("extractPlaceholderKeys: витягує унікальні базові ключі з HTML", () => {
  const html = "<p>{%Imię%} {%Nazwisko%}, {%Data urodzenia data:(d.m.Y)%}. {%Imię%} ще раз.</p>";
  assert.deepEqual(extractPlaceholderKeys(html).sort(), ["Data urodzenia", "Imię", "Nazwisko"]);
});

test("substitutePlaceholders: підставляє дані, форматує data:/format:tak_nie, HTML-екранує значення", () => {
  const html = "<p>{%Imię%} {%Data urodzenia data:(d.m.Y)%} {%Ankieta student format:tak_nie%}</p>";
  const out = substitutePlaceholders(html, { "Imię": "Jan <script>", "Data urodzenia": "2000-05-14", "Ankieta student": "Tak" });
  assert.match(out, /Jan &lt;script&gt;/);
  assert.match(out, /14\.05\.2000/);
  assert.match(out, /Tak(?!.*Nie)/s);
});

test("substitutePlaceholders: підпис-плейсхолдери підставляють <img>, не екранують і не позначаються бракуючими", () => {
  const html = "<div>{%Podpis odręczny pracownika%}</div><div>{%Podpis odręczny pracodawcy%}</div>";
  const unsigned = substitutePlaceholders(html, {});
  assert.doesNotMatch(unsigned, /<img/);

  const signed = substitutePlaceholders(html, {}, {
    workerSignatureDataUrl: "data:image/png;base64,AAA", companyStampDataUrl: "data:image/png;base64,BBB",
  });
  assert.match(signed, /<img src="data:image\/png;base64,AAA"/);
  assert.match(signed, /<img src="data:image\/png;base64,BBB"/);
});

test("missingFields: лише ключі, ВІДСУТНІ у словнику (undefined) — не порожні рядки", () => {
  const data = { "Imię": "Jan", "Nazwisko": "", "Wynagrodzenie słownie": undefined as unknown as string };
  delete (data as Record<string, string>)["Wynagrodzenie słownie"];
  assert.deepEqual(missingFields(data, ["Imię", "Nazwisko", "Wynagrodzenie słownie"]), ["Wynagrodzenie słownie"]);
});
