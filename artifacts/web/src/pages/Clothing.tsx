// Одяг: реєстр видачі спецодягу (наш/свій/проданий) і ціни зняття з ЗП.
// Мігровано з таблиць водія «Учёт рабочей одежды» / «Forma» (07.2026).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Shirt } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del } from "../lib/api";
import { Button, Input, Label, Card, Spinner, Badge, Modal, Empty, Select } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

type Item = {
  id: number; workerId: number | null; workerName: string | null; itemType: string;
  ownership: string | null; price: number | null; deducted: boolean; writtenOff: boolean; periodMonth: string | null; note: string | null;
};

const TYPE_LABEL: Record<string, string> = { boots: "Взуття", coverall: "Комбінезон", jacket: "Куртка", hat: "Шапка", tshirt: "Футболка", set: "Комплект", other: "Інше" };
const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Clothing() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery<{ rows: Item[]; pendingTotal: number; totalItems: number }>({
    queryKey: ["clothing", q],
    queryFn: () => get(`/clothing${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["clothing"] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/clothing/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const toggleDeducted = useMutation({
    mutationFn: (i: Item) => patch(`/clothing/${i.id}`, { deducted: !i.deducted }),
    onSuccess: () => inv(), onError: (e: any) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader title={t("Одяг")} subtitle={t("видача спецодягу і зняття з ЗП")}
        action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button>} />
      <div className="mb-3 flex items-center gap-3">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук за імʼям…")} className="w-64" />
        {data && <span className="text-sm text-slate-500">
          <Shirt className="mr-1 inline h-4 w-4 text-red-600" />
          {data.totalItems} {t("позицій")} · {t("не знято з ЗП")}: <b>{fmtPln(data.pendingTotal)} зл</b>
        </span>}
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !data?.rows.length ? <Empty>{t("Немає записів")}</Empty> : (
          <table className="w-full min-w-140 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Працівник")}</th><th className="px-3 py-2.5">{t("Тип")}</th>
                <th className="px-3 py-2.5">{t("Належність")}</th><th className="px-3 py-2.5 text-right">{t("Ціна, зл")}</th>
                <th className="px-3 py-2.5">{t("Знято з ЗП")}</th><th className="px-3 py-2.5">{t("Місяць")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th><th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map(i => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-700">{i.workerName ?? "—"}{i.workerId == null && <Badge color="amber">{t("не привʼязано")}</Badge>}</td>
                  <td className="px-3 py-2 text-slate-600">{t(TYPE_LABEL[i.itemType] ?? i.itemType)}</td>
                  <td className="px-3 py-2">
                    {i.ownership === "ours" ? <Badge color="blue">{t("наш")}</Badge>
                      : i.ownership === "own" ? <Badge color="slate">{t("своє")}</Badge>
                      : i.ownership === "sold" ? <Badge color="amber">{t("проданий")}</Badge> : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{i.price != null ? fmtPln(i.price) : "—"}</td>
                  <td className="px-3 py-2">
                    {i.writtenOff ? <Badge color="slate">{t("списано")}</Badge>
                      : i.price != null ? (
                        <button onClick={() => toggleDeducted.mutate(i)} title={t("Клікни, щоб перемкнути")}>
                          {i.deducted ? <Badge color="green">{t("знято")}</Badge> : <Badge color="rose">{t("ще ні")}</Badge>}
                        </button>
                      ) : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{i.periodMonth ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{i.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
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
      {(adding || editing) && <ItemModal item={editing ?? undefined} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { inv(); setAdding(false); setEditing(null); }} />}
    </>
  );
}

function ItemModal({ item, onClose, onSaved }: { item?: Item; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const isEdit = !!item;
  const { data: workers = [] } = useQuery<{ id: number; fullName: string }[]>({ queryKey: ["workers-light"], queryFn: () => get("/workers") });
  const [f, setF] = useState({
    workerId: item?.workerId != null ? String(item.workerId) : "", workerName: item?.workerName ?? "",
    itemType: item?.itemType ?? "boots", ownership: item?.ownership ?? "ours",
    price: item?.price != null ? String(item.price) : "", deducted: item?.deducted ?? false,
    writtenOff: item?.writtenOff ?? false,
    month: item?.periodMonth ?? "", note: item?.note ?? "",
  });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target?.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        workerId: f.workerId ? Number(f.workerId) : null, workerName: f.workerName,
        itemType: f.itemType, ownership: f.ownership || null,
        price: f.price ? Number(f.price) : null, deducted: f.deducted, writtenOff: f.writtenOff,
        month: f.month || null, note: f.note,
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
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </Select></div>
          <div><Label>{t("Належність")}</Label>
            <Select value={f.ownership} onChange={set("ownership")}>
              <option value="ours">{t("наш")}</option><option value="own">{t("своє")}</option><option value="sold">{t("проданий")}</option>
            </Select></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>{t("Ціна, зл")}</Label><Input type="number" value={f.price} onChange={set("price")} /></div>
          <div><Label>{t("Місяць")}</Label><Input type="month" value={f.month} onChange={set("month")} /></div>
          <div className="flex flex-col justify-end gap-1 pb-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={f.deducted} onChange={set("deducted")} className="accent-red-600" /> {t("знято")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={f.writtenOff} onChange={set("writtenOff")} className="accent-red-600" /> {t("списано")}
            </label>
          </div>
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
