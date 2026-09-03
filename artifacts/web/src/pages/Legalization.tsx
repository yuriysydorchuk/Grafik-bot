// «Легалізація» (/legalization, cap `legalization`) — дашборд світлофорів по
// документах: зведення-чипи, фільтри, таблиця з причинами (розгортання рядка),
// Excel-експорт, перерахунок усіх. Фаза 2 плану worker-docs-signing (D6).
import { Fragment, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, FileSpreadsheet, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { get, post, type LegalizationDashboard, type LegalizationRow, type LegalityStatus } from "../lib/api";
import { Card, Spinner, Select, Input, Empty, Button } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT, type TFn } from "../lib/i18n";
import {
  LEGALITY_STATUSES, LEGALITY_LABEL, LEGALITY_BADGE, LEGALITY_DOT, LEGALITY_ROW,
  AXIS_LABEL, MISMATCH_LABEL, reasonText, daysUntil,
} from "../lib/legality";
import { NatFlag } from "../lib/nationality";
import { LEGAL_LABEL, type LegalStatus } from "../lib/legalStatus";

type SortKey = "expiry" | "name" | "status";
const NOT_COMPUTED_BADGE = "bg-slate-100 text-slate-500 ring-slate-200";

// Плитки дашборду ведуть сюди з початковим фільтром: /legalization?status=illegal,
// ?soon=1 (строк ≤30 днів), ?review=1 (потребують перевірки).
function initialFilters() {
  const p = new URLSearchParams(window.location.search);
  return { status: p.get("status") ?? "", soon: p.get("soon") === "1", review: p.get("review") === "1" };
}

export default function Legalization() {
  const t = useT();
  const qc = useQueryClient();
  const init = useMemo(initialFilters, []);
  const { data, isLoading } = useQuery<LegalizationDashboard>({ queryKey: ["legalization"], queryFn: () => get("/legalization") });

  const [q, setQ] = useState("");
  const [factory, setFactory] = useState("");
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState(init.status);
  const [soon, setSoon] = useState(init.soon);
  const [reviewOnly, setReviewOnly] = useState(init.review);
  const [sort, setSort] = useState<SortKey>("expiry");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const recompute = useMutation({
    mutationFn: () => post<{ total: number; byOverall: Record<string, number>; reviewRequired: number }>("/legalization/recompute-all"),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ["legalization"] });
      toast.success(t("Перераховано {n}", { n: r.total }), { description: t("Потребують перевірки: {n}", { n: r.reviewRequired }) });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];
  const factories = useMemo(
    () => [...new Map(rows.filter(r => r.factoryId).map(r => [r.factoryId!, r.factoryName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk")),
    [rows],
  );
  const companies = useMemo(
    () => [...new Map(rows.filter(r => r.companyId).map(r => [r.companyId!, r.companyName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk")),
    [rows],
  );

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    let list = rows.filter(r => {
      if (query && !r.fullName.toLowerCase().includes(query) && !(r.workerCode ?? "").toLowerCase().includes(query)) return false;
      if (factory && String(r.factoryId ?? "") !== factory) return false;
      if (company && String(r.companyId ?? "") !== company) return false;
      if (status) { if (status === "notComputed") { if (r.legality) return false; } else if (r.legality?.overall !== status) return false; }
      if (soon) { const d = daysUntil(r.legality?.nextExpiryAt); if (d === null || d > 30) return false; }
      // «потребують перевірки» = або движок питає підтвердження, або є аплоуд з бота, що
      // чекає офіс (той самий query-параметр ?review=1 веде сюди з плитки «на перевірці»)
      if (reviewOnly && !r.legality?.reviewRequired && r.pendingDocs === 0) return false;
      return true;
    });
    const cmp: Record<SortKey, (a: LegalizationRow, b: LegalizationRow) => number> = {
      expiry: (a, b) => {
        const da = daysUntil(a.legality?.nextExpiryAt), db_ = daysUntil(b.legality?.nextExpiryAt);
        if (da === null && db_ === null) return 0;
        if (da === null) return 1;
        if (db_ === null) return -1;
        return da - db_;
      },
      name: (a, b) => a.fullName.localeCompare(b.fullName, "pl"),
      status: (a, b) => (a.legality?.overall ?? "zzz").localeCompare(b.legality?.overall ?? "zzz"),
    };
    return [...list].sort((a, b) => sortDir * cmp[sort](a, b));
  }, [rows, q, factory, company, status, soon, reviewOnly, sort, sortDir]);

  const toggleRow = (id: number) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clickSort = (k: SortKey) => { if (sort === k) setSortDir(d => (d === 1 ? -1 : 1)); else { setSort(k); setSortDir(1); } };
  const sortIcon = (k: SortKey) => sort !== k ? null : (sortDir === 1 ? <ChevronUp className="inline h-3 w-3" /> : <ChevronDown className="inline h-3 w-3" />);
  const resetFilters = () => { setQ(""); setFactory(""); setCompany(""); setStatus(""); setSoon(false); setReviewOnly(false); };
  const filtersActive = !!(q || factory || company || status || soon || reviewOnly);

  return (
    <div>
      <PageHeader
        title={t("Легалізація")}
        subtitle={data ? t("{n} активних, розраховано {today}", { n: data.summary.total, today: data.today }) : ""}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" loading={recompute.isPending} onClick={() => recompute.mutate()}>
              <RefreshCw className="h-4 w-4" /> {t("Перерахувати всіх")}
            </Button>
            <a href="/api/legalization/excel"><Button variant="secondary"><FileSpreadsheet className="h-4 w-4" /> Excel</Button></a>
          </div>
        }
      />

      {isLoading || !data ? <Spinner /> : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {LEGALITY_STATUSES.map(s => (
              <button key={s} onClick={() => setStatus(v => (v === s ? "" : s))}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  status === s ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                <span className={`h-2 w-2 rounded-full ${LEGALITY_DOT[s]}`} /> {t(LEGALITY_LABEL[s])} <span className="font-semibold">{data.summary[s]}</span>
              </button>
            ))}
            <button onClick={() => setStatus(v => (v === "notComputed" ? "" : "notComputed"))}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                status === "notComputed" ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {t("ще не рахувалось")} <span className="font-semibold">{data.summary.notComputed}</span>
            </button>
            <button onClick={() => setReviewOnly(v => !v)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                reviewOnly ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {t("потребують перевірки")} <span className="font-semibold">{data.summary.review}</span>
            </button>
            <span className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500">
              {t("на перевірці з бота")} <span className="font-semibold">{data.summary.pendingDocs}</span>
            </span>
          </div>

          <Card className="mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук за іменем або кодом")} className="w-56" />
            <Select value={factory} onChange={e => setFactory(e.target.value)} className="w-48">
              <option value="">{t("Усі фабрики")}</option>
              {factories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
            <Select value={company} onChange={e => setCompany(e.target.value)} className="w-40">
              <option value="">{t("Усі фірми")}</option>
              {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={soon} onChange={e => setSoon(e.target.checked)} /> {t("строк ≤ 30 днів")}
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={reviewOnly} onChange={e => setReviewOnly(e.target.checked)} /> {t("потребують перевірки")}
            </label>
            {filtersActive && <button onClick={resetFilters} className="ml-auto text-xs text-slate-400 hover:text-slate-600">{t("Скинути фільтри")}</button>}
          </Card>

          <Card className="overflow-hidden">
            {filtered.length === 0 ? <Empty>{t("Немає працівників за цим фільтром.")}</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                    <tr>
                      <th className="cursor-pointer select-none px-3 py-2 whitespace-nowrap" onClick={() => clickSort("name")}>{t("Працівник")} {sortIcon("name")}</th>
                      <th className="px-3 py-2 whitespace-nowrap">{t("Фірма")}</th>
                      <th className="px-3 py-2 whitespace-nowrap">{t("Фабрика")}</th>
                      <th className="px-3 py-2 whitespace-nowrap">{t(AXIS_LABEL.stay)}</th>
                      <th className="px-3 py-2 whitespace-nowrap">{t(AXIS_LABEL.work)}</th>
                      <th className="cursor-pointer select-none px-3 py-2 whitespace-nowrap" onClick={() => clickSort("status")}>{t(AXIS_LABEL.overall)} {sortIcon("status")}</th>
                      <th className="cursor-pointer select-none px-3 py-2 whitespace-nowrap" onClick={() => clickSort("expiry")}>{t("Наступний термін")} {sortIcon("expiry")}</th>
                      <th className="px-3 py-2 whitespace-nowrap">{t("Форма легалізації")}</th>
                      <th className="px-3 py-2 whitespace-nowrap">{t("Перевірка")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map(r => (
                      <RowGroup key={r.id} r={r} open={expanded.has(r.id)} onToggle={() => toggleRow(r.id)} t={t} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function RowGroup({ r, open, onToggle, t }: { r: LegalizationRow; open: boolean; onToggle: () => void; t: TFn }) {
  const lg = r.legality;
  const d = daysUntil(lg?.nextExpiryAt);
  return (
    <Fragment>
      <tr className={`cursor-pointer ${lg ? LEGALITY_ROW[lg.overall] : "bg-slate-50/50"} hover:brightness-95`} onClick={onToggle}>
        <td className="px-3 py-2">
          <Link href={`/workers/${r.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-red-600 hover:underline">
            <NatFlag value={r.nationality} />{r.fullName}
          </Link>
          {r.workerCode && <span className="ml-1 text-xs text-slate-400">#{r.workerCode}</span>}
        </td>
        <td className="px-3 py-2 text-slate-500">{r.companyName ?? "—"}</td>
        <td className="px-3 py-2 text-slate-500">{r.factoryName ?? "—"}</td>
        <td className="px-3 py-2"><AxisCell status={lg?.stay} basis={r.stayBasis} t={t} /></td>
        <td className="px-3 py-2"><AxisCell status={lg?.work} basis={r.workBasis} t={t} /></td>
        <td className="px-3 py-2">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${lg ? LEGALITY_BADGE[lg.overall] : NOT_COMPUTED_BADGE}`}>
            {lg ? t(LEGALITY_LABEL[lg.overall]) : t("не рахувалось")}
          </span>
        </td>
        <td className="px-3 py-2">
          {lg?.nextExpiryAt ? (
            <span className={d !== null && d < 0 ? "font-medium text-rose-600" : d !== null && d <= 30 ? "font-medium text-amber-600" : "text-slate-600"}>
              {lg.nextExpiryAt}{d !== null ? ` (${d} ${t("дн.")})` : ""}
            </span>
          ) : <span className="text-slate-300">—</span>}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-slate-600">{r.legalStatus ? t(LEGAL_LABEL[r.legalStatus as LegalStatus] ?? r.legalStatus) : "—"}</span>
            {lg?.derivedLegalStatus && lg.legacyMismatchKind === "cross_class" && (
              <span className="text-xs font-medium text-rose-600">{t(MISMATCH_LABEL.cross_class!)}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            {lg?.reviewRequired && <span className="text-xs font-medium text-amber-600">{t("потребує перевірки")}</span>}
            {r.pendingDocs > 0 && <span className="text-xs text-slate-400">{t("{n} на перевірці", { n: r.pendingDocs })}</span>}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/70">
          <td colSpan={9} className="px-4 py-3 text-xs text-slate-600">
            {lg && lg.reasons.length > 0
              ? <ul className="list-disc space-y-0.5 pl-4">{lg.reasons.map((rs, i) => <li key={i}>{reasonText(t, rs)}</li>)}</ul>
              : <span className="text-slate-400">{t("Причин немає — усе гаразд.")}</span>}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function AxisCell({ status, basis, t }: { status?: LegalityStatus; basis: { label: string | null; until: string | null; docId: number | null } | null; t: TFn }) {
  if (!status) return <span className="text-slate-300">—</span>;
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${LEGALITY_DOT[status]}`} />
      <div className="min-w-0 max-w-[230px]">
        <div className="text-slate-700">{t(LEGALITY_LABEL[status])}</div>
        {basis?.label && <div className="truncate text-xs text-slate-400" title={`${basis.label}${basis.until ? ` · ${basis.until}` : ""}`}>{basis.label}{basis.until ? ` · ${t("до")} ${basis.until}` : ""}</div>}
      </div>
    </div>
  );
}
