// Одяг: магазин (склад: тип/розмір/стан/ціна/кількість), видача зі складу з
// життєвим циклом (видано → повернуто/знято з ЗП), «до зняття» з перенесенням
// до сводної (колонка Odzież) і архів знять. Мігровано з таблиць водія (07.2026).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Shirt, Store, Banknote, Archive, Tags } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del } from "../lib/api";
import { Button, Input, Label, Card, Spinner, Badge, Modal, Empty, Select } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { IssueClothingModal, ReturnClothingModal } from "./WorkerDetail";
import { useClothingTypes, type ClothingType } from "../lib/clothingTypes";

type Item = {
  id: number; workerId: number | null; workerName: string | null; itemType: string;
  ownership: string | null; price: number | null; deducted: boolean; writtenOff: boolean; periodMonth: string | null; note: string | null;
  stockId: number | null; size: string | null; condition: string | null;
  issuedAt: string | null; returnedAt: string | null; deductedAmount: number | null; deductedMonth: string | null;
};
type StockRow = {
  id: number; itemType: string; name: string | null; size: string | null; condition: string;
  price: number | null; qty: number; note: string | null; isActive: boolean;
};
type PendingGroup = { workerId: number | null; workerName: string | null; total: number; items: { id: number; itemType: string; size: string | null; condition: string | null; price: number | null; issuedAt: string | null; note: string | null }[] };

const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const curMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }).slice(0, 7);

export default function Clothing() {
  const t = useT();
  const [tab, setTab] = useState<"issued" | "shop" | "pending" | "archive">("issued");
  const TABS: [typeof tab, string][] = [
    ["issued", t("Видача")], ["shop", t("Магазин")], ["pending", t("До зняття")], ["archive", t("Архів знять")],
  ];
  return (
    <>
      <PageHeader title={t("Одяг")} subtitle={t("магазин, видача спецодягу і зняття з ЗП")} />
      <div className="mb-4 flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 ${tab === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "issued" && <IssuedTab />}
      {tab === "shop" && <ShopTab />}
      {tab === "pending" && <PendingTab />}
      {tab === "archive" && <ArchiveTab />}
    </>
  );
}

const WorkerCell = ({ workerId, workerName }: { workerId: number | null; workerName: string | null }) =>
  workerId != null
    ? <Link href={`/workers/${workerId}`} className="font-medium text-slate-700 hover:text-red-600 hover:underline">{workerName ?? "—"}</Link>
    : <span className="font-medium text-slate-700">{workerName ?? "—"}</span>;

// ─── Видача: реєстр виданого ─────────────────────────────────────────────────
function IssuedTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { labelOf } = useClothingTypes();
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery<{ rows: Item[]; pendingTotal: number; totalItems: number }>({
    queryKey: ["clothing", q],
    queryFn: () => get(`/clothing${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });
  const [issuing, setIssuing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [returning, setReturning] = useState<Item | null>(null);
  const inv = () => { qc.invalidateQueries({ queryKey: ["clothing"] }); qc.invalidateQueries({ queryKey: ["clothing-stock"] }); qc.invalidateQueries({ queryKey: ["clothing-pending"] }); };
  const remove = useMutation({ mutationFn: (id: number) => del(`/clothing/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const toggleDeducted = useMutation({
    mutationFn: (i: Item) => patch(`/clothing/${i.id}`, { deducted: !i.deducted }),
    onSuccess: () => inv(), onError: (e: any) => toast.error(e.message),
  });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук за імʼям…")} className="w-64" />
        {data && <span className="text-sm text-slate-500">
          <Shirt className="mr-1 inline h-4 w-4 text-red-600" />
          {data.totalItems} {t("позицій")} · {t("не знято з ЗП")}: <b>{fmtPln(data.pendingTotal)} зл</b>
        </span>}
        <div className="ml-auto flex gap-2">
          <Button onClick={() => setIssuing(true)}><Plus className="h-4 w-4" /> {t("Видати зі складу")}</Button>
          <Button variant="secondary" onClick={() => setAdding(true)}>{t("Додати вручну")}</Button>
        </div>
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !data?.rows.length ? <Empty>{t("Немає записів")}</Empty> : (
          <table className="w-full min-w-160 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Працівник")}</th><th className="px-3 py-2.5">{t("Тип")}</th>
                <th className="px-3 py-2.5">{t("Стан")}</th><th className="px-3 py-2.5">{t("Належність")}</th>
                <th className="px-3 py-2.5">{t("Видано")}</th><th className="px-3 py-2.5">{t("Повернуто")}</th>
                <th className="px-3 py-2.5 text-right">{t("Ціна, зл")}</th>
                <th className="px-3 py-2.5">{t("Знято з ЗП")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th><th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(i => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <WorkerCell workerId={i.workerId} workerName={i.workerName} />
                    {i.workerId == null && <span className="ml-1"><Badge color="amber">{t("не привʼязано")}</Badge></span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{t(labelOf(i.itemType))}{i.size && <span className="text-slate-400"> · {i.size}</span>}</td>
                  <td className="px-3 py-2">{i.condition === "new" ? <Badge color="blue">{t("новий")}</Badge> : i.condition === "used" ? <Badge color="slate">{t("БУ")}</Badge> : "—"}</td>
                  <td className="px-3 py-2">
                    {i.ownership === "ours" ? <Badge color="blue">{t("наш")}</Badge>
                      : i.ownership === "own" ? <Badge color="slate">{t("своє")}</Badge>
                      : i.ownership === "sold" ? <Badge color="amber">{t("проданий")}</Badge> : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{i.issuedAt ? fmtD(i.issuedAt) : i.periodMonth ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{i.returnedAt ? fmtD(i.returnedAt) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{i.price != null ? fmtPln(i.price) : "—"}</td>
                  <td className="px-3 py-2">
                    {i.writtenOff ? <Badge color="slate">{t("списано")}</Badge>
                      : i.deducted ? (
                        <button onClick={() => toggleDeducted.mutate(i)} title={t("Клікни, щоб перемкнути")}>
                          <Badge color="green">{t("знято")}{i.deductedMonth ? ` · ${i.deductedMonth}` : ""}</Badge>
                        </button>
                      ) : i.returnedAt ? <span className="text-xs text-slate-400">{t("повернуто без зняття")}</span>
                      : i.price != null ? (
                        <button onClick={() => toggleDeducted.mutate(i)} title={t("Клікни, щоб перемкнути")}>
                          <Badge color="rose">{t("ще ні")}</Badge>
                        </button>
                      ) : "—"}
                  </td>
                  <td className="max-w-40 truncate px-3 py-2 text-xs text-slate-400" title={i.note ?? undefined}>{i.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {!i.returnedAt && (
                        <button title={t("Повернення")} onClick={() => setReturning(i)}
                          className="rounded-lg px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700">↩</button>
                      )}
                      <button onClick={() => setEditing(i)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Pencil className="h-4 w-4" /></button>
                      <button onClick={async () => { if (await confirm({ title: t("Видалити запис?"), danger: true, confirmText: t("Видалити") })) remove.mutate(i.id); }}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {issuing && <IssueClothingModal onClose={() => setIssuing(false)} onSaved={() => { inv(); setIssuing(false); }} />}
      {returning && (
        <ReturnClothingModal itemId={returning.id}
          label={`${returning.workerName ?? "—"} · ${t(labelOf(returning.itemType))}${returning.size ? ` · ${returning.size}` : ""}`}
          onClose={() => setReturning(null)} onSaved={() => { inv(); setReturning(null); }} />
      )}
      {(adding || editing) && <ItemModal item={editing ?? undefined} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { inv(); setAdding(false); setEditing(null); }} />}
    </>
  );
}

// ─── Магазин: склад ──────────────────────────────────────────────────────────
function ShopTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { labelOf } = useClothingTypes();
  const { data: stock = [], isLoading } = useQuery<StockRow[]>({ queryKey: ["clothing-stock"], queryFn: () => get("/clothing/stock") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StockRow | null>(null);
  const [managingTypes, setManagingTypes] = useState(false);
  const inv = () => qc.invalidateQueries({ queryKey: ["clothing-stock"] });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/clothing/stock/${id}`),
    onSuccess: (r: any) => { inv(); toast.success(r?.deactivated ? t("Позиція мала видачі — деактивовано") : t("Видалено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const totalQty = stock.filter(s => s.isActive).reduce((s, r) => s + r.qty, 0);
  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-sm text-slate-500"><Store className="mr-1 inline h-4 w-4 text-red-600" /> {t("на складі")}: <b>{totalQty} {t("шт")}</b></span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => setManagingTypes(true)}><Tags className="h-4 w-4" /> {t("Типи")}</Button>
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати позицію")}</Button>
        </div>
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !stock.length ? <Empty>{t("Склад порожній")}</Empty> : (
          <table className="w-full min-w-140 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Тип")}</th><th className="px-3 py-2.5">{t("Назва")}</th>
                <th className="px-3 py-2.5">{t("Розмір")}</th><th className="px-3 py-2.5">{t("Стан")}</th>
                <th className="px-3 py-2.5 text-right">{t("Ціна, зл")}</th><th className="px-3 py-2.5 text-right">{t("К-сть")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th><th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stock.map(s => (
                <tr key={s.id} className={`hover:bg-slate-50 ${!s.isActive ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 font-medium text-slate-700">{t(labelOf(s.itemType))}{!s.isActive && <span className="ml-1.5"><Badge color="slate">{t("неактивна")}</Badge></span>}</td>
                  <td className="px-3 py-2 text-slate-600">{s.name ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{s.size ?? "—"}</td>
                  <td className="px-3 py-2">{s.condition === "new" ? <Badge color="blue">{t("новий")}</Badge> : <Badge color="slate">{t("БУ")}</Badge>}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{s.price != null ? fmtPln(s.price) : "—"}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{s.qty}</td>
                  <td className="max-w-40 truncate px-3 py-2 text-xs text-slate-400" title={s.note ?? undefined}>{s.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(s)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Pencil className="h-4 w-4" /></button>
                      <button onClick={async () => { if (await confirm({ title: t("Видалити позицію складу?"), danger: true, confirmText: t("Видалити") })) remove.mutate(s.id); }}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {(adding || editing) && <StockModal row={editing ?? undefined} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { inv(); setAdding(false); setEditing(null); }} />}
      {managingTypes && <TypesModal onClose={() => setManagingTypes(false)} />}
    </>
  );
}

// Довідник типів одягу: додати новий, перейменувати, сховати невживаний.
// key лишається в записах складу/видач — перейменування міняє підпис скрізь.
function TypesModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { types } = useClothingTypes();
  const [newLabel, setNewLabel] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const inv = () => qc.invalidateQueries({ queryKey: ["clothing-types"] });
  const add = useMutation({
    mutationFn: () => post<ClothingType>("/clothing/types", { label: newLabel.trim() }),
    onSuccess: () => { inv(); setNewLabel(""); toast.success(t("Тип додано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: (v: { id: number; label?: string; isActive?: boolean }) => patch(`/clothing/types/${v.id}`, v),
    onSuccess: () => { inv(); setEditId(null); },
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/clothing/types/${id}`),
    onSuccess: (r: any) => { inv(); toast.success(r?.deactivated ? t("Тип має записи — деактивовано") : t("Видалено")); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Типи одягу")}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder={t("Новий тип (напр. Рукавиці)")} autoFocus
            onKeyDown={e => { if (e.key === "Enter" && newLabel.trim()) add.mutate(); }} />
          <Button loading={add.isPending} onClick={() => newLabel.trim() && add.mutate()}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
        </div>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {types.map(ty => (
            <div key={ty.id} className={`flex items-center gap-2 px-3 py-2 text-sm ${!ty.isActive ? "opacity-50" : ""}`}>
              {editId === ty.id ? (
                <>
                  <Input value={editLabel} onChange={e => setEditLabel(e.target.value)} className="h-8"
                    onKeyDown={e => { if (e.key === "Enter" && editLabel.trim()) save.mutate({ id: ty.id, label: editLabel.trim() }); }} />
                  <button className="text-xs font-medium text-emerald-600" onClick={() => editLabel.trim() && save.mutate({ id: ty.id, label: editLabel.trim() })}>{t("Зберегти")}</button>
                  <button className="text-xs text-slate-400" onClick={() => setEditId(null)}>{t("Скасувати")}</button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{t(ty.label)}</span>
                  {!ty.isActive && <Badge color="slate">{t("неактивна")}</Badge>}
                  <button title={t("Перейменувати")} onClick={() => { setEditId(ty.id); setEditLabel(ty.label); }}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Pencil className="h-4 w-4" /></button>
                  <button title={ty.isActive ? t("Сховати") : t("Активувати")}
                    onClick={() => save.mutate({ id: ty.id, isActive: !ty.isActive })}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">{ty.isActive ? "👁" : "🚫"}</button>
                  <button title={t("Видалити")}
                    onClick={async () => { if (await confirm({ title: t("Видалити тип?"), message: t("Тип із записами складу чи видач не видаляється — лише деактивується."), danger: true, confirmText: t("Видалити") })) remove.mutate(ty.id); }}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Закрити")}</Button>
        </div>
      </div>
    </Modal>
  );
}


// опції типів для селектів: активні з довідника + поточне значення рядка
// (легасі/деактивований тип не має зникати з форми редагування)
function useTypeOptions(current?: string | null): { key: string; label: string }[] {
  const { types, active, labelOf } = useClothingTypes();
  const opts = active.map(x => ({ key: x.key, label: x.label }));
  if (current && !opts.some(o => o.key === current) && (types.length || current))
    opts.push({ key: current, label: labelOf(current) });
  return opts;
}

function StockModal({ row, onClose, onSaved }: { row?: StockRow; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const typeOptions = useTypeOptions(row?.itemType);
  const isEdit = !!row;
  const [f, setF] = useState({
    itemType: row?.itemType ?? "boots", name: row?.name ?? "", size: row?.size ?? "",
    condition: row?.condition ?? "new", price: row?.price != null ? String(row.price) : "",
    qty: row != null ? String(row.qty) : "0", note: row?.note ?? "", isActive: row?.isActive ?? true,
  });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target?.type === "checkbox" ? e.target.checked : e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        itemType: f.itemType, name: f.name, size: f.size, condition: f.condition,
        price: f.price ? Number(f.price) : null, qty: Number(f.qty) || 0, note: f.note, isActive: f.isActive,
      };
      return isEdit ? patch(`/clothing/stock/${row!.id}`, body) : post("/clothing/stock", body);
    },
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати позицію") : t("Нова позиція складу")}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Тип")}</Label>
            <Select value={f.itemType} onChange={set("itemType")}>
              {typeOptions.map(o => <option key={o.key} value={o.key}>{t(o.label)}</option>)}
            </Select></div>
          <div><Label>{t("Назва (уточнення)")}</Label><Input value={f.name} onChange={set("name")} placeholder={t("напр. Lahti Pro")} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>{t("Розмір")}</Label><Input value={f.size} onChange={set("size")} placeholder="42 / L" /></div>
          <div><Label>{t("Стан")}</Label>
            <Select value={f.condition} onChange={set("condition")}>
              <option value="new">{t("новий")}</option><option value="used">{t("БУ")}</option>
            </Select></div>
          <div><Label>{t("К-сть, шт")}</Label><Input type="number" min={0} value={f.qty} onChange={set("qty")} /></div>
        </div>
        <div><Label>{t("Ціна зняття, зл")}</Label><Input type="number" value={f.price} onChange={set("price")} /></div>
        <div><Label>{t("Нотатка")}</Label><Input value={f.note} onChange={set("note")} /></div>
        {isEdit && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.isActive} onChange={set("isActive")} className="accent-red-600" /> {t("активна (доступна для видачі)")}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{isEdit ? t("Зберегти") : t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── До зняття: список людей і сум + перенесення до сводної (Odzież) ─────────
function PendingTab() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { labelOf } = useClothingTypes();
  const me = useMe();
  const canSvodni = can(me, "svodni");
  const [month, setMonth] = useState(curMonth());
  const { data, isLoading } = useQuery<{ groups: PendingGroup[]; total: number }>({
    queryKey: ["clothing-pending"], queryFn: () => get("/clothing/pending"),
  });
  const apply = useMutation({
    mutationFn: () => post<{ updated: number; itemsMarked: number; verified: number; verifyMismatches: { workerName: string; factoryLabel: string; expected: number | null; actual: number | null }[]; skippedLocked: number; unmatched: { workerName: string | null; amount: number }[] }>(
      "/svodni/apply-clothing-deductions", { month }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["clothing-pending"] });
      qc.invalidateQueries({ queryKey: ["clothing"] });
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
  // місяці на вибір — реальні місяці сводних (перенесення цілить у наявну вкладку)
  const { data: svodniMonths } = useQuery<{ months: string[] }>({
    queryKey: ["svodni-months"], queryFn: () => get("/svodni/months"), enabled: canSvodni,
  });
  const months = useMemo(
    () => [...new Set([curMonth(), ...(svodniMonths?.months ?? [])])].sort().reverse(),
    [svodniMonths]);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500"><Banknote className="mr-1 inline h-4 w-4 text-red-600" /> {t("до зняття")}: <b>{fmtPln(data?.total ?? 0)} зл</b> · {data?.groups.length ?? 0} {t("людей")}</span>
        {canSvodni && (
          <div className="ml-auto flex items-center gap-2">
            <Select value={month} onChange={e => setMonth(e.target.value)} className="w-36">
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </Select>
            <Button loading={apply.isPending}
              onClick={async () => { if (await confirm({ title: t("Перенести зняття за одяг до сводної?"), message: t("Суми ляжуть у колонку Odzież рядка основної фабрики людини за вибраний місяць; позиції позначаться «знято». Затверджені вкладки пропускаються."), confirmText: t("Перенести") })) apply.mutate(); }}>
              → {t("Перенести до сводної")}
            </Button>
          </div>
        )}
      </div>
      {isLoading ? <Spinner /> : !data?.groups.length ? <Card><Empty>{t("Нема одягу до зняття")}</Empty></Card> : (
        <div className="space-y-3">
          {data.groups.map(g => (
            <Card key={g.workerId ?? g.workerName ?? "?"} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <WorkerCell workerId={g.workerId} workerName={g.workerName} />
                  {g.workerId == null && <Badge color="amber">{t("не привʼязано")}</Badge>}
                </div>
                <span className="text-sm font-semibold tabular-nums text-slate-800">{fmtPln(g.total)} зл</span>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {g.items.map(i => (
                    <tr key={i.id} className="hover:bg-slate-50">
                      <td className="px-4 py-1.5 text-slate-600">{t(labelOf(i.itemType))}{i.size && <span className="text-slate-400"> · {i.size}</span>}{i.condition === "used" && <span className="ml-1.5 align-middle"><Badge color="slate">{t("БУ")}</Badge></span>}</td>
                      <td className="px-4 py-1.5 tabular-nums text-slate-500">{i.issuedAt ? fmtD(i.issuedAt) : "—"}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-slate-700">{i.price != null ? fmtPln(i.price) : "—"} зл</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Архів знять: що вже знято, з якої сводної ───────────────────────────────
function ArchiveTab() {
  const t = useT();
  const { labelOf } = useClothingTypes();
  const { data, isLoading } = useQuery<{ rows: Item[] }>({ queryKey: ["clothing", ""], queryFn: () => get("/clothing") });
  const deducted = (data?.rows ?? []).filter(i => i.deducted);
  const byMonth = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of deducted) {
      const k = i.deductedMonth ?? i.periodMonth ?? "—";
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [deducted]);
  if (isLoading) return <Spinner />;
  if (!deducted.length) return <Card><Empty>{t("Ще нічого не знято")}</Empty></Card>;
  return (
    <div className="space-y-4">
      {byMonth.map(([month, items]) => (
        <Card key={month} className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Archive className="h-4 w-4 text-red-600" /> {month}</div>
            <span className="text-sm font-semibold tabular-nums text-slate-800">{fmtPln(items.reduce((s, i) => s + (i.deductedAmount ?? i.price ?? 0), 0))} зл</span>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {items.map(i => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-4 py-1.5"><WorkerCell workerId={i.workerId} workerName={i.workerName} /></td>
                  <td className="px-4 py-1.5 text-slate-600">{t(labelOf(i.itemType))}{i.size && <span className="text-slate-400"> · {i.size}</span>}</td>
                  <td className="px-4 py-1.5 tabular-nums text-slate-500">{i.issuedAt ? fmtD(i.issuedAt) : i.periodMonth ?? "—"}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums text-slate-700">{fmtPln(i.deductedAmount ?? i.price ?? 0)} зл</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

// ─── Ручний запис реєстру (історія / одяг не зі складу) ──────────────────────
function ItemModal({ item, onClose, onSaved }: { item?: Item; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const typeOptions = useTypeOptions(item?.itemType);
  const isEdit = !!item;
  const { data: workers = [] } = useQuery<{ id: number; fullName: string }[]>({ queryKey: ["workers-light"], queryFn: () => get("/workers") });
  const [f, setF] = useState({
    workerId: item?.workerId != null ? String(item.workerId) : "", workerName: item?.workerName ?? "",
    itemType: item?.itemType ?? "boots", ownership: item?.ownership ?? "ours",
    price: item?.price != null ? String(item.price) : "", deducted: item?.deducted ?? false,
    writtenOff: item?.writtenOff ?? false,
    month: item?.periodMonth ?? "", note: item?.note ?? "", size: item?.size ?? "",
  });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target?.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        workerId: f.workerId ? Number(f.workerId) : null, workerName: f.workerName,
        itemType: f.itemType, ownership: f.ownership || null,
        price: f.price ? Number(f.price) : null, deducted: f.deducted, writtenOff: f.writtenOff,
        month: f.month || null, note: f.note, size: f.size,
      };
      return isEdit ? patch(`/clothing/${item!.id}`, body) : post("/clothing", body);
    },
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати запис") : t("Видати одяг")}>
      <div className="space-y-3">
        {!isEdit && (
          <div><Label>{t("Працівник")}</Label>
            <Select value={f.workerId} onChange={set("workerId")}>
              <option value="">{t("— не в базі (впишіть імʼя) —")}</option>
              {workers.map((w: any) => <option key={w.id} value={w.id}>{w.fullName}</option>)}
            </Select></div>
        )}
        {!f.workerId && !isEdit && <div><Label>{t("Імʼя")}</Label><Input value={f.workerName} onChange={set("workerName")} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Тип")}</Label>
            <Select value={f.itemType} onChange={set("itemType")}>
              {typeOptions.map(o => <option key={o.key} value={o.key}>{t(o.label)}</option>)}
            </Select></div>
          <div><Label>{t("Належність")}</Label>
            <Select value={f.ownership} onChange={set("ownership")}>
              <option value="ours">{t("наш")}</option><option value="own">{t("своє")}</option><option value="sold">{t("проданий")}</option>
            </Select></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>{t("Розмір")}</Label><Input value={f.size} onChange={set("size")} /></div>
          <div><Label>{t("Ціна, зл")}</Label><Input type="number" value={f.price} onChange={set("price")} /></div>
          <div><Label>{t("Місяць")}</Label><Input type="month" value={f.month} onChange={set("month")} /></div>
        </div>
        <div className="flex gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.deducted} onChange={set("deducted")} className="accent-red-600" /> {t("знято")}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.writtenOff} onChange={set("writtenOff")} className="accent-red-600" /> {t("списано")}
          </label>
        </div>
        <div><Label>{t("Нотатка")}</Label><Input value={f.note} onChange={set("note")} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => (f.workerId || f.workerName.trim() || isEdit) && save.mutate()}>{isEdit ? t("Зберегти") : t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}
