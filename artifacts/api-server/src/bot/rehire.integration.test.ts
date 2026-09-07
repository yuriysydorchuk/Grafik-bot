import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, sendStart, sendText, pressButton, resetSent, sentText, sent } from "../test/botHarness.ts";
import { workersTable, factoriesTable, adminsTable, workerChangesTable } from "../test/harness.ts";
import { getState, clearState } from "./state.ts";

// Повернення звільненого (bot/handlers/rehire.ts): лінк фабрики тим самим або
// новим Telegram → запит офісу → «✅ Відновити»/«❌ Відхилити» → старий профіль
// активний (нового немає), фабрика з лінка, Telegram оновлено, журнал змін.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const OLD_TG = "830100", NEW_TG = "830200", OWNER_TG = "830900", SCHED_TG = "830901";

// стани бота живуть у памʼяті процесу — resetDb їх не чистить
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); for (const t of [OLD_TG, NEW_TG, OWNER_TG, SCHED_TG]) clearState(t); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seed() {
  const [f1] = await db.insert(factoriesTable).values({ name: "Old Factory" } as any).returning();
  const [f2] = await db.insert(factoriesTable).values({ name: "New Factory" } as any).returning();
  const [w] = await db.insert(workersTable).values({
    fullName: "Kowalski Jan", workerCode: "00123", telegramId: OLD_TG, factoryId: f1!.id, language: "uk",
    isActive: false, status: "fired", firedAt: new Date("2026-07-14T12:00:00Z"),
  }).returning();
  await db.insert(adminsTable).values([
    { name: "Owner", role: "owner", telegramId: OWNER_TG, isMain: true },
    { name: "Sched", role: "scheduler", telegramId: SCHED_TG },
  ] as any);
  return { f1: f1!, f2: f2!, w: w! };
}
const worker = async (id: number) => (await db.select().from(workersTable).where(eq(workersTable.id, id)))[0]!;
const adminMsgs = () => sent.filter(s => s.method === "sendMessage" && [OWNER_TG, SCHED_TG].includes(String(s.chatId)));
const okButton = () => {
  const kb = adminMsgs()[0]!.extra.reply_markup.inline_keyboard[0];
  return kb[0].callback_data as string;
};

test("той самий Telegram, fac-лінк: «Так» → запит офісу → ✅ → профіль активний на фабриці лінка", opts, async () => {
  const { f2, w } = await seed();
  await sendStart(OLD_TG, `fac${f2.id}`);
  assert.match(sentText(), /Повертаєтесь на роботу на \*New Factory\*/);
  resetSent();
  await pressButton(OLD_TG, `rh:yes:${f2.id}`);
  assert.equal(adminMsgs().length, 2, "owner + scheduler отримали запит");
  assert.match(adminMsgs()[0]!.text!, /Kowalski Jan.*№00123.*Old Factory.*New Factory/s);
  assert.doesNotMatch(adminMsgs()[0]!.text!, /Новий Telegram/);
  assert.match(sentText(), /Запит надіслано в офіс/);
  assert.equal(getState(OLD_TG)?.action, "rehire:pending");
  const ok = okButton();
  assert.match(ok, new RegExp(`^rhadm:ok:${w.id}:${f2.id}:${OLD_TG}$`));
  // /start під час очікування не стирає запит
  resetSent();
  await sendStart(OLD_TG);
  assert.match(sentText(), /уже надіслано/);
  assert.equal(getState(OLD_TG)?.action, "rehire:pending");

  resetSent();
  await pressButton(SCHED_TG, ok);
  const row = await worker(w.id);
  assert.equal(row.isActive, true);
  assert.equal(row.status, "active");
  assert.equal(row.firedAt, null);
  assert.equal(row.factoryId, f2.id);
  assert.equal(row.telegramId, OLD_TG);
  assert.equal(getState(OLD_TG), undefined, "pending знято");
  assert.equal(sent.filter(s => s.method === "editMessageText").length, 2, "повідомлення обох адресатів відредаговано");
  assert.match(sent.filter(s => s.method === "editMessageText")[0]!.text!, /Відновив\(ла\) Sched/);
  assert.match(sent.find(s => s.method === "sendMessage" && String(s.chatId) === OLD_TG)!.text!, /відновлено на роботу/);
  const fields = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, w.id))).map(c => c.field).sort();
  assert.deepEqual(fields, ["factoryId", "restored"]);
  assert.equal((await db.select().from(workersTable)).length, 1, "нового профілю немає");

  // повторний тап другого адміна — «вже вирішено», без змін
  resetSent();
  await pressButton(OWNER_TG, ok);
  assert.match(sent.find(s => s.method === "answerCallbackQuery")!.extra.text, /Вже вирішено/);
  assert.equal(sent.filter(s => s.method === "editMessageText").length, 0);
});

test("той самий Telegram: «Ні» → нічого не міняється", opts, async () => {
  const { f2, w } = await seed();
  await sendStart(OLD_TG, `fac${f2.id}`);
  resetSent();
  await pressButton(OLD_TG, "rh:no");
  assert.match(sentText(), /Якщо передумаєте/);
  assert.equal(adminMsgs().length, 0);
  assert.equal((await worker(w.id)).isActive, false);
});

test("новий Telegram, ім'я в чаті: «Це я» → «Оновити Telegram» → ✅ → старий профіль з новим tg, старий tg у журналі", opts, async () => {
  const { f2, w } = await seed();
  await sendStart(NEW_TG, `fac${f2.id}`);
  await pressButton(NEW_TG, "setlang:uk");
  resetSent();
  await sendText(NEW_TG, "Jan Kowalski");
  assert.match(sentText(), /Ви вже працювали у нас як \*Kowalski Jan\* \(№00123\)/);
  assert.equal((await db.select().from(workersTable)).length, 1, "профіль не створено");
  resetSent();
  await pressButton(NEW_TG, "rh:me");
  assert.match(sentText(), /Оновити Telegram/);
  resetSent();
  await pressButton(NEW_TG, "rh:tg:yes");
  assert.equal(adminMsgs().length, 2);
  assert.match(adminMsgs()[0]!.text!, /Новий Telegram-акаунт \(старий: 830100\)/);
  assert.equal(getState(NEW_TG)?.action, "rehire:pending");

  const ok = okButton();
  assert.match(ok, new RegExp(`:${NEW_TG}$`));
  resetSent();
  await pressButton(OWNER_TG, ok);
  const row = await worker(w.id);
  assert.equal(row.isActive, true);
  assert.equal(row.telegramId, NEW_TG);
  assert.equal(row.factoryId, f2.id);
  assert.equal((await db.select().from(workersTable)).length, 1);
  const tg = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.field, "telegramId")))[0]!;
  assert.equal(tg.oldValue, OLD_TG);
  assert.equal(tg.newValue, NEW_TG);
  assert.match(sent.find(s => s.method === "sendMessage" && String(s.chatId) === NEW_TG)!.text!, /відновлено на роботу на \*New Factory\*/);
});

test("новий Telegram: «Ні, це інша людина» → створюється новий профіль, як раніше (алерт з wmerge)", opts, async () => {
  const { f2 } = await seed();
  await sendStart(NEW_TG, `fac${f2.id}`);
  await pressButton(NEW_TG, "setlang:uk");
  await sendText(NEW_TG, "Jan Kowalski");
  resetSent();
  await pressButton(NEW_TG, "rh:notme");
  const all = await db.select().from(workersTable);
  assert.equal(all.length, 2);
  const fresh = all.find(x => x.telegramId === NEW_TG)!;
  assert.equal(fresh.isActive, true);
  assert.equal(fresh.factoryId, f2.id);
  assert.match(sentText(), /Вас додано до фабрики \*New Factory\*/);
  assert.match(adminMsgs()[0]!.text!, /Можливий дублікат.*звільнений/);
  assert.match(JSON.stringify(adminMsgs()[0]!.extra.reply_markup), /wmerge_/);
  assert.equal(getState(NEW_TG), undefined);
});

test("❌ Відхилити: профіль лишається звільненим, працівнику повідомлено, pending знято", opts, async () => {
  const { f2, w } = await seed();
  await sendStart(OLD_TG, `fac${f2.id}`);
  await pressButton(OLD_TG, `rh:yes:${f2.id}`);
  const no = okButton().replace("rhadm:ok:", "rhadm:no:");
  resetSent();
  await pressButton(OWNER_TG, no);
  assert.equal((await worker(w.id)).isActive, false);
  assert.equal(getState(OLD_TG), undefined);
  assert.match(sent.find(s => s.method === "sendMessage" && String(s.chatId) === OLD_TG)!.text!, /відхилено/);
  assert.match(sent.filter(s => s.method === "editMessageText")[0]!.text!, /Відхилив\(ла\) Owner/);
});
