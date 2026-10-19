// Робот praca.gov.pl (12.10.2026): headless Chromium (puppeteer, той самий, що рендерить PDF
// умов) з окремим профілем на акаунт (сесія порталу живе 30 хв — у пачці повторний вхід не
// потрібен). Кожен крок: дія → перевірка очікуваного стану → скріншот у журнал подачі; будь-яка
// невідповідність = failed з текстом і знімком, ручний шлях лишається. Коди SMS profilu
// zaufanego просить у власника акаунта через бот/веб (codes.ts).
//
// Етап 1 (цей файл): вхід + перемикання контексту організації. Заповнення форми PSZ-PPWPU і
// підпис — form.ts (етап 2–3), селектори — docs/PRACA_GOV_PPWPU.md.
//
// Сторінки входу (login.gov.pl → pz.gov.pl) зняті не були (потрібен чужий акаунт), тож
// робот шукає поля за ознаками (type=password, autocomplete=one-time-code, текст кнопок)
// і при першому реальному тесті покаже скріншоти кожного кроку для підгонки.
import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { PzAccount } from "@workspace/db";
import { logger } from "../../lib/logger";
import { pzCredentials } from "./accounts";
import { waitForCode } from "./codes";
import { addScreenshot, setSubmission } from "./submissions";
import { pzProfileDir } from "./paths";
import { isCancelled } from "./cancel";

// Код усередині page.evaluate виконується в браузері; tsconfig бекенду без lib "dom", тож
// мінімальні ambient-оголошення лише для цього модуля (підключати "dom" глобально не хочемо).
declare const document: any;
declare const window: any;
declare const CSS: any;
type Element = any;
type HTMLElement = any;

export const PORTAL = "https://www.praca.gov.pl";
const NAV_TIMEOUT = 45_000;

// без parameter properties: Node у режимі зняття типів (тест-харнес) їх не підтримує
export class RobotError extends Error {
  readonly step: string;
  constructor(msg: string, step: string) { super(msg); this.step = step; }
}

export interface RobotCtx {
  submissionId: number;
  account: PzAccount;
  adminId: number | null;
  onAwaitCode: (ctx: RobotCtx, purpose: "login" | "sign", hint?: string) => Promise<void>; // повідомити людину, що чекаємо код (hint — напр. час SMS / номер спроби)
}

// ── браузер ───────────────────────────────────────────────────────────────────
const inFlight = new Set<number>(); // accountId → одна подача на акаунт одночасно
export const isAccountBusy = (accountId: number) => inFlight.has(accountId);
// Синхронне бронювання акаунта ДО будь-якого await у фасаді (подвійний клік/паралельні запити
// інакше проходили перевірку isAccountBusy і відкривали два Chromium під одним profilem zaufanym).
export function reserveAccount(accountId: number): boolean { if (inFlight.has(accountId)) return false; inFlight.add(accountId); return true; }
export function releaseAccount(accountId: number): void { inFlight.delete(accountId); }

export async function withBrowser<T>(account: PzAccount, fn: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  // акаунт уже заброньовано фасадом (reserveAccount); якщо ні — бронюємо тут
  if (!inFlight.has(account.id) && !reserveAccount(account.id)) throw new RobotError("Цей акаунт уже виконує подачу — дочекайтесь завершення", "lock");
  let browser: Browser | null = null;
  try {
    const userDataDir = pzProfileDir(account.id);
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    browser = await puppeteer.launch({ headless: true, userDataDir, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--lang=pl-PL", "--window-size=1400,1000"], defaultViewport: { width: 1400, height: 1000 } });
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    // esbuild (keepNames) обгортає внутрішні функції у __name(...); puppeteer серіалізує колбеки
    // page.evaluate у браузер як текст, де цього хелпера нема → «__name is not defined».
    // Підкладаємо no-op у кожен документ до запуску скриптів сторінки.
    await page.evaluateOnNewDocument("window.__name = function (f) { return f; };");
    await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9,uk;q=0.8" });
    return await fn(page, browser);
  } finally {
    // спершу закрити Chromium, лише потім зняти блокування: інакше новий запуск відкриє той самий профіль
    if (browser) await browser.close().catch(() => {});
    inFlight.delete(account.id);
  }
}

// ── утиліти кроків ────────────────────────────────────────────────────────────
export async function snap(ctx: RobotCtx, page: Page, slug: string): Promise<void> {
  try { await addScreenshot(ctx.submissionId, slug, await page.screenshot({ fullPage: false, type: "png" })); } catch (e) { logger.warn({ err: e, id: ctx.submissionId }, "praca.gov: screenshot failed"); }
}
// Кожен крок перевіряє прапорець скасування («Зупинити робота» ззовні): кидає RobotError,
// withBrowser закриває Chromium, а фасад ставить cancelled, не failed.
export async function step(ctx: RobotCtx, page: Page, status: "running" | "awaiting_code" | "review" | "signing", text: string): Promise<void> {
  if (isCancelled(ctx.submissionId)) throw new RobotError("Скасовано користувачем", "cancelled");
  logger.info({ id: ctx.submissionId, status, text }, "praca.gov robot step");
  await setSubmission(ctx.submissionId, { status, step: text });
  void page;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Видимий елемент за текстом (кнопка/лінк/пункт меню) — клік через DOM, щоб не залежати від координат.
export async function clickByText(page: Page, re: RegExp, opts: { tags?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const tags = opts.tags ?? "button, a, [role=button], [role=menuitem], mat-option, li, span, div";
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const ok = await page.evaluate((tagsSel, src, flags) => {
      const rx = new RegExp(src, flags);
      const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const els = [...document.querySelectorAll(tagsSel)].filter(el => vis(el) && rx.test((el.textContent || "").replace(/\s+/g, " ").trim()));
      // найкоротший збіг = найточніший (span усередині button, а не весь блок)
      els.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const el = els[0] as HTMLElement | undefined;
      if (!el) return false;
      el.click(); return true;
    }, tags, re.source, re.flags);
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

export async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ")).catch(() => "");
}
export async function waitForText(page: Page, re: RegExp, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (re.test(await pageText(page))) return true; await sleep(500); }
  return false;
}

// Набір у поле реальними клавішами (Angular Material реагує на key-події, не на value=)
export async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector);
  await page.$eval(selector, (el: any) => { el.focus(); el.select?.(); });
  await page.keyboard.press("Backspace");
  const left = await page.$eval(selector, (el: any) => String(el.value ?? "").length).catch(() => 0);
  for (let i = 0; i < left; i++) await page.keyboard.press("Backspace");
  await page.type(selector, text, { delay: 25 });
}

// ── вхід ──────────────────────────────────────────────────────────────────────
// Селектори зняті 12.10.2026 (docs/PRACA_GOV_PPWPU.md → «Вхід»). Шапка порталу після входу —
// `pgp-header` з кнопкою меню користувача «<IMIĘ> Kontekst: …».
const HEADER_SEL = "pgp-header, header";
export async function headerText(page: Page): Promise<string> {
  return page.evaluate((sel: string) => (document.querySelector(sel)?.textContent || "").replace(/\s+/g, " "), HEADER_SEL).catch(() => "");
}
export async function isLoggedIn(page: Page): Promise<boolean> {
  return /Kontekst:/i.test(await headerText(page));
}

export async function ensureLoggedIn(ctx: RobotCtx, page: Page): Promise<void> {
  await step(ctx, page, "running", "відкриваю praca.gov.pl");
  await page.goto(`${PORTAL}/eurzad/strona-glowna`, { waitUntil: "networkidle2" });
  // Angular-застосунок малює шапку й підписи (i18n) із запізненням: чекаємо, поки в шапці
  // зʼявиться або «Kontekst:» (сесія є), або «Zaloguj» (сесії нема), а не фіксовану паузу.
  const ready = await waitUntil(async () => /Kontekst:|Zaloguj/i.test(await headerText(page)), 40_000);
  if (!ready) { await snap(ctx, page, "portal-not-ready"); throw new RobotError("praca.gov.pl не домалював шапку за 40 с", "portal-ready"); }
  await sleep(500);
  if (await isLoggedIn(page)) { await snap(ctx, page, "already-logged-in"); return; }
  await snap(ctx, page, "portal-home");

  await step(ctx, page, "running", "вхід: натискаю «Zaloguj»");
  if (!(await clickByText(page, /Zaloguj/i, { tags: `${HEADER_SEL} a, ${HEADER_SEL} button, a, button, [role=button]`, timeoutMs: 15_000 }))) throw new RobotError("Не знайшов кнопку «Zaloguj» на praca.gov.pl", "login-button");
  await Promise.race([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), sleep(15_000)]);
  await sleep(1500);
  await snap(ctx, page, "login-gateway");

  // login.praca.gov.pl (Keycloak + Angular-тема): кнопка «login.gov.pl» веде на window.loginGovPlUrl
  // (змінна з інлайн-скрипта сторінки, &amp; закодовані) — переходимо за нею напряму.
  if (/login\.praca\.gov\.pl/i.test(page.url())) {
    await step(ctx, page, "running", "вхід: переходжу з login.praca.gov.pl на login.gov.pl");
    const rel = await page.evaluate(() => (window as any).loginGovPlUrl as string | undefined).catch(() => undefined);
    if (rel) await page.goto(new URL(rel.replace(/&amp;/g, "&"), page.url()).toString(), { waitUntil: "networkidle2" });
    else if (!(await clickByText(page, /login\.gov\.pl/i, { tags: "a, button, [role=button], span, div" }))) throw new RobotError("На login.praca.gov.pl не знайшов перехід на login.gov.pl", "kc-gateway");
    await Promise.race([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), sleep(10_000)]);
    await sleep(1500);
    await snap(ctx, page, "login-gov-pl");
  }

  // login.gov.pl: плитки способів входу → «Profil zaufany»
  if (/login\.gov\.pl/i.test(page.url())) {
    await step(ctx, page, "running", "вхід: обираю «Profil zaufany» на login.gov.pl");
    if (!(await clickByText(page, /Profil zaufany/i, { tags: "button.wds-action-tile, button, a" }))) throw new RobotError("На login.gov.pl не знайшов плитку «Profil zaufany»", "login-provider");
    await Promise.race([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), sleep(15_000)]);
    await sleep(1500);
    await snap(ctx, page, "pz-login-page");
  }

  // pz.gov.pl/ui/au/login: #username + #password → «Zaloguj się»
  await step(ctx, page, "running", "вхід: вводжу логін і пароль profilu zaufanego");
  const pw = await page.waitForSelector("input#password, input[type=password]", { visible: true, timeout: 20_000 }).catch(() => null);
  if (!pw) throw new RobotError(`Не знайшов форму логіна profilu zaufanego (${page.url()})`, "pz-form");
  const loginSel = (await page.$("input#username")) ? "input#username" : "input[name=username], input[type=text]";
  const cred = pzCredentials(ctx.account);
  await typeInto(page, loginSel, cred.login);
  await typeInto(page, "input#password, input[type=password]", cred.password);
  await snap(ctx, page, "pz-filled");
  if (!(await clickByText(page, /^Zaloguj( się)?$/i, { tags: "button[type=submit], button" }))) await page.keyboard.press("Enter");
  await sleep(2500);

  // Другий фактор: модалка «Potwierdź logowanie» з #smsInput. Якщо на акаунті push у mObywatel —
  // модалки з полем не буде, чекаємо автоперехід на портал.
  const codeSel = await findCodeInput(page, 25_000);
  await snap(ctx, page, codeSel ? "pz-sms-modal" : "pz-after-submit");
  if (!codeSel) {
    const t = await pageText(page);
    if (/nieprawidłow|błędn|niepoprawn/i.test(t) && /hasło|login|nazw/i.test(t)) throw new RobotError("pz.gov.pl: невірний логін або пароль", "pz-credentials");
  } else {
    // очікування реєструємо ДО публікації статусу/сповіщення: інакше веб/бот встигають надіслати код, якого ніхто не чекає
    const codeP = waitForCode(ctx.submissionId, ctx.adminId); codeP.catch(() => {});
    await step(ctx, page, "awaiting_code", "вхід: чекаю код SMS від власника акаунта");
    await ctx.onAwaitCode(ctx, "login");
    const code = await codeP;
    await step(ctx, page, "running", "вхід: вводжу код SMS");
    await typeInto(page, codeSel, code);
    if (!(await clickByText(page, /^Potwierdź$/i, { tags: ".cdk-overlay-container button, button" }))) await page.keyboard.press("Enter");
    await sleep(2500);
    await snap(ctx, page, "pz-after-code");
    const t = await pageText(page);
    if (/pz\.gov\.pl/i.test(page.url()) && /nieprawidłow|błędn|niepoprawn|nieważn/i.test(t)) throw new RobotError("pz.gov.pl не прийняв код SMS", "pz-code");
  }

  // Повернення на портал
  await step(ctx, page, "running", "вхід: чекаю повернення на praca.gov.pl");
  const back = await waitUntil(async () => /praca\.gov\.pl/i.test(page.url()) && (await isLoggedIn(page)), 90_000);
  await snap(ctx, page, back ? "portal-logged-in" : "portal-not-logged-in");
  if (!back) throw new RobotError(`Після входу portal не показав сесію (${page.url()})`, "portal-session");
}

export async function findCodeInput(page: Page, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sel = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")].filter(i => i.getBoundingClientRect().width > 0 && !["hidden", "password", "checkbox", "radio", "submit"].includes(i.type));
      const hit = inputs.find(i => i.id === "smsInput") ?? inputs.find(i => i.autocomplete === "one-time-code" || i.inputMode === "numeric" || /kod|code|sms|otp|token/i.test(`${i.id} ${i.name} ${i.placeholder} ${i.getAttribute("aria-label") || ""}`));
      if (!hit) return null;
      if (!hit.id) hit.id = "__pz_code";
      return "#" + CSS.escape(hit.id);
    });
    if (sel) return sel;
    await sleep(700);
  }
  return null;
}

export async function waitUntil(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred().catch(() => false)) return true; await sleep(1000); }
  return false;
}

// Контекст подачі: меню користувача в шапці → «Zmiana kontekstu» → діалог з таблицею
// (tr.mat-row «Nazwa | Typ») → клік по рядку організації. contextName — підрядок назви
// (напр. «EUROSUPPORT GROUP»); порожній = лишаємо, як є (osoba fizyczna).
export async function ensureContext(ctx: RobotCtx, page: Page): Promise<void> {
  const want = ctx.account.contextName?.trim();
  if (!want) return;
  const rx = new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (rx.test(await headerText(page))) return;
  await step(ctx, page, "running", `перемикаю контекст на «${want}»`);
  if (!(await clickByText(page, /Kontekst:/i, { tags: `${HEADER_SEL} button, ${HEADER_SEL} [role=button]` }))) throw new RobotError("Не знайшов меню користувача («Kontekst:») у шапці", "context-menu");
  await sleep(1000);
  if (!(await clickByText(page, /^Zmiana kontekstu$/i, { tags: "[role=menuitem], button" }))) throw new RobotError("У меню нема пункту «Zmiana kontekstu»", "context-menu-item");
  await page.waitForSelector(".cdk-overlay-container mat-dialog-container", { visible: true, timeout: 10_000 }).catch(() => {});
  await sleep(800);
  await snap(ctx, page, "context-dialog");
  const picked = await page.evaluate((src: string, flags: string) => {
    const rxx = new RegExp(src, flags);
    const rows = [...document.querySelectorAll(".cdk-overlay-container mat-dialog-container tr.mat-row, .cdk-overlay-container mat-dialog-container tr[class*=mat-row]")];
    const row = rows.find(r => rxx.test((r.textContent || "").replace(/\s+/g, " ")));
    if (!row) return false;
    (row as HTMLElement).click();
    return true;
  }, rx.source, rx.flags);
  if (!picked) throw new RobotError(`У діалозі «Zmiana kontekstu» нема організації «${want}»`, "context-pick");
  await sleep(1500);
  // можливий крок підтвердження у тому ж діалозі
  await clickByText(page, /^(Zmień|Wybierz|Potwierdź|Zapisz|OK|Tak)$/i, { tags: ".cdk-overlay-container button", timeoutMs: 2000 });
  const ok = await waitUntil(async () => rx.test(await headerText(page)), 20_000);
  await snap(ctx, page, ok ? "context-switched" : "context-failed");
  if (!ok) throw new RobotError(`Контекст на «${want}» не перемкнувся`, "context-verify");
}
