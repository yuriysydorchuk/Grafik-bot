import { test } from "node:test";
import assert from "node:assert/strict";
import { mdSafe, mdSafeWithLinks } from "./display.ts";

test("mdSafe strips Markdown entity starters", () => {
  assert.equal(mdSafe("Jan_Kowalski *x* [y]"), "JanKowalski x y");
  assert.equal(mdSafe(null), "");
});

test("mdSafeWithLinks turns URLs into labeled links and escapes the rest", () => {
  // the real-world case that killed factory info: goo.gl link with "_" in the query
  const bimiz = "Заправка / Fuel station BP, https://maps.app.goo.gl/eErekfn4ZqUn2bjV6?g_st=ic";
  assert.equal(
    mdSafeWithLinks(bimiz, "📍 Мапа"),
    "Заправка / Fuel station BP [📍 Мапа](https://maps.app.goo.gl/eErekfn4ZqUn2bjV6?g_st=ic)",
  );
});

test("mdSafeWithLinks: no URL → plain mdSafe, several URLs → several links", () => {
  assert.equal(mdSafeWithLinks("Biedronka_центр", "Map"), "Biedronkaцентр");
  assert.equal(
    mdSafeWithLinks("A https://a.example/x_1 B https://b.example/y_2", "Map"),
    "A [Map](https://a.example/x_1) B [Map](https://b.example/y_2)",
  );
});

test("mdSafeWithLinks percent-encodes ')' inside a URL", () => {
  assert.equal(
    mdSafeWithLinks("Stop https://ex.ample/a(b)c", "Map"),
    "Stop [Map](https://ex.ample/a(b%29c)",
  );
});
