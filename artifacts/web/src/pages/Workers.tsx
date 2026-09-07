import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, UserX, UserCheck, Link2, Trash2, FileText } from "lucide-react";
import { toast } from "sonner";
import { get, post, del, type Worker, type Factory, type Company, type Position, type WorkerContractsBrief } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Empty, Modal } from "../components/ui";
import { WorkerModal } from "../components/WorkerModal";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";
import { LEGAL_STATUSES, LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import { LEGALITY_STATUSES, LEGALITY_LABEL, LEGALITY_DOT, daysUntil } from "../lib/legality";
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
  // Легалізація за документами (движок worker_legality) — окремо від старого
  // поля «Форма легалізації» (legFilter вище, не чіпати).
  const [docLegFilter, setDocLegFilter] = useState("");
  // Умова (контракти з модуля підпису): signed/pending/none/expired — по w.contracts.umowa.
  const [umowaFilter, setUmowaFilter] = useState("");
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState<Worker | null>(null);
  const [adding, setAdding] = useState(false);
  const [firing, setFiring] = useState<Worker | null>(null);
  const [scanInviteLink, setScanInviteLink] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["workers"] });
  const fire = useMutation({
    mutationFn: (v: { id: number; offerReport: boolean; date?: string }) => post<{ reportOffered?: boolean }>(`/workers/${v.id}/fire`, { offerReport: v.offerReport, date: v.date }),
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
  // Живий онбординг — «Додати» шле на скан+анкету замість ручної форми
  // (WorkerModal лишається другорядним фолбеком, кнопка «...або вручну»).
  const scanInvite = useMutation({
    mutationFn: () => post<{ link: string }>("/workers/scan-invite"),
    onSuccess: (d) => setScanInviteLink(d.link),
    onError: (e: any) => toast.error(e.message),
  });
  // Масове запрошення ІСНУЮЧИХ працівників на подачу паспорта+анкети —
  // дзеркалить inviteAll: одна мутація на кожного, підсумковий toast.
  const docsInviteAll = useMutation({
    mutationFn: async (targets: Worker[]) => {
      let notified = 0;
      for (const w of targets) {
        const r = await post<{ notified: boolean }>(`/workers/${w.id}/docs-invite`);
        if (r.notified) notified++;
      }
      return { total: targets.length, notified };
    },
    onSuccess: (r) => toast.success(t("Запрошення надіслано {notified} з {total}", { notified: r.notified, total: r.total })),
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
    (!docLegFilter || (docLegFilter === "none" ? !w.legality : w.legality?.overall === docLegFilter)) &&
    (!umowaFilter || (() => {
      const um = w.contracts?.umowa ?? null;
      if (umowaFilter === "none") return !um;
      if (umowaFilter === "expired") return !!um?.expired;
      if (umowaFilter === "signed") return um?.status === "signed" && !um.expired;
      if (umowaFilter === "pending") return !!um && !um.expired && um.status !== "signed";
      return true;
    })()) &&
    (!expiringOnly || (() => { const d = daysUntil(w.legality?.nextExpiryAt); return d != null && d <= 30; })()) &&
    (!q || w.fullName.toLowerCase().includes(q.toLowerCase()) || (w.workerCode ?? "").includes(q))
  ), [workers, q, facFilter, coFilter, posFilter, legFilter, natFilter, stud26Only, docLegFilter, umowaFilter, expiringOnly, showInactive]);

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Працівники")} subtitle={`${filtered.length} ${showInactive ? t("звільнених") : t("активних")}`}
        action={canEdit ? (
          <div className="flex items-center gap-3">
            <Button loading={scanInvite.isPending} onClick={() => scanInvite.mutate()}><Plus className="h-4 w-4" /> {t("Додати")}</Button>
            <button onClick={() => setAdding(true)} className="text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline">{t("...або вручну")}</button>
          </div>
        ) : undefined} />

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
          <option value="">{t("Форма (сводна): всі")}</option>
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
        <Select value={docLegFilter} onChange={e => setDocLegFilter(e.target.value)} className="w-52">
          <option value="">{t("Легалізація: всі")}</option>
          <option value="none">{t("Ще не рахувалось")}</option>
          {LEGALITY_STATUSES.map(s => <option key={s} value={s}>{t(LEGALITY_LABEL[s])}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={expiringOnly} onChange={e => setExpiringOnly(e.target.checked)} /> {t("Строк ≤ 30 днів")}
        </label>
        <Select value={umowaFilter} onChange={e => setUmowaFilter(e.target.value)} className="w-44">
          <option value="">{t("Умова: всі")}</option>
          <option value="signed">{t("є підписана")}</option>
          <option value="pending">{t("на підписі")}</option>
          <option value="none">{t("без umowy")}</option>
          <option value="expired">{t("прострочена")}</option>
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> {t("Звільнені")}
        </label>
        {(() => { const targets = filtered.filter(w => w.isActive && !w.telegramId); return targets.length > 0 ? (
          <Button variant="secondary" loading={inviteAll.isPending} onClick={() => inviteAll.mutate(targets)}>
            <Link2 className="h-4 w-4" /> {t("Скопіювати всі посилання")} ({targets.length})
          </Button>
        ) : null; })()}
        {(() => { const targets = filtered.filter(w => w.isActive); return targets.length > 0 ? (
          <Button variant="secondary" loading={docsInviteAll.isPending} onClick={() => docsInviteAll.mutate(targets)}>
            <FileText className="h-4 w-4" /> {t("Запросити на подачу документів")} ({targets.length})
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
                  <td className="px-4 py-2.5"><LegalizationCell w={w} /></td>
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

      {firing && <FireModal worker={firing} loading={fire.isPending} onClose={() => setFiring(null)} onFire={(offerReport, date) => fire.mutate({ id: firing.id, offerReport, date })} />}

      {scanInviteLink && <ScanInviteModal link={scanInviteLink} onClose={() => setScanInviteLink(null)} />}
    </>
  );
}

// Підсвітка проблемних рядків: не зголошений (oczekuje) → rose; без форми
// легалізації → amber (не студент, «не оформлений») / yellow (студент — форму
// просто не заповнили). Дзеркало логіки unlegalized в Обліку годин.
// Підсвітка — за ефективним статусом виплат (за документами або ручним полем), як у сводній
const rowTint = (w: Worker) => {
  const ls = w.effectiveLegalStatus !== undefined ? w.effectiveLegalStatus : w.legalStatus;
  return ls === "oczekuje" ? "bg-rose-50/60 hover:bg-rose-50"
    : !ls ? (w.student ? "bg-yellow-50/60 hover:bg-yellow-50" : "bg-amber-50/60 hover:bg-amber-50")
    : "hover:bg-slate-50";
};

// Одна колонка «Легалізація» (відгук власника 03.09.2026: «легалізація док і
// легалізація — одне й те саме, лиши одну колонку») — три рядки зверху вниз:
// 1) світлофор за документами (движок worker_legality) — головний індикатор;
// 2) дрібний бейдж старої форми (legalStatus) — досі рахує сводні, не чіпати;
// 3) дрібні чипи умов (umowa/комплект) з модуля підпису.
function LegalizationCell({ w }: { w: Worker }) {
  const t = useT();
  const leg = w.legality;
  const dLeft = daysUntil(leg?.nextExpiryAt);
  const expiryCls = dLeft != null && dLeft < 0 ? "font-medium text-rose-600" : dLeft != null && dLeft <= 30 ? "font-medium text-amber-600" : "text-slate-400";
  const s = w.legalStatus as LegalStatus | null | undefined;
  const known = !!s && (LEGAL_STATUSES as readonly string[]).includes(s);
  const badge = known ? LEGAL_BADGE[s as LegalStatus] : null;
  const um = w.contracts?.umowa ?? null;
  const pkg = w.contracts?.package ?? null;
  return (
    <div className="space-y-0.5 py-0.5">
      {leg ? (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={`h-2 w-2 shrink-0 rounded-full ${LEGALITY_DOT[leg.overall]}`} title={t(LEGALITY_LABEL[leg.overall])} />
          <span className="text-xs text-slate-600">{t(LEGALITY_LABEL[leg.overall])}</span>
          {leg.nextExpiryAt && <span className={`text-xs ${expiryCls}`}>· {t("{n} дн.", { n: dLeft ?? "—" })}</span>}
          {leg.reviewRequired && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{t("перевірка")}</span>}
        </div>
      ) : <span className="text-xs text-slate-300">—</span>}
      {s && (
        <div className="text-[11px]" title={t("Форма для сводної (вручну)")}>
          {known
            ? <span className={`inline-block rounded px-1 font-semibold ${badge ? badge.cls : "bg-slate-100 text-slate-600"}`}>{badge ? badge.short : "ZUS"}</span>
            : <span className="text-slate-500">{s}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 text-[11px]" title={um?.factoryName ?? undefined}>
        {umowaChip(t, um)}
        {packageChip(t, pkg)}
      </div>
    </div>
  );
}

const fmtContractDate = (d: string | null) => d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "";

function umowaChip(t: ReturnType<typeof useT>, um: WorkerContractsBrief["umowa"]) {
  if (!um) return <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">{t("без umowy")}</span>;
  if (um.expired) return <span className="rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700">{t("umowa прострочена {date}", { date: fmtContractDate(um.dateTo) })}</span>;
  if (um.status === "signed") return <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">{t("umowa ✓ до {date}", { date: fmtContractDate(um.dateTo) })}</span>;
  return <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">{t("umowa на підписі")}</span>;
}

function packageChip(t: ReturnType<typeof useT>, pkg: WorkerContractsBrief["package"]) {
  if (!pkg) return <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">{t("без комплекту")}</span>;
  if (pkg.status === "signed") return <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">{t("комплект ✓")}</span>;
  return <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">{t("комплект на підписі")}</span>;
}

// Лінк на скан+анкету для НОВОГО кандидата (POST /workers/scan-invite) —
// відкрий на телефоні кандидата, профіль створиться сам після сканування.
function ScanInviteModal({ link, onClose }: { link: string; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open onClose={onClose} title={t("Запросити кандидата на скан+анкету")}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{t("Відкрий це посилання на телефоні кандидата — камера й анкета. Лінк дійсний 30 хвилин.")}</p>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-slate-600">{link}</code>
          <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(link); toast.success(t("Скопійовано")); }}>{t("Копіювати")}</Button>
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>{t("Закрити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Firing confirm with the "offer a farewell report" option: the leaver gets inline
// month buttons in the bot and can submit within 30 days after firing.
export function FireModal({ worker, loading, onClose, onFire }: { worker: { fullName: string; telegramId: string | null }; loading: boolean; onClose: () => void; onFire: (offerReport: boolean, date: string) => void }) {
  const t = useT();
  const [offerReport, setOfferReport] = useState(!!worker.telegramId);
  const [date, setDate] = useState(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }));
  return (
    <Modal open onClose={onClose} title={t("Звільнити {name}?", { name: worker.fullName })}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("Працівник стане неактивним і не потраплятиме в графік.")}</p>
        <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{t("Дата звільнення (можна минулим числом)")}</span><input type="date" value={date} onChange={e => setDate(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-sm" /></label>
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
          <Button variant="danger" loading={loading} disabled={!date} onClick={() => onFire(offerReport && !!worker.telegramId, date)}>
            <UserX className="h-4 w-4" /> {t("Звільнити")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

