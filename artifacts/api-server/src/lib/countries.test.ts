import { test } from "node:test";
import assert from "node:assert/strict";
import { countryNamePl, countryToCatalog, normalizeMrzCountry, canonicalCountry, COUNTRY_NAMES, COUNTRY_NAMES_TOP } from "./countries.ts";

test("countryNamePl: код MRZ → польська назва; OCR-плутанина; назва — як є; невідоме — як ввели", () => {
  assert.equal(countryNamePl("UKR"), "Ukraina");
  assert.equal(countryNamePl("ukr"), "Ukraina", "регістр");
  assert.equal(countryNamePl("P0L"), "Polska", "нуль замість O");
  assert.equal(countryNamePl("D<<"), "Niemcy", "німецький MRZ-код D<<");
  assert.equal(countryNamePl("KAZ"), "Kazachstan");
  assert.equal(countryNamePl("Ukraina"), "Ukraina", "вже назва");
  assert.equal(countryNamePl(" Gruzja "), "Gruzja");
  assert.equal(countryNamePl("CHU"), "CHU", "невідомий код — не вигадуємо");
  assert.equal(countryNamePl(null), "");
});

test("countryToCatalog: код або польська назва → каталог NATIONALITIES", () => {
  assert.equal(countryToCatalog("UKR"), "ukraine");
  assert.equal(countryToCatalog("Ukraina"), "ukraine", "назва зі збереженої анкети");
  assert.equal(countryToCatalog("ukraina"), "ukraine");
  assert.equal(countryToCatalog("ROM"), "romania");
  assert.equal(countryToCatalog("KAZ"), "central_asia");
  assert.equal(countryToCatalog("IND"), "south_asia");
  assert.equal(countryToCatalog("LTU"), "eu_other");
  assert.equal(countryToCatalog("Niemcy"), "eu_other");
  assert.equal(countryToCatalog("NGA"), "africa");
  assert.equal(countryToCatalog("COL"), "latin_america");
  assert.equal(countryToCatalog("USA"), "other");
  assert.equal(countryToCatalog("XXX"), null);
  assert.equal(countryToCatalog(""), null);
  assert.equal(normalizeMrzCountry("5RB"), "SRB");
});

test("canonicalCountry: код/назва/регістр → точна назва option-а; невідоме → порожньо", () => {
  assert.equal(canonicalCountry("UKR"), "Ukraina");
  assert.equal(canonicalCountry(" ukraina "), "Ukraina");
  assert.equal(canonicalCountry("P0L"), "Polska");
  assert.equal(canonicalCountry("CHU"), "");
  assert.equal(canonicalCountry(null), "");
  for (const n of COUNTRY_NAMES_TOP) assert.ok(COUNTRY_NAMES.includes(n), `${n} є в списку`);
});
