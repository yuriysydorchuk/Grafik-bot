// Дані для форми PSZ-PPWPU (етап 2 робота praca.gov.pl, 13.10.2026): збираються з профілю,
// анкети, фабрики, фірми й посади у структуру під поля форми (docs/PRACA_GOV_PPWPU.md) і
// перевіряються ДО запуску браузера — список прогалин повертається людині одразу.
import { db, workersTable, workerQuestionnairesTable, factoriesTable, companiesTable, positionsTable, contractsTable, factoryPositionsTable, workerFactoriesTable } from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { countryNamePl } from "../../lib/countries";
import { dateStr } from "../taskUtils";

export interface UaFormPayload {
  workerId: number; workerName: string; companyId: number | null; companyName: string;
  contextPattern: string;                 // підрядок назви організації для «Zmiana kontekstu»
  miejscowosc: string;                    // місто складання (шапка форми)
  kraz: string; email: string; telefon: string;
  cudzoziemiec: {
    imie: string; kolejneImiona: string; nazwisko: string; obywatelstwo: string;
    dokRodzaj: "Paszport"; panstwoWydania: string; seriaNr: string; dataWydania: string; dataWaznosci: string;
    pesel: string; dataUrodzenia: string; plec: "Kobieta" | "Mężczyzna";
  };
  praca: {
    dataPodjecia: string; dataPodjeciaFakt?: string; pkdVersion: "PKD_2007" | "PKD_2025"; pkd: string; stanowisko: string; zawodKod: string;
    miejsce: { kodPocztowy: string; wojewodztwo: string; powiat: string; gmina: string; miejscowosc: string; ulica: string; nrDomu: string; nrLokalu: string };
    infoDodatkowe: string; rodzajUmowy: string; godzinMiesiac: string; stawkaGodz: string; stawkaMies: string; // miesięczne = godzinowa × godziny (вимагає форма при годинній)
  };
  liczby: { umowaOPrace: string; cywilne: string };
  warnings: string[]; // не блокують подачу, показуються людині (напр. прострочення 7-денного вікна)
  podpis: { funkcja: string; pelnomocnik: boolean; poaAbsPath?: string | null };
}

export const RODZAJ_UMOWY_ZLECENIE = "Umowa zlecenie / Umowa o świadczenie usług";

// Правки з екрана анкети (лише для цієї подачі, у джерела не пишуться): білий список шляхів,
// щоб з клієнта не прилетіло нічого поза полями форми.
const OVERRIDE_PATHS = [
  "miejscowosc", "kraz", "email", "telefon",
  "cudzoziemiec.imie", "cudzoziemiec.kolejneImiona", "cudzoziemiec.nazwisko", "cudzoziemiec.obywatelstwo", "cudzoziemiec.panstwoWydania",
  "cudzoziemiec.seriaNr", "cudzoziemiec.dataWydania", "cudzoziemiec.dataWaznosci", "cudzoziemiec.pesel", "cudzoziemiec.dataUrodzenia", "cudzoziemiec.plec",
  "praca.dataPodjecia", "praca.pkdVersion", "praca.pkd", "praca.stanowisko", "praca.zawodKod", "praca.infoDodatkowe", "praca.rodzajUmowy", "praca.godzinMiesiac", "praca.stawkaGodz", "praca.stawkaMies",
  "praca.miejsce.kodPocztowy", "praca.miejsce.wojewodztwo", "praca.miejsce.powiat", "praca.miejsce.gmina", "praca.miejsce.miejscowosc", "praca.miejsce.ulica", "praca.miejsce.nrDomu", "praca.miejsce.nrLokalu",
  "liczby.umowaOPrace", "liczby.cywilne", "podpis.funkcja",
] as const;
export function applyOverrides(payload: UaFormPayload, overrides: unknown): UaFormPayload {
  if (!overrides || typeof overrides !== "object") return payload;
  const out: any = structuredClone(payload);
  for (const path of OVERRIDE_PATHS) {
    const parts = path.split(".");
    let src: any = overrides; for (const k of parts) { src = src?.[k]; if (src === undefined) break; }
    if (src === undefined || src === null) continue;
    let v = String(src).trim();
    if (path === "cudzoziemiec.plec") { if (!["Kobieta", "Mężczyzna"].includes(v)) continue; }
    if (path === "praca.pkdVersion") { if (!["PKD_2007", "PKD_2025"].includes(v)) continue; }
    if (path === "praca.pkd") v = v.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (/^(praca\.stawkaGodz|praca\.stawkaMies)$/.test(path)) v = v.replace(".", ",");
    let dst: any = out; for (const k of parts.slice(0, -1)) dst = dst[k];
    dst[parts[parts.length - 1]!] = v;
  }
  return out as UaFormPayload;
}

export function missingOf(payload: UaFormPayload): string[] {
  const p = payload; const missing: string[] = [];
  const need = (v: string, label: string) => { if (!v) missing.push(label); };
  need(p.companyName, "фірма-роботодавець"); need(p.miejscowosc, "місто фірми (Miejscowość)");
  // e-mail/телефон (1.2/1.3) portal часто підставляє з реєстрації організації — порожнє у нас не блокує, робот лишить значення порталу
  need(p.cudzoziemiec.imie, "імʼя"); need(p.cudzoziemiec.nazwisko, "прізвище"); need(p.cudzoziemiec.obywatelstwo, "громадянство"); need(p.cudzoziemiec.seriaNr, "номер паспорта");
  need(p.cudzoziemiec.dataWydania, "дата видачі паспорта"); need(p.cudzoziemiec.dataWaznosci, "термін паспорта"); need(p.cudzoziemiec.dataUrodzenia, "дата народження"); need(p.cudzoziemiec.plec, "стать");
  need(p.praca.dataPodjecia, "дата початку роботи");
  if (p.praca.dataPodjecia && p.praca.dataPodjecia > new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" })) missing.push("дата початку роботи в майбутньому"); need(p.praca.pkd, "PKD фірми"); need(p.praca.stanowisko, "посада / обовʼязки"); need(p.praca.zawodKod, "код KZiS посади");
  need(p.praca.miejsce.wojewodztwo, "адреса фабрики: województwo"); need(p.praca.miejsce.powiat, "адреса фабрики: powiat"); need(p.praca.miejsce.gmina, "адреса фабрики: gmina");
  need(p.praca.godzinMiesiac, "години в повідомленні"); need(p.praca.stawkaGodz, "ставка brutto"); need(p.praca.stawkaMies, "місячна сума за ставкою");
  need(p.liczby.umowaOPrace, "чисельність фірми: umowa o pracę"); need(p.liczby.cywilne, "чисельність фірми: umowy cywilnoprawne");
  return missing;
}

// «EUROSUPPORT GROUP SPÓŁKA Z OGRANICZONĄ…» у діалозі контекстів ↔ «Eurosupport Group Sp. z o.o.» у базі:
// беремо перші значущі слова назви (без форми власності).
export function contextPatternFor(name: string | null | undefined): string {
  const stop = new Set(["sp", "sp.", "z", "o.o.", "o.o", "spółka", "spolka", "s.a.", "sa", "ograniczoną", "odpowiedzialnością", "zoo"]);
  const words = (name ?? "").split(/\s+/).filter(w => w && !stop.has(w.toLowerCase().replace(/,$/, "")));
  return words.slice(0, 2).join(" ");
}

const fmtNum = (v: number | null | undefined) => v == null ? "" : (Math.round(v * 100) / 100).toFixed(2).replace(".", ","); // «31,40» як на порталі

export async function buildUaFormPayload(workerId: number, companyId: number | null): Promise<{ payload: UaFormPayload; missing: string[] }> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) throw new Error("Працівника не знайдено");
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  let [f] = w.factoryId ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, w.factoryId)) : [undefined];
  const cid = companyId ?? w.companyId ?? (f?.multiFirm ? null : f?.companyId ?? null);
  // рядок задачі = людина×фірма: якщо фірма подачі не збігається з фірмою основної фабрики, місце роботи,
  // посада на фабриці та умова беруться з ДОДАТКОВОЇ фабрики цієї фірми (worker_factories), не з основної
  if (companyId != null && f && (w.companyId ?? f.companyId) !== companyId) {
    const extra = await db.select({ wf: workerFactoriesTable, fac: factoriesTable }).from(workerFactoriesTable)
      .innerJoin(factoriesTable, eq(factoriesTable.id, workerFactoriesTable.factoryId))
      .where(and(eq(workerFactoriesTable.workerId, workerId), sql`(${workerFactoriesTable.validTo} is null or ${workerFactoriesTable.validTo} >= current_date)`));
    const hit = extra.find(x => (x.wf.companyId ?? x.fac.companyId) === companyId);
    if (hit) f = hit.fac;
  }
  const [c] = cid ? await db.select().from(companiesTable).where(eq(companiesTable.id, cid)) : [undefined];
  const [pos] = w.positionId ? await db.select().from(positionsTable).where(eq(positionsTable.id, w.positionId)) : [undefined];
  const [fp] = w.positionId && f ? await db.select().from(factoryPositionsTable).where(and(eq(factoryPositionsTable.factoryId, f.id), eq(factoryPositionsTable.positionId, w.positionId))) : [undefined];
  const [contract] = await db.select().from(contractsTable).where(and(eq(contractsTable.workerId, workerId), f ? eq(contractsTable.factoryId, f.id) : isNull(contractsTable.factoryId), sql`${contractsTable.status} in ('signed','sent','viewed','worker_signed')`)).orderBy(desc(contractsTable.id)).limit(1);
  const { KSIEG_STD_BRUTTO } = await import("../svodni");
  const rate = f?.contractRateBrutto ?? KSIEG_STD_BRUTTO();
  const sex: "Kobieta" | "Mężczyzna" | "" = w.gender === "male" ? "Mężczyzna" : w.gender === "female" ? "Kobieta" : q?.sex === "M" ? "Mężczyzna" : q?.sex === "F" ? "Kobieta" : "";
  const citizen = countryNamePl(q?.citizenship) || (w.nationality === "ukraine" ? "Ukraina" : "");
  const first = w.firstName ?? w.fullName.split(" ").slice(1).join(" ");
  const last = w.lastName ?? w.fullName.split(" ")[0] ?? "";

  // Портал приймає «Data podjęcia pracy» лише в межах 7 днів до дня подачі. Рішення власника 13.10.2026:
  // прострочену дату підставляємо на край вікна (сьогодні−7), а людині показуємо попередження з фактичною датою.
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const windowStart = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const startFakt = dateStr(w.firstWorkDate) ?? dateStr(w.employmentStartDate) ?? dateStr(contract?.dateFrom) ?? "";
  const warnings: string[] = [];
  let start = startFakt;
  if (!(c?.contactEmail)) warnings.push("E-mail фірми (1.2) у нас порожній — робот лишить той, що підставить portal з реєстрації організації.");
  if (!(c?.contactPhone)) warnings.push("Телефон фірми (1.3) у нас порожній — робот лишить той, що підставить portal.");
  if (startFakt && startFakt < windowStart) { start = windowStart; warnings.push(`Прострочено: фактичний перший робочий день ${startFakt}, портал приймає лише дати з ${windowStart} по ${today} — у форму підставлено ${windowStart}.`); }
  else if (startFakt && startFakt > today) warnings.push(`Дата початку ${startFakt} у майбутньому — portal такого не приймає; виправте дату в анкеті (підміна на «сьогодні» була б неправдивими відомостями).`);

  const payload: UaFormPayload = {
    workerId, workerName: w.fullName, companyId: cid, companyName: c?.name ?? "",
    contextPattern: contextPatternFor(c?.legalName ?? c?.name),
    miejscowosc: c?.city ?? "",
    kraz: c?.kraz ?? "", email: c?.contactEmail ?? "", telefon: c?.contactPhone ?? "",
    cudzoziemiec: {
      imie: first, kolejneImiona: w.middleName ?? "", nazwisko: last, obywatelstwo: citizen,
      dokRodzaj: "Paszport", panstwoWydania: countryNamePl(q?.passportCountry) || citizen,
      seriaNr: q?.passportNumber ?? "", dataWydania: dateStr(q?.passportIssuedAt) ?? "", dataWaznosci: dateStr(q?.passportExpiresAt) ?? "",
      pesel: w.pesel ?? "", dataUrodzenia: dateStr(w.birthDate) ?? "", plec: sex as "Kobieta" | "Mężczyzna",
    },
    praca: {
      dataPodjecia: start, dataPodjeciaFakt: startFakt || undefined,
      pkdVersion: "PKD_2007", pkd: (c?.pkd ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase(),
      // посада для повідомлення: по посаді на фабриці → по фабриці → обовʼязки умови → назва посади
      stanowisko: fp?.uaStanowisko || f?.uaStanowisko || fp?.contractDuties || f?.contractDuties || pos?.name || "",
      zawodKod: fp?.kzisCode || f?.uaKzisCode || pos?.kzisCode || "",
      miejsce: { kodPocztowy: f?.addrPostalCode ?? "", wojewodztwo: f?.addrWojewodztwo ?? "", powiat: f?.addrPowiat ?? "", gmina: f?.addrGmina ?? "", miejscowosc: f?.addrMiejscowosc ?? "", ulica: f?.addrStreet ?? "", nrDomu: f?.addrHouseNo ?? "", nrLokalu: f?.addrAptNo ?? "" },
      infoDodatkowe: f ? `${f.name}${f.address ? ` — ${f.address}` : ""}` : "",
      rodzajUmowy: RODZAJ_UMOWY_ZLECENIE,
      godzinMiesiac: w.notifyHours != null ? String(Math.round(w.notifyHours)) : "",
      stawkaGodz: fmtNum(rate),
      stawkaMies: rate && w.notifyHours != null ? fmtNum(Math.round(rate * Math.round(w.notifyHours) * 100) / 100) : "",
    },
    liczby: { umowaOPrace: c?.headcountEmployment != null ? String(c.headcountEmployment) : "", cywilne: c?.headcountCivil != null ? String(c.headcountCivil) : "" },
    warnings,
    podpis: { funkcja: "", pelnomocnik: true },
  };

  const missing = missingOf(payload);
  return { payload, missing };
}
