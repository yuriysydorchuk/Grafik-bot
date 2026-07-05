import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, nameScore, matchWorker } from "./workerMatch.ts";

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
