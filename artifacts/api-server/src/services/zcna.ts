// ZUS ZCNA — зголошення членів родини до ubezpieczenia zdrowotnego (рішення власника 10.09.2026):
// ЛИШЕ на окреме прохання працівника, не всім. Потік:
//   1) офіс з профілю → «Запросити анкету ZCNA» → токен-лінк /zcna/:token у бот працівника
//      (passport_scan_tokens.purpose='zcna', 30 днів); працівник вписує членів родини
//      (поля бланка ZUS ZCNA, розділи IV/V) → worker_family_members (заміна списку);
//   2) офіс → «Згенерувати ZCNA» → документ з шаблону kind='zcna' (розділи бланка + таблиця
//      членів через {%Członkowie rodziny format:html%}), печатка фірми на чернетку → одразу на
//      підпис працівнику (VII), після підпису фірма підписує автоматично; паралельно задача
//      виконавцю ZUS (правило zcna_file, фолбек як у ZWUA): подати в Płatnik, внести
//      підтвердження (тип zus_zcna) — задача закривається, коли документ зʼявився.
import { db, workersTable, workerFamilyMembersTable, workerQuestionnairesTable, companiesTable, passportScanTokensTable, contractsTable, tasksTable, workerDocumentsTable, documentTypesTable } from "@workspace/db";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { randomInviteCode } from "../lib/invite";
import { addDaysStr } from "../lib/dates";
import { createTask, resolveAssignee, warsawToday, dateStr, mdEsc, OPEN_STATUSES } from "./tasks";
import { normalizeChecklist } from "./taskUtils";
import { generateContract, stampDraftWithCompany, sendContractForSignature, DATA_AUTO_FINALIZE } from "./contracts";
import { pickEventTemplate } from "./contractEndDocs";
import { bot } from "../bot/instance";
import { t as tw, asLang } from "../bot/i18n";
import { notifyAdminById } from "../bot/notify";
import { logger } from "../lib/logger";

export const ZCNA_KIND = "zcna";
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

// Kod stopnia pokrewieństwa / powinowactwa (ZUS ZCNA, pole IV.10)
export const ZCNA_RELATION_CODES: { code: string; pl: string }[] = [
  { code: "01", pl: "małżonek" },
  { code: "11", pl: "dziecko własne, przysposobione lub dziecko małżonka" },
  { code: "21", pl: "wnuk albo dziecko obce (opieka / rodzina zastępcza)" },
  { code: "30", pl: "matka" }, { code: "31", pl: "ojciec" }, { code: "32", pl: "macocha" }, { code: "33", pl: "ojczym" },
  { code: "40", pl: "babka" }, { code: "41", pl: "dziadek" },
  { code: "60", pl: "inny członek rodziny" },
];
// Kod stopnia niepełnosprawności (pole IV.12): порожньо = brak
export const ZCNA_DISABILITY_CODES: { code: string; pl: string }[] = [
  { code: "", pl: "brak" }, { code: "1", pl: "znaczny" }, { code: "2", pl: "umiarkowany" }, { code: "3", pl: "lekki" },
];

export interface FamilyMemberInput {
  action?: "zgloszenie" | "wyrejestrowanie"; rightsDate?: string | null; pesel?: string | null; docKind?: string | null; docNumber?: string | null;
  lastName: string; firstName: string; birthDate?: string | null; relationCode: string; sharedHousehold?: boolean; disabilityCode?: string | null;
  addressDiffers?: boolean; postalCode?: string | null; city?: string | null; gmina?: string | null; street?: string | null; houseNo?: string | null; flatNo?: string | null; phone?: string | null; countryCode?: string | null; foreignPostal?: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LATIN = /^[A-Za-zÀ-ÖØ-öø-ÿĀ-žŁłŚśŻżŹźĆćŃńÓóĄąĘę' -]{1,80}$/;
function peselValid(p: string): boolean {
  if (!/^\d{11}$/.test(p)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = w.reduce((acc, wi, i) => acc + wi * Number(p[i]), 0);
  return (10 - (sum % 10)) % 10 === Number(p[10]);
}
// Повертає код помилки (для клієнта) або null. Правила — з бланка: прізвище/імʼя латиницею, код
// спорідненості зі списку, PESEL з контрольною сумою АБО тип+номер документа, дата народження ISO.
export function validateMember(m: FamilyMemberInput): string | null {
  if (!m || typeof m !== "object") return "member";
  // JSON з публічної форми: кожне текстове поле мусить бути рядком (число/обʼєкт → помилка, не TypeError)
  for (const k of ["lastName", "firstName", "relationCode", "pesel", "docKind", "docNumber", "birthDate", "rightsDate", "disabilityCode", "postalCode", "city", "gmina", "street", "houseNo", "flatNo", "phone", "countryCode", "foreignPostal", "action"] as const) {
    const v = (m as unknown as Record<string, unknown>)[k];
    if (v != null && typeof v !== "string") return k;
  }
  if (!m.lastName?.trim() || !LATIN.test(m.lastName.trim())) return "lastName";
  if (!m.firstName?.trim() || !LATIN.test(m.firstName.trim())) return "firstName";
  if (!ZCNA_RELATION_CODES.some(r => r.code === m.relationCode)) return "relationCode";
  if (m.action && !["zgloszenie", "wyrejestrowanie"].includes(m.action)) return "action";
  const pesel = (m.pesel ?? "").trim();
  if (pesel) { if (!peselValid(pesel)) return "pesel"; }
  else if (!(m.docKind === "1" || m.docKind === "2") || !(m.docNumber ?? "").trim()) return "document";
  if (m.birthDate && !ISO.test(m.birthDate)) return "birthDate";
  if (!m.birthDate && !pesel) return "birthDate";
  if (m.rightsDate && !ISO.test(m.rightsDate)) return "rightsDate";
  if (m.disabilityCode && !ZCNA_DISABILITY_CODES.some(d => d.code === m.disabilityCode)) return "disabilityCode";
  if (m.addressDiffers && !(m.city ?? "").trim()) return "city";
  return null;
}

export async function listFamily(workerId: number) {
  return db.select().from(workerFamilyMembersTable).where(eq(workerFamilyMembersTable.workerId, workerId)).orderBy(workerFamilyMembersTable.id);
}

// Заміна списку цілком (анкета працівника / редагування офісом). Валідація — до запису, помилка з індексом.
export async function replaceFamily(workerId: number, members: FamilyMemberInput[], source: "worker" | "office"): Promise<{ count: number }> {
  if (members.length > 10) throw new Error("Забагато членів родини (максимум 10)");
  for (const [i, m] of members.entries()) { const err = validateMember(m); if (err) throw Object.assign(new Error(`Помилка в члені родини №${i + 1}: ${err}`), { field: err, index: i }); }
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM workers WHERE id = ${workerId} FOR UPDATE`); // серіалізація паралельних PUT/POST одного працівника (ревʼю 10.09)
    await tx.delete(workerFamilyMembersTable).where(eq(workerFamilyMembersTable.workerId, workerId));
    if (members.length) await tx.insert(workerFamilyMembersTable).values(members.map(m => ({
      workerId, action: m.action ?? "zgloszenie", rightsDate: m.rightsDate || null, pesel: (m.pesel ?? "").trim() || null,
      docKind: (m.pesel ?? "").trim() ? null : m.docKind ?? null, docNumber: (m.pesel ?? "").trim() ? null : (m.docNumber ?? "").trim() || null,
      lastName: m.lastName.trim(), firstName: m.firstName.trim(), birthDate: m.birthDate || null, relationCode: m.relationCode,
      sharedHousehold: m.sharedHousehold ?? true, disabilityCode: m.disabilityCode || null, addressDiffers: !!m.addressDiffers,
      postalCode: m.addressDiffers ? m.postalCode ?? null : null, city: m.addressDiffers ? m.city ?? null : null, gmina: m.addressDiffers ? m.gmina ?? null : null,
      street: m.addressDiffers ? m.street ?? null : null, houseNo: m.addressDiffers ? m.houseNo ?? null : null, flatNo: m.addressDiffers ? m.flatNo ?? null : null,
      phone: m.addressDiffers ? m.phone ?? null : null, countryCode: m.addressDiffers ? m.countryCode ?? null : null, foreignPostal: m.addressDiffers ? m.foreignPostal ?? null : null,
      source, updatedAt: new Date(),
    })));
  });
  return { count: members.length };
}

// ── Запрошення анкети (токен-лінк у бот) ────────────────────────────────────────────
export async function createZcnaInvite(workerId: number, adminId: number | null): Promise<{ link: string | null; notified: boolean; token: string }> {
  const [w] = await db.select({ id: workersTable.id, telegramId: workersTable.telegramId, language: workersTable.language, isActive: workersTable.isActive }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) throw new Error("Працівника не знайдено");
  if (!w.isActive) throw new Error("Працівник звільнений");
  const token = randomInviteCode(24);
  await db.insert(passportScanTokensTable).values({ token, purpose: "zcna", workerId, language: w.language ?? null, createdBy: adminId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) });
  const base = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
  const link = base ? `${base}/zcna/${token}` : null;
  let notified = false;
  if (w.telegramId && link) {
    try { await bot.telegram.sendMessage(w.telegramId, tw(asLang(w.language), "zcna.invite", { link })); notified = true; } catch { notified = false; }
  }
  return { link, notified, token };
}

export async function loadZcnaToken(token: string) {
  const [row] = await db.select().from(passportScanTokensTable).where(and(eq(passportScanTokensTable.token, token), eq(passportScanTokensTable.purpose, "zcna")));
  if (!row || !row.workerId) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  const [w] = await db.select({ isActive: workersTable.isActive }).from(workersTable).where(eq(workersTable.id, row.workerId));
  if (!w?.isActive) return null; // звільнений — лінк недійсний
  return row;
}

// Працівник надіслав анкету → зберегти й повідомити того, хто запрошував (або головного)
export async function submitZcnaForm(token: string, members: FamilyMemberInput[]): Promise<{ count: number }> {
  const row = await loadZcnaToken(token);
  if (!row) throw new Error("Лінк недійсний або прострочений");
  if (!members.length) throw Object.assign(new Error("Додайте хоча б одного члена родини"), { field: "members", index: 0 });
  // офіс уже згенерував документ на підпис — правити список пізно (PDF став би неактуальним)
  const [pendingDoc] = await db.select({ id: contractsTable.id }).from(contractsTable).where(and(eq(contractsTable.workerId, row.workerId!),
    sql`${contractsTable.data}->>'_zcna' = '1'`, inArray(contractsTable.status, ["draft", "pending_approval", "approved", "sent", "viewed", "worker_signed"]))).limit(1);
  if (pendingDoc) throw new Error("Документ ZCNA вже підготовлено — зміни повідомте офісу");
  const r = await replaceFamily(row.workerId!, members, "worker");
  const firstSubmit = !row.usedAt; // лінк багаторазовий (виправити помилку) — офіс сповіщаємо лише про ПЕРШЕ надсилання
  await db.update(passportScanTokensTable).set({ usedAt: new Date() }).where(eq(passportScanTokensTable.id, row.id));
  const [w] = await db.select({ fullName: workersTable.fullName, telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, row.workerId!));
  if (w?.telegramId && firstSubmit) bot.telegram.sendMessage(w.telegramId, tw(asLang(w.language), "zcna.thanks")).catch(() => {});
  if (firstSubmit) {
    const base = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
    const to = row.createdBy ?? (await resolveAssignee({ factoryId: null, ruleCode: "zcna_file" }));
    if (to) await notifyAdminById(to, "tasks", `👨‍👩‍👧 *Анкета ZCNA заповнена*: ${mdEsc(w?.fullName ?? "")} — ${r.count} ос. Згенеруй документ у профілі${base ? `: ${base}/workers/${row.workerId}` : ""}`, { parse_mode: "Markdown" }).catch(() => {});
  }
  return r;
}

// ── Генерація документа ZCNA + задача виконавцю ZUS ──────────────────────────────────
const esc = (s: string | null | undefined) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pl = (iso: string | null | undefined) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ""); return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; };
function membersHtml(rows: typeof workerFamilyMembersTable.$inferSelect[]): string {
  const th = (s: string) => `<th style="border:1px solid #999;padding:3px 4px;font-size:8pt;text-align:left;background:#f3f3f3;">${s}</th>`;
  const td = (s: string) => `<td style="border:1px solid #999;padding:3px 4px;font-size:8.5pt;vertical-align:top;">${s}</td>`;
  const head = ["Lp.", "01. Zgł./Wyrej.", "02. Data uprawnień", "03. PESEL", "05–06. Dokument", "07. Nazwisko", "08. Imię", "09. Data ur.", "10. Kod pokr.", "11. Wsp. gosp.", "12. Niepełn.", "B. Adres (jeśli inny)"].map(th).join("");
  const body = rows.map((m, i) => {
    const rel = ZCNA_RELATION_CODES.find(r => r.code === m.relationCode);
    const addr = m.addressDiffers ? [m.postalCode, m.city, m.gmina ? `gm. ${m.gmina}` : "", m.street ? `ul. ${m.street} ${m.houseNo ?? ""}${m.flatNo ? `/${m.flatNo}` : ""}` : "", m.countryCode ? `(${m.countryCode} ${m.foreignPostal ?? ""})` : "", m.phone ? `tel. ${m.phone}` : ""].filter(Boolean).join(", ") : "—";
    return `<tr>${[String(i + 1), m.action === "wyrejestrowanie" ? "2 (wyrejestrowanie)" : "1 (zgłoszenie)", pl(dateStr(m.rightsDate)), m.pesel ?? "—",
      m.pesel ? "—" : `${m.docKind === "1" ? "dowód (1)" : "paszport (2)"} ${m.docNumber ?? ""}`, m.lastName, m.firstName, pl(dateStr(m.birthDate)),
      `${m.relationCode}${rel ? ` — ${rel.pl}` : ""}`, m.sharedHousehold ? "X" : "", m.disabilityCode || "—", addr].map(esc).map(td).join("")}</tr>`;
  }).join("");
  return `<table style="width:100%;border-collapse:collapse;margin:6px 0 10px 0;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export async function generateZcnaDocument(workerId: number, adminId: number | null): Promise<{ contractId: number; link: string | null; notified: boolean; taskId: number | null }> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) throw new Error("Працівника не знайдено");
  const members = await listFamily(workerId);
  if (!members.length) throw new Error("Немає членів родини — спершу анкета ZCNA (або додайте вручну)");
  const tpl = await pickEventTemplate(ZCNA_KIND, null, w.companyId ?? null);
  if (!tpl) throw new Error("Немає активного шаблону «ZUS ZCNA» у бібліотеці");
  const [pending] = await db.select({ id: contractsTable.id }).from(contractsTable).where(and(eq(contractsTable.workerId, workerId),
    sql`${contractsTable.data}->>'_zcna' = '1'`, inArray(contractsTable.status, ["draft", "pending_approval", "approved", "sent", "viewed", "worker_signed"]))).limit(1);
  if (pending) throw new Error("ZCNA уже надіслано на підпис — дочекайтесь підпису або скасуйте попередній");
  // Замок і ідемпотентність (ревʼю 10.09): задача виконавцю ZUS створюється ПЕРШОЮ з unique source_key
  // на працівника (`zcna:w<id>`); паралельний виклик впаде на дублі, збій генерації прибирає задачу,
  // а документ без задачі неможливий.
  const assignee = await resolveAssignee({ factoryId: null, ruleCode: "zcna_file" });
  let task: { id: number };
  try {
    task = await createTask({
      kind: "task", title: `ZUS ZCNA — подати зголошення родини: ${w.fullName} (${members.length} ос.)`, priority: "normal", dueAt: addDaysStr(warsawToday(), 7),
      assigneeAdminId: assignee, workerId, source: "auto:zcna_file", sourceKey: `zcna:w${workerId}`,
      autoParams: { workerName: w.fullName, members: members.length, docTypeCode: "zus_zcna" },
      checklist: normalizeChecklist([
        { id: "", text: "Дочекатись підпису працівника (документ у профілі → «підписано»)", done: false },
        { id: "", text: "Подати ZUS ZCNA у Płatnik / PUE ZUS", done: false },
        { id: "", text: "Внести підтвердження ZCNA в профіль", done: false, auto: "entered" },
      ]),
      notify: false,
    }, adminId);
  } catch (e: any) {
    const [open] = await db.select({ id: tasksTable.id, status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.sourceKey, `zcna:w${workerId}`));
    if (open && OPEN_STATUSES.includes(open.status as any)) throw new Error("ZCNA для цього працівника вже в роботі (відкрита задача ZUS) — закрийте її або дочекайтесь підтвердження");
    // стара закрита задача з тим самим ключем — звільнити ключ і спробувати ще раз
    if (open) { await db.update(tasksTable).set({ sourceKey: `zcna:w${workerId}:${open.id}` }).where(eq(tasksTable.id, open.id)); return generateZcnaDocument(workerId, adminId); }
    throw e;
  }
  let docId: number | null = null;
  try {
    const [q] = await db.select({ dowod: workerQuestionnairesTable.seriaINumerDowodu, passport: workerQuestionnairesTable.passportNumber }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
    const [co] = w.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, w.companyId)) : [];
    const docKind = q?.dowod ? "1" : q?.passport ? "2" : "";
    const doc = await generateContract({
      workerId, factoryId: null, companyId: w.companyId ?? null, templateIds: [tpl.id], allowUnverified: true,
      extraData: {
        "Członkowie rodziny": membersHtml(members),
        "Rodzaj dokumentu ZCNA": docKind, "Seria i numer dokumentu ZCNA": q?.dowod ?? q?.passport ?? "",
        "Nazwa skrócona płatnika": co?.name ?? "",
        "Liczba członków rodziny": String(members.length),
      },
    });
    docId = doc.id;
    await db.update(contractsTable).set({ data: sql`${contractsTable.data} || ${JSON.stringify({ [DATA_AUTO_FINALIZE]: "1", _zcna: "1" })}::jsonb`, updatedAt: new Date() }).where(eq(contractsTable.id, doc.id));
    await stampDraftWithCompany(doc.id, adminId); // pieczątka płatnika (VI.03) одразу
    const r = await sendContractForSignature(doc.id, adminId, { bundle: false });
    await db.update(tasksTable).set({ contractId: doc.id, autoParams: sql`${tasksTable.autoParams} || ${JSON.stringify({ contractId: doc.id })}::jsonb`, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
    if (assignee) await notifyAdminById(assignee, "tasks", `👨‍👩‍👧 *ZUS ZCNA* — ${mdEsc(w.fullName)} (${members.length} ос.): документ надіслано працівнику на підпис; після підпису подай у Płatnik (задача)`, { parse_mode: "Markdown" }).catch(() => {});
    logger.info({ contractId: doc.id, workerId, members: members.length, notified: r.notified, taskId: task.id }, "zcna document sent for signature");
    return { contractId: doc.id, link: r.link, notified: r.notified, taskId: task.id };
  } catch (e) {
    // збій на будь-якому кроці → чернетку скасувати (не блокує повтор), задачу-замок прибрати
    if (docId) await db.update(contractsTable).set({ status: "cancelled", declineReason: "ZCNA: збій генерації/відправки", updatedAt: new Date() }).where(eq(contractsTable.id, docId)).catch(() => {});
    await db.delete(tasksTable).where(eq(tasksTable.id, task.id)).catch(() => {});
    throw e;
  }
}

// Для taskAutoRules: відкриті задачі zcna_file живуть, поки в профілі нема документа zus_zcna,
// внесеного після створення задачі (тоді кандидат зникає → auto_resolved).
export async function openZcnaTasksStillPending(): Promise<{ sourceKey: string; task: typeof tasksTable.$inferSelect }[]> {
  const open = await db.select().from(tasksTable).where(and(eq(tasksTable.source, "auto:zcna_file"), inArray(tasksTable.status, OPEN_STATUSES)));
  if (!open.length) return [];
  const [ty] = await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, "zus_zcna"));
  const out: { sourceKey: string; task: typeof tasksTable.$inferSelect }[] = [];
  for (const t of open) {
    if (!t.sourceKey || !t.workerId) continue;
    const [doc] = ty ? await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, t.workerId), eq(workerDocumentsTable.docTypeId, ty.id), ne(workerDocumentsTable.status, "missing"), gt(workerDocumentsTable.createdAt, t.createdAt))).limit(1) : [];
    if (!doc) out.push({ sourceKey: t.sourceKey, task: t });
  }
  return out;
}
