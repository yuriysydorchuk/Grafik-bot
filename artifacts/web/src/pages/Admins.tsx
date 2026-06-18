import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Link2, KeyRound, Copy } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, type Me } from "../lib/api";
import { ROLE_LABEL, type Role } from "../lib/roles";
import { Card, Spinner, Badge, Empty, Select, Button, Modal, Input, Label } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

interface AdminRow {
  id: number; name: string; username: string | null; role: Role;
  isMain: boolean; hasWebLogin: boolean; hasTelegram: boolean; pending: boolean; inviteLink: string | null;
}

const ROLE_OPTS: { value: Role; label: string }[] = [
  { value: "owner", label: "Власник" }, { value: "scheduler", label: "Графікова" }, { value: "driver", label: "Водій" },
];

export default function Admins({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canManage = me.isMain; // only the head admin assigns roles / manages users
  const { data, isLoading } = useQuery<AdminRow[]>({ queryKey: ["admins"], queryFn: () => get("/admins") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminRow | null>(null);
  const [invite, setInvite] = useState<{ name: string; link: string } | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["admins"] });

  const setRole = useMutation({
    mutationFn: (v: { id: number; role: Role }) => patch(`/admins/${v.id}`, { role: v.role }),
    onSuccess: () => { toast.success(t("Роль оновлено")); inv(); }, onError: (e: any) => toast.error(e.message),
  });
  const regenInvite = useMutation({
    mutationFn: (a: AdminRow) => post<{ inviteLink: string }>(`/admins/${a.id}/invite`).then(r => ({ r, a })),
    onSuccess: ({ r, a }) => { navigator.clipboard?.writeText(r.inviteLink); setInvite({ name: a.name, link: r.inviteLink }); },
    onError: (e: any) => toast.error(e.message),
  });
  const resetWeb = useMutation({
    mutationFn: (id: number) => post(`/admins/${id}/reset-web`),
    onSuccess: () => { toast.success(t("Веб-доступ скинуто — користувач задасть новий у боті")); inv(); }, onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/admins/${id}`),
    onSuccess: () => { toast.success(t("Видалено")); inv(); }, onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Spinner />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">{t("Ви:")} <span className="font-medium text-slate-700">{me.name}</span> · {t(ROLE_LABEL[me.role])}{me.isMain && " 👑"}</p>
        {canManage && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати користувача")}</Button>}
      </div>
      {!canManage && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          {t("Лише головний адміністратор 👑 може додавати користувачів і призначати ролі. Тут — перегляд.")}
        </div>
      )}

      <Card className="overflow-x-auto">
        {!data?.length ? <Empty>{t("Немає користувачів")}</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Імʼя")}</th><th className="px-4 py-2.5">{t("Веб-логін")}</th><th className="px-4 py-2.5">{t("Статус")}</th><th className="px-4 py-2.5">{t("Роль")}</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map(a => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{a.name}{a.isMain && " 👑"}</td>
                  <td className="px-4 py-2.5">{a.username ? <span className="font-mono text-slate-600">{a.username}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">
                    {a.pending ? <Badge color="amber">{t("очікує приєднання")}</Badge>
                      : a.hasWebLogin ? <Badge color="green">{t("активний")}</Badge>
                      : <Badge color="slate">{t("без веб-логіну")}</Badge>}
                  </td>
                  <td className="px-4 py-2.5">
                    {a.isMain ? <Badge color="red">👑 {t("Власник")}</Badge>
                      : canManage ? (
                        <Select className="w-36" value={a.role} disabled={setRole.isPending}
                          onChange={e => setRole.mutate({ id: a.id, role: e.target.value as Role })}>
                          {ROLE_OPTS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                        </Select>
                      ) : <Badge color="slate">{t(ROLE_LABEL[a.role])}</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        <button onClick={() => setEditing(a)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-4 w-4" /></button>
                        {a.pending && <button onClick={() => regenInvite.mutate(a)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Посилання-запрошення")}><Link2 className="h-4 w-4" /></button>}
                        {a.hasWebLogin && !a.isMain && <button onClick={async () => { if (await confirm({ title: t("Скинути веб-доступ {name}?", { name: a.name }), message: t("Логін і пароль буде стерто; користувач задасть нові у боті."), confirmText: t("Скинути") })) resetWeb.mutate(a.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600" title={t("Скинути веб-доступ")}><KeyRound className="h-4 w-4" /></button>}
                        {!a.isMain && <button onClick={async () => { if (await confirm({ title: t("Видалити {name}?", { name: a.name }), danger: true, confirmText: t("Видалити") })) remove.mutate(a.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        <div className="mb-1 font-medium text-slate-700">{t("Як це працює")}</div>
        <ul className="list-disc space-y-0.5 pl-5">
          <li>{t("Додати користувача → оберіть роль → скопіюйте посилання-запрошення і надішліть людині.")}</li>
          <li>{t("Людина відкриває посилання в Telegram, приєднується і задає логін/пароль.")}</li>
          <li>{t("Вхід — двофакторний: після логіну+паролю бот надсилає 6-значний код у Telegram.")}</li>
        </ul>
        <div className="mt-2 text-xs">{t("Ролі: Власник — повний доступ; Графікова — усе, крім фінансів і користувачів; Водій — лайв, графіки (перегляд), поїздки, призначення водіїв.")}</div>
      </div>

      {adding && <AddUser onClose={() => setAdding(false)} onCreated={(name, link) => { inv(); setAdding(false); setInvite({ name, link }); }} />}
      {editing && <EditUser admin={editing} onClose={() => setEditing(null)} onSaved={() => { inv(); setEditing(null); }} />}
      {invite && <InviteModal name={invite.name} link={invite.link} onClose={() => setInvite(null)} />}
    </>
  );
}

function AddUser({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, link: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("scheduler");
  const save = useMutation({
    mutationFn: () => post<{ inviteLink: string }>("/admins", { name, role }),
    onSuccess: (r) => { navigator.clipboard?.writeText(r.inviteLink); onCreated(name, r.inviteLink); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Новий користувач")}>
      <div className="space-y-3">
        <div><Label>{t("Імʼя")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Роль")}</Label>
          <Select value={role} onChange={e => setRole(e.target.value as Role)}>
            {ROLE_OPTS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
          </Select>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500"><Copy className="mr-1 inline h-3 w-3" />{t("Після створення скопіюється посилання-запрошення. Надішліть його людині в Telegram.")}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => name.trim() && save.mutate()}>{t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditUser({ admin, onClose, onSaved }: { admin: AdminRow; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState(admin.name);
  const [role, setRole] = useState<Role>(admin.role);
  const save = useMutation({
    mutationFn: () => patch(`/admins/${admin.id}`, { name, ...(admin.isMain ? {} : { role }) }),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); }, onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Редагувати користувача")}>
      <div className="space-y-3">
        <div><Label>{t("Імʼя")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Роль")}</Label>
          <Select value={role} disabled={admin.isMain} onChange={e => setRole(e.target.value as Role)}>
            {ROLE_OPTS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
          </Select>
          {admin.isMain && <p className="mt-1 text-xs text-slate-400">{t("Головний власник — роль незмінна.")}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => name.trim() && save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function InviteModal({ name, link, onClose }: { name: string; link: string; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open onClose={onClose} title={t("Запрошення — {name}", { name })}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{t("Посилання скопійовано. Надішліть його користувачу в Telegram — він приєднається і задасть логін/пароль.")}</p>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <code className="min-w-0 flex-1 truncate text-xs text-slate-600">{link}</code>
          <button onClick={() => { navigator.clipboard?.writeText(link); toast.success(t("Скопійовано")); }} className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-red-600" title={t("Копіювати")}><Copy className="h-4 w-4" /></button>
        </div>
        <div className="flex justify-end"><Button onClick={onClose}>{t("Готово")}</Button></div>
      </div>
    </Modal>
  );
}
