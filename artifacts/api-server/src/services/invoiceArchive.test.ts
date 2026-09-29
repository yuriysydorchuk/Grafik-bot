// Чисті хелпери архіву фактур: розкладка по папках офісу і порівняння назв папок
import { test } from "node:test";
import assert from "node:assert/strict";
import { archivePath, folderKey, firmFolderName, archiveFileName, driveMonthFolder } from "./invoiceArchive";

test("firm folder: ES → ESG, решта як у довіднику, без фірми — Inne", () => {
  assert.equal(firmFolderName("ES"), "ESG");
  assert.equal(firmFolderName("ESO"), "ESO");
  assert.equal(firmFolderName("Klinex"), "KLINEX");
  assert.equal(firmFolderName(null), "Inne");
});

test("folderKey: без регістру, пробілів і з кириличною М", () => {
  assert.equal(folderKey("KLINEX"), folderKey("Klinex"));
  assert.equal(folderKey("М3.26"), folderKey("M3.26")); // кирилична М в офісі
  assert.equal(folderKey("PROFORMA "), "proforma");
  assert.notEqual(folderKey("ESG"), folderKey("ESO"));
});

test("archivePath: закупівлі з роком і підпапками, продажі без року", () => {
  assert.deepEqual(archivePath("Faktury kosztowe", "2026-09-03", "ES"), ["2026", "M9.26", "ESG"]);
  assert.deepEqual(archivePath("Faktury kosztowe", "2026-09-03", "ES", "scan"), ["2026", "M9.26", "ESG", "Skany"]);
  assert.deepEqual(archivePath("Faktury kosztowe", "2026-09-03", "ESO", "proforma"), ["2026", "M9.26", "ESO", "Proformy"]);
  assert.deepEqual(archivePath("Faktury sprzedażowe", "2026-07-31", "Klinex"), ["M7.26", "KLINEX"]);
});

test("driveMonthFolder / archiveFileName", () => {
  assert.deepEqual(driveMonthFolder("2026-01-15"), { year: "2026", month: "M1.26" });
  assert.equal(archiveFileName("FV/12/2026", "ACME  Sp. z o.o."), "FV_12_2026 ACME Sp. z o.o.");
});
