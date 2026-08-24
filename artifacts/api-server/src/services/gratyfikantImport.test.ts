import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectFileKind, parseUmowyRows, parseKartotekaRows, matchNexo, candidateMap,
  defaultPayDate, umowaStatusFor, normName,
} from "./gratyfikantImport.ts";

// ── детект типу файлу ────────────────────────────────────────────────────────
test("детект: список умов і картотека по заголовках", () => {
  assert.equal(detectFileKind(["U", "Pracownik", "Nr umowy", "Od dnia", "Do dnia", "Dział", "Flaga"]), "umowy");
  assert.equal(detectFileKind(["S", "P", "Nazwisko i imię", "PESEL", "Adres", "Miejscowość", "Telefon", "Flaga"]), "kartoteka");
  assert.equal(detectFileKind(["Pracownik", "Data", "Wartość"]), null);
});

// ── парсери ──────────────────────────────────────────────────────────────────
test("парсер умов: колонки по заголовках, дати нормалізуються, порожні рядки пропускаються", () => {
  const rows = [
    ["U", "Pracownik", "Nr umowy", "Od dnia", "Do dnia", "Kwota na UC", "Dział", "Flaga"],
    ["UC", "BUNTU COLY", "UC 182/2026", new Date("2026-07-13T00:00:00Z"), "2026-12-31", 0, "FABRYKA > EUROCASH", "NIEOPODATKOWANE"],
    ["UC", "", "", "", "", "", "", ""],
    ["UC", "ABZALULY  AYAN", "UZ/2025/376", "2025-10-07", "brak", 0, "-", ""],
  ];
  const out = parseUmowyRows(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: "BUNTU COLY", nr: "UC 182/2026", od: "2026-07-13", do: "2026-12-31", dzial: "FABRYKA > EUROCASH" });
  assert.equal(out[1]!.name, "ABZALULY AYAN"); // подвійний пробіл сколапсовано
  assert.equal(out[1]!.do, null);              // «brak» — не дата
});

test("парсер картотеки: PESEL лише 11 цифр, решта — null", () => {
  const rows = [
    ["S", "P", "Nazwisko i imię", "PESEL", "Adres"],
    ["", "", "ABI AAD CHARBEL", "03261712716", "os. Wichrowe"],
    ["", "", "BROKEN PESEL", "1234", ""],
  ];
  const out = parseKartotekaRows(rows);
  assert.deepEqual(out.map(r => r.pesel), ["03261712716", null]);
});

// ── матчер ───────────────────────────────────────────────────────────────────
const cands = candidateMap([
  { name: "KENZHEBAEVA MAIRAMGUL" }, { name: "DONGO TICHATONGA" }, { name: "GADZA LOUIS" },
  { name: "DMYTRUK KARINA" }, { name: "KOURDI MOHAMMED A" }, { name: "IBAÑEZ CACERES MARIA" },
  { name: "GONZALEZ CORONEL NERI" }, { name: "GONZALEZ CORONEL PEDRO" },
]);

test("матчер: точний, перестановка, відкинуті середні імена, діакритика", () => {
  assert.equal(matchNexo("Gadza Louis", cands)?.method, "exact");
  assert.equal(matchNexo("Mairamgul Kenzhebaeva", cands)?.hit.name, "KENZHEBAEVA MAIRAMGUL");
  assert.equal(matchNexo("Dongo Tichatonga Blessing", cands)?.hit.name, "DONGO TICHATONGA");
  assert.equal(matchNexo("Ibanez Caceres Maria", cands)?.method, "exact"); // Ñ → N
});

test("матчер: fuzzy ловить одрукування, але не сміття", () => {
  assert.equal(matchNexo("Dmytryk Karina", cands)?.method, "fuzzy"); // y↔u
  // суфікс «- D» — заборонений для нестрогих матчів
  assert.equal(matchNexo("Kondratieva Nikol - D", cands), null);
  // одна літера «A» в кандидата не має примагнічувати чужі імена
  assert.equal(matchNexo("Amara Amdjed Takieddine", cands), null);
  // неоднозначність (двоє GONZALEZ CORONEL …) → null
  assert.equal(matchNexo("Gonzales Coronel", cands), null);
});

// ── дата виплати й статус умови ──────────────────────────────────────────────
test("дефолтна дата виплати: 25-те наступного місяця (грудень → січень)", () => {
  assert.equal(defaultPayDate("2026-07"), "2026-08-25");
  assert.equal(defaultPayDate("2026-12"), "2027-01-25");
});

test("статус умови: ok / expired / none / other_firm", () => {
  const u = (firm: string, od: string | null, doo: string | null) => ({ firm, od, do: doo });
  assert.equal(umowaStatusFor("2026-07", "ESO", [u("ESO", "2026-01-01", "2026-12-31")]), "ok");
  assert.equal(umowaStatusFor("2026-07", "ESO", [u("ESO", "2026-01-01", "2026-07-13")]), "ok"); // перетин з місяцем є
  assert.equal(umowaStatusFor("2026-07", "ESO", [u("ESO", "2026-01-01", "2026-06-30")]), "expired");
  assert.equal(umowaStatusFor("2026-07", "ESO", []), "none");
  assert.equal(umowaStatusFor("2026-07", "ESO", [u("ES", "2026-01-01", "2026-12-31")]), "other_firm");
});

test("normName: діакритика і регістр", () => {
  assert.equal(normName("Ibañez  Caceres"), "IBANEZ CACERES");
  assert.equal(normName("łukasz"), "LUKASZ");
});
