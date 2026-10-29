// Експорт даних працівників (28.10.2026, прохання власника): один набір фільтрів
// (статус / фірми / міста / фабрики / посади / форма легалізації / національність /
// студент до 26 / легалізація за документами / умова / дати / анкета / документи / пошук)
// для трьох виходів і превʼю-списку в модалці:
//   • Excel-список з вибором колонок (польські заголовки, імена КАПСОМ — як усі згенеровані
//     таблиці; колонки документів — по типу: статус + номер + «ważny do»);
//   • CSV для імпорту в Gratyfikant nexo — колонки 1:1 як у вивантаженні
//     «Eksport - Umowy» (зразок від księgowej 22.10.2026), імена mixed case «Nazwisko Imię»
//     (файл для точного матчингу, НЕ nameCaps — як gratyfikantExport.ts);
//   • ZIP документів: <Firma>/<Fabryka>/<Nazwisko Imię (kod)>/<файли> (+ підписані умови в
//     підпапці Umowy) — стрім через archiver, без збирання в памʼяті.
// Фільтри застосовуються тут (у JS по завантаженому набору — людей сотні, не мільйони);
// скоуп адміна — workerInScopeSql у SELECT (скоуп-адмін бачить лише своїх).
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import archiver from "archiver";
import type { Response } from "express";
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  db, workersTable, factoriesTable, companiesTable, positionsTable, factoryPositionsTable, workerFactoriesTable,
  workerQuestionnairesTable, workerLegalityTable, workerDocumentsTable, documentTypesTable, contractsTable, contractFilesTable, documentTemplatesTable,
} from "@workspace/db";
import { workerInScopeSql, factoryInScope, type AdminScope } from "../lib/scope";
import { effectiveView } from "./effectiveStatus";
import { normalizeProfileLegal } from "./svodni";
import { isUnder26 } from "./svodniSync";
import { citizenshipZus, COUNTRIES } from "../lib/countries";
import { UPLOADS_ROOT } from "../lib/uploads";
import { nameCaps } from "./drive";
import { warsawToday as warsawDateStr } from "./taskUtils";
import { normalizeName, nameScore } from "../bot/workerMatch";
import { addDaysStr } from "../lib/dates";
import { logger } from "../lib/logger";

export type ExportMode = "active" | "fired" | "blacklist" | "all";
type YesNo = "" | "yes" | "no";
export interface ExportFilters {
  mode: ExportMode;
  factoryIds: number[]; companyIds: number[]; positionIds: number[]; cities: string[];
  legal: string; nationality: string; stud26: boolean; docLeg: string; umowa: string; q: string;
  gender: "" | "male" | "female"; telegram: YesNo;
  // дати (YYYY-MM-DD, включно; порожньо = без межі)
  firstWorkFrom: string; firstWorkTo: string; firedFrom: string; firedTo: string; startFrom: string; startTo: string;
  birthFrom: string; birthTo: string; termFrom: string; termTo: string; umowaToFrom: string; umowaToTo: string; createdFrom: string; createdTo: string;
  // анкета
  anketa: "" | "yes" | "no" | "verified"; pesel: YesNo; bank: YesNo; phone: YesNo; email: YesNo; nip: YesNo;
  qCity: string; qTaxOffice: string; qNfz: string;
  // документи: є документ типу (у стані docState) / нема документа типу / номер містить
  docHasTypeIds: number[]; docNoTypeIds: number[]; docState: "" | "present" | "expired" | "expiring" | "pending" | "nofile"; docExpiringDays: number; docNumber: string;
}

const nums = (v: unknown): number[] => String(v ?? "").split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
const strs = (v: unknown): string[] => String(v ?? "").split(",").map(s => s.trim()).filter(Boolean);
const date = (v: unknown): string => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : "";
const yn = (v: unknown): YesNo => v === "yes" || v === "no" ? v : "";
const str = (v: unknown) => String(v ?? "").trim();

/** Фільтри з query (усі необовʼязкові; списки — через кому). */
export function parseExportFilters(q: Record<string, unknown>): ExportFilters {
  const mode = ["active", "fired", "blacklist", "all"].includes(String(q.mode)) ? String(q.mode) as ExportMode : "active";
  return {
    mode, factoryIds: nums(q.factoryIds), companyIds: nums(q.companyIds), positionIds: nums(q.positionIds), cities: strs(q.cities),
    legal: str(q.legal), nationality: str(q.nationality), stud26: q.stud26 === "1" || q.stud26 === "true",
    docLeg: str(q.docLeg), umowa: str(q.umowa), q: str(q.q),
    gender: q.gender === "male" || q.gender === "female" ? q.gender : "", telegram: yn(q.telegram),
    firstWorkFrom: date(q.firstWorkFrom), firstWorkTo: date(q.firstWorkTo), firedFrom: date(q.firedFrom), firedTo: date(q.firedTo),
    startFrom: date(q.startFrom), startTo: date(q.startTo), birthFrom: date(q.birthFrom), birthTo: date(q.birthTo),
    termFrom: date(q.termFrom), termTo: date(q.termTo), umowaToFrom: date(q.umowaToFrom), umowaToTo: date(q.umowaToTo), createdFrom: date(q.createdFrom), createdTo: date(q.createdTo),
    anketa: ["yes", "no", "verified"].includes(String(q.anketa)) ? String(q.anketa) as ExportFilters["anketa"] : "",
    pesel: yn(q.pesel), bank: yn(q.bank), phone: yn(q.phone), email: yn(q.email), nip: yn(q.nip),
    qCity: str(q.qCity), qTaxOffice: str(q.qTaxOffice), qNfz: str(q.qNfz),
    docHasTypeIds: nums(q.docHasTypeIds), docNoTypeIds: nums(q.docNoTypeIds),
    docState: ["present", "expired", "expiring", "pending", "nofile"].includes(String(q.docState)) ? String(q.docState) as ExportFilters["docState"] : "",
    docExpiringDays: Math.max(1, Math.min(365, Number(q.docExpiringDays) || 30)), docNumber: str(q.docNumber),
  };
}

export interface ExportDoc { id: number; typeId: number | null; typeName: string; code: string | null; title: string; number: string | null; status: string; issuedAt: string | null; expiresAt: string | null; hasFile: boolean; employerCompanyId: number | null }
export interface ExportRow {
  id: number; fullName: string; firstName: string | null; middleName: string | null; lastName: string | null; gratyfikantName: string | null;
  code: string | null; gender: string | null; birthDate: string | null; nationality: string | null; pesel: string | null; language: string | null;
  telegram: boolean; status: "active" | "fired" | "blacklist"; firedAt: string | null; firstWorkDate: string | null; employmentStartDate: string | null; createdAt: string | null;
  doNotHireReason: string | null; terminationDate: string | null;
  companyId: number | null; companyName: string | null; factoryId: number | null; factoryName: string | null; city: string | null; factoryCompanyName: string | null;
  extraFactories: string[]; extraFactoryIds: number[]; positionName: string | null; kzisCode: string | null;
  legalStatus: string | null; effectiveLegalStatus: string | null; legalSource: string; student: boolean; stud26: boolean;
  legality: { overall: string; stay: string | null; work: string | null; nextExpiryAt: string | null } | null;
  umowa: { status: string; dateFrom: string | null; dateTo: string | null; signedAt: string | null; companySignedAt: string | null; sentAt: string | null; factoryName: string | null; companyName: string | null; payoutMethod: string | null; expired: boolean; terminationDate: string | null; terminationBy: string | null } | null;
  contracts: { status: string; dateFrom: string | null; dateTo: string | null; factoryName: string | null; companyName: string | null; concludedAt: string | null }[]; // усі живі umowy людини
  q: typeof workerQuestionnairesTable.$inferSelect | null;
  passport: { number: string | null; issuedAt: string | null; expiresAt: string | null } | null;
  docs: ExportDoc[];
  note: string | null;
}

// date-колонки приходять рядком, timestamp — Date у настінному Warsaw (TZ процесу) → локальні гетери, не toISOString
const dstr = (d: unknown): string | null => d == null ? null
  : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  : String(d).slice(0, 10);
const has = (v: string | null | undefined) => !!v && v.trim() !== "";
const inRange = (v: string | null, from: string, to: string) => (!from && !to) || (!!v && (!from || v >= from) && (!to || v <= to));
const contains = (hay: string | null | undefined, needle: string) => !needle || (!!hay && hay.toLowerCase().includes(needle.toLowerCase()));
const matchesQ = (q: string, fullName: string, ...vals: (string | null | undefined)[]): boolean => {
  // normalizeName — транслітерація + зняття діакритики (bot/workerMatch); кирилиця транслітерується
  // неоднозначно («Сидорчук» → sidorcuk ≠ sydorchuk), тож для неї — нечіткий nameScore, як у матчингу водія
  if (/[\u0400-\u04FF]/.test(q)) return nameScore(q, fullName) >= 0.7 || vals.some(v => v && nameScore(q, v) >= 0.7);
  const words = normalizeName(q).split(/\s+/).filter(Boolean);
  const hay = normalizeName([fullName, ...vals].filter(Boolean).join(" "));
  return words.every(w => hay.includes(w));
};

/** Завантажити й відфільтрувати працівників (скоуп адміна — у SELECT). */
export async function loadExportRows(f: ExportFilters, scope: AdminScope | null | undefined): Promise<ExportRow[]> {
  const today = warsawDateStr();
  const workers = await db.select().from(workersTable).where(scope ? workerInScopeSql(scope) : undefined).orderBy(workersTable.fullName);
  const facs = await db.select().from(factoriesTable);
  const facById = new Map(facs.map(x => [x.id, x]));
  const cos = await db.select().from(companiesTable);
  const coById = new Map(cos.map(x => [x.id, x]));
  const poss = await db.select().from(positionsTable);
  const posById = new Map(poss.map(x => [x.id, x]));
  const facPos = await db.select({ factoryId: factoryPositionsTable.factoryId, positionId: factoryPositionsTable.positionId, kzisCode: factoryPositionsTable.kzisCode }).from(factoryPositionsTable);
  const facPosKzis = new Map(facPos.map(x => [`${x.factoryId}-${x.positionId}`, x.kzisCode]));
  const ids = workers.map(w => w.id);
  if (!ids.length) return [];
  const extra = await db.select().from(workerFactoriesTable).where(inArray(workerFactoriesTable.workerId, ids));
  const extraOf = new Map<number, typeof extra>();
  for (const e of extra) {
    const vf = dstr(e.validFrom), vt = dstr(e.validTo);
    if ((vf && vf > today) || (vt && vt < today)) continue; // лише чинні додаткові фабрики
    extraOf.set(e.workerId, [...(extraOf.get(e.workerId) ?? []), e]);
  }
  const qs = await db.select().from(workerQuestionnairesTable).where(inArray(workerQuestionnairesTable.workerId, ids));
  const qOf = new Map(qs.map(x => [x.workerId, x]));
  const lg = await db.select().from(workerLegalityTable).where(inArray(workerLegalityTable.workerId, ids));
  const lgOf = new Map(lg.map(x => [x.workerId, x]));
  const types = await db.select({ id: documentTypesTable.id, name: documentTypesTable.name, code: documentTypesTable.code }).from(documentTypesTable);
  const typeById = new Map(types.map(t => [t.id, t]));
  const allDocs = await db.select({
    id: workerDocumentsTable.id, workerId: workerDocumentsTable.workerId, docTypeId: workerDocumentsTable.docTypeId, title: workerDocumentsTable.title,
    number: workerDocumentsTable.number, status: workerDocumentsTable.status, issuedAt: workerDocumentsTable.issuedAt, expiresAt: workerDocumentsTable.expiresAt,
    filePath: workerDocumentsTable.filePath, employerCompanyId: workerDocumentsTable.employerCompanyId,
  }).from(workerDocumentsTable).where(inArray(workerDocumentsTable.workerId, ids)).orderBy(desc(workerDocumentsTable.id));
  const docsOf = new Map<number, ExportDoc[]>();
  for (const d of allDocs) {
    const ty = d.docTypeId != null ? typeById.get(d.docTypeId) : undefined;
    docsOf.set(d.workerId, [...(docsOf.get(d.workerId) ?? []), {
      id: d.id, typeId: d.docTypeId, typeName: ty?.name ?? d.title, code: ty?.code ?? null, title: d.title, number: d.number, status: d.status,
      issuedAt: dstr(d.issuedAt), expiresAt: dstr(d.expiresAt), hasFile: !!d.filePath, employerCompanyId: d.employerCompanyId,
    }]);
  }
  // умова (umowa): та сама логіка, що в GET /workers — живий пакет з файлом виду umowa на фабрику
  const LIVE = ["approved", "sent", "viewed", "worker_signed", "signed"];
  const contracts = await db.select({
    id: contractsTable.id, workerId: contractsTable.workerId, factoryId: contractsTable.factoryId, status: contractsTable.status,
    dateFrom: contractsTable.dateFrom, dateTo: contractsTable.dateTo, signedAt: contractsTable.signedAt, companySignedAt: contractsTable.companySignedAt, sentAt: contractsTable.sentAt,
    payoutMethod: contractsTable.payoutMethod, companyId: contractsTable.companyId, terminationDate: contractsTable.terminationDate, terminationBy: contractsTable.terminationBy,
    factoryCompanyId: factoriesTable.companyId, factoryName: factoriesTable.name,
  }).from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(and(inArray(contractsTable.workerId, ids), inArray(contractsTable.status, LIVE))).orderBy(desc(contractsTable.id));
  const kinds = contracts.length ? await db.select({ contractId: contractFilesTable.contractId, kind: documentTemplatesTable.kind }).from(contractFilesTable)
    .innerJoin(documentTemplatesTable, eq(contractFilesTable.templateId, documentTemplatesTable.id))
    .where(inArray(contractFilesTable.contractId, contracts.map(c => c.id))) : [];
  const withFiles = new Set(kinds.map(k => k.contractId));
  const umowaIds = new Set(kinds.filter(k => k.kind === "umowa" || k.kind === "sprzatanie_umowa").map(k => k.contractId));
  const isUmowa = (id: number) => umowaIds.has(id) || !withFiles.has(id);
  const expiringUntil = addDaysStr(today, f.docExpiringDays);
  const docMatchesState = (d: ExportDoc): boolean => {
    switch (f.docState) {
      case "expired": return d.status === "expired" || (!!d.expiresAt && d.expiresAt < today);
      case "expiring": return d.status !== "missing" && !!d.expiresAt && d.expiresAt >= today && d.expiresAt <= expiringUntil;
      case "pending": return d.status === "pending";
      case "nofile": return d.status !== "missing" && !d.hasFile;
      case "present": return d.status === "present" && (!d.expiresAt || d.expiresAt >= today);
      default: return d.status !== "missing";
    }
  };

  const out: ExportRow[] = [];
  for (const w of workers) {
    const fac = w.factoryId != null ? facById.get(w.factoryId) : undefined;
    const coId = w.companyId ?? fac?.companyId ?? null;
    const status: ExportRow["status"] = w.doNotHire ? "blacklist" : w.isActive ? "active" : "fired";
    const cache = lgOf.get(w.id);
    const eff = effectiveView({ legalStatus: w.legalStatus, isStudent: w.isStudent }, cache ? { overall: cache.overall, derivedLegalStatus: cache.derivedLegalStatus, legacyMismatchKind: cache.legacyMismatchKind ?? "none" } : null);
    const bd = dstr(w.birthDate);
    const under26 = bd ? isUnder26(bd) : !!w.under26;
    const student = !!eff.isStudent;
    const um = contracts.find(c => c.workerId === w.id && c.factoryId != null && isUmowa(c.id) && (coId == null || (c.companyId ?? c.factoryCompanyId) === coId)) ?? null;
    const extras = (extraOf.get(w.id) ?? []).filter(e => e.factoryId !== w.factoryId);
    const q = qOf.get(w.id) ?? null;
    const docs = docsOf.get(w.id) ?? [];
    const pd = docs.find(d => d.code === "passport" && d.status === "present");
    const row: ExportRow = {
      id: w.id, fullName: w.fullName, firstName: w.firstName, middleName: w.middleName, lastName: w.lastName, gratyfikantName: w.gratyfikantName,
      code: w.workerCode, gender: w.gender, birthDate: bd, nationality: w.nationality, pesel: w.pesel ?? null, language: w.language,
      telegram: !!w.telegramId, status, firedAt: dstr(w.firedAt), firstWorkDate: dstr(w.firstWorkDate), employmentStartDate: dstr(w.employmentStartDate), createdAt: dstr(w.createdAt),
      doNotHireReason: w.doNotHireReason, terminationDate: dstr(w.terminationDate),
      companyId: coId, companyName: coId != null ? coById.get(coId)?.name ?? null : null,
      factoryId: w.factoryId, factoryName: fac?.name ?? null, city: fac?.city ?? null, factoryCompanyName: fac?.companyId != null ? coById.get(fac.companyId)?.name ?? null : null,
      extraFactories: extras.map(e => facById.get(e.factoryId)?.name ?? `#${e.factoryId}`), extraFactoryIds: extras.map(e => e.factoryId),
      positionName: w.positionId != null ? posById.get(w.positionId)?.name ?? null : null,
      kzisCode: (w.factoryId != null && w.positionId != null ? facPosKzis.get(`${w.factoryId}-${w.positionId}`) : null) || fac?.uaKzisCode || (w.positionId != null ? posById.get(w.positionId)?.kzisCode : null) || null,
      legalStatus: normalizeProfileLegal(w.legalStatus) ?? w.legalStatus, effectiveLegalStatus: eff.legalStatus, legalSource: eff.legalSource,
      student, stud26: student && under26,
      legality: cache ? { overall: cache.overall, stay: cache.stay, work: cache.work, nextExpiryAt: dstr(cache.nextExpiryAt) } : null,
      umowa: um ? {
        status: um.status, dateFrom: dstr(um.dateFrom), dateTo: dstr(um.dateTo), signedAt: dstr(um.signedAt), companySignedAt: dstr(um.companySignedAt), sentAt: dstr(um.sentAt),
        factoryName: um.factoryName, companyName: (um.companyId ?? um.factoryCompanyId) != null ? coById.get((um.companyId ?? um.factoryCompanyId)!)?.name ?? null : null,
        payoutMethod: um.payoutMethod, expired: !!um.dateTo && dstr(um.dateTo)! < today, terminationDate: dstr(um.terminationDate), terminationBy: um.terminationBy,
      } : null,
      contracts: contracts.filter(c => c.workerId === w.id && c.factoryId != null && isUmowa(c.id)).map(c => ({
        status: c.status, dateFrom: dstr(c.dateFrom), dateTo: dstr(c.dateTo), factoryName: c.factoryName,
        companyName: (c.companyId ?? c.factoryCompanyId) != null ? coById.get((c.companyId ?? c.factoryCompanyId)!)?.name ?? null : null,
        concludedAt: dstr(c.companySignedAt) ?? dstr(c.signedAt),
      })),
      q, passport: q?.passportNumber || pd ? { number: q?.passportNumber || pd?.number || null, issuedAt: dstr(q?.passportIssuedAt) || pd?.issuedAt || null, expiresAt: dstr(q?.passportExpiresAt) || pd?.expiresAt || null } : null,
      docs, note: w.note,
    };
    // ── фільтри ──
    if (f.mode !== "all" && status !== f.mode) continue;
    if (f.factoryIds.length && !(w.factoryId != null && f.factoryIds.includes(w.factoryId)) && !extras.some(e => f.factoryIds.includes(e.factoryId))) continue;
    if (f.companyIds.length && !(coId != null && f.companyIds.includes(coId))) continue;
    if (f.positionIds.length && !(w.positionId != null && f.positionIds.includes(w.positionId))) continue;
    if (f.cities.length && !(fac?.city && f.cities.includes(fac.city))) continue;
    if (f.gender && w.gender !== f.gender) continue;
    if (f.telegram && (f.telegram === "yes") !== row.telegram) continue;
    if (f.legal) {
      const ls = row.legalStatus;
      if (f.legal === "problem" ? !(!ls || ls === "oczekuje") : f.legal === "none" ? !!ls : ls !== f.legal) continue;
    }
    if (f.nationality && (f.nationality === "none" ? !!w.nationality : w.nationality !== f.nationality)) continue;
    if (f.stud26 && !row.stud26) continue;
    if (f.docLeg && (f.docLeg === "none" ? !!row.legality : row.legality?.overall !== f.docLeg)) continue;
    if (f.umowa) {
      const ok = f.umowa === "none" ? !um : f.umowa === "expired" ? !!row.umowa?.expired
        : f.umowa === "signed" ? row.umowa?.status === "signed" && !row.umowa.expired
        : f.umowa === "pending" ? !!row.umowa && !row.umowa.expired && row.umowa.status !== "signed" : true;
      if (!ok) continue;
    }
    // дати
    if (!inRange(row.firstWorkDate, f.firstWorkFrom, f.firstWorkTo)) continue;
    if (!inRange(row.firedAt, f.firedFrom, f.firedTo)) continue;
    if (!inRange(row.employmentStartDate, f.startFrom, f.startTo)) continue;
    if (!inRange(row.birthDate, f.birthFrom, f.birthTo)) continue;
    if (!inRange(row.terminationDate, f.termFrom, f.termTo)) continue;
    if (!inRange(row.umowa?.dateTo ?? null, f.umowaToFrom, f.umowaToTo)) continue;
    if (!inRange(row.createdAt, f.createdFrom, f.createdTo)) continue;
    // анкета
    if (f.anketa === "yes" && !q) continue;
    if (f.anketa === "no" && q) continue;
    if (f.anketa === "verified" && !q?.verifiedAt) continue;
    if (f.pesel && (f.pesel === "yes") !== has(row.pesel)) continue;
    if (f.bank && (f.bank === "yes") !== has(q?.bankIban)) continue;
    if (f.phone && (f.phone === "yes") !== has(q?.phone)) continue;
    if (f.email && (f.email === "yes") !== has(q?.email)) continue;
    if (f.nip && (f.nip === "yes") !== has(q?.nip)) continue;
    if (f.qCity && !(contains(q?.zamMiejscowosc, f.qCity) || contains(q?.regMiejscowosc, f.qCity) || contains(q?.city, f.qCity))) continue;
    if (f.qTaxOffice && !contains(q?.taxOffice, f.qTaxOffice)) continue;
    if (f.qNfz && !contains(q?.nfzBranch, f.qNfz)) continue;
    // документи
    if (f.docHasTypeIds.length && !docs.some(d => d.typeId != null && f.docHasTypeIds.includes(d.typeId) && docMatchesState(d))) continue;
    if (!f.docHasTypeIds.length && f.docState && !docs.some(docMatchesState)) continue;
    if (f.docNoTypeIds.length && docs.some(d => d.typeId != null && f.docNoTypeIds.includes(d.typeId) && d.status !== "missing")) continue;
    if (f.docNumber && !docs.some(d => contains(d.number, f.docNumber))) continue;
    if (f.q && !matchesQ(f.q, w.fullName, w.workerCode, w.gratyfikantName, w.firstName, w.lastName)) continue;
    out.push(row);
  }
  return out;
}

// ── Поля (каталог): колонки Excel/списку і поля конструктора умов ──────────────
// Кожне поле: header — заголовок у файлі (польською), label — підпис у панелі (укр., через t()),
// type — визначає оператори умов і вигляд значення; get — сире значення (для умов), text — як у файл.
const STATUS_PL: Record<ExportRow["status"], string> = { active: "Aktywny", fired: "Zwolniony", blacklist: "Czarna lista" };
const GENDER_PL = (g: string | null) => g === "male" ? "Mężczyzna" : g === "female" ? "Kobieta" : "";
// Громадянство польською (форма ZUS, «Ukraińskie»): спершу країна з анкети (паспорт: назва або ICAO-код),
// інакше код каталогу національності, якщо він однозначно = одна країна (ukraine → Ukraina; регіони — порожньо).
const regionCountry = new Map<string, string | null>();
for (const [name, region] of Object.values(COUNTRIES)) regionCountry.set(region, regionCountry.has(region) && regionCountry.get(region) !== name ? null : name);
export function citizenshipPl(q: { citizenship: string | null } | null, nationality: string | null): string {
  const raw = q?.citizenship?.trim() || (nationality ? regionCountry.get(nationality) ?? "" : "");
  if (!raw) return "";
  const v = citizenshipZus(raw);
  return v === raw && !/skie$|ckie$/.test(v) ? "" : v.replace(/^./, c => c.toUpperCase()); // невідома назва — не вигадуємо
}
const LEGAL_OPTS = [["student", "Student"], ["dyplom", "Dyplom"], ["powiadomienie", "Powiadomienie"], ["zus", "ZUS"], ["oczekuje", "Oczekuje"], ["karta_pobytu", "Karta pobytu"], ["staly_pobyt", "Stały pobyt"], ["polak", "Polak"]] as const;
const LEGALITY_OPTS = [["ok", "OK"], ["warning", "Uwaga"], ["blocked", "Brak podstawy"], ["review", "Do sprawdzenia"], ["expiring", "Wygasa"]] as const;
const CONTRACT_OPTS = [["signed", "podpisana"], ["worker_signed", "podpisana przez pracownika"], ["sent", "wysłana do podpisu"], ["viewed", "otwarta"], ["approved", "zatwierdzona"], ["none", "brak"], ["expired", "wygasła"]] as const;
const DOC_STATUS_OPTS = [["present", "jest"], ["pending", "do sprawdzenia"], ["expired", "wygasł"], ["missing", "brak (żądany)"], ["none", "nie ma wpisu"]] as const;
const NAT_OPTS = [["ukraine", "Ukraina"], ["belarus", "Białoruś"], ["poland", "Polska"], ["moldova", "Mołdawia"], ["romania", "Rumunia"], ["georgia", "Gruzja"], ["azerbaijan", "Azerbejdżan"], ["turkey", "Turcja"], ["eu_other", "UE (inne)"], ["africa", "Afryka"], ["latin_america", "Ameryka Łacińska"], ["central_asia", "Azja Środkowa"], ["south_asia", "Azja Południowa"], ["other", "Inne"]] as const;
const addrZam = (q: ExportRow["q"]) => q ? [q.zamUlica, q.zamNumerDomu, q.zamKodPocztowy, q.zamMiejscowosc].filter(Boolean).join(", ") || (q.addressPl ?? "") : "";
const addrReg = (q: ExportRow["q"]) => q ? [q.regUlica, q.regNumerDomu, q.regKodPocztowy, q.regMiejscowosc].filter(Boolean).join(", ") || (q.addressRegistered ?? "") : "";
const opts = (o: readonly (readonly [string, string])[]) => o.map(([value, label]) => ({ value, label }));

export type FieldType = "text" | "date" | "number" | "bool" | "enum" | "list";
export type ColGroup = "base" | "work" | "legal" | "anketa" | "umowa" | "docs";
export type FieldValue = string | number | boolean | string[] | null;
export interface ExportField {
  key: string; header: string; label: string; group: ColGroup; type: FieldType; width: number;
  options?: { value: string; label: string }[];
  get: (r: ExportRow) => FieldValue;
}
const F = (key: string, header: string, label: string, group: ColGroup, type: FieldType, width: number, get: (r: ExportRow) => FieldValue, options?: readonly (readonly [string, string])[]): ExportField =>
  ({ key, header, label, group, type, width, get, ...(options ? { options: opts(options) } : {}) });

export const WORKER_FIELDS: ExportField[] = [
  F("code", "Kod", "Код", "base", "text", 10, r => r.code),
  F("fullName", "Nazwisko i imię", "Прізвище та імʼя", "base", "text", 32, r => nameCaps(r.fullName)),
  F("firstName", "Imię", "Імʼя", "base", "text", 16, r => r.firstName ? nameCaps(r.firstName) : null),
  F("lastName", "Nazwisko", "Прізвище", "base", "text", 18, r => r.lastName ? nameCaps(r.lastName) : null),
  F("middleName", "Drugie imię", "Друге імʼя", "base", "text", 14, r => r.middleName),
  F("gratyfikantName", "Imię w Gratyfikancie", "Імʼя в Gratyfikancie", "base", "text", 22, r => r.gratyfikantName),
  F("gender", "Płeć", "Стать", "base", "enum", 11, r => r.gender, [["male", "Mężczyzna"], ["female", "Kobieta"]]),
  F("birthDate", "Data urodzenia", "Дата народження", "base", "date", 13, r => r.birthDate),
  F("age", "Wiek", "Вік (років)", "base", "number", 6, r => r.birthDate ? Math.floor((Date.parse(warsawDateStr()) - Date.parse(r.birthDate)) / (365.25 * 86400000)) : null),
  F("citizenship", "Obywatelstwo", "Громадянство (ZUS)", "base", "text", 16, r => citizenshipPl(r.q, r.nationality)),
  F("nationality", "Narodowość (katalog)", "Національність (каталог)", "base", "enum", 14, r => r.nationality, NAT_OPTS),
  F("pesel", "PESEL", "PESEL", "base", "text", 13, r => r.pesel),
  F("telegram", "Telegram", "Підключений до бота", "base", "bool", 9, r => r.telegram),
  F("language", "Język bota", "Мова бота", "base", "text", 9, r => r.language),
  F("createdAt", "W systemie od", "Доданий у систему", "base", "date", 13, r => r.createdAt),
  F("company", "Firma", "Фірма", "work", "text", 20, r => r.companyName),
  F("factory", "Fabryka", "Фабрика", "work", "text", 22, r => r.factoryName),
  F("city", "Miasto", "Місто фабрики", "work", "text", 12, r => r.city),
  F("extraFactories", "Fabryki dodatkowe", "Додаткові фабрики", "work", "list", 22, r => r.extraFactories),
  F("position", "Stanowisko", "Посада", "work", "text", 18, r => r.positionName),
  F("kzis", "Kod zawodu", "Код професії (KZiS)", "work", "text", 10, r => r.kzisCode),
  F("status", "Status", "Статус", "work", "enum", 12, r => r.status, [["active", "Aktywny"], ["fired", "Zwolniony"], ["blacklist", "Czarna lista"]]),
  F("firstWorkDate", "Pierwszy dzień pracy", "Перший робочий день", "work", "date", 13, r => r.firstWorkDate),
  F("employmentStartDate", "Zatrudniony od", "Працевлаштований з", "work", "date", 13, r => r.employmentStartDate),
  F("firedAt", "Data zwolnienia", "Дата звільнення", "work", "date", 13, r => r.firedAt),
  F("terminationDate", "Wypowiedzenie (data)", "Виповідзення (дата)", "work", "date", 13, r => r.terminationDate),
  F("doNotHireReason", "Czarna lista — powód", "Чорний список — причина", "work", "text", 24, r => r.doNotHireReason),
  F("note", "Notatka", "Нотатка профілю", "work", "text", 30, r => r.note),
  F("companyOfFactory", "Firma fabryki", "Фірма фабрики (клієнт у нашій фірмі)", "work", "text", 18, r => r.factoryCompanyName),
  F("tenureDays", "Staż (dni od pierwszego dnia)", "Стаж, днів від першого робочого дня", "work", "number", 8, r => r.firstWorkDate ? Math.max(0, Math.round((Date.parse(r.firedAt ?? warsawDateStr()) - Date.parse(r.firstWorkDate)) / 86400000)) : null),
  F("legalStatus", "Forma legalizacji", "Форма легалізації (сводна)", "legal", "enum", 16, r => r.legalStatus, LEGAL_OPTS),
  F("effectiveLegal", "Forma do wypłat", "Форма для виплат", "legal", "enum", 16, r => r.effectiveLegalStatus, LEGAL_OPTS),
  F("legality", "Status wg dokumentów", "Легалізація за документами", "legal", "enum", 16, r => r.legality?.overall ?? null, LEGALITY_OPTS),
  F("legalityStay", "Pobyt", "Вісь «перебування»", "legal", "enum", 12, r => r.legality?.stay ?? null, LEGALITY_OPTS),
  F("legalityWork", "Praca", "Вісь «праця»", "legal", "enum", 12, r => r.legality?.work ?? null, LEGALITY_OPTS),
  F("nextExpiry", "Najbliższy termin", "Найближчий строк документа", "legal", "date", 13, r => r.legality?.nextExpiryAt ?? null),
  F("legalSource", "Forma — źródło", "Форма для виплат — джерело", "legal", "enum", 12, r => r.legalSource, [["documents", "dokumenty"], ["manual", "ręcznie"], ["none", "brak"]]),
  F("stud26", "Student do 26", "Студент до 26", "legal", "bool", 10, r => r.stud26),
  F("student", "Student", "Студент", "legal", "bool", 10, r => r.student),
  F("phone", "Telefon", "Телефон", "anketa", "text", 15, r => r.q?.phone ?? null),
  F("email", "E-mail", "E-mail", "anketa", "text", 24, r => r.q?.email ?? null),
  F("addrZam", "Adres zamieszkania", "Адреса проживання", "anketa", "text", 34, r => addrZam(r.q) || null),
  F("addrReg", "Adres zameldowania", "Адреса прописки", "anketa", "text", 34, r => addrReg(r.q) || null),
  F("qStreet", "Ulica", "Вулиця (проживання)", "anketa", "text", 18, r => r.q?.zamUlica ?? null),
  F("qHouse", "Numer domu", "Номер дому (проживання)", "anketa", "text", 8, r => r.q?.zamNumerDomu ?? null),
  F("qCity", "Miejscowość", "Місто проживання", "anketa", "text", 14, r => r.q?.zamMiejscowosc ?? r.q?.city ?? null),
  F("qPostal", "Kod pocztowy", "Поштовий індекс", "anketa", "text", 10, r => r.q?.zamKodPocztowy ?? r.q?.postalCode ?? null),
  F("qGmina", "Gmina", "Гміна", "anketa", "text", 14, r => r.q?.zamGmina ?? null),
  F("qPowiat", "Powiat", "Повіт", "anketa", "text", 14, r => r.q?.zamPowiat ?? null),
  F("qWoj", "Województwo", "Воєводство", "anketa", "text", 14, r => r.q?.zamWojewodztwo ?? null),
  F("bank", "Rachunek bankowy", "Банківський рахунок", "anketa", "text", 30, r => r.q?.bankIban ?? null),
  F("bankName", "Bank", "Банк", "anketa", "text", 20, r => r.q?.bankName ?? null),
  F("nip", "NIP", "NIP", "anketa", "text", 12, r => r.q?.nip ?? null),
  F("taxOffice", "Urząd skarbowy", "Urząd skarbowy", "anketa", "text", 30, r => r.q?.taxOffice ?? null),
  F("nfz", "Oddział NFZ", "Oddział NFZ", "anketa", "text", 30, r => r.q?.nfzBranch ?? null),
  F("birthPlace", "Miejsce urodzenia", "Місце народження", "anketa", "text", 16, r => r.q?.birthPlace ?? null),
  F("motherName", "Imię matki", "Імʼя матері", "anketa", "text", 14, r => r.q?.motherName ?? null),
  F("fatherName", "Imię ojca", "Імʼя батька", "anketa", "text", 14, r => r.q?.fatherName ?? null),
  F("dowod", "Dowód osobisty", "Dowód osobisty (серія/номер)", "anketa", "text", 14, r => r.q?.seriaINumerDowodu ?? null),
  F("passport", "Paszport", "Паспорт (номер)", "anketa", "text", 12, r => r.passport?.number ?? null),
  F("passportCountry", "Paszport — kraj", "Паспорт — країна", "anketa", "text", 12, r => r.q?.passportCountry ?? null),
  F("passportIssued", "Paszport wydany", "Паспорт виданий", "anketa", "date", 12, r => r.passport?.issuedAt ?? null),
  F("passportExpires", "Paszport ważny do", "Паспорт дійсний до", "anketa", "date", 12, r => r.passport?.expiresAt ?? null),
  F("qStudent", "Student (ankieta)", "Студент (анкета)", "anketa", "bool", 10, r => r.q ? !!r.q.isStudent : null),
  F("qSchool", "Szkoła", "Навчальний заклад", "anketa", "text", 20, r => r.q?.schoolName ?? null),
  F("qOtherJob", "Inny pracodawca", "Інший роботодавець", "anketa", "bool", 10, r => r.q ? !!r.q.hasOtherEmployment : null),
  F("qUnemployed", "Zarejestrowany bezrobotny", "Зареєстрований безробітний", "anketa", "bool", 10, r => r.q ? !!r.q.isRegisteredUnemployed : null),
  F("qChorobowe", "Składka chorobowa", "Składka chorobowa", "anketa", "bool", 10, r => r.q ? !!r.q.ankietaSkladkaChorobowa : null),
  F("qEmeryt", "Emeryt", "Emeryt", "anketa", "bool", 8, r => r.q ? !!r.q.ankietaEmeryt : null),
  F("qRencista", "Rencista", "Rencista", "anketa", "bool", 8, r => r.q ? !!r.q.ankietaRencista : null),
  F("qNiepeln", "Niepełnosprawność", "Niepełnosprawność", "anketa", "bool", 10, r => r.q ? !!r.q.ankietaNiepelnosprawnosc : null),
  F("qPayout", "Sposób wypłaty", "Спосіб виплати", "anketa", "text", 12, r => r.q?.payoutMethod ?? null),
  F("qEmergency", "Kontakt awaryjny", "Контакт на випадок", "anketa", "text", 20, r => r.q?.emergencyContact ?? null),
  F("qHas", "Ankieta", "Анкета є", "anketa", "bool", 8, r => !!r.q),
  F("qSubmitted", "Ankieta złożona", "Анкета подана", "anketa", "date", 13, r => dstr(r.q?.submittedAt)),
  F("qVerified", "Ankieta zweryfikowana", "Анкета підтверджена", "anketa", "date", 13, r => dstr(r.q?.verifiedAt)),
  F("qSource", "Ankieta — źródło", "Анкета — джерело", "anketa", "text", 10, r => r.q?.source ?? null),
  F("qConsents", "Zgody RODO", "Згоди RODO (дата)", "anketa", "date", 13, r => dstr(r.q?.consentsAt)),
  F("qAddrReg2", "Adres zameldowania — miejscowość", "Прописка — місто", "anketa", "text", 14, r => r.q?.regMiejscowosc ?? null),
  F("qAddrRegPostal", "Adres zameldowania — kod", "Прописка — індекс", "anketa", "text", 10, r => r.q?.regKodPocztowy ?? null),
  // чинна umowa (на фірму працівника) — stan, даты, підписи; «Data zawarcia» = день підпису фірмою (остаточний), інакше підпис працівника
  F("umowa", "Umowa — stan", "Умова (стан)", "umowa", "enum", 22, r => !r.umowa ? "none" : r.umowa.expired ? "expired" : r.umowa.status, CONTRACT_OPTS),
  F("umowaConcluded", "Data zawarcia umowy", "Умова — дата укладення", "umowa", "date", 13, r => r.umowa?.companySignedAt ?? r.umowa?.signedAt ?? null),
  F("umowaFrom", "Umowa od", "Умова — дата початку", "umowa", "date", 11, r => r.umowa?.dateFrom ?? null),
  F("umowaTo", "Umowa do", "Умова — дата кінця", "umowa", "date", 11, r => r.umowa?.dateTo ?? null),
  F("umowaSigned", "Umowa — podpis pracownika", "Умова — підпис працівника (дата)", "umowa", "date", 13, r => r.umowa?.signedAt ?? null),
  F("umowaCompanySigned", "Umowa — podpis firmy", "Умова — підпис фірми (дата)", "umowa", "date", 13, r => r.umowa?.companySignedAt ?? null),
  F("umowaSent", "Umowa — wysłana do podpisu", "Умова — надіслана на підпис (дата)", "umowa", "date", 13, r => r.umowa?.sentAt ?? null),
  F("umowaFactory", "Umowa — fabryka", "Умова — фабрика", "umowa", "text", 20, r => r.umowa?.factoryName ?? null),
  F("umowaCompany", "Umowa — firma", "Умова — фірма", "umowa", "text", 18, r => r.umowa?.companyName ?? null),
  F("umowaPayout", "Umowa — sposób wypłaty", "Умова — спосіб виплати", "umowa", "enum", 12, r => r.umowa?.payoutMethod ?? null, [["konto", "na konto"], ["reka", "do rąk"]]),
  F("umowaDaysLeft", "Umowa — dni do końca", "Умова — днів до кінця", "umowa", "number", 10, r => r.umowa?.dateTo ? Math.round((Date.parse(r.umowa.dateTo) - Date.parse(warsawDateStr())) / 86400000) : null),
  F("umowaTermination", "Umowa — wypowiedzenie (data)", "Умова — виповідзення (дата)", "umowa", "date", 13, r => r.umowa?.terminationDate ?? null),
  F("umowaTerminationBy", "Umowa — wypowiedzenie (strona)", "Умова — виповідзення (ініціатор)", "umowa", "enum", 12, r => r.umowa?.terminationBy ?? null, [["worker", "pracownik"], ["company", "firma"]]),
  F("contractsCount", "Umowy — ilość", "Умов усього (живих)", "umowa", "number", 8, r => r.contracts.length),
  F("contractsList", "Umowy — lista", "Умови — перелік", "umowa", "list", 50, r => r.contracts.map(c => `${c.factoryName ?? "?"}${c.companyName ? ` (${c.companyName})` : ""} ${c.dateFrom ?? "?"}–${c.dateTo ?? "∞"} [${c.status}]${c.concludedAt ? ` zawarta ${c.concludedAt}` : ""}`)),
  F("docsList", "Dokumenty (lista)", "Документи (перелік)", "docs", "list", 40, r => r.docs.filter(d => d.status !== "missing").map(d => `${d.typeName}${d.number ? ` ${d.number}` : ""}${d.expiresAt ? ` do ${d.expiresAt}` : ""}`)),
  F("docsMissing", "Dokumenty — brak/żądane", "Документи — бракує/запитані", "docs", "list", 30, r => r.docs.filter(d => d.status === "missing").map(d => d.typeName)),
  F("docsCount", "Dokumenty — ilość plików", "Документи — кількість файлів", "docs", "number", 8, r => r.docs.filter(d => d.hasFile).length),
];
export const DEFAULT_XLSX_COLS = ["code", "fullName", "gender", "birthDate", "citizenship", "pesel", "company", "factory", "city", "position", "status", "firstWorkDate", "firedAt", "legalStatus", "legality", "nextExpiry", "stud26", "umowa", "umowaFrom", "umowaTo", "phone", "email", "addrZam", "bank", "nip", "taxOffice", "nfz", "passport", "passportExpires", "telegram"];

/** Поля по типу документа: doc:<typeId>:status|number|expires|issued|file (у каталозі — активні типи). */
let docFieldsCache: { at: number; fields: ExportField[] } | null = null;
export async function docFields(): Promise<ExportField[]> {
  if (docFieldsCache && Date.now() - docFieldsCache.at < 60_000) return docFieldsCache.fields;
  const types = await db.select({ id: documentTypesTable.id, name: documentTypesTable.name, isActive: documentTypesTable.isActive, sortOrder: documentTypesTable.sortOrder }).from(documentTypesTable);
  const out: ExportField[] = [];
  for (const t of types.filter(t => t.isActive !== false).sort((a, b) => a.sortOrder - b.sortOrder)) {
    const pick = (r: ExportRow) => r.docs.find(d => d.typeId === t.id && d.status !== "missing") ?? r.docs.find(d => d.typeId === t.id);
    out.push(F(`doc:${t.id}:status`, `${t.name} — status`, `${t.name} — стан`, "docs", "enum", 14, r => pick(r)?.status ?? "none", DOC_STATUS_OPTS));
    out.push(F(`doc:${t.id}:number`, `${t.name} — nr`, `${t.name} — номер`, "docs", "text", 16, r => pick(r)?.number ?? null));
    out.push(F(`doc:${t.id}:issued`, `${t.name} — wydany`, `${t.name} — виданий`, "docs", "date", 12, r => pick(r)?.issuedAt ?? null));
    out.push(F(`doc:${t.id}:expires`, `${t.name} — ważny do`, `${t.name} — дійсний до`, "docs", "date", 12, r => pick(r)?.expiresAt ?? null));
    out.push(F(`doc:${t.id}:file`, `${t.name} — plik`, `${t.name} — файл є`, "docs", "bool", 8, r => { const d = pick(r); return d ? d.hasFile : null; }));
  }
  docFieldsCache = { at: Date.now(), fields: out };
  return out;
}
export async function allFields(): Promise<ExportField[]> { return [...WORKER_FIELDS, ...(await docFields())]; }
/** Поля, доступні адміну: анкета (персональні дані) — лише з cap workerDocs, як GET /workers/:id/questionnaire (ревʼю agy 28.10.2026). */
export async function allowedFields(canAnketa: boolean): Promise<ExportField[]> {
  return (await allFields()).filter(f => canAnketa || f.group !== "anketa");
}

/** Значення поля як у файл: enum → підпис, bool → Tak/Nie, список → через «; ». */
export function fieldText(f: ExportField, r: ExportRow): string | number {
  const v = f.get(r);
  if (v == null) return "";
  if (f.type === "bool") return v ? "Tak" : "Nie";
  if (f.type === "enum") return f.options?.find(o => o.value === String(v))?.label ?? String(v);
  if (Array.isArray(v)) return v.join("; ");
  return v as string | number;
}

// ── Конструктор умов: групи АБО, всередині — умови І (як у HRappka) ────────────
export type CondOp = "contains" | "not_contains" | "starts" | "ends" | "eq" | "neq" | "empty" | "not_empty" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "not_in" | "true" | "false" | "within_days" | "older_days";
export interface Cond { k: string; op: CondOp; v?: string | string[] | number | null }
export interface CondSpec { or: { and: Cond[] }[] }
export const OPS_BY_TYPE: Record<FieldType, CondOp[]> = {
  text: ["contains", "not_contains", "starts", "ends", "eq", "neq", "empty", "not_empty"],
  list: ["contains", "not_contains", "empty", "not_empty"],
  date: ["eq", "lt", "gt", "between", "within_days", "older_days", "empty", "not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "empty", "not_empty"],
  bool: ["true", "false", "empty"],
  enum: ["eq", "neq", "in", "not_in", "empty", "not_empty"],
};
export function parseCondSpec(raw: unknown): CondSpec | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const j = JSON.parse(raw);
    const or = Array.isArray(j?.or) ? j.or : [];
    const spec: CondSpec = { or: [] };
    for (const g of or) {
      const and: Cond[] = [];
      for (const c of Array.isArray(g?.and) ? g.and : []) if (c && typeof c.k === "string" && typeof c.op === "string") and.push({ k: c.k, op: c.op as CondOp, v: c.v ?? null });
      if (and.length) spec.or.push({ and });
    }
    return spec.or.length ? spec : null;
  } catch { return null; }
}
const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
function condMatches(c: Cond, f: ExportField, r: ExportRow, today: string): boolean {
  const v = f.get(r);
  const isEmpty = v == null || v === "" || (Array.isArray(v) && !v.length);
  if (c.op === "empty") return isEmpty;
  if (c.op === "not_empty") return !isEmpty;
  if (f.type === "bool") return c.op === "true" ? v === true : c.op === "false" ? v === false : false;
  if (!OPS_BY_TYPE[f.type].includes(c.op)) return true; // незнайомий оператор — умову ігноруємо
  const val = c.v;
  if (f.type === "list") {
    const list = (Array.isArray(v) ? v : v == null ? [] : [String(v)]).map(norm);
    const hit = list.some(x => x.includes(norm(val)));
    return c.op === "contains" ? hit : !hit;
  }
  if (f.type === "enum") {
    const cur = v == null ? "" : String(v);
    const arr = Array.isArray(val) ? val.map(String) : [String(val ?? "")];
    const inSet = arr.includes(cur);
    return c.op === "eq" || c.op === "in" ? inSet : !inSet;
  }
  if (f.type === "text") {
    const cur = norm(v), x = norm(val);
    switch (c.op) {
      case "contains": return cur.includes(x);
      case "not_contains": return !cur.includes(x);
      case "starts": return cur.startsWith(x);
      case "ends": return cur.endsWith(x);
      case "eq": return cur === x;
      case "neq": return cur !== x;
      default: return true;
    }
  }
  // date / number — порівняння рядком (ISO-дата) або числом
  if (isEmpty) return false;
  if (f.type === "date") {
    const cur = String(v);
    const a = Array.isArray(val) ? String(val[0] ?? "") : String(val ?? "");
    const b = Array.isArray(val) ? String(val[1] ?? "") : "";
    switch (c.op) {
      case "eq": return cur === a;
      case "lt": return cur < a;
      case "gt": return cur > a;
      case "between": return (!a || cur >= a) && (!b || cur <= b);
      case "within_days": { const n = Number(a) || 0; return cur >= today && cur <= addDaysStr(today, n); } // спливає за N днів
      case "older_days": { const n = Number(a) || 0; return cur <= addDaysStr(today, -n); } // раніше ніж N днів тому
      default: return true;
    }
  }
  const cur = Number(v);
  const num = (x: unknown) => x == null || x === "" ? NaN : Number(x); // порожня межа = без межі (Number("") дав би 0 — ревʼю codex)
  const a = num(Array.isArray(val) ? val[0] : val), b = num(Array.isArray(val) ? val[1] : null);
  switch (c.op) {
    case "eq": return cur === a;
    case "neq": return cur !== a;
    case "gt": return cur > a;
    case "gte": return cur >= a;
    case "lt": return cur < a;
    case "lte": return cur <= a;
    case "between": return (Number.isNaN(a) || cur >= a) && (Number.isNaN(b) || cur <= b);
    default: return true;
  }
}
/** Застосувати умови: хоч одна група АБО, у якій усі умови І. Невідоме поле = умова пропускається. */
export async function applyCondSpec(rows: ExportRow[], spec: CondSpec | null, canAnketa = true): Promise<ExportRow[]> {
  if (!spec) return rows;
  const fields = new Map((await allowedFields(canAnketa)).map(f => [f.key, f])); // умова по недоступному полю — пропускається
  const today = warsawDateStr();
  return rows.filter(r => spec.or.some(g => g.and.every(c => { const f = fields.get(c.k); return !f || condMatches(c, f, r, today); })));
}

export async function resolveCols(keys: string[] | undefined, canAnketa = true): Promise<ExportField[]> {
  const byKey = new Map((await allowedFields(canAnketa)).map(c => [c.key, c]));
  const wanted = keys?.length ? keys : DEFAULT_XLSX_COLS;
  return wanted.map(k => byKey.get(k)).filter((c): c is ExportField => !!c);
}
export const renderCells = (rows: ExportRow[], cols: ExportField[]) => rows.map(r => cols.map(c => fieldText(c, r)));

export async function buildWorkersXlsx(rows: ExportRow[], colKeys?: string[], canAnketa = true): Promise<Buffer> {
  const cols = await resolveCols(colKeys, canAnketa);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Pracownicy", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map(c => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  for (const r of rows) ws.addRow(cols.map(c => fieldText(c, r)));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── CSV для Gratyfikant nexo (колонки 1:1 зі зразка «Eksport - Umowy») ─────────
export const GRATYFIKANT_HEADERS = [
  "Pracownik", "Dział/Klient - Nazwa", "Data rozpoczęcia", "Data zakończenia", "Typ",
  "Pracownik - Dane do rozliczeń - Jestem studentem lub uczniem i nie przekroczyłem 26 roku życia", "Data zawarcia", "Pracownik - Status",
  "Pracownik - Imię", "Pracownik - Drugie imię", "Pracownik - Nazwisko", "Pracownik - Płeć", "Pracownik - Data urodzenia", "Pracownik - Obywatelstwo",
  "Pracownik - Oddział NFZ", "Pracownik - Urząd skarbowy", "Pracownik - Rachunek bankowy",
  "Pracownik - Dane kontaktowe - Telefon", "Pracownik - Dane kontaktowe - E-mail",
  "Pracownik - Numery identyfikacyjne - PESEL", "Pracownik - Numery identyfikacyjne - Dowód osobisty",
  "Pracownik - Numery identyfikacyjne - Dowód osobisty - Data wydania", "Pracownik - Numery identyfikacyjne - Dowód osobisty - Data ważności",
  "Pracownik - Numery identyfikacyjne - Paszport", "Pracownik - Numery identyfikacyjne - Paszport - Data wydania", "Pracownik - Numery identyfikacyjne - Paszport - Data ważności",
  "Pracownik - Numery identyfikacyjne - Paszport biometryczny", "Pracownik - Numery identyfikacyjne - Paszport biometryczny - Data wydania", "Pracownik - Numery identyfikacyjne - Paszport biometryczny - Data ważności",
  "Pracownik - Adres Zamieszkania - Ulica", "Pracownik - Adres Zamieszkania - Numer domu / mieszkania", "Pracownik - Adres Zamieszkania - Miejscowość",
  "Pracownik - Adres Zamieszkania - Kod pocztowy", "Pracownik - Adres Zamieszkania - Gmina", "Pracownik - Adres Zamieszkania - Powiat",
  "Pracownik - Adres Zamieszkania - Województwo", "Pracownik - Adres Zamieszkania - Kraj", "Pracownik - Bieżąca umowa - Stanowisko - Kod zawodu",
] as const;

/** Імʼя для Gratyfikant: «Nazwisko Imię» — gratyfikant_name профілю, інакше структуровані поля, інакше fullName як є. */
const gratName = (r: ExportRow) => r.gratyfikantName || (r.lastName && r.firstName ? `${r.lastName} ${r.firstName}` : r.fullName);
const splitName = (r: ExportRow): { first: string; last: string } => {
  if (r.firstName || r.lastName) return { first: r.firstName ?? "", last: r.lastName ?? "" };
  const parts = r.fullName.trim().split(/\s+/);
  return parts.length > 1 ? { first: parts.slice(1).join(" "), last: parts[0]! } : { first: "", last: r.fullName };
};

export function gratyfikantRecord(r: ExportRow): string[] {
  const n = splitName(r);
  const q = r.q;
  const bank = q?.bankIban ? [q.bankIban.replace(/\s+/g, ""), "PLN", q.bankName ?? ""].filter(Boolean).join("\n") : "";
  return [
    gratName(r), r.factoryName ?? "", r.umowa?.dateFrom ?? "", r.umowa?.dateTo ?? "", "Zlecenie",
    r.stud26 ? "Tak" : "Nie", r.umowa?.signedAt ?? r.umowa?.dateFrom ?? "", "Dodać do Gratyfikanta",
    n.first, r.middleName ?? "", n.last, GENDER_PL(r.gender) || (q?.sex === "M" ? "Mężczyzna" : q?.sex === "F" ? "Kobieta" : ""), r.birthDate ?? "",
    citizenshipPl(q, r.nationality),
    q?.nfzBranch ?? "", q?.taxOffice ?? "", bank, q?.phone ?? "", q?.email ?? "",
    r.pesel ?? "", q?.seriaINumerDowodu ?? "", "", "",
    r.passport?.number ?? "", r.passport?.issuedAt ?? "", r.passport?.expiresAt ?? "",
    r.passport?.number ?? "", r.passport?.issuedAt ?? "", r.passport?.expiresAt ?? "",
    q?.zamUlica ?? "", q?.zamNumerDomu ?? "", q?.zamMiejscowosc ?? "", q?.zamKodPocztowy ?? "", q?.zamGmina ?? "", q?.zamPowiat ?? "",
    (q?.zamWojewodztwo ?? "").toUpperCase(), q?.zamMiejscowosc ? "Polska" : "", r.kzisCode ?? "",
  ];
}

// формули Excel (=, @, +/- не перед цифрою) нейтралізуємо апострофом; телефони «+48 …» лишаються як є
const csvSafe = (v: string) => /^[=@]/.test(v) || /^[+-][^\d\s]/.test(v) ? `'${v}` : v;
const csvCell = (raw: string) => { const v = csvSafe(raw); return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v; };
/** CSV: роздільник «;» (польський Excel/nexo), UTF-8 з BOM, CRLF. */
export function buildGratyfikantCsv(rows: ExportRow[]): Buffer {
  const lines = [GRATYFIKANT_HEADERS.map(csvCell).join(";"), ...rows.map(r => gratyfikantRecord(r).map(csvCell).join(";"))];
  return Buffer.from("﻿" + lines.join("\r\n") + "\r\n", "utf8");
}
export async function buildGratyfikantXlsx(rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Worksheet");
  ws.addRow([...GRATYFIKANT_HEADERS]);
  for (const r of rows) ws.addRow(gratyfikantRecord(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── ZIP документів ─────────────────────────────────────────────────────────────
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\.{2,}/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "-"; // «..» теж — zip-slip (ревʼю agy)
const extOf = (fileName: string | null, mime: string | null, fallback: string) => {
  const e = fileName ? path.extname(fileName).toLowerCase() : "";
  if (e) return e;
  if (mime === "application/pdf") return ".pdf";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  return fallback;
};

export interface DocsZipOptions { docTypeIds: number[]; includeContracts: boolean; scope?: AdminScope | null; factoryIds?: number[] }

/** Скільки файлів поїде (превʼю в модалці). */
export async function countDocsForZip(rows: ExportRow[], opts: DocsZipOptions): Promise<{ docs: number; contracts: number; workersWithFiles: number }> {
  const ids = rows.map(r => r.id);
  if (!ids.length) return { docs: 0, contracts: 0, workersWithFiles: 0 };
  const withFile = rows.flatMap(r => r.docs.filter(d => d.hasFile && (!opts.docTypeIds.length || (d.typeId != null && opts.docTypeIds.includes(d.typeId)))).map(() => r.id));
  // умови — лише фабрик у скоупі адміна (як lookupAllowed для /contracts/:id/files; ревʼю codex 28.10.2026)
  const contracts = (opts.includeContracts ? await db.select({ workerId: contractsTable.workerId, factoryId: contractsTable.factoryId }).from(contractsTable)
    .innerJoin(contractFilesTable, eq(contractFilesTable.contractId, contractsTable.id))
    .where(and(inArray(contractsTable.workerId, ids), eq(contractsTable.status, "signed"))) : [])
    .filter(c => !opts.scope || c.factoryId == null || factoryInScope(opts.scope, c.factoryId));
  const ws = new Set([...withFile, ...contracts.map(c => c.workerId)]);
  return { docs: withFile.length, contracts: contracts.length, workersWithFiles: ws.size };
}

// шлях із БД — лише всередині UPLOADS_ROOT (захист від «../» у збережених шляхах; ревʼю agy 28.10.2026)
const ROOT_ABS = path.resolve(UPLOADS_ROOT);
const safeAbs = (rel: string): string | null => { const abs = path.resolve(UPLOADS_ROOT, rel); return abs.startsWith(ROOT_ABS + path.sep) ? abs : null; };

/**
 * Стрім ZIP у відповідь: Firma/Fabryka/Nazwisko Imię (kod)/… Людина на кількох фабриках (основна +
 * чинні додаткові) кладеться під КОЖНУ з них (рішення власника 28.10.2026); якщо фільтр по фабриках
 * заданий — лише під вибрані, де вона є. Файли в кожній папці ті самі.
 */
export async function streamDocsZip(rows: ExportRow[], opts: DocsZipOptions, res: Response, filename: string): Promise<void> {
  const ids = rows.map(r => r.id);
  const facNames = new Map((await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable)).map(f => [f.id, f.name]));
  const docs = ids.length ? await db.select().from(workerDocumentsTable)
    .where(and(inArray(workerDocumentsTable.workerId, ids), ...(opts.docTypeIds.length ? [inArray(workerDocumentsTable.docTypeId, opts.docTypeIds)] : [])))
    .orderBy(workerDocumentsTable.id) : [];
  const types = await db.select({ id: documentTypesTable.id, name: documentTypesTable.name, code: documentTypesTable.code }).from(documentTypesTable);
  const typeById = new Map(types.map(t => [t.id, t]));
  const files = (opts.includeContracts && ids.length ? await db.select({
    workerId: contractsTable.workerId, contractId: contractsTable.id, factoryId: contractsTable.factoryId, dateFrom: contractsTable.dateFrom, factoryName: factoriesTable.name,
    title: contractFilesTable.title, signedPath: contractFilesTable.signedPath, sortOrder: contractFilesTable.sortOrder,
  }).from(contractsTable).innerJoin(contractFilesTable, eq(contractFilesTable.contractId, contractsTable.id)).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(and(inArray(contractsTable.workerId, ids), eq(contractsTable.status, "signed"))) : [])
    .filter(c => !opts.scope || c.factoryId == null || factoryInScope(opts.scope, c.factoryId)); // лише фабрики скоупу

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  const zip = archiver("zip", { zlib: { level: 6 } });
  zip.on("warning", (err: Error) => logger.warn({ err }, "docs zip warning"));
  zip.on("error", (err: Error) => { logger.error({ err }, "docs zip failed"); if (!res.headersSent) res.status(500).end(); else res.end(); });
  zip.pipe(res);
  let added = 0;
  for (const r of rows) {
    const person = safeName(nameCaps(r.fullName));
    let facIds = [...new Set([...(r.factoryId != null ? [r.factoryId] : []), ...r.extraFactoryIds])];
    if (opts.factoryIds?.length) facIds = facIds.filter(id => opts.factoryIds!.includes(id));
    const facFolders = facIds.length ? facIds.map(id => safeName(facNames.get(id) ?? `#${id}`)) : ["Bez fabryki"];
    for (const facFolder of facFolders) {
    const folder = `${safeName(r.companyName ?? "Bez firmy")}/${facFolder}/${safeName(`${nameCaps(r.fullName)}${r.code ? ` (${r.code})` : ""}`)}`;
    const used = new Set<string>();
    const uniq = (name: string) => { let n = name, i = 2; while (used.has(n.toLowerCase())) { const e = path.extname(name); n = `${name.slice(0, name.length - e.length)} (${i++})${e}`; } used.add(n.toLowerCase()); return n; };
    for (const d of docs.filter(x => x.workerId === r.id)) {
      if (!d.filePath) continue;
      const abs = safeAbs(d.filePath);
      if (!abs) { logger.warn({ docId: d.id, filePath: d.filePath }, "docs zip: path outside uploads root blocked"); continue; }
      if (!fs.existsSync(abs)) { logger.warn({ docId: d.id, filePath: d.filePath }, "docs zip: file missing on disk"); continue; }
      const ty = d.docTypeId != null ? typeById.get(d.docTypeId) : undefined;
      // імʼя файла = ПРІЗВИЩЕ ІМʼЯ - тип документа [номер] (прохання власника 28.10.2026)
      const base = `${person} - ${safeName(ty?.name && ty.code !== "other" ? ty.name : d.title)}${d.number ? ` ${safeName(d.number)}` : ""}`;
      zip.file(abs, { name: `${folder}/${uniq(base + extOf(d.fileName, d.fileMime, ".bin"))}` });
      added++;
    }
    for (const f of files.filter(x => x.workerId === r.id)) {
      if (!f.signedPath) continue;
      const abs = safeAbs(f.signedPath);
      if (!abs) { logger.warn({ contractId: f.contractId, signedPath: f.signedPath }, "docs zip: path outside uploads root blocked"); continue; }
      if (!fs.existsSync(abs)) { logger.warn({ contractId: f.contractId, signedPath: f.signedPath }, "docs zip: contract file missing on disk"); continue; }
      const base = `${person} - ${safeName(`${f.title}${f.dateFrom ? ` ${dstr(f.dateFrom)}` : ""}${f.factoryName ? ` ${f.factoryName}` : ""}`)}`;
      zip.file(abs, { name: `${folder}/Umowy/${uniq(base + ".pdf")}` });
      added++;
    }
    }
  }
  if (!added) zip.append("Brak plików dla wybranych filtrów.\r\n", { name: "README.txt" });
  await zip.finalize();
}
