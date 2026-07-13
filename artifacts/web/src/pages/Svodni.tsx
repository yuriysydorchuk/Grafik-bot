// «Сводні» — повне дзеркало зарплатних таблиць по містах (Люблін/Познань/Лодзь).
// Вкладка = фабрика; кожна клітинка редагується (рядок стає «ручним» і синк із
// Google його більше не перезаписує — сайт є джерелом). Відкритий шар: фактичні
// години, ставки, відрахування, до виплати. Закритий (księgowość/готівка/конто)
// приходить з API лише з capability svodniSensitive — показуємо, що прийшло.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Link2, CircleAlert, CircleCheck, Users, PencilLine, Columns3,
  Coins, CreditCard, Banknote, PiggyBank, HandCoins,
  Home, Gavel, IdCard, GraduationCap, Wallet, UserPlus, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { get, post, patch, del } from "../lib/api";
import { Button, Card, Empty, Badge, Spinner, Select, Modal, Input } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { PageHeader } from "../components/Layout";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";

type Row = {
  id: number; city: string; firm: string | null; factoryLabel: string; factoryId: number | null;
  section: string | null; rawName: string; workerId: number | null; workerName: string | null;
  linkStatus: string; manual: boolean;
  hoursNotified: number | null; hours: number | null; shifts: number | null;
  rateBrutto: number | null; rateNetto: number | null; premia: number | null;
  zaliczka: number | null; zaliczkaBd: number | null; hostel: number | null; odziez: number | null;
  dojazd: number | null; kara: number | null; komornik: number | null; kaucja: number | null;
  potracenia: number | null; doWyplaty: number | null; brutto: number | null;
  isStudent: boolean | null; under26: boolean | null;
  hoursDeclared?: number | null; ksiegBrutto?: number | null; ksiegNetto?: number | null;
  gotowka?: number | null; konto?: number | null;
  extras: Record<string, number | string>; hr: Record<string, string>;
  mismatch: Record<string, { ours: number; sheet: number }> | null;
  rowColor: string | null;
};
type Check = { city: string; factoryLabel: string; metric: string; ours: number | null; sheetSuma: number | null; summaryTab: number | null; ok: boolean };
type TabMeta = { city: string; factoryLabel: string; colOrder: string[]; info: { stawkaEurocash?: (string | number)[][] } };
type Data = { month: string; cities: string[]; rows: Row[]; checks: Check[]; tabMeta?: TabMeta[]; sensitive: boolean };
type Unmatched = { rawName: string; city: string; factories: string[]; months: string[]; candidates: { id: number; name: string }[] };

// колонки відкритого шару: [поле, заголовок]
const OPEN_COLS: [keyof Row & string, string][] = [
  ["hoursNotified", "Год. повід."], ["hours", "Години"], ["shifts", "Зміни"],
  ["rateBrutto", "Ставка бр."], ["rateNetto", "Ставка нет."], ["premia", "Премія"],
  ["zaliczka", "Zaliczka"], ["zaliczkaBd", "Zaliczka BD"], ["hostel", "Hostel"],
  ["odziez", "Odzież"], ["dojazd", "Dojazd"], ["kara", "Kara"], ["komornik", "Komornik"],
  ["kaucja", "Kaucja"], ["potracenia", "Potrącenia"], ["doWyplaty", "До виплати"], ["brutto", "Brutto"],
];
const SENS_COLS: [keyof Row & string, string][] = [
  ["hoursDeclared", "Год. księg."], ["ksiegBrutto", "Księg. brutto"], ["ksiegNetto", "Księg. netto (конто)"], ["gotowka", "Готівка"],
];
// кадрові текстові колонки (hr.*) + ZUS-статус (extras.zusStatus): базовий набір
// показується завжди, решта (Stanowisko, Linia, Nr osobowy…) — коли є дані в місті
const HR_COLS: [string, string][] = [
  ["extras.zusStatus", "Księgowość (статус)"],
  ["hr.zaswiadczenieDo", "Zaświadczenie до"],
  ["hr.zaswiadczenieWystawione", "Zaśw. виставлено"],
  ["hr.wniosekZaliczki", "Wniosek zaliczki"],
  ["hr.dataUrodzenia", "Дата народження"],
];
const HR_LABEL: Record<string, string> = {
  zusStatus: "Księgowość (статус)", zaswiadczenieDo: "Zaświadczenie до",
  zaswiadczenieWystawione: "Zaśw. виставлено", wniosekZaliczki: "Wniosek zaliczki",
  dataUrodzenia: "Дата народження", nrOsobowy: "Nr osobowy", stanowisko: "Stanowisko",
  linia: "Linia", szkolenie: "Szkolenie", oddzial: "Oddział", firma: "Firma",
  status: "Status", umowaOd: "Umowa od", umowaDo: "Umowa do",
  dataStart: "Початок роботи", dataLiczymy: "Дата відліку", dataWypowiedzenia: "Wypowiedzenie",
  dniOdpracowane: "Дні відпрац.", koniecStudiow: "Кінець студій", uwagi: "Uwagi",
  powOsw: "Pow./Ośw.", hoursText: "Години (текст)", kontoNr: "Nr konta",
};
const EXTRA_LABEL: Record<string, string> = {
  nocneH: "Нічні [год]", doplataNocna: "Допл. нічні", oplataKierowcy: "Оплата водія",
  doplataEs: "Dopłata ES", badania: "Badania", nakladki: "Nakładki", zwrotKosztow: "Zwrot kosztów",
  kartaPobytu: "Karta pobytu", karaKlient: "Кара клієнта", karaEs: "Кара ES",
  zadluzenie: "Заборгованість", migawka: "Migawka", dokumenty: "Dokumenty", workListHours: "Work List [год]",
  premiaBase: "Premia (кол.)", premiaAgram: "Premia Agram", premiaEs: "Premia ES",
  ksiegHours: "Godzin faktycznie", kontoH: "Конто [год]", gotowkaH: "Готівка [год]",
};
const EXTRA_ORDER = Object.keys(EXTRA_LABEL);
const extraLabel = (k: string) => EXTRA_LABEL[k] ?? k;
const EXTRA_STUDENTS = "Додаткові студенти";
const OFFICE_CITY = "Офіс"; // віртуальна вкладка поряд із містами
const OFFICE_RE = /^OFFICE|^ОФИС|^ОФІС|^OFIS/i;
const isSpecial = (label: string) => OFFICE_RE.test(label) || label === EXTRA_STUDENTS;
const fmt = (v: unknown) => typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "";
const r2 = (n: number) => Math.round(n * 100) / 100;
const STD_RATIO = 31.4 / 25.35;

export default function Svodni() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [month, setMonth] = useState<string>("");
  const [city, setCity] = useState<string>("");
  const [factory, setFactory] = useState<string>("");
  const [showLinks, setShowLinks] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [hideEmptyCols, setHideEmptyCols] = useState(() => localStorage.getItem("svodni.hideEmptyCols") === "1");
  const [hideKsieg, setHideKsieg] = useState(() => localStorage.getItem("svodni.hideKsieg") === "1");
  const toggleEmptyCols = () => setHideEmptyCols(v => { localStorage.setItem("svodni.hideEmptyCols", v ? "0" : "1"); return !v; });
  const toggleKsieg = () => setHideKsieg(v => { localStorage.setItem("svodni.hideKsieg", v ? "0" : "1"); return !v; });
  // видимість колонок: дефолт — усі; вибір зберігається в браузері
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("svodni.hiddenCols") ?? "[]")); } catch { return new Set(); }
  });
  const setHidden = (n: Set<string>) => {
    setHiddenCols(n);
    try { localStorage.setItem("svodni.hiddenCols", JSON.stringify([...n])); } catch { /* ignore */ }
  };
  const toggleCol = (k: string) => {
    const n = new Set(hiddenCols);
    n.has(k) ? n.delete(k) : n.add(k);
    setHidden(n);
  };

  const { data: monthsData } = useQuery<{ months: string[] }>({ queryKey: ["svodni-months"], queryFn: () => get("/svodni/months") });
  const months = monthsData?.months ?? [];
  const effMonth = month || months[0] || "";

  const { data, isFetching } = useQuery<Data>({
    queryKey: ["svodni", effMonth], enabled: !!effMonth,
    queryFn: () => get(`/svodni?month=${effMonth}`),
  });
  const cityTabs = useMemo(() => [
    ...(data?.cities ?? []).filter(c => c !== OFFICE_CITY),
    ...(data?.sensitive ? [OFFICE_CITY] : []),
  ], [data]);
  const effCity = cityTabs.includes(city) ? city : cityTabs[0] ?? "";
  // «Офіс» збирає офісні вкладки всіх міст + додаткових студентів;
  // з міських вкладок вони відповідно прибрані
  const cityRows = useMemo(() => (data?.rows ?? []).filter(r =>
    effCity === OFFICE_CITY ? isSpecial(r.factoryLabel) : (r.city === effCity && !isSpecial(r.factoryLabel))
  ), [data, effCity]);
  // фабрики міста: з рядків ∪ зі звірок імпорту — порожні вкладки (фабрика без
  // людей цього місяця) теж мають бути видимі з повним набором колонок
  const factories = useMemo(() => {
    const set = new Set(cityRows.map(r => r.factoryLabel));
    if (effCity === OFFICE_CITY) {
      set.add(EXTRA_STUDENTS); // завжди доступна для наповнення
    } else {
      for (const c of (data?.checks ?? [])) {
        if (c.city === effCity && !c.factoryLabel.includes(" + ") && !isSpecial(c.factoryLabel)) set.add(c.factoryLabel);
      }
    }
    const rank = (f: string) => f === EXTRA_STUDENTS ? 2 : cityRows.some(r => r.factoryLabel === f) ? 0 : 1;
    return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [cityRows, data, effCity]);
  const effFactory = factories.includes(factory) ? factory : factories[0] ?? "";
  useEffect(() => { if (factory && !factories.includes(factory) && factories.length) setFactory(factories[0]!); }, [factories]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => cityRows.filter(r => r.factoryLabel === effFactory), [cityRows, effFactory]);
  const checks = useMemo(() => (data?.checks ?? []).filter(c => c.factoryLabel.split(" + ").includes(effFactory)), [data, effFactory]);
  // extras, що зустрічаються в місті цього місяця (усі числові ключі з даних,
  // не лише відомі каталогу — фабричні нюанси на кшталт Sushi мають свої колонки)
  const cityExtraKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of cityRows) for (const [k, v] of Object.entries(r.extras)) {
      if (typeof v === "number" && k !== "blockOnly") keys.add(k);
    }
    const idx = (k: string) => { const i = EXTRA_ORDER.indexOf(k); return i < 0 ? EXTRA_ORDER.length : i; };
    return [...keys].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
  }, [cityRows]);
  // кадрові колонки: базовий набір + усі hr-ключі, що є в даних міста
  const cityHrCols = useMemo(() => {
    const cols = new Map<string, string>(HR_COLS);
    const order = Object.keys(HR_LABEL);
    const found = new Set<string>();
    for (const r of cityRows) for (const k of Object.keys(r.hr)) if (r.hr[k]) found.add(k);
    const dynamic = [...found].filter(k => !cols.has(`hr.${k}`))
      .sort((a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1) || a.localeCompare(b));
    for (const k of dynamic) cols.set(`hr.${k}`, HR_LABEL[k] ?? k);
    return [...cols.entries()] as [string, string][];
  }, [cityRows]);
  const allColumns: [string, string][] = useMemo(() => [
    ...OPEN_COLS as [string, string][],
    ...cityExtraKeys.map(k => [`extras.${k}`, extraLabel(k)] as [string, string]),
    ...cityHrCols,
    ...(data?.sensitive ? SENS_COLS as [string, string][] : []),
  ], [cityExtraKeys, cityHrCols, data?.sensitive]);
  const visible = useMemo(() => {
    const v = new Set(allColumns.map(([k]) => k).filter(k => !hiddenCols.has(k)));
    if (hideKsieg) for (const [k] of SENS_COLS) v.delete(k);
    return v;
  }, [allColumns, hiddenCols, hideKsieg]);

  const sync = useMutation({
    mutationFn: () => post("/svodni/sync", { months: [effMonth] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["svodni"] }); toast.success(t("Синхронізовано з Google")); },
    onError: (e: any) => toast.error(e.message),
  });
  const rematch = useMutation({
    mutationFn: () => post<{ linked: number }>("/svodni/rematch", {}),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["svodni"] }); qc.invalidateQueries({ queryKey: ["svodni-unmatched"] }); toast.success(t("Підвʼязано рядків: {n}", { n: r.linked })); },
    onError: (e: any) => toast.error(e.message),
  });
  const applyRates = useMutation({
    mutationFn: () => post<{ updated: number }>("/svodni/apply-rates", { month: effMonth }),
    onSuccess: (r) => toast.success(t("Оновлено працівників: {n}", { n: r.updated })),
    onError: (e: any) => toast.error(e.message),
  });

  // маркери на вкладки фабрик: розбіжності/ручні правки
  const factoryFlags = useMemo(() => {
    const m = new Map<string, { count: number; mismatch: boolean; manual: boolean }>();
    for (const f of factories) {
      const fr = cityRows.filter(r => r.factoryLabel === f);
      m.set(f, { count: fr.length, mismatch: fr.some(r => r.mismatch), manual: fr.some(r => r.manual) });
    }
    return m;
  }, [factories, cityRows]);

  return (
    <>
      <PageHeader title={t("Сводні")} subtitle={t("Зарплатні таблиці по містах — дзеркало з перевіркою формул")} />

      {/* панель керування */}
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={effMonth} onChange={e => setMonth(e.target.value)} className="font-medium">
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
          <div className="flex rounded-xl bg-slate-100 p-1">
            {cityTabs.map(c => (
              <button key={c} onClick={() => { setCity(c); setFactory(""); }}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${effCity === c ? "bg-white text-red-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {c === OFFICE_CITY ? "🏢 " : ""}{t(c)}
              </button>
            ))}
          </div>
          <div className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" />
          <button onClick={() => setShowCols(v => !v)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${showCols ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            <Columns3 className="h-3.5 w-3.5" /> {t("Колонки")}
          </button>
          <button onClick={toggleEmptyCols}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${hideEmptyCols ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}
            title={t("Ховає колонки без жодного значення в цій фабриці")}>
            {t("Без порожніх колонок")}
          </button>
          {data?.sensitive && (
            <button onClick={toggleKsieg}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${hideKsieg ? "bg-amber-500 text-white" : "text-amber-700 hover:bg-amber-50"}`}
              title={t("Швидко сховати/показати księgowe колонки")}>
              {hideKsieg ? t("Księgowe: сховано") : t("Księgowe: видно")}
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setShowLinks(v => !v)}><Users className="h-4 w-4" /> {t("Привʼязки")}</Button>
            <Button variant="secondary" loading={rematch.isPending} onClick={() => rematch.mutate()} title={t("Пробує підвʼязати нерозпізнаних людей до працівників")}><Link2 className="h-4 w-4" /></Button>
            <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()} title={t("Синк із Google")}><RefreshCw className="h-4 w-4" /></Button>
            {can(me, "viewFinance") && (
              <Button variant="secondary" loading={applyRates.isPending} onClick={() => applyRates.mutate()}>{t("Ставки → профілі")}</Button>
            )}
          </div>
        </div>

        {/* фільтр колонок */}
        {showCols && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="mb-2 flex items-center gap-3 text-[11px]">
              <span className="font-semibold uppercase tracking-wide text-slate-400">{t("Видимі колонки")}</span>
              <button className="text-red-600 hover:underline" onClick={() => setHidden(new Set())}>{t("показати всі")}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allColumns.map(([k, h]) => {
                const on = !hiddenCols.has(k);
                return (
                  <button key={k} onClick={() => toggleCol(k)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${on ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-slate-50 text-slate-400 ring-1 ring-slate-200 line-through"}`}>
                    {t(h)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      {/* вкладки фабрик міста */}
      {factories.length > 0 && (
        <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
          {factories.map(f => {
            const fl = factoryFlags.get(f)!;
            const active = effFactory === f;
            const special = f === EXTRA_STUDENTS;
            return (
              <button key={f} onClick={() => setFactory(f)}
                className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                  active ? "border-red-600 bg-red-600 text-white shadow-sm"
                  : special ? "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400"
                  : "border-slate-200 bg-white text-slate-600 hover:border-red-300"}`}>
                {f === EXTRA_STUDENTS ? "🎓 " : OFFICE_RE.test(f) ? "🏢 " : ""}{f}
                <span className={`rounded-full px-1.5 text-[10px] font-medium ${active ? "bg-red-500 text-red-50" : "bg-slate-100 text-slate-500"}`}>{fl.count}</span>
                {fl.mismatch && <span title={t("є розбіжності формул")}>⚠</span>}
                {fl.manual && <PencilLine className={`h-3 w-3 ${active ? "text-red-100" : "text-sky-500"}`} />}
              </button>
            );
          })}
        </div>
      )}

      {showLinks && <UnmatchedPanel />}

      {isFetching && !data ? <Spinner /> : !factories.length ? (
        <Empty>{t("Немає даних за цей місяць — запусти «Синк із Google»")}</Empty>
      ) : (
        <div className="space-y-4">
          <FactoryTable month={effMonth} city={effCity} label={effFactory} rows={rows} checks={checks} sensitive={!!data?.sensitive}
            visible={visible} cityExtraKeys={cityExtraKeys} cityHrCols={cityHrCols} hideEmptyCols={hideEmptyCols} onHideCol={toggleCol} cityRows={cityRows}
            meta={data?.tabMeta?.find(m => m.factoryLabel === effFactory && (effCity === OFFICE_CITY || m.city === effCity))} />
          <SummaryBlock rows={rows} sensitive={!!data?.sensitive} />
        </div>
      )}
    </>
  );
}

// Заголовок колонки з кнопкою «сховати» (зʼявляється при наведенні)
function Th({ label, onHide, left, amber, strong }: { label: string; onHide: () => void; left?: boolean; amber?: boolean; strong?: boolean }) {
  return (
    <th className={`group/th px-1.5 py-2.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide ${
      left ? "text-left" : "text-right"} ${amber ? "bg-amber-50 text-amber-700/70" : strong ? "bg-red-50/70 text-red-700/80" : "text-slate-400"}`}>
      <span className="inline-flex items-center gap-0.5">
        {label}
        <button type="button" onClick={onHide} title="Сховати колонку"
          className="invisible rounded px-0.5 text-slate-300 hover:bg-slate-200 hover:text-slate-600 group-hover/th:visible">×</button>
      </span>
    </th>
  );
}

// Редагована клітинка: клік → інпут (для кадрових — випадаючий список значень
// колонки, як data validation в екселі), Enter/blur → PATCH. Порожнє = очистити.
function EditableCell({ row, field, value, month, text, strong, options }: {
  row: Row; field: string; value: unknown; month: string; text?: boolean; strong?: boolean; options?: string[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [freeText, setFreeText] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (v: string) => patch<Row>(`/svodni/rows/${row.id}`, { field, value: v === "" ? null : v }),
    onSuccess: (updated) => {
      qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: old.rows.map(r => r.id === updated.id ? updated : r) } : old);
      setEditing(false);
      setFreeText(false);
    },
    onError: (e: any) => { toast.error(e.message); setEditing(false); setFreeText(false); },
  });
  if (editing && options?.length && !freeText) {
    // випадаючий список значень колонки (як в екселі) + «(інше…)» для свого тексту
    return (
      <select autoFocus value={draft}
        onChange={e => { if (e.target.value === "__other__") { setFreeText(true); setDraft(""); } else save.mutate(e.target.value); }}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
        className="w-44 rounded-md border border-red-400 bg-white px-1 py-1 text-left text-xs shadow-sm focus:outline-none">
        <option value="">{"—"}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
        <option value="__other__">{t("(інше…)")}</option>
      </select>
    );
  }
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => save.mutate(draft)}
        onKeyDown={e => { if (e.key === "Enter") save.mutate(draft); if (e.key === "Escape") { setEditing(false); setFreeText(false); } }}
        className={`rounded-md border border-red-400 bg-white px-1 py-1 text-right text-xs shadow-sm focus:outline-none ${text ? "w-40 text-left" : "w-20"}`} />
    );
  }
  return (
    <button type="button"
      onClick={() => { setDraft(value == null ? "" : String(value)); setEditing(true); }}
      title={t("Клікни, щоб редагувати")}
      className={`block w-full cursor-text rounded px-1 py-1 tabular-nums transition hover:bg-red-50 hover:ring-1 hover:ring-red-200 ${
        text ? "text-left" : "text-right"} ${strong ? "font-semibold text-slate-900" : ""}`}>
      {text ? (String(value ?? "") || <span className="text-slate-300">—</span>) : (fmt(value) || <span className="text-slate-300">—</span>)}
    </button>
  );
}

function FactoryTable({ month, city, label, rows, checks, sensitive, visible, cityExtraKeys, cityHrCols, hideEmptyCols, onHideCol, cityRows, meta }: {
  month: string; city: string; label: string; rows: Row[]; checks: Check[]; sensitive: boolean;
  visible: Set<string>; cityExtraKeys: string[]; cityHrCols: [string, string][]; hideEmptyCols: boolean;
  onHideCol: (key: string) => void; cityRows: Row[]; meta?: TabMeta;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const removeRow = useMutation({
    mutationFn: (id: number) => del(`/svodni/rows/${id}`),
    onSuccess: (_r, id) => qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: old.rows.filter(r => r.id !== id) } : old),
    onError: (e: any) => toast.error(e.message),
  });
  const hrVal = (r: Row, k: string) => k.startsWith("hr.") ? r.hr[k.slice(3)] : (r.extras as any)[k.slice(7)];
  // «порожня колонка» = жодного значення в поточній фабриці (тумблер зверху)
  const hasVal = (k: string) => rows.some(r =>
    k.startsWith("extras.") ? r.extras[k.slice(7)] != null :
    k.startsWith("hr.") ? !!r.hr[k.slice(3)] :
    (r as any)[k] != null);
  // у порожній фабриці колонки показуються всі (інакше не було б чого бачити)
  const show = (k: string) => visible.has(k) && (!hideEmptyCols || rows.length === 0 || hasVal(k));
  // єдиний список колонок у порядку таблиці Google (colOrder вкладки);
  // колонки поза colOrder — у каталожному порядку в кінці, закритий шар — окремо
  const cols = useMemo(() => {
    const defs: { key: string; label: string; kind: "open" | "extra" | "hr" }[] = [
      ...OPEN_COLS.map(([k, h]) => ({ key: k as string, label: h, kind: "open" as const })),
      ...cityExtraKeys.map(k => ({ key: `extras.${k}`, label: extraLabel(k), kind: "extra" as const })),
      ...cityHrCols.map(([k, h]) => ({ key: k, label: h, kind: "hr" as const })),
    ];
    const orderIdx = new Map((meta?.colOrder ?? []).map((k, i) => [k, i]));
    return defs
      .map((d, i) => ({ ...d, ord: orderIdx.get(d.key) ?? 1000 + i }))
      .sort((a, b) => a.ord - b.ord);
  }, [cityExtraKeys, cityHrCols, meta]);
  const shownCols = cols.filter(d => show(d.key));
  const sensCols = sensitive ? SENS_COLS.filter(([k]) => show(k)) : [];
  const colCount = 1 + shownCols.length + sensCols.length;
  // м'який фон рядка з кольору позначки в таблиці (блендинг із білим)
  const tint = (hex: string, a: number) => {
    const v = (o: number) => Math.round(255 - (255 - parseInt(hex.slice(o, o + 2), 16)) * a);
    return `rgb(${v(1)},${v(3)},${v(5)})`;
  };
  // випадаючі списки кадрових колонок: унікальні значення колонки по місту (як в екселі)
  const hrOptions = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [k] of cityHrCols) {
      const vals = [...new Set(cityRows.map(r => String(hrVal(r, k) ?? "")).filter(Boolean))].sort();
      m.set(k, vals);
    }
    return m;
  }, [cityRows, cityHrCols]);
  const badChecks = checks.filter(c => !c.ok);
  const sum = (f: (r: Row) => number | null | undefined) => r2(rows.reduce((a, r) => a + (f(r) ?? 0), 0));

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
        <span className="text-sm font-bold tracking-tight text-slate-800">{label}</span>
        <Badge color="slate">{rows.length} {t("ос.")}</Badge>
        {rows.some(r => r.manual) && <Badge color="blue">✎ {t("є ручні правки")}</Badge>}
        {badChecks.length
          ? <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" title={badChecks.map(c => `${c.metric}: ${c.ours} ≠ ${c.sheetSuma ?? c.summaryTab}`).join("; ")}>
              <CircleAlert className="h-3.5 w-3.5" /> {t("суми не сходяться")}
            </span>
          : <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"><CircleCheck className="h-3.5 w-3.5" /> {t("звірено")}</span>}
        <span className="ml-auto text-[11px] text-slate-400">{t("клік по клітинці — редагування")}</span>
        <button onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700">
          <UserPlus className="h-3.5 w-3.5" /> {t("Додати людину")}
        </button>
      </div>
      {adding && <AddPersonModal month={month} factoryLabel={label} onClose={() => setAdding(false)}
        city={rows[0]?.city ?? (label === EXTRA_STUDENTS ? OFFICE_CITY : city)} />}
      {meta?.info?.stawkaEurocash && (
        <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Ставки Eurocash (за діапазонами годин)")}</div>
          <div className="overflow-x-auto">
            <table className="border-collapse text-[11px]">
              <tbody>
                {meta.info.stawkaEurocash.map((row, i) => (
                  <tr key={i} className={i === 0 ? "font-semibold text-slate-700" : "text-slate-600"}>
                    {row.map((c, j) => (
                      <td key={j} className={`whitespace-nowrap border border-slate-200 bg-white px-2 py-1 tabular-nums ${j === 0 ? "font-medium text-slate-500" : "text-right"}`}>
                        {typeof c === "number" ? fmt(r2(c)) : c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-20 bg-white shadow-sm">
            <tr>
              <th className="sticky left-0 z-30 bg-white px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Працівник")}</th>
              {shownCols.map(d => <Th key={d.key} label={t(d.label)} strong={d.key === "doWyplaty"} left={d.kind === "hr"} onHide={() => onHideCol(d.key)} />)}
              {sensCols.map(([k, h]) => <Th key={k} label={t(h)} amber onHide={() => onHideCol(k)} />)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr><td colSpan={colCount} className="px-3 py-6 text-center text-sm text-slate-400">{t("У цій фабриці немає людей цього місяця")}</td></tr>
            )}
            {rows.map((r, i) => {
              const sectionChanged = r.section && r.section !== rows[i - 1]?.section;
              return [
                sectionChanged ? (
                  <tr key={`sec-${r.id}`} className="bg-slate-50/80">
                    <td colSpan={colCount} className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{r.section}</td>
                  </tr>
                ) : null,
                <tr key={r.id} className={`group/row transition ${r.mismatch ? "bg-rose-50/60" : "hover:bg-red-50/30"}`}
                  style={r.rowColor ? { backgroundColor: tint(r.rowColor, 0.3) } : undefined}>
                  <td className={`sticky left-0 z-10 max-w-56 whitespace-nowrap px-3 py-1 ${r.mismatch ? "bg-rose-50" : "bg-white group-hover/row:bg-red-50/60"}`}
                    style={r.rowColor ? { backgroundColor: tint(r.rowColor, 0.3), boxShadow: `inset 3px 0 0 ${r.rowColor}` } : undefined}
                    title={r.workerName ?? r.rawName}>
                    <span className="flex max-w-full items-center gap-1.5">
                      {r.manual && <PencilLine className="h-3 w-3 shrink-0 text-sky-500" aria-label={t("є ручні правки")} />}
                      {r.workerId
                        ? <Link href={`/workers/${r.workerId}`} className="truncate font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName ?? r.rawName}</Link>
                        : <EditableCell row={r} field="rawName" value={r.rawName} month={month} text />}
                      {r.linkStatus === "unmatched" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title={t("Немає в системі")} />}
                      {r.isStudent && <span className="rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700">STUD</span>}
                      {r.under26 && <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700">&lt;26</span>}
                      {r.mismatch && (
                        <span className="cursor-help text-[11px] font-medium text-rose-600"
                          title={Object.entries(r.mismatch).map(([k, v]) => `${k}: ${t("наш розрахунок")} ${v.ours} ≠ ${t("у таблиці")} ${v.sheet}`).join("\n")}>
                          ⚠
                        </span>
                      )}
                      <button type="button" title={t("Видалити рядок")}
                        onClick={async () => { if (await confirm({ title: t("Видалити рядок?"), message: `${r.rawName} — ${t("рядок зникне зі сводної цього місяця")}`, confirmText: t("Видалити") })) removeRow.mutate(r.id); }}
                        className="invisible ml-0.5 rounded p-0.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500 group-hover/row:visible">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </td>
                  {shownCols.map(d => d.kind === "hr" ? (
                    <td key={d.key} className="max-w-48 px-1 py-0.5 text-left text-slate-500">
                      <EditableCell row={r} field={d.key} value={hrVal(r, d.key)} month={month} text options={hrOptions.get(d.key)} />
                    </td>
                  ) : (
                    <td key={d.key} className={`px-1 py-0.5 text-right ${d.key === "doWyplaty" && !r.rowColor ? "bg-red-50/40" : ""} text-slate-600`}>
                      <EditableCell row={r} field={d.key} value={d.kind === "extra" ? r.extras[d.key.slice(7)] : r[d.key as keyof Row & string]} month={month} strong={d.key === "doWyplaty"} />
                    </td>
                  ))}
                  {sensCols.map(([k]) => (
                    <td key={k} className="bg-amber-50/50 px-1 py-0.5 text-right text-slate-700">
                      <EditableCell row={r} field={k} value={r[k]} month={month} />
                    </td>
                  ))}
                </tr>,
              ];
            })}
          </tbody>
          <tfoot className="sticky bottom-0 z-20">
            <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold text-slate-800">
              <td className="sticky left-0 z-30 bg-slate-100 px-3 py-2.5">{t("Разом")}</td>
              {shownCols.map(d => d.kind === "hr" || ["rateBrutto", "rateNetto"].includes(d.key) ? <td key={d.key} /> : (
                <td key={d.key} className={`px-1.5 py-2.5 text-right tabular-nums ${d.key === "doWyplaty" ? "text-red-700" : ""}`}>
                  {fmt(sum(r => d.kind === "extra"
                    ? (typeof r.extras[d.key.slice(7)] === "number" ? r.extras[d.key.slice(7)] as number : 0)
                    : r[d.key as keyof Row & string] as number | null))}
                </td>
              ))}
              {sensCols.map(([k]) => <td key={k} className="bg-amber-100/70 px-1.5 py-2.5 text-right tabular-nums">{fmt(sum(r => r[k] as number | null))}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// Підсумок фабрики: ЗП/карта/податки/готівка/економія/аванси/хостел/штрафи/karta pobytu.
// Чутливі позиції — лише коли API віддав закритий шар. Тултіп = формула з числами.
function SummaryBlock({ rows, sensitive }: { rows: Row[]; sensitive: boolean }) {
  const t = useT();
  const sum = (f: (r: Row) => number | null | undefined) => r2(rows.reduce((a, r) => a + (f(r) ?? 0), 0));
  const ex = (r: Row, k: string) => (typeof r.extras[k] === "number" ? (r.extras[k] as number) : 0);
  const z = (n: number) => `${n.toFixed(2)} zł`;

  const total = sum(r => r.doWyplaty);
  const konto = sum(r => r.konto ?? r.ksiegNetto);
  const ksiegBrutto = sum(r => (r.ksiegBrutto != null && r.ksiegNetto != null && r.ksiegBrutto > r.ksiegNetto) ? r.ksiegBrutto : 0);
  const workerTax = r2(ksiegBrutto - sum(r => (r.ksiegBrutto != null && r.ksiegNetto != null && r.ksiegBrutto > r.ksiegNetto) ? r.ksiegNetto : 0));
  const taxableBrutto = sum(r => (r.ksiegBrutto != null && r.ksiegNetto != null && r.ksiegBrutto > r.ksiegNetto + 0.01) ? r.ksiegBrutto : 0);
  const employerZus = r2(taxableBrutto * 0.2048);
  const gotowka = sum(r => r.gotowka);
  // економія: якби готівкова частина йшла офіційно — брутто-еквівалент + ZUS
  // роботодавця мінус сама готівка; студенти без податків → економії немає
  const savedParts = rows.reduce((acc, r) => {
    const g = r.gotowka ?? 0;
    if (!g || r.isStudent) return acc;
    const ratio = r.rateBrutto && r.rateNetto && r.rateBrutto > r.rateNetto ? r.rateBrutto / r.rateNetto : STD_RATIO;
    if (ratio <= 1) return acc;
    const bruttoEq = g * ratio;
    return { got: acc.got + g, bruttoEq: acc.bruttoEq + bruttoEq };
  }, { got: 0, bruttoEq: 0 });
  const saved = r2((savedParts.bruttoEq - savedParts.got) + savedParts.bruttoEq * 0.2048);
  const zalA = sum(r => r.zaliczka), zalBd = sum(r => r.zaliczkaBd);
  const zaliczki = r2(zalA + zalBd);
  const hostel = sum(r => r.hostel);
  const karaSum = sum(r => r.kara), karaKl = sum(r => ex(r, "karaKlient")), karaEs = sum(r => ex(r, "karaEs"));
  const kary = r2(karaSum + karaKl + karaEs);
  const kartaPobytu = sum(r => ex(r, "kartaPobytu"));
  const stud = rows.filter(r => r.isStudent === true).length;
  const nonStud = rows.filter(r => r.isStudent === false).length;
  const unknown = rows.length - stud - nonStud;

  const Item = ({ label, value, icon: Icon, tone, formula, textValue }: {
    label: string; value?: number; icon: any; tone: string; formula: string; textValue?: string;
  }) => (
    <div className="group relative flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 transition hover:border-slate-300 hover:shadow-sm">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-slate-400">{label}</div>
        <div className="text-sm font-bold tabular-nums text-slate-800">{textValue ?? z(value!)}</div>
      </div>
      <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-max max-w-md rounded-lg bg-slate-800 px-3 py-2 text-[11px] leading-relaxed text-white shadow-xl group-hover:block">
        {formula}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Item label={t("Загальна ЗП")} value={total} icon={Coins} tone="bg-slate-800 text-white"
        formula={`${t("Σ колонки «До виплати» по рядках фабрики")} = ${z(total)}`} />
      {sensitive && <Item label={t("ЗП на карту")} value={konto} icon={CreditCard} tone="bg-sky-50 text-sky-600"
        formula={`${t("Σ «Księg. netto (конто)» — офіційна частина, що йде на рахунок")} = ${z(konto)}`} />}
      {sensitive && <Item label={t("ЗП готівкою")} value={gotowka} icon={Banknote} tone="bg-amber-50 text-amber-600"
        formula={`${t("Σ колонки «Готівка»")} = ${z(gotowka)}`} />}
      {sensitive && <Item label={t("Зекономлено на готівці (оцінка)")} value={saved} icon={PiggyBank} tone="bg-emerald-50 text-emerald-600"
        formula={`${t("Якби готівку платили офіційно: (брутто-еквівалент − готівка) + брутто-еквівалент × 20,48% ZUS. Студенти не рахуються — у них податків немає.")} (${z(savedParts.bruttoEq)} − ${z(savedParts.got)}) + ${z(savedParts.bruttoEq)} × 0,2048 = ${z(saved)}`} />}
      {sensitive && <Item label={t("Податки разом (я плачу)")} value={r2(workerTax + employerZus)} icon={Wallet} tone="bg-rose-600 text-white"
        formula={`${t("Утримання з працівника + ZUS роботодавця — повна податкова вартість офіційної частини")}: (${z(ksiegBrutto)} − ${z(r2(ksiegBrutto - workerTax))}) + ${z(taxableBrutto)} × 0,2048 = ${z(workerTax)} + ${z(employerZus)} = ${z(r2(workerTax + employerZus))}`} />}
      <Item label={t("Аванси (zaliczki)")} value={zaliczki} icon={HandCoins} tone="bg-violet-50 text-violet-600"
        formula={`Σ Zaliczka + Σ Zaliczka BD = ${z(zalA)} + ${z(zalBd)} = ${z(zaliczki)}`} />
      <Item label={t("Хостел")} value={hostel} icon={Home} tone="bg-slate-100 text-slate-600"
        formula={`${t("Σ колонки Hostel")} = ${z(hostel)}`} />
      <Item label={t("Штрафи (разом)")} value={kary} icon={Gavel} tone="bg-orange-50 text-orange-600"
        formula={`Σ Kara + ${t("Кара клієнта")} + ${t("Кара ES")} = ${z(karaSum)} + ${z(karaKl)} + ${z(karaEs)} = ${z(kary)}`} />
      <Item label={t("Karta pobytu")} value={kartaPobytu} icon={IdCard} tone="bg-slate-100 text-slate-600"
        formula={`${t("Σ колонки Karta pobytu")} = ${z(kartaPobytu)}`} />
      <Item label={t("Студенти / не студенти")} icon={GraduationCap} tone="bg-sky-50 text-sky-600"
        textValue={`${stud} / ${nonStud}${unknown ? ` (+${unknown})` : ""}`}
        formula={t("Студент = без податків (netto = brutto). Невідомо — статус у сводній не вказаний.") + (unknown ? ` +${unknown} ${t("невідомо")}` : "")} />
    </div>
  );
}

// Додавання людини у сводну фабрики: пошук по базі (рядок префілиться з
// профілю) або створення нового працівника — профіль зʼявляється автоматично.
function AddPersonModal({ month, city, factoryLabel, onClose }: {
  month: string; city: string; factoryLabel: string; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const addRow = useMutation({
    mutationFn: (p: { workerId?: number; newWorkerName?: string }) =>
      post<Row>("/svodni/rows", { periodMonth: month, city, factoryLabel, ...p }),
    onSuccess: (created) => {
      qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: [...old.rows, created] } : old);
      qc.invalidateQueries({ queryKey: ["workers"] });
      toast.success(t("Додано"));
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const needle = q.trim().toLowerCase();
  const found = (workers ?? [])
    .filter(w => needle && w.fullName.toLowerCase().includes(needle))
    .slice(0, 12);
  const exact = (workers ?? []).some(w => w.fullName.toLowerCase() === needle);

  return (
    <Modal open onClose={onClose} title={`${t("Додати людину")} — ${factoryLabel} · ${month}`}>
      <div className="space-y-3">
        <Input autoFocus placeholder={t("Імʼя працівника (пошук по базі або нове)")} value={q} onChange={e => setQ(e.target.value)} />
        {needle.length >= 2 && (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {found.map(w => (
              <button key={w.id} onClick={() => addRow.mutate({ workerId: w.id })} disabled={addRow.isPending}
                className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm transition hover:border-red-300 hover:bg-red-50/40">
                <span className="font-medium text-slate-700">{w.fullName}</span>
                <span className="text-xs text-slate-400">{w.factoryName ?? ""}{w.isActive === false ? ` · ${t("звільнений")}` : ""}</span>
              </button>
            ))}
            {!exact && (
              <button onClick={() => addRow.mutate({ newWorkerName: q.trim() })} disabled={addRow.isPending}
                className="flex w-full items-center gap-2 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 px-3 py-2 text-left text-sm font-medium text-emerald-700 transition hover:bg-emerald-50">
                <UserPlus className="h-4 w-4" /> {t("Створити нового працівника")} «{q.trim()}»
              </button>
            )}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-slate-400">
          {t("Рядок префілиться з профілю (ставки, студент, до-26, дата народження). Новому працівнику профіль створюється автоматично — далі його можна заповнювати прямо з таблиці: правки ставок/статусів синхронізуються з профілем і підтягнуться в наступні місяці.")}
        </p>
      </div>
    </Modal>
  );
}

// Панель незматчених: привʼязка людини зі сводної до працівника системи
function UnmatchedPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery<{ people: Unmatched[] }>({ queryKey: ["svodni-unmatched"], queryFn: () => get("/svodni/unmatched") });
  const people = data?.people ?? [];
  const link = useMutation({
    mutationFn: (p: { rawName: string; city: string; workerId?: number; status: string }) => post("/svodni/link", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["svodni"] }); qc.invalidateQueries({ queryKey: ["svodni-unmatched"] }); toast.success(t("Збережено")); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-white px-4 py-3">
        <Users className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-bold text-slate-800">{t("Не привʼязані до працівників")}</span>
        <Badge color="amber">{people.length}</Badge>
      </div>
      {!people.length ? <div className="p-4 text-sm text-slate-400">{t("Всі рядки привʼязані")} 🎉</div> : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {people.map(p => (
                <tr key={`${p.city}-${p.rawName}`} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2 font-semibold text-slate-700">{p.rawName}</td>
                  <td className="px-2 py-2 text-slate-500">{t(p.city)} · {p.factories.join(", ")}</td>
                  <td className="px-2 py-2">
                    <span className="flex flex-wrap gap-1">
                      {p.months.map(m => <span key={m} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{m.slice(5)}.{m.slice(2, 4)}</span>)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {p.candidates.length === 0 && <span className="text-[11px] text-slate-300">{t("кандидатів немає")}</span>}
                      {p.candidates.map(c => (
                        <button key={c.id} onClick={() => link.mutate({ rawName: p.rawName, city: p.city, workerId: c.id, status: "confirmed" })}
                          className="rounded-lg bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200 transition hover:bg-emerald-100"
                          title={t("Привʼязати до")}>
                          <Link2 className="mr-0.5 inline h-3 w-3" />{c.name}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
