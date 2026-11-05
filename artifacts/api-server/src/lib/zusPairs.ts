// Пари ZUS: зголошення (ZUA / ZZA) ↔ виреєстрування (ZWUA) — по фірмі-платнику, за датами
// (зголошення #16, 05.11.2026). Раніше кожна ZUA в профілі показувалась однаково «чинне до ZWUA», а
// «зголошеним» вважався будь-хто з будь-якою ZUA фірми: у людини, яку звільнили (ZWUA) і взяли знову,
// стара ZUA рахувалась «уже є» — задача зголошення створювалась без авто-закриття, а нова ZUA
// нічим не відрізнялась від старої.
// Правила (чиста функція pairZusDocs):
//  • документи діляться по фірмі (employer_company_id); без фірми — до єдиної відомої фірми серед
//    ZUS-документів людини, інакше окремою групою «без фірми»;
//  • у групі йдемо за датою (за однакової дати виреєстрування раніше за зголошення: ZUA в день ZWUA —
//    нове безперервне зголошення, а не «закрите тим самим днем»);
//  • ZWUA закриває найпізніше ВІДКРИТЕ зголошення групи; відкритого немає — ZWUA «без пари»
//    (зголошення могли не внести в систему — це не помилка);
//  • нове зголошення при ще відкритому попередньому (ZZA → ZUA, зміна tytułu без ZWUA) — попереднє
//    «замінене», чинним лишається новіше.
// Чисте ядро (без БД) — завантаження документів і мітки для профілю: services/zusPairs.ts.
export const ZUS_REG_CODES = ["zus_zua", "zus_zza"] as const;
export const ZUS_DEREG_CODE = "zus_zwua";

export interface ZusDocIn { id: number; kind: "reg" | "dereg"; companyId: number | null; date: string; }
export type ZusPairState =
  | { kind: "reg"; status: "open"; date: string; companyId: number | null }
  | { kind: "reg"; status: "closed"; date: string; until: string; byId: number; companyId: number | null }
  | { kind: "reg"; status: "replaced"; date: string; byId: number; companyId: number | null }
  | { kind: "dereg"; date: string; closesId: number | null; regDate: string | null; companyId: number | null };

export function pairZusDocs(docs: ZusDocIn[]): Map<number, ZusPairState> {
  const out = new Map<number, ZusPairState>();
  const known = [...new Set(docs.map(d => d.companyId).filter((c): c is number => c != null))];
  const groupOf = (d: ZusDocIn) => d.companyId ?? (known.length === 1 ? known[0]! : 0);
  const groups = new Map<number, ZusDocIn[]>();
  for (const d of docs) groups.set(groupOf(d), [...(groups.get(groupOf(d)) ?? []), d]);
  for (const [group, list] of groups) {
    const companyId = group === 0 ? null : group;
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? a.id - b.id : a.kind === "dereg" ? -1 : 1));
    let open: ZusDocIn | null = null;
    for (const d of list) {
      if (d.kind === "reg") {
        if (open) out.set(open.id, { kind: "reg", status: "replaced", date: open.date, byId: d.id, companyId });
        open = d;
        out.set(d.id, { kind: "reg", status: "open", date: d.date, companyId });
      } else {
        if (open) out.set(open.id, { kind: "reg", status: "closed", date: open.date, until: d.date, byId: d.id, companyId });
        out.set(d.id, { kind: "dereg", date: d.date, closesId: open?.id ?? null, regDate: open?.date ?? null, companyId });
        open = null;
      }
    }
  }
  return out;
}
