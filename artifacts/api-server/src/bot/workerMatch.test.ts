import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, nameScore, matchWorker } from "./workerMatch.ts";

test("зайві токени запиту (друге ім'я з експорту фабрики) штрафуються м'яко", () => {
  const ws = [{ id: 1, fullName: "Garira Munashe", workerCode: null }, { id: 2, fullName: "Nowak Piotr", workerCode: null }];
  // «Munashe Gariva Joel»: 2 токени сідають (1.0 + 0.8), joel — зайвий → впевнений матч
  assert.equal(matchWorker("Munashe Gariva Joel", ws).confident?.id, 1);
  // коротший запит, ніж ім'я — поведінка без змін
  assert.equal(nameScore("Munashe", "Garira Munashe"), 1);
});

test("opts.minCandidate розширює список кандидатів для превʼю імпорту", () => {
  const ws = [
    { id: 1, fullName: "Khvorostenko Maksym", workerCode: null, isActive: true },
    { id: 2, fullName: "Podoba Maksym", workerCode: null, isActive: false },
  ];
  // спотворене прізвище: збігається лише ім'я (скор 0.5) — дефолтний поріг ховає всіх
  assert.equal(matchWorker("Maksym Khdvarenko", ws).candidates.length, 0);
  const m = matchWorker("Maksym Khdvarenko", ws, { minCandidate: 0.5 });
  assert.equal(m.confident, null);
  assert.equal(m.candidates.length, 2);
  assert.equal(m.candidates[0]!.id, 1); // при рівному скорі активний вище
});

const W = (id: number, fullName: string, workerCode: string | null = null) => ({ id, fullName, workerCode });

test("normalizeName folds Polish diacritics, Cyrillic and letter variants", () => {
  assert.equal(normalizeName("Łukasz Woźniak"), "lukasz vozniak");
  assert.equal(normalizeName("Гнатюк Юрій"), "hnatiuk iurii");
  assert.equal(normalizeName("Hnatiuk Yurii"), "hnatiuk iurii");
  assert.equal(normalizeName("Ковальчук Іван"), "kovalcuk ivan");
});

test("nameScore is word-order independent", () => {
  assert.equal(nameScore("Iwan Kowalczuk", "Kowalczuk Iwan"), 1);
});

test("matchWorker: exact code wins outright", () => {
  const ws = [W(1, "Kowalczuk Iwan", "105"), W(2, "Nowak Piotr", "17")];
  assert.equal(matchWorker("105", ws).confident?.id, 1);
});

test("matchWorker: Cyrillic input with typo still auto-links a unique worker", () => {
  const ws = [W(1, "Hnatiuk Yurii"), W(2, "Nowak Piotr"), W(3, "Kowalczuk Iwan")];
  assert.equal(matchWorker("Юрий Гнатюк", ws).confident?.id, 1);
  assert.equal(matchWorker("hnatuk jurii", ws).confident?.id, 1);
});

test("matchWorker: ambiguous first name gives candidates, no confident pick", () => {
  const ws = [W(1, "Kowalczuk Iwan"), W(2, "Melnyk Iwan"), W(3, "Nowak Piotr")];
  const m = matchWorker("Iwan", ws);
  assert.equal(m.confident, null);
  assert.deepEqual(m.candidates.map(w => w.id).sort(), [1, 2]);
});

test("matchWorker: unique surname alone is enough", () => {
  const ws = [W(1, "Kowalczuk Iwan"), W(2, "Melnyk Iwan")];
  assert.equal(matchWorker("Kowalczuk", ws).confident?.id, 1);
});

test("matchWorker: дубль профілю (активний + звільнений двійник) не ламає впевнений матч", () => {
  // прод-кейс: Lobas Olha двічі в базі (звільнена + активна) → раніше «не знайдено в базі»
  const ws = [
    { id: 126, fullName: "Lobas Olha", workerCode: "00126", isActive: false },
    { id: 142, fullName: "Lobas Olha", workerCode: "00142", isActive: true },
    { id: 3, fullName: "Nowak Piotr", workerCode: null, isActive: true },
  ];
  const m = matchWorker("LOBAS OLHA", ws);
  assert.equal(m.confident?.id, 142); // активний профіль, а не null
  // а СПРАВЖНЯ неоднозначність (різні люди зі схожим збігом) — як і була
  const m2 = matchWorker("Iwan", [W(1, "Kowalczuk Iwan"), W(2, "Melnyk Iwan")]);
  assert.equal(m2.confident, null);
});

test("matchWorker: opts.prefer сильніший за isActive — дубль, що ВЖЕ в обліку годин, виграє", () => {
  // місяць відпрацьований на старому (звільненому) профілі, новий активний порожній
  const ws = [
    { id: 126, fullName: "Lobas Olha", workerCode: "00126", isActive: false },
    { id: 142, fullName: "Lobas Olha", workerCode: "00142", isActive: true },
  ];
  const inHours = new Set([126]);
  const m = matchWorker("LOBAS OLHA", ws, { prefer: w => inHours.has(w.id) ? 1 : 0 });
  assert.equal(m.confident?.id, 126); // той, у кого години місяця, а не просто активний
});

test("matchWorker: unrelated text matches nothing", () => {
  const ws = [W(1, "Kowalczuk Iwan"), W(2, "Nowak Piotr")];
  const m = matchWorker("Abdurrahman Öztürk", ws);
  assert.equal(m.confident, null);
  assert.equal(m.candidates.length, 0);
});

test("matchWorker: fuzzy single-word hit is a candidate, not auto-link", () => {
  const ws = [W(1, "Kowalczuk Iwan"), W(2, "Kowalski Adam")];
  const m = matchWorker("Kowalzcuk", ws);
  assert.equal(m.confident, null);
  assert.ok(m.candidates.some(w => w.id === 1));
});
