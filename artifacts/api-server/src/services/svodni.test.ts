import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLublinTab, parseWorkList, parseLodzFullTab, parseGotowkaTab, overlayGotowka, computeMismatch, parseOfficeTab,
  legalStatusOf, applyLegalDefaults, computePayout, agramBonusPerHour, monthsBetween, monthEndStr,
  segmentsBase, splitTotalByWindows, computeSegmented,
  eurocashRatesFromBlock, eurocashBracketIndex,
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

// ── Eurocash: ставки від порогів продуктивності ──────────────────────────────
// Реальний блок EUROCASH LUBLIN 06.2026 (скорочений до перших 7 порогів).
const EC_BLOCK: (string | number)[][] = [
  ["STAWKA EUROCASH", 41.2, 42.43, 43.88, 45.33, 46.95, 48.83, 50.83],
  [5.55, "1 - 114.99", "115-124.99", "125 - 132.99", "133 - 140.99", "141-148.99", "149-156.99", "157 +"],
  [3.5, 24.6, 25.03, 25.89, 26.74, 27.7, 28.805441904312982, 29.83],
  [4.5, 30.5, 31, 32.06, 33.12, 34.3, 35.675936837143524, 37.14],
  ["", 1, 2, 3, 4, 5, 6, 7],
];

test("eurocash: розбір блоку порогів + індекс за ставкою агенції і продуктивністю", () => {
  const rates = eurocashRatesFromBlock(EC_BLOCK)!;
  assert.equal(rates.agency.length, 7);
  near(rates.nightNetto, 3.5);
  near(rates.nightBrutto, 4.5);
  assert.deepEqual(rates.ranges[6], { from: 157, to: null }); // «157 +»
  // матч по ставці агенції (файл — повна точність, дзеркало може бути округлене)
  assert.equal(eurocashBracketIndex(rates, 48.83097882465875, null), 5);
  assert.equal(eurocashBracketIndex(rates, 48.83, null), 5);
  // фолбек — продуктивність у діапазони жовтого рядка
  assert.equal(eurocashBracketIndex(rates, null, 162.55), 6);   // «157 +»
  assert.equal(eurocashBracketIndex(rates, null, 118.67), 1);   // «115-124.99»
  assert.equal(eurocashBracketIndex(rates, null, 108.79), 0);   // «1 - 114.99»
  // невідома ставка агенції → фолбек по продуктивності; без обох — null
  assert.equal(eurocashBracketIndex(rates, 99.99, 141), 4);
  assert.equal(eurocashBracketIndex(rates, 99.99, null), null);
  // зіпсутий блок → null
  assert.equal(eurocashRatesFromBlock([["STAWKA EUROCASH", 41.2]]), null);
  assert.equal(eurocashRatesFromBlock(null), null);
});

test("eurocash: студент до 26 — брутто-ставка і нічна 4,50; формула = таблиця 06.2026", () => {
  // NKOMO THABO 06.2026: 158 год × 35.675936837… + 65.5 нічних × 4.5 − 190 кари
  const rates = eurocashRatesFromBlock(EC_BLOCK)!;
  const i = eurocashBracketIndex(rates, 48.83, null)!;
  const rate = rates.brutto[i]!; // студент: нетто = брутто
  const row = {
    hours: 158, rateNetto: rate, premia: null, zaliczka: null, zaliczkaBd: null,
    hostel: null, odziez: null, dojazd: null, kara: 190, komornik: null, kaucja: null,
    potracenia: null, extras: { nocneH: 65.5, doplataNocna: rates.nightBrutto },
  };
  near(computePayout(row, "Люблін")!, 5741.55); // клітинка таблиці: 5741.548…
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

test("Люблін: Premia ES — бонус/год до базової ставки; вшитий у ставку бонус дає ⚠", () => {
  const rows = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Premia Agram", "Premia ES", "Stawka brutto", "Stawka netto", "Zaliczka", "Do wypłaty Netto", "Brutto"],
    // базова ставка 25,35 + бонус 1,5/год: формула = C×(G + бонус) + Premia Agram
    ["WISNIEWSKA EWA", 40, 170, 100, 1.5, 31.4, 25.35, 0, 170 * 26.85 + 100, ""],
    // ставка з ВШИТИМ бонусом + заповнена колонка = подвійний запис → ⚠
    ["WSZYTA HALINA", 40, 170, 100, 1.5, 31.4, 27.85, 0, 170 * 27.85 + 100, ""],
  ];
  const p = parseLublinTab("AGRAM MOTYCZ", rows)!;
  near(p.rows[0]!.premia, 100); // лише Premia Agram
  assert.equal(p.rows[0]!.extras.premiaEs, 1.5);
  for (const r of p.rows) computeMismatch(r, "Люблін");
  assert.equal(p.rows[0]!.mismatch, null, "базова + бонус = формула таблиці");
  assert.ok(p.rows[1]!.mismatch?.doWyplaty, "вшитий бонус + колонка — подвійний запис, має світити ⚠");
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
  assert.equal(zwykly!.konto, 2535, "легально оформлений (powiadomienie) без год. oświadczenia — все на карту");
  assert.equal(zwykly!.gotowka, 0);
  assert.equal(zwykly!.ksiegBrutto, 3140, "оподатковувана база = години × ставка брутто");
  // не оформлений (без статусу) при force (сайтовий флоу) — все готівкою;
  // без force (google-імпорт без тексту статусу) — лишається нерозписаним
  const rowsF = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto"],
    ["BEZ STATUSU JAN", "", 100, 31.4, 25.35, 2535],
  ];
  const pf = parseLublinTab("TESTOWA", rowsF)!;
  applyLegalDefaults(pf.rows[0]!);
  assert.equal(pf.rows[0]!.konto, null, "google-імпорт без статусу — нерозписаний");
  applyLegalDefaults(pf.rows[0]!, true);
  assert.equal(pf.rows[0]!.gotowka, 2535, "сайтовий флоу без форми легалізації — все готівкою");
  assert.equal(pf.rows[0]!.konto, 0);
  // профільний статус (сайтові рядки без zusStatus): оформлений → все на карту
  const pf2 = parseLublinTab("TESTOWA", rowsF)!;
  applyLegalDefaults(pf2.rows[0]!, true, { profileLegal: "zus" });
  assert.equal(pf2.rows[0]!.konto, 2535, "оформлений за профілем — все на карту");
  assert.equal(pf2.rows[0]!.gotowka, 0);
  // кеп: на карту не більше, ніж належить (відрахування зʼїли виплату) —
  // Романов: 64 год, oświadczenie 40, але доВиплати −0.40 → конто 0, не 1014
  const rowsCap = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Hostel", "Do wypłaty Netto", "Księgowość"],
    ["ROMANOV TEST", 40, 64, 31.4, 25.35, 1622.8, -0.4, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ];
  const pc = parseLublinTab("TESTOWA", rowsCap)!;
  applyLegalDefaults(pc.rows[0]!, true);
  assert.equal(pc.rows[0]!.konto, 0, "виплата ≤ 0 → на конто нічого");
  assert.equal(pc.rows[0]!.hoursDeclared, 0);
  assert.equal(pc.rows[0]!.ksiegBrutto, 0);
  near(pc.rows[0]!.gotowka, -0.4, "залишок (борг) видно в готівці");
  // частковий кеп: належить менше, ніж oświadczenie×ставка → конто = виплата
  const rowsCap2 = [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Hostel", "Do wypłaty Netto", "Księgowość"],
    ["CZESC KONTO", 40, 64, 31.4, 25.35, 1122.4, 500, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ];
  const pc2 = parseLublinTab("TESTOWA", rowsCap2)!;
  applyLegalDefaults(pc2.rows[0]!, true);
  assert.equal(pc2.rows[0]!.konto, 500, "конто обрізане до належної виплати");
  near(pc2.rows[0]!.hoursDeclared, 19.72, "księgowe години — від фактичного конто");
  assert.equal(pc2.rows[0]!.gotowka, 0);
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

test("фабрична стеля księgowych годин: DEZYNFEKCJA/LST — 70 при 200+, інакше 60", () => {
  const mk = (hours, doWyplaty) => {
    const p = parseLublinTab("LST", [
      [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
      ["TEST OSOBA", "", hours, 31.4, 25.35, doWyplaty, "Zgłoszony, Powiadomienie, Wyżej 26"],
    ])!;
    return p.rows[0]!;
  };
  // 202 год ≥ 200 → стеля 70: konto = 70 × 25.35
  const a = mk(202, 202 * 25.35);
  applyLegalDefaults(a, true, { factoryLabel: "LST" });
  assert.equal(a.hoursDeclared, 70);
  assert.equal(a.ksiegNetto, 1774.5);
  // 161 год < 200 → стеля 60
  const b = mk(161, 161 * 25.35);
  applyLegalDefaults(b, true, { factoryLabel: "DEZYNFEKCJA" });
  assert.equal(b.hoursDeclared, 60);
  assert.equal(b.ksiegNetto, 1521);
  // відпрацював менше стелі → реальні години
  const c = mk(26, 26 * 25.35);
  applyLegalDefaults(c, true, { factoryLabel: "SERWIS PLUS" });
  assert.equal(c.hoursDeclared, 26);
  // студента до 26 стеля не стосується — все на конто
  const st = parseLublinTab("LST", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["STUDENTKA LST", "STUD", 220, 31.4, 31.4, 6908, "Zgłoszony, do 26, student"],
  ])!.rows[0]!;
  applyLegalDefaults(st, true, { factoryLabel: "LST" });
  assert.equal(st.konto, 6908);
  // інші фабрики — без стелі
  const d = mk(202, 202 * 25.35);
  applyLegalDefaults(d, true, { factoryLabel: "AGRAM" });
  assert.equal(d.hoursDeclared, 202);
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

test("księgowa ставка — нижча зі ставок (LST 26.35 → декларуємо по 25.35); побажання понад усе", () => {
  const mk = () => parseLublinTab("LST", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["LST OSOBA", "", 144, 32.4, 26.35, 144 * 26.35, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ])!.rows[0]!;
  // стеля 60 (144 < 200) × 25.35 (стандартна, бо фабрична 26.35 вища)
  const a = mk();
  applyLegalDefaults(a, true, { factoryLabel: "LST" });
  assert.equal(a.hoursDeclared, 60);
  assert.equal(a.ksiegNetto, 1521, "60 × 25.35, не 26.35");
  assert.equal(a.gotowka, 2273.4, "решта готівкою до повного нетто");
  // побажання «сума на конто» — понад статус і стелю
  const b = mk();
  applyLegalDefaults(b, true, { factoryLabel: "LST", payoutPref: { kind: "amount", value: 3000 } });
  assert.equal(b.konto, 3000);
  near(b.hoursDeclared, 118.34, "години від суми по księgowej ставці");
  // побажання «все на конто»
  const c = mk();
  applyLegalDefaults(c, true, { factoryLabel: "LST", payoutPref: { kind: "all_konto", value: null } });
  assert.equal(c.konto, 3794.4);
  assert.equal(c.gotowka, 0);
  // побажання «N годин на конто»
  const d = mk();
  applyLegalDefaults(d, true, { factoryLabel: "LST", payoutPref: { kind: "hours", value: 100 } });
  assert.equal(d.konto, 2535, "100 × 25.35");
  // заробив менше, ніж просить — менша сума (кеп)
  const e = mk();
  e.doWyplaty = 1000;
  applyLegalDefaults(e, true, { payoutPref: { kind: "amount", value: 3000 } });
  assert.equal(e.konto, 1000);
});

test("бонусна ставка AGRAM (26,85 = 25,35 + 1,5): конто по księgowій, бонус готівкою", () => {
  // оформлений без oświadczenia: загальна зп по 26,85; конто = год × 25,35; решта готівкою
  const p = parseLublinTab("AGRAM", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["BONUSOWY ADAM", "", 136, 32.9, 26.85, 136 * 26.85, "Zgłoszony, Decyzja Karty Pobytu"],
  ])!.rows[0]!;
  applyLegalDefaults(p, true, { factoryLabel: "AGRAM" });
  near(p.doWyplaty, 3651.6, "разом = 136 × 26,85");
  assert.equal(p.hoursDeclared, 136);
  assert.equal(p.ksiegNetto, 3447.6, "конто = 136 × 25,35");
  assert.equal(p.gotowka, 204, "бонус 136 × 1,5 — готівкою");
  // з oświadczeniem: конто по 25,35 за години повідомлення, решта (вкл. бонус) готівкою
  const o = parseLublinTab("AGRAM", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["BONUSOWY PIOTR", 40, 136, 32.9, 26.85, 136 * 26.85, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ])!.rows[0]!;
  applyLegalDefaults(o, true, { factoryLabel: "AGRAM" });
  assert.equal(o.ksiegNetto, 1014, "конто = 40 × 25,35");
  assert.equal(o.gotowka, 2637.6);
});

test("Premia ES (бонус/год): входить у виплату, конто по базовій, księg. brutto від конто", () => {
  // базова 25,35 + бонус 1,5/год: разом = год × (25,35 + 1,5) − відрахування
  const p = parseLublinTab("AGRAM", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["BONUS GODZINOWY", "", 136, 31.4, 25.35, null, "Zgłoszony, Decyzja Karty Pobytu"],
  ])!.rows[0]!;
  p.extras.premiaEs = 1.5;
  p.doWyplaty = computePayout(p, "Люблін");
  near(p.doWyplaty, 136 * 26.85, "виплата = год × (базова + бонус)");
  applyLegalDefaults(p, true, { factoryLabel: "AGRAM" });
  assert.equal(p.ksiegNetto, 3447.6, "конто = 136 × 25,35 (без бонусу)");
  near(p.gotowka, 204, "бонус 136 × 1,5 — готівкою");
  near(p.ksiegBrutto, 3447.6 / 25.35 * 31.4, "księg. brutto = konto ÷ нетто × брутто");
  // «все на конто» з премією: brutto теж від конто, не від фактичних годин
  const k = parseLublinTab("AGRAM", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Premia Agram", "Do wypłaty Netto", "Księgowość"],
    ["Z PREMIA ADAM", "", 80, 31.4, 25.35, 100, 80 * 25.35 + 100, "Zgłoszony, Decyzja Karty Pobytu"],
  ])!.rows[0]!;
  applyLegalDefaults(k, true, { factoryLabel: "AGRAM" });
  assert.equal(k.konto, 2128, "все на конто разом із премією");
  near(k.ksiegBrutto, 2128 / 25.35 * 31.4, "brutto від конто (83,94 год × 31,4), не 80 × 31,4");
});

test("ставка «на руки» (netto=brutto) у НЕ-студента → księgowo стандартна пара", () => {
  // ANDROS wózkowy: платимо 36/год на руки, в ZUS іде oświadczenie 40 год по 31.40/25.35
  const p = parseLublinTab("ANDROS KLINEX", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["WOZKOWY ADAM", 40, 72, 36, 36, 72 * 36, "Zgłoszony, Powiadomienie, Wyżej 26"],
  ])!.rows[0]!;
  applyLegalDefaults(p, true, { factoryLabel: "ANDROS KLINEX" });
  assert.equal(p.hoursDeclared, 40);
  assert.equal(p.ksiegNetto, 1014, "40 × 25.35 — стандартна пара, не 36");
  assert.equal(p.ksiegBrutto, 1256, "40 × 31.40");
  assert.equal(p.gotowka, 1578, "2592 − 1014 — доплата готівкою до повних 36/год");
  // а студентська неоподаткована ставка (навіть wyżej 26) — далі декларується як є
  const st = parseLublinTab("PAK-SERWIS", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["STUDENT STARSZY", 100, 150, 31.4, 31.4, 150 * 31.4, "Zgłoszony, Powiadomienie, student"],
  ])!.rows[0]!;
  applyLegalDefaults(st, true, { factoryLabel: "PAK-SERWIS" });
  assert.equal(st.hoursDeclared, 100);
  assert.equal(st.ksiegNetto, 3140, "100 × 31.40 — студентська ставка як є");
});

// ── Інваріанти розкладу: цифри мають сходитись у КОЖНІЙ гілці правил ─────────
// До виплати = конто + готівка (− Dopłata ES); конто в межах [0, до виплати];
// księg. brutto = konto ÷ księgowa нетто × księgowa брутто (не-студенти).
test("інваріанти: до виплати = конто + готівка у всіх сценаріях розкладу", () => {
  const r2i = (n: number) => Math.round(n * 100) / 100;
  const mk = (over: Record<string, unknown> = {}) => {
    const p = parseLublinTab("INWARIANT", [
      [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
      ["OSOBA TESTOWA", "", 160, 31.4, 25.35, null, ""],
    ])!.rows[0]!;
    Object.assign(p, over);
    p.doWyplaty = computePayout(p, "Люблін");
    return p;
  };
  const scenarios: { name: string; row: ReturnType<typeof mk>; ctx: Parameters<typeof applyLegalDefaults>[2] }[] = [
    { name: "студент до 26", row: mk({ isStudent: true, under26: true, rateBrutto: 31.4, rateNetto: 31.4 }), ctx: {} },
    { name: "oświadczenie 100 год", row: mk({ hoursNotified: 100, extras: { zusStatus: "Zgłoszony, Powiadomienie, Wyżej 26" } }), ctx: {} },
    { name: "oświadczenie більше факту", row: mk({ hoursNotified: 200, extras: { zusStatus: "Zgłoszony, Powiadomienie" } }), ctx: {} },
    { name: "оформлений без oświadczenia", row: mk({ extras: { zusStatus: "Zgłoszony, Decyzja Karty Pobytu" } }), ctx: {} },
    { name: "не оформлений", row: mk({ extras: { zusStatus: "Nie zgłoszony" } }), ctx: {} },
    { name: "без статусу (force)", row: mk(), ctx: {} },
    { name: "бонусна ставка без oświadczenia", row: mk({ rateNetto: 26.85, rateBrutto: 32.9, extras: { zusStatus: "Zgłoszony, Decyzja" } }), ctx: { factoryLabel: "AGRAM" } },
    { name: "бонус-колонка + oświadczenie", row: mk({ hoursNotified: 40, extras: { premiaEs: 1.5, zusStatus: "Zgłoszony, Powiadomienie" } }), ctx: { factoryLabel: "AGRAM" } },
    { name: "ставка на руки 36/36", row: mk({ rateNetto: 36, rateBrutto: 36, hoursNotified: 40, extras: { zusStatus: "Zgłoszony, Powiadomienie" } }), ctx: {} },
    { name: "фабрична стеля LST", row: mk({ hours: 220, extras: { zusStatus: "Zgłoszony, Powiadomienie" }, hoursNotified: 100 }), ctx: { factoryLabel: "LST" } },
    { name: "відрахування з'їли зп (кеп)", row: mk({ kara: 4000, hostel: 1000, extras: { zusStatus: "Zgłoszony, Powiadomienie" }, hoursNotified: 100 }), ctx: {} },
    { name: "побажання: все на конто", row: mk({ extras: { zusStatus: "Nie zgłoszony" } }), ctx: { payoutPref: { kind: "all_konto", value: null } } },
    { name: "побажання: 50 год на конто", row: mk({ extras: {} }), ctx: { payoutPref: { kind: "hours", value: 50 } } },
    { name: "побажання: 3000 zł на конто", row: mk({ extras: {} }), ctx: { payoutPref: { kind: "amount", value: 3000 } } },
    { name: "побажання більше заробленого", row: mk({ hours: 20, extras: {} }), ctx: { payoutPref: { kind: "amount", value: 3000 } } },
    { name: "Люблін з Dopłata ES (всередині до виплати)", row: (() => { const p = mk({ hoursNotified: 60, extras: { doplataEs: 90, zusStatus: "Zgłoszony, Powiadomienie" } }); return p; })(), ctx: {} },
    { name: "Лодзь з Dopłata ES (поверх RAZEM)", row: (() => { const p = mk({ hoursNotified: 60, extras: { doplataEs: 90, zusStatus: "Zgłoszony, Powiadomienie" } }); p.doWyplaty = computePayout(p, "Лодзь"); return p; })(), ctx: { city: "Лодзь" } },
  ];
  for (const s of scenarios) {
    applyLegalDefaults(s.row, true, s.ctx);
    const { doWyplaty, konto, gotowka, ksiegNetto, ksiegBrutto, hoursDeclared } = s.row;
    const doplata = typeof s.row.extras.doplataEs === "number" ? (s.row.extras.doplataEs as number) : 0;
    // у Лодзі доплата йде ПОВЕРХ doWyplaty (готівкою), в інших містах — уже всередині
    const extraCash = (s.ctx as { city?: string } | undefined)?.city === "Лодзь" ? doplata : 0;
    assert.ok(doWyplaty != null && konto != null && gotowka != null, `${s.name}: розклад має бути зроблений`);
    // 1) конто + готівка = все, що людина отримує
    near(r2i(konto! + gotowka!), r2i(doWyplaty! + extraCash), `${s.name}: konto ${konto} + gotówka ${gotowka} ≠ до отримання ${doWyplaty}+${extraCash}`);
    // 2) конто в межах [0, max(до виплати, 0)]
    assert.ok(konto! >= 0, `${s.name}: конто від'ємне`);
    assert.ok(konto! <= Math.max(doWyplaty!, 0) + 0.01, `${s.name}: конто ${konto} більше за належне ${doWyplaty}`);
    // 3) konto = ksiegNetto
    assert.equal(konto, ksiegNetto, `${s.name}: konto ≠ księg. netto`);
    // 4) księg. brutto від конто по księgowій парі (не студентська гілка)
    if (!(s.row.isStudent && s.row.under26) && konto! > 0 && ksiegBrutto != null) {
      const untaxed = (s.row.isStudent === true) && s.row.rateBrutto != null && s.row.rateNetto != null && s.row.rateBrutto <= s.row.rateNetto + 0.001;
      const kn = untaxed ? s.row.rateNetto! : Math.min(s.row.rateNetto ?? 25.35, 25.35);
      const kb = untaxed ? s.row.rateBrutto! : Math.min(s.row.rateBrutto ?? 31.4, 31.4);
      near(ksiegBrutto, r2i(konto! / kn * kb), `${s.name}: księg. brutto ≠ konto ÷ netto × brutto`);
    }
    // 5) декларовані години × księgowa нетто = konto (де години відомі і кеп
    // не різав); допуск 0,2 zł — заокруглення «зворотних» годин (сума ÷ ставка)
    if (hoursDeclared != null && konto! > 0 && konto! < Math.max(doWyplaty!, 0)) {
      const kn = Math.min(s.row.rateNetto ?? 25.35, 25.35);
      if (!s.row.isStudent) assert.ok(Math.abs(r2i(hoursDeclared * kn) - konto!) <= 0.2,
        `${s.name}: години ${hoursDeclared} × ${kn} ≠ konto ${konto}`);
    }
  }
});

// ── Текстові маркери в колонці «Ilość godz w powiadomieniu» ──────────────────
test("маркери повідомлень: STUD>26 / DYPLOM / NIE ZGŁOSZONY → статус, не години", () => {
  const p = parseLublinTab("PREMIUM FRUITS", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["AHAMED MAHEEN", "STUD>26", 120, 31.4, 25.35, 120 * 25.35, ""],
    ["DYPLOMOWY JAN", "DYPLOM", 100, 31.4, 25.35, 100 * 25.35, ""],
    ["CZEKA PIOTR", "NIE ZGŁOSZONY", 80, 31.4, 25.35, 80 * 25.35, ""],
    ["ZWYKLY STUD", "STUD", 90, 31.4, 31.4, 90 * 31.4, ""],
  ])!;
  const [ahamed, dyplom, czeka, stud] = p.rows;
  // STUD>26: студент після 26 — оподатковується, але статус є (не «?»)
  assert.equal(ahamed!.isStudent, true);
  assert.equal(ahamed!.under26, false);
  assert.equal(legalStatusOf(String(ahamed!.extras.zusStatus)), "student");
  assert.equal(ahamed!.hoursNotified, null, "маркер — не години повідомлення");
  // DYPLOM у колонці повідомлень → форма легалізації «диплом»
  assert.equal(legalStatusOf(String(dyplom!.extras.zusStatus)), "dyplom");
  assert.equal(dyplom!.isStudent, false);
  // NIE ZGŁOSZONY → не оформлений
  assert.equal(legalStatusOf(String(czeka!.extras.zusStatus)), "oczekuje");
  // класичний STUD = студент до 26
  assert.equal(stud!.isStudent, true);
  assert.equal(stud!.under26, true);
  // розклад: STUD>26 без oświadczenia → оформлений, все на карту; NIE ZGŁOSZONY → готівка
  for (const r of p.rows) applyLegalDefaults(r, true, { factoryLabel: "PREMIUM FRUITS" });
  assert.equal(ahamed!.konto, 3042, "студент wyżej 26 — оформлений: усе на конто");
  assert.equal(czeka!.konto, 0, "не зголошений — все готівкою");
  assert.equal(stud!.konto, 2826, "студент до 26 — все на конто");
});

test("бонуси Agram: лише при ≥160 год; стаж +1 від 30 днів, +1.5 від 60; без дати +1", () => {
  assert.equal(monthEndStr("2026-07"), "2026-07-31");
  assert.equal(monthEndStr("2026-02"), "2026-02-28");
  const w = (staz: boolean, cash: boolean, start: string | null) =>
    ({ agramStazBonus: staz, agramCashBonus: cash, employmentStartDate: start });
  // яруси стажу за днями на кінець місяця (звірено з таблицею AGRAM 06.2026)
  assert.equal(agramBonusPerHour(w(true, false, "2026-04-16"), "2026-06", 203), 1.5, "Nabieva: 75 днів → 1.5");
  assert.equal(agramBonusPerHour(w(true, true, "2026-05-27"), "2026-06", 240), 2, "Petrenko: 34 дні → 1 + нал 1");
  assert.equal(agramBonusPerHour(w(true, false, "2026-06-10"), "2026-06", 200), 0, "20 днів → 0");
  // умова 160 годин — ЛИШЕ для стажу: Lomako 147 год → стаж-бонусу нема
  assert.equal(agramBonusPerHour(w(true, false, "2025-07-28"), "2026-06", 147), 0, "менше 160 год → стаж 0");
  assert.equal(agramBonusPerHour(w(true, true, "2025-07-28"), "2026-06", 159.9), 1, "нал НЕ залежить від годин; стаж відпав");
  assert.equal(agramBonusPerHour(w(false, true, "2025-07-28"), "2026-06", 100), 1, "нал сам по собі при малих годинах");
  assert.equal(agramBonusPerHour(w(true, false, "2025-07-28"), "2026-06", 160), 1.5, "рівно 160 — стаж є");
  // без годин (превʼю/ручний рядок) — не блокуємо
  assert.equal(agramBonusPerHour(w(true, false, null), "2026-07", null), 1, "галочка без дати → 1");
  assert.equal(agramBonusPerHour(w(false, true, null), "2026-07", 200), 1, "нал окремо");
  assert.equal(agramBonusPerHour(w(false, false, "2025-01-01"), "2026-07", 200), 0, "без галочок — нічого");
});

test("сегменти: база = Σ(год × ставка), księgowa пара по нижчій ставці, розбивка рапорту", () => {
  // 96 год працівником по 25.35 + 60 год лідером по 30 → база і min-ставки
  const s = segmentsBase([
    { hours: 96, rateNetto: 25.35, rateBrutto: 31.4 },
    { hours: 60, rateNetto: 30, rateBrutto: 36 },
  ]);
  near(s.base, 96 * 25.35 + 60 * 30);
  near(s.hours, 156);
  near(s.minNetto, 25.35, "деклароване — по нижчій зі ставок сегментів");
  near(s.minBrutto, 31.4);
  near(s.bruttoSum, 96 * 31.4 + 60 * 36);
  // computePayout з baseOverride: премія/відрахування з батьківського рядка
  const payout = computePayout(
    { hours: 156, rateNetto: 25.35, premia: 100, zaliczka: 500, extras: {} },
    "Люблін", s.base!,
  );
  near(payout, s.base! + 100 - 500);
  // рапортні місяці: пропорційно явкам у вікнах…
  assert.deepEqual(splitTotalByWindows(160, [
    { from: "2026-07-01", to: "2026-07-13", attHours: 60 },
    { from: "2026-07-14", to: "2026-07-31", attHours: 20 },
  ]), [120, 40]);
  // …а без явок — порівну по календарних днях (13 і 18 днів)
  const byDays = splitTotalByWindows(155, [
    { from: "2026-07-01", to: "2026-07-13", attHours: 0 },
    { from: "2026-07-14", to: "2026-07-31", attHours: 0 },
  ]);
  near(byDays[0]!, Math.round(155 * 13 / 31 * 100) / 100);
  near(byDays[0]! + byDays[1]!, 155, "корекція округлення тримає суму");
});

test("сегменти: кожен рядок рахується за правилами СВОГО статусу, батько = сума", () => {
  // до 10-го oświadczenie (80 год × 25.35, повід. 40), з 11-го студент до 26
  // (160 год × 26.35); аванс місяця 500 ділиться пропорційно базі
  const { segs, parent } = computeSegmented(
    {
      city: "Люблін", factoryLabel: "AGRAM MOTYCZ", hoursNotified: 40,
      premia: null, zaliczka: 500, zaliczkaBd: null, hostel: null, odziez: null,
      dojazd: null, kara: null, komornik: null, kaucja: null, potracenia: null, extras: {},
    },
    [
      { hours: 80, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: true, legal: "oswiadczenie" },
      { hours: 160, rateNetto: 26.35, rateBrutto: 31.4, isStudent: true, under26: true, legal: "student" },
    ],
    null,
  );
  const [a, b] = segs;
  // аванс: 500 × 2028/6244 ≈ 162.40, решта (з корекцією округлення) 337.60
  near(a!.alloc.zaliczka!, 162.4);
  near(b!.alloc.zaliczka!, 337.6);
  near(a!.doWyplaty, 80 * 25.35 - 162.4);
  near(b!.doWyplaty, 160 * 26.35 - 337.6);
  // oświadczenie: деклароване = min(80, 40 повід.) = 40 → konto 40 × 25.35
  near(a!.hoursDeclared, 40);
  near(a!.konto, 1014);
  near(a!.gotowka, a!.doWyplaty! - 1014);
  // студент до 26: все на конто, готівка 0
  near(b!.konto, b!.doWyplaty!);
  near(b!.gotowka, 0);
  // батько — сума сегментів; ставки — нижчі (декларування)
  near(parent.hours!, 240);
  near(parent.doWyplaty!, a!.doWyplaty! + b!.doWyplaty!);
  near(parent.konto!, 1014 + b!.doWyplaty!);
  near(parent.gotowka!, a!.gotowka!);
  near(parent.rateNetto!, 25.35);
  // повід. години не задвоюються: студентський сегмент їх не споживає
  assert.equal(a!.hoursNotified, 40);
  assert.equal(b!.hoursNotified, 0);
});

test("сегменти: місячний ліміт повідомлення не задвоюється і не палиться дарма", () => {
  const parent = {
    city: "Люблін", factoryLabel: "TEST", hoursNotified: 40,
    premia: null, zaliczka: null, zaliczkaBd: null, hostel: null, odziez: null,
    dojazd: null, kara: null, komornik: null, kaucja: null, potracenia: null, extras: {},
  };
  // два oświadczenie-сегменти: ліміт 40 споживає перший, другому konto = 0
  const a = computeSegmented(parent, [
    { hours: 40, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: false, legal: "powiadomienie" },
    { hours: 80, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: false, legal: "powiadomienie" },
  ], null);
  near(a.segs[0]!.konto, 1014);
  near(a.segs[1]!.konto, 0, "ліміт вичерпано — другий сегмент без конто");
  near(a.parent.konto!, 1014, "разом не більше ліміту");
  near(a.parent.hoursDeclared!, 40);
  // oczekuje не використовує konto → не палить ліміт наступному
  const b = computeSegmented(parent, [
    { hours: 60, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: false, legal: "oczekuje" },
    { hours: 80, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: false, legal: "powiadomienie" },
  ], null);
  near(b.segs[0]!.konto, 0, "не оформлений — готівкою");
  near(b.segs[1]!.konto, 1014, "ліміт дістався сегменту, що ним користується");
  // побажання по виплаті: розклад лише на батькові, сегментні konto/готівка порожні
  const c = computeSegmented(parent, [
    { hours: 40, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: false, legal: "powiadomienie" },
    { hours: 80, rateNetto: 25.35, rateBrutto: 31.4, isStudent: false, under26: false, legal: "powiadomienie" },
  ], { kind: "all_konto", value: null });
  assert.equal(c.segs[0]!.konto, null);
  assert.equal(c.segs[1]!.konto, null);
  near(c.parent.konto!, c.parent.doWyplaty!, "all_konto — усе на карту на рівні місяця");
});

test("стаж-бонус: найм 29–31-го числа «доживає» місяць в останній день коротшого місяця", () => {
  assert.equal(monthsBetween("2025-12-31", "2026-06-30"), 6, "31.12 + 6 міс = 30.06");
  assert.equal(monthsBetween("2026-01-31", "2026-02-28"), 1, "31.01 → кінець лютого = 1 місяць");
  assert.equal(monthsBetween("2026-08-01", "2026-07-31"), -1, "майбутній найм — відʼємне");
  const w = { agramStazBonus: true, agramCashBonus: false, employmentStartDate: "2026-08-15" };
  assert.equal(agramBonusPerHour(w, "2026-07", 200), 0, "найнятий у майбутньому — бонусу нема");
});

test("Dopłata ES: Люблін — всередині до виплати (готівкова частина), конто її не з'їдає", () => {
  // заробив 160×31.4 = 5024 + 500 доплати → до виплати 5524, з них 500 готівкою
  const row: any = { hours: 160, rateNetto: 31.4, rateBrutto: 31.4, isStudent: true, under26: true, extras: { doplataEs: 500 }, hr: {}, sheetValues: {} };
  row.doWyplaty = computePayout(row, "Люблін");
  near(row.doWyplaty, 5524);
  applyLegalDefaults(row, true, {});
  near(row.konto, 5024, "студент: все на конто, ОКРІМ готівкової доплати");
  near(row.gotowka, 500, "доплата один раз, готівкою");
  // Лодзь: RAZEM доплати не містить — вона йде поверх, готівкою
  const lodz: any = { hours: 100, rateNetto: 25.35, rateBrutto: 31.4, isStudent: true, under26: true, extras: { doplataEs: 90 }, hr: {}, sheetValues: {} };
  lodz.doWyplaty = computePayout(lodz, "Лодзь");
  near(lodz.doWyplaty, 2535, "RAZEM без доплати");
  applyLegalDefaults(lodz, true, { city: "Лодзь" });
  near(lodz.konto, 2535);
  near(lodz.gotowka, 90, "доплата поверх, готівкою");
});

test("Лодзь: Dojazd — доплата за доїзд (входить у RAZEM з плюсом)", () => {
  // NOWOPAK 06.2026, Burdiuh: 252.5×25.35 + 400 премії + 200 dojazd = 7000.88
  near(computePayout({ hours: 252.5, rateNetto: 25.35, premia: 400, dojazd: 200, extras: {} } as any, "Лодзь"), 7000.88);
  // а в Любліні dojazd — потрącenie (віднімається)
  near(computePayout({ hours: 100, rateNetto: 25.35, dojazd: 200, extras: {} } as any, "Люблін"), 100 * 25.35 - 200);
});

// ── Вік «до 26»: рахується на дату розрахунку/затвердження, не на кінець місяця ──
test("isUnder26: межа — день 26-річчя вже НЕ «до 26»", async () => {
  const { isUnder26 } = await import("./svodniSync.ts");
  assert.equal(isUnder26("2000-06-15", new Date("2026-06-14T12:00:00")), true, "переддень 26-річчя");
  assert.equal(isUnder26("2000-06-15", new Date("2026-06-15T00:00:00")), false, "день 26-річчя");
  assert.equal(isUnder26("2000-06-15", new Date("2026-07-03T12:00:00")), false, "після");
  // правило «вік на момент затвердження»: місяць сводної скінчився ДО дня
  // народження, а лок ставлять ПІСЛЯ — людина вже не «до 26»
  assert.equal(isUnder26("2000-07-01", new Date("2026-06-30T12:00:00")), true, "кінець місяця — ще до 26");
  assert.equal(isUnder26("2000-07-01", new Date("2026-07-02T12:00:00")), false, "затвердження після дня народження");
});

// ── Резолюція ставок: профіль → посада → найдешевша посада → база фабрики ────
test("resolveBaseRates: пріоритет профілю і фабричні fallback-и", async () => {
  const { resolveBaseRates } = await import("./svodni.ts");
  const rules = {
    position: { brutto: 32.5, netto: 26.24 },
    cheapestPosition: { brutto: 31.4, netto: 25.35 },
    factory: { brutto: 31.4, netto: 25.35 },
  };
  // профільна ставка перекриває правила
  assert.deepEqual(resolveBaseRates({ hourlyRate: 36, hourlyRateNetto: 36 }, rules, false), { brutto: 36, netto: 36 });
  // без профілю — пара посади
  assert.deepEqual(resolveBaseRates({ hourlyRate: null, hourlyRateNetto: null }, rules, false), { brutto: 32.5, netto: 26.24 });
  // посади нема — найдешевша посада («звичайний працівник»)
  assert.deepEqual(resolveBaseRates({ hourlyRate: null, hourlyRateNetto: null }, { ...rules, position: null }, false), { brutto: 31.4, netto: 25.35 });
  // фабрика без посад — базова пара
  assert.deepEqual(resolveBaseRates({ hourlyRate: null, hourlyRateNetto: null }, { factory: { brutto: 31.4, netto: 25.35 } }, false), { brutto: 31.4, netto: 25.35 });
  // профільне брутто = правилу, нетто порожня → нетто з правила
  assert.deepEqual(resolveBaseRates({ hourlyRate: 32.5, hourlyRateNetto: null }, rules, false), { brutto: 32.5, netto: 26.24 });
  // профільне брутто ІНШЕ → нетто з правила не беремо (невідома пара)
  assert.deepEqual(resolveBaseRates({ hourlyRate: 33, hourlyRateNetto: null }, rules, false), { brutto: 33, netto: null });
  // студент до 26: нетто = брутто, оподаткована профільна нетто ігнорується
  assert.deepEqual(resolveBaseRates({ hourlyRate: 31.4, hourlyRateNetto: 25.35 }, rules, true), { brutto: 31.4, netto: 31.4 });
  assert.deepEqual(resolveBaseRates({ hourlyRate: null, hourlyRateNetto: null }, rules, true), { brutto: 32.5, netto: 32.5 });
});

test("factoryBonusPerHour: LST — лише готівковий +1, Agram — нал+стаж", async () => {
  const { factoryBonusPerHour, LST_FACTORY_ID } = await import("./svodni.ts");
  const w = (p: any) => ({ agramStazBonus: false, agramCashBonus: false, employmentStartDate: null, ...p });
  assert.equal(factoryBonusPerHour(w({ agramCashBonus: true }), LST_FACTORY_ID, "2026-06", 80), 1, "LST нал не залежить від годин");
  assert.equal(factoryBonusPerHour(w({}), LST_FACTORY_ID, "2026-06", 180), 0, "LST без галочки — без бонусу");
  assert.equal(factoryBonusPerHour(w({ agramCashBonus: true, agramStazBonus: true, employmentStartDate: "2026-03-01" }), LST_FACTORY_ID, "2026-06", 180), 1, "стаж на LST не діє");
  assert.equal(factoryBonusPerHour(w({ agramCashBonus: true, agramStazBonus: true, employmentStartDate: "2026-03-01" }), 12, "2026-06", 180), 2.5, "Agram: нал 1 + стаж 1.5");
  assert.equal(factoryBonusPerHour(w({ agramCashBonus: true }), 5, "2026-06", 180), 0, "звичайна фабрика — без бонусів");
});
