// Резолвер виплат (06.09.2026): golden-таблиця «кеш легальності × ручне поле → ефективний статус».
// Зміна будь-якого рядка = зміна того, ЩО йде у listy płac — потрібне окреме рішення власника.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveLegal, effectiveStudent, effectiveView } from "./effectiveStatus.ts";

const cache = (overall: string, derived: string | null, kind = "none") => ({ overall, derivedLegalStatus: derived, legacyMismatchKind: kind });

test("повністю оформлений за документами → статус із документів, інакше ручне поле, порожнє → none", () => {
  const cases: [Parameters<typeof resolveEffectiveLegal>[1], string | null, { status: string | null; source: string }][] = [
    [cache("legal", "polak"), "zus", { status: "polak", source: "documents" }],
    [cache("expiring", "karta_pobytu"), null, { status: "karta_pobytu", source: "documents" }],
    [cache("legal", "student"), "zus", { status: "student", source: "documents" }],
    [cache("legal", null), "zus", { status: "zus", source: "manual" }],            // нема пропозиції → ручне
    [cache("legal", "zus", "no_proposal"), "zus", { status: "zus", source: "manual" }],
    [cache("illegal", "polak"), "zus", { status: "zus", source: "manual" }],       // не оформлений повністю → ручне
    [cache("unknown", "polak"), "zus", { status: "zus", source: "manual" }],
    [cache("pending", "polak"), null, { status: null, source: "none" }],
    [null, "oswiadczenie", { status: "powiadomienie", source: "manual" }],         // легасі-ключ нормалізується
    [null, "student_do26", { status: "student", source: "manual" }],
    [null, null, { status: null, source: "none" }],
    [undefined, "oczekuje", { status: "oczekuje", source: "manual" }],
  ];
  for (const [c, manual, expected] of cases) {
    assert.deepEqual(resolveEffectiveLegal({ legalStatus: manual }, c), expected, `cache=${JSON.stringify(c)} manual=${manual}`);
  }
});

test("студент: за документами — лише статус student із документів; вручну — чекбокс або legal_status", () => {
  assert.equal(effectiveStudent({ isStudent: true, legalStatus: "zus" }, { status: "polak", source: "documents" }), false, "чекбокс не рятує, коли документи кажуть «оформлений»");
  assert.equal(effectiveStudent({ isStudent: false, legalStatus: null }, { status: "student", source: "documents" }), true);
  assert.equal(effectiveStudent({ isStudent: true, legalStatus: null }, { status: null, source: "none" }), true);
  assert.equal(effectiveStudent({ isStudent: false, legalStatus: "student" }, { status: "student", source: "manual" }), true);
  assert.equal(effectiveStudent({ isStudent: false, legalStatus: "zus" }, { status: "zus", source: "manual" }), false);
});

test("effectiveView підміняє legalStatus/isStudent і зберігає ручне значення в manualLegalStatus", () => {
  const w = { id: 1, legalStatus: "oczekuje", isStudent: false, hourlyRate: 30 };
  const v = effectiveView(w, cache("legal", "polak"));
  assert.equal(v.legalStatus, "polak"); assert.equal(v.legalSource, "documents"); assert.equal(v.manualLegalStatus, "oczekuje"); assert.equal(v.hourlyRate, 30);
  const m = effectiveView(w, cache("illegal", "polak"));
  assert.equal(m.legalStatus, "oczekuje"); assert.equal(m.legalSource, "manual");
});
