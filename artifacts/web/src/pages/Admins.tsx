import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Link2, KeyRound, Copy, Shield } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, type Me, type RoleDef } from "../lib/api";
import { CAP_KEYS, CAP_LABEL, PAGE_KEYS, PAGE_LABEL, NOTIFY_KEYS, NOTIFY_LABEL, type Capability, type NotifyType } from "../lib/roles";
import { Card, Spinner, Badge, Empty, Select, Button, Modal, Input, Label } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";
import { SearchBox, matchesQuery } from "../components/SearchBox";
import { useSessionState } from "../lib/nav";
import { ScopePicker, scopeSummary, type ScopeValue } from "../components/ScopePicker";

interface AdminRow {
  id: number; name: string; username: string | null; role: string;
  isMain: boolean; hasWebLogin: boolean; hasTelegram: boolean; pending: boolean; inviteLink: string | null;
  scopeCities: string[]; scopeFactoryIds: number[]; canInviteRoles: string[]; invitedBy: number | null;
}

// Головний адмін — користувачі й ролі; делегат запрошень (admins.can_invite_roles) — лише свої запрошення.
export default function Admins({ me }: { me: Me }) {
  return me.isMain ? <AdminsMain me={me} /> : <MyInvites me={me} />;
}

function AdminsMain({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canManage = me.isMain; // only the head admin assigns roles / manages users
  const { data, isLoading } = useQuery<AdminRow[]>({ queryKey: ["admins"], queryFn: () => get("/admins") });
  const { data: roles = [] } = useQuery<RoleDef[]>({ queryKey: ["roles"], queryFn: () => get("/roles") });
  const roleLabel = (key: string) => roles.find(r => r.key === key)?.label ?? key;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminRow | null>(null);
  const [invite, setInvite] = useState<{ name: string; link: string } | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["admins"] });
  const [q, setQ] = useSessionState("admins.q", ""); // пошук по імені/логіну/ролі
  const shown = (data ?? []).filter(a => matchesQuery(q, a.name, a.username, roleLabel(a.role)));

  const setRole = useMutation({
    mutationFn: (v: { id: number; role: string }) => patch(`/admins/${v.id}`, { role: v.role }),
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
        <p className="text-sm text-slate-500">{t("Ви:")} <span className="font-medium text-slate-700">{me.name}</span> · {me.roleLabel}{me.isMain && " 👑"}</p>
        {canManage && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати користувача")}</Button>}
      </div>
      {!canManage && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          {t("Лише головний адміністратор 👑 може додавати користувачів і призначати ролі. Тут — перегляд.")}
        </div>
      )}

      <div className="mb-4"><SearchBox value={q} onChange={setQ} placeholder={t("Пошук: імʼя, логін, роль")} /></div>
      <Card className="overflow-x-auto">
        {!data?.length ? <Empty>{t("Немає користувачів")}</Empty> : !shown.length ? <Empty>{t("Нічого не знайдено")}</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Імʼя")}</th><th className="px-4 py-2.5">{t("Веб-логін")}</th><th className="px-4 py-2.5">{t("Статус")}</th><th className="px-4 py-2.5">{t("Роль")}</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map(a => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{a.name}{a.isMain && " 👑"}</td>
                  <td className="px-4 py-2.5">{a.username ? <span className="font-mono text-slate-600">{a.username}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">
                    {a.pending ? <Badge color="amber">{t("очікує приєднання")}</Badge>
                      : a.hasWebLogin ? <Badge color="green">{t("активний")}</Badge>
                      : <Badge color="slate">{t("без веб-логіну")}</Badge>}
                  </td>
                  <td className="px-4 py-2.5">
                    {a.isMain ? <Badge color="red">👑 {roleLabel(a.role)}</Badge>
                      : canManage ? (
                        <Select className="w-40" value={a.role} disabled={setRole.isPending}
                          onChange={e => setRole.mutate({ id: a.id, role: e.target.value })}>
                          {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                        </Select>
                      ) : <Badge color="slate">{roleLabel(a.role)}</Badge>}
                    {!a.isMain && a.role !== "owner" && (a.scopeCities.length > 0 || a.scopeFactoryIds.length > 0) && (
                      <div className="mt-1 text-xs text-slate-500">{scopeSummary(a.scopeCities, a.scopeFactoryIds, t)}</div>
                    )}
                    {a.canInviteRoles.length > 0 && <div className="mt-0.5 text-xs text-slate-400">✉️ {t("запрошує:")} {a.canInviteRoles.map(roleLabel).join(", ")}</div>}
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

      {canManage && <RolesManager roles={roles} confirm={confirm} />}

      {adding && <AddUser roles={roles} onClose={() => setAdding(false)} onCreated={(name, link) => { inv(); setAdding(false); setInvite({ name, link }); }} />}
      {editing && <EditUser admin={editing} roles={roles} onClose={() => setEditing(null)} onSaved={() => { inv(); setEditing(null); }} />}
      {invite && <InviteModal name={invite.name} link={invite.link} onClose={() => setInvite(null)} />}
    </>
  );
}

// ─── Roles & accesses (head admin only) ───────────────────────────────────────
function RolesManager({ roles, confirm }: { roles: RoleDef[]; confirm: ReturnType<typeof useConfirm> }) {
  const t = useT();
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["roles"] });
  const [editing, setEditing] = useState<RoleDef | null>(null);
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/roles/${id}`),
    onSuccess: () => { toast.success(t("Роль видалено")); inv(); }, onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className="mt-6 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800"><Shield className="h-4 w-4 text-slate-400" /> {t("Ролі та доступи")}</h3>
          <p className="mt-0.5 text-sm text-slate-500">{t("Створюйте власні ролі й задавайте, які сторінки та дії їм дозволені.")}</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Нова роль")}</Button>
      </div>
      <div className="space-y-2">
        {roles.map(r => (
          <div key={r.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-700">{r.label}</span>
                {r.isSystem && <Badge color="slate">{t("системна")}</Badge>}
                {r.key === "owner" && <Badge color="red">👑</Badge>}
                {r.inUse > 0 && <span className="text-xs text-slate-400">· {r.inUse} {t("корист.")}</span>}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-400">
                {r.key === "owner" ? t("Повний доступ (незмінна)") : `${r.pages.length} ${t("стор.")} · ${r.caps.length} ${t("дій")}`}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button onClick={() => setEditing(r)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={r.key === "owner" ? t("Сповіщення") : t("Редагувати")}><Pencil className="h-4 w-4" /></button>
              {!r.isSystem && <button onClick={async () => { if (await confirm({ title: t("Видалити роль «{name}»?", { name: r.label }), danger: true, confirmText: t("Видалити") })) remove.mutate(r.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-4 w-4" /></button>}
            </div>
          </div>
        ))}
      </div>
      {(adding || editing) && <RoleEditor role={editing} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { inv(); setAdding(false); setEditing(null); }} />}
    </Card>
  );
}

function RoleEditor({ role, onClose, onSaved }: { role: RoleDef | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const isOwner = role?.key === "owner";
  const [label, setLabel] = useState(role?.label ?? "");
  const [pages, setPages] = useState<Set<string>>(new Set(role?.pages ?? ["/"]));
  const [caps, setCaps] = useState<Set<string>>(new Set(role?.caps ?? []));
  const [notify, setNotify] = useState<Set<string>>(new Set(role?.notify ?? []));
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); setter(next);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = isOwner
        ? { notify: [...notify] }
        : { label: label.trim(), pages: [...pages], caps: [...caps], notify: [...notify] };
      return role ? patch(`/roles/${role.id}`, body) : post("/roles", body);
    },
    onSuccess: () => { toast.success(role ? t("Роль оновлено") : t("Роль створено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={role ? (isOwner ? t("Сповіщення ролі «Власник»") : t("Редагувати роль")) : t("Нова роль")}>
      <div className="space-y-4">
        {isOwner ? (
          <p className="text-sm text-slate-500">{t("Повний доступ (незмінна) — можна налаштувати лише сповіщення бота.")}</p>
        ) : (
          <>
            <div><Label>{t("Назва ролі")}</Label><Input value={label} onChange={e => setLabel(e.target.value)} placeholder={t("напр. Координатор складу")} autoFocus /></div>
            <div>
              <Label>{t("Доступ до сторінок")}</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {PAGE_KEYS.map(p => (
                  <label key={p} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={pages.has(p)} onChange={() => toggle(pages, setPages, p)} />
                    {t(PAGE_LABEL[p] ?? p)}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label>{t("Дозволені дії")}</Label>
              <div className="space-y-1.5">
                {CAP_KEYS.map(c => (
                  <label key={c} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={caps.has(c)} onChange={() => toggle(caps, setCaps, c)} />
                    {t(CAP_LABEL[c as Capability])}
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
        <div>
          <Label>{t("Сповіщення бота")}</Label>
          <div className="space-y-1.5">
            {NOTIFY_KEYS.map(n => (
              <label key={n} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={notify.has(n)} onChange={() => toggle(notify, setNotify, n)} />
                {t(NOTIFY_LABEL[n as NotifyType])}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!isOwner && !label.trim()} onClick={() => (isOwner || label.trim()) && save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function AddUser({ roles, onClose, onCreated }: { roles: RoleDef[]; onClose: () => void; onCreated: (name: string, link: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(roles.find(r => r.key !== "owner")?.key ?? "scheduler");
  const [scope, setScope] = useState<ScopeValue>({ cities: [], factoryIds: [] });
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () => post<{ inviteLink: string }>("/admins", { name, role, scopeCities: scope.cities, scopeFactoryIds: scope.factoryIds, canInviteRoles: inviteRoles }),
    onSuccess: (r) => { navigator.clipboard?.writeText(r.inviteLink); onCreated(name, r.inviteLink); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Новий користувач")} size="lg">
      <div className="space-y-3">
        <div><Label>{t("Імʼя")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Роль")}</Label>
          <Select value={role} onChange={e => setRole(e.target.value)}>
            {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>
        </div>
        <AccessFields role={role} roles={roles} scope={scope} onScope={setScope} inviteRoles={inviteRoles} onInviteRoles={setInviteRoles} />
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500"><Copy className="mr-1 inline h-3 w-3" />{t("Після створення скопіюється посилання-запрошення. Надішліть його людині в Telegram.")}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => name.trim() && save.mutate()}>{t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditUser({ admin, roles, onClose, onSaved }: { admin: AdminRow; roles: RoleDef[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState(admin.name);
  const [role, setRole] = useState<string>(admin.role);
  const [scope, setScope] = useState<ScopeValue>({ cities: admin.scopeCities, factoryIds: admin.scopeFactoryIds });
  const [inviteRoles, setInviteRoles] = useState<string[]>(admin.canInviteRoles);
  const save = useMutation({
    mutationFn: () => patch(`/admins/${admin.id}`, { name, canInviteRoles: inviteRoles,
      ...(admin.isMain ? {} : { role, scopeCities: role === "owner" ? [] : scope.cities, scopeFactoryIds: role === "owner" ? [] : scope.factoryIds }) }),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); }, onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Редагувати користувача")} size="lg">
      <div className="space-y-3">
        <div><Label>{t("Імʼя")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Роль")}</Label>
          <Select value={role} disabled={admin.isMain} onChange={e => setRole(e.target.value)}>
            {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>
          {admin.isMain && <p className="mt-1 text-xs text-slate-400">{t("Головний власник — роль незмінна.")}</p>}
        </div>
        <AccessFields role={admin.isMain ? "owner" : role} roles={roles} scope={scope} onScope={setScope} inviteRoles={inviteRoles} onInviteRoles={setInviteRoles} />
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

// Доступ по містах/фабриках + право запрошувати (лише головний адмін заповнює).
// Для owner скоуп не діє (повний доступ у коді) — пікер ховається.
function AccessFields({ role, roles, scope, onScope, inviteRoles, onInviteRoles }: {
  role: string; roles: RoleDef[]; scope: ScopeValue; onScope: (v: ScopeValue) => void; inviteRoles: string[]; onInviteRoles: (v: string[]) => void;
}) {
  const t = useT();
  const invitable = roles.filter(r => r.key !== "owner");
  return (
    <>
      {role !== "owner" && <div><Label>{t("Доступ по містах і фабриках")}</Label><ScopePicker value={scope} onChange={onScope} /></div>}
      <div>
        <Label>{t("Може запрошувати людей на ролі")}</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {invitable.map(r => (
            <label key={r.key} className="flex cursor-pointer items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={inviteRoles.includes(r.key)}
                onChange={() => onInviteRoles(inviteRoles.includes(r.key) ? inviteRoles.filter(k => k !== r.key) : [...inviteRoles, r.key])} />
              {r.label}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-400">{t("Запрошених бачить і перевидає лише сам; доступ нового — не ширший за власний.")}</p>
      </div>
    </>
  );
}

// ─── Делегат: мої запрошення ──────────────────────────────────────────────────
interface InviteRow { id: number; name: string; role: string; pending: boolean; hasWebLogin: boolean; inviteLink: string | null; scopeCities: string[]; scopeFactoryIds: number[] }
interface InvitesResp { roles: { key: string; label: string }[]; myScope: ScopeValue | null; invites: InviteRow[] }

function MyInvites({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<InvitesResp>({ queryKey: ["admin-invites"], queryFn: () => get("/admin-invites") });
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<{ name: string; link: string } | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["admin-invites"] });
  const roleLabel = (k: string) => data?.roles.find(r => r.key === k)?.label ?? k;
  const regen = useMutation({
    mutationFn: (a: InviteRow) => post<{ inviteLink: string }>(`/admin-invites/${a.id}/invite`).then(r => ({ r, a })),
    onSuccess: ({ r, a }) => { navigator.clipboard?.writeText(r.inviteLink); setInvite({ name: a.name, link: r.inviteLink }); },
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/admin-invites/${id}`),
    onSuccess: () => { toast.success(t("Запрошення відкликано")); inv(); }, onError: (e: any) => toast.error(e.message),
  });
  if (isLoading || !data) return <Spinner />;
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-500">{t("Ви:")} <span className="font-medium text-slate-700">{me.name}</span> · {me.roleLabel}</p>
        {data.roles.length > 0 && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Запросити")}</Button>}
      </div>
      <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
        {t("Ви можете запрошувати людей на ролі:")} <b>{data.roles.map(r => r.label).join(", ") || "—"}</b>.
        {data.myScope && <> {t("Доступ запрошених — у межах вашого:")} {scopeSummary(data.myScope.cities, data.myScope.factoryIds, t)}.</>}
      </div>
      <Card className="overflow-x-auto">
        {!data.invites.length ? <Empty>{t("Ви ще нікого не запросили")}</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Імʼя")}</th><th className="px-4 py-2.5">{t("Роль")}</th><th className="px-4 py-2.5">{t("Доступ")}</th><th className="px-4 py-2.5">{t("Статус")}</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.invites.map(a => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{a.name}</td>
                  <td className="px-4 py-2.5"><Badge color="slate">{roleLabel(a.role)}</Badge></td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{scopeSummary(a.scopeCities, a.scopeFactoryIds, t)}</td>
                  <td className="px-4 py-2.5">{a.pending ? <Badge color="amber">{t("очікує приєднання")}</Badge> : a.hasWebLogin ? <Badge color="green">{t("активний")}</Badge> : <Badge color="slate">{t("без веб-логіну")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-right">
                    {a.pending && (
                      <div className="flex justify-end gap-1">
                        <button onClick={() => regen.mutate(a)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Посилання-запрошення")}><Link2 className="h-4 w-4" /></button>
                        <button onClick={async () => { if (await confirm({ title: t("Відкликати запрошення {name}?", { name: a.name }), danger: true, confirmText: t("Відкликати") })) remove.mutate(a.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Відкликати")}><Trash2 className="h-4 w-4" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adding && <InviteNew roles={data.roles} scoped={!!data.myScope} onClose={() => setAdding(false)} onCreated={(name, link) => { inv(); setAdding(false); setInvite({ name, link }); }} />}
      {invite && <InviteModal name={invite.name} link={invite.link} onClose={() => setInvite(null)} />}
    </>
  );
}

function InviteNew({ roles, scoped, onClose, onCreated }: { roles: { key: string; label: string }[]; scoped: boolean; onClose: () => void; onCreated: (name: string, link: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [role, setRole] = useState(roles[0]?.key ?? "");
  const [scope, setScope] = useState<ScopeValue>({ cities: [], factoryIds: [] });
  const scopeEmpty = !scope.cities.length && !scope.factoryIds.length;
  const save = useMutation({
    mutationFn: () => post<{ inviteLink: string }>("/admin-invites", { name, role, scopeCities: scope.cities, scopeFactoryIds: scope.factoryIds }),
    onSuccess: (r) => { navigator.clipboard?.writeText(r.inviteLink); onCreated(name, r.inviteLink); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Запросити людину")} size="lg">
      <div className="space-y-3">
        <div><Label>{t("Імʼя")}</Label><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
        <div><Label>{t("Роль")}</Label>
          <Select value={role} onChange={e => setRole(e.target.value)}>{roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</Select>
        </div>
        <div><Label>{t("Доступ по містах і фабриках")}</Label><ScopePicker value={scope} onChange={setScope} allowAll={!scoped} /></div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500"><Copy className="mr-1 inline h-3 w-3" />{t("Після створення скопіюється посилання-запрошення. Надішліть його людині в Telegram.")}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!name.trim() || !role || (scoped && scopeEmpty)} onClick={() => save.mutate()}>{t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}
