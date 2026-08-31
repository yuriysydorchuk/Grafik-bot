import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, UserX, UserCheck, Link2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { get, post, del, type Worker, type Factory, type Company, type Position } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Empty, Modal } from "../components/ui";
import { WorkerModal } from "../components/WorkerModal";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";
import { LEGAL_STATUSES, LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import { NATIONALITIES, NatFlag } from "../lib/nationality";

export default function Workers() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const isOwner = me?.role === "owner";
  const canEdit = can(me, "editData"); // viewWorkers-only (бухгалтерія) — лише перегляд, без дій
  const { data: workers, isLoading } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: () => get("/workers") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const { data: positions = [] } = useQuery<Position[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const [q, setQ] = useState("");
  const [facFilter, setFacFilter] = useState("");
  const [coFilter, setCoFilter] = useState("");
  const [posFilter, setPosFilter] = useState("");
  const [legFilter, setLegFilter] = useState("");
  const [natFilter, setNatFilter] = useState("");
  const [stud26Only, setStud26Only] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState<Worker | null>(null);
  const [adding, setAdding] = useState(false);
  const [firing, setFiring] = useState<Worker | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["workers"] });
  const fire = useMutation({
    mutationFn: (v: { id: number; offerReport: boolean }) => post<{ reportOffered?: boolean }>(`/workers/${v.id}/fire`, { offerReport: v.offerReport }),
    onSuccess: (r) => { invalidate(); setFiring(null); toast.success(t("Працівника звільнено"), { description: r?.reportOffered ? t("Пропозицію здати рапорт надіслано в бот") : undefined }); },
    onError: (e: any) => toast.error(e.message),
  });
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
    (!legFilter ||
      (legFilter === "problem" ? (!w.legalStatus || w.legalStatus === "oczekuje")
        : legFilter === "none" ? !w.legalStatus
        : w.legalStatus === legFilter)) &&
    (!natFilter || (natFilter === "none" ? !w.nationality : w.nationality === natFilter)) &&
    (!stud26Only || !!w.stud26) &&
    (!q || w.fullName.toLowerCase().includes(q.toLowerCase()) || (w.workerCode ?? "").includes(q))
  ), [workers, q, facFilter, coFilter, posFilter, legFilter, natFilter, stud26Only, showInactive]);

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Працівники")} subtitle={`${filtered.length} ${showInactive ? t("звільнених") : t("активних")}`}
        action={canEdit ? <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати")}</Button> : undefined} />

      {/* Filters pinned under the top bar while the table scrolls (md+ only) —
          same pattern as Schedule: top-[52px] = desktop top-bar height − 1px,
          -mx-8/px-8 undo the main padding so the opaque strip spans full width. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 md:sticky md:top-[52px] md:z-20 md:-mx-8 md:bg-page md:px-8 md:pb-3 md:pt-2 md:shadow-[0_6px_10px_-8px_rgb(15_23_42/0.12)]">
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
        <Select value={legFilter} onChange={e => setLegFilter(e.target.value)} className="w-48">
          <option value="">{t("Легалізація: всі")}</option>
          <option value="problem">{t("⚠️ Проблемні (без форми / не зголошені)")}</option>
          <option value="none">{t("Без форми")}</option>
          {LEGAL_STATUSES.map(s => <option key={s} value={s}>{t(LEGAL_LABEL[s])}</option>)}
        </Select>
        <Select value={natFilter} onChange={e => setNatFilter(e.target.value)} className="w-44">
          <option value="">{t("Національність: всі")}</option>
          <option value="none">{t("Без національності")}</option>
          {NATIONALITIES.map(n => <option key={n.value} value={n.value}>{n.flag} {t(n.label)}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={stud26Only} onChange={e => setStud26Only(e.target.checked)} /> {t("Студ. до 26")}
        </label>
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
          <table className="w-full min-w-150 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2.5">{t("Ім'я")}</th><th className="px-4 py-2.5">{t("Код")}</th><th className="px-4 py-2.5">{t("Посада")}</th><th className="px-4 py-2.5">{t("Легалізація")}</th><th className="px-4 py-2.5">{t("Фірма")}</th><th className="px-4 py-2.5">{t("Фабрика")}</th><th className="px-4 py-2.5">Telegram</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(w => (
                <tr key={w.id} className={rowTint(w)}>
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/workers/${w.id}`} className="text-red-700 underline-offset-2 hover:underline">{w.fullName}</Link>
                    {w.gender && <span className={`ml-1.5 font-semibold ${genderClass(w.gender)}`} title={w.gender === "male" ? t("Чоловік") : t("Жінка")}>{genderIcon(w.gender)}</span>}
                    <NatFlag value={w.nationality} className="ml-1.5 cursor-default" />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-500">{w.workerCode ?? "—"}</td>
                  <td className="px-4 py-2.5">{w.positionName ? <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(w.positionColor ?? "slate")}`}><span className={`h-1.5 w-1.5 rounded-full ${dotClass(w.positionColor ?? "slate")}`} />{w.positionName}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5"><LegalCell w={w} /></td>
                  <td className="px-4 py-2.5">{w.companyName ? <Badge color="blue">{w.companyName}</Badge> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">{w.factoryName ? <Badge color="red">{w.factoryName}</Badge> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5">{w.telegramId ? <Badge color="green">✓</Badge> : <Badge color="amber">{t("не приєднаний")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      {canEdit && <button onClick={() => setEdit(w)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-4 w-4" /></button>}
                      {canEdit && w.isActive && !w.telegramId && <button onClick={() => invite.mutate(w.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={t("Скопіювати посилання-запрошення")}><Link2 className="h-4 w-4" /></button>}
                      {canEdit && (w.isActive
                        ? <button onClick={() => setFiring(w)} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Звільнити")}><UserX className="h-4 w-4" /></button>
                        : <button onClick={() => restore.mutate(w.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600" title={t("Відновити")}><UserCheck className="h-4 w-4" /></button>)}
                      {canEdit && !w.isActive && isOwner && <button onClick={async () => { if (await confirm({ title: t("Видалити назавжди {name}?", { name: w.fullName }), message: t("Працівника та всю його історію буде видалено безповоротно."), danger: true, confirmText: t("Видалити") })) remove.mutate(w.id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити назавжди")}><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {(adding || edit) && <WorkerModal worker={edit} factories={factories} companies={companies} isOwner={isOwner} onClose={() => { setAdding(false); setEdit(null); }} onSaved={() => { invalidate(); setAdding(false); setEdit(null); }} />}

      {firing && <FireModal worker={firing} loading={fire.isPending} onClose={() => setFiring(null)} onFire={(offerReport) => fire.mutate({ id: firing.id, offerReport })} />}
    </>
  );
}

// Підсвітка проблемних рядків: не зголошений (oczekuje) → rose; без форми
// легалізації → amber (не студент, «не оформлений») / yellow (студент — форму
// просто не заповнили). Дзеркало логіки unlegalized в Обліку годин.
const rowTint = (w: Worker) =>
  w.legalStatus === "oczekuje" ? "bg-rose-50/60 hover:bg-rose-50"
  : !w.legalStatus ? (w.student ? "bg-yellow-50/60 hover:bg-yellow-50" : "bg-amber-50/60 hover:bg-amber-50")
  : "hover:bg-slate-50";

// Бейдж форми легалізації: канонічні статуси — компактні бейджі сводної
// (zus там свідомо без бейджа — у списку показуємо нейтральний «ZUS», щоб
// стандартний випадок не виглядав як «без форми»)
function LegalCell({ w }: { w: Worker }) {
  const t = useT();
  const s = w.legalStatus as LegalStatus | null | undefined;
  if (s && (LEGAL_STATUSES as readonly string[]).includes(s)) {
    const b = LEGAL_BADGE[s as LegalStatus];
    return <span title={t(LEGAL_LABEL[s as LegalStatus])} className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${b ? b.cls : "bg-slate-100 text-slate-600"}`}>{b ? b.short : "ZUS"}</span>;
  }
  if (s) return <span className="text-xs text-slate-500">{s}</span>; // legacy-статус поза каталогом — показуємо як є
  return w.student
    ? <span title={t("Студент — форма легалізації не заповнена")} className="inline-block rounded bg-yellow-100 px-1.5 py-0.5 text-[11px] font-semibold text-yellow-700">{t("без форми")}</span>
    : <span title={t("Не оформлений — без форми легалізації")} className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">{t("без форми")}</span>;
}

// Firing confirm with the "offer a farewell report" option: the leaver gets inline
// month buttons in the bot and can submit within 30 days after firing.
function FireModal({ worker, loading, onClose, onFire }: { worker: Worker; loading: boolean; onClose: () => void; onFire: (offerReport: boolean) => void }) {
  const t = useT();
  const [offerReport, setOfferReport] = useState(!!worker.telegramId);
  return (
    <Modal open onClose={onClose} title={t("Звільнити {name}?", { name: worker.fullName })}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("Працівник стане неактивним і не потраплятиме в графік.")}</p>
        <label className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${worker.telegramId ? "border-slate-200" : "border-slate-100 bg-slate-50 opacity-60"}`}>
          <input type="checkbox" className="mt-0.5" disabled={!worker.telegramId} checked={offerReport} onChange={e => setOfferReport(e.target.checked)} />
          <span>
            <span className="font-medium text-slate-700">{t("Запропонувати здати рапорт у боті")}</span>
            <span className="block text-xs text-slate-500">
              {worker.telegramId
                ? t("Працівник отримає кнопку «здати рапорт» за відпрацьований місяць — діє 30 днів")
                : t("працівник не підключений до бота")}
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button variant="danger" loading={loading} onClick={() => onFire(offerReport && !!worker.telegramId)}>
            <UserX className="h-4 w-4" /> {t("Звільнити")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

