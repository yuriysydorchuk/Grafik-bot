// «Сводні» — повне дзеркало зарплатних таблиць по містах (Люблін/Познань/Лодзь).
// Вкладка = фабрика; кожна клітинка редагується (рядок стає «ручним» і синк із
// Google його більше не перезаписує — сайт є джерелом). Відкритий шар: фактичні
// години, ставки, відрахування, до виплати. Закритий (księgowość/готівка/конто)
// приходить з API лише з capability svodniSensitive — показуємо, що прийшло.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Link2, UserX, CircleAlert, CircleCheck, Users, PencilLine, Columns3 } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { get, post, patch } from "../lib/api";
import { Button, Card, Empty, Badge, Spinner, Select } from "../components/ui";
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
};
type Check = { factoryLabel: string; metric: string; ours: number | null; sheetSuma: number | null; summaryTab: number | null; ok: boolean };
type Data = { month: string; cities: string[]; rows: Row[]; checks: Check[]; sensitive: boolean };
type Unmatched = { rawName: string; city: string; factories: string[]; months: string[]; candidates: { id: number; name: string }[] };

// колонки відкритого шару: [поле, заголовок] — показуються лише непорожні
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
const EXTRA_LABEL: Record<string, string> = {
  nocneH: "Нічні [год]", doplataNocna: "Допл. нічні", oplataKierowcy: "Оплата водія",
  doplataEs: "Dopłata ES", badania: "Badania", nakladki: "Nakładki", zwrotKosztow: "Zwrot kosztów",
  kartaPobytu: "Karta pobytu", karaKlient: "Кара клієнта", karaEs: "Кара ES",
  zadluzenie: "Заборгованість", migawka: "Migawka", dokumenty: "Dokumenty", workListHours: "Work List [год]",
};
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
  // видимість колонок: дефолт — усі; вибір зберігається в браузері
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("svodni.hiddenCols") ?? "[]")); } catch { return new Set(); }
  });
  const toggleCol = (k: string) => setHiddenCols(prev => {
    const n = new Set(prev);
    n.has(k) ? n.delete(k) : n.add(k);
    try { localStorage.setItem("svodni.hiddenCols", JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });

  const { data: monthsData } = useQuery<{ months: string[] }>({ queryKey: ["svodni-months"], queryFn: () => get("/svodni/months") });
  const months = monthsData?.months ?? [];
  const effMonth = month || months[0] || "";

  const { data, isFetching } = useQuery<Data>({
    queryKey: ["svodni", effMonth], enabled: !!effMonth,
    queryFn: () => get(`/svodni?month=${effMonth}`),
  });
  const effCity = city || data?.cities?.[0] || "";
  const cityRows = useMemo(() => (data?.rows ?? []).filter(r => r.city === effCity), [data, effCity]);
  const factories = useMemo(() => [...new Set(cityRows.map(r => r.factoryLabel))], [cityRows]);
  const effFactory = factories.includes(factory) ? factory : factories[0] ?? "";
  useEffect(() => { if (factory && !factories.includes(factory) && factories.length) setFactory(factories[0]!); }, [factories]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => cityRows.filter(r => r.factoryLabel === effFactory), [cityRows, effFactory]);
  const checks = useMemo(() => (data?.checks ?? []).filter(c => c.factoryLabel.split(" + ").includes(effFactory)), [data, effFactory]);
  // extras, що зустрічаються в місті цього місяця (колонки для фільтра)
  const cityExtraKeys = useMemo(
    () => Object.keys(EXTRA_LABEL).filter(k => cityRows.some(r => typeof r.extras[k] === "number")),
    [cityRows]);
  const allColumns: [string, string][] = useMemo(() => [
    ...OPEN_COLS as [string, string][],
    ...cityExtraKeys.map(k => [`extras.${k}`, EXTRA_LABEL[k]!] as [string, string]),
    ...(data?.sensitive ? SENS_COLS as [string, string][] : []),
  ], [cityExtraKeys, data?.sensitive]);
  const visible = useMemo(() => new Set(allColumns.map(([k]) => k).filter(k => !hiddenCols.has(k))), [allColumns, hiddenCols]);

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

  return (
    <>
      <PageHeader title={t("Сводні")} subtitle={t("Зарплатні таблиці по містах — дзеркало з перевіркою формул")} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={effMonth} onChange={e => setMonth(e.target.value)}>
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </Select>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {(data?.cities ?? []).map(c => (
            <button key={c} onClick={() => { setCity(c); setFactory(""); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${effCity === c ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
              {t(c)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setShowCols(v => !v)}><Columns3 className="h-4 w-4" /> {t("Колонки")}</Button>
          <Button variant="secondary" onClick={() => setShowLinks(v => !v)}><Users className="h-4 w-4" /> {t("Привʼязки")}</Button>
          <Button variant="secondary" loading={rematch.isPending} onClick={() => rematch.mutate()}><Link2 className="h-4 w-4" /> {t("Перематчити")}</Button>
          <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}><RefreshCw className="h-4 w-4" /> {t("Синк із Google")}</Button>
          {can(me, "viewFinance") && (
            <Button variant="secondary" loading={applyRates.isPending} onClick={() => applyRates.mutate()}>{t("Застосувати ставки в профілі")}</Button>
          )}
        </div>
      </div>

      {/* фільтр колонок: усе видно за замовчуванням, вимкнене — сховано */}
      {showCols && (
        <Card className="mb-4 p-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {allColumns.map(([k, h]) => (
              <label key={k} className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                <input type="checkbox" checked={!hiddenCols.has(k)} onChange={() => toggleCol(k)} />
                {t(h)}
              </label>
            ))}
          </div>
        </Card>
      )}

      {/* вкладки фабрик міста */}
      {factories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          {factories.map(f => (
            <button key={f} onClick={() => setFactory(f)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${effFactory === f ? "bg-slate-800 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-400"}`}>
              {f}
            </button>
          ))}
        </div>
      )}

      {showLinks && <UnmatchedPanel />}

      {isFetching && !data ? <Spinner /> : !rows.length ? (
        <Empty>{t("Немає даних за цей місяць — запусти «Синк із Google»")}</Empty>
      ) : (
        <div className="space-y-4">
          <FactoryTable month={effMonth} label={effFactory} rows={rows} checks={checks} sensitive={!!data?.sensitive}
            visible={visible} cityExtraKeys={cityExtraKeys} />
          <SummaryBlock rows={rows} sensitive={!!data?.sensitive} />
        </div>
      )}
    </>
  );
}

// Редагована клітинка: клік → інпут, Enter/blur → PATCH. Порожнє значення = очистити.
function EditableCell({ row, field, value, month, sensitive, text }: {
  row: Row; field: string; value: unknown; month: string; sensitive?: boolean; text?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (v: string) => patch<Row>(`/svodni/rows/${row.id}`, { field, value: v === "" ? null : v }),
    onSuccess: (updated) => {
      qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: old.rows.map(r => r.id === updated.id ? updated : r) } : old);
      setEditing(false);
    },
    onError: (e: any) => { toast.error(e.message); setEditing(false); },
  });
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => save.mutate(draft)}
        onKeyDown={e => { if (e.key === "Enter") save.mutate(draft); if (e.key === "Escape") setEditing(false); }}
        className={`w-20 rounded border border-red-300 px-1 py-0.5 text-right text-xs focus:outline-none ${text ? "w-40 text-left" : ""}`} />
    );
  }
  return (
    <button type="button"
      onClick={() => { setDraft(value == null ? "" : String(value)); setEditing(true); }}
      title={t("Клікни, щоб редагувати")}
      className={`block w-full cursor-text rounded px-1 py-0.5 text-right tabular-nums hover:bg-red-50 ${text ? "text-left" : ""} ${sensitive ? "" : ""}`}>
      {text ? String(value ?? "") : fmt(value) || <span className="text-slate-300">—</span>}
    </button>
  );
}

function FactoryTable({ month, label, rows, checks, sensitive, visible, cityExtraKeys }: {
  month: string; label: string; rows: Row[]; checks: Check[]; sensitive: boolean;
  visible: Set<string>; cityExtraKeys: string[];
}) {
  const t = useT();
  // колонки не ховаються за порожнечею — керує фільтр «Колонки» зверху
  const openCols = OPEN_COLS.filter(([k]) => visible.has(k));
  const sensCols = sensitive ? SENS_COLS.filter(([k]) => visible.has(k)) : [];
  const extraKeys = cityExtraKeys.filter(k => visible.has(`extras.${k}`));
  const badChecks = checks.filter(c => !c.ok);
  const sum = (f: (r: Row) => number | null | undefined) => r2(rows.reduce((a, r) => a + (f(r) ?? 0), 0));

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <Badge color="slate">{rows.length} {t("ос.")}</Badge>
        {rows.some(r => r.manual) && <Badge color="blue">✎ {t("є ручні правки")}</Badge>}
        {badChecks.length
          ? <span className="flex items-center gap-1 text-xs font-medium text-amber-600" title={badChecks.map(c => `${c.metric}: ${c.ours} ≠ ${c.sheetSuma ?? c.summaryTab}`).join("; ")}>
              <CircleAlert className="h-3.5 w-3.5" /> {t("суми не сходяться")}
            </span>
          : <span className="flex items-center gap-1 text-xs font-medium text-emerald-600"><CircleCheck className="h-3.5 w-3.5" /> {t("звірено")}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-[11px] text-slate-400">
              <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium">{t("Працівник")}</th>
              {openCols.map(([k, h]) => <th key={k} className="px-1.5 py-2 text-right font-medium whitespace-nowrap">{t(h)}</th>)}
              {extraKeys.map(k => <th key={k} className="px-1.5 py-2 text-right font-medium whitespace-nowrap">{t(EXTRA_LABEL[k]!)}</th>)}
              {sensCols.map(([k, h]) => <th key={k} className="bg-amber-50/60 px-1.5 py-2 text-right font-medium whitespace-nowrap">{t(h)}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <tr key={r.id} className={r.mismatch ? "bg-rose-50/50" : undefined}>
                <td className="sticky left-0 z-10 bg-white px-3 py-1 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {r.manual && <PencilLine className="h-3 w-3 text-sky-500" aria-label={t("є ручні правки")} />}
                    {r.workerId
                      ? <Link href={`/workers/${r.workerId}`} className="font-medium text-slate-700 hover:text-red-600">{r.workerName ?? r.rawName}</Link>
                      : <EditableCell row={r} field="rawName" value={r.rawName} month={month} text />}
                    {r.linkStatus === "unmatched" && <span className="text-[10px] text-amber-600" title={t("Немає в системі")}>●</span>}
                    {r.isStudent && <span className="rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700">STUD</span>}
                    {r.under26 && <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700">&lt;26</span>}
                    {r.mismatch && (
                      <span className="text-[10px] font-medium text-rose-600"
                        title={Object.entries(r.mismatch).map(([k, v]) => `${k}: ${t("наш розрахунок")} ${v.ours} ≠ ${t("у таблиці")} ${v.sheet}`).join("\n")}>
                        ⚠
                      </span>
                    )}
                  </span>
                </td>
                {openCols.map(([k]) => (
                  <td key={k} className="px-1 py-0.5 text-right text-slate-600">
                    <EditableCell row={r} field={k} value={r[k]} month={month} />
                  </td>
                ))}
                {extraKeys.map(k => (
                  <td key={k} className="px-1 py-0.5 text-right text-slate-600">
                    <EditableCell row={r} field={`extras.${k}`} value={r.extras[k]} month={month} />
                  </td>
                ))}
                {sensCols.map(([k]) => (
                  <td key={k} className="bg-amber-50/40 px-1 py-0.5 text-right text-slate-600">
                    <EditableCell row={r} field={k} value={r[k]} month={month} sensitive />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold text-slate-700">
              <td className="sticky left-0 z-10 bg-slate-50 px-3 py-2">{t("Разом")}</td>
              {openCols.map(([k]) => (
                <td key={k} className="px-1.5 py-2 text-right tabular-nums">
                  {["rateBrutto", "rateNetto"].includes(k) ? "" : fmt(sum(r => r[k] as number | null))}
                </td>
              ))}
              {extraKeys.map(k => <td key={k} className="px-1.5 py-2 text-right tabular-nums">{fmt(sum(r => typeof r.extras[k] === "number" ? r.extras[k] as number : 0))}</td>)}
              {sensCols.map(([k]) => <td key={k} className="bg-amber-50/60 px-1.5 py-2 text-right tabular-nums">{fmt(sum(r => r[k] as number | null))}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// Підсумок фабрики: ЗП/карта/податок/готівка/економія/аванси/хостел/штрафи/karta pobytu.
// Чутливі позиції — лише коли API віддав закритий шар.
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

  // тултіп = формула з реальними числами, як в екселі
  const Item = ({ label, value, accent, formula }: { label: string; value: number; accent?: string; formula: string }) => (
    <div className="group relative rounded-xl border border-slate-200 bg-white px-3 py-2" title={formula}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${accent ?? "text-slate-700"}`}>{z(value)}</div>
      <div className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden w-max max-w-md rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] leading-relaxed text-white shadow-lg group-hover:block">
        {formula}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      <Item label={t("Загальна ЗП")} value={total} accent="text-slate-900"
        formula={`${t("Σ колонки «До виплати» по рядках фабрики")} = ${z(total)}`} />
      {sensitive && <Item label={t("ЗП на карту")} value={konto}
        formula={`${t("Σ «Księg. netto (конто)» — офіційна частина, що йде на рахунок")} = ${z(konto)}`} />}
      {sensitive && <Item label={t("Податки працівника з карти")} value={workerTax}
        formula={`${t("Σ (Księg. brutto − Księg. netto): ПДФО + внески ZUS, утримані з офіційної частини")} = ${z(ksiegBrutto)} − ${z(r2(ksiegBrutto - workerTax))} = ${z(workerTax)}`} />}
      {sensitive && <Item label={t("ZUS роботодавця (оцінка)")} value={employerZus}
        formula={`${t("Σ оподатковуваного Księg. brutto × 20,48%")} = ${z(taxableBrutto)} × 0,2048 = ${z(employerZus)}`} />}
      {sensitive && <Item label={t("ЗП готівкою")} value={gotowka} accent="text-amber-700"
        formula={`${t("Σ колонки «Готівка»")} = ${z(gotowka)}`} />}
      {sensitive && <Item label={t("Зекономлено на готівці (оцінка)")} value={saved} accent="text-emerald-700"
        formula={`${t("Якби готівку платили офіційно: (брутто-еквівалент − готівка) + брутто-еквівалент × 20,48% ZUS. Студенти не рахуються — у них податків немає.")} (${z(savedParts.bruttoEq)} − ${z(savedParts.got)}) + ${z(savedParts.bruttoEq)} × 0,2048 = ${z(saved)}`} />}
      <Item label={t("Аванси (zaliczki)")} value={zaliczki}
        formula={`Σ Zaliczka + Σ Zaliczka BD = ${z(zalA)} + ${z(zalBd)} = ${z(zaliczki)}`} />
      <Item label={t("Хостел")} value={hostel} formula={`${t("Σ колонки Hostel")} = ${z(hostel)}`} />
      <Item label={t("Штрафи (разом)")} value={kary}
        formula={`Σ Kara + ${t("Кара клієнта")} + ${t("Кара ES")} = ${z(karaSum)} + ${z(karaKl)} + ${z(karaEs)} = ${z(kary)}`} />
      <Item label={t("Karta pobytu")} value={kartaPobytu} formula={`${t("Σ колонки Karta pobytu")} = ${z(kartaPobytu)}`} />
    </div>
  );
}

// Панель незматчених: привʼязати до працівника / позначити зовнішнім
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
    <Card className="mb-5 overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">
        {t("Не привʼязані до працівників")} ({people.length})
      </div>
      {!people.length ? <div className="p-4 text-sm text-slate-400">{t("Всі рядки привʼязані")} 🎉</div> : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {people.map(p => (
                <tr key={`${p.city}-${p.rawName}`}>
                  <td className="px-4 py-1.5 font-medium text-slate-700">{p.rawName}</td>
                  <td className="px-2 py-1.5 text-slate-500">{t(p.city)} · {p.factories.join(", ")}</td>
                  <td className="px-2 py-1.5 text-slate-400">{p.months.map(m => m.slice(5)).join(", ")}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap justify-end gap-1">
                      {p.candidates.map(c => (
                        <button key={c.id} onClick={() => link.mutate({ rawName: p.rawName, city: p.city, workerId: c.id, status: "confirmed" })}
                          className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
                          title={t("Привʼязати до")}>
                          <Link2 className="mr-0.5 inline h-3 w-3" />{c.name}
                        </button>
                      ))}
                      <button onClick={() => link.mutate({ rawName: p.rawName, city: p.city, status: "external" })}
                        className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-200"
                        title={t("Поза системою (не працівник)")}>
                        <UserX className="mr-0.5 inline h-3 w-3" />{t("зовнішній")}
                      </button>
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
