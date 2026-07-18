import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, AlertTriangle, PiggyBank, Wallet, ArrowDownLeft, ArrowUpRight, ArrowLeftRight } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Button, Input, Modal } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";
import { useCats } from "../lib/financeCats";

interface Meta { companies: { id: number; name: string }[]; years: string[]; boxes: string[] }
interface Summary {
  opening: number; inflow: number; outflow: number; closing: number;
  boxTotals: Record<string, { opening: number; inflow: number; outflow: number; closing: number }>;
  discrepancies: { box: string; companyId: number | null; month: string; expected: number; entered: number; diff: number }[];
}
interface Entry {
  id: number; box: string; companyId: number | null; periodMonth: string; entryDate: string | null;
  kind: string; amount: number; description: string | null; note: string | null; tabName: string; editable: boolean;
  transferGroup: string | null; manualCategory: string | null; category: string | null;
}
interface Reconcile { unmatchedBankIds: number[]; unmatchedBankTotal: number; unmatchedCashIds: number[]; unmatchedCashTotal: number; bankTotal: number; cashTotal: number }

const zl = (n: number) => `${(n ?? 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const MONTHS_UK = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const BOX_LABELS: Record<string, string> = { office: "Каса офісу", yuriy: "Сейф Юрія", tetiana: "Сейф Тетяни" };

export default function CashRegister() {
  const t = useT();
  const qc = useQueryClient();
  const { label: catLabel, recatOptions } = useCats();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [monthNum, setMonthNum] = useState(String(now.getMonth() + 1).padStart(2, "0"));
  const [companyId, setCompanyId] = useState("");
  const [box, setBox] = useState("office"); // office | yuriy | tetiana | "" (всі)
  const [editing, setEditing] = useState<Entry | null>(null);
  const [adding, setAdding] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const meta = useQuery<Meta>({ queryKey: ["cash-meta"], queryFn: () => get("/cash/meta") });
  const params = new URLSearchParams({ year });
  if (monthNum) params.set("month", monthNum);
  if (box) params.set("box", box);
  if (box === "office" && companyId) params.set("companyId", companyId);
  const summary = useQuery<Summary>({ queryKey: ["cash-summary", params.toString()], queryFn: () => get(`/cash/summary?${params}`) });
  const entries = useQuery<{ rows: Entry[] }>({ queryKey: ["cash-entries", params.toString()], queryFn: () => get(`/cash/entries?${params}`) });
  const rec = useQuery<Reconcile>({ queryKey: ["cash-reconcile", params.toString()], queryFn: () => get(`/cash/reconcile?${params}`), enabled: box === "office" });

  const coName = (id: number | null) => meta.data?.companies.find(c => c.id === id)?.name ?? "—";
  const boxLabel = (b: string) => t(BOX_LABELS[b] ?? b);
  const isOffice = box === "office";
  const showFirmCol = !box || (isOffice && !companyId);
  const invalidate = () => ["cash-summary", "cash-entries", "cash-reconcile"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  const s = summary.data;
  const unmatchedCash = new Set(rec.data?.unmatchedCashIds ?? []);
  const netDiffLine = (bankTotal: number, cashTotal: number) => {
    const net = bankTotal - cashTotal;
    const base = t("підсумок за період: знято з банку {a}, вписано в касу {b}", { a: zl(bankTotal), b: zl(cashTotal) });
    return net > 0.005 ? `${base} — ${t("в касі не вистачає {v}", { v: zl(net) })}`
      : net < -0.005 ? `${base} — ${t("в касу вписано на {v} більше", { v: zl(-net) })}`
      : `${base} — ${t("сходиться; непарні записи нижче — лише розбіжності дат/сум")}`;
  };

  return (
    <>
      <PageHeader title={t("Каса")} subtitle={t("Готівка фірми: каса офісу та резервні сейфи, звірка з банком")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Ящик")}</div>
          <div className="flex overflow-hidden rounded-lg border border-slate-200">
            {["office", "yuriy", "tetiana", ""].map(b => (
              <button key={b} onClick={() => setBox(b)}
                className={`px-3 py-2 text-sm ${box === b ? "bg-slate-800 font-medium text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                {b ? boxLabel(b) : t("Всі разом")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Рік")}</div>
          <Select value={year} onChange={e => setYear(e.target.value)} className="w-24">
            {(meta.data?.years?.length ? meta.data.years : [year]).map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t("Період")}</div>
          <Select value={monthNum} onChange={e => setMonthNum(e.target.value)} className="w-36">
            <option value="">{t("Весь рік")}</option>
            {MONTHS_UK.map((m, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
          </Select>
        </div>
        {isOffice && (
          <div>
            <div className="mb-1 text-xs text-slate-500">{t("Фірма")}</div>
            <Select value={companyId} onChange={e => setCompanyId(e.target.value)} className="w-40">
              <option value="">{t("Усі")}</option>
              {meta.data?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />{t("Запис")}</Button>
        <Button variant="ghost" onClick={() => setTransferring(true)}><ArrowLeftRight className="mr-1 h-4 w-4" />{t("Переміщення")}</Button>
      </div>

      {summary.isFetching && !s ? <Spinner /> : s && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Metric icon={<PiggyBank className="h-5 w-5 text-slate-400" />} label={t("На початок")} value={s.opening} />
            <Metric icon={<ArrowDownLeft className="h-5 w-5 text-emerald-500" />} label={t("Покладено")} value={s.inflow} tone="text-emerald-700" />
            <Metric icon={<ArrowUpRight className="h-5 w-5 text-rose-500" />} label={t("Видано")} value={s.outflow} tone="text-rose-600" />
            <Metric icon={<Wallet className="h-5 w-5 text-slate-400" />} label={t("На кінець")} value={s.closing} />
          </div>
          {!box && s.boxTotals && Object.keys(s.boxTotals).length > 1 && (
            <div className="mt-2 text-sm text-slate-500">
              {Object.entries(s.boxTotals).map(([b, v]) => `${boxLabel(b)}: ${zl(v.closing)}`).join(" · ")}
            </div>
          )}
        </>
      )}

      {/* internal chain check */}
      {s && s.discrepancies.length > 0 && (
        <Card className="mt-4 border-amber-200 bg-amber-50 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" />{t("Каса не сходиться між місяцями")}</div>
          <ul className="text-sm text-amber-700">
            {s.discrepancies.map((d, i) => (
              <li key={i}>{d.box === "office" ? coName(d.companyId) : boxLabel(d.box)} · {d.month}: {t("вписаний початок {a}, а кінець попереднього місяця {b} (різниця {c})", { a: zl(d.entered), b: zl(d.expected), c: zl(d.diff) })}</li>
            ))}
          </ul>
        </Card>
      )}
      {rec.data && (rec.data.unmatchedBankIds.length > 0 || rec.data.unmatchedCashIds.length > 0) && (
        <Card className="mt-3 border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{t("Звірка з банком не сходиться")}</div>
          <ul className="ml-6 list-disc space-y-0.5">
            {rec.data.unmatchedBankIds.length > 0 && (
              <li>{t("зняття без пари в касі: {n} на {v} (див. Витяги → Готівковий рух)", { n: rec.data.unmatchedBankIds.length, v: zl(rec.data.unmatchedBankTotal) })}</li>
            )}
            {rec.data.unmatchedCashIds.length > 0 && (
              <li>{t("приходи в касі без пари в банку: {n} на {v} (позначені в списку нижче)", { n: rec.data.unmatchedCashIds.length, v: zl(rec.data.unmatchedCashTotal) })}</li>
            )}
            <li className="font-medium">{netDiffLine(rec.data.bankTotal, rec.data.cashTotal)}</li>
          </ul>
        </Card>
      )}

      <Card className="mt-4 p-0">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">{t("Рухи каси")}</div>
        {entries.isFetching && !entries.data ? <div className="p-5"><Spinner /></div> : !(entries.data?.rows.length) ? <div className="p-5"><Empty>{t("Немає записів")}</Empty></div> : (
          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="px-3 py-2 text-left">{t("Дата")}</th>
                {!box && <th className="px-3 py-2 text-left">{t("Ящик")}</th>}
                {showFirmCol && <th className="px-3 py-2 text-left">{t("Фірма")}</th>}
                <th className="px-3 py-2 text-left">{t("Опис")}</th>
                <th className="px-3 py-2 text-left">{t("Категорія")}</th>
                <th className="px-3 py-2 text-left">{t("Нотатка")}</th>
                <th className="px-3 py-2 text-right">{t("Сума")}</th>
                <th className="px-2 py-2"></th>
              </tr></thead>
              <tbody>
                {entries.data!.rows.filter(e => e.kind !== "opening" || e.box !== "office").map(e => (
                  <tr key={e.id} className={`border-b border-slate-100 ${unmatchedCash.has(e.id) ? "bg-amber-50" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{e.entryDate ?? e.periodMonth}</td>
                    {!box && <td className="px-3 py-1.5 text-slate-600">{boxLabel(e.box)}</td>}
                    {showFirmCol && <td className="px-3 py-1.5 text-slate-600">{e.box === "office" ? coName(e.companyId) : "—"}</td>}
                    <td className="px-3 py-1.5 text-slate-700">
                      <div className="max-w-[320px] truncate">
                        {e.kind === "opening" ? (e.description || t("Початковий залишок (перерахунок)")) : (e.description || "—")}
                        {e.transferGroup && <span className="ml-1.5 rounded bg-sky-100 px-1 text-[10px] font-medium text-sky-700">{t("переміщення")}</span>}
                      </div>
                      {unmatchedCash.has(e.id) && <div className="text-[11px] font-medium text-amber-600">{t("не знайдено зняття в банку")}</div>}
                    </td>
                    <td className="px-3 py-1.5">
                      {e.kind === "out" && e.category && (e.category === "transfer" ? (
                        <span className="text-xs text-slate-400">{t(catLabel(e.category))}</span>
                      ) : (
                        <select
                          value={e.category}
                          onChange={async ev => { await patch(`/cash/entries/${e.id}/category`, { category: ev.target.value }); invalidate(); }}
                          className={`max-w-[170px] cursor-pointer truncate rounded border-0 bg-transparent p-0 text-xs focus:ring-0 ${e.manualCategory ? "font-medium text-sky-700" : "text-slate-500"}`}
                          title={e.manualCategory ? t("категорію змінено вручну") : t("категорія авто — можна змінити")}
                        >
                          {recatOptions.concat([{ value: "deposit", label: "Вплата на рахунок" }]).map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                        </select>
                      ))}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-slate-400"><div className="max-w-[220px] truncate">{e.note}{e.tabName !== "manual" && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px]">{t("з таблиці")}</span>}</div></td>
                    <td className={`whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums ${e.kind === "in" ? "text-emerald-600" : e.kind === "out" ? "text-rose-600" : "text-slate-700"}`}>{e.kind === "in" ? "+" : e.kind === "out" ? "−" : "="}{zl(e.amount)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {e.editable && (
                        <>
                          {!e.transferGroup && <button className="p-1 text-slate-300 hover:text-slate-600" onClick={() => setEditing(e)}><Pencil className="h-4 w-4" /></button>}
                          <button className="p-1 text-slate-300 hover:text-rose-500" onClick={async () => { if (confirm(e.transferGroup ? t("Видалити переміщення (обидва записи)?") : t("Видалити запис?"))) { await del(`/cash/entries/${e.id}`); invalidate(); } }}><Trash2 className="h-4 w-4" /></button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {transferring && (
        <TransferModal
          companies={meta.data?.companies ?? []}
          defaultFrom={box && box !== "office" ? box : "office"}
          onClose={() => setTransferring(false)}
          onSaved={() => { setTransferring(false); invalidate(); }}
        />
      )}
      {(adding || editing) && (
        <EntryModal
          companies={meta.data?.companies ?? []}
          entry={editing}
          defaultCompany={companyId}
          defaultBox={editing ? editing.box : (box || "office")}
          boxLocked={!!editing || !!box}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); invalidate(); }}
        />
      )}
    </>
  );
}

function Metric({ icon, label, value, tone = "text-slate-800" }: { icon: React.ReactNode; label: string; value: number; tone?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-500">{label}</div>{icon}</div>
      <div className={`mt-2 text-2xl font-bold ${tone}`}>{zl(value)}</div>
    </Card>
  );
}

function TransferModal({ companies, defaultFrom, onClose, onSaved }: {
  companies: { id: number; name: string }[]; defaultFrom: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const SIDES: Record<string, string> = { ...BOX_LABELS, bank: "Рахунок (банк)" };
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultFrom === "office" ? "yuriy" : "office");
  const [companyId, setCompanyId] = useState(String(companies[0]?.id ?? ""));
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const officeInvolved = from === "office" || to === "office";
  const valid = from !== to && !!amount && !!entryDate && (!officeInvolved || !!companyId) && !(from === "bank" && to === "bank");
  const save = async () => {
    setBusy(true);
    try {
      await post("/cash/transfer", { from, to, companyId: officeInvolved ? Number(companyId) : null, entryDate, amount, note });
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={t("Переміщення готівки")} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Звідки")}</div>
            <Select value={from} onChange={e => setFrom(e.target.value)}>
              {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </Select></label>
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Куди")}</div>
            <Select value={to} onChange={e => setTo(e.target.value)}>
              {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </Select></label>
        </div>
        {from === to && <div className="text-xs text-rose-600">{t("«Звідки» і «Куди» мають різнитися")}</div>}
        {officeInvolved && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Фірма (для запису каси офісу)")}</div>
            <Select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        )}
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Дата")}</div>
          <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума")}</div>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Нотатка")}</div>
          <Input value={note} onChange={e => setNote(e.target.value)} /></label>
        {(from === "bank" || to === "bank") && (
          <div className="text-xs text-slate-500">{t("Рух з/на рахунок створює лише запис у касі — банківська частина підтягнеться з витягу і звіриться автоматично")}</div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!valid} onClick={save}>{t("Перемістити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EntryModal({ companies, entry, defaultCompany, defaultBox, boxLocked, onClose, onSaved }: {
  companies: { id: number; name: string }[]; entry: Entry | null; defaultCompany: string; defaultBox: string; boxLocked: boolean; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [box, setBox] = useState(defaultBox);
  const [companyId, setCompanyId] = useState(entry ? String(entry.companyId ?? "") : (defaultCompany || String(companies[0]?.id ?? "")));
  const [entryDate, setEntryDate] = useState(entry?.entryDate ?? new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState(entry?.kind ?? "out");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [busy, setBusy] = useState(false);
  const isOffice = box === "office";
  const effKind = isOffice && kind === "opening" ? "out" : kind;
  const save = async () => {
    setBusy(true);
    try {
      const body = { box, companyId: isOffice ? Number(companyId) : null, entryDate, kind: effKind, amount, description, note };
      if (entry) await patch(`/cash/entries/${entry.id}`, body);
      else await post("/cash/entries", body);
      onSaved();
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={entry ? t("Редагувати запис") : t("Новий запис каси")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Ящик")}</div>
          <Select value={box} onChange={e => setBox(e.target.value)} disabled={boxLocked}>
            {Object.entries(BOX_LABELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </Select></label>
        {isOffice && (
          <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Фірма")}</div>
            <Select value={companyId} onChange={e => setCompanyId(e.target.value)} disabled={!!entry}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        )}
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Тип")}</div>
          <Select value={effKind} onChange={e => setKind(e.target.value)}>
            <option value="in">{isOffice ? t("Покладено в касу (знято з карти)") : t("Покладено в сейф")}</option>
            <option value="out">{isOffice ? t("Видано з каси") : t("Видано з сейфа")}</option>
            {!isOffice && <option value="opening">{t("Початковий залишок (перерахунок)")}</option>}
          </Select></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Дата")}</div>
          <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Сума")}</div>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Опис (кому / за що)")}</div>
          <Input value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="block"><div className="mb-1 text-xs font-medium text-slate-500">{t("Нотатка")}</div>
          <Input value={note} onChange={e => setNote(e.target.value)} /></label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={busy} disabled={!amount || !entryDate || (isOffice && !companyId)} onClick={save}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}
