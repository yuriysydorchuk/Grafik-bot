import { test } from "node:test";
import assert from "node:assert/strict";
import { cashCategory, cashInCategory, cashCategoryOf } from "./cashCategories.ts";

const out = (description: string, extra: Partial<Parameters<typeof cashCategory>[0]> = {}) =>
  cashCategory({ kind: "out", description, transferGroup: null, manualCategory: null, ...extra });
const inc = (description: string, extra: Partial<Parameters<typeof cashInCategory>[0]> = {}) =>
  cashInCategory({ kind: "in", box: "office", description, transferGroup: null, manualCategory: null, ...extra });

test("видатки: зарплатні розбивки по містах перед загальним salary", () => {
  assert.equal(out("ЗАРПЛАТА FABRYKI LUBLIN"), "salary_fab_lublin");
  assert.equal(out("ЗАРПЛАТА FABRYKI  LUBLIN"), "salary_fab_lublin"); // подвійний пробіл з таблиці
  assert.equal(out("ЗАРПЛАТА ЛОДЗЬ"), "salary_fab_lodz");
  assert.equal(out("ЗАРПЛАТА FABRYKI POZNAN"), "salary_fab_poznan");
  assert.equal(out("ЗАРПЛАТА ПОЗНАНЬ"), "salary_fab_poznan");
  assert.equal(out("ЗАРПЛАТА ОФІСУ"), "salary_office_lublin");
  assert.equal(out("ДЛЯ ПРАЦІВНИКІВ ЮРИ( ІРЕК/АНЕТА)"), "salary"); // місто невідоме → legacy
});

test("видатки: повернення коштів, службові та фолбек", () => {
  assert.equal(out("ПОВЕРНЕННЯ КОШТІВ ПРАЦІВНИКАМ"), "worker_refund");
  assert.equal(out("ВПЛАЧЕНО НА РАХУНОК"), "deposit");
  assert.equal(out("щось нерозпізнане"), "other");
  assert.equal(out("будь-що", { transferGroup: "tr1" }), "transfer");
  assert.equal(out("ЗАРПЛАТА ОФІСУ", { manualCategory: "household" }), "household"); // ручна виграє
});

test("приходи: POBYTU раніше за card (у описі теж є «Z KARTY»)", () => {
  assert.equal(inc("DOCHOD Z KARTY POBYTU"), "karta_pobytu");
  assert.equal(inc("ЗНЯЛА З КАРТИ"), "card");
  assert.equal(inc("ЗНЯТО З КАРТИ"), "card");
  assert.equal(inc("OPLATA ZA ZEZWOLENIE"), "zezwolenie");
  assert.equal(inc("ОПЛАТА ХОСТЕЛА ГОЛЫШЕВ ИВАН"), "hostel_payment");
  assert.equal(inc("JAGIELONSKA: ПОЛУЧЕНО", { box: "hostel" }), "hostel_payment");
});

test("приходи: дефолт — card для каси офісу, other_income для інших ящиків", () => {
  assert.equal(inc("без опису взагалі"), "card");
  assert.equal(inc("без опису взагалі", { box: "hostel" }), "other_income");
  assert.equal(inc("будь-що", { transferGroup: "tr1" }), "transfer");
  assert.equal(inc("", { manualCategory: "from_owner" }), "from_owner");
});

test("cashCategoryOf: розводить за kind, opening — без категорії", () => {
  assert.equal(cashCategoryOf({ kind: "out", description: "ZAKUPY OFFICE", transferGroup: null, manualCategory: null }), "household");
  assert.equal(cashCategoryOf({ kind: "in", box: "office", description: "ЗНЯТО З КАРТИ", transferGroup: null, manualCategory: null }), "card");
  assert.equal(cashCategoryOf({ kind: "opening", description: "STAN KASY", transferGroup: null, manualCategory: null }), null);
});
