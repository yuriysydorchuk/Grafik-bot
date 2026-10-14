// Фасад робота praca.gov.pl (12.10.2026): запуск тесту входу / подачі у фоні, сповіщення
// власника акаунта про потрібний код (бот + веб), скасування. Один прогін на акаунт одночасно.
import { db, adminsTable, uaSubmissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Markup } from "telegraf";
import { bot } from "../../bot/instance";
import { logger } from "../../lib/logger";
import { markPzLogin, pzAccountById } from "./accounts";
import { cancelCodeWait, isAwaitingCode, provideCode } from "./codes";
import { RobotError, ensureContext, ensureLoggedIn, isAccountBusy, reserveAccount, releaseAccount, snap, withBrowser, type RobotCtx } from "./robot";
import { createSubmission, setSubmission, submissionById, openSubmissionsForAccount } from "./submissions";
import { buildUaFormPayload, applyOverrides, missingOf } from "./payload";
import { fillForm, openForm, captureWydruk, saveDraft, signAndSend } from "./form";
import { attachConfirmation } from "./confirm";
import { cancelDecisionWait, isAwaitingDecision, provideDecision, waitForDecision, type ReviewDecision } from "./decisions";
import { requestCancel, isCancelled, clearCancel } from "./cancel";

export { listPzAccounts, createPzAccount, updatePzAccount, deletePzAccount, pzAccountById, pzReady, pzAccountFor, setPzAccountPoa } from "./accounts";
export { provideCode, isAwaitingCode, awaitingCodeFor } from "./codes";
export { submissionById, recentSubmissions, screenshotPath, previewPath, failStaleSubmissions, UA_SUBMISSIONS_DIR } from "./submissions";
export { isAccountBusy } from "./robot";
void isAccountBusy;
export { buildUaFormPayload } from "./payload";
export { isAwaitingDecision } from "./decisions";

const panelUrl = () => (process.env.WEB_APP_URL || "").replace(/\/$/, "");

// Запит коду власнику акаунта: прямий sendMessage по telegramId (без фільтра типів сповіщень —
// без коду подача не рухається), кнопка «Ввести код» → стан бота pz:code (handlers/pracaGov.ts).
async function askCodeViaBot(ctx: RobotCtx, purpose: "login" | "sign"): Promise<void> {
  if (!ctx.adminId) return;
  const [a] = await db.select({ telegramId: adminsTable.telegramId }).from(adminsTable).where(eq(adminsTable.id, ctx.adminId));
  if (!a?.telegramId) return;
  const what = purpose === "login" ? "для входу на praca.gov.pl" : "для підпису powiadomienia";
  const web = panelUrl() ? `${panelUrl()}/settings?tab=pracaGov&submission=${ctx.submissionId}` : null;
  await bot.telegram.sendMessage(a.telegramId,
    `🔐 Робот praca.gov.pl чекає код SMS ${what} (акаунт «${ctx.account.label ?? ctx.account.login}»).\nНадішліть код кнопкою нижче — він діє кілька хвилин.`,
    Markup.inlineKeyboard([[Markup.button.callback("🔢 Ввести код", `pz:code:${ctx.submissionId}`)], ...(web ? [[Markup.button.url("🖥 Відкрити в панелі", web)]] : [])]),
  ).catch(e => logger.warn({ err: e, id: ctx.submissionId }, "praca.gov: code prompt failed"));
}

async function notifyResult(adminId: number | null, text: string): Promise<void> {
  if (!adminId) return;
  const [a] = await db.select({ telegramId: adminsTable.telegramId }).from(adminsTable).where(eq(adminsTable.id, adminId));
  if (a?.telegramId) await bot.telegram.sendMessage(a.telegramId, text).catch(() => {});
}

// Тест входу: логін → код → контекст організації → скріншот шапки. Повертає id рядка журналу;
// сам прогін — у фоні, стан читається з ua_submissions.
export async function startLoginTest(accountId: number, adminId: number): Promise<number> {
  const account = await pzAccountById(accountId);
  if (!account) throw new Error("Акаунт не знайдено");
  if (!account.isActive) throw new Error("Акаунт вимкнено");
  if (!reserveAccount(account.id)) throw new Error("Цей акаунт уже виконує подачу — дочекайтесь завершення");
  let sub: Awaited<ReturnType<typeof createSubmission>>;
  try { sub = await createSubmission({ kind: "login_test", accountId: account.id, adminId }); }
  catch (e) { releaseAccount(account.id); throw e; }
  const ctx: RobotCtx = { submissionId: sub.id, account, adminId, onAwaitCode: askCodeViaBot };
  void (async () => {
    try {
      await withBrowser(account, async page => {
        await ensureLoggedIn(ctx, page);
        await ensureContext(ctx, page);
        await snap(ctx, page, "login-test-ok");
      });
      await setSubmission(sub.id, { status: "done", step: "вхід працює", finished: true });
      await markPzLogin(account.id, true);
      await notifyResult(adminId, `✅ praca.gov.pl: вхід акаунтом «${account.label ?? account.login}» працює.`);
    } catch (e: any) {
      if (isCancelled(sub.id)) { await setSubmission(sub.id, { status: "cancelled", step: "зупинено користувачем", finished: true }); return; }
      const msg = e instanceof RobotError ? `${e.message} (крок ${e.step})` : String(e?.message ?? e);
      logger.warn({ err: e, id: sub.id }, "praca.gov login test failed");
      await setSubmission(sub.id, { status: "failed", step: "помилка", error: msg, finished: true });
      await markPzLogin(account.id, false, msg);
      await notifyResult(adminId, `❌ praca.gov.pl: тест входу не вдався — ${msg}`);
    } finally { cancelCodeWait(sub.id, "завершено"); clearCancel(sub.id); }
  })();
  return sub.id;
}

export async function submitCode(submissionId: number, code: string): Promise<void> {
  const sub = await submissionById(submissionId);
  if (!sub) throw new Error("Подачу не знайдено");
  if (sub.status !== "awaiting_code" || !isAwaitingCode(submissionId)) throw new Error("Ця подача зараз не чекає код");
  const c = code.replace(/\s+/g, "");
  if (!/^\d{4,10}$/.test(c)) throw new Error("Код — лише цифри");
  if (!provideCode(submissionId, c)) throw new Error("Робот уже не чекає код");
}

export async function cancelSubmission(submissionId: number): Promise<void> {
  const sub = await submissionById(submissionId);
  if (!sub) throw new Error("Подачу не знайдено");
  if (!["queued", "running", "awaiting_code", "review", "signing"].includes(sub.status)) return;
  requestCancel(submissionId); // робот перевіряє прапорець на кожному кроці, закриває браузер і сам ставить cancelled
  cancelCodeWait(submissionId, "Скасовано користувачем");
  if (isAwaitingDecision(submissionId)) { provideDecision(submissionId, "cancel"); return; }
  await setSubmission(submissionId, { status: "cancelled", step: "зупиняю робота…", finished: false });
}

// ── Подача powiadomienia (етап 2: заповнення → перегляд → чернетка/підпис) ─────
// Дані збираються й валідуються до браузера; робот логіниться, перемикає контекст фірми
// (contextName акаунта або перші слова назви фірми), заповнює форму, знімає екрани на перегляд
// і чекає рішення людини: «зберегти чернетку» (Zapisz dane → schowek порталу) або «підписати»
// (етап 3; поки — чернетка + інструкція). Скасування закриває браузер без збереження.
export async function startSubmission(v: { taskId: number | null; workerId: number; companyId: number | null; adminId: number; overrides?: unknown }): Promise<{ submissionId: number }> {
  const built = await buildUaFormPayload(v.workerId, v.companyId);
  const payload = applyOverrides(built.payload, v.overrides); // правки з екрана анкети — лише для цієї подачі
  const { pzAccountFor } = await import("./accounts");
  const account = await pzAccountFor(v.adminId, payload.companyId); // акаунт — під фактичну фірму подачі
  if (!account) throw new Error("У вас нема активного акаунта profilu zaufanego для цієї фірми (Налаштування → praca.gov.pl)");
  if (!payload.podpis.funkcja) payload.podpis.funkcja = account.signerFunction ?? "";
  const missing = missingOf(payload);
  if (missing.length) throw new Error(`Бракує даних для форми: ${missing.join(", ")}`);
  {
    const path = await import("node:path"); const fs = await import("node:fs"); const { UPLOADS_ROOT } = await import("../../lib/uploads");
    const abs = account.poaFilePath ? path.resolve(UPLOADS_ROOT, account.poaFilePath) : null;
    payload.podpis.poaAbsPath = abs && fs.existsSync(abs) ? abs : null; // запис є, файла нема → без галочки
    payload.podpis.pelnomocnik = !!payload.podpis.poaAbsPath; // без файла довіреності галочку не ставимо (форма вимагає załącznik)
  }
  // бронюємо акаунт синхронно ДО створення рядка: подвійний клік інакше відкривав два Chromium під одним PZ
  if (!reserveAccount(account.id)) throw new Error("Акаунт зараз виконує іншу подачу — дочекайтесь її завершення");
  let sub: Awaited<ReturnType<typeof createSubmission>>;
  try { sub = await createSubmission({ kind: "submission", accountId: account.id, adminId: v.adminId, workerId: v.workerId, companyId: payload.companyId, taskId: v.taskId, payload }); }
  catch (e) { releaseAccount(account.id); throw e; }
  // контекст порталу — ФІРМА подачі (назва з довідника); сталий contextName акаунта — лише коли фірми в подачі нема
  const ctx: RobotCtx = { submissionId: sub.id, account: { ...account, contextName: payload.contextPattern || account.contextName }, adminId: v.adminId, onAwaitCode: askCodeViaBot };
  void (async () => {
    let outcome: ReviewDecision | "failed" = "failed";
    try {
      await withBrowser(account, async page => {
        await ensureLoggedIn(ctx, page);
        await ensureContext(ctx, page);
        await openForm(ctx, page);
        await fillForm(ctx, page, payload);
        const wyd = await captureWydruk(ctx, page);
        const decisionP = waitForDecision(sub.id); decisionP.catch(() => {}); // resolver — до публікації статусу
        await setSubmission(sub.id, { status: "review", step: "форма заповнена — перевірте Wydruk і оберіть: підписати, чернетка або скасувати", previewFile: wyd.rel });
        await notifyResult(v.adminId, `📝 praca.gov.pl: форма powiadomienia для ${payload.workerName} (${payload.companyName}) заповнена, чекає вашого рішення в панелі (20 хв).`);
        const d = await decisionP;
        outcome = d;
        if (d === "cancel") { await setSubmission(sub.id, { status: "cancelled", step: "скасовано на перегляді", finished: true }); return; }
        const saved = await saveDraft(ctx, page);
        const where = "Usługi elektroniczne → PSZ-PPWPU → Wczytaj dane → Ze schowka";
        const note = saved ? `чернетка збережена на порталі: ${where}` : `чернетку відправлено в schowek, але portal не підтвердив — перевірте: ${where}`;
        if (d === "save_draft") { await setSubmission(sub.id, { status: "done", step: note, finished: true }); return; }
        // d === "sign": чернетка вже в schowku (страховка) → підпис profilem zaufanym → відправка → потвердження в профіль
        const res = await signAndSend(ctx, page);
        await setSubmission(sub.id, { status: "submitted", step: "підписано й відправлено — вношу потвердження в профіль", confirmationNo: res.confirmationNo });
        const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
        const [fresh] = await db.select().from(uaSubmissionsTable).where(eq(uaSubmissionsTable.id, sub.id));
        let docId: number | null = null;
        if (res.file && fresh) docId = await attachConfirmation(fresh, res.file, today, res.confirmationNo, v.adminId).catch(e => { logger.warn({ err: e, id: sub.id }, "praca.gov: attachConfirmation failed"); return null; });
        await setSubmission(sub.id, { status: "done", step: docId ? `подано й підписано${res.confirmationNo ? ` · ${res.confirmationNo}` : ""}; потвердження внесено в профіль` : `подано й підписано${res.confirmationNo ? ` · ${res.confirmationNo}` : ""}; потвердження не вдалося внести автоматично — додайте файл у задачі`, finished: true });
        await notifyResult(v.adminId, `✅ praca.gov.pl: powiadomienie для ${payload.workerName} (${payload.companyName}) підписано й відправлено${res.confirmationNo ? ` · ${res.confirmationNo}` : ""}.`);
      });
      await markPzLogin(account.id, true);
    } catch (e: any) {
      if (isCancelled(sub.id)) { await setSubmission(sub.id, { status: "cancelled", step: "зупинено користувачем", finished: true }); return; }
      const msg = e instanceof RobotError ? `${e.message} (крок ${e.step})` : String(e?.message ?? e);
      logger.warn({ err: e, id: sub.id }, "praca.gov submission failed");
      await setSubmission(sub.id, { status: "failed", step: "помилка", error: msg, finished: true });
      await notifyResult(v.adminId, `❌ praca.gov.pl: подача для ${payload.workerName} не вдалася — ${msg}`);
    } finally { void outcome; cancelCodeWait(sub.id, "завершено"); cancelDecisionWait(sub.id, "завершено"); clearCancel(sub.id); }
  })();
  return { submissionId: sub.id };
}

// Анкета на перегляд ДО запуску (задача ступеня 2 або профіль): дані форми + прогалини + акаунт
// цього адміна під фірму подачі; підпис — функція з акаунта, галочка pełnomocnika лише з файлом довіреності.
export async function previewSubmission(workerId: number, companyId: number | null, adminId: number) {
  const { pzAccountFor } = await import("./accounts");
  const r = await buildUaFormPayload(workerId, companyId);
  const acc = await pzAccountFor(adminId, r.payload.companyId);
  r.payload.podpis.funkcja = acc?.signerFunction ?? "";
  r.payload.podpis.pelnomocnik = !!acc?.poaFilePath;
  return { ...r, account: acc ? { id: acc.id, label: acc.label ?? acc.login, contextName: acc.contextName || r.payload.contextPattern, signerFunction: acc.signerFunction } : null };
}

export async function decideSubmission(submissionId: number, decision: ReviewDecision): Promise<void> {
  const sub = await submissionById(submissionId);
  if (!sub) throw new Error("Подачу не знайдено");
  if (sub.status !== "review" || !isAwaitingDecision(submissionId)) throw new Error("Ця подача зараз не на перегляді");
  if (!provideDecision(submissionId, decision)) throw new Error("Робот уже не чекає рішення");
}

// Відкрита подача по людині×фірмі (щоб у задачі показати її стан)
export async function openSubmissionFor(workerId: number, companyId: number | null, adminId: number): Promise<number | null> {
  const { pzAccountFor } = await import("./accounts");
  const account = await pzAccountFor(adminId, companyId);
  if (!account) return null;
  const rows = await openSubmissionsForAccount(account.id);
  return rows.find(r => r.workerId === workerId && (companyId == null || r.companyId === companyId))?.id ?? null;
}
