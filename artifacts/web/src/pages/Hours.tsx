import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Factory as FactoryIcon, AlertTriangle, BellRing, Download, Check, X, Pencil, Upload as UploadIcon, Mail, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { get, post, upload } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { WorkerDaysModal } from "../components/DetailModals";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT, useLang } from "../lib/i18n";

interface Dispute { workerId: number; status: string }

interface HourRow {
  workerId: number; name: string; code: string | null; factoryId: number | null; factory: string | null;
  city: string; factoryShiftCount: number; byShift: Record<string, number>; shifts: number; hours: number;
  reportHours?: number | null; reportSubmitted?: boolean; reportLink?: string | null;
  factoryHours?: number | null; factoryDays?: Record<string, number> | null; clientEmail?: string | null;
  rate?: number; gross?: number; net?: number; laborCost?: number; reportNet?: number | null; reportGross?: number | null; // owner only
}
interface Group { key: string; name: string; factoryId: number | null; city: string; n: number; rows: HourRow[]; shifts: number; hours: number; net: number }

// Звірка «рапорт працівника vs години фабрики» для підсвітки рядка:
// match — обидва є і збігаються (±0.01), mismatch — розходяться, partial — є лише одне.
type DiffState = "match" | "mismatch" | "partial" | "none";
function diffState(w: HourRow): DiffState {
  const rep = w.reportHours ?? null, fac = w.factoryHours ?? null;
  if (rep == null && fac == null) return "none";
  if (rep == null || fac == null) return "partial";
  return Math.abs(rep - fac) <= 0.01 ? "match" : "mismatch";
}
const DIFF_CELL: Record<DiffState, string> = {
  match: "bg-emerald-50", mismatch: "bg-red-50", partial: "bg-amber-50/60", none: "",
};

export default function Hours() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const me = useMe();
  const isOwner = me?.role === "owner";
  // Місяць і вкладки живуть в URL (?m=&city=&fac=) — оновлення сторінки
  // повертає на те саме місце, а не на «всі фабрики, поточний місяць»
  const [month, setMonth] = useState(() => {
    const m = new URLSearchParams(window.location.search).get("m");
    return m && months.some(x => x.value === m) ? m : months[0]!.value;
  });
  const [cityTab, setCityTab] = useState(() => new URLSearchParams(window.location.search).get("city") ?? "");   // "" = всі міста
  const [facTab, setFacTab] = useState(() => new URLSearchParams(window.location.search).get("fac") ?? "");      // ключ групи ("" = всі фабрики)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (month !== months[0]!.value) p.set("m", month); else p.delete("m");
    if (cityTab) p.set("city", cityTab); else p.delete("city");
    if (facTab) p.set("fac", facTab); else p.delete("fac");
    const q = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
  }, [month, cityTab, facTab, months]);
  const [sel, setSel] = useState<{ id: number; name: string } | null>(null);
  // Ключі груп, для яких відкриті модалки (сам Group береться свіжим із query —
  // так лист/превʼю живо перераховуються після правок годин)
  const [importKey, setImportKey] = useState<string | null>(null);
  const [emailKey, setEmailKey] = useState<string | null>(null);
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const { data, isFetching } = useQuery<{ month: string; workers: HourRow[]; totalHours: number; totalShifts: number; totalReportHours: number; totalFactoryHours?: number; totalNet?: number; totalReportNet?: number }>({
    queryKey: ["hours", month], queryFn: () => get(`/hours?month=${month}`),
  });
  const { data: disputes = [] } = useQuery<Dispute[]>({ queryKey: ["hours-reports"], queryFn: () => get("/hours-reports") });
  const openByWorker = useMemo(() => new Set(disputes.filter(d => d.status === "new").map(d => d.workerId)), [disputes]);
  const canEdit = can(me, "editData");
  const remind = useMutation({
    // Server picks the report month by the collection window (first days of a month → prev month)
    mutationFn: () => post<{ notified: number; total: number; month: string }>("/hours/report-remind", {}),
    onSuccess: (r) => toast.success(t("Нагадування про рапорт надіслано: {n} з {total}", { n: r.notified, total: r.total }), {
      description: months.find(m => m.value === r.month)?.label ?? r.month,
    }),
    onError: (e: any) => toast.error(e.message),
  });
  // «Години підтверджені → до сводної»: весь місяць, одне місто або одна фабрика
  const toSvodni = useMutation({
    mutationFn: (scope: { factoryId?: number; city?: string }) =>
      post<{ created: number; updated: number; workers: number; noNettoRate: number; skippedLocked: number; noCity: string[] }>("/svodni/from-hours", { month, ...scope }),
    onSuccess: (r) => toast.success(t("Сводна {month}: створено {c}, оновлено {u}", { month, c: r.created, u: r.updated }), {
      description: [
        r.noNettoRate ? t("Без ставки нетто (виплата не порахована): {n} — заповни в профілі чи сводній", { n: r.noNettoRate }) : null,
        r.skippedLocked ? t("Пропущено затверджених фабрик: {n}", { n: r.skippedLocked }) : null,
        r.noCity?.length ? t("Місто фабрики невідоме (пропущено): {list} — фабрика ще не зустрічалась ні в сводних, ні в Зарплатах", { list: r.noCity.join(", ") }) : null,
      ].filter(Boolean).join(" · ") || undefined,
    }),
    onError: (e: any) => toast.error(e.message),
  });
  const confirmToSvodni = (label: string, scope: { factoryId?: number; city?: string }) => {
    if (window.confirm(t("Перенести підтверджені години до сводної: {what}? Рядки створяться/оновляться з даними з профілів.", { what: label }))) toSvodni.mutate(scope);
  };

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const r of data?.workers ?? []) {
      const key = r.factoryId != null ? `f${r.factoryId}` : "none";
      if (!map.has(key)) map.set(key, { key, name: r.factory ?? t("Без фабрики"), factoryId: r.factoryId, city: r.city, n: Math.max(1, r.factoryShiftCount || 1), rows: [], shifts: 0, hours: 0, net: 0 });
      const g = map.get(key)!;
      g.rows.push(r); g.shifts += r.shifts; g.hours += r.hours; g.net += r.net ?? 0;
    }
    return [...map.values()];
  }, [data]);
  // місто → його фабрики (для заголовків і кнопки «місто → до сводної»)
  const cityGroups = useMemo(() => {
    const map = new Map<string, Group[]>();
    for (const g of groups) (map.get(g.city) ?? map.set(g.city, []).get(g.city)!).push(g);
    // «Без міста» — завжди в кінці, решта міст за алфавітом
    const last = (c: string) => c === "Без міста" ? 1 : 0;
    return [...map.entries()].sort((a, b) => last(a[0]) - last(b[0]) || a[0].localeCompare(b[0]));
  }, [groups]);
  // Вкладки: місто → фабрики в ньому; невалідний вибір (інший місяць) тихо падає на «всі»
  const cities = cityGroups.map(([c]) => c);
  const effCity = cities.includes(cityTab) ? cityTab : "";
  const facTabs = useMemo(() => groups.filter(g => !effCity || g.city === effCity), [groups, effCity]);
  const effFac = facTabs.some(g => g.key === facTab) ? facTab : "";
  const shownCityGroups = useMemo(() => cityGroups
    .filter(([c]) => !effCity || c === effCity)
    .map(([c, gs]) => [c, gs.filter(g => !effFac || g.key === effFac)] as const)
    .filter(([, gs]) => gs.length > 0), [cityGroups, effCity, effFac]);

  const round = (n: number) => Math.round(n * 100) / 100;

  return (
    <>
      <PageHeader title={t("Облік годин")} subtitle={t("Відпрацьовані зміни й фактичні години за місяць (із затвердженого графіку)")} />
      {/* Controls + city/factory tabs pinned under the top bar while tables scroll
          (md+ only) — same pattern as Schedule: top-[52px] = desktop top-bar height − 1px,
          -mx-8/px-8 undo the main padding so the opaque strip spans full width. */}
      <div className="mb-4 md:sticky md:top-[52px] md:z-20 md:-mx-8 md:bg-page md:px-8 md:pb-3 md:pt-2 md:shadow-[0_6px_10px_-8px_rgb(15_23_42/0.12)]">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        {data && (
          <div className="flex gap-2">
            <Badge color="slate">{t("Усього змін:")} {data.totalShifts}</Badge>
            <Badge color="green">{t("Усього годин:")} {round(data.totalHours)}</Badge>
            {isOwner && data.totalNet != null && <Badge color="green">{t("ЗП нетто:")} {round(data.totalNet)} zł</Badge>}
            <Badge color="blue">{t("Годин з рапорту:")} {round(data.totalReportHours ?? 0)}</Badge>
            <Badge color="amber">{t("Годин з фабрики:")} {round(data.totalFactoryHours ?? 0)}</Badge>
            {isOwner && data.totalReportNet != null && <Badge color="blue">{t("ЗП по рапорту:")} {round(data.totalReportNet)} zł</Badge>}
          </div>
        )}
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            {can(me, "svodni") && (
              <Button loading={toSvodni.isPending}
                onClick={() => confirmToSvodni(`${monthLabel} — ${t("всі фабрики")}`, {})}>
                <Check className="h-4 w-4" /> {t("Години підтверджені → до сводної")}
              </Button>
            )}
            <Button variant="secondary" loading={remind.isPending} onClick={() => remind.mutate()}><BellRing className="h-4 w-4" /> {t("Нагадати про рапорт")}</Button>
            <a href={`/api/hours/report-excel?month=${month}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> {t("Excel рапорту")}</a>
          </div>
        )}
      </div>

      {/* Вкладки міст + фабрик вибраного міста — фільтрують список нижче */}
      {cities.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl bg-slate-100 p-1">
              {[...cities, ""].map(c => (
                <button key={c || "all"} onClick={() => { setCityTab(c); setFacTab(""); }}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${effCity === c ? "bg-white text-red-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                  {c ? t(c) : t("Всі міста")}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {[null, ...facTabs].map(g => {
              const active = effFac === (g?.key ?? "");
              return (
                <button key={g?.key ?? "all"} onClick={() => setFacTab(g?.key ?? "")}
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                    active ? "border-red-600 bg-red-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-red-300"}`}>
                  {g ? g.name : t("Всі фабрики")}
                  <span className={`rounded-full px-1.5 text-[10px] font-medium ${active ? "bg-red-500 text-red-50" : "bg-slate-100 text-slate-500"}`}>
                    {g ? g.rows.length : facTabs.reduce((s, x) => s + x.rows.length, 0)}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      </div>{/* /sticky header */}

      {openByWorker.size > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-2.5 text-sm text-amber-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{openByWorker.size} {t(openByWorker.size === 1 ? "працівник має скаргу" : "працівників мають скарги")} {t("на години — позначені ⚠️. Клікніть на них, щоб переглянути й затвердити.")}</span>
        </div>
      )}

      {isFetching && !data ? <Spinner /> : !groups.length ? <Empty>{t("За цей місяць немає затверджених змін")}</Empty> : (
        <div className="space-y-8">
          {shownCityGroups.map(([city, cityGs]) => (
          <div key={city}>
            <div className="mb-3 flex items-center gap-2 border-b border-slate-200 pb-2">
              <h2 className="text-base font-bold tracking-tight text-slate-800">{t(city)}</h2>
              <Badge color="slate">{cityGs.length} {t("фабрик")}</Badge>
              <Badge color="green">{round(cityGs.reduce((s, g) => s + g.hours, 0))} {t("год")}</Badge>
              {can(me, "svodni") && canEdit && (
                <button onClick={() => confirmToSvodni(city, { city })} disabled={toSvodni.isPending}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                  <Check className="h-3.5 w-3.5" /> {t("Місто → до сводної")}
                </button>
              )}
            </div>
            <div className="space-y-6">
          {cityGs.map(g => {
            const cols = Array.from({ length: g.n }, (_, i) => String(i + 1));
            return (
              <div key={g.key}>
                <div className="mb-2 flex items-center gap-2">
                  <FactoryIcon className="h-4 w-4 text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-700">{g.name}</h2>
                  <Badge color="slate">{g.shifts} {t("змін")}</Badge>
                  <Badge color="green">{round(g.hours)} {t("год")}</Badge>
                  {isOwner && <Badge color="green">{round(g.net)} {t("zł нетто")}</Badge>}
                  <span className="ml-auto inline-flex items-center gap-2">
                  {can(me, "svodni") && canEdit && g.factoryId != null && (
                    <button onClick={() => confirmToSvodni(g.name, { factoryId: g.factoryId! })} disabled={toSvodni.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                      <Check className="h-3.5 w-3.5" /> {t("До сводної")}
                    </button>
                  )}
                  {canEdit && g.factoryId != null && (
                    <button onClick={() => setImportKey(g.key)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                      title={t("Імпорт годин з файла фабрики або вставленого списку")}>
                      <UploadIcon className="h-3.5 w-3.5" /> {t("Імпорт годин фабрики")}
                    </button>
                  )}
                  {canEdit && g.factoryId != null && g.rows.some(w => diffState(w) === "mismatch") && (
                    <button onClick={() => setEmailKey(g.key)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                      title={t("Згенерувати лист клієнту про розбіжності годин")}>
                      <Mail className="h-3.5 w-3.5" /> {t("Лист про розбіжності")}
                      <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{g.rows.filter(w => diffState(w) === "mismatch").length}</span>
                    </button>
                  )}
                  {canEdit && g.factoryId != null && (
                    <a href={`/api/hours/report-excel?month=${month}&factoryId=${g.factoryId}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" title={t("Excel рапорту по фабриці")}><Download className="h-3.5 w-3.5" /> {t("Excel рапорту")}</a>
                  )}
                  </span>
                </div>
                <Card className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                      <tr>
                        <th className="px-4 py-2.5">{t("Працівник")}</th><th className="px-4 py-2.5">{t("Код")}</th>
                        {cols.map(c => <th key={c} className="px-3 py-2.5 text-center">{c} {t("зм")}</th>)}
                        <th className="px-4 py-2.5 text-center">{t("Усього змін")}</th><th className="px-4 py-2.5 text-right">{t("Години")}</th>
                        <th className="px-4 py-2.5 text-right">{t("Години з рапорту")}</th>
                        <th className="px-4 py-2.5 text-right">{t("Години з фабрики")}</th>
                        {isOwner && <><th className="px-3 py-2.5 text-right">{t("Ставка")}</th><th className="px-4 py-2.5 text-right">{t("ЗП нетто")}</th><th className="px-4 py-2.5 text-right">{t("ЗП по рапорту")}</th></>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.rows.map(w => (
                        <tr key={`${w.workerId}-${w.factoryId ?? 0}`} onClick={() => setSel({ id: w.workerId, name: w.name })} className="cursor-pointer hover:bg-red-50/40">
                          <td className="px-4 py-2.5 font-medium text-red-700 underline-offset-2 hover:underline">
                            {openByWorker.has(w.workerId) && <span title={t("Є скарга на години")}><AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-amber-500" /></span>}
                            {w.name}
                          </td>
                          <td className="px-4 py-2.5 text-slate-400">{w.code ?? "—"}</td>
                          {cols.map(c => <td key={c} className="px-3 py-2.5 text-center text-slate-600">{w.byShift[c] || <span className="text-slate-300">0</span>}</td>)}
                          <td className="px-4 py-2.5 text-center font-medium text-slate-700">{w.shifts}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-emerald-700">{round(w.hours)} {t("год")}</td>
                          <td className={`px-4 py-2.5 text-right ${DIFF_CELL[diffState(w)]}`} onClick={e => e.stopPropagation()}><ReportHoursCell w={w} month={month} canEdit={canEdit} /></td>
                          <td className={`px-4 py-2.5 text-right ${DIFF_CELL[diffState(w)]}`} onClick={e => e.stopPropagation()}><FactoryHoursCell w={w} month={month} canEdit={canEdit} /></td>
                          {isOwner && <><td className="px-3 py-2.5 text-right text-slate-400">{w.rate ?? "—"}</td><td className="px-4 py-2.5 text-right font-semibold text-slate-700">{round(w.net ?? 0)} zł</td><td className="px-4 py-2.5 text-right font-semibold text-blue-700">{w.reportNet != null ? `${round(w.reportNet)} zł` : "—"}</td></>}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold text-slate-700">
                        <td className="px-4 py-2.5" colSpan={2 + cols.length}>{t("Разом по фабриці")}</td>
                        <td className="px-4 py-2.5 text-center">{g.shifts}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-700">{round(g.hours)} {t("год")}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{round(g.rows.reduce((s, w) => s + (w.reportHours ?? 0), 0))} {t("год")}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{round(g.rows.reduce((s, w) => s + (w.factoryHours ?? 0), 0))} {t("год")}</td>
                        {isOwner && <><td /><td className="px-4 py-2.5 text-right text-emerald-700">{round(g.net)} zł</td><td className="px-4 py-2.5 text-right text-blue-700">{round(g.rows.reduce((s, w) => s + (w.reportNet ?? 0), 0))} zł</td></>}
                      </tr>
                    </tfoot>
                  </table>
                </Card>
              </div>
            );
          })}
            </div>
          </div>
          ))}
        </div>
      )}
      {sel && <WorkerDaysModal workerId={sel.id} name={sel.name} month={month} monthLabel={monthLabel} onClose={() => setSel(null)} />}
      {(() => {
        // групи беруться свіжими з query — правки годин живо оновлюють модалки
        const ig = importKey ? groups.find(g => g.key === importKey) : null;
        const eg = emailKey ? groups.find(g => g.key === emailKey) : null;
        return (
          <>
            {ig?.factoryId != null && <ImportHoursModal group={ig} month={month} onClose={() => setImportKey(null)} />}
            {eg?.factoryId != null && <DiscrepancyEmailModal group={eg} month={month} onClose={() => setEmailKey(null)} />}
          </>
        );
      })()}
    </>
  );
}

// Клітинка «Години з фабрики»: показ + inline-редагування (дзеркало ReportHoursCell);
// при розбіжності з рапортом показує Δ.
function FactoryHoursCell({ w, month, canEdit }: { w: HourRow; month: string; canEdit: boolean }) {
  const t = useT();
  const { lang } = useLang();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showDays, setShowDays] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (hours: string | null) => post("/hours/factory", { workerId: w.workerId, month, hours, factoryId: w.factoryId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); qc.invalidateQueries({ queryKey: ["hours-day-compare"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const st = diffState(w);
  const diff = w.reportHours != null && w.factoryHours != null ? Math.round((w.factoryHours - w.reportHours) * 100) / 100 : null;
  const dayEntries = useMemo(
    () => Object.entries(w.factoryDays ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
    [w.factoryDays],
  );
  const inner = (
    <>
      {w.factoryHours} {t("год")}
      {st === "mismatch" && diff != null && <span className="ml-1 text-xs font-medium text-red-500">({diff > 0 ? "+" : ""}{diff})</span>}
      {st === "match" && <Check className="ml-1 inline h-3.5 w-3.5 text-emerald-500" />}
    </>
  );
  const color = st === "mismatch" ? "text-red-700" : st === "match" ? "text-emerald-700" : "text-slate-700";
  const shown = w.factoryHours != null
    ? (dayEntries.length
      // є розбивка по днях → значення клікабельне, відкриває деталізацію
      ? <button onClick={() => setShowDays(true)} title={t("Показати розбивку по днях від фабрики")}
          className={`font-semibold underline decoration-dotted underline-offset-2 hover:opacity-75 ${color}`}>{inner}</button>
      : <span className={`font-semibold ${color}`}>{inner}</span>)
    : <span className="text-slate-300">—</span>;
  const daysModal = showDays && (
    <Modal open onClose={() => setShowDays(false)} title={`${w.name} — ${t("дні від фабрики")}`}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-slate-400">
          <tr><th className="px-2 py-1.5">{t("Дата")}</th><th className="px-2 py-1.5 text-right">{t("Години")}</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {dayEntries.map(([date, h]) => (
            <tr key={date}>
              <td className="px-2 py-1.5 text-slate-700">
                {date.slice(8, 10)}.{date.slice(5, 7)}
                <span className="ml-1.5 text-xs text-slate-400">{new Date(`${date}T00:00:00`).toLocaleDateString(lang === "en" ? "en-US" : "uk-UA", { weekday: "short" })}</span>
              </td>
              <td className="px-2 py-1.5 text-right font-medium text-slate-700">{h}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold text-slate-700">
            <td className="px-2 py-1.5">{t("Разом")} · {dayEntries.length} {t("дн.")}</td>
            <td className="px-2 py-1.5 text-right">{Math.round(dayEntries.reduce((s, [, h]) => s + h, 0) * 100) / 100}</td>
          </tr>
        </tfoot>
      </table>
    </Modal>
  );
  if (!canEdit) return <>{shown}{daysModal}</>;
  if (editing) {
    const submit = () => save.mutate(val.replace(",", ".").trim() || null);
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Input value={val} onChange={e => setVal(e.target.value)} inputMode="decimal" placeholder="0–500" className="w-20 text-right" autoFocus
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }} />
        <button onClick={submit} disabled={save.isPending} className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {shown}
      <button onClick={() => { setVal(w.factoryHours != null ? String(w.factoryHours) : ""); setEditing(true); }} className="rounded-md p-0.5 text-slate-300 hover:text-red-600" title={t("Вписати години фабрики")}><Pencil className="h-3.5 w-3.5" /></button>
      {daysModal}
    </span>
  );
}

interface ParsedRow { name: string; hours: number; days: Record<number, number> | null; workerId: number | null; matchName: string | null; candidates: { id: number; name: string; active: boolean }[] }

// Імпорт годин фабрики: Excel-файл (2 формати) або вставлений список → превʼю
// з матчингом імен (bot/workerMatch) → масове збереження.
function ImportHoursModal({ group, month, onClose }: { group: Group; month: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [picked, setPicked] = useState<Record<number, number | null>>({});  // index → workerId
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [monthDetected, setMonthDetected] = useState<string | null>(null);
  const [srcKind, setSrcKind] = useState<"excel" | "paste">("paste");
  const fileRef = useRef<HTMLInputElement>(null);
  const initPreview = (r: ParsedRow[], detected: string | null) => {
    setRows(r); setMonthDetected(detected);
    const p: Record<number, number | null> = {}, c: Record<number, boolean> = {};
    r.forEach((row, i) => { p[i] = row.workerId; c[i] = row.workerId != null && row.hours > 0; });
    setPicked(p); setChecked(c);
  };
  const parse = useMutation({
    mutationFn: async (file: File | null) => {
      setSrcKind(file ? "excel" : "paste");
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("month", month);
        return upload<{ rows: ParsedRow[]; monthDetected: string | null }>("/hours/factory-parse", form);
      }
      return post<{ rows: ParsedRow[]; monthDetected: string | null }>("/hours/factory-parse", { month, text });
    },
    onSuccess: (r) => initPreview(r.rows, r.monthDetected),
    onError: (e: any) => toast.error(e.message),
  });
  const apply = useMutation({
    mutationFn: () => {
      const out = (rows ?? []).map((r, i) => ({ workerId: picked[i], hours: r.hours, days: r.days, on: checked[i] }))
        .filter(r => r.on && r.workerId != null)
        .map(r => ({ workerId: r.workerId!, hours: r.hours, days: r.days }));
      return post<{ saved: number; skipped: number }>("/hours/factory-apply", {
        month, factoryId: group.factoryId, source: srcKind, rows: out,
      });
    },
    onSuccess: (r) => {
      toast.success(t("Збережено годин фабрики: {n}", { n: r.saved }));
      qc.invalidateQueries({ queryKey: ["hours", month] });
      qc.invalidateQueries({ queryKey: ["hours-day-compare"] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const nSelected = rows ? rows.filter((_, i) => checked[i] && picked[i] != null).length : 0;
  // «Чи це та сама людина?»: лише ті з обліку фабрики, у кого Є години з рапорту,
  // але ще НЕМАЄ збігу з таблицею фабрики — пропонуються в випадайці для
  // незматчених рядків файла (крім уже вибраних деінде)
  const pickedIds = useMemo(() => new Set(Object.values(picked).filter((v): v is number => v != null)), [picked]);
  const missingWorkers = useMemo(
    () => group.rows.filter(r => r.reportHours != null && r.factoryHours == null)
      .map(r => ({ id: r.workerId, name: r.name, reportHours: r.reportHours! })),
    [group],
  );
  const unmatchedMissing = missingWorkers.filter(w => !pickedIds.has(w.id));
  return (
    <Modal open onClose={onClose} title={`${t("Імпорт годин фабрики")} — ${group.name} · ${month}`} size="xl">
      {!rows ? (
        <div className="space-y-4">
          <div>
            <Label>{t("Excel-файл від фабрики (обидва формати: зведена таблиця або lista dni szczegółowo)")}</Label>
            <input ref={fileRef} type="file" accept=".xls,.xlsx" className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-red-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-red-700 hover:file:bg-red-100"
              onChange={e => { const f = e.target.files?.[0]; if (f) parse.mutate(f); }} />
          </div>
          <div className="flex items-center gap-3 text-xs uppercase text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />{t("або")}<div className="h-px flex-1 bg-slate-200" />
          </div>
          <div>
            <Label>{t("Вставити список «ім'я — години» (по рядку на людину)")}</Label>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={8}
              placeholder={"Kowalski Jan 168\nNowak Anna — 152,5\nWiśniewski Piotr 140:30"}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 outline-none focus:border-red-300" />
            <div className="mt-2 flex justify-end">
              <Button onClick={() => parse.mutate(null)} loading={parse.isPending} disabled={!text.trim()}>{t("Розібрати")}</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {monthDetected && monthDetected !== month && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t("У файлі місяць {detected}, а вибрано {month} — перевір, чи той файл", { detected: monthDetected, month })}
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-2" />
                  <th className="px-3 py-2">{t("Ім'я у файлі")}</th>
                  <th className="px-3 py-2 text-right">{t("Години")}</th>
                  <th className="px-3 py-2">{t("Працівник у базі")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={i} className={checked[i] ? "" : "opacity-50"}>
                    <td className="px-3 py-2"><input type="checkbox" checked={!!checked[i]} onChange={e => setChecked(c => ({ ...c, [i]: e.target.checked }))} className="h-4 w-4 accent-red-600" /></td>
                    <td className="px-3 py-2 font-medium text-slate-700">{r.name}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-700">{r.hours}</td>
                    <td className="px-3 py-2">
                      {r.workerId != null ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700"><Check className="h-3.5 w-3.5" /> {r.matchName}</span>
                      ) : (() => {
                        // «Чи це та сама людина?»: пропонуються ЛИШЕ люди з рапортом
                        // без збігу з фабрикою, найближчі за годинами — вгорі.
                        // Вибраний у ЦЬОМУ рядку лишається, вибрані в інших — ховаються.
                        const opts = missingWorkers
                          .filter(w => !pickedIds.has(w.id) || picked[i] === w.id)
                          .sort((a, b) => Math.abs(a.reportHours - r.hours) - Math.abs(b.reportHours - r.hours));
                        if (!opts.length) return <span className="text-slate-400">{t("не знайдено в базі")}</span>;
                        return (
                          <Select value={picked[i] ?? ""} onChange={e => {
                            const v = e.target.value ? Number(e.target.value) : null;
                            setPicked(p => ({ ...p, [i]: v }));
                            setChecked(c => ({ ...c, [i]: v != null })); // вибрав людину → одразу в список
                          }} className="w-full">
                            <option value="">{t("— вибери, якщо це та сама людина —")}</option>
                            {opts.map(w => <option key={w.id} value={w.id}>{w.name} — {w.reportHours} {t("год")} ({t("рапорт")})</option>)}
                          </Select>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unmatchedMissing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-700">
              <span className="font-medium">{t("Є в обліку, але без годин фабрики ({n}):", { n: unmatchedMissing.length })}</span>{" "}
              {unmatchedMissing.map(w => `${w.name} (${w.reportHours} ${t("год")})`).join(", ")}
              <div className="mt-0.5 text-xs text-amber-600">{t("Якщо хтось із них є у файлі під іншим написанням — вибери його у випадайці відповідного рядка.")}</div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <button onClick={() => { setRows(null); setText(""); }} className="text-sm text-slate-500 underline-offset-2 hover:underline">{t("← Назад до вибору файла")}</button>
            <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!nSelected}>
              <Check className="h-4 w-4" /> {t("Зберегти {n} рядків", { n: nSelected })}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Лист клієнту про розбіжності (польською): драфт генерується з поточних даних
// і живо оновлюється після правок годин, поки адмін не відредагував текст вручну.
function DiscrepancyEmailModal({ group, month, onClose }: { group: Group; month: string; onClose: () => void }) {
  const t = useT();
  const mismatches = useMemo(() => group.rows.filter(w => diffState(w) === "mismatch"), [group]);
  const monthPl = useMemo(() => new Date(`${month}-01T00:00:00`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" }), [month]);
  // Позмінна звірка (рапорт = наші явки, файл фабрики має дні) — конкретні дні в лист
  interface DayDiff { date: string; our: number; ourShifts: string[]; factory: number }
  const { data: dayCmp } = useQuery<{ workers: { workerId: number; days: DayDiff[] }[] }>({
    queryKey: ["hours-day-compare", month, group.factoryId],
    queryFn: () => get(`/hours/day-compare?month=${month}&factoryId=${group.factoryId}`),
  });
  const dayByWorker = useMemo(() => new Map((dayCmp?.workers ?? []).map(w => [w.workerId, w.days])), [dayCmp]);
  const generated = useMemo(() => {
    const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
    const lines = mismatches.flatMap(w => {
      const diff = Math.round(((w.factoryHours ?? 0) - (w.reportHours ?? 0)) * 100) / 100;
      const head = `• ${w.name}: wg raportu pracownika ${w.reportHours} godz., wg zestawienia z Państwa strony ${w.factoryHours} godz. (różnica ${diff > 0 ? "+" : ""}${diff} godz.)`;
      const days = dayByWorker.get(w.workerId);
      if (!days?.length) return [head];
      return [head,
        "   Rozbieżne dni (wg potwierdzonych obecności):",
        ...days.map(d =>
          `   – ${ddmm(d.date)}: u nas ${d.our} godz.${d.ourShifts.length ? ` (zmiana ${d.ourShifts.join("+")})` : ""}, wg Państwa ${d.factory} godz.`),
      ];
    });
    return {
      subject: `Rozbieżności w godzinach — ${group.name} — ${monthPl}`,
      body: [
        "Dzień dobry,",
        "",
        `po weryfikacji godzin za ${monthPl} znaleźliśmy rozbieżności między raportami naszych pracowników a zestawieniem z Państwa strony:`,
        "",
        ...lines,
        "",
        "W załączeniu przesyłamy raporty pracowników jako potwierdzenie.",
        "",
        "Prosimy o weryfikację i informację zwrotną.",
        "",
        "Pozdrawiamy,",
        "Euro Support",
      ].join("\n"),
    };
  }, [mismatches, group.name, monthPl, dayByWorker]);
  // null = слідувати за згенерованим (живе оновлення); рядок = ручна правка
  const [customSubject, setCustomSubject] = useState<string | null>(null);
  const [customBody, setCustomBody] = useState<string | null>(null);
  const [to, setTo] = useState(() => group.rows.find(r => r.clientEmail)?.clientEmail ?? "");
  const subject = customSubject ?? generated.subject;
  const body = customBody ?? generated.body;
  const withReport = mismatches.filter(w => w.reportSubmitted && w.reportLink);
  const withoutReport = mismatches.filter(w => !(w.reportSubmitted && w.reportLink));
  const send = useMutation({
    mutationFn: () => post<{ sent: boolean; attached: number; missingReports: string[] }>("/hours/discrepancy-email", {
      month, factoryId: group.factoryId, to, subject, body, attachWorkerIds: withReport.map(w => w.workerId),
    }),
    onSuccess: (r) => {
      toast.success(t("Лист надіслано на {to} (вкладень: {n})", { to, n: r.attached }), {
        description: r.missingReports.length ? t("Без рапорту-доказу: {list}", { list: r.missingReports.join(", ") }) : undefined,
      });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${t("Лист про розбіжності")} — ${group.name} · ${month}`} size="xl">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Badge color="red">{mismatches.length} {t("розбіжностей")}</Badge>
          {(customSubject != null || customBody != null) ? (
            <button onClick={() => { setCustomSubject(null); setCustomBody(null); }} className="inline-flex items-center gap-1 text-xs text-slate-500 underline-offset-2 hover:underline">
              <RotateCcw className="h-3 w-3" /> {t("Скинути до згенерованого")}
            </button>
          ) : (
            <span className="text-xs text-slate-400">{t("Текст оновлюється автоматично при правках годин")}</span>
          )}
        </div>
        <div>
          <Label>{t("Кому (email клієнта)")}</Label>
          <Input value={to} onChange={e => setTo(e.target.value)} placeholder="klient@fabryka.pl" className="mt-1" />
        </div>
        <div>
          <Label>{t("Тема")}</Label>
          <Input value={subject} onChange={e => setCustomSubject(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label>{t("Текст листа")}</Label>
          <textarea value={body} onChange={e => setCustomBody(e.target.value)} rows={14}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 outline-none focus:border-red-300" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <div className="font-medium text-slate-700">{t("Вкладення (PDF-рапорти як докази):")} {withReport.length}</div>
          {withReport.length > 0 && <div className="mt-1">{withReport.map(w => w.name).join(", ")}</div>}
          {withoutReport.length > 0 && (
            <div className="mt-1 text-amber-700">{t("Без файла рапорту (не буде прикріплено):")} {withoutReport.map(w => w.name).join(", ")}</div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button onClick={() => { if (window.confirm(t("Надіслати лист клієнту на {to}?", { to }))) send.mutate(); }} loading={send.isPending} disabled={!to || !mismatches.length}>
            <Mail className="h-4 w-4" /> {t("Надіслати клієнту")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Report-hours cell: read-only for non-editors; click-to-edit inline for admins so they
// can fill hours manually (e.g. for workers who submitted before this feature existed).
function ReportHoursCell({ w, month, canEdit }: { w: HourRow; month: string; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: (hours: string | null) => post("/hours/report", { workerId: w.workerId, month, hours, factoryId: w.factoryId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hours", month] }); qc.invalidateQueries({ queryKey: ["hours-day-compare"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  // The hours value links to the submitted report file (Drive) when there is one.
  const linked = w.reportSubmitted
    ? (w.reportLink
        ? <a href={w.reportLink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="font-semibold text-red-700 underline-offset-2 hover:underline" title={t("Відкрити рапорт")}>{w.reportHours} {t("год")}</a>
        : <span className="font-semibold text-slate-700">{w.reportHours} {t("год")}</span>)
    : <Badge color="amber">{t("не вислано")}</Badge>;
  if (!canEdit) return linked;
  if (editing) {
    const submit = () => save.mutate(val.replace(",", ".").trim() || null);
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Input value={val} onChange={e => setVal(e.target.value)} inputMode="decimal" placeholder="1–400" className="w-20 text-right" autoFocus
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false); }} />
        <button onClick={submit} disabled={save.isPending} className="rounded-md p-1 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
        <button onClick={() => setEditing(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {linked}
      <button onClick={() => { setVal(w.reportHours != null ? String(w.reportHours) : ""); setEditing(true); }} className="rounded-md p-0.5 text-slate-300 hover:text-red-600" title={t("Вписати години")}><Pencil className="h-3.5 w-3.5" /></button>
    </span>
  );
}
