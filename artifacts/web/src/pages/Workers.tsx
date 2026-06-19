import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, UserX, UserCheck, Link2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { get, post, del, type Worker, type Factory, type Company, type Position } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Empty } from "../components/ui";
import { WorkerModal } from "../components/WorkerModal";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";

export default function Workers() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const isOwner = me?.role === "owner";
  const { data: workers, isLoading } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: () => get("/workers") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: positions = [] } = useQuery<Position[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const [q, setQ] = useState("");
  const [facFilter, setFacFilter] = useState("");
  const [coFilter, setCoFilter] = useState("");
  const [posFilter, setPosFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState<Worker | null>(null);
  const [adding, setAdding] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["workers"] });
  const fire = useMutation({ mutationFn: (id: number) => post(`/workers/${id}/fire`), onSuccess: () => { invalidate(); toast.success(t("Працівника звільнено")); } });
  const restore = useMutation({ mutationFn: (id: number) => post(`/workers/${id}/restore`), onSuccess: () => { invalidate(); toast.success(t("Відновлено")); } });
  const remove = useMutation({ mutationFn: (id: number) => del(`/workers/${id}`), onSuccess: () => { invalidate(); toast.success(t("Працівника видалено")); }, onError: (e: any) => toast.error(e.message) });
  const invite = useMutation({
    mutationFn: (id: number) => get<{ link: string }>(`/workers/${id}/invite`),
    onSuccess: (d) => { navigator.clipboard?.writeText(d.link); toast.success(t("Посилання скопійовано"), { description: d.link }); },
    onError: (e: any) => toast.error(e.message),
  });
  const inviteAll = useMutation({
    mutationFn: async (targets: Worker[]) => {
      const lines = await Promise.all(targets.map(async w => {
        const { link } = await get<{ link: string }>(`/workers/${w.id}/invite`);
        return `${w.fullName}: ${link}`;
      }));
      return lines.join("\n");
    },
    onSuccess: (text, targets) => { navigator.clipboard?.writeText(text); toast.success(t("Скопійовано {n} посилань", { n: targets.length })); },
    onError: (e: any) => toast.error(e.message),
  });

  const filtered = useMemo(() => (workers ?? []).filter(w =>
    (showInactive ? !w.isActive : w.isActive) &&
    (!facFilter || String(w.factoryId) === facFilter) &&
    (!coFilter || String(w.companyId) === coFilter) &&
    (!posFilter || String(w.positionId) === posFilter) &&
    (!q || w.fullName.toLowerCase().includes(q.toLowerCase()) || (w.workerCode ?? "").includes(q))
  ), [workers, q, facFilter, coFilter, posFilter, showInactive]);

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Працівники")} subtitle={`${filtered.length} ${showInactive ? t("звільнених") : t("активних")}`}
        action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button>} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-50">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input placeholder={t("Пошук за іменем або кодом")} value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
        </div>
        <Select value={facFilter} onChange={e => setFacFilter(e.target.value)} className="w-44">
          <option value="">{t("Усі фабрики")}</option>
          {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
        <Select value={coFilter} onChange={e => setCoFilter(e.target.value)} className="w-40">
          <option value="">{t("Усі фірми")}</option>
          {companies.map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
        </Select>
        <Select value={posFilter} onChange={e => setPosFilter(e.target.value)} className="w-44">
          <option value="">{t("Усі посади")}</option>
          {positions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> {t("Звільнені")}
        </label>
        {(() => { const targets = filtered.filter(w => w.isActive && !w.telegramId); return targets.length > 0 ? (
          <Button variant="secondary" loading={inviteAll.isPending} onClick={() => inviteAll.mutate(targets)}>
            <Link2 className="h-4 w-4" /> {t("Скопіювати всі посилання")} ({targets.length})
          </Button>
        ) : null; })()}
      </div>

      <Card className="overflow-x-auto">
        {filtered.length === 0 ? <Empty>{t("Нікого не знайдено")}</Empty> : (
          <table className="w-full min-w-130 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Ім'я")}</th><th className="px-4 py-2.5">{t("Код")}</th><th className="px-4 py-2.5">{t("Посада")}</th><th className="px-4 py-2.5">{t("Фірма")}</th><th className="px-4 py-2.5">{t("Фабрика")}</th><th className="px-4 py-2.5">Telegram</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(w => (
                <tr key={w.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/workers/${w.id}`} className="text-red-700 underline-offset-2 hover:underline">{w.fullName}</Link>
                    {w.gender && <span className={`ml-1.5 font-semibold ${genderClass(w.gender)}`} title={w.gender === "male" ? t("Чоловік") : t("Жінка")}>{genderIcon(w.gender)}</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-500">{w.workerCode ?? "—"}</td>
                  <td className="px-4 py-2.5">{w.positionName ? <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(w.positionColor ?? "slate")}`}><span className={`h-1.5 w-1.5 rounded-full ${dotClass(w.positionColor ?? "slate")}`} />{w.positionName}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">{w.companyName ? <Badge color="blue">{w.companyName}</Badge> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">{w.factoryName ? <Badge color="red">{w.factoryName}</Badge> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">{w.telegramId ? <Badge color="green">✓</Badge> : <Badge color="amber">{t("не приєднаний")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEdit(w)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-4 w-4" /></button>
                      {w.isActive && !w.telegramId && <button onClick={() => invite.mutate(w.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Скопіювати посилання-запрошення")}><Link2 className="h-4 w-4" /></button>}
                      {w.isActive
                        ? <button onClick={async () => { if (await confirm({ title: t("Звільнити {name}?", { name: w.fullName }), message: t("Працівник стане неактивним і не потраплятиме в графік."), danger: true, confirmText: t("Звільнити") })) fire.mutate(w.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Звільнити")}><UserX className="h-4 w-4" /></button>
                        : <button onClick={() => restore.mutate(w.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600" title={t("Відновити")}><UserCheck className="h-4 w-4" /></button>}
                      {!w.isActive && isOwner && <button onClick={async () => { if (await confirm({ title: t("Видалити назавжди {name}?", { name: w.fullName }), message: t("Працівника та всю його історію буде видалено безповоротно."), danger: true, confirmText: t("Видалити") })) remove.mutate(w.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити назавжди")}><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {(adding || edit) && <WorkerModal worker={edit} factories={factories} companies={companies} isOwner={isOwner} onClose={() => { setAdding(false); setEdit(null); }} onSaved={() => { invalidate(); setAdding(false); setEdit(null); }} />}
    </>
  );
}

