// «CFO» (/cfo) — фінансовий директор: місячна звірка кешфлоу↔баланс, P&L vs кеш,
// маржинальність проєктів із MoM, АІ-висновок (Claude API). Owner-only (viewFinance).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Scale, TrendingDown, TrendingUp, Sparkles, Settings2, CheckCircle2, AlertTriangle } from "lucide-react";
import { get, post, put } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

interface ClientMargin {
  label: string; revenue: number; cogs: number; margin: number; marginPct: number | null;
  prevRevenue: number; prevMargin: number; prevMarginPct: number | null;
  revenueDelta: number; marginPctDelta: number | null;
  low: boolean; isNew: boolean; gone: boolean;
}
interface Data {
  month: string;
  reconciliation: {
    opening: { banks: number; cash: number; total: number };
    closing: { banks: number; cash: number; total: number };
    delta: number; computedClosing: number; residual: number;
    inflows: { income: number; vatRefund: number; total: number };
    expensesTotal: number; ownersTotal: number;
  };
  pnlVsCash: {
    pnlProfit: number; cashDelta: number; difference: number;
    factors: { ownersPayouts: number; receivablesChange: number; payablesChange: number; vatRefund: number };
  };
  margins: { clients: ClientMargin[]; threshold: number; totals: { revenue: number; margin: number; marginPct: number | null; fixed: number; profit: number } };
  settings: { marginThreshold: number; recipientAdminIds: number[] };
  reports: { id: number; periodMonth: string; content: string; model: string | null; auto: boolean; createdAt: string }[];
  admins: { id: number; name: string }[];
  aiConfigured: boolean;
}

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} zł`;

function monthList(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 18; i++) {
    out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

export default function Cfo() {
  const t = useT();
  const qc = useQueryClient();
  const prevMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const [month, setMonth] = useState(prevMonth);
  const [showSettings, setShowSettings] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const q = useQuery<Data>({ queryKey: ["cfo", month], queryFn: () => get(`/cfo?month=${month}`) });
  const d = q.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cfo"] });

  const analyze = async () => {
    setAnalyzing(true);
    try {
      await post("/cfo/analyze", { month });
      toast.success(t("Аналіз готовий"));
      invalidate();
    } catch (e: any) { toast.error(e?.message || t("Не вдалося виконати аналіз")); }
    finally { setAnalyzing(false); }
  };

  const r = d?.reconciliation;
  const recOk = r ? Math.abs(r.residual) <= 5 : true;

  return (
    <>
      <PageHeader title={t("CFO")} subtitle={t("Місячні звірки, маржинальність проєктів і висновки фінансового директора")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Місяць")}</div>
          <Select value={month} onChange={e => setMonth(e.target.value)} className="w-36">
            {monthList().map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={() => setShowSettings(true)}><Settings2 className="mr-1 h-4 w-4" />{t("Налаштування")}</Button>
          <Button disabled={analyzing || !d} onClick={analyze}>
            <Sparkles className={`mr-1 h-4 w-4 ${analyzing ? "animate-pulse" : ""}`} />
            {analyzing ? t("Аналізую…") : t("Аналіз фін.директора")}
          </Button>
        </div>
      </div>

      {q.isFetching && !d ? <Spinner /> : !d ? <Empty>{t("Немає даних")}</Empty> : (
        <>
          {/* ── Звірка ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <Scale className="h-5 w-5 text-slate-400" />
                <span className="font-semibold text-slate-700">{t("Звірка: баланс ↔ кешфлоу")}</span>
                {recOk
                  ? <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />{t("сходиться")}</span>
                  : <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600"><AlertTriangle className="h-3.5 w-3.5" />{t("нев'язка {v}", { v: zl(r!.residual) })}</span>}
              </div>
              <div className="space-y-1.5 text-sm">
                <Row label={t("Стан на початок (банки+каса)")} value={zl(r!.opening.total)} sub={`${zl(r!.opening.banks)} + ${zl(r!.opening.cash)}`} />
                <Row label={t("+ Приходи")} value={zl(r!.inflows.total)} tone="text-emerald-700" />
                <Row label={t("− Витрати (разом із ЗП)")} value={zl(r!.expensesTotal)} tone="text-rose-600" />
                <Row label={t("− Виплати власникам")} value={zl(r!.ownersTotal)} tone="text-rose-600" />
                <div className="border-t border-slate-200 pt-1.5">
                  <Row label={t("= Розрахунковий кінець")} value={zl(r!.computedClosing)} bold />
                  <Row label={t("Фактичний кінець (банки+каса)")} value={zl(r!.closing.total)} bold sub={`${zl(r!.closing.banks)} + ${zl(r!.closing.cash)}`} />
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-400">{t("Рівняння: якщо нев'язка більша за кілька злотих — щось не так у категоріях кешфлоу або в касі; деталі на /cashflow.")}</p>
            </Card>

            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-slate-400" />
                <span className="font-semibold text-slate-700">{t("P&L (нараховано) vs гроші (каса)")}</span>
              </div>
              <div className="space-y-1.5 text-sm">
                <Row label={t("Прибуток P&L за місяць")} value={zl(d.pnlVsCash.pnlProfit)} bold />
                <Row label={t("Приріст грошей за місяць")} value={zl(d.pnlVsCash.cashDelta)} bold />
                <Row label={t("Різниця")} value={zl(d.pnlVsCash.difference)} tone={Math.abs(d.pnlVsCash.difference) > 50000 ? "text-amber-600" : undefined} />
                <div className="border-t border-slate-200 pt-1.5 text-xs text-slate-500">{t("Куди дівається різниця:")}</div>
                <Row label={t("Виплати власникам (не в P&L)")} value={zl(d.pnlVsCash.factors.ownersPayouts)} />
                <Row label={t("Δ дебіторки (виставлено − оплачено)")} value={zl(d.pnlVsCash.factors.receivablesChange)} />
                <Row label={t("Δ кредиторки (нараховано − сплачено)")} value={zl(d.pnlVsCash.factors.payablesChange)} />
              </div>
              <p className="mt-3 text-xs text-slate-400">{t("ЗП виплачується в M+1, тому великий розрив P&L↔кеш — це переважно ще не виплачена зарплата місяця. Стабільний розрив = норма.")}</p>
            </Card>
          </div>

          {/* ── Маржі ── */}
          <Card className="mt-4 overflow-x-auto p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <div className="font-semibold text-slate-700">{t("Проєкти: маржинальність і зміни")}</div>
              <div className="text-sm text-slate-500">
                {t("Разом: дохід {r} · маржа {m} ({p}%) · прибуток {pr}", {
                  r: zl(d.margins.totals.revenue), m: zl(d.margins.totals.margin),
                  p: d.margins.totals.marginPct ?? "?", pr: zl(d.margins.totals.profit),
                })}
              </div>
            </div>
            <table className="w-full min-w-[860px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="px-5 py-2.5">{t("Клієнт")}</th>
                <th className="px-3 py-2.5 text-right">{t("Дохід")}</th>
                <th className="px-3 py-2.5 text-right">{t("Собівартість (ЗП)")}</th>
                <th className="px-3 py-2.5 text-right">{t("Маржа")}</th>
                <th className="px-3 py-2.5 text-right">{t("Маржа %")}</th>
                <th className="px-3 py-2.5 text-right">{t("MoM маржа")}</th>
                <th className="px-3 py-2.5 text-right">{t("MoM дохід")}</th>
              </tr></thead>
              <tbody>
                {d.margins.clients.filter(c => !c.gone).map(c => (
                  <tr key={c.label} className={`border-b border-slate-100 ${c.low ? "bg-rose-50/50" : ""}`}>
                    <td className="max-w-[280px] truncate px-5 py-2 font-medium text-slate-700" title={c.label}>
                      {c.label}
                      {c.isNew && <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-semibold text-emerald-700">{t("новий")}</span>}
                      {c.low && <span className="ml-1.5 rounded bg-rose-100 px-1 py-0.5 text-[10px] font-semibold text-rose-700">{t("низька маржа")}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{zl(c.revenue)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{zl(c.cogs)}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${c.margin < 0 ? "text-rose-600" : ""}`}>{zl(c.margin)}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums ${c.marginPct == null ? "text-slate-400" : c.marginPct < d.margins.threshold ? "text-rose-600" : c.marginPct < d.margins.threshold * 1.5 ? "text-amber-600" : "text-emerald-700"}`}>
                      {c.marginPct ?? "—"}{c.marginPct != null && "%"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                      {c.marginPctDelta == null ? <span className="text-slate-300">—</span> : (
                        <span className={`inline-flex items-center gap-0.5 ${c.marginPctDelta < -2 ? "text-rose-600" : c.marginPctDelta > 2 ? "text-emerald-700" : "text-slate-500"}`}>
                          {c.marginPctDelta < -2 ? <TrendingDown className="h-3.5 w-3.5" /> : c.marginPctDelta > 2 ? <TrendingUp className="h-3.5 w-3.5" /> : null}
                          {c.marginPctDelta > 0 ? "+" : ""}{c.marginPctDelta} {t("п.п.")}
                        </span>
                      )}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${c.revenueDelta < 0 ? "text-rose-600" : "text-slate-500"}`}>
                      {c.revenueDelta > 0 ? "+" : ""}{zl(c.revenueDelta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.margins.clients.some(c => c.gone) && (
              <div className="border-t border-slate-100 px-5 py-2 text-xs text-slate-400">
                {t("Зникли цього місяця:")} {d.margins.clients.filter(c => c.gone).map(c => c.label).slice(0, 8).join(", ")}
                {d.margins.clients.filter(c => c.gone).length > 8 && ` +${d.margins.clients.filter(c => c.gone).length - 8}`}
              </div>
            )}
          </Card>

          {/* ── АІ-висновки ── */}
          <Card className="mt-4 p-5">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-500" />
              <span className="font-semibold text-slate-700">{t("Висновок фінансового директора")}</span>
              {!d.aiConfigured && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{t("АІ не налаштований — додай ANTHROPIC_API_KEY")}</span>}
            </div>
            {d.reports.length === 0
              ? <p className="text-sm text-slate-400">{t("Ще немає аналізів за цей місяць — натисни «Аналіз фін.директора».")}</p>
              : d.reports.map(rep => (
                <div key={rep.id} className="mb-4 border-b border-slate-100 pb-4 last:mb-0 last:border-0 last:pb-0">
                  <div className="mb-1 text-xs text-slate-400">
                    {new Date(rep.createdAt).toLocaleString("uk-UA")} · {rep.model} {rep.auto && `· ${t("авто")}`}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{rep.content}</div>
                </div>
              ))}
          </Card>
        </>
      )}

      {showSettings && d && (
        <SettingsModal settings={d.settings} admins={d.admins}
          onClose={() => setShowSettings(false)}
          onSaved={() => { setShowSettings(false); invalidate(); }} />
      )}
    </>
  );
}

function Row({ label, value, sub, tone, bold }: { label: string; value: string; sub?: string; tone?: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`${bold ? "font-medium text-slate-700" : "text-slate-500"}`}>{label}{sub && <span className="ml-1 text-xs text-slate-400">({sub})</span>}</span>
      <span className={`whitespace-nowrap tabular-nums ${bold ? "font-semibold" : ""} ${tone ?? "text-slate-700"}`}>{value}</span>
    </div>
  );
}

function SettingsModal({ settings, admins, onClose, onSaved }: {
  settings: { marginThreshold: number; recipientAdminIds: number[] };
  admins: { id: number; name: string }[];
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [threshold, setThreshold] = useState(String(settings.marginThreshold));
  const [ids, setIds] = useState<number[]>(settings.recipientAdminIds);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await put("/cfo/settings", { marginThreshold: Number(threshold.replace(",", ".")), recipientAdminIds: ids });
      toast.success(t("Збережено"));
      onSaved();
    } catch (e: any) { toast.error(e?.message || "error"); }
    finally { setSaving(false); }
  };

  return (
    <Modal open title={t("Налаштування CFO")} onClose={onClose} size="md">
      <label className="mb-4 block">
        <span className="mb-1 block text-xs text-slate-500">{t("Поріг маломаржинального проєкту, %")}</span>
        <Input value={threshold} onChange={e => setThreshold(e.target.value)} className="w-28" />
      </label>
      <div className="mb-1 text-xs text-slate-500">{t("Кому слати місячний звіт у бот (1-го числа)")}</div>
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-3">
        {admins.map(a => (
          <label key={a.id} className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={ids.includes(a.id)}
              onChange={e => setIds(p => e.target.checked ? [...p, a.id] : p.filter(x => x !== a.id))} />
            {a.name}
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button disabled={saving} onClick={save}>{t("Зберегти")}</Button>
      </div>
    </Modal>
  );
}