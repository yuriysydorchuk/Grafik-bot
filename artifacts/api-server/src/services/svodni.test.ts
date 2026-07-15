import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLublinTab, parseWorkList, parseLodzFullTab, parseGotowkaTab, overlayGotowka, computeMismatch, parseOfficeTab,
  legalStatusOf, computeKsiegHours, applyLegalDefaults,
} from "./svodni.ts";

const near = (actual: number | null | undefined, expected: number, msg?: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 0.01, msg ?? `${actual} ≉ ${expected}`);

// ── Люблін: базова вкладка зі ставками, STUD, блоком księgowość ───────────────
test("Люблін: рядок людини — усі колонки, формула do wypłaty, STUD-маркер", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Zaliczka", "Hostel", "Kara za nieobecność", "Do wypłaty Netto", "Brutto", "Księgowość", "Data Urodzenia"],
    ["KOWALSKI JAN", 40, 160, 31.4, 25.35, 500, 650, 0, 160 * 25.35 - 500 - 650, 160 * 31.4, "Zgłoszony, Wyżej 26", "01.01.1990"],
    ["NOWAK ANNA", "STUD", 100, 31.4, 31.4, "", "", "", 3140, 3140, "Zgłoszony, do 26, student", "05.05.2004"],
    ["Suma Godzin", "", 260, "", "", 500, 650, 0, 5904, "", "", ""],
    ["ILOŚĆ PRACOWNIKÓW", 2],
    ["W TYM STUDENTÓW", 1],
  ];
  const p = parseLublinTab("TESTOWA", rows)!;
  assert.equal(p.rows.length, 2);
  const [jan, anna] = p.rows;
  near(jan!.hours, 160);
  near(jan!.rateNetto, 25.35);
  near(jan!.zaliczka, 500);
  near(jan!.hostel, 650);
  near(jan!.doWyplaty, 2906);
  near(jan!.brutto, 5024);
  assert.equal(jan!.isStudent, false);
  assert.equal(jan!.under26, false);
  assert.equal(anna!.isStudent, true);
  assert.equal(anna!.under26, true);
  assert.equal(anna!.hr.dataUrodzenia, "05.05.2004");
  near(p.sheetSuma.hours!, 260);
  near(p.sheetSuma.doWyplaty!, 5904);
  assert.equal(p.counts.workers, 2);
  assert.equal(p.counts.students, 1);
  for (const r of p.rows) computeMismatch(r, "Люблін");
  assert.equal(p.rows.filter(r => r.mismatch).length, 0);
  // порядок колонок — як у таблиці; кадрові після Do wypłaty — hr.*
  assert.deepEqual(p.colOrder, [
    "hoursNotified", "hours", "rateBrutto", "rateNetto", "zaliczka", "hostel",
    "kara", "doWyplaty", "brutto", "extras.zusStatus", "hr.dataUrodzenia",
  ]);
  assert.equal(p.nameCol, 0);
  assert.equal(jan!.sheetRow, 1);
});

test("Люблін: інфо-блок STAWKA EUROCASH зберігається як є", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka netto", "Do wypłaty Netto"],
    ["NKOMO CRAIG", "STUD", 158, 35.68, 5637.44],
    ["Suma Godzin", "", 158, "", 5637.44],
    [],
    ["STAWKA EUROCASH", 41.2, 42.43],
    [5.55, "1 - 114.99", "115-124.99"],
    [3.5, 24.6, 25.03],
    [4.5, 30.5, 31],
    ["", 1, 2],
  ];
  const p = parseLublinTab("EUROCASH TEST", rows)!;
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.info?.stawkaEurocash, [
    ["STAWKA EUROCASH", 41.2, 42.43],
    [5.55, "1 - 114.99", "115-124.99"],
    [3.5, 24.6, 25.03],
    [4.5, 30.5, 31],
    ["", 1, 2], // рядок нумерації рівнів — дзеркалимо як у таблиці
  ]);
});

test("Люблін: «Brutto|Netto» перед Do Wypłaty — це ставки (ANDROS-варіант)", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Premia ES", "Brutto", "Netto", "Zaliczka", "Hostel", "Do Wypłaty", "Brutto", "Księgowość"],
    ["PEREZ MARIA", "", 96, "", 31.4, 25.35, "", 650, 96 * 25.35 - 650, "", "Zgłoszony, do 26"],
  ];
  const p = parseLublinTab("ANDROS TEST", rows)!;
  near(p.rows[0]!.rateBrutto, 31.4);
  near(p.rows[0]!.rateNetto, 25.35);
  assert.equal(p.rows[0]!.under26, true);
  for (const r of p.rows) computeMismatch(r, "Люблін");
  assert.equal(p.rows[0]!.mismatch, null);
});

test("Люблін: Premia ES на вкладці з Premia Agram — індикатор, не входить у виплату", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Premia Agram", "Premia ES", "Stawka brutto", "Stawka netto", "Zaliczka", "Do wypłaty Netto", "Brutto"],
    // формула таблиці: C*G − H + D (премія ES 1,5 — НЕ додається)
    ["WISNIEWSKA EWA", 40, 170, 100, 1.5, 31.4, 26.85, 0, 170 * 26.85 + 100, ""],
  ];
  const p = parseLublinTab("AGRAM MOTYCZ", rows)!;
  near(p.rows[0]!.premia, 100); // лише Premia Agram
  assert.equal(p.rows[0]!.extras.premiaEs, 1.5);
  for (const r of p.rows) computeMismatch(r, "Люблін");
  assert.equal(p.rows[0]!.mismatch, null);
});

test("Люблін: нижній блок księgowość/готівка підтягується до людини", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto"],
    ["LIS TOMASZ", "", 180, 31.4, 25.35, 4563],
    ["Suma Godzin", "", 180, "", "", 4563],
    [],
    ["", "godz fakt", "godz księgowość", "brutto", "netto", "gotówka"],
    ["LIS TOMASZ", 180, 100, 3140, 2535, 2028],
  ];
  const p = parseLublinTab("BLOKOWA", rows)!;
  assert.equal(p.rows.length, 1);
  const w = p.rows[0]!;
  near(w.hoursDeclared, 100);
  near(w.ksiegBrutto, 3140);
  near(w.ksiegNetto, 2535);
  near(w.gotowka, 2028);
  near(w.konto, 2535);
});

// ── Познань: безлейбловий блок і Work List ────────────────────────────────────
test("Познань: блок без заголовків матчиться за іменами головної таблиці", () => {
  const rows = [
    ["", "Nr Osobowy", "Stanowisko", "Linia", "Szkolenie", 46174, "ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Zaliczka", "Do wypłaty Netto"],
    ["", 1001, "Pracownik", "-", "-", "SILVA NUWAN", 160, 160, 30.5, 24.6, 0, 3936],
    ["", "", "", "", "", "Suma Godzin", "", 160],
    [],
    // [імʼя, godz fakt, godz ksieg, brutto, netto, gotówka]
    ["", "", "", "", "", "SILVA NUWAN", 160, 120, 3660, 2952, 984],
  ];
  const p = parseLublinTab("Sushi&Food Factory", rows)!;
  assert.equal(p.rows.length, 1);
  const w = p.rows[0]!;
  assert.equal(w.hr.nrOsobowy, "1001");
  near(w.hoursDeclared, 120);
  near(w.gotowka, 984);
  near(w.konto, 2952);
});

test("Познань: Work List — години з часу × 24 або з числової колонки", () => {
  const wl = parseWorkList([
    ["Numer", "Imię Nazwisko", "SUMA GODZIN", "GODZINY LICZBOWO"],
    [1001, "SILVA NUWAN", 6.6666666, 160],
    [1002, "FERNANDO K", 5, ""],
  ]);
  near(wl.get("1001")!, 160);
  near(wl.get("1002")!, 120); // 5 діб × 24
});

// ── Лодзь: секційна вкладка, Ew.-розклад, Total, KONTO-номер ─────────────────
test("Лодзь: RAZEM-формула, Ew.-розклад офіційної частини, Total-рядок", () => {
  const rows = [
    ["Nazwisko/Imię", "Status", "Godzin", "Stawka/brutto", "Stawka/netto", "Premia", "Hostel", "Potrącenia", "Zaliczki", "Migawka", "RAZEM", "NA KONTO \"h\"", "Ew.", "h.", "zł.", "Dopłata ES", "KONTO", "Księgowość"],
    // RAZEM = 150×25.35 + 50 − 100 − 0 − 200 + 80 = 3632.5; Ew=60 → netto 1521, gotówka = 3632.5−1521+90=2201.5
    ["KOT ADAM", "Nie Stud.", 150, 31.4, 25.35, 80, 200, 0, 100, 50, 3632.5, "", 60, 90, "", 90, "12 3456 7890 1234 5678 9012 3456", ""],
    ["Total:", "", 150, "", "", 80, 200, 0, 100, 50, 3632.5, "", "", "", "", "", "", ""],
  ];
  const p = parseLodzFullTab("AUNDE", rows)!;
  assert.equal(p.rows.length, 1);
  const w = p.rows[0]!;
  near(w.doWyplaty, 3632.5);
  near(w.hoursDeclared, 60);
  near(w.ksiegNetto, 1521);
  near(w.gotowka, 2201.5);
  assert.equal(w.isStudent, false);
  near(p.sheetSuma.hours!, 150);
  near(p.sheetSuma.doWyplaty!, 3632.5);
  for (const r of p.rows) computeMismatch(r, "Лодзь");
  assert.equal(w.mismatch, null);
});

test("Лодзь: KONTO з номером рахунку не стає сумою", () => {
  const rows = [
    ["Imie/Nazwisko", "Status", "Godzin", "Stawka/brutto", "Stawka/netto", "Zaliczki", "RAZEM", "KONTO"],
    ["PTAK JAN", "Stud.", 100, 31.4, 31.4, 0, 3140, "68 1600 1462 1742 3750 4000 0001"],
  ];
  const p = parseLodzFullTab("PRINT EXTRA", rows)!;
  const w = p.rows[0]!;
  // номер рахунку не парситься як гроші; обмежений розклад → усе офіційно (konto = RAZEM)
  assert.equal(w.hr.kontoNr, "68 1600 1462 1742 3750 4000 0001");
  assert.equal(w.konto, 3140);
  assert.equal(w.ksiegNetto, 3140);
  assert.equal(w.hoursDeclared, 100, "Год. księg. = konto / ставка (без колонки NA KONTO h)");
});

test("форма легалізації: текст Księgowość → канонічний статус", () => {
  assert.equal(legalStatusOf("Zgłoszony, do 26, student"), "student");
  assert.equal(legalStatusOf("Zgłoszo, wyżej 26, student"), "student");
  assert.equal(legalStatusOf("Posiada Dyplom ukończenia studiów"), "dyplom");
  assert.equal(legalStatusOf("NIE ZGŁOSZONO, CZEKAMY NA ZEZWOLENIE"), "oczekuje");
  assert.equal(legalStatusOf("Zgłoszony, Decyzja Karty Pobytu"), "karta_pobytu");
  assert.equal(legalStatusOf("Zgłoszony, stały pobyt"), "staly_pobyt");
  assert.equal(legalStatusOf("Zgłoszony Polak / Polka"), "polak");
  assert.equal(legalStatusOf("Zgłoszony, Powiadomienie, Do 26"), "powiadomienie");
  assert.equal(legalStatusOf("Zgłoszony, Powiadomienie, Wyżej 26"), "powiadomienie");
  assert.equal(legalStatusOf("Zgłoszony, Wyżej 26"), "zus");
  assert.equal(legalStatusOf("Zgłoszony, Do 26"), "zus"); // вік — не форма легалізації
  assert.equal(legalStatusOf(""), null);
  assert.equal(legalStatusOf("щось невідоме"), null);
});

test("розклад за статусом: студент до 26 → все на конто; не зголошений → все готівкою", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["STUDENTKA ANNA", "STUD", 100, 31.4, 31.4, 3140, "Zgłoszony, do 26, student"],
    ["CZEKAJACY JAN", "", 100, 31.4, 25.35, 2535, "NIE ZGŁOSZONO, CZEKAMY NA ZEZWOLENIE"],
    ["ZWYKLY PIOTR", "", 100, 31.4, 25.35, 2535, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ];
  const p = parseLublinTab("TESTOWA", rows)!;
  for (const r of p.rows) applyLegalDefaults(r);
  const [stud, czek, zwykly] = p.rows;
  assert.equal(stud!.konto, 3140, "студент до 26: все до виплати йде на конто");
  assert.equal(stud!.ksiegNetto, 3140);
  assert.equal(stud!.ksiegBrutto, 3140, "студент: netto = brutto");
  assert.equal(stud!.gotowka, 0);
  assert.equal(stud!.hoursDeclared, 100);
  assert.equal(czek!.gotowka, 2535, "не зголошений: все готівкою");
  assert.equal(czek!.konto, 0);
  assert.equal(czek!.hoursDeclared, 0);
  assert.equal(zwykly!.konto, null, "звичайний нерозписаний — лишається порожнім (блок заповнить бухгалтерія)");
  // правило 3: години з oświadczenia (powiadomienie) → на карту, решта готівкою
  const rows3 = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["OSWIADCZENIE JAN", 100, 150, 31.4, 25.35, 3802.5, "Zgłoszony, Powiadomienie, Wyżej 26"],
    ["MENSZE PIOTR", 100, 80, 31.4, 25.35, 2028, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ];
  const p3 = parseLublinTab("TESTOWA", rows3)!;
  for (const r of p3.rows) applyLegalDefaults(r);
  const [oswiad, mensze] = p3.rows;
  assert.equal(oswiad!.hoursDeclared, 100, "офіційно — години oświadczenia");
  assert.equal(oswiad!.ksiegNetto, 2535, "конто = 100 × 25.35");
  assert.equal(oswiad!.ksiegBrutto, 3140);
  assert.equal(oswiad!.gotowka, 1267.5, "решта готівкою: 3802.5 − 2535");
  assert.equal(mensze!.hoursDeclared, 80, "відпрацював менше oświadczenia → реальні години");
  assert.equal(mensze!.ksiegNetto, 2028);
  assert.equal(mensze!.gotowka, 0);
  // force-перерахунок (правка на сайті) переписує наявний розклад студента
  stud!.hours = 120; stud!.doWyplaty = 3768;
  applyLegalDefaults(stud!, true);
  assert.equal(stud!.konto, 3768);
});

test("Godzin Faktycznie: Eurocash = виплата/30,5; Sushi = (виплата+zaliczka)/24,6 і brutto", () => {
  assert.deepEqual(computeKsiegHours("EUROCASH LUBLIN", { doWyplaty: 6100, zaliczka: null }), { ksiegHours: 200 });
  const sushi = computeKsiegHours("Sushi&Food Factory", { doWyplaty: 4000, zaliczka: 920 })!;
  assert.equal(sushi.ksiegHours, 200);
  assert.equal(sushi.brutto, 6100);
  assert.equal(computeKsiegHours("AGRAM", { doWyplaty: 1000, zaliczka: 0 }), null);
});

test("Офіс: людина без сум, але з умовою/ставкою — лишається в списку", () => {
  const rows = [
    [46174],
    ["LUBLIN OFFICE ES", "", "GODZINY", "STAWKA", "BRUTTO", "UMOWA OD", "UMOWA DO"],
    ["OUADOUD BILAL", "STUD", "", 31.4, "", 46127, 46387],
    ["KOTELENETS OLENA", "ZUS", 60, 31.4, 1884, 46086, "NIEOKREŚLONY"],
    ["випадковий текст", "", "", "", "", "", ""],
  ];
  const p = parseOfficeTab("OFFICE ES", rows)!;
  assert.deepEqual(p.rows.map(r => r.rawName), ["OUADOUD BILAL", "KOTELENETS OLENA"]);
  assert.equal(p.rows[0]!.rateBrutto, 31.4);
  assert.equal(p.rows[0]!.doWyplaty, null);
  assert.ok(p.rows[0]!.hr.umowaOd);
});

test("Лодзь: WYPŁATA GOTÓWKĄ накладається на фабричні рядки без Ew.-даних", () => {
  const tab = parseLodzFullTab("PAK-SERWIS", [
    ["Imie/Nazwisko", "Status", "Godziny", "Stawka/brutto", "Stawka/netto", "Zaliczki", "RAZEM"],
    ["SOWA PIOTR", "Nie Stud.", 160, 31.4, 25.35, 0, 4056],
  ])!;
  const got = parseGotowkaTab([
    ["Wypłata wynagrodzenia 05.2026"],
    ["Imie/Nazwisko", "Fabryka", "Razem", "Na konto", "Na renke"],
    ["SOWA PIOTR", "PAK-SERWIS", 4056, 2500, 1556],
  ]);
  assert.equal(got.length, 1);
  overlayGotowka(tab, got);
  const w = tab.rows[0]!;
  near(w.konto, 2500);
  near(w.gotowka, 1556);
});
