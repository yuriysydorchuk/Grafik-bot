// Смоук злиття main → feature/worker-docs-signing (06.09.2026): поведінка САМЕ в місцях
// ручного розвʼязання конфліктів — капабіліті-меню бота (main) + «🪪 Паспорт»
// (гілка), «➕ Додати працівника» = гейт капи + скан-лінк, меню працівника з обома
// новими пунктами, обʼєднані поля фабрики і каталог капабіліті.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, sendStart, sendText, resetSent, sent, sentText } from "../test/botHarness.ts";
import { app, seedAdmin, seedRole, adminsTable, workersTable, factoriesTable, companiesTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

// останній reply-keyboard, який бот надіслав, як плаский список підписів кнопок
const lastKeyboard = (): string[] => {
  const s = [...sent].reverse().find(x => x.extra?.reply_markup?.keyboard);
  return s ? (s.extra.reply_markup.keyboard as any[]).flat().map(b => typeof b === "string" ? b : b.text) : [];
};

test("меню адміна: «🪪 Паспорт» лише з workerDocs; капабіліті-фільтр main лишився", opts, async () => {
  await seedRole("kadry", ["editData", "workerDocs"], ["/workers"]);
  await seedRole("clerk", ["editData"], ["/workers"]);
  await db.insert(adminsTable).values([
    { name: "Kadry", role: "kadry", telegramId: "800100" },
    { name: "Clerk", role: "clerk", telegramId: "800200" },
    { name: "Owner", role: "owner", telegramId: "800300" },
  ]);
  await sendStart("800100");
  let kb = lastKeyboard();
  assert.ok(kb.includes("🪪 Паспорт"), `kadry має Паспорт: ${kb.join(" | ")}`);
  assert.ok(kb.includes("👥 Управління") && kb.includes("📢 Розсилки"), "editData → управління і розсилки");
  assert.ok(!kb.includes("📄 Фактура"), "без invoiceScan Фактури нема");

  resetSent(); await sendStart("800200");
  kb = lastKeyboard();
  assert.ok(!kb.includes("🪪 Паспорт"), `clerk без workerDocs не бачить Паспорт: ${kb.join(" | ")}`);
  assert.ok(kb.includes("👥 Управління"));

  resetSent(); await sendStart("800300");
  kb = lastKeyboard();
  assert.ok(kb.includes("🪪 Паспорт") && kb.includes("📄 Фактура") && kb.includes("👥 Управління"), `owner бачить усе: ${kb.join(" | ")}`);
});

test("«➕ Додати працівника»: editData → скан-лінк (гілка), роль лише viewWorkers → відмова (гейт main)", opts, async () => {
  await seedRole("clerk", ["editData"], ["/workers"]);
  await seedRole("viewer", ["viewWorkers"], ["/workers"]);
  await db.insert(adminsTable).values([
    { name: "Clerk", role: "clerk", telegramId: "800200" },
    { name: "Viewer", role: "viewer", telegramId: "800400" },
  ]);
  await sendStart("800200"); resetSent();
  await sendText("800200", "➕ Додати працівника");
  assert.match(sentText(), /passport-scan/, "editData → лінк на веб-скан паспорта");
  assert.doesNotMatch(sentText(), /Введіть повне ім'я/, "старого текстового флоу «add_worker» більше нема");

  await sendStart("800400"); resetSent();
  await sendText("800400", "➕ Додати працівника");
  assert.match(sentText(), /недоступна для твоєї ролі/, "viewWorkers без editData — відмова");
  assert.doesNotMatch(sentText(), /passport-scan/);
});

test("меню працівника: «🚫 Мої пропуски» (main) і «📄 Документи» (гілка) разом", opts, async () => {
  const [f] = await db.insert(factoriesTable).values({ name: "Fabryka" }).returning();
  await db.insert(workersTable).values({ fullName: "Jan Nowak", telegramId: "800500", language: "uk", factoryId: f!.id, isActive: true });
  await sendStart("800500");
  const kb = lastKeyboard();
  assert.ok(kb.includes("🚫 Мої пропуски"), `пропуски: ${kb.join(" | ")}`);
  assert.ok(kb.includes("📄 Документи"), `документи: ${kb.join(" | ")}`);
  assert.ok(kb.includes("💸 Аванс") || kb.some(x => /Аванс/.test(x)), "аванс лишився");
});

test("фабрика: isOffice (гілка) + minDaysPerWeek/email-отримувачі (main) зберігаються разом; join-link — обидва лінки", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [f] = await db.insert(factoriesTable).values({ name: "Biuro", companyId: co!.id }).returning();
  const p = await request(app).patch(`/api/factories/${f!.id}`).set("Cookie", owner.cookie).set(H)
    .send({ isOffice: true, minDaysPerWeek: 3, contractDuties: "prace biurowe", requiresSanepid: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const [after] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, f!.id));
  assert.equal(after?.isOffice, true); assert.equal(after?.minDaysPerWeek, 3);
  assert.equal(after?.contractDuties, "prace biurowe"); assert.equal(after?.requiresSanepid, true);

  const r = await request(app).put(`/api/factories/${f!.id}/email-recipients`).set("Cookie", owner.cookie).set(H)
    .send({ recipients: [{ email: "kadry@firma.pl" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = await request(app).get("/api/factories").set("Cookie", owner.cookie);
  const mine = list.body.find((x: any) => x.id === f!.id);
  assert.equal(mine?.emailRecipients?.length, 1); assert.equal(mine?.isOffice, true); assert.equal(mine?.minDaysPerWeek, 3);

  const j = await request(app).get(`/api/factories/${f!.id}/join-link`).set("Cookie", owner.cookie);
  assert.equal(j.status, 200);
  assert.match(j.body.link, new RegExp(`start=fac${f!.id}$`)); assert.match(j.body.scanLink, new RegExp(`start=facs${f!.id}$`));
});

test("каталог капабіліті: viewWorkers (main) + workerDocs/legalization (гілка) приймаються ролями", opts, async () => {
  const main = await seedAdmin({ role: "owner", isMain: true });
  const r = await request(app).post("/api/roles").set("Cookie", main.cookie).set(H)
    .send({ key: "merged", label: "Merged", caps: ["viewWorkers", "workerDocs", "legalization", "nope"], pages: ["/workers"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([...r.body.caps].sort(), ["legalization", "viewWorkers", "workerDocs"], "усі три капи в каталозі, невідома відкинута");
});
