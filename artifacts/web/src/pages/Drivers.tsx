import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Crown, Link2, Trash2, Pencil, Copy } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, type Driver } from "../lib/api";
import { Button, Input, Label, Card, Spinner, Badge, Modal, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";

export default function Drivers() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const { data: drivers, isLoading } = useQuery<Driver[]>({ queryKey: ["drivers"], queryFn: () => get("/drivers") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Driver | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["drivers"] });

  const setHead = useMutation({ mutationFn: (id: number) => patch(`/drivers/${id}`, { isHeadDriver: true }), onSuccess: () => { inv(); toast.success(t("Головного водія призначено")); } });
  const remove = useMutation({ mutationFn: (id: number) => del(`/drivers/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); } });
  const invite = useMutation({
    mutationFn: (id: number) => get<{ link: string }>(`/drivers/${id}/invite`),
    onSuccess: (d) => { navigator.clipboard?.writeText(d.link); toast.success(t("Посилання скопійовано"), { description: d.link }); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Водії")} subtitle={`${drivers?.length ?? 0} ${t("активних")}`}
        action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button>} />
      <Card className="overflow-x-auto">
        {!drivers?.length ? <Empty>{t("Немає водіїв")}</Empty> : (
          <table className="w-full min-w-120 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Ім'я")}</th><th className="px-4 py-2.5">{t("Авто")}</th><th className="px-4 py-2.5">{t("Телефон")}</th><th className="px-4 py-2.5">Telegram</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {drivers.map(d => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{d.isHeadDriver && "👑 "}{d.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{d.vehicle ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">{d.phone ?? "—"}</td>
                  <td className="px-4 py-2.5">{d.telegramId ? <Badge color="green">{t("✓ приєднаний")}</Badge> : <Badge color="amber">{t("не приєднаний")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(d)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Редагувати")}><Pencil className="h-4 w-4" /></button>
                      {!d.telegramId && <button onClick={() => invite.mutate(d.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Скопіювати посилання-запрошення")}><Link2 className="h-4 w-4" /></button>}
                      {!d.isHeadDriver && me?.isMain && <button onClick={() => setHead.mutate(d.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600" title={t("Зробити головним")}><Crown className="h-4 w-4" /></button>}
                      <button onClick={async () => { if (await confirm({ title: t("Видалити {name}?", { name: d.name }), danger: true, confirmText: t("Видалити") })) remove.mutate(d.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adding && <DriverModal onClose={() => setAdding(false)} onSaved={() => { inv(); setAdding(false); }} />}
      {editing && <DriverModal driver={editing} onClose={() => setEditing(null)} onSaved={() => { inv(); setEditing(null); }} />}
    </>
  );
}

function DriverModal({ driver, onClose, onSaved }: { driver?: Driver; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const isEdit = !!driver;
  const [name, setName] = useState(driver?.name ?? "");
  const [vehicle, setVehicle] = useState(driver?.vehicle ?? "");
  const [phone, setPhone] = useState(driver?.phone ?? "");
  const [seats, setSeats] = useState(driver?.seats != null ? String(driver.seats) : "");

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, vehicle, phone, seats: seats.trim() ? Number(seats) : null };
      if (isEdit) return patch<Driver>(`/drivers/${driver!.id}`, body);
      const d = await post<Driver>("/drivers", body);
      try {
        const r = await get<{ link: string }>(`/drivers/${d.id}/invite`);
        navigator.clipboard?.writeText(r.link);
        toast.success(t("Водія додано"), { description: t("Посилання-запрошення скопійовано") });
      } catch { toast.success(t("Водія додано")); }
      return d;
    },
    onSuccess: () => { if (isEdit) toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати водія") : t("Новий водій")}>
      <div className="space-y-3">
        <div><Label>{t("Ім'я")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Авто (необов'язково)")}</Label><Input value={vehicle} onChange={e => setVehicle(e.target.value)} /></div>
        <div><Label>{t("Місткість, пасажирів (для розрахунку заборів)")}</Label><Input type="number" min={1} value={seats} onChange={e => setSeats(e.target.value)} placeholder="8" /></div>
        <div><Label>{t("Телефон (необов'язково)")}</Label><Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+48…" /></div>
        {!isEdit && <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500"><Copy className="mr-1 inline h-3 w-3" />{t("Після створення посилання-запрошення скопіюється автоматично. Надішліть його водієві — щойно він натисне «Старт», отримуватиме сповіщення.")}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => name.trim() && save.mutate()}>{isEdit ? t("Зберегти") : t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}
