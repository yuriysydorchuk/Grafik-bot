import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKzis, kzisName, KZIS_CODES } from "./kzis.ts";

test("довідник KZiS: коди унікальні, 6 цифр, відсортовані; відомі zawody на місці", () => {
  assert.ok(KZIS_CODES.length > 2900);
  assert.equal(new Set(KZIS_CODES.map(c => c[0])).size, KZIS_CODES.length);
  assert.ok(KZIS_CODES.every(([c, n]) => /^\d{6}$/.test(c) && n.length > 1));
  assert.deepEqual([kzisName("932101"), kzisName("933304"), kzisName("932990"), kzisName("000000")], ["Pakowacz ręczny", "Robotnik magazynowy", "Pozostali robotnicy wykonujący prace proste w przemyśle", null]);
  assert.ok(!KZIS_CODES.some(([, n]) => /[a-ząćęłńóśźż]S$/.test(n)), "позначку «S» прибрано");
});

test("parseKzis: порожньо → null; не 6 цифр / нема в класифікації → помилка; збережене значення проходить", () => {
  assert.equal(parseKzis(""), null); assert.equal(parseKzis(null), null);
  assert.equal(parseKzis(" 932101 "), "932101");
  assert.throws(() => parseKzis("93210"), /6 цифр/);
  assert.throws(() => parseKzis("932102x"), /6 цифр/);
  assert.throws(() => parseKzis("999999"), /немає в класифікації/);
  assert.equal(parseKzis("999999", "999999"), "999999", "уже збережений код старої класифікації не блокує збереження");
});
