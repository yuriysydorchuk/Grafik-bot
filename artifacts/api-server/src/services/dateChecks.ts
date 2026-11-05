// Звірка дат у профілі (зголошення #25, рішення власника 05.11.2026): умова, powiadomienie, ZUA і ZWUA
// мають розповідати ОДНУ історію. Розбіжність не блокує нічого й на статус легальності не впливає —
// це лише жовте попередження в документах профілю, щоб помилку (умова з 21-го, powiadomienie з 23-го)
// помітили до контролю. Перевірки — по кожній фірмі-роботодавцю, у межах поточного найму
// (після повернення звільненого старі документи не рахуються — firstWorkDate.restoredSince):
//   start_mismatch — початок за умовою ≠ «праця від» у powiadomienii ≠ дата зголошення ZUA/ZZA;
//   zua_before_permit — зголошення раніше, ніж почав діяти дозвіл на працю (oświadczenie / zezwolenie);
//   zwua_mismatch — виреєстрування ≠ день після звільнення (людину звільнено).
import { db, workersTable, contractsTable, factoriesTable, companiesTable, workerDocumentsTable, documentTypesTable } from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { dateStr } from "./taskUtils";
import { eventContractIds } from "./contractEndDocs";
import { loadZusPairs } from "./zusPairs";
import { restoredSince } from "./firstWorkDate";

export type DateWarning =
  | { code: "start_mismatch"; companyId: number | null; companyName: string | null; umowa: string | null; powiadomienie: string | null; zua: string | null }
  | { code: "zua_before_permit"; companyId: number | null; companyName: string | null; zua: string; permitFrom: string; permitName: string }
  | { code: "zwua_mismatch"; companyId: number | null; companyName: string | null; zwua: string; expected: string; fireDate: string };

const PERMIT_CODES = ["oswiadczenie", "zezwolenie_a", "zezwolenie_jednolite"];

export async function workerDateWarnings(workerId: number): Promise<DateWarning[]> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return [];
  const out: DateWarning[] = [];
  const floor = (await restoredSince([workerId])).get(workerId) ?? null; // поточний найм
  const thisHire = (d: string | null) => !!d && (!floor || d >= floor);

  const signed = await db.select({ id: contractsTable.id, dateFrom: contractsTable.dateFrom, companyId: sql<number | null>`coalesce(${contractsTable.companyId}, ${factoriesTable.companyId})` })
    .from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(and(eq(contractsTable.workerId, workerId), eq(contractsTable.status, "signed")));
  const events = await eventContractIds(signed.map(c => c.id));
  const umowy = signed.filter(c => !events.has(c.id) && thisHire(dateStr(c.dateFrom)));

  const types = await db.select({ id: documentTypesTable.id, code: documentTypesTable.code, name: documentTypesTable.name }).from(documentTypesTable)
    .where(inArray(documentTypesTable.code, ["powiadomienie_ua", ...PERMIT_CODES]));
  const typeOf = new Map(types.map(t => [t.id, t]));
  const docs = types.length ? await db.select().from(workerDocumentsTable)
    .where(and(eq(workerDocumentsTable.workerId, workerId), inArray(workerDocumentsTable.docTypeId, types.map(t => t.id)), ne(workerDocumentsTable.status, "missing"))) : [];
  const zus = await loadZusPairs(workerId);

  const companyIds = [...new Set([...umowy.map(c => c.companyId), ...zus.map(z => z.state.companyId)].filter((x): x is number => x != null))];
  const names = new Map((companyIds.length ? await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, companyIds)) : []).map(c => [c.id, c.name]));
  const forCo = (docCompany: number | null, co: number | null) => docCompany == null || co == null || docCompany === co;
  // (студент до 26 до ZUS не зголошується — у нього ZUA просто немає, і порівнюються лише умова з powiadomieniem)

  for (const co of companyIds.length ? companyIds : [null]) {
    const companyName = co != null ? names.get(co) ?? null : null;
    const umowa = umowy.filter(c => forCo(c.companyId, co)).map(c => dateStr(c.dateFrom)).filter((d): d is string => !!d).sort()[0] ?? null;
    // powiadomienie цього найму на цю фірму: «праця від» — фактичний перший день (attrs.dateFromActual), далі validFrom
    const pow = docs.filter(d => typeOf.get(d.docTypeId!)?.code === "powiadomienie_ua" && forCo(d.employerCompanyId ?? null, co))
      .map(d => (typeof (d.attrs as Record<string, unknown> | null)?.dateFromActual === "string" ? String((d.attrs as Record<string, unknown>).dateFromActual).slice(0, 10) : dateStr(d.validFrom)))
      .filter((d): d is string => thisHire(d)).sort().pop() ?? null;
    const openReg = zus.filter(z => z.state.kind === "reg" && z.state.status === "open" && forCo(z.companyId, co)).map(z => z.date).filter(thisHire).sort().pop() ?? null;
    const present = [umowa, pow, openReg].filter((d): d is string => !!d);
    if (present.length >= 2 && new Set(present).size > 1) out.push({ code: "start_mismatch", companyId: co, companyName, umowa, powiadomienie: pow, zua: openReg });

    // ZUA раніше за початок дії дозволу на працю (чинного на дату зголошення немає)
    if (openReg) {
      const permits = docs.filter(d => PERMIT_CODES.includes(typeOf.get(d.docTypeId!)?.code ?? "") && forCo(d.employerCompanyId ?? null, co) && dateStr(d.validFrom));
      if (permits.length && permits.every(d => dateStr(d.validFrom)! > openReg)) {
        const first = permits.sort((a, b) => dateStr(a.validFrom)!.localeCompare(dateStr(b.validFrom)!))[0]!;
        out.push({ code: "zua_before_permit", companyId: co, companyName, zua: openReg, permitFrom: dateStr(first.validFrom)!, permitName: typeOf.get(first.docTypeId!)?.name ?? "" });
      }
    }
    // ZWUA = день після звільнення
    if (!w.isActive && w.firedAt) {
      const fireDate = dateStr(w.firedAt)!;
      const expected = addDaysStr(fireDate, 1);
      const dereg = zus.filter(z => z.state.kind === "dereg" && forCo(z.companyId, co) && z.date >= addDaysStr(fireDate, -14)).map(z => z.date).sort().pop() ?? null;
      if (dereg && dereg !== expected) out.push({ code: "zwua_mismatch", companyId: co, companyName, zwua: dereg, expected, fireDate });
    }
  }
  return out;
}
