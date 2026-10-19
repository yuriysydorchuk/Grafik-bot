// Заповнення форми PSZ-PPWPU (етап 2, 13.10.2026). Селектори — docs/PRACA_GOV_PPWPU.md.
// Форма — Angular Material в окремому застосунку formularze-pgp: поля шукаємо за підписом
// (label[for] → input), випадайки/автодоповнення — через overlay mat-option. Кожна група кроків
// робить скріншот; невдалий довідник = RobotError з назвою поля.
import type { Page } from "puppeteer";
import { RobotError, PORTAL, clickByText, pageText, snap, step, typeInto, findCodeInput, waitUntil, type RobotCtx } from "./robot";
import { pzCredentials } from "./accounts";
import { waitForCode } from "./codes";
import type { UaFormPayload } from "./payload";
import { logger } from "../../lib/logger";
import fs from "node:fs";
import path from "node:path";
import { UA_SUBMISSIONS_DIR } from "./submissions";

declare const document: any;
declare const CSS: any;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[:*]/g, "").trim().toLowerCase();

// ── пошук полів за підписом ───────────────────────────────────────────────────
// Повертає CSS-селектор контролу під підписом (label/mat-label, що починається з тексту).
// section — заголовок секції (h3), щоб розрізнити однакові підписи (адреса 1.1 vs 3.4).
async function controlByLabel(page: Page, label: string, opts: { section?: string; kind?: "input" | "select" | "textarea" | "checkbox" } = {}): Promise<string | null> {
  return page.evaluate((lab: string, sec: string | null, kind: string | null) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[:*]/g, "").trim().toLowerCase();
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let scope: any = document;
    if (sec) {
      const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((x: any) => norm(x.textContent).startsWith(norm(sec)));
      if (h) scope = h.parentElement;
    }
    // спершу в контейнері секції, потім по всій формі (поля 3.6/3.7 лежать поза блоком заголовка)
    // підпис може бути label/mat-label або просто span/div (секція 4): беремо текстові елементи без
    // контролів усередині, що починаються з тексту підпису, від найкоротшого (найточнішого)
    const pick = (root: any) => [...root.querySelectorAll("label, mat-label, legend, span, div, p")]
      .filter((l: any) => vis(l) && !l.querySelector("input, textarea, mat-select") && norm(l.textContent).startsWith(norm(lab)))
      .sort((a: any, b: any) => a.textContent.length - b.textContent.length);
    let labels = pick(scope);
    if (!labels.length && scope !== document) labels = pick(document);
    for (const l of labels) {
      let ctl: any = null;
      const forId = l.getAttribute("for");
      if (forId) ctl = document.getElementById(forId);
      const want = kind === "select" ? "mat-select" : kind === "textarea" ? "textarea" : kind === "checkbox" ? "input[type=checkbox]" : "input:not([type=hidden]), textarea, mat-select";
      if (ctl && kind === "select" && ctl.tagName !== "MAT-SELECT") ctl = null;
      // підпис без for (або for на обгортку): піднімаємось по предках, поки контейнер не матиме контрол
      if (!ctl) { let anc: any = l.parentElement; for (let i = 0; i < 4 && anc && !ctl; i++) { const cands = [...anc.querySelectorAll(want)].filter((c: any) => vis(c)); ctl = cands[0] ?? null; anc = anc.parentElement; } }
      if (!ctl) continue;
      // підпис перемикача/чекбокса може збігатися з підписом поля («Liczba godzin pracy w miesiącu») — для текстових полів їх пропускаємо
      if (!kind && ctl.tagName === "INPUT" && ["radio", "checkbox"].includes(ctl.type)) continue;
      if (!ctl.id) ctl.id = "__ctl_" + Math.random().toString(36).slice(2, 8);
      return "#" + CSS.escape(ctl.id);
    }
    return null;
  }, label, opts.section ?? null, opts.kind ?? null);
}

async function fillText(ctx: RobotCtx, page: Page, label: string, value: string, opts: { section?: string; required?: boolean } = {}): Promise<void> {
  if (!value) { if (opts.required) throw new RobotError(`Порожнє обовʼязкове поле «${label}»`, "form-data"); return; }
  const sel = await controlByLabel(page, label, { section: opts.section });
  if (!sel) { await snap(ctx, page, "field-notfound"); await dumpHtmlNear(ctx, page, new RegExp(esc(label.slice(0, 30)), "i"), "field-" + label.slice(0, 20)); throw new RobotError(`Не знайшов поле «${label}»${opts.section ? ` у секції «${opts.section}»` : ""}`, "form-field"); }
  const disabled = await page.$eval(sel, (el: any) => !!el.disabled);
  if (disabled) return; // підставлено порталом (NIP/REGON/дата) — не чіпаємо
  await typeInto(page, sel, value);
  await page.keyboard.press("Tab");
  await sleep(150);
}

// Autocomplete: набрати, дочекатись overlay, вибрати опцію, що містить match (або першу).
async function fillAutocomplete(ctx: RobotCtx, page: Page, label: string, typed: string, match: RegExp | null, opts: { section?: string } = {}): Promise<string> {
  const sel = await controlByLabel(page, label, { section: opts.section });
  if (!sel) throw new RobotError(`Не знайшов поле-довідник «${label}»`, "form-field");
  await page.waitForSelector(sel, { visible: true });
  // портал сам підставляє województwo/powiat/gmina/miejscowość з індексу — якщо вже стоїть потрібне, не чіпаємо
  const { cur, disabled } = await page.$eval(sel, (el: any) => ({ cur: String(el.value ?? "").trim(), disabled: !!el.disabled }));
  if (cur && match && match.test(cur)) return cur;
  if (disabled) { if (cur) return cur; throw new RobotError(`Поле «${label}» заблоковане порталом і порожнє`, "form-field"); }
  await page.click(sel);
  await page.$eval(sel, (el: any) => { el.focus(); el.select?.(); });
  await page.keyboard.press("Backspace");
  const left = await page.$eval(sel, (el: any) => String(el.value ?? "").length);
  for (let i = 0; i < left; i++) await page.keyboard.press("Backspace");
  await page.type(sel, typed, { delay: 40 });
  // Панель показує ВЕСЬ довідник одразу при фокусі й фільтрує з затримкою після набору —
  // чекаємо саме на потрібну опцію (або на стабільний відфільтрований список), не на перший список.
  const readOpts = () => page.evaluate(() => [...document.querySelectorAll(".cdk-overlay-container mat-option")].filter((o: any) => o.getBoundingClientRect().height > 0).map((o: any) => (o.textContent || "").replace(/\s+/g, " ").trim()));
  const deadline = Date.now() + 8000;
  let opts2: string[] = [], prev = "", idx = -1;
  while (Date.now() < deadline) {
    opts2 = await readOpts();
    if (match) { idx = opts2.findIndex(o => match.test(o)); if (idx >= 0) break; }
    else if (opts2.length && opts2.length <= 50 && opts2.join("\n") === prev) { idx = 0; break; }
    prev = opts2.join("\n");
    await sleep(400);
  }
  if (!opts2.length) { await snap(ctx, page, "dict-empty"); throw new RobotError(`Довідник «${label}» нічого не знайшов для «${typed}»`, "form-dict"); }
  if (idx < 0) await snap(ctx, page, "dict-nomatch");
  if (idx < 0) throw new RobotError(`У довіднику «${label}» нема «${typed}» (є: ${opts2.slice(0, 3).join("; ")}${opts2.length > 3 ? ` … ${opts2.length}` : ""})`, "form-dict");
  await page.evaluate((i: number) => { const os = [...document.querySelectorAll(".cdk-overlay-container mat-option")].filter((o: any) => o.getBoundingClientRect().height > 0); (os[i] as any).click(); }, idx);
  await sleep(300);
  return opts2[idx]!;
}

// mat-select, у чийого контейнера (до 4 предків) є текст підпису — для списків без label[for]
async function selectNearText(page: Page, re: RegExp): Promise<string | null> {
  return page.evaluate((src: string, flags: string) => {
    const rx = new RegExp(src, flags);
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const sel of [...document.querySelectorAll("mat-select")].filter(vis)) {
      let anc: any = sel.parentElement;
      for (let i = 0; i < 4 && anc; i++) {
        const own = [...anc.querySelectorAll("label, mat-label, span, div")].filter((x: any) => x.children.length === 0 && rx.test(x.textContent || ""));
        if (own.length && anc.querySelectorAll("mat-select").length === 1) { if (!sel.id) sel.id = "__sel_" + Math.random().toString(36).slice(2, 8); return "#" + CSS.escape(sel.id); }
        anc = anc.parentElement;
      }
    }
    return null;
  }, re.source, re.flags);
}

async function pickSelect(ctx: RobotCtx, page: Page, label: string, option: string | RegExp, opts: { section?: string } = {}): Promise<string> {
  const sel = (await controlByLabel(page, label, { section: opts.section, kind: "select" })) ?? (await selectNearText(page, new RegExp("^\\s*" + esc(label), "i")));
  if (!sel) throw new RobotError(`Не знайшов список «${label}»`, "form-field");
  return pickSelectBySel(ctx, page, sel, label, option);
}
async function pickSelectBySel(ctx: RobotCtx, page: Page, sel: string, label: string, option: string | RegExp): Promise<string> {
  const rx = option instanceof RegExp ? option : new RegExp("^" + esc(option) + "$", "i");
  // панель mat-select малюється асинхронно; поле може бути за межами екрана — прокрутити, клікнути,
  // дочекатись опцій; без них — повторити кліком і клавіатурою (Enter відкриває mat-select)
  const countOpts = () => page.evaluate(() => document.querySelectorAll(".cdk-overlay-container mat-option").length as number);
  await page.$eval(sel, (el: any) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
  // Заблокований список портал заповнив сам (Płeć і Data urodzenia — з PESEL): клік його не відкриває,
  // а Enter влучав у наступне поле з фокусом («Tytuł pobytu») — інцидент 16.10.2026. Звіряємо значення й не чіпаємо.
  const readLocked = () => page.$eval(sel, (el: any) => ({
    disabled: el.getAttribute("aria-disabled") === "true" || /select-disabled/.test(el.className || ""),
    value: (el.querySelector(".mat-mdc-select-value-text, .mat-select-value-text")?.textContent || "").replace(/\s+/g, " ").trim(),
  }));
  let locked = await readLocked();
  if (locked.disabled) {
    // підстановка з PESEL асинхронна — порожнє заблоковане поле чекаємо, а не пропускаємо
    const deadline = Date.now() + 5000;
    while (!locked.value && Date.now() < deadline) { await sleep(250); locked = await readLocked(); }
    if (!locked.value) { await snap(ctx, page, "select-locked-empty"); throw new RobotError(`«${label}» заблоковане порталом і порожнє — перевірте PESEL`, "form-data"); }
    if (rx.test(locked.value)) return locked.value;
    await snap(ctx, page, "select-locked-mismatch");
    throw new RobotError(`«${label}» портал підставив сам: «${locked.value}», а в профілі «${String(option)}» — перевірте PESEL і дані профілю`, "form-data");
  }
  for (let attempt = 0; attempt < 3 && !(await countOpts()); attempt++) {
    if (attempt === 2) {
      // Enter — лише якщо фокус справді на цьому списку, інакше відкриється чужий
      const focused = await page.$eval(sel, (el: any) => { el.focus(); return el === document.activeElement || el.contains(document.activeElement); }).catch(() => false);
      if (focused) await page.keyboard.press("Enter");
    }
    else await page.click(sel).catch(() => {});
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(await countOpts())) await sleep(250);
  }
  const res = await page.evaluate((src: string, flags: string) => {
    const rxx = new RegExp(src, flags);
    const os = [...document.querySelectorAll(".cdk-overlay-container mat-option")];
    const texts = os.map((x: any) => (x.textContent || "").replace(/\s+/g, " ").trim());
    const i = texts.findIndex(t => rxx.test(t));
    if (i >= 0) (os[i] as any).click();
    return { picked: i >= 0 ? texts[i] : null, texts };
  }, rx.source, rx.flags);
  if (!res.picked) { await snap(ctx, page, "select-nomatch"); await page.keyboard.press("Escape"); throw new RobotError(`У списку «${label}» нема опції «${String(option)}» (є: ${res.texts.slice(0, 6).join("; ")})`, "form-dict"); }
  await sleep(250);
  return res.picked;
}

async function pickRadio(page: Page, labelRe: RegExp, section?: string): Promise<boolean> {
  return page.evaluate((src: string, flags: string, sec: string | null) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const rx = new RegExp(src, flags);
    const labelOf = (r: any) => r.tagName === "INPUT" ? (document.querySelector(`label[for="${r.id}"]`)?.textContent || r.closest("mat-radio-button")?.textContent || "") : r.textContent;
    const find = (scope: any) => [...scope.querySelectorAll("mat-radio-button, input[type=radio]")].find((r: any) => rx.test(norm(labelOf(r) || "")));
    let hit: any = null;
    // секція (h3 «3.6…») → її контейнер; перемикачі можуть лежати в сусідньому блоці — тоді шукаємо по всій формі
    if (sec) { const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((x: any) => norm(x.textContent).toLowerCase().startsWith(sec.toLowerCase())); if (h) hit = find(h.parentElement); }
    if (!hit) hit = find(document);
    if (!hit) return false;
    const input = hit.tagName === "INPUT" ? hit : hit.querySelector("input[type=radio]");
    ((input ?? hit) as any).click();
    return true;
  }, labelRe.source, labelRe.flags, section ?? null);
}

// Числове поле поруч з перемикачем (3.6/3.7): власного підпису не має — беремо перший увімкнений
// видимий input (не radio/checkbox) у контейнері перемикача, піднімаючись до 4 предків.
async function inputNearRadio(page: Page, labelRe: RegExp): Promise<string | null> {
  return page.evaluate((src: string, flags: string) => {
    const rx = new RegExp(src, flags);
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const lab = [...document.querySelectorAll("mat-radio-button label, label")].find((l: any) => vis(l) && rx.test((l.textContent || "").replace(/\s+/g, " ").trim()) && l.closest("mat-radio-button"));
    if (!lab) return null;
    let anc: any = lab.closest("mat-radio-button")?.parentElement;
    for (let i = 0; i < 4 && anc; i++) {
      const inp = [...anc.querySelectorAll("input")].find((x: any) => !["radio", "checkbox", "hidden"].includes(x.type) && !x.disabled && vis(x));
      if (inp) { if (!inp.id) inp.id = "__near_" + Math.random().toString(36).slice(2, 8); return "#" + CSS.escape(inp.id); }
      anc = anc.parentElement;
    }
    return null;
  }, labelRe.source, labelRe.flags);
}

// Поле поруч із довільним текстом-підписом (без label): перший увімкнений input у контейнері тексту
async function fillNearText(ctx: RobotCtx, page: Page, textRe: RegExp, value: string, what: string): Promise<void> {
  if (!value) throw new RobotError(`Порожнє значення для «${what}»`, "form-data");
  const sel = await page.evaluate((src: string, flags: string) => {
    const rx = new RegExp(src, flags);
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const t = [...document.querySelectorAll("label, mat-label, span, div, p")].filter((x: any) => vis(x) && !x.querySelector("input") && rx.test((x.textContent || "").replace(/\s+/g, " "))).sort((a: any, b: any) => a.textContent.length - b.textContent.length)[0];
    if (!t) return null;
    let anc: any = t.parentElement;
    for (let i = 0; i < 4 && anc; i++) { const inp = [...anc.querySelectorAll("input")].find((x: any) => !["radio", "checkbox", "hidden"].includes(x.type) && !x.disabled && vis(x)); if (inp) { if (!inp.id) inp.id = "__nt_" + Math.random().toString(36).slice(2, 8); return "#" + CSS.escape(inp.id); } anc = anc.parentElement; }
    return null;
  }, textRe.source, textRe.flags);
  if (!sel) { await snap(ctx, page, "near-text-notfound"); await dumpHtmlNear(ctx, page, textRe, "near-" + what); throw new RobotError(`Не знайшов поле біля тексту «${what}»`, "form-field"); }
  await typeInto(page, sel, value);
  await page.keyboard.press("Tab");
  await sleep(150);
}

async function fillNearRadio(ctx: RobotCtx, page: Page, labelRe: RegExp, value: string, what: string): Promise<void> {
  const sel = await inputNearRadio(page, labelRe);
  if (!sel) { await snap(ctx, page, "near-radio-notfound"); await dumpHtmlNear(ctx, page, labelRe, "near-" + what); throw new RobotError(`Не знайшов числове поле біля перемикача «${what}»`, "form-field"); }
  await typeInto(page, sel, value);
  await page.keyboard.press("Tab");
  await sleep(150);
}

async function setCheckbox(page: Page, labelRe: RegExp, checked: boolean): Promise<boolean> {
  return page.evaluate((src: string, flags: string, want: boolean) => {
    const rx = new RegExp(src, flags);
    const boxes = [...document.querySelectorAll("mat-checkbox")];
    const hit = boxes.find((b: any) => rx.test((b.textContent || "").replace(/\s+/g, " ")));
    if (!hit) return false;
    const input = hit.querySelector("input[type=checkbox]") as any;
    if (!!input.checked !== want) input.click();
    return true;
  }, labelRe.source, labelRe.flags, checked);
}

// Помилки валідації форми (mat-error) → список
async function formErrors(page: Page): Promise<string[]> {
  // Помилка під ВИМКНЕНИМ полем (напр. «miesięczna w złotych», коли обрано годинну ставку) — артефакт
  // порталу, не блокер: по data-label знаходимо підпис поля → його контрол → якщо disabled, пропускаємо.
  return page.evaluate(() => {
    const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[:*]/g, "").trim().toLowerCase();
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const controlFor = (lab: string): any => {
      const cands = [...document.querySelectorAll("label, mat-label, legend, span, div, p")].filter((l: any) => vis(l) && !l.querySelector("input, textarea, mat-select") && norm(l.textContent).startsWith(norm(lab))).sort((a: any, b: any) => a.textContent.length - b.textContent.length);
      for (const l of cands) {
        const forId = l.getAttribute("for"); if (forId && document.getElementById(forId)) return document.getElementById(forId);
        let anc: any = l.parentElement; for (let i = 0; i < 3 && anc; i++) { const c = [...anc.querySelectorAll("input:not([type=hidden]), textarea, mat-select")].filter((x: any) => vis(x) && !["radio", "checkbox"].includes(x.type))[0]; if (c) return c; anc = anc.parentElement; }
      }
      return null;
    };
    return [...document.querySelectorAll("mat-error, .mat-mdc-form-field-error, .error-message")].filter((e: any) => vis(e))
      .map((e: any) => ({ lab: e.closest("pgp-errors")?.getAttribute("data-label") || e.closest("[data-label]")?.getAttribute("data-label") || "", t: (e.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter(({ lab }) => { if (!lab) return true; const c = controlFor(lab); return !(c && (c.disabled || c.getAttribute("aria-disabled") === "true")); })
      .map(({ lab, t }) => lab ? `${lab}: ${t}` : t).filter(Boolean).slice(0, 20);
  });
}

// ── кроки ─────────────────────────────────────────────────────────────────────
// Крок 1: конструктор → адресат (підставлений) → Dalej → «Potwierdzenie» (контекст) → Tak → форма.
export async function openForm(ctx: RobotCtx, page: Page): Promise<void> {
  await step(ctx, page, "running", "відкриваю конструктор PSZ-PPWPU");
  await page.goto(`${PORTAL}/eurzad/uslugi-elektroniczne/kreator-wnioskow/PSZ-PPWPU`, { waitUntil: "networkidle2" });
  const ok = await waitFor(page, async () => /Wybór adresata/i.test(await pageText(page)) && !!(await page.$("input[placeholder*='urzędu'], input[role=combobox]")), 30_000);
  if (!ok) { await snap(ctx, page, "kreator-not-ready"); throw new RobotError("Конструктор PSZ-PPWPU не відкрився", "kreator"); }
  await sleep(800);
  const t = await pageText(page);
  if (/Konieczne jest wypełnienie adresu zamieszkania/i.test(t)) throw new RobotError("Portal вимагає заповнити адресу проживання в даних акаунта (Zarządzanie kontem)", "kreator-account");
  const adresat = await page.$eval("input[placeholder*='urzędu'], input[role=combobox]", (el: any) => el.value as string).catch(() => "");
  if (!adresat) throw new RobotError("Поле «Adresat» порожнє — portal не підставив urząd за адресою організації", "kreator-adresat");
  await snap(ctx, page, "kreator-adresat");
  await step(ctx, page, "running", `крок 1: адресат «${adresat}» → Dalej`);
  if (!(await clickByText(page, /^Dalej$/i, { tags: "button" }))) throw new RobotError("Нема кнопки «Dalej» на кроці адресата", "kreator-dalej");
  await sleep(1200);
  // діалог про контекст
  if (/Potwierdzenie/i.test(await pageText(page))) {
    const t2 = await pageText(page);
    if (/Konieczne jest wypełnienie adresu zamieszkania/i.test(t2)) throw new RobotError("Portal вимагає адресу проживання в даних акаунта", "kreator-account");
    await snap(ctx, page, "kreator-confirm");
    if (!(await clickByText(page, /^Tak$/i, { tags: ".cdk-overlay-container button, button" }))) throw new RobotError("Діалог «Potwierdzenie» без кнопки «Tak»", "kreator-confirm");
  }
  const opened = await waitFor(page, async () => /formularze-pgp\/formularz\/PSZ-PPWPU/i.test(page.url()) && /Dane cudzoziemca/i.test(await pageText(page)), 40_000);
  if (!opened) { await snap(ctx, page, "form-not-opened"); throw new RobotError(`Форма не відкрилась (${page.url()})`, "form-open"); }
  await sleep(1000);
  await snap(ctx, page, "form-opened");
}

// Крок 2: заповнення
export async function fillForm(ctx: RobotCtx, page: Page, p: UaFormPayload): Promise<void> {
  await step(ctx, page, "running", "заповнюю шапку та підмiot");
  await fillText(ctx, page, "Miejscowość", p.miejscowosc, { required: true });
  if (p.kraz) await fillText(ctx, page, "Numer KRAZ", p.kraz);
  // 1.2/1.3: у нас порожньо → лишаємо підставлене порталом (Klinex має контакт у реєстрації); валідація в кінці спіймає, якщо порожньо і там
  if (p.email) await fillText(ctx, page, "e-mail", p.email, { section: "1.2" });
  if (p.telefon) await fillText(ctx, page, "Nr telefonu", p.telefon, { section: "1.3" });
  await snap(ctx, page, "form-1-podmiot");

  await step(ctx, page, "running", "заповнюю дані cudzoziemca");
  const S2 = "2. Dane cudzoziemca";
  await fillText(ctx, page, "Imię", p.cudzoziemiec.imie, { section: S2, required: true });
  await fillText(ctx, page, "Kolejne imiona", p.cudzoziemiec.kolejneImiona, { section: S2 });
  await fillText(ctx, page, "Nazwisko", p.cudzoziemiec.nazwisko, { section: S2, required: true });
  await fillAutocomplete(ctx, page, "Obywatelstwo", p.cudzoziemiec.obywatelstwo.slice(0, 6), new RegExp("^" + esc(p.cudzoziemiec.obywatelstwo) + "$", "i"), { section: S2 });
  await pickSelect(ctx, page, "Rodzaj dokumentu podróży", p.cudzoziemiec.dokRodzaj, { section: S2 });
  await fillAutocomplete(ctx, page, "Państwo, w którym wydano dokument", p.cudzoziemiec.panstwoWydania.slice(0, 6), new RegExp("^" + esc(p.cudzoziemiec.panstwoWydania) + "$", "i"), { section: S2 });
  await fillText(ctx, page, "Seria i nr dokumentu", p.cudzoziemiec.seriaNr, { section: S2, required: true });
  await fillText(ctx, page, "Data wydania dokumentu", p.cudzoziemiec.dataWydania, { section: S2, required: true });
  await fillText(ctx, page, "Data ważności dokumentu", p.cudzoziemiec.dataWaznosci, { section: S2, required: true });
  if (p.cudzoziemiec.pesel) await fillText(ctx, page, "PESEL", p.cudzoziemiec.pesel, { section: S2 });
  await fillText(ctx, page, "Data urodzenia", p.cudzoziemiec.dataUrodzenia, { section: S2, required: true });
  await pickSelect(ctx, page, "Płeć", p.cudzoziemiec.plec, { section: S2 });
  // у контексті організації «Tytuł pobytu» — обовʼязковий список (у fizycznej був підставлений «OCHRONA CZASOWA»)
  // pgp-autocomplete (mat-label без for, input role=combobox «Wybierz wartość»); у fizycznej — disabled з «OCHRONA CZASOWA»
  // значення з payload (POBYT CZASOWY для власників karty, OCHRONA CZASOWA для решти); portal інколи підставляє
  // «OCHRONA CZASOWA» і блокує поле — тоді змінити не можемо, лишаємо як є (fillAutocomplete повертає поточне)
  { const want = p.cudzoziemiec.tytulPobytu || "OCHRONA CZASOWA"; const got = await fillAutocomplete(ctx, page, "Tytuł pobytu", want.slice(0, 5), new RegExp("^" + esc(want) + "$", "i"), { section: S2 });
    if (got && got.toUpperCase() !== want.toUpperCase()) logger.warn({ id: ctx.submissionId, got, want }, "praca.gov: Tytuł pobytu заблокований порталом — лишаємо підставлене"); }
  await snap(ctx, page, "form-2-cudzoziemiec");

  await step(ctx, page, "running", "заповнюю дані про роботу");
  const S3 = "3. Informacje o oferowanej pracy";
  await fillText(ctx, page, "Data podjęcia pracy", p.praca.dataPodjecia, { section: S3, required: true });
  if (!(await pickRadio(page, p.praca.pkdVersion === "PKD_2025" ? /PKD 2025/i : /PKD 2007/i, "3.1"))) throw new RobotError("Нема перемикача класифікації PKD", "form-field");
  await sleep(400);
  {
    // код у базі «78.10.Z» → довідник порталу показує «7810Z - …»; пробуємо кілька написань
    const code = p.praca.pkd; const dotted = code.length >= 5 ? `${code.slice(0, 2)}.${code.slice(2, 4)}.${code.slice(4)}` : code;
    const variants = [code, code.replace(/[A-Z]$/, ""), dotted];
    let done = false, lastErr: unknown = null;
    for (const v of variants) { try { await fillAutocomplete(ctx, page, "Symbol PKD i opis", v, new RegExp("^" + esc(code) + "\\b|^" + esc(dotted) + "\\b", "i"), { section: "3.1" }); done = true; break; } catch (e) { lastErr = e; } }
    if (!done) throw lastErr;
  }
  await fillText(ctx, page, "Stanowisko / rodzaj pracy", p.praca.stanowisko.slice(0, 200), { section: "3.2", required: true });
  await fillAutocomplete(ctx, page, "Nazwa i kod zawodu", p.praca.zawodKod, new RegExp("^" + esc(p.praca.zawodKod) + "\\b"), { section: "3.3" });
  const S34 = "3.4. Miejsce wykonywania pracy";
  const m = p.praca.miejsce;
  if (m.kodPocztowy) {
    await fillText(ctx, page, "Kod pocztowy", m.kodPocztowy, { section: S34 });
    // портал за індексом сам підставляє województwo/powiat/gmina/miejscowość — асинхронно; дочекатись, інакше наш набір змішається з підстановкою
    const wojSel = await controlByLabel(page, "Województwo", { section: S34 });
    if (wojSel) await waitFor(page, async () => !!(await page.$eval(wojSel, (el: any) => String(el.value ?? "").trim())), 6000);
    await sleep(500);
  }
  await fillAutocomplete(ctx, page, "Województwo", m.wojewodztwo, new RegExp("^" + esc(m.wojewodztwo) + "$", "i"), { section: S34 });
  await fillAutocomplete(ctx, page, "Powiat", m.powiat, new RegExp("^" + esc(m.powiat) + "$", "i"), { section: S34 });
  await fillAutocomplete(ctx, page, "Gmina", m.gmina, new RegExp("^" + esc(m.gmina) + "$", "i"), { section: S34 });
  if (m.miejscowosc) await fillAutocomplete(ctx, page, "Miejscowość", m.miejscowosc, new RegExp("^" + esc(m.miejscowosc) + "$", "i"), { section: S34 });
  if (m.ulica) await fillAutocomplete(ctx, page, "Ulica", m.ulica.replace(/^ul\.\s*/i, ""), null, { section: S34 }).catch(async () => { await fillText(ctx, page, "Ulica", m.ulica, { section: S34 }); });
  if (m.nrDomu) await fillText(ctx, page, "Nr domu", m.nrDomu, { section: S34 });
  if (m.nrLokalu) await fillText(ctx, page, "Nr lokalu", m.nrLokalu, { section: S34 });
  if (p.praca.infoDodatkowe) await fillText(ctx, page, "Informacje dodatkowe o miejscu", p.praca.infoDodatkowe.slice(0, 200), { section: S34 });
  await pickSelect(ctx, page, "Rodzaj umowy", p.praca.rodzajUmowy, { section: "3.5" });
  if (!(await pickRadio(page, /Liczba godzin pracy w miesiącu/i, "3.6"))) { await snap(ctx, page, "radio-notfound"); await dumpHtmlNear(ctx, page, /Wymiar czasu pracy/i, "wymiar"); throw new RobotError("Нема перемикача «Liczba godzin pracy w miesiącu»", "form-field"); }
  await sleep(400);
  await fillNearRadio(ctx, page, /^Liczba godzin pracy w miesiącu$/i, p.praca.godzinMiesiac, "Liczba godzin pracy w miesiącu");
  if (!(await pickRadio(page, /godzinowa w złotych/i, "3.7"))) throw new RobotError("Нема перемикача «godzinowa w złotych»", "form-field");
  await sleep(400);
  await fillNearRadio(ctx, page, /^godzinowa w złotych/i, p.praca.stawkaGodz, "godzinowa w złotych");
  // при годинній ставці форма вимагає ще «oraz najniższe miesięczne wynagrodzenie … na podstawie stawki godzinowej»
  await fillNearText(ctx, page, /oraz najniższe miesięczne wynagrodzenie/i, p.praca.stawkaMies, "miesięczne na podstawie stawki godzinowej");
  await snap(ctx, page, "form-3-praca");

  await step(ctx, page, "running", "заповнюю чисельність і підписанта");
  const S4 = "4. Informacja o liczbie";
  await fillText(ctx, page, "Liczba wszystkich osób wykonujących pracę na podstawie umowy o pracę", p.liczby.umowaOPrace, { section: S4, required: true });
  await fillText(ctx, page, "Liczba wszystkich osób wykonujących pracę na podstawie umów cywilnoprawnych", p.liczby.cywilne, { section: S4, required: true });
  await addAttachments(ctx, page, p);
  if (p.podpis.funkcja) await fillText(ctx, page, "Pełniona funkcja", p.podpis.funkcja, { section: "Osoba podpisująca" });
  // pełnomocnik: галочка відкриває обовʼязковий załącznik «Pełnomocnictwo (…)» — вантажимо PDF з акаунта
  await setCheckbox(page, /pełnomocnik/i, !!(p.podpis.pelnomocnik && p.podpis.poaAbsPath));
  if (p.podpis.pelnomocnik && p.podpis.poaAbsPath) {
    await sleep(800);
    const fileInput = await page.$("input[type=file]");
    if (!fileInput) { await snap(ctx, page, "poa-no-input"); throw new RobotError("Не знайшов поле файлу для pełnomocnictwa", "form-poa"); }
    await fileInput.uploadFile(p.podpis.poaAbsPath);
    const attached = await waitFor(page, async () => /Maksymalna liczba załączonych plików[^0-9]*[1-9]/i.test(await pageText(page)) || /\.pdf/i.test((await pageText(page)).slice(-4000)), 15_000);
    if (!attached) { await snap(ctx, page, "poa-not-attached"); throw new RobotError("Pełnomocnictwo не прикріпилось", "form-poa"); }
    await step(ctx, page, "running", "pełnomocnictwo прикріплено");
  }
  await sleep(500);
  await snap(ctx, page, "form-4-podpis");

  const errs = await formErrors(page);
  if (errs.length) { await snap(ctx, page, "form-errors"); throw new RobotError(`Форма показує помилки: ${errs.join(" | ")}`, "form-validate"); }
}

// ── Załączniki (best-effort, 19.10.2026): «Dodaj załącznik» → назва + файл, як у ручних подачах (Paszport + 88Z ×2).
// Розмітку секції наживо не знято, тож кожен załącznik під try: не прикріпився — знімок, warn у лог, порожній рядок
// прибираємо («Usuń»), форма валідна й без залучників; людина бачить результат у Wydruku перед підписом.
async function addAttachments(ctx: RobotCtx, page: Page, p: UaFormPayload): Promise<void> {
  if (!p.zalaczniki?.length) return;
  // секція має бути впізнана по заголовку — інакше нічого не чіпаємо (запис у чужий input зіпсував би форму)
  const hasSection = await page.evaluate(() => [...document.querySelectorAll("h1,h2,h3,h4")].some((x: any) => (x.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().startsWith("załączniki")));
  if (!hasSection) { logger.warn({ id: ctx.submissionId }, "praca.gov: секцію «Załączniki» не знайдено — без залучників"); await step(ctx, page, "running", "секцію Załączniki не знайдено — подача без залучників, додайте руками за потреби"); return; }
  // останній елемент у секції; file-input не фільтруємо по видимості (він схований за стилізованою кнопкою)
  const lastInSection = (sel: string, anyVis = false) => page.evaluate((s: string, av: boolean) => {
    const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((x: any) => norm(x.textContent).startsWith("załączniki"));
    if (!h?.parentElement) return null;
    const els = [...h.parentElement.querySelectorAll(s)].filter((el: any) => av || vis(el));
    const el: any = els[els.length - 1]; if (!el) return null;
    if (!el.id) el.id = "__zal_" + Math.random().toString(36).slice(2, 8);
    return "#" + CSS.escape(el.id);
  }, sel, anyVis);
  const fileInputsInSection = () => page.evaluate(() => {
    const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((x: any) => (x.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().startsWith("załączniki"));
    return h?.parentElement ? h.parentElement.querySelectorAll("input[type=file]").length : 0;
  });
  // файл вантажимо під ОРИГІНАЛЬНОЮ назвою (portal показує basename шляху; на диску лежить timestamp-random.pdf)
  const tmpDir = path.join(UA_SUBMISSIONS_DIR, String(ctx.submissionId), "zalaczniki");
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const [i, z] of p.zalaczniki.entries()) {
    const tag = `zal-${i + 1}`;
    const before = await fileInputsInSection();
    let rowAdded = false;
    try {
      const safeName = z.fileName.replace(/[\/\\:*?"<>|]/g, "_");
      const tmp = path.join(tmpDir, safeName); fs.copyFileSync(z.absPath, tmp);
      if (!(await clickByText(page, /^Dodaj załącznik/i, { timeoutMs: 5000 }))) throw new Error("нема кнопки «Dodaj załącznik»");
      await sleep(800);
      rowAdded = (await fileInputsInSection()) > before;
      const nameSel = await lastInSection("input[type=text]:not([disabled]), textarea:not([disabled])");
      if (nameSel) { await typeInto(page, nameSel, z.label); await page.keyboard.press("Tab"); await sleep(150); }
      const fileSel = await lastInSection("input[type=file]", true);
      const fileInput = fileSel ? await page.$(fileSel) : null;
      if (!fileInput) throw new Error(`нема поля файлу в секції (file-полів: ${before})`);
      await fileInput.uploadFile(tmp);
      const attached = await waitFor(page, async () => (await pageText(page)).includes(safeName), 15_000);
      if (!attached) throw new Error(`файл ${safeName} не зʼявився на сторінці`);
      await step(ctx, page, "running", `załącznik ${i + 1}/${p.zalaczniki.length}: ${z.label}`);
    } catch (e) {
      await snap(ctx, page, `${tag}-fail`);
      logger.warn({ id: ctx.submissionId, err: String(e), label: z.label }, "praca.gov: załącznik не прикріплено");
      // порожній рядок załącznika валить валідацію («Nie dodano plików dla załącznika») — прибираємо ЛИШЕ щойно доданий
      if (rowAdded) {
        const rm = await page.evaluate(() => {
          const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((x: any) => (x.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().startsWith("załączniki"));
          const btns = h?.parentElement ? [...h.parentElement.querySelectorAll("button, [role=button]")].filter((b: any) => /usuń/i.test(b.textContent || "")) : [];
          const b: any = btns[btns.length - 1]; if (!b) return false; b.click(); return true;
        });
        await sleep(500);
        if (!rm) await step(ctx, page, "running", `порожній рядок załącznika «${z.label}» не прибрався — Wydruk може не пройти, перевірте`);
      }
      await step(ctx, page, "running", `załącznik «${z.label}» не прикріпився — перевірте у Wydruku, за потреби додайте руками`);
    }
  }
  await snap(ctx, page, "form-zalaczniki");
}

// «Wydruk» порталу — офіційний друк заповненої форми (PDF): саме його людина бачить перед підписом.
// Портал може віддати PDF відповіддю, відкрити в новій вкладці або завантажити — ловимо всі три
// шляхи; без PDF — повний PNG сторінки як запасний варіант.
export async function captureWydruk(ctx: RobotCtx, page: Page): Promise<{ rel: string; mime: string }> {
  const fs = await import("node:fs"); const path = await import("node:path");
  const { UA_SUBMISSIONS_DIR } = await import("./submissions");
  const dir = path.join(UA_SUBMISSIONS_DIR, String(ctx.submissionId)); fs.mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  let pdf: Buffer | null = null;
  const onResp = async (r: any) => { try { const ct = String(r.headers()["content-type"] || ""); if (/pdf/i.test(ct) && !pdf) pdf = Buffer.from(await r.buffer()); } catch { /* ignore */ } };
  page.on("response", onResp);
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true } as any).catch(() => {});
  const browser = page.browser();
  const extraPages: Page[] = [];
  const onTarget = async (t: any) => { try { if (t.type() === "page") { const p = await t.page(); if (p) { extraPages.push(p); p.on("response", onResp); } } } catch { /* ignore */ } };
  browser.on("targetcreated", onTarget);
  try {
    await step(ctx, page, "running", "генерую Wydruk (PDF заповненої форми)");
    if (!(await clickByText(page, /^Wydruk$/i, { tags: "button" }))) throw new RobotError("Кнопка «Wydruk» недоступна — форма невалідна?", "form-wydruk");
    const deadline = Date.now() + 25_000;
    const newFile = () => fs.readdirSync(dir).map(f => path.join(dir, f)).filter(f => /\.pdf$/i.test(f) && fs.statSync(f).mtimeMs >= startedAt - 1000)[0];
    while (Date.now() < deadline && !pdf && !newFile()) await sleep(400);
    const out = path.join(dir, "wydruk.pdf");
    if (pdf) fs.writeFileSync(out, pdf);
    else { const f = newFile(); if (f && f !== out) fs.renameSync(f, out); }
    if (fs.existsSync(out)) return { rel: path.posix.join("ua-submissions", String(ctx.submissionId), "wydruk.pdf"), mime: "application/pdf" };
    await snap(ctx, page, "wydruk-fallback");
    const png = await page.screenshot({ fullPage: true, type: "png" });
    fs.writeFileSync(path.join(dir, "wydruk.png"), png);
    return { rel: path.posix.join("ua-submissions", String(ctx.submissionId), "wydruk.png"), mime: "image/png" };
  } finally {
    page.off("response", onResp); browser.off("targetcreated", onTarget);
    for (const p of extraPages) await p.close().catch(() => {});
    await client.detach().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
}

// «Zapisz dane» → schowek порталу (далі людина відкриває «Wczytaj dane → Ze schowka»)
export async function saveDraft(ctx: RobotCtx, page: Page): Promise<boolean> {
  await step(ctx, page, "running", "зберігаю чернетку на порталі (Zapisz dane)");
  if (!(await clickByText(page, /^Zapisz dane$/i, { tags: "button" }))) throw new RobotError("Нема кнопки «Zapisz dane»", "form-save");
  await sleep(800);
  // меню: «Zapis do schowka praca.gov.pl» | «Zapis do dokumentów roboczych»
  if (!(await clickByText(page, /Zapis do schowka/i, { tags: "[role=menuitem], button, a, span, div", timeoutMs: 5000 }))) throw new RobotError("У меню «Zapisz dane» нема «Zapis do schowka»", "form-save");
  const saved = await waitFor(page, async () => /zapisan|schowk/i.test(await pageText(page)) && !/Zapis do dokumentów roboczych/i.test(await pageText(page)), 10_000);
  await sleep(1000);
  await snap(ctx, page, saved ? "draft-saved" : "draft-save-unconfirmed");
  // модалка «Sukces — Formularz został pomyślnie zapisany» → OK, інакше вона перекриває «Dalej»
  await clickByText(page, /^OK$/i, { tags: ".cdk-overlay-container button, [role=dialog] button, button", timeoutMs: 2000 });
  await sleep(500);
  return saved;
}

// Діагностика: HTML контейнера навколо тексту → файл у папці подачі (без скріншота структури не видно)
async function dumpHtmlNear(ctx: RobotCtx, page: Page, re: RegExp, slug: string): Promise<void> {
  try {
    const html = await page.evaluate((src: string, flags: string) => {
      const rx = new RegExp(src, flags);
      const own = (x: any) => [...x.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join(" ");
      const leaves = [...document.querySelectorAll("label, mat-label, legend, span, div, p")].filter((x: any) => rx.test(own(x)) || (x.children.length === 0 && rx.test(x.textContent || ""))).slice(0, 4);
      return leaves.map((leaf: any) => { let anc: any = leaf; for (let i = 0; i < 3 && anc?.parentElement; i++) anc = anc.parentElement; return (anc?.outerHTML || "").slice(0, 5000); }).join("\n\n<!-- ===== next match ===== -->\n\n");
    }, re.source, re.flags);
    const fs = await import("node:fs"); const path = await import("node:path");
    const { UA_SUBMISSIONS_DIR } = await import("./submissions");
    const dir = path.join(UA_SUBMISSIONS_DIR, String(ctx.submissionId)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug.replace(/[^a-z0-9_-]+/gi, "_")}.html`), html);
  } catch { /* діагностика не має валити подачу */ }
}

// Розвідка кроку 3 «Wysłanie wniosku» (до появи автопідпису): після збереження чернетки натиснути
// «Dalej», зняти знімки й розмітку сторінки підпису, НІЧОГО не підписувати й не відправляти.
export async function exploreStep3(ctx: RobotCtx, page: Page): Promise<boolean> {
  await step(ctx, page, "running", "розвідка кроку 3 (Wysłanie wniosku): знімки для автопідпису, без підпису");
  const before = await pageText(page);
  if (!(await clickByText(page, /^Dalej$/i, { tags: "button:not([disabled])" }))) throw new RobotError("Нема активної кнопки «Dalej» на формі", "step3");
  // перехід підтверджуємо зміною сторінки: зникла секція даних cudzoziemca або змінився URL/текст
  // після «Dalej» портал повертається в кабінет (/eurzad/…) і довго малює крок 3 (спінер) —
  // чекаємо на змістовну сторінку: нема спінера, є кнопки/текст про підпис або відправку
  const moved = await waitStep3(page, before);
  await sleep(1500);
  await snap(ctx, page, moved ? "step3-top" : "step3-not-opened");
  if (!moved) { const errs = await formErrors(page); throw new RobotError(`Крок 3 не відкрився${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`, "step3"); }
  await dumpHtmlNear(ctx, page, /Wysłanie wniosku|Podpis|podpis/i, "step3");
  try {
    const fs = await import("node:fs"); const path = await import("node:path"); const { UA_SUBMISSIONS_DIR } = await import("./submissions");
    const dir = path.join(UA_SUBMISSIONS_DIR, String(ctx.submissionId)); fs.mkdirSync(dir, { recursive: true });
    const main = await page.evaluate(() => (document.querySelector("main") || document.body).outerHTML.slice(0, 200_000));
    fs.writeFileSync(path.join(dir, "step3-main.html"), main);
    fs.writeFileSync(path.join(dir, "step3-text.txt"), await pageText(page));
    const ctrls = await page.evaluate(() => [...document.querySelectorAll("button, a, input, mat-select, mat-radio-button, mat-checkbox")].filter((e: any) => e.getBoundingClientRect().width > 0).map((e: any) => [e.tagName, e.type || "", e.id || "", (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)].join(" | ")).join("\n"));
    fs.writeFileSync(path.join(dir, "step3-controls.txt"), ctrls);
  } catch { /* діагностика не валить подачу */ }
  const h = await page.evaluate(() => document.documentElement.scrollHeight as number);
  for (let y = 900, i = 2; y < h && i <= 5; y += 850, i++) { await page.evaluate((yy: number) => window.scrollTo(0, yy), y); await sleep(300); await snap(ctx, page, `step3-${i}`); }
  return true;
}

// Крок 3 «Wysłanie wniosku» (кабінет /eurzad): три плитки підпису з кнопками «Podpisz i wyślij».
// Індикатор таймера сесії має role=progressbar постійно — спінер НЕ перевіряємо, лише текст плиток.
async function waitStep3(page: Page, before: string): Promise<boolean> {
  return waitFor(page, async () => { const t = await pageText(page); return t !== before && !/2\. Dane cudzoziemca/i.test(t) && /Wysłanie wniosku/i.test(t) && /Podpisz i wyślij/i.test(t); }, 60_000);
}

// ── Етап 3: підпис profilem zaufanym і відправка ──────────────────────────────
// Крок 3 → плитка «Podpisz wniosek profilem zaufanym i wyślij» → pz.gov.pl (за потреби логін +
// SMS) → підтвердження підпису (код SMS) → повернення у кабінет, крок 4 «Podsumowanie» → PDF/UPP.
// Сторінки pz.gov.pl для підпису не зняті наперед: кожен крок робить знімок і падає з назвою
// кроку, якщо очікуваного елемента нема. Незворотний крок — підтвердження підпису на pz.gov.pl
// (зазвичай після коду SMS від людини); людина авторизує підпис рішенням «sign» на екрані Wydruk.
export interface SignResult { confirmationNo: string | null; file: { absPath: string; fileName: string; mime: string } | null; summaryText: string }
export async function signAndSend(ctx: RobotCtx, page: Page): Promise<SignResult> {
  await step(ctx, page, "signing", "крок 3: відкриваю «Wysłanie wniosku»");
  const before = await pageText(page);
  if (!(await clickByText(page, /^Dalej$/i, { tags: "button:not([disabled])" }))) throw new RobotError("Нема активної кнопки «Dalej» на формі", "sign-dalej");
  if (!(await waitStep3(page, before))) { await snap(ctx, page, "sign-step3-missing"); throw new RobotError("Крок 3 «Wysłanie wniosku» не відкрився", "sign-step3"); }
  await snap(ctx, page, "sign-step3");
  await step(ctx, page, "signing", "крок 3: обираю «Podpisz wniosek profilem zaufanym i wyślij»");
  const clicked = await page.evaluate(() => {
    const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const tiles = [...document.querySelectorAll("div, section, article, li")].filter((d: any) => vis(d) && /profilem zaufanym/i.test(d.textContent || "") && d.querySelector("button"));
    tiles.sort((a: any, b: any) => (a.textContent || "").length - (b.textContent || "").length);
    const btn = tiles[0]?.querySelector("button");
    if (!btn) return false; (btn as any).click(); return true;
  });
  if (!clicked) throw new RobotError("Не знайшов кнопку «Podpisz i wyślij» у плитці profilu zaufanego", "sign-tile");
  await Promise.race([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), sleep(20_000)]);
  await sleep(2000);
  await snap(ctx, page, "sign-after-tile");
  // можлива проміжна сторінка/діалог підтвердження в кабінеті
  await clickByText(page, /^(Tak|Potwierdź|Dalej|Kontynuuj)$/i, { tags: ".cdk-overlay-container button", timeoutMs: 1500 });

  // pz.gov.pl: логін (якщо сесії нема) → сторінка підпису
  let deadline = Date.now() + 90_000; // після вводу коду дедлайн переставляється — очікування людини його не зʼїдає
  let signedBack = false;
  const isSummaryOk = (t: string) => /Podsumowanie/i.test(t) && /(został[ao]? (wysłan|złożon|przekazan)|Urzędowe Poświadczenie|UPP|przyjęt|wysłano)/i.test(t) && !/nie został|nie udało|niepowodzen|błąd|błędn|odrzucon/i.test(t);
  while (Date.now() < deadline) {
    const url = page.url(); const t = await pageText(page);
    if (/praca\.gov\.pl/i.test(url) && isSummaryOk(t)) { signedBack = true; break; }
    if (/pz\.gov\.pl|login\.gov\.pl/i.test(url)) {
      if (/login\.gov\.pl/i.test(url)) { await clickByText(page, /Profil zaufany/i, { tags: "button.wds-action-tile, button, a" }); await sleep(3000); continue; }
      if (await page.$("input#password")) {
        await step(ctx, page, "signing", "pz.gov.pl: повторний вхід для підпису");
        const cred = pzCredentials(ctx.account);
        await typeInto(page, "input#username", cred.login); await typeInto(page, "input#password", cred.password);
        if (!(await clickByText(page, /^Zaloguj( się)?$/i, { tags: "button[type=submit], button" }))) await page.keyboard.press("Enter");
        await sleep(3000); continue;
      }
      const codeSel = await findCodeInput(page, 3000);
      if (codeSel) {
        await snap(ctx, page, "sign-code-page");
        const codeP = waitForCode(ctx.submissionId, ctx.adminId); codeP.catch(() => {});
        await step(ctx, page, "awaiting_code", "підпис: чекаю код SMS profilu zaufanego від власника акаунта");
        await ctx.onAwaitCode(ctx, "sign");
        const code = await codeP;
        await step(ctx, page, "signing", "підпис: вводжу код SMS");
        await typeInto(page, codeSel, code);
        if (!(await clickByText(page, /^(Potwierdź|Podpisz|Zaloguj( się)?|Dalej|Autoryzuj)/i, { tags: ".cdk-overlay-container button, button[type=submit], button" }))) await page.keyboard.press("Enter");
        await sleep(4000); await snap(ctx, page, "sign-after-code");
        deadline = Date.now() + 90_000;
        const t2 = await pageText(page);
        if (/pz\.gov\.pl/i.test(page.url()) && /nieprawidłow|błędn|niepoprawn|nieważn/i.test(t2)) throw new RobotError("pz.gov.pl не прийняв код SMS підпису", "sign-code");
        continue;
      }
      // сторінка підпису без поля коду: кнопка «Podpisz podpisem zaufanym» / «Podpisz»
      if (await clickByText(page, /Podpisz podpisem zaufanym|^Podpisz$|Podpisz dokument|Podpisz i wyślij/i, { tags: "button, a", timeoutMs: 1500 })) { await snap(ctx, page, "sign-pz-clicked"); await sleep(3000); continue; }
      await clickByText(page, /^(Dalej|Kontynuuj|Potwierdź)$/i, { tags: "button, a", timeoutMs: 1500 });
      await sleep(2000); continue;
    }
    await sleep(1500);
  }
  await snap(ctx, page, signedBack ? "sign-summary" : "sign-timeout");
  if (!signedBack) throw new RobotError(`Підпис не завершився: ${page.url()}`, "sign-return");

  // крок 4: Podsumowanie — потвердження (UPP/PDF) і номер
  await step(ctx, page, "signing", "крок 4: забираю потвердження");
  const summaryText = await pageText(page);
  const m = summaryText.match(/(?:Numer sprawy|Numer dokumentu|Identyfikator dokumentu|Nr dokumentu|Numer UPP|Identyfikator)[^:0-9A-Z]*[:\s]+([A-Z0-9][A-Z0-9\/\-.]{4,})/i);
  const confirmationNo = m?.[1] ?? null;
  const file = await captureSummaryPdf(ctx, page).catch(() => null);
  return { confirmationNo, file, summaryText: summaryText.slice(0, 4000) };
}

// Потвердження з «Podsumowanie»: клік по лінку/кнопці UPP/Pobierz → PDF із відповіді або завантаження;
// без нього — PNG усієї сторінки підсумку (теж документ-доказ).
async function captureSummaryPdf(ctx: RobotCtx, page: Page): Promise<{ absPath: string; fileName: string; mime: string }> {
  const fs = await import("node:fs"); const path = await import("node:path");
  const { UA_SUBMISSIONS_DIR } = await import("./submissions");
  const dir = path.join(UA_SUBMISSIONS_DIR, String(ctx.submissionId)); fs.mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  let pdf: Buffer | null = null;
  const onResp = async (r: any) => { try { const ct = String(r.headers()["content-type"] || ""); if (/pdf/i.test(ct) && !pdf) pdf = Buffer.from(await r.buffer()); } catch { /* ignore */ } };
  page.on("response", onResp);
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true } as any).catch(() => {});
  const extra: Page[] = []; const browser = page.browser();
  const onTarget = async (t: any) => { try { if (t.type() === "page") { const p = await t.page(); if (p) { extra.push(p); p.on("response", onResp); } } } catch { /* ignore */ } };
  browser.on("targetcreated", onTarget);
  try {
    await clickByText(page, /UPP|Urzędowe Poświadczenie|Pobierz potwierdzenie|Pobierz dokument|Pobierz wniosek|Pobierz/i, { tags: "a, button", timeoutMs: 4000 });
    const stamp = String(startedAt);
    const newFile = () => fs.readdirSync(dir).map(f => path.join(dir, f)).filter(f => /\.(pdf|xml)$/i.test(f) && !/wydruk|PSZ-PPWPU\.pdf$|potwierdzenie-/i.test(f) && fs.statSync(f).mtimeMs >= startedAt - 1000)[0];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !pdf && !newFile()) await sleep(400);
    // лише свіжий файл цього прогону (ім'я зі штампом), формат зберігаємо: XML не видаємо за PDF
    if (pdf) { const out = path.join(dir, `potwierdzenie-${stamp}.pdf`); fs.writeFileSync(out, pdf); return { absPath: out, fileName: "powiadomienie-potwierdzenie.pdf", mime: "application/pdf" }; }
    const f = newFile();
    if (f) { const ext = /\.xml$/i.test(f) ? "xml" : "pdf"; const out = path.join(dir, `potwierdzenie-${stamp}.${ext}`); fs.renameSync(f, out); return { absPath: out, fileName: `powiadomienie-potwierdzenie.${ext}`, mime: ext === "xml" ? "application/xml" : "application/pdf" }; }
    const png = path.join(dir, `podsumowanie-${stamp}.png`);
    fs.writeFileSync(png, await page.screenshot({ fullPage: true, type: "png" }));
    return { absPath: png, fileName: "powiadomienie-podsumowanie.png", mime: "image/png" };
  } finally {
    page.off("response", onResp); browser.off("targetcreated", onTarget);
    for (const p of extra) await p.close().catch(() => {});
    await client.detach().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
}

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function waitFor(page: Page, pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred().catch(() => false)) return true; await sleep(700); }
  void page; return false;
}
declare const window: any;
