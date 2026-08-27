// «Прибирання» (/cleaning, cap `cleaning`) — окремий під-бізнес: прибирання
// wspólnot mieszkaniowych. Самодостатній розділ (роль може бачити лише його):
// Дохід (KSeF-продажі на вспульноти, акруал M−1) · Винагродження (вільний список
// людей, складові сум, поділ конто/готівка, привʼязка до вспульнот — ЗП ділиться
// порівну) · Видатки (позначені фактури + готівка cleaning-категорій каси) ·
// P&L (по кожній вспульноті і разом, по місяцях року) · Вспульноти (реєстр).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil, Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label, cn } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { monthOptions } from "../lib/dates";
import { useT } from "../lib/i18n";

type Project = { id: number; name: string; nip: string | null; active: boolean; note: string | null };
type IncomeRow = {
  id: number; month: string; issueDate: string; number: string; firm: string | null;
  buyerName: string | null; buyerNip: string | null; net: number; gross: number;
  paid: boolean; paidDate: string | null; drivePdfId: string | null;
  projectId: number | null; projectManual: boolean;
};
type IncomeData = { rows: IncomeRow[]; projects: Project[]; totals: { net: number; gross: number; unpaidGross: number; count: number; unmatched: number } };
type Component = { label: string; amount: number };
type PayrollRow = {
  id: number; periodMonth: string; name: string; base: number; hours: number | null; rate: number | null;
  components: Component[]; total: number; konto: number; cash: number; note: string | null; projectIds: number[];
};
type PayrollData = { month: string; rows: PayrollRow[]; projects: Project[]; totals: { total: number; konto: number; cash: number; count: number } };
type ExpenseRow = {
  key: string; origin: "local" | "ksef" | "cash"; id: number; month: string; date: string | null;
  number: string | null; counterparty: string | null; firm: string | null; amount: number;
  paid: boolean; projectId: number | null; source: "invoice" | "ksef" | "cash"; note: string | null;
};
type ExpenseData = { rows: ExpenseRow[]; projects: Project[]; totals: { amount: number; count: number } };
type PnlCell = { revenue: number; payroll: number; expenses: number; margin: number };
type PnlData = {
  year: string; months: string[];
  projects: { id: number; name: string; nip: string | null; active: boolean; byMonth: Record<string, PnlCell>; totals: PnlCell }[];
  common: { byMonth: Record<string, PnlCell>; totals: PnlCell };
  totalsByMonth: Record<string, PnlCell>; totals: PnlCell;
};

const fmt = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (s: string) => Number(String(s).replace(/\s/g, "").replace(",", "."));
const r2 = (n: number) => Math.round(n * 100) / 100;

// Скорочена назва вспульноти для таблиць/селектів: без «WSPÓLNOTA MIESZKANIOWA /
// PRZY UL. / W LUBLINIE», капс → Title Case («ZYGMUNTA AUGUSTA 31» → «Zygmunta
// Augusta 31»). Повна назва — в тултіпах; реєстр (вкладка «Вспульноти») тримає повну.
const shortProj = (name: string): string => {
  const s = name
    .replace(/WSPÓLNOTA (MIESZKANIOWA|LOKALOWA)/gi, " ")
    .replace(/NIERUCHOMOŚCI/gi, " ").replace(/PRZY UL\.?/gi, " ")
    .replace(/ W LUBLINIE\b/gi, " ").replace(/\s+/g, " ").trim() || name;
  return s.split(" ")
    .map(w => w === "I" || w === "i" ? "i" : w.toLocaleLowerCase("pl-PL").replace(/(^|\.)\p{L}/gu, m => m.toUpperCase()))
    .join(" ");
};

export default function Cleaning() {
  const t = useT();
  const [tab, setTab] = useState<"income" | "payroll" | "workers" | "expenses" | "pnl" | "projects">("income");
  const TABS: [typeof tab, string][] = [
    ["income", t("Дохід")], ["payroll", t("Винагродження")], ["workers", t("Працівники")],
    ["expenses", t("Видатки")], ["pnl", "P&L"], ["projects", t("Вспульноти")],
  ];
  const months = useMemo(() => monthOptions("uk-UA", 18), []);
  const [month, setMonth] = useState(months[0]!.value);
  return (
    <>
      <PageHeader title={t("Прибирання")} subtitle={t("окремий бізнес: вспульноти — дохід, винагродження, видатки, P&L")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-lg px-3 py-1.5 ${tab === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        {tab !== "pnl" && tab !== "projects" && tab !== "workers" && (
          <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
            {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        )}
      </div>
      {tab === "income" && <IncomeTab month={month} />}
      {tab === "payroll" && <PayrollTab month={month} />}
      {tab === "workers" && <WorkersTab />}
      {tab === "expenses" && <ExpensesTab month={month} />}
      {tab === "pnl" && <PnlTab />}
      {tab === "projects" && <ProjectsTab />}
    </>
  );
}

// ── Дохід ─────────────────────────────────────────────────────────────────────
function IncomeTab({ month }: { month: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isFetching } = useQuery<IncomeData>({
    queryKey: ["cleaning-income", month], queryFn: () => get(`/cleaning/income?month=${month}`),
  });
  const projById = useMemo(() => new Map((data?.projects ?? []).map(p => [p.id, p])), [data]);
  const attach = useMutation({
    mutationFn: (p: { id: number; projectId: number | null }) => patch(`/cleaning/income/${p.id}`, { projectId: p.projectId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cleaning-income"] }); qc.invalidateQueries({ queryKey: ["cleaning-pnl"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  if (isFetching && !data) return <Spinner />;
  if (!data) return null;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge color="green">{t("Нетто:")} {fmt(data.totals.net)} zł</Badge>
        <Badge color="slate">{t("Брутто:")} {fmt(data.totals.gross)} zł</Badge>
        {data.totals.unpaidGross > 0 && <Badge color="amber">{t("Не оплачено:")} {fmt(data.totals.unpaidGross)} zł</Badge>}
        <Badge color="slate">{data.totals.count} {t("факт.")}</Badge>
        {data.totals.unmatched > 0 && <Badge color="rose">{t("без вспульноти:")} {data.totals.unmatched}</Badge>}
      </div>
      {!data.rows.length ? (
        <Empty>{t("За цей місяць фактур на вспульноти немає. Дохід тягнеться з KSeF автоматично (покупці WSPÓLNOTA…), місяць — за датою виставлення.")}</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">{t("Дата")}</th>
                <th className="px-4 py-2">{t("Номер")}</th>
                <th className="px-4 py-2">{t("Фірма")}</th>
                <th className="px-4 py-2">{t("Вспульнота")}</th>
                <th className="px-4 py-2 text-right">{t("Нетто")}</th>
                <th className="px-4 py-2 text-right">{t("Брутто")}</th>
                <th className="px-4 py-2">{t("Оплата")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(r => (
                <tr key={r.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-500">{r.issueDate}</td>
                  <td className="px-4 py-2 font-medium text-slate-700">{r.number}</td>
                  <td className="px-4 py-2 text-slate-500">{r.firm}</td>
                  <td className="px-4 py-2">
                    {r.projectId != null ? (
                      <span className="inline-flex items-center gap-1" title={projById.get(r.projectId)?.name}>
                        <Badge color="blue">{shortProj(projById.get(r.projectId)?.name ?? `#${r.projectId}`)}</Badge>
                        {r.projectManual && (
                          <button className="text-xs text-slate-400 hover:text-rose-500" title={t("Прибрати ручну привʼязку")}
                            onClick={() => attach.mutate({ id: r.id, projectId: null })}>✕</button>
                        )}
                      </span>
                    ) : (
                      <Select className="w-48 py-1 text-xs" value=""
                        onChange={e => e.target.value && attach.mutate({ id: r.id, projectId: Number(e.target.value) })}>
                        <option value="">{t("— привʼязати —")}</option>
                        {(data.projects ?? []).filter(p => p.active).map(p => <option key={p.id} value={p.id}>{shortProj(p.name)}</option>)}
                      </Select>
                    )}
                    <div className="text-[11px] text-slate-400">{r.buyerName}</div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(r.net)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmt(r.gross)}</td>
                  <td className="px-4 py-2">
                    {r.paid ? <Badge color="green">{r.paidDate ?? t("оплачена")}</Badge> : <Badge color="amber">{t("очікує")}</Badge>}
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

// ── Винагродження ─────────────────────────────────────────────────────────────
// Вигляд «як сводна»: числові колонки Podstawa / Дод. год / Ставка / Дод., zł /
// Доплати / Відрахування / Разом / Конто / Готівка, клік по клітинці — правка,
// вспульноти додаються/знімаються прямо в рядку, футер — підсумки колонок.
function PayrollTab({ month }: { month: string }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isFetching } = useQuery<PayrollData>({
    queryKey: ["cleaning-payrolls", month], queryFn: () => get(`/cleaning/payrolls?month=${month}`),
  });
  const [editing, setEditing] = useState<PayrollRow | "new" | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["cleaning-payrolls"] }); qc.invalidateQueries({ queryKey: ["cleaning-pnl"] }); };
  const patchRow = useMutation({
    mutationFn: (p: { id: number; body: Record<string, unknown> }) => patch(`/cleaning/payrolls/${p.id}`, p.body),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/cleaning/payrolls/${id}`),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.message),
  });
  const fromWorkers = useMutation({
    mutationFn: () => post<{ created: number; skipped: number }>("/cleaning/payrolls/from-workers", { month }),
    onSuccess: (d) => {
      invalidate();
      toast.success(`${t("Створено рядків:")} ${d.created}`, { description: d.skipped ? `${t("пропущено (вже є):")} ${d.skipped}` : undefined });
    },
    onError: (e: any) => toast.error(e.message),
  });
  if (isFetching && !data) return <Spinner />;
  if (!data) return null;
  const sum = (f: (r: PayrollRow) => number) => r2(data.rows.reduce((s, r) => s + f(r), 0));
  const extra = (r: PayrollRow) => r2((r.hours ?? 0) * (r.rate ?? 0));
  const additions = (r: PayrollRow) => r2(r.components.filter(c => c.amount > 0).reduce((s, c) => s + c.amount, 0));
  const deductions = (r: PayrollRow) => r2(r.components.filter(c => c.amount < 0).reduce((s, c) => s + c.amount, 0));
  const compTitle = (r: PayrollRow, sign: 1 | -1) =>
    r.components.filter(c => sign > 0 ? c.amount > 0 : c.amount < 0).map(c => `${c.label || "—"}: ${fmt(c.amount)}`).join("\n");
  const numTd = "px-3 py-1.5 text-right tabular-nums";
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge color="green">{t("Разом:")} {fmt(data.totals.total)} zł</Badge>
        <Badge color="blue">{t("Конто:")} {fmt(data.totals.konto)} zł</Badge>
        <Badge color="amber">{t("Готівка:")} {fmt(data.totals.cash)} zł</Badge>
        <Badge color="slate">{data.totals.count} {t("ос.")}</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" loading={fromWorkers.isPending} onClick={() => fromWorkers.mutate()}
            title={t("Створити рядки місяця з довідника працівників: podstawa = сума фіксованих позицій, вспульноти — з поділом за позиціями. Наявні рядки не чіпаються.")}>
            ⤵ {t("З працівників")}
          </Button>
          <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> {t("Додати людину")}</Button>
        </div>
      </div>
      {editing && (
        <PayrollModal month={month} row={editing === "new" ? null : editing}
          projects={data.projects} onClose={() => setEditing(null)} />
      )}
      {!data.rows.length ? (
        <Empty>{t("За цей місяць винагороджень ще немає")}</Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5">{t("Імʼя")}</th>
                <th className="px-3 py-2.5">{t("Вспульноти")}</th>
                <th className="px-3 py-2.5 text-right">Podstawa</th>
                <th className="px-3 py-2.5 text-right">{t("Дод. год")}</th>
                <th className="px-3 py-2.5 text-right">{t("Ставка")}</th>
                <th className="px-3 py-2.5 text-right">{t("Дод., zł")}</th>
                <th className="px-3 py-2.5 text-right">{t("Доплати")}</th>
                <th className="px-3 py-2.5 text-right">{t("Відрахування")}</th>
                <th className="px-3 py-2.5 text-right">{t("Разом")}</th>
                <th className="px-3 py-2.5 text-right">{t("Конто")}</th>
                <th className="px-3 py-2.5 text-right">{t("Готівка")}</th>
                <th className="w-16 px-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(r => (
                <tr key={r.id} className="group hover:bg-slate-50/60">
                  <td className="px-4 py-1.5 font-medium text-slate-700">
                    {r.name}
                    {r.note && <div className="text-[11px] font-normal text-slate-400">{r.note}</div>}
                  </td>
                  <td className="px-3 py-1.5">
                    <ProjectsCell row={r} projects={data.projects}
                      onSave={ids => patchRow.mutate({ id: r.id, body: { projectIds: ids } })} />
                  </td>
                  <td className={numTd}>
                    <NumCell value={r.base} zero="" onSave={v => patchRow.mutate({ id: r.id, body: { base: v } })} />
                  </td>
                  <td className={cn(numTd, "text-slate-500")}>
                    <NumCell value={r.hours ?? 0} zero="" onSave={v => patchRow.mutate({ id: r.id, body: { hours: v || null } })} />
                  </td>
                  <td className={cn(numTd, "text-slate-500")}>
                    <NumCell value={r.rate ?? 0} zero="" onSave={v => patchRow.mutate({ id: r.id, body: { rate: v || null } })} />
                  </td>
                  <td className={cn(numTd, "text-slate-500")}>{extra(r) ? fmt(extra(r)) : ""}</td>
                  <td className={cn(numTd, "text-emerald-700")}>
                    <button type="button" className="cursor-pointer rounded px-1 hover:bg-emerald-50" title={compTitle(r, 1) || t("Складові — в редагуванні (олівець)")}
                      onClick={() => setEditing(r)}>
                      {additions(r) ? `+${fmt(additions(r))}` : ""}
                    </button>
                  </td>
                  <td className={cn(numTd, "text-rose-600")}>
                    <button type="button" className="cursor-pointer rounded px-1 hover:bg-rose-50" title={compTitle(r, -1) || t("Складові — в редагуванні (олівець)")}
                      onClick={() => setEditing(r)}>
                      {deductions(r) ? fmt(deductions(r)) : ""}
                    </button>
                  </td>
                  <td className={cn(numTd, "font-semibold")}>{fmt(r.total)}</td>
                  <td className={cn(numTd, "text-blue-700")}>
                    <NumCell value={r.konto} zero="" onSave={v => patchRow.mutate({ id: r.id, body: { konto: v } })} />
                  </td>
                  <td className={cn(numTd, "text-amber-700")}>{fmt(r.cash)}</td>
                  <td className="px-2 text-right whitespace-nowrap">
                    <button className="invisible rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600 group-hover:visible"
                      title={t("Редагувати")} onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /></button>
                    <button className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible"
                      title={t("Видалити")}
                      onClick={async () => { if (await confirm({ title: t("Видалити запис?"), message: `${r.name} · ${fmt(r.total)} zł`, danger: true, confirmText: t("Видалити") })) remove.mutate(r.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/80 font-semibold">
                <td className="px-4 py-2" colSpan={2}>{t("Разом")}</td>
                <td className={numTd}>{fmt(sum(r => r.base))}</td>
                <td className={numTd}>{sum(r => r.hours ?? 0) || ""}</td>
                <td />
                <td className={numTd}>{fmt(sum(extra))}</td>
                <td className={cn(numTd, "text-emerald-700")}>+{fmt(sum(additions))}</td>
                <td className={cn(numTd, "text-rose-600")}>{fmt(sum(deductions))}</td>
                <td className={numTd}>{fmt(data.totals.total)}</td>
                <td className={cn(numTd, "text-blue-700")}>{fmt(data.totals.konto)}</td>
                <td className={cn(numTd, "text-amber-700")}>{fmt(data.totals.cash)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
      <p className="mt-3 text-xs text-slate-400">
        {t("Разом = Podstawa + додаткові години × ставка + доплати − відрахування. Клік по числу — редагування; вспульноти додаються прямо в рядку.")}
      </p>
    </>
  );
}

// Клік-редагована числова клітинка (як у сводній)
function NumCell({ value, zero, onSave }: { value: number; zero?: string; onSave: (v: number) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => { const v = num(draft); if (Number.isFinite(v) && v >= 0 && v !== value) onSave(r2(v)); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
        className="w-20 rounded-md border border-red-400 px-1 py-0.5 text-right text-sm focus:outline-none" />
    );
  }
  return (
    <button type="button" onClick={() => { setDraft(value ? String(value) : ""); setEditing(true); }}
      title={t("Клікни, щоб редагувати")}
      className="cursor-text rounded px-1 tabular-nums hover:bg-red-50 hover:ring-1 hover:ring-red-200">
      {value ? fmt(value) : (zero ?? "0")}
    </button>
  );
}

// Вспульноти людини: чипи з ✕ + компактний селект «+» — правка без модалки
function ProjectsCell({ row, projects, onSave }: { row: PayrollRow; projects: Project[]; onSave: (ids: number[]) => void }) {
  const t = useT();
  const byId = new Map(projects.map(p => [p.id, p]));
  const options = projects.filter(p => p.active && !row.projectIds.includes(p.id));
  return (
    <div className="flex max-w-72 flex-wrap items-center gap-1">
      {row.projectIds.map(pid => (
        <span key={pid} className="inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
          title={byId.get(pid)?.name}>
          {shortProj(byId.get(pid)?.name ?? `#${pid}`)}
          <button className="text-blue-300 hover:text-rose-500" title={t("Прибрати")}
            onClick={() => onSave(row.projectIds.filter(x => x !== pid))}>✕</button>
        </span>
      ))}
      {options.length > 0 && (
        <select value="" title={t("Додати вспульноту людині")}
          onChange={e => e.target.value && onSave([...row.projectIds, Number(e.target.value)])}
          className="w-6 cursor-pointer rounded-full border border-dashed border-slate-300 bg-transparent px-1 py-0.5 text-[11px] text-slate-400 hover:border-slate-400 hover:text-slate-600">
          <option value="">+</option>
          {options.map(p => <option key={p.id} value={p.id}>{shortProj(p.name)}</option>)}
        </select>
      )}
    </div>
  );
}

function PayrollModal({ month, row, projects, onClose }: { month: string; row: PayrollRow | null; projects: Project[]; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(row?.name ?? "");
  const [base, setBase] = useState(row?.base ? String(row.base) : "");
  const [hours, setHours] = useState(row?.hours != null ? String(row.hours) : "");
  const [rate, setRate] = useState(row?.rate != null ? String(row.rate) : "");
  const [comps, setComps] = useState<{ label: string; amount: string }[]>(
    row?.components.map(c => ({ label: c.label, amount: String(c.amount) })) ?? []);
  const [konto, setKonto] = useState(row?.konto ? String(row.konto) : "");
  const [note, setNote] = useState(row?.note ?? "");
  const [projectIds, setProjectIds] = useState<Set<number>>(new Set(row?.projectIds ?? []));
  const toggleProj = (id: number) => setProjectIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const baseN = base ? num(base) : 0;
  const compTotal = comps.reduce((s, c) => s + (Number.isFinite(num(c.amount)) ? num(c.amount) : 0), 0);
  const hourly = (num(hours) || 0) * (num(rate) || 0);
  const total = r2(baseN + hourly + compTotal);
  const kontoN = konto ? num(konto) : 0;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(), base: baseN, hours: hours ? num(hours) : null, rate: rate ? num(rate) : null,
        components: comps.filter(c => c.amount.trim()).map(c => ({ label: c.label.trim(), amount: num(c.amount) })),
        konto: kontoN, note: note.trim() || null, projectIds: [...projectIds],
      };
      return row ? patch(`/cleaning/payrolls/${row.id}`, body) : post("/cleaning/payrolls", { ...body, periodMonth: month });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cleaning-payrolls"] });
      qc.invalidateQueries({ queryKey: ["cleaning-pnl"] });
      toast.success(row ? t("Збережено") : t("Додано")); onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={row ? t("Редагувати винагродження") : t("Додати людину")} size="lg">
      <div className="space-y-3">
        <div><Label>{t("Імʼя")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="Leszek…" /></div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>Podstawa, zł</Label><Input value={base} onChange={e => setBase(e.target.value)} inputMode="decimal" placeholder="6000" /></div>
          <div><Label>{t("Додаткові години")}</Label><Input value={hours} onChange={e => setHours(e.target.value)} inputMode="decimal" placeholder="79" /></div>
          <div><Label>{t("Ставка, zł/год")}</Label><Input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" placeholder="30" /></div>
        </div>
        <div>
          <Label>{t("Складові (доплати «+», відрахування «−»)")}</Label>
          <div className="space-y-1.5">
            {comps.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={c.label} onChange={e => setComps(cs => cs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                  placeholder={t("підпис (plewienie, komornik…)")} className="flex-1" />
                <Input value={c.amount} onChange={e => setComps(cs => cs.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                  inputMode="decimal" placeholder="±0,00" className="w-28 text-right" />
                <button className="rounded p-1 text-slate-300 hover:text-rose-500" onClick={() => setComps(cs => cs.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setComps(cs => [...cs, { label: "", amount: "" }])}>
              <Plus className="h-4 w-4" /> {t("Додати складову")}
            </Button>
          </div>
        </div>
        <div>
          <Label>{t("Вспульноти (ЗП ділиться порівну)")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {projects.filter(p => p.active || projectIds.has(p.id)).map(p => (
              <button key={p.id} type="button" onClick={() => toggleProj(p.id)} title={p.name}
                className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition",
                  projectIds.has(p.id) ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 text-slate-500 hover:border-slate-300")}>
                {shortProj(p.name)}
              </button>
            ))}
            {!projects.length && <span className="text-xs text-slate-400">{t("Реєстр вспульнот порожній — вкладка «Вспульноти»")}</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("На конто, zł (решта — готівка)")}</Label><Input value={konto} onChange={e => setKonto(e.target.value)} inputMode="decimal" placeholder="0" /></div>
          <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} placeholder={t("необовʼязково")} /></div>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm tabular-nums">
          <span className="mr-3 text-slate-500">
            {fmt(baseN)}{hourly > 0 ? ` + ${hours}h×${rate} (${fmt(hourly)})` : ""}{compTotal !== 0 ? ` ${compTotal > 0 ? "+" : "−"} ${fmt(Math.abs(compTotal))}` : ""}
          </span>
          <span className="font-semibold">{t("Разом:")} {fmt(total)} zł</span>
          <span className="ml-3 text-blue-700">{t("Конто:")} {fmt(kontoN)}</span>
          <span className="ml-3 text-amber-700">{t("Готівка:")} {fmt(Math.max(0, r2(total - kontoN)))}</span>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!name.trim() || kontoN > total} onClick={() => save.mutate()}>
            {row ? t("Зберегти") : t("Додати")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Працівники прибирання ─────────────────────────────────────────────────────
// Легкий довідник (не workers): ім'я + прізвище, фірма Klinex і посада sprzątanie
// у всіх (статично). Оплата — позиціями: вспульнота(и) → фіксована сума за
// позицію ЦІЛКОМ («3 вспульноти за 2500») або % від місячної ЗП.
type WorkerRate = { id?: number; projectIds: number[]; amount: number | null; pct: number | null; note: string | null };
type CWorker = { id: number; firstName: string; lastName: string; active: boolean; note: string | null; rates: WorkerRate[]; fixedTotal: number };

function WorkersTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isFetching } = useQuery<{ workers: CWorker[]; projects: Project[] }>({
    queryKey: ["cleaning-workers"], queryFn: () => get("/cleaning/workers"),
  });
  const [editing, setEditing] = useState<CWorker | "new" | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["cleaning-workers"] }); qc.invalidateQueries({ queryKey: ["cleaning-pnl"] }); };
  const toggleActive = useMutation({
    mutationFn: (w: CWorker) => patch(`/cleaning/workers/${w.id}`, { active: !w.active }),
    onSuccess: invalidate, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/cleaning/workers/${id}`),
    onSuccess: () => { invalidate(); toast.success(t("Видалено")); },
    onError: (e: any) => toast.error(e.message),
  });
  if (isFetching && !data) return <Spinner />;
  if (!data) return null;
  const projById = new Map(data.projects.map(p => [p.id, p]));
  const rateLabel = (r: WorkerRate) => {
    const names = r.projectIds.map(pid => shortProj(projById.get(pid)?.name ?? `#${pid}`)).join(" + ") || t("podstawa");
    return `${names} — ${r.amount != null ? `${fmt(r.amount)} zł` : `${r.pct}%`}`;
  };
  const active = data.workers.filter(w => w.active);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge color="slate">{active.length} {t("ос.")}</Badge>
        <Badge color="green">{t("Фікс. разом/міс:")} {fmt(r2(active.reduce((s, w) => s + w.fixedTotal, 0)))} zł</Badge>
        <div className="ml-auto">
          <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> {t("Додати працівника")}</Button>
        </div>
      </div>
      {editing && (
        <WorkerModal row={editing === "new" ? null : editing} projects={data.projects} onClose={() => setEditing(null)} />
      )}
      {!data.workers.length ? (
        <Empty>{t("Працівників ще немає — додай першого, і в «Винагродженнях» з'явиться кнопка заповнення місяця з довідника.")}</Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5">{t("Працівник")}</th>
                <th className="px-3 py-2.5">{t("Фірма")}</th>
                <th className="px-3 py-2.5">{t("Посада")}</th>
                <th className="px-3 py-2.5">{t("Вспульноти й оплата")}</th>
                <th className="px-3 py-2.5 text-right">{t("Фікс./міс")}</th>
                <th className="px-3 py-2.5">{t("Стан")}</th>
                <th className="w-16 px-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.workers.map(w => (
                <tr key={w.id} className={cn("group hover:bg-slate-50/60", !w.active && "opacity-50")}>
                  <td className="px-4 py-2 font-medium text-slate-700">
                    <button className="hover:underline" onClick={() => setEditing(w)}>{w.firstName} {w.lastName}</button>
                    {w.note && <div className="text-[11px] font-normal text-slate-400">{w.note}</div>}
                  </td>
                  <td className="px-3 py-2"><Badge color="slate">Klinex</Badge></td>
                  <td className="px-3 py-2"><Badge color="blue">sprzątanie</Badge></td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-96 flex-wrap gap-1">
                      {w.rates.length
                        ? w.rates.map((r, i) => (
                          <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-600"
                            title={r.projectIds.map(pid => projById.get(pid)?.name ?? `#${pid}`).join("\n")}>
                            {rateLabel(r)}
                          </span>
                        ))
                        : <span className="text-xs text-slate-400">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {w.fixedTotal ? fmt(w.fixedTotal) : w.rates.some(r => r.pct != null)
                      ? <span className="font-normal text-slate-400">{r2(w.rates.reduce((s, r) => s + (r.pct ?? 0), 0))}%</span> : ""}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => toggleActive.mutate(w)}>
                      {w.active ? <Badge color="green">{t("активний")}</Badge> : <Badge color="slate">{t("неактивний")}</Badge>}
                    </button>
                  </td>
                  <td className="px-2 text-right whitespace-nowrap">
                    <button className="invisible rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600 group-hover:visible"
                      title={t("Редагувати")} onClick={() => setEditing(w)}><Pencil className="h-3.5 w-3.5" /></button>
                    <button className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible"
                      title={t("Видалити")}
                      onClick={async () => { if (await confirm({ title: t("Видалити працівника?"), message: `${w.firstName} ${w.lastName}`, danger: true, confirmText: t("Видалити") })) remove.mutate(w.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-xs text-slate-400">
        {t("Позиція оплати — одна чи кілька вспульнот з сумою за позицію цілком, або % від місячної ЗП. Кнопка «З працівників» у Винагродженнях створює рядки місяця з цими сумами й поділом.")}
      </p>
    </>
  );
}

function WorkerModal({ row, projects, onClose }: { row: CWorker | null; projects: Project[]; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [firstName, setFirstName] = useState(row?.firstName ?? "");
  const [lastName, setLastName] = useState(row?.lastName ?? "");
  const [note, setNote] = useState(row?.note ?? "");
  const [mode, setMode] = useState<"amount" | "pct">(row?.rates.some(r => r.pct != null) ? "pct" : "amount");
  const [rates, setRates] = useState<{ projectIds: number[]; value: string; note: string }[]>(
    row?.rates.map(r => ({ projectIds: r.projectIds, value: String(r.amount ?? r.pct ?? ""), note: r.note ?? "" })) ?? []);
  const setRate = (i: number, patchR: Partial<{ projectIds: number[]; value: string; note: string }>) =>
    setRates(rs => rs.map((r, j) => j === i ? { ...r, ...patchR } : r));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        firstName: firstName.trim(), lastName: lastName.trim(), note: note.trim() || null,
        rates: rates.filter(r => r.value.trim() && (mode === "amount" || r.projectIds.length)).map(r => ({
          projectIds: r.projectIds,
          amount: mode === "amount" ? num(r.value) : null,
          pct: mode === "pct" ? num(r.value) : null,
          note: r.note.trim() || null,
        })),
      };
      return row ? patch(`/cleaning/workers/${row.id}`, body) : post("/cleaning/workers", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cleaning-workers"] });
      qc.invalidateQueries({ queryKey: ["cleaning-pnl"] });
      toast.success(row ? t("Збережено") : t("Додано")); onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const fixedSum = mode === "amount" ? r2(rates.reduce((s, r) => s + (Number.isFinite(num(r.value)) ? num(r.value) : 0), 0)) : 0;
  const pctSum = mode === "pct" ? r2(rates.reduce((s, r) => s + (Number.isFinite(num(r.value)) ? num(r.value) : 0), 0)) : 0;
  return (
    <Modal open onClose={onClose} title={row ? `${row.firstName} ${row.lastName}`.trim() : t("Додати працівника")} size="lg">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Імʼя")}</Label><Input value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus /></div>
          <div><Label>{t("Прізвище")}</Label><Input value={lastName} onChange={e => setLastName(e.target.value)} /></div>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Badge color="slate">Klinex</Badge>
          <Badge color="blue">sprzątanie</Badge>
          <span className="text-xs text-slate-400">{t("фірма й посада однакові для всіх працівників прибирання")}</span>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-3">
            <Label>{t("Вспульноти й оплата")}</Label>
            <div className="flex w-fit gap-1 rounded-lg bg-slate-100 p-0.5 text-[11px] font-medium">
              {([["amount", t("Суми, zł")], ["pct", t("% поділ")]] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setMode(k)}
                  className={`rounded-md px-2 py-0.5 ${mode === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {rates.map((r, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-slate-100 p-2">
                <div className="flex flex-1 flex-wrap items-center gap-1">
                  {r.projectIds.map(pid => {
                    const p = projects.find(x => x.id === pid);
                    return (
                      <span key={pid} className="inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700" title={p?.name}>
                        {shortProj(p?.name ?? `#${pid}`)}
                        <button type="button" className="text-blue-300 hover:text-rose-500"
                          onClick={() => setRate(i, { projectIds: r.projectIds.filter(x => x !== pid) })}>✕</button>
                      </span>
                    );
                  })}
                  <select value="" title={t("Додати вспульноту до позиції")}
                    onChange={e => e.target.value && setRate(i, { projectIds: [...r.projectIds, Number(e.target.value)] })}
                    className="w-6 cursor-pointer rounded-full border border-dashed border-slate-300 bg-transparent px-1 py-0.5 text-[11px] text-slate-400 hover:border-slate-400 hover:text-slate-600">
                    <option value="">+</option>
                    {projects.filter(p => p.active && !r.projectIds.includes(p.id)).map(p =>
                      <option key={p.id} value={p.id}>{shortProj(p.name)}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <Input value={r.value} onChange={e => setRate(i, { value: e.target.value })}
                    inputMode="decimal" placeholder={mode === "amount" ? "2500" : "%"} className="w-24 text-right" />
                  <span className="text-xs text-slate-400">{mode === "amount" ? "zł" : "%"}</span>
                  <button type="button" className="rounded p-1 text-slate-300 hover:text-rose-500" onClick={() => setRates(rs => rs.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setRates(rs => [...rs, { projectIds: [], value: "", note: "" }])}>
              <Plus className="h-4 w-4" /> {t("Додати позицію оплати")}
            </Button>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {mode === "amount"
              ? `${t("Фікс. разом/міс:")} ${fmt(fixedSum)} zł · ${t("сума позиції — за всі її вспульноти разом; позиція без вспульнот — загальна podstawa")}`
              : `${t("Σ відсотків:")} ${pctSum}% ${pctSum > 100 ? "⚠️" : ""} · ${t("ЗП місяця ділиться між вспульнотами за цими відсотками")}`}
          </div>
        </div>
        <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} placeholder={t("необовʼязково")} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!firstName.trim() || (mode === "pct" && pctSum > 100)} onClick={() => save.mutate()}>
            {row ? t("Зберегти") : t("Додати")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Видатки ───────────────────────────────────────────────────────────────────
function ExpensesTab({ month }: { month: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isFetching } = useQuery<ExpenseData>({
    queryKey: ["cleaning-expenses", month], queryFn: () => get(`/cleaning/expenses?month=${month}`),
  });
  const projById = useMemo(() => new Map((data?.projects ?? []).map(p => [p.id, p])), [data]);
  const attach = useMutation({
    mutationFn: (p: { origin: string; id: number; projectId: number | null }) =>
      patch(`/cleaning/expenses/${p.origin}/${p.id}`, { projectId: p.projectId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cleaning-expenses"] }); qc.invalidateQueries({ queryKey: ["cleaning-pnl"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  if (isFetching && !data) return <Spinner />;
  if (!data) return null;
  const srcBadge = (r: ExpenseRow) =>
    r.source === "cash" ? <Badge color="amber">{t("каса")}</Badge>
      : r.source === "ksef" ? <Badge color="slate">KSeF</Badge>
      : <Badge color="slate">{t("фактура")}</Badge>;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge color="rose">{t("Разом видатків:")} {fmt(data.totals.amount)} zł</Badge>
        <Badge color="slate">{data.totals.count} {t("поз.")}</Badge>
        <span className="text-xs text-slate-400">
          {t("Фактури позначаються чекбоксом «Прибирання» на сторінці Фактур; готівка — категоріями каси з позначкою «Прибирання».")}
        </span>
      </div>
      {!data.rows.length ? (
        <Empty>{t("За цей місяць видатків на прибирання не позначено")}</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">{t("Дата")}</th>
                <th className="px-4 py-2">{t("Джерело")}</th>
                <th className="px-4 py-2">{t("Номер / опис")}</th>
                <th className="px-4 py-2">{t("Контрагент")}</th>
                <th className="px-4 py-2">{t("Вспульнота")}</th>
                <th className="px-4 py-2 text-right">{t("Сума")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(r => (
                <tr key={r.key} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-500">{r.date ?? r.month}</td>
                  <td className="px-4 py-2">{srcBadge(r)}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {r.number ?? r.counterparty ?? "—"}
                    {r.note && <div className="text-[11px] text-slate-400">{r.note}</div>}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{r.number ? r.counterparty : r.firm}</td>
                  <td className="px-4 py-2">
                    {r.origin === "cash" ? (
                      <span className="text-xs text-slate-400">{t("загальні")}</span>
                    ) : (
                      <Select className="w-48 py-1 text-xs" value={r.projectId ?? ""}
                        title={r.projectId != null ? projById.get(r.projectId)?.name : undefined}
                        onChange={e => attach.mutate({ origin: r.origin, id: r.id, projectId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">{t("загальні (без вспульноти)")}</option>
                        {(data.projects ?? []).filter(p => p.active || p.id === r.projectId).map(p =>
                          <option key={p.id} value={p.id}>{shortProj(p.name)}</option>)}
                      </Select>
                    )}
                    {r.origin !== "cash" && r.projectId != null && !projById.get(r.projectId) && (
                      <div className="text-[11px] text-rose-500">#{r.projectId}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums">{fmt(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

// ── P&L ───────────────────────────────────────────────────────────────────────
// Два режими: «Рік» — місяці в порівнянні (матриця по вибраному показнику +
// річна таблиця по вспульнотах), «Місяць» — детальний розріз одного місяця
// (усі чотири показники по кожній вспульноті). Дані одні — GET /cleaning/pnl?year.
function PnlTab() {
  const t = useT();
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - 2023 }, (_, i) => String(thisYear - i));
  const [year, setYear] = useState(String(thisYear));
  const [mode, setMode] = useState<"year" | "month">("year");
  const [month, setMonth] = useState<string>("");
  const [metric, setMetric] = useState<"margin" | "revenue" | "payroll" | "expenses">("margin");
  const { data, isFetching } = useQuery<PnlData>({
    queryKey: ["cleaning-pnl", year], queryFn: () => get(`/cleaning/pnl?year=${year}`),
  });
  const METRICS: [typeof metric, string][] = [
    ["margin", t("Маржа")], ["revenue", t("Дохід")], ["payroll", t("Винагродження")], ["expenses", t("Видатки")],
  ];
  if (isFetching && !data) return <Spinner />;
  if (!data) return null;
  const mLabel = (m: string) => m.slice(5) + "." + m.slice(2, 4);
  // місяць режиму «детально»: вибраний, якщо він є в даних року, інакше останній
  const selMonth = data.months.includes(month) ? month : data.months[data.months.length - 1] ?? "";
  const monthTotals = selMonth ? data.totalsByMonth[selMonth] : null;
  const shownTotals = mode === "month" && monthTotals ? monthTotals : data.totals;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
          {([["year", t("Рік")], ["month", t("Місяць")]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`rounded-lg px-3 py-1.5 ${mode === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        <Select value={year} onChange={e => setYear(e.target.value)} className="w-28">
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </Select>
        {mode === "month" ? (
          <Select value={selMonth} onChange={e => setMonth(e.target.value)} className="w-32">
            {data.months.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        ) : (
          <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-xs font-medium">
            {METRICS.map(([k, label]) => (
              <button key={k} onClick={() => setMetric(k)}
                className={`rounded-lg px-2.5 py-1 ${metric === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        <Badge color="green">{t("Дохід:")} {fmt(shownTotals.revenue)} zł</Badge>
        <Badge color="blue">{t("Винагродження:")} {fmt(shownTotals.payroll)} zł</Badge>
        <Badge color="rose">{t("Видатки:")} {fmt(shownTotals.expenses)} zł</Badge>
        <Badge color={shownTotals.margin >= 0 ? "green" : "rose"}>{t("Маржа:")} {fmt(shownTotals.margin)} zł</Badge>
      </div>
      {!data.months.length ? (
        <Empty>{t("За цей рік даних немає")}</Empty>
      ) : mode === "month" ? (
        <MonthDetail data={data} month={selMonth} />
      ) : (
        <YearMatrix data={data} metric={metric} mLabel={mLabel} />
      )}
    </>
  );
}

// «Місяць детально»: усі чотири показники по кожній вспульноті за один місяць
function MonthDetail({ data, month }: { data: PnlData; month: string }) {
  const t = useT();
  const cell = (p: { byMonth: Record<string, PnlCell> }) => p.byMonth[month] ?? { revenue: 0, payroll: 0, expenses: 0, margin: 0 };
  const rows = data.projects
    .map(p => ({ id: p.id as number | null, name: p.name, c: cell(p) }))
    .filter(r => r.c.revenue || r.c.payroll || r.c.expenses)
    .sort((a, b) => b.c.revenue - a.c.revenue);
  const common = cell(data.common);
  if (common.revenue || common.payroll || common.expenses) rows.push({ id: null, name: t("Загальні / нерозподілені"), c: common });
  const totals = data.totalsByMonth[month] ?? { revenue: 0, payroll: 0, expenses: 0, margin: 0 };
  const pct = (c: PnlCell) => c.revenue > 0 ? `${Math.round(100 * c.margin / c.revenue)}%` : "—";
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <th className="px-4 py-2.5">{t("Вспульнота")}</th>
            <th className="px-3 py-2.5 text-right">{t("Дохід")}</th>
            <th className="px-3 py-2.5 text-right">{t("Винагродження")}</th>
            <th className="px-3 py-2.5 text-right">{t("Видатки")}</th>
            <th className="px-3 py-2.5 text-right">{t("Маржа")}</th>
            <th className="px-4 py-2.5 text-right">{t("Маржа, %")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {!rows.length ? (
            <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">{t("У цьому місяці даних немає")}</td></tr>
          ) : rows.map(r => (
            <tr key={r.id ?? "common"} className={cn("hover:bg-slate-50/60", r.id == null && "bg-slate-50/60 text-slate-500")}>
              <td className="max-w-72 truncate px-4 py-2 font-medium text-slate-700" title={r.name}>{r.id == null ? r.name : shortProj(r.name)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.c.revenue ? fmt(r.c.revenue) : "·"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.c.payroll ? fmt(r.c.payroll) : "·"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.c.expenses ? fmt(r.c.expenses) : "·"}</td>
              <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", r.c.margin > 0 ? "text-emerald-700" : r.c.margin < 0 ? "text-rose-600" : "text-slate-400")}>
                {fmt(r.c.margin)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-500">{pct(r.c)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50/80 font-semibold">
            <td className="px-4 py-2">{t("Разом")} · {month}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.revenue)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-blue-700">{fmt(totals.payroll)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-rose-600">{fmt(totals.expenses)}</td>
            <td className={cn("px-3 py-2 text-right tabular-nums", totals.margin >= 0 ? "text-emerald-700" : "text-rose-600")}>{fmt(totals.margin)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{pct(totals)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}

// «Рік»: матриця вспульнота × місяць по вибраному показнику + річна таблиця
function YearMatrix({ data, metric, mLabel }: { data: PnlData; metric: "margin" | "revenue" | "payroll" | "expenses"; mLabel: (m: string) => string }) {
  const t = useT();
  const cellCls = (v: number) =>
    metric === "margin" ? (v > 0 ? "text-emerald-700" : v < 0 ? "text-rose-600" : "text-slate-400") : v ? "" : "text-slate-300";
  return (
    <div className="space-y-5">
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="sticky left-0 bg-white px-4 py-2">{t("Вспульнота")}</th>
              {data.months.map(m => <th key={m} className="px-3 py-2 text-right">{mLabel(m)}</th>)}
              <th className="px-4 py-2 text-right">{t("Разом")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.projects.map(p => (
              <tr key={p.id} className="hover:bg-slate-50/60">
                <td className="sticky left-0 max-w-56 truncate bg-white px-4 py-2 font-medium text-slate-700" title={p.name}>{shortProj(p.name)}</td>
                {data.months.map(m => {
                  const v = p.byMonth[m]?.[metric] ?? 0;
                  return <td key={m} className={cn("px-3 py-2 text-right tabular-nums", cellCls(v))}>{v ? fmt(v) : "·"}</td>;
                })}
                <td className={cn("px-4 py-2 text-right font-semibold tabular-nums", cellCls(p.totals[metric]))}>{fmt(p.totals[metric])}</td>
              </tr>
            ))}
            {(data.common.totals.revenue !== 0 || data.common.totals.payroll !== 0 || data.common.totals.expenses !== 0) && (
              <tr className="bg-slate-50/60">
                <td className="sticky left-0 bg-slate-50 px-4 py-2 font-medium text-slate-500">{t("Загальні / нерозподілені")}</td>
                {data.months.map(m => {
                  const v = data.common.byMonth[m]?.[metric] ?? 0;
                  return <td key={m} className={cn("px-3 py-2 text-right tabular-nums", cellCls(v))}>{v ? fmt(v) : "·"}</td>;
                })}
                <td className={cn("px-4 py-2 text-right font-semibold tabular-nums", cellCls(data.common.totals[metric]))}>{fmt(data.common.totals[metric])}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50/80 font-semibold">
              <td className="sticky left-0 bg-slate-50 px-4 py-2">{t("Разом")}</td>
              {data.months.map(m => {
                const v = data.totalsByMonth[m]?.[metric] ?? 0;
                return <td key={m} className={cn("px-3 py-2 text-right tabular-nums", cellCls(v))}>{fmt(v)}</td>;
              })}
              <td className={cn("px-4 py-2 text-right tabular-nums", cellCls(data.totals[metric]))}>{fmt(data.totals[metric])}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
      {/* по проєктах за рік: всі чотири показники поряд */}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2">{t("Вспульнота")}</th>
              <th className="px-4 py-2 text-right">{t("Дохід")}</th>
              <th className="px-4 py-2 text-right">{t("Винагродження")}</th>
              <th className="px-4 py-2 text-right">{t("Видатки")}</th>
              <th className="px-4 py-2 text-right">{t("Маржа")}</th>
              <th className="px-4 py-2 text-right">{t("Маржа, %")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...data.projects].sort((a, b) => b.totals.revenue - a.totals.revenue).map(p => (
              <tr key={p.id} className="hover:bg-slate-50/60">
                <td className="px-4 py-2 font-medium text-slate-700" title={p.name}>{shortProj(p.name)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmt(p.totals.revenue)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmt(p.totals.payroll)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmt(p.totals.expenses)}</td>
                <td className={cn("px-4 py-2 text-right font-semibold tabular-nums", p.totals.margin >= 0 ? "text-emerald-700" : "text-rose-600")}>
                  {fmt(p.totals.margin)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                  {p.totals.revenue > 0 ? `${Math.round(100 * p.totals.margin / p.totals.revenue)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ── Вспульноти (реєстр) ───────────────────────────────────────────────────────
function ProjectsTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isFetching } = useQuery<{ projects: Project[] }>({
    queryKey: ["cleaning-projects"], queryFn: () => get("/cleaning/projects"),
  });
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cleaning-projects"] });
    qc.invalidateQueries({ queryKey: ["cleaning-income"] });
    qc.invalidateQueries({ queryKey: ["cleaning-pnl"] });
  };
  const seed = useMutation({
    mutationFn: () => post<{ created: number }>("/cleaning/projects/seed"),
    onSuccess: (d) => { invalidate(); toast.success(`${t("Підтягнуто з KSeF:")} ${d.created}`); },
    onError: (e: any) => toast.error(e.message),
  });
  const toggleActive = useMutation({
    mutationFn: (p: Project) => patch(`/cleaning/projects/${p.id}`, { active: !p.active }),
    onSuccess: invalidate, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del<{ deleted?: boolean; deactivated?: boolean }>(`/cleaning/projects/${id}`),
    onSuccess: (d) => { invalidate(); toast.success(d.deactivated ? t("Є привʼязані дані — деактивовано") : t("Видалено")); },
    onError: (e: any) => toast.error(e.message),
  });
  if (isFetching && !data) return <Spinner />;
  if (!data) return null;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge color="slate">{data.projects.length} {t("вспульнот")}</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" loading={seed.isPending} onClick={() => seed.mutate()}
            title={t("Створити проєкти з покупців KSeF-фактур сегмента прибирання (по NIP), яких ще немає")}>
            <RefreshCw className="h-4 w-4" /> {t("Підтягнути з KSeF")}
          </Button>
          <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> {t("Додати вспульноту")}</Button>
        </div>
      </div>
      {editing && <ProjectModal row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {!data.projects.length ? (
        <Empty>
          <Sparkles className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          {t("Реєстр порожній. Натисни «Підтягнути з KSeF» — вспульноти створяться з фактур автоматично.")}
        </Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">{t("Назва")}</th>
                <th className="px-4 py-2">NIP</th>
                <th className="px-4 py-2">{t("Стан")}</th>
                <th className="px-4 py-2">{t("Примітка")}</th>
                <th className="w-24 px-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.projects.map(p => (
                <tr key={p.id} className={cn("group hover:bg-slate-50/60", !p.active && "opacity-50")}>
                  <td className="px-4 py-2 font-medium text-slate-700">{p.name}</td>
                  <td className="px-4 py-2 tabular-nums text-slate-500">{p.nip ?? "—"}</td>
                  <td className="px-4 py-2">
                    <button onClick={() => toggleActive.mutate(p)}>
                      {p.active ? <Badge color="green">{t("активна")}</Badge> : <Badge color="slate">{t("неактивна")}</Badge>}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{p.note}</td>
                  <td className="px-2 text-right whitespace-nowrap">
                    <button className="invisible rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600 group-hover:visible"
                      title={t("Редагувати")} onClick={() => setEditing(p)}><Pencil className="h-3.5 w-3.5" /></button>
                    <button className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible"
                      title={t("Видалити")}
                      onClick={async () => { if (await confirm({ title: t("Видалити вспульноту?"), message: p.name, danger: true, confirmText: t("Видалити") })) remove.mutate(p.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
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

function ProjectModal({ row, onClose }: { row: Project | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(row?.name ?? "");
  const [nip, setNip] = useState(row?.nip ?? "");
  const [note, setNote] = useState(row?.note ?? "");
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), nip: nip.trim() || null, note: note.trim() || null };
      return row ? patch(`/cleaning/projects/${row.id}`, body) : post("/cleaning/projects", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cleaning-projects"] });
      qc.invalidateQueries({ queryKey: ["cleaning-income"] });
      qc.invalidateQueries({ queryKey: ["cleaning-pnl"] });
      toast.success(row ? t("Збережено") : t("Додано")); onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={row ? t("Редагувати вспульноту") : t("Додати вспульноту")}>
      <div className="space-y-3">
        <div><Label>{t("Назва")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="WSPÓLNOTA MIESZKANIOWA…" /></div>
        <div><Label>NIP</Label><Input value={nip} onChange={e => setNip(e.target.value)} inputMode="numeric" placeholder={t("10 цифр — для авто-матчу фактур")} /></div>
        <div><Label>{t("Примітка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} placeholder={t("необовʼязково")} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>{row ? t("Зберегти") : t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}
