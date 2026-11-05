import { test } from "node:test";
import assert from "node:assert/strict";
import { workerFileDownloadName, contentDisposition } from "./downloadName.ts";

test("імʼя скачаного файлу: тип_NAZWISKO_IMIE_дата.розширення", () => {
  assert.equal(workerFileDownloadName({ label: "Paszport", fullName: "Sydorchuk Yuriy", date: "2026-10-14", fileName: "IMG_20261014.JPG", fallback: "document-1" }), "Paszport_SYDORCHUK_YURIY_2026-10-14.jpg");
  assert.equal(workerFileDownloadName({ label: "ZUS ZUA (zgłoszenie do ubezpieczeń)", fullName: "Żółć Łukasz", date: null, fileName: null, mime: "application/pdf", fallback: "document-2" }), "ZUS_ZUA_(zgłoszenie_do_ubezpieczeń)_ŻÓŁĆ_ŁUKASZ.pdf");
  assert.equal(workerFileDownloadName({ label: "Umowa: a/b?", fullName: "Jan  Kowalski", date: "2026-01-02T10:00:00", fileName: "x.pdf", suffix: "v2", fallback: "f" }), "Umowa_a_b_JAN_KOWALSKI_2026-01-02_v2.pdf");
  assert.equal(workerFileDownloadName({ label: null, fullName: null, fileName: "skan", fallback: "document-7" }), "document-7");
});

test("Content-Disposition: UTF-8 імʼя + ASCII-фолбек без лапок і діакритики", () => {
  assert.equal(contentDisposition("attachment", 'Zaświadczenie_ŻÓŁĆ_"A".pdf'),
    `attachment; filename="Zaswiadczenie_ZOLC__A_.pdf"; filename*=UTF-8''${encodeURIComponent('Zaświadczenie_ŻÓŁĆ_"A".pdf')}`);
});
