// «Сводні» — повне дзеркало зарплатних таблиць по містах (Люблін/Познань/Лодзь).
// Відкритий шар: фактичні години, ставки, відрахування, до виплати. Закритий
// (księgowość-години, ksieg brutto/netto, готівка, конто) приходить з API лише
// коли роль має capability svodniSensitive — тут просто показуємо, що прийшло.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Link2, UserX, CircleAlert, CircleCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { get, post } from "../lib/api";
import { Button, Card, Empty, Badge, Spinner, Select } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";

type Row = {
  id: number; city: string; firm: string | null; factoryLabel: string; factoryId: number | null;
  section: string | null; rawName: string; workerId: number | null; workerName: string | null; linkStatus: string;
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

// колонки відкритого шару: [ключ, заголовок] — показуються лише непорожні
const OPEN_COLS: [keyof Row, string][] = [
  ["hoursNotified", "Год. повід."], ["hours", "Години"], ["shifts", "Зміни"],
  ["rateBrutto", "Ставка бр."], ["rateNetto", "Ставка нет."], ["premia", "Премія"],
  ["zaliczka", "Zaliczka"], ["zaliczkaBd", "Zaliczka BD"], ["hostel", "Hostel"],
  ["odziez", "Odzież"], ["dojazd", "Dojazd"], ["kara", "Kara"], ["komornik", "Komornik"],
  ["kaucja", "Kaucja"], ["potracenia", "Potrącenia"], ["doWyplaty", "До виплати"], ["brutto", "Brutto"],
];
const SENS_COLS: [keyof Row, string][] = [
  ["hoursDeclared", "Год. księg."], ["ksiegBrutto", "Księg. brutto"], ["ksiegNetto", "Księg. netto (конто)"], ["gotowka", "Готівка"],
];
const EXTRA_LABEL: Record<string, string> = {
  nocneH: "Нічні [год]", doplataNocna: "Допл. нічні", oplataKierowcy: "Оплата водія",
  doplataEs: "Dopłata ES", badania: "Badania", nakladki: "Nakładki", zwrotKosztow: "Zwrot kosztów",
  kartaPobytu: "Karta pobytu", karaKlient: "Кара клієнта", karaEs: "Кара ES",
  zadluzenie: "Заборгованість", migawka: "Migawka", dokumenty: "Dokumenty", workListHours: "Work List [год]",
};
const fmt = (v: unknown) => typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "";

export default function Svodni() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [month, setMonth] = useState<string>("");
  const [city, setCity] = useState<string>("");
  const [showLinks, setShowLinks] = useState(false);

  const { data: monthsData } = useQuery<{ months: string[] }>({ queryKey: ["svodni-months"], queryFn: () => get("/svodni/months") });
  const months = monthsData?.months ?? [];
  const effMonth = month || months[0] || "";

  const { data, isFetching } = useQuery<Data>({
    queryKey: ["svodni", effMonth, city], enabled: !!effMonth,
    queryFn: () => get(`/svodni?month=${effMonth}${city ? `&city=${encodeURIComponent(city)}` : ""}`),
  });
  const effCity = city || data?.cities?.[0] || "";
  const rows = useMemo(() => (data?.rows ?? []).filter(r => !effCity || r.city === effCity), [data, effCity]);
  const checks = useMemo(() => (data?.checks ?? []), [data]);
  const factories = useMemo(() => [...new Set(rows.map(r => r.factoryLabel))], [rows]);

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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={effMonth} onChange={e => setMonth(e.target.value)}>
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </Select>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {(data?.cities ?? []).map(c => (
            <button key={c} onClick={() => setCity(c)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${effCity === c ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
              {t(c)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setShowLinks(v => !v)}>
            <Users className="h-4 w-4" /> {t("Привʼязки")}
          </Button>
          <Button variant="secondary" loading={rematch.isPending} onClick={() => rematch.mutate()}>
            <Link2 className="h-4 w-4" /> {t("Перематчити")}
          </Button>
          <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw className="h-4 w-4" /> {t("Синк із Google")}
          </Button>
          {can(me, "viewFinance") && (
            <Button variant="secondary" loading={applyRates.isPending} onClick={() => applyRates.mutate()}>
              {t("Застосувати ставки в профілі")}
            </Button>
          )}
        </div>
      </div>

      {showLinks && <UnmatchedPanel />}

      {isFetching && !data ? <Spinner /> : !rows.length ? (
        <Empty>{t("Немає даних за цей місяць — запусти «Синк із Google»")}</Empty>
      ) : (
        <div className="space-y-5">
          {factories.map(f => (
            <FactoryTable key={f} label={f}
              rows={rows.filter(r => r.factoryLabel === f)}
              checks={checks.filter(c => c.factoryLabel.split(" + ").includes(f))}
              sensitive={!!data?.sensitive} />
          ))}
        </div>
      )}
    </>
  );
}

function FactoryTable({ label, rows, checks, sensitive }: { label: string; rows: Row[]; checks: Check[]; sensitive: boolean }) {
  const t = useT();
  const hasVal = (k: keyof Row) => rows.some(r => r[k] != null);
  const openCols = OPEN_COLS.filter(([k]) => hasVal(k));
  const sensCols = sensitive ? SENS_COLS.filter(([k]) => rows.some(r => r[k as keyof Row] != null)) : [];
  const extraKeys = [...new Set(rows.flatMap(r => Object.keys(r.extras).filter(k => EXTRA_LABEL[k] && typeof r.extras[k] === "number")))];
  const badChecks = checks.filter(c => !c.ok);
  const sum = (f: (r: Row) => number | null | undefined) => {
    const s = rows.reduce((a, r) => a + (f(r) ?? 0), 0);
    return Math.round(s * 100) / 100;
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <Badge color="slate">{rows.length} {t("ос.")}</Badge>
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
              {openCols.map(([k, h]) => <th key={k} className="px-2 py-2 text-right font-medium whitespace-nowrap">{t(h)}</th>)}
              {extraKeys.map(k => <th key={k} className="px-2 py-2 text-right font-medium whitespace-nowrap">{t(EXTRA_LABEL[k]!)}</th>)}
              {sensCols.map(([k, h]) => <th key={k} className="bg-amber-50/60 px-2 py-2 text-right font-medium whitespace-nowrap">{t(h)}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <tr key={r.id} className={r.mismatch ? "bg-rose-50/50" : undefined}>
                <td className="sticky left-0 z-10 bg-white px-3 py-1.5 whitespace-nowrap">
                  {r.workerId
                    ? <Link href={`/workers/${r.workerId}`} className="font-medium text-slate-700 hover:text-red-600">{r.workerName ?? r.rawName}</Link>
                    : <span className="text-slate-600">{r.rawName}</span>}
                  {r.linkStatus === "unmatched" && <span className="ml-1 text-[10px] text-amber-600" title={t("Немає в системі")}>●</span>}
                  {r.linkStatus === "external" && <span className="ml-1 text-[10px] text-slate-400">{t("(зовн.)")}</span>}
                  {r.isStudent && <span className="ml-1 rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700">STUD</span>}
                  {r.under26 && <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700">&lt;26</span>}
                  {r.mismatch && (
                    <span className="ml-1 text-[10px] font-medium text-rose-600"
                      title={Object.entries(r.mismatch).map(([k, v]) => `${k}: ${t("наш розрахунок")} ${v.ours} ≠ ${t("у таблиці")} ${v.sheet}`).join("\n")}>
                      ⚠ {t("не сходиться")}
                    </span>
                  )}
                </td>
                {openCols.map(([k]) => <td key={k} className="px-2 py-1.5 text-right tabular-nums text-slate-600">{fmt(r[k])}</td>)}
                {extraKeys.map(k => <td key={k} className="px-2 py-1.5 text-right tabular-nums text-slate-600">{fmt(r.extras[k])}</td>)}
                {sensCols.map(([k]) => <td key={k} className="bg-amber-50/40 px-2 py-1.5 text-right tabular-nums text-slate-600">{fmt(r[k as keyof Row])}</td>)}
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold text-slate-700">
              <td className="sticky left-0 z-10 bg-slate-50 px-3 py-2">{t("Разом")}</td>
              {openCols.map(([k]) => (
                <td key={k} className="px-2 py-2 text-right tabular-nums">
                  {["rateBrutto", "rateNetto"].includes(k as string) ? "" : fmt(sum(r => r[k] as number | null))}
                </td>
              ))}
              {extraKeys.map(k => <td key={k} className="px-2 py-2 text-right tabular-nums">{fmt(sum(r => typeof r.extras[k] === "number" ? r.extras[k] as number : 0))}</td>)}
              {sensCols.map(([k]) => <td key={k} className="bg-amber-50/60 px-2 py-2 text-right tabular-nums">{fmt(sum(r => r[k as keyof Row] as number | null))}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
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
