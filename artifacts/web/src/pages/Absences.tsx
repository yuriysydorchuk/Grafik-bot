import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, DAY_UK, SHIFT_UK, type DayCode, type ShiftCode } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge, Button } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT, useLang } from "../lib/i18n";

interface Absence {
  entryId: number; workerId: number; name: string; code: string | null; factory: string | null;
  city: string | null;
  date: string; day: DayCode; shift: ShiftCode; reason: string | null;
  excused: boolean;             // відпросився (є причина)
  justified: boolean;           // виправдано адміном — не рахується в кількість/штраф
  penalty: number;              // ефективний штраф, zł
  penaltyOverride: number | null; // NULL = стандарт
  deductedMonth: string | null; // YYYY-MM сводної, куди перенесено штраф (NULL = ні)
  deductedAmount: number | null;
}
interface AbsenceRequest {
  id: number; workerId: number; name: string | null; factory: string | null;
  date: string; day: DayCode; shift: ShiftCode | null; reason: string | null; status: string; createdAt: string;
  substitutes: { id: number; name: string }[];
}
interface AbsencesResp {
  month: string; absences: Absence[]; total: number; excused: number; noShow: number;
  justified: number; penaltyTotal: number; defaultPenalty: number;
}

const fmtDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
const zl = (n: number) => `${Math.round(n * 100) / 100} zł`;

type WorkerSum = {
  key: string; name: string; code: string | null; factories: string[];
  total: number; excused: number; noShow: number; justified: number; penalty: number; items: Absence[];
};
type SortKey = "name" | "factory" | "total" | "excused" | "noShow" | "justified" | "penalty";

// Клікабельний заголовок із стрілкою сортування
function SortTh({ label, k, sort, onSort, center }: {
  label: string; k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (k: SortKey) => void; center?: boolean;
}) {
  return (
    <th className={`px-4 py-2.5 ${center ? "text-center" : "text-left"}`}>
      <button onClick={() => onSort(k)} className="inline-flex items-center gap-0.5 uppercase hover:text-slate-600">
        {label}
        {sort.key === k && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

export default function Absences() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const qc = useQueryClient();
  const me = useMe();
  const canEdit = can(me, "editData");
  const [month, setMonth] = useState(months[0]!.value);
  const [filter, setFilter] = useState<"all" | "excused" | "noshow" | "justified">("all");
  const [cityF, setCityF] = useState("");  // "" = всі міста
  const [facF, setFacF] = useState("");    // "" = всі фабрики
  const { data, isFetching } = useQuery<AbsencesResp>({
    queryKey: ["absences", month], queryFn: () => get(`/absences?month=${month}`),
  });
  const { data: requests = [] } = useQuery<AbsenceRequest[]>({ queryKey: ["absence-requests"], queryFn: () => get("/absence-requests") });
  const pending = requests.filter(r => r.status === "pending");
  // Відхилення — з опційною причиною: клік по «Відхилити» відкриває поле в картці
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const decide = useMutation({
    mutationFn: (v: { id: number; action: "approve" | "reject"; reason?: string }) =>
      post(`/absence-requests/${v.id}/${v.action}`, v.reason ? { reason: v.reason } : {}),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["absence-requests"] }); qc.invalidateQueries({ queryKey: ["absences", month] }); toast.success(v.action === "approve" ? t("Прийнято") : t("Відхилено")); setRejecting(null); setRejectReason(""); },
    onError: (e: any) => toast.error(e.message),
  });
  const substitute = useMutation({
    mutationFn: (v: { id: number; workerId: number }) => post(`/absence-requests/${v.id}/substitute`, { workerId: v.workerId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["absence-requests"] }); qc.invalidateQueries({ queryKey: ["absences", month] }); toast.success(t("Заміну призначено")); },
    onError: (e: any) => toast.error(e.message),
  });
  // Виправдання / штраф одного пропуску
  const patchAbs = useMutation({
    mutationFn: (v: { entryId: number; justified?: boolean; penalty?: number | null }) =>
      patch(`/absences/${v.entryId}`, { ...(v.justified !== undefined ? { justified: v.justified } : {}), ...("penalty" in v ? { penalty: v.penalty } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["absences", month] }),
    onError: (e: any) => toast.error(e.message),
  });

  // ── Перенесення штрафів у Kara сводної (формат — як бадання в Авансах) ─────
  const canSvodni = can(me, "svodni");
  const confirm = useConfirm();
  const eligible = (a: Absence) => !a.justified && a.penalty > 0 && !a.deductedMonth;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { data: svodniMonths } = useQuery<{ months: string[] }>({
    queryKey: ["svodni-months"], queryFn: () => get("/svodni/months"), enabled: canSvodni,
  });
  const [target, setTarget] = useState(month);
  useEffect(() => { setTarget(month); }, [month]);
  const targetMonths = useMemo(
    () => [...new Set([month, ...(svodniMonths?.months ?? [])])].sort().reverse(),
    [month, svodniMonths]);
  const apply = useMutation({
    mutationFn: (entryIds: number[]) => post<{
      updated: number; itemsMarked: number; verified: number;
      verifyMismatches: { workerName: string; expected: number | null; actual: number | null }[];
      skippedLocked: number; unmatched: { workerName: string | null; amount: number }[];
    }>("/svodni/apply-absence-deductions", { month: target, entryIds }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["absences", month] });
      const parts = [`${t("оновлено рядків")}: ${d.updated}`, `${t("позицій знято")}: ${d.itemsMarked}`, `${t("звірено")}: ${d.verified - d.verifyMismatches.length}/${d.verified} ✓`];
      if (d.skippedLocked) parts.push(`${t("пропущено затверджених")}: ${d.skippedLocked}`);
      toast.success(t("Перенесено до сводної"), { description: parts.join(", ") });
      if (d.verifyMismatches.length) {
        toast.error(`${t("Самозвірка не зійшлася")}: ${d.verifyMismatches.length}`, {
          description: d.verifyMismatches.slice(0, 6).map(v => `${v.workerName}: ${v.expected ?? 0} ≠ ${v.actual ?? 0}`).join(", "), duration: 15000,
        });
      }
      if (d.unmatched.length) {
        toast.warning(`${t("Без рядка сводної")}: ${d.unmatched.length}`, {
          description: d.unmatched.slice(0, 6).map(u => u.workerName ?? "—").join(", ") + (d.unmatched.length > 6 ? "…" : ""), duration: 12000,
        });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });
  const undo = useMutation({
    mutationFn: (entryId: number) => post<{ month: string; subtracted: { factoryLabel: string; newValue: number | null } | null; warning: string | null }>("/svodni/undo-absence-deduction", { entryId }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["absences", month] });
      if (d.warning) toast.warning(t("Відмінено з попередженням"), { description: d.warning, duration: 12000 });
      else toast.success(t("Відмінено"), { description: `${d.subtracted!.factoryLabel} (${d.month}): Kara → ${d.subtracted!.newValue ?? 0} zł` });
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Фільтри «зверху»: місто/фабрика звужують таблиці, підсумки і перенесення в сводну
  const scoped = useMemo(() => (data?.absences ?? []).filter(a =>
    (!cityF || a.city === cityF) && (!facF || a.factory === facF)), [data, cityF, facF]);
  const cities = useMemo(() =>
    [...new Set((data?.absences ?? []).map(a => a.city).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "pl")), [data]);
  const factoryOpts = useMemo(() =>
    [...new Set((data?.absences ?? []).filter(a => !cityF || a.city === cityF).map(a => a.factory).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b, "pl")), [data, cityF]);
  // Бейджі-підсумки рахуються по відфільтрованому набору (дзеркало серверної логіки)
  const sums = useMemo(() => {
    const counted = scoped.filter(a => !a.justified);
    const noShow = counted.filter(a => !a.excused).length;
    return {
      total: counted.length, excused: counted.length - noShow, noShow,
      justified: scoped.length - counted.length,
      penaltyTotal: Math.round(scoped.reduce((s, a) => s + a.penalty, 0) * 100) / 100,
    };
  }, [scoped]);
  const rows = useMemo(() => {
    if (filter === "all") return scoped;
    if (filter === "justified") return scoped.filter(a => a.justified);
    return scoped.filter(a => !a.justified && (filter === "excused" ? a.excused : !a.excused));
  }, [scoped, filter]);

  // Зведення по кожному працівнику (поважає фільтр вище); клік по рядку розкриває деталі.
  // Виправдані пропуски НЕ рахуються в кількість/штраф — показуються окремою колонкою.
  const [openWorker, setOpenWorker] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "total", dir: "desc" });
  const onSort = (key: SortKey) => setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "factory" ? "asc" : "desc" });
  const byWorker = useMemo<WorkerSum[]>(() => {
    const map = new Map<string, WorkerSum>();
    for (const a of rows) {
      const key = String(a.workerId ?? a.code ?? a.name);
      let w = map.get(key);
      if (!w) { w = { key, name: a.name, code: a.code, factories: [], total: 0, excused: 0, noShow: 0, justified: 0, penalty: 0, items: [] }; map.set(key, w); }
      if (a.factory && !w.factories.includes(a.factory)) w.factories.push(a.factory);
      if (a.justified) w.justified++;
      else { w.total++; a.excused ? w.excused++ : w.noShow++; w.penalty += a.penalty; }
      w.items.push(a);
    }
    for (const w of map.values()) { w.items.sort((a, b) => a.date.localeCompare(b.date)); w.penalty = Math.round(w.penalty * 100) / 100; }
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (w: WorkerSum) => sort.key === "name" ? w.name : sort.key === "factory" ? w.factories.join(", ") : w[sort.key];
    return [...map.values()].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb), "pl") : (va as number) - (vb as number);
      return c !== 0 ? c * dir : a.name.localeCompare(b.name, "pl");
    });
  }, [rows, sort]);

  // Незняті штрафи по працівниках (для перенесення); типово вибрані всі
  const eligByWorker = useMemo(() => {
    const m = new Map<string, { entryIds: number[]; sum: number }>();
    for (const a of rows) {
      if (!eligible(a)) continue;
      const key = String(a.workerId ?? a.code ?? a.name);
      const e = m.get(key) ?? m.set(key, { entryIds: [], sum: 0 }).get(key)!;
      e.entryIds.push(a.entryId);
      e.sum = Math.round((e.sum + a.penalty) * 100) / 100;
    }
    return m;
  }, [rows]);
  useEffect(() => { setSel(new Set(eligByWorker.keys())); }, [eligByWorker]);
  const toggleSel = (key: string) => setSel(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const selKeys = [...eligByWorker.keys()].filter(k => sel.has(k));
  const allSelected = eligByWorker.size > 0 && selKeys.length === eligByWorker.size;
  const selSum = Math.round(selKeys.reduce((s, k) => s + eligByWorker.get(k)!.sum, 0) * 100) / 100;
  const selEntryIds = selKeys.flatMap(k => eligByWorker.get(k)!.entryIds);

  return (
    <>
      <PageHeader title={t("Відсутності")} subtitle={t("Пропуски змін із причинами (із затвердженого графіку)")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <Select value={filter} onChange={e => setFilter(e.target.value as any)} className="w-48">
          <option value="all">{t("Усі пропуски")}</option>
          <option value="excused">{t("Тільки відпросились")}</option>
          <option value="noshow">{t("Тільки нез'явлення")}</option>
          <option value="justified">{t("Тільки виправдані")}</option>
        </Select>
        <Select value={cityF} onChange={e => { setCityF(e.target.value); setFacF(""); }} className="w-40">
          <option value="">{t("Всі міста")}</option>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select value={facF} onChange={e => setFacF(e.target.value)} className="w-48">
          <option value="">{t("Всі фабрики")}</option>
          {factoryOpts.map(f => <option key={f} value={f}>{f}</option>)}
        </Select>
        {data && (
          <div className="flex flex-wrap gap-2">
            <Badge color="slate">{t("Усього:")} {sums.total}</Badge>
            <Badge color="amber">{t("Відпросились:")} {sums.excused}</Badge>
            <Badge color="rose">{t("Нез'явлення:")} {sums.noShow}</Badge>
            {sums.justified > 0 && <Badge color="green">{t("Виправдано:")} {sums.justified}</Badge>}
            <Badge color="red">{t("Штрафи:")} {zl(sums.penaltyTotal)}</Badge>
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <Card className="mb-5 border-amber-200 bg-amber-50/40 p-4">
          <div className="mb-2 text-sm font-semibold text-slate-700">🙋 {t("Зголошення відсутності на розгляді")} ({pending.length})</div>
          <div className="space-y-2">
            {pending.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700">{r.name ?? "—"} {r.factory && <Badge color="slate">{r.factory}</Badge>}</div>
                  <div className="text-sm text-slate-500">{fmtDate(r.date)} · {DAY_UK[r.day]} · {r.shift ? SHIFT_UK[r.shift] : `🏖 ${t("цілий день")}`}</div>
                  {r.reason && <div className="mt-0.5 text-sm text-slate-600">📝 {r.reason}</div>}
                  {r.shift == null ? (
                    <div className="mt-1 text-xs text-slate-400">{t("Вихідний на цілий день — без прив'язки до зміни")}</div>
                  ) : r.substitutes.length > 0 ? (
                    <div className="mt-1.5">
                      <div className="text-xs font-medium text-slate-500">{t("Можливі заміни (доступні на цю зміну):")}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.substitutes.map(s => (
                          <button key={s.id} onClick={() => substitute.mutate({ id: r.id, workerId: s.id })} disabled={substitute.isPending}
                            className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                            ↪ {t("Призначити")} {s.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : <div className="mt-1 text-xs text-slate-400">{t("Доступних замін не знайдено")}</div>}
                </div>
                {rejecting === r.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <input autoFocus value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") decide.mutate({ id: r.id, action: "reject", reason: rejectReason.trim() || undefined }); if (e.key === "Escape") { setRejecting(null); setRejectReason(""); } }}
                      placeholder={t("Причина відхилення (необов'язково)")}
                      className="w-56 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs focus:border-rose-400 focus:outline-none" />
                    <button onClick={() => decide.mutate({ id: r.id, action: "reject", reason: rejectReason.trim() || undefined })} disabled={decide.isPending}
                      className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"><X className="h-4 w-4" /> {t("Відхилити")}</button>
                    <button onClick={() => { setRejecting(null); setRejectReason(""); }} className="rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100">{t("Скасувати")}</button>
                  </div>
                ) : (
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => decide.mutate({ id: r.id, action: "approve" })} disabled={decide.isPending} className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Check className="h-4 w-4" /> {t("Прийняти")}</button>
                    <button onClick={() => { setRejecting(r.id); setRejectReason(""); }} disabled={decide.isPending} className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"><X className="h-4 w-4" /> {t("Відхилити")}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="mb-5 overflow-x-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
            <span className="text-sm font-semibold text-slate-700">👤 {t("По працівниках")}</span>
            <span className="ml-2 text-xs text-slate-400">{t("Клікніть на працівника, щоб побачити деталі. Виправдані пропуски не рахуються.")}</span>
            {canSvodni && eligByWorker.size > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <Select value={target} onChange={e => setTarget(e.target.value)} className="w-36" title={t("Місяць сводної")}>
                  {targetMonths.map(m => <option key={m} value={m}>{m}</option>)}
                </Select>
                <Button loading={apply.isPending} disabled={!selEntryIds.length}
                  onClick={async () => { if (await confirm({ title: t("Перенести штрафи за пропуски до сводної?"), message: t("Суми вибраних ляжуть у колонку Kara рядка фабрики пропуску (нема рядка пари — основної фабрики людини) за вибраний місяць (додаються до наявних). Затверджені вкладки пропускаються."), confirmText: t("Перенести") })) apply.mutate(selEntryIds); }}>
                  → {allSelected ? t("Перенести всі") : `${t("Перенести вибрані")} (${selKeys.length})`} · {selSum.toFixed(2)} zł
                </Button>
              </div>
            )}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                {canSvodni && (
                  <th className="w-8 px-3 py-2.5">
                    <input type="checkbox" className="accent-red-600" checked={allSelected} disabled={!eligByWorker.size}
                      onChange={() => setSel(allSelected ? new Set() : new Set(eligByWorker.keys()))} />
                  </th>
                )}
                <SortTh label={t("Працівник")} k="name" sort={sort} onSort={onSort} />
                <th className="px-4 py-2.5">{t("Код")}</th>
                <SortTh label={t("Фабрика")} k="factory" sort={sort} onSort={onSort} />
                <SortTh label={t("Усього")} k="total" sort={sort} onSort={onSort} center />
                <SortTh label={t("Відпросився")} k="excused" sort={sort} onSort={onSort} center />
                <SortTh label={t("Нез'явлення")} k="noShow" sort={sort} onSort={onSort} center />
                <SortTh label={t("Виправдано")} k="justified" sort={sort} onSort={onSort} center />
                <SortTh label={t("Штраф")} k="penalty" sort={sort} onSort={onSort} center />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byWorker.map(w => (
                <WorkerRows key={w.key} w={w} open={openWorker === w.key} canEdit={canEdit}
                  defaultPenalty={data?.defaultPenalty ?? 200}
                  canSvodni={canSvodni} selectable={eligByWorker.has(w.key)} selected={sel.has(w.key)}
                  onSelToggle={() => toggleSel(w.key)} onUndo={(entryId) => undo.mutate(entryId)} undoing={undo.isPending}
                  onToggle={() => setOpenWorker(k => (k === w.key ? null : w.key))}
                  onPatch={(v) => patchAbs.mutate(v)} patching={patchAbs.isPending} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-700">
                <td className="px-4 py-2.5" colSpan={canSvodni ? 4 : 3}>{t("Разом")}</td>
                <td className="px-4 py-2.5 text-center">{byWorker.reduce((s, w) => s + w.total, 0)}</td>
                <td className="px-4 py-2.5 text-center">{byWorker.reduce((s, w) => s + w.excused, 0)}</td>
                <td className="px-4 py-2.5 text-center">{byWorker.reduce((s, w) => s + w.noShow, 0)}</td>
                <td className="px-4 py-2.5 text-center">{byWorker.reduce((s, w) => s + w.justified, 0)}</td>
                <td className="px-4 py-2.5 text-center">{zl(byWorker.reduce((s, w) => s + w.penalty, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}

      {isFetching && !data ? <Spinner /> : !rows.length ? <Empty>{t("За цей місяць немає пропусків")}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">{t("Дата")}</th><th className="px-4 py-2.5">{t("День")}</th>
                <th className="px-4 py-2.5">{t("Працівник")}</th><th className="px-4 py-2.5">{t("Фабрика")}</th>
                <th className="px-4 py-2.5 text-center">{t("Зміна")}</th><th className="px-4 py-2.5">{t("Тип")}</th>
                <th className="px-4 py-2.5">{t("Причина")}</th>
                <th className="px-4 py-2.5 text-right">{t("Штраф")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((a) => (
                <tr key={a.entryId} className={`hover:bg-slate-50 ${a.justified ? "opacity-60" : ""}`}>
                  <td className="px-4 py-2.5 font-medium text-slate-700">{fmtDate(a.date)}</td>
                  <td className="px-4 py-2.5 text-slate-500">{DAY_UK[a.day]}</td>
                  <td className="px-4 py-2.5 text-slate-700">{a.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{a.factory ?? "—"}</td>
                  <td className="px-4 py-2.5 text-center text-slate-500">{SHIFT_UK[a.shift]}</td>
                  <td className="px-4 py-2.5">
                    {a.justified ? <Badge color="green">{t("Виправдано")}</Badge>
                      : a.excused ? <Badge color="amber">{t("Відпросився")}</Badge>
                      : <Badge color="rose">{t("Нез'явлення")}</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{a.reason || <span className="text-slate-300">{t("— без причини —")}</span>}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {a.justified || a.penalty === 0 ? <span className="text-slate-300">—</span> : (
                      <span className="font-medium text-slate-700">
                        {zl(a.penalty)}
                        {a.deductedMonth && <Badge color="green">{t("сводна")} {a.deductedMonth}</Badge>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

// Рядок зведення по працівнику + розкриття його пропусків із діями
// («виправдати», редагування/анулювання штрафу, відміна перенесення в сводну)
function WorkerRows({ w, open, canEdit, defaultPenalty, canSvodni, selectable, selected, onSelToggle, onUndo, undoing, onToggle, onPatch, patching }: {
  w: WorkerSum; open: boolean; canEdit: boolean; defaultPenalty: number;
  canSvodni: boolean; selectable: boolean; selected: boolean;
  onSelToggle: () => void; onUndo: (entryId: number) => void; undoing: boolean;
  onToggle: () => void;
  onPatch: (v: { entryId: number; justified?: boolean; penalty?: number | null }) => void;
  patching: boolean;
}) {
  const t = useT();
  const confirm = useConfirm();
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer ${open ? "bg-slate-50" : "hover:bg-slate-50"}`}>
        {canSvodni && (
          <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
            {selectable && <input type="checkbox" className="accent-red-600" checked={selected} onChange={onSelToggle} />}
          </td>
        )}
        <td className="px-4 py-2.5 font-medium text-slate-700">
          <span className={`mr-1.5 inline-block text-[10px] text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          {w.name}
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{w.code ?? "—"}</td>
        <td className="px-4 py-2.5 text-slate-500">{w.factories.join(", ") || "—"}</td>
        <td className="px-4 py-2.5 text-center font-semibold text-slate-700">{w.total || <span className="font-normal text-slate-300">·</span>}</td>
        <td className="px-4 py-2.5 text-center">{w.excused ? <Badge color="amber">{w.excused}</Badge> : <span className="text-slate-300">·</span>}</td>
        <td className="px-4 py-2.5 text-center">{w.noShow ? <Badge color="rose">{w.noShow}</Badge> : <span className="text-slate-300">·</span>}</td>
        <td className="px-4 py-2.5 text-center">{w.justified ? <Badge color="green">{w.justified}</Badge> : <span className="text-slate-300">·</span>}</td>
        <td className="px-4 py-2.5 text-center tabular-nums font-medium text-slate-700">{w.penalty ? zl(w.penalty) : <span className="font-normal text-slate-300">·</span>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={canSvodni ? 9 : 8} className="bg-slate-50/60 px-4 py-2">
            <div className="space-y-1">
              {w.items.map(a => (
                <div key={a.entryId} className={`flex flex-wrap items-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-sm ${a.justified ? "border-emerald-200" : "border-slate-200"}`}>
                  <span className="font-medium text-slate-700">{fmtDate(a.date)}</span>
                  <span className="text-slate-500">{DAY_UK[a.day]}</span>
                  <span className="text-slate-500">{SHIFT_UK[a.shift]}</span>
                  {a.factory && <Badge color="slate">{a.factory}</Badge>}
                  {a.justified ? <Badge color="green">{t("Виправдано")}</Badge>
                    : a.excused ? <Badge color="amber">{t("Відпросився")}</Badge>
                    : <Badge color="rose">{t("Нез'явлення")}</Badge>}
                  {a.reason && <span className="text-slate-500">📝 {a.reason}</span>}
                  <span className="ml-auto inline-flex items-center gap-1.5">
                    {a.deductedMonth ? (
                      <>
                        <span className="tabular-nums text-xs font-medium text-slate-600">{zl(a.deductedAmount ?? a.penalty)}</span>
                        <Badge color="green">{t("сводна")} {a.deductedMonth}</Badge>
                        {canSvodni && (
                          <button disabled={undoing}
                            onClick={async () => { if (await confirm({ title: t("Відмінити зняття?"), message: `${w.name} · ${zl(a.deductedAmount ?? a.penalty)} — ${t("сума віднімається з клітинки Kara сводної")} ${a.deductedMonth}. ${t("Запис повернеться у «до зняття».")}`, danger: true, confirmText: t("Відмінити") })) onUndo(a.entryId); }}
                            className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                            ↩ {t("Відмінити")}
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {!a.justified && <PenaltyEditor a={a} canEdit={canEdit} defaultPenalty={defaultPenalty} onPatch={onPatch} patching={patching} />}
                        {canEdit && (
                          <button onClick={() => onPatch({ entryId: a.entryId, justified: !a.justified })} disabled={patching}
                            title={a.justified ? t("Пропуск знову рахуватиметься і матиме штраф") : t("Виправданий пропуск не рахується в кількість і не має штрафу")}
                            className={`rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${a.justified
                              ? "border-slate-200 text-slate-500 hover:bg-slate-50"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}>
                            {a.justified ? t("Зняти виправдання") : `✔ ${t("Виправдати")}`}
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Штраф пропуску: показ + редагування (свій розмір / анулювати / повернути стандарт)
function PenaltyEditor({ a, canEdit, defaultPenalty, onPatch, patching }: {
  a: Absence; canEdit: boolean; defaultPenalty: number;
  onPatch: (v: { entryId: number; penalty: number | null }) => void; patching: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  if (!canEdit) return <span className="tabular-nums text-xs font-medium text-slate-600">{a.penalty ? zl(a.penalty) : "—"}</span>;
  if (!editing) {
    return (
      <button onClick={() => { setVal(String(a.penalty)); setEditing(true); }} disabled={patching}
        title={t("Змінити штраф (стандарт {n} zł)", { n: defaultPenalty })}
        className={`rounded-md border px-2 py-1 text-xs font-medium tabular-nums disabled:opacity-50 ${a.penalty === 0
          ? "border-slate-200 text-slate-400 hover:bg-slate-50"
          : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"}`}>
        {a.penalty === 0 ? t("без штрафу") : zl(a.penalty)}{a.penaltyOverride == null ? "" : " *"}
      </button>
    );
  }
  const commit = () => {
    const n = Number(val.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { toast.error(t("Невірна сума")); return; }
    onPatch({ entryId: a.entryId, penalty: n });
    setEditing(false);
  };
  return (
    <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
      <input autoFocus value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className="w-16 rounded-md border border-slate-300 px-1.5 py-0.5 text-right text-xs tabular-nums focus:border-red-400 focus:outline-none" />
      <button onClick={commit} className="rounded-md bg-emerald-50 px-1.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">OK</button>
      <button onClick={() => { onPatch({ entryId: a.entryId, penalty: 0 }); setEditing(false); }}
        className="rounded-md px-1.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100">{t("Анулювати")}</button>
      {a.penaltyOverride != null && (
        <button onClick={() => { onPatch({ entryId: a.entryId, penalty: null }); setEditing(false); }}
          title={t("Повернути стандартний штраф")}
          className="rounded-md px-1.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100">{defaultPenalty} zł</button>
      )}
      <button onClick={() => setEditing(false)} className="rounded-md px-1 py-1 text-xs text-slate-400 hover:bg-slate-100"><X className="h-3.5 w-3.5" /></button>
    </span>
  );
}
