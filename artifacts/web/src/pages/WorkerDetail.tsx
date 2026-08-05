import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Building2, Factory as FactoryIcon, Send, Clock, CalendarCheck, UserX, Activity, Gift,
  FileText, Plus, Pencil, Trash2, ExternalLink, AlertTriangle, Briefcase, Users, Upload, Car, Cake, IdCard, Wallet, BadgePlus, History, Lock
} from "lucide-react";
import { can } from "../lib/roles";
import { LEGAL_STATUSES, LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import { get, post, patch, del, upload, type DocumentType, type WorkerDocument, type Worker, type Factory, type Company, type Gender } from "../lib/api";
import { Button, Card, Spinner, Badge, Empty, Modal, Input, Select, Label } from "../components/ui";
import { WorkerModal } from "../components/WorkerModal";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { badgeClass, dotClass, genderIcon, genderClass } from "../lib/colors";

interface WorkerProfile {
  id: number; fullName: string; workerCode: string | null; telegramId: string | null;
  factoryId: number | null; factoryName: string | null; companyId: number | null; companyName: string | null;
  positionId: number | null; positionName: string | null; positionColor: string | null;
  gender: string | null; fixedShift: string | null; selfTransport: boolean;
  status: string; isActive: boolean; createdAt: string; firedAt: string | null; language: string | null;
  hourlyRate?: number; hourlyRateNetto?: number | null; positionRate?: number | null; effectiveRate?: number; isStudent?: boolean; under26?: boolean;
  birthDate?: string | null; legalStatus?: string | null; notifyHours?: number | null;
  employmentStartDate?: string | null;
  agramFactory?: boolean; agramStazBonus?: boolean; agramCashBonus?: boolean;
  cashBonusFactory?: boolean; // не-Agram бонусна фабрика (LST): лише нал-бонус
  note?: string | null; payoutPrefKind?: string | null; payoutPrefValue?: number | null;
  stats: { month: string; monthShifts: number; monthHours: number; monthAbsent: number; totalShifts: number; totalHours: number; totalAbsent: number; reliability: number | null; referralCount: number };
  factoryHistory: { factoryId: number | null; factoryName: string | null; shifts: number; hours: number; absent: number; firstDate: string; lastDate: string }[];
  recent: { date: string | null; factoryName: string | null; shift: string; status: string; hours: number }[];
}

function Kpi({ icon: Icon, label, value, sub, color }: { icon: any; label: string; value: React.ReactNode; sub?: string; color: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">{label}</div>
          <div className="mt-1 text-2xl font-bold text-slate-800">{value}</div>
          {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${color}`}><Icon className="h-5 w-5" /></div>
      </div>
    </Card>
  );
}

export default function WorkerDetail() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const isOwner = me?.role === "owner";
  const [, params] = useRoute("/workers/:id");
  const id = params?.id;
  const { data: w, isLoading, isError } = useQuery<WorkerProfile>({ queryKey: ["worker", id], queryFn: () => get(`/workers/${id}`), enabled: !!id });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["companies"], queryFn: () => get("/companies") });
  const [editing, setEditing] = useState(false);
  // зміна з датою набуття: свод-релевантні поля відкривають модалку «від коли +
  // що зачепить» замість прямого PATCH (лише для користувачів з cap svodni)
  const canSvodni = can(me, "svodni");
  const [pendingChange, setPendingChange] = useState<{ changes: Record<string, unknown>; title: string; from?: string } | null>(null);
  const requestChange = canSvodni ? (changes: Record<string, unknown>, title: string, from?: string) => setPendingChange({ changes, title, from }) : undefined;

  if (isLoading) return <Spinner />;
  if (isError || !w) return <Empty>{t("Працівника не знайдено")}</Empty>;

  // Shape the profile into the Worker form the shared modal expects.
  const workerForEdit: Worker = {
    id: w.id, fullName: w.fullName, workerCode: w.workerCode, telegramId: w.telegramId,
    factoryId: w.factoryId, factoryName: w.factoryName, companyId: w.companyId, companyName: w.companyName,
    positionId: w.positionId, positionName: w.positionName, positionColor: w.positionColor,
    gender: (w.gender as Gender | null) ?? null, fixedShift: w.fixedShift, selfTransport: w.selfTransport,
    status: w.status, isActive: w.isActive, language: w.language,
    hourlyRate: w.hourlyRate, isStudent: w.isStudent, under26: w.under26,
  };

  const st = w.stats;
  const statusBadge = (s: string) =>
    s === "present" ? <Badge color="green">{t("вийшов")}</Badge>
    : s === "absent" ? <Badge color="rose">{t("не вийшов")}</Badge>
    : <Badge color="slate">{t("заплановано")}</Badge>;

  return (
    <>
      <Link href="/workers" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" /> {t("До працівників")}</Link>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-lg font-bold text-red-700">
          {w.fullName?.[0]?.toUpperCase() ?? "?"}
        </div>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-800">
            {w.fullName}
            {w.gender && <span className={`text-lg font-semibold ${genderClass(w.gender)}`} title={w.gender === "male" ? t("Чоловік") : t("Жінка")}>{genderIcon(w.gender)}</span>}
            {!w.isActive && <Badge color="rose">{t("звільнений")}</Badge>}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            {w.workerCode && <span className="font-mono">{w.workerCode}</span>}
            {w.positionName && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(w.positionColor ?? "slate")}`}><span className={`h-1.5 w-1.5 rounded-full ${dotClass(w.positionColor ?? "slate")}`} />{w.positionName}</span>}
            {w.companyName && <Badge color="blue">{w.companyName}</Badge>}
            {w.factoryName && <Badge color="red">{w.factoryName}</Badge>}
          </div>
        </div>
        <Button variant="secondary" className="ml-auto" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> {t("Редагувати")}</Button>
      </div>

      {/* Contact / info */}
      <Card className="mb-5 p-4">
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Info icon={Building2} label={t("Фірма")} value={w.companyName ?? "—"} />
          <Info icon={FactoryIcon} label={t("Фабрика")} value={w.factoryName ?? "—"} />
          <Info icon={Briefcase} label={t("Посада")} value={w.positionName ?? "—"} />
          <Info icon={Users} label={t("Стать")} value={w.gender === "male" ? t("Чоловік") : w.gender === "female" ? t("Жінка") : "—"} />
          {w.fixedShift && <Info icon={CalendarCheck} label={t("Закріплена зміна")} value={t("{n} зміна", { n: w.fixedShift })} />}
          {w.selfTransport && <Info icon={Car} label={t("Транспорт")} value={t("Доїжджає сам")} />}
          <Info icon={Send} label="Telegram" value={w.telegramId ?? t("не приєднаний")} />
          <Info icon={CalendarCheck} label={t("Додано")} value={new Date(w.createdAt).toLocaleDateString("uk-UA")} />
          <BirthDateRow workerId={w.id} birthDate={w.birthDate ?? null} under26Fallback={w.under26 ?? null} />
          <EmploymentDateRow workerId={w.id} date={w.employmentStartDate ?? null} readOnly={w.payoutPrefKind === undefined} onRequest={requestChange} />
          <LegalStatusRow workerId={w.id} legalStatus={(w.legalStatus as LegalStatus | null) ?? null} onRequest={requestChange} />
          <NotifyHoursRow workerId={w.id} notifyHours={w.notifyHours ?? null} onRequest={requestChange} />
          {(w.agramFactory || w.cashBonusFactory) && (
            <AgramBonusRow workerId={w.id} staz={!!w.agramStazBonus} cash={!!w.agramCashBonus} startDate={w.employmentStartDate ?? null} cashOnly={!w.agramFactory} onRequest={requestChange} />
          )}
          {w.payoutPrefKind !== undefined && (
            <PayoutPrefRow workerId={w.id} kind={w.payoutPrefKind ?? null} value={w.payoutPrefValue ?? null} onRequest={requestChange} />
          )}
          {(w.hourlyRate != null || w.effectiveRate != null) && <Info icon={Clock} label={t("Ставка")} value={`${w.effectiveRate ?? w.hourlyRate} zł/${t("год")}${w.hourlyRate == null ? " · " + t("авто") : ""}${w.positionRate != null ? " · " + t("за посадою") : ""}${w.isStudent ? " · " + t("Студент") : ""}${w.under26 ? " · <26" : ""}`} />}
          {w.hourlyRate === null && w.effectiveRate == null && w.hourlyRateNetto == null && (
            <Info icon={Clock} label={t("Ставка")} value={t("авто (за правилами фабрики)")} />
          )}
        </div>
        {w.note !== undefined && <NoteBlock workerId={w.id} note={w.note ?? null} />}
      </Card>

      {/* KPI grid */}
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={CalendarCheck} label={t("Змін цього місяця")} value={st.monthShifts} sub={`${st.monthHours} ${t("год")}`} color="text-emerald-600 bg-emerald-50" />
        <Kpi icon={Clock} label={t("Годин цього місяця")} value={st.monthHours} color="text-sky-600 bg-sky-50" />
        <Kpi icon={Activity} label={t("Надійність")} value={st.reliability != null ? `${st.reliability}%` : "—"} sub={t("за весь час")} color="text-red-600 bg-red-50" />
        <Kpi icon={UserX} label={t("Невиходи")} value={st.totalAbsent} sub={t("за весь час")} color="text-rose-600 bg-rose-50" />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={CalendarCheck} label={t("Усього змін")} value={st.totalShifts} color="text-slate-600 bg-slate-100" />
        <Kpi icon={Clock} label={t("Усього годин")} value={st.totalHours} color="text-slate-600 bg-slate-100" />
        <Kpi icon={Gift} label={t("Запросив друзів")} value={st.referralCount} color="text-amber-600 bg-amber-50" />
      </div>

      {/* Employment history per factory (transfers / re-hires keep old factories visible) */}
      {(w.factoryHistory?.length ?? 0) > 0 && (
        <Card className="mb-5 overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-3"><h3 className="text-sm font-semibold text-slate-700">{t("Історія по фабриках")}</h3></div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">{t("Фабрика")}</th><th className="px-4 py-2">{t("Період")}</th><th className="px-4 py-2 text-center">{t("Зміни")}</th><th className="px-4 py-2 text-right">{t("Години")}</th><th className="px-4 py-2 text-right">{t("Невиходи")}</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {w.factoryHistory.map((f, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-700">
                    {f.factoryName ?? t("Без фабрики")}
                    {f.factoryId != null && f.factoryId === w.factoryId && <span className="ml-2"><Badge color="green">{t("поточна")}</Badge></span>}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{f.firstDate} — {f.lastDate}</td>
                  <td className="px-4 py-2 text-center text-slate-600">{f.shifts}</td>
                  <td className="px-4 py-2 text-right font-medium text-emerald-700">{f.hours} {t("год")}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{f.absent || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Documents */}
      <WorkerDocuments workerId={w.id} />

      <WorkerBankAccounts workerId={w.id} />

      {/* Recent shifts */}
      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3"><h3 className="text-sm font-semibold text-slate-700">{t("Останні зміни")}</h3></div>
        {!w.recent.length ? <Empty>{t("Немає відпрацьованих змін")}</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">{t("Дата")}</th><th className="px-4 py-2">{t("Фабрика")}</th><th className="px-4 py-2">{t("Зміна")}</th><th className="px-4 py-2">{t("Статус")}</th><th className="px-4 py-2 text-right">{t("Години")}</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {w.recent.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-700">{r.date}</td>
                  <td className="px-4 py-2 text-slate-500">{r.factoryName ?? "—"}</td>
                  <td className="px-4 py-2 text-slate-500">{r.shift} {t("зм")}</td>
                  <td className="px-4 py-2">{statusBadge(r.status)}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{r.hours || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Історія змін профілю (журнал з датами набуття) + видалення зміни */}
      <ChangesTimeline workerId={w.id} canUndo={canSvodni} />

      {editing && (
        <WorkerModal worker={workerForEdit} factories={factories} companies={companies} isOwner={isOwner}
          onClose={() => setEditing(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["worker", id] }); qc.invalidateQueries({ queryKey: ["workers"] }); setEditing(false); }} />
      )}
      {pendingChange && (
        <ProfileChangeModal workerId={w.id} changes={pendingChange.changes} title={pendingChange.title}
          initialFrom={pendingChange.from} onClose={() => setPendingChange(null)} />
      )}
    </>
  );
}

function Info({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="shrink-0 text-slate-400">{label}:</span>
      <span className="min-w-0 truncate font-medium text-slate-700" title={value}>{value}</span>
    </div>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────
const DOC_STATUS: Record<string, { label: string; color: "green" | "rose" | "amber" | "slate" }> = {
  present: { label: "наявний", color: "green" },
  missing: { label: "відсутній", color: "rose" },
  expired: { label: "прострочений", color: "amber" },
  pending: { label: "очікується", color: "slate" },
};
const isExpired = (iso?: string | null) => !!iso && new Date(iso + "T00:00:00").getTime() < Date.now();

function WorkerDocuments({ workerId }: { workerId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: types = [] } = useQuery<DocumentType[]>({ queryKey: ["document-types"], queryFn: () => get("/document-types") });
  const { data: docs = [], isLoading } = useQuery<WorkerDocument[]>({ queryKey: ["worker-docs", workerId], queryFn: () => get(`/workers/${workerId}/documents`) });
  const [editing, setEditing] = useState<WorkerDocument | null>(null);
  const [addFor, setAddFor] = useState<DocumentType | null | "custom">(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-docs", workerId] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/worker-documents/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });

  const docByType = new Map<number, WorkerDocument>();
  for (const d of docs) if (d.docTypeId != null) docByType.set(d.docTypeId, d);
  const extras = docs.filter(d => d.docTypeId == null || !types.some(ty => ty.id === d.docTypeId));

  const missingRequired = types.filter(ty => ty.required && !docByType.has(ty.id)).length;

  const row = (key: string, name: string, required: boolean, doc: WorkerDocument | undefined, type: DocumentType | null) => {
    const expired = doc && (doc.status === "expired" || isExpired(doc.expiresAt));
    const status = doc ? (expired && doc.status === "present" ? "expired" : doc.status) : "missing";
    const s = DOC_STATUS[status] ?? DOC_STATUS.missing;
    return (
      <div key={key} className="flex flex-wrap items-center gap-2 border-b border-slate-50 px-4 py-2.5 text-sm last:border-0">
        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="font-medium text-slate-700">{name}</span>
        {required && <span className="text-[10px] font-semibold uppercase text-amber-500">{t("обов'язковий")}</span>}
        <Badge color={s!.color}>{t(s!.label)}</Badge>
        {doc?.expiresAt && <span className={`text-xs ${isExpired(doc.expiresAt) ? "font-medium text-rose-600" : "text-slate-400"}`}>⏳ {doc.expiresAt}</span>}
        {doc?.number && <span className="text-xs text-slate-400">№ {doc.number}</span>}
        {doc?.fileName && <a href={`/api/worker-documents/${doc.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-red-600 hover:underline" title={doc.fileName}>{t("файл")} <ExternalLink className="h-3 w-3" /></a>}
        {doc?.fileUrl && <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-red-600 hover:underline">{t("посилання")} <ExternalLink className="h-3 w-3" /></a>}
        {doc?.note && <span className="truncate text-xs text-slate-400" title={doc.note}>📝 {doc.note}</span>}
        <div className="ml-auto flex shrink-0 gap-1">
          {doc
            ? <>
                <button onClick={() => setEditing(doc)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={t("Редагувати")}><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={async () => { if (await confirm({ title: t("Видалити документ?"), danger: true, confirmText: t("Видалити") })) remove.mutate(doc.id); }} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
              </>
            : <button onClick={() => setAddFor(type)} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><Plus className="h-3.5 w-3.5" /> {t("Додати")}</button>}
        </div>
      </div>
    );
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          {t("Документи")}
          {missingRequired > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600"><AlertTriangle className="h-3 w-3" /> {t("бракує {n}", { n: missingRequired })}</span>}
        </h3>
        <Button variant="secondary" onClick={() => setAddFor("custom")}><Plus className="h-4 w-4" /> {t("Документ")}</Button>
      </div>
      {isLoading ? <Spinner /> : (
        <div>
          {types.map(ty => row(`ty${ty.id}`, ty.name, ty.required, docByType.get(ty.id), ty))}
          {extras.map(d => row(`ex${d.id}`, d.title, false, d, null))}
          {!types.length && !extras.length && <Empty>{t("Немає документів. Додайте типи в Налаштуваннях → Документи.")}</Empty>}
        </div>
      )}
      {(addFor !== null || editing) && (
        <DocModal workerId={workerId} doc={editing} type={addFor === "custom" ? null : addFor} types={types}
          onClose={() => { setAddFor(null); setEditing(null); }} onSaved={() => { inv(); setAddFor(null); setEditing(null); }} />
      )}
    </Card>
  );
}

// Банківські рахунки працівника: перекази на ці IBAN-и класифікуються у витягах
// як ЗП/аванси навіть без ключових слів у призначенні. Більшість підтягується
// автоматично з зарплатних переказів; тут — перегляд і ручні правки.
function WorkerBankAccounts({ workerId }: { workerId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [iban, setIban] = useState("");
  const { data: rows = [], isLoading } = useQuery<{ id: number; iban: string; source: string }[]>({
    queryKey: ["worker-bank-accounts", workerId], queryFn: () => get(`/workers/${workerId}/bank-accounts`),
  });
  const inv = () => qc.invalidateQueries({ queryKey: ["worker-bank-accounts", workerId] });
  const add = useMutation({
    mutationFn: () => post(`/workers/${workerId}/bank-accounts`, { iban }),
    onSuccess: () => { inv(); setIban(""); toast.success(t("Рахунок додано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/worker-bank-accounts/${id}`), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const fmtIban = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-3">
        <h3 className="text-sm font-semibold text-slate-700">{t("Банківські рахунки (для ЗП/авансів)")}</h3>
      </div>
      {isLoading ? <Spinner /> : (
        <div>
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2 border-b border-slate-50 px-4 py-2 text-sm last:border-0">
              <span className="tabular-nums text-slate-700">{fmtIban(r.iban)}</span>
              <span className="text-[10px] uppercase text-slate-400">{r.source === "auto" ? t("авто") : t("ручна")}</span>
              <button className="ml-auto rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                onClick={async () => { if (await confirm({ title: t("Видалити рахунок?"), danger: true, confirmText: t("Видалити") })) remove.mutate(r.id); }}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {!rows.length && <Empty>{t("Рахунків ще немає — підтягнуться з зарплатних переказів або додай вручну.")}</Empty>}
          <div className="flex items-center gap-2 px-4 py-3">
            <Input value={iban} onChange={e => setIban(e.target.value)} placeholder="PL00 0000…" className="w-72" />
            <Button variant="secondary" disabled={iban.replace(/\W/g, "").length < 15 || add.isPending} onClick={() => add.mutate()}>
              <Plus className="h-4 w-4" /> {t("Додати")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function DocModal({ workerId, doc, type, types, onClose, onSaved }: {
  workerId: number; doc: WorkerDocument | null; type: DocumentType | null; types: DocumentType[]; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const isEdit = !!doc;
  const [docTypeId, setDocTypeId] = useState(doc?.docTypeId != null ? String(doc.docTypeId) : (type ? String(type.id) : ""));
  const [title, setTitle] = useState(doc?.title ?? type?.name ?? "");
  const [status, setStatus] = useState(doc?.status ?? "present");
  const [number, setNumber] = useState(doc?.number ?? "");
  const [expiresAt, setExpiresAt] = useState(doc?.expiresAt ?? "");
  const [fileUrl, setFileUrl] = useState(doc?.fileUrl ?? "");
  const [note, setNote] = useState(doc?.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  const body = () => ({ docTypeId: docTypeId ? Number(docTypeId) : null, title: title.trim(), status, number, expiresAt: expiresAt || null, fileUrl, note });
  const save = useMutation({
    mutationFn: async () => {
      const saved: WorkerDocument = isEdit ? await patch(`/worker-documents/${doc!.id}`, body()) : await post(`/workers/${workerId}/documents`, body());
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        await upload(`/worker-documents/${saved.id}/file`, fd);
      }
      return saved;
    },
    onSuccess: () => { toast.success(isEdit ? t("Збережено") : t("Додано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати документ") : t("Новий документ")}>
      <div className="space-y-3">
        <div><Label>{t("Тип документа")}</Label>
          <Select value={docTypeId} onChange={e => { setDocTypeId(e.target.value); const ty = types.find(x => String(x.id) === e.target.value); if (ty && !title.trim()) setTitle(ty.name); }}>
            <option value="">{t("— власний —")}</option>
            {types.map(ty => <option key={ty.id} value={ty.id}>{ty.name}</option>)}
          </Select>
        </div>
        <div><Label>{t("Назва")}</Label><Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("Назва документа")} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Статус")}</Label>
            <Select value={status} onChange={e => setStatus(e.target.value)}>
              {Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
            </Select>
          </div>
          <div><Label>{t("Дійсний до")}</Label><Input type="date" value={expiresAt ?? ""} onChange={e => setExpiresAt(e.target.value)} /></div>
        </div>
        <div><Label>{t("Номер")}</Label><Input value={number} onChange={e => setNumber(e.target.value)} /></div>
        <div>
          <Label>{t("Файл")}</Label>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 hover:bg-slate-50">
            <Upload className="h-4 w-4 shrink-0" />
            <span className="truncate">{file ? file.name : (doc?.fileName ? t("Замінити: {name}", { name: doc.fileName }) : t("Обрати файл (PDF, фото, docx)"))}</span>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx" className="hidden" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <div><Label>{t("Посилання на файл")}</Label><Input value={fileUrl} onChange={e => setFileUrl(e.target.value)} placeholder="https://drive…" /></div>
        <div><Label>{t("Нотатка")}</Label><Input value={note} onChange={e => setNote(e.target.value)} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => title.trim() && save.mutate()}>{isEdit ? t("Зберегти") : t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}


// Дата народження з інлайн-редагуванням; «до 26» виводиться автоматично
// (податкова пільга) і зберігається у профілі при зміні дати.
// Побажання по виплаті (лише svodniSensitive): найвищий пріоритет у розкладі
// konto/готівка — понад статус і год. oświadczenia (менше заробив → менша сума)
const PAYOUT_PREF_LABEL: Record<string, string> = {
  all_konto: "Все на конто", hours: "N годин на конто", amount: "Сума на конто",
};
type RequestChange = ((changes: Record<string, unknown>, title: string, from?: string) => void) | undefined;

function PayoutPrefRow({ workerId, kind, value, onRequest }: { workerId: number; kind: string | null; value: number | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  // ресинк із пропом: після скасування модалки/збереження інпут не має
  // показувати незастосоване значення як «збережене»
  useEffect(() => { setDraft(value == null ? "" : String(value)); }, [value]);
  const save = useMutation({
    mutationFn: (p: { payoutPrefKind?: string | null; payoutPrefValue?: number | null }) => patch(`/workers/${workerId}`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = (p: { payoutPrefKind?: string | null; payoutPrefValue?: number | null }) =>
    onRequest ? onRequest(p, t("Побажання по виплаті")) : save.mutate(p);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Wallet className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Побажання по виплаті")}:</span>
      <select value={kind ?? ""} onChange={e => submit({ payoutPrefKind: e.target.value || null })}
        className="rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
        <option value="">{t("— за правилами —")}</option>
        {Object.entries(PAYOUT_PREF_LABEL).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
      </select>
      {(kind === "hours" || kind === "amount") && (
        <input type="number" min={0} value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft === "" ? null : Number(draft);
            if (v !== value) {
              submit({ payoutPrefValue: v });
              // модалковий шлях: інпут не має показувати незастосоване як збережене
              if (onRequest) setDraft(value == null ? "" : String(value));
            }
          }}
          placeholder={kind === "hours" ? t("год") : "zł"}
          className="w-24 rounded border border-slate-300 px-1 py-0.5 text-sm" />
      )}
    </div>
  );
}

// Примітка (лише svodniSensitive)
function NoteBlock({ workerId, note }: { workerId: number; note: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { note: draft.trim() || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-600">
        <FileText className="h-3.5 w-3.5" /> {t("Примітка (закритий доступ)")}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={3}
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-red-400 focus:outline-none" />
          <div className="flex gap-2">
            <button className="text-xs font-medium text-emerald-600" onClick={() => save.mutate()}>{t("Зберегти")}</button>
            <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-lg bg-amber-50/60 px-3 py-2 text-left text-sm text-slate-700 hover:bg-amber-50"
          onClick={() => { setDraft(note ?? ""); setEditing(true); }}>
          {note || <span className="text-slate-400">{t("додати примітку…")}</span>}
        </button>
      )}
    </div>
  );
}

// Форма легалізації: select із канонічних статусів (двосторонній синк зі сводними)
function LegalStatusRow({ workerId, legalStatus, onRequest }: { workerId: number; legalStatus: LegalStatus | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: string) => patch(`/workers/${workerId}`, { legalStatus: v || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = (v: string) => onRequest ? onRequest({ legalStatus: v || null }, t("Форма легалізації")) : save.mutate(v);
  const badge = legalStatus ? LEGAL_BADGE[legalStatus] : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <IdCard className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Форма легалізації")}:</span>
      <select value={legalStatus ?? ""} onChange={e => submit(e.target.value)}
        className="rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
        <option value="">—</option>
        {LEGAL_STATUSES.map(s => <option key={s} value={s}>{t(LEGAL_LABEL[s])}</option>)}
      </select>
      {badge && <span className={`rounded px-1 text-[10px] font-medium ${badge.cls}`}>{badge.short}</span>}
    </div>
  );
}

// Години в повідомленні (powiadomienie — дозвіл на працю): показуються в сводній
function NotifyHoursRow({ workerId, notifyHours, onRequest }: { workerId: number; notifyHours: number | null; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { notifyHours: draft === "" ? null : Number(draft) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = () => {
    if (onRequest) { onRequest({ notifyHours: draft === "" ? null : Number(draft) }, t("Год. у повідомленні")); setEditing(false); }
    else save.mutate();
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Clock className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Год. у повідомленні")}:</span>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="number" min={0} value={draft} onChange={e => setDraft(e.target.value)}
            className="w-20 rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600"
          onClick={() => { setDraft(notifyHours == null ? "" : String(notifyHours)); setEditing(true); }}>
          {notifyHours != null ? `${notifyHours} ${t("год")}` : t("вказати")}
        </button>
      )}
    </div>
  );
}

function BirthDateRow({ workerId, birthDate, under26Fallback }: { workerId: number; birthDate: string | null; under26Fallback?: boolean | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(birthDate ?? "");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { birthDate: draft || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  // Дата народження — факт, а не зміна умов «з дати»: модалку «Діє з» не
  // відкриваємо, зберігаємо одразу (журнал змін на бекенді лишається).
  const submit = () => save.mutate();
  // вік — окрема властивість (не форма легалізації): з дати, без дати — з профілю
  const under26 = birthDate ? new Date(birthDate + "T00:00:00").getTime() > Date.now() - 26 * 365.25 * 86400000 : under26Fallback ?? null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Cake className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Дата народження")}:</span>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)}
            className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600" onClick={() => { setDraft(birthDate ?? ""); setEditing(true); }}>
          {birthDate ? new Date(birthDate + "T00:00:00").toLocaleDateString("uk-UA") : t("вказати")}
          {under26 != null && <span className={under26 ? "ml-1 rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700" : "ml-1 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500"}>{under26 ? "<26" : "26+"}</span>}
        </button>
      )}
    </div>
  );
}

// Дата працевлаштування (усі працівники); на фабриках Agram від неї
// автоматично рахується стаж-бонус до ставки нетто
// readOnly: без доступу до кшєнгових даних (svodniSensitive) дата видима, але не редагується
function EmploymentDateRow({ workerId, date, readOnly, onRequest }: { workerId: number; date: string | null; readOnly?: boolean; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(date ?? "");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { employmentStartDate: draft || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const submit = () => {
    if (onRequest) { onRequest({ employmentStartDate: draft || null }, t("Дата працевлаштування")); setEditing(false); }
    else save.mutate();
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Briefcase className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Дата працевлаштування")}:</span>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)}
            className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={submit}>{t("Зберегти")}</button>
          <button className="text-xs text-slate-400" onClick={() => setEditing(false)}>{t("Скасувати")}</button>
        </span>
      ) : readOnly ? (
        <span className="font-medium text-slate-700">
          {date ? new Date(date + "T00:00:00").toLocaleDateString("uk-UA") : "—"}
        </span>
      ) : (
        <button className="font-medium text-slate-700 hover:text-red-600" onClick={() => { setDraft(date ?? ""); setEditing(true); }}>
          {date ? new Date(date + "T00:00:00").toLocaleDateString("uk-UA") : t("вказати")}
        </button>
      )}
    </div>
  );
}

// Бонуси Agram (лише працівники фабрик Agram): галочки профілю. Сума стажу
// рахується автоматично від дати працевлаштування (+1 від 1 міс, +1.5 від 6;
// без дати — +1); нал — фіксований +1 зл/год до ставки нетто.
function AgramBonusRow({ workerId, staz, cash, startDate, cashOnly, onRequest }: { workerId: number; staz: boolean; cash: boolean; startDate: string | null; cashOnly?: boolean; onRequest?: RequestChange }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (p: { agramStazBonus?: boolean; agramCashBonus?: boolean }) => patch(`/workers/${workerId}`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); qc.invalidateQueries({ queryKey: ["worker-changes"] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const groupLabel = cashOnly ? t("Бонус фабрики") : t("Бонуси Agram");
  const submit = (p: { agramStazBonus?: boolean; agramCashBonus?: boolean }) =>
    onRequest ? onRequest(p, groupLabel) : save.mutate(p);
  // поточний ярус стажу — на кінець поточного місяця (як рахує сводна)
  const stazRate = (() => {
    if (!startDate) return 1;
    // дзеркало серверного правила: дні стажу на кінець поточного місяця
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);
    const days = Math.round((end.getTime() - new Date(startDate + "T12:00:00").getTime()) / 86400000);
    return days >= 60 ? 1.5 : days >= 30 ? 1 : 0;
  })();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-2">
      <BadgePlus className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{groupLabel}:</span>
      {!cashOnly && (
        <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
          <input type="checkbox" checked={staz} onChange={e => submit({ agramStazBonus: e.target.checked })} />
          {t("Стаж")}
          <span className="text-xs text-slate-400" title={t("Стаж авто від дати: +1 зл/год від 30 днів, +1.5 від 60 (лише при 160+ год у місяці); без дати — +1")}>
            {staz ? `+${stazRate} zł/${t("год")}` : "+1…1.5"}{staz && !startDate ? ` · ${t("без дати")}` : ""}
          </span>
        </label>
      )}
      <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
        <input type="checkbox" checked={cash} onChange={e => submit({ agramCashBonus: e.target.checked })} />
        {t("Частина ЗП налом")}
        <span className="text-xs text-slate-400">+1 zł/{t("год")}</span>
      </label>
    </div>
  );
}

// ─── Зміни з датою набуття: модалка превʼю + журнал ──────────────────────────
// Людські назви полів журналу/дифів (укр-рядок-як-ключ для t())
const CHANGE_FIELD_LABEL: Record<string, string> = {
  factoryId: "Фабрика", positionId: "Посада", legalStatus: "Форма легалізації",
  birthDate: "Дата народження", notifyHours: "Год. у повідомленні",
  employmentStartDate: "Дата працевлаштування", agramStazBonus: "Бонус Agram: стаж",
  agramCashBonus: "Бонус Agram: нал", hourlyRate: "Ставка брутто", hourlyRateNetto: "Ставка нетто",
  isStudent: "Студент", payoutPrefKind: "Побажання по виплаті", payoutPrefValue: "Значення побажання",
  fired: "Звільнення", restored: "Поновлення",
};
const DIFF_KEY_LABEL: Record<string, string> = {
  hoursNotified: "Год. повід.", rateBrutto: "Ставка брутто", rateNetto: "Ставка нетто",
  isStudent: "Студент", under26: "До 26", section: "Секція", doWyplaty: "До виплати",
  brutto: "Brutto", hoursDeclared: "Год. księg.", ksiegBrutto: "Księg. brutto",
  ksiegNetto: "Księg. netto", konto: "Конто", gotowka: "Готівка",
  zusStatus: "Księgowość (текст)", dataUrodzenia: "Дата народження",
};
// На що поле впливає в системі (місця-споживачі) — показується в превʼю зміни,
// щоб було видно наслідки за межами конкретних рядків сводної
const FIELD_IMPACTS: Record<string, string[]> = {
  legalStatus: ["Розклад konto/готівка у сводних", "Księgowa ставка (нижча зі ставок)", "Фінанси: розрахунок ЗП"],
  birthDate: ["Пільга «до 26» (податки)", "Розклад konto/готівка у сводних", "Фінанси: розрахунок ЗП"],
  notifyHours: ["Ліміт декларованих годин → konto/готівка у сводних"],
  hourlyRate: ["Ставка в сводних і нових місяцях", "Фінанси: розрахунок ЗП", "Excel-сводна"],
  hourlyRateNetto: ["Ставка в сводних і нових місяцях", "Фінанси: розрахунок ЗП", "Excel-сводна"],
  agramStazBonus: ["Ставка нетто Agram (бонус вшивається у ставку)"],
  agramCashBonus: ["Ставка нетто Agram (бонус вшивається у ставку)"],
  employmentStartDate: ["Ярус стаж-бонусу Agram (+1 від 1 міс, +1.5 від 6)"],
  payoutPrefKind: ["Пріоритетний розклад konto/готівка (понад правила)"],
  payoutPrefValue: ["Пріоритетний розклад konto/готівка (понад правила)"],
  positionId: ["Секція в сводній", "Генерація графіка (вимоги посад)", "Excel-графік клієнту"],
  isStudent: ["Розклад konto/готівка у сводних", "Фінанси: розрахунок ЗП"],
};
const MONEY_KEYS: { key: string; label: string }[] = [
  { key: "doWyplaty", label: "До виплати" },
  { key: "konto", label: "Конто" },
  { key: "gotowka", label: "Готівка" },
];
const fmtVal = (v: unknown, t: (s: string) => string): string =>
  v == null || v === "" ? "—"
  : v === true || v === "true" ? "✓"
  : v === false || v === "false" ? "✕"
  : LEGAL_LABEL[v as LegalStatus] ? t(LEGAL_LABEL[v as LegalStatus])
  : PAYOUT_PREF_LABEL[v as string] ? t(PAYOUT_PREF_LABEL[v as string]!)
  : String(v);
const todayStr = () => new Date().toLocaleDateString("sv-SE");

type ImpactItem = {
  rowId: number; month: string; city: string; factoryLabel: string; locked: boolean;
  hours: number | null; merge?: boolean; diffs: { key: string; from: unknown; to: unknown }[];
  // план порізки місяця на сегменти (зміна з середини місяця): кожен сегмент
  // рахується за правилами свого статусу
  split?: {
    from: string; to: string; hours: number; rateNetto: number | null; label: string | null;
    legal: string | null; doWyplaty: number | null; konto?: number | null; gotowka?: number | null;
  }[];
};
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
// кольори сегментів у превʼю порізки — ті самі, що в таблиці сводної
const SPLIT_TEXT = ["text-violet-700", "text-sky-700", "text-teal-700", "text-rose-700"];
const SPLIT_DOT = ["bg-violet-400", "bg-sky-400", "bg-teal-400", "bg-rose-400"];

// Модалка «зміна від дати»: питає дату набуття, показує що зачепить у сводних
// (dry-run /svodni/profile-impact) і застосовує вибране (/svodni/profile-apply)
function ProfileChangeModal({ workerId, changes, title, initialFrom, onClose }: {
  workerId: number; changes: Record<string, unknown>; title: string; initialFrom?: string; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [from, setFrom] = useState(initialFrom ?? todayStr());
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const { data, isFetching, isError, error } = useQuery<{ items: ImpactItem[]; checkedRows: number; workerMonths: string[] }>({
    queryKey: ["profile-impact", workerId, JSON.stringify(changes), from],
    queryFn: () => post("/svodni/profile-impact", { workerId, changes, from }),
  });
  const items = data?.items ?? [];
  const selectable = items.filter(i => !i.locked);
  const selectedIds = selectable.filter(i => !deselected.has(i.rowId)).map(i => i.rowId);
  const apply = useMutation({
    mutationFn: (rowIds: number[]) => post<{ applied: number }>("/svodni/profile-apply", { workerId, changes, from, rowIds }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["worker"] });
      qc.invalidateQueries({ queryKey: ["worker-changes"] });
      qc.invalidateQueries({ queryKey: ["svodni"] });
      toast.success(r.applied ? t("Застосовано: профіль + {n} рядків сводної", { n: r.applied }) : t("Збережено в профіль"));
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const changesSummary = Object.entries(changes)
    .map(([k, v]) => `${t(CHANGE_FIELD_LABEL[k] ?? k)} → ${fmtVal(v, t)}`).join("; ");
  // місця-споживачі поля + сумарний грошовий ефект по вибраних рядках
  const consumers = [...new Set(Object.keys(changes).flatMap(k => FIELD_IMPACTS[k] ?? []))];
  const selectedItems = items.filter(i => !i.locked && !deselected.has(i.rowId));
  const totals = MONEY_KEYS.map(({ key, label }) => ({
    label,
    delta: Math.round(selectedItems.reduce((a, it) => {
      const d = it.diffs.find(d => d.key === key);
      return a + (d ? (Number(d.to) || 0) - (Number(d.from) || 0) : 0);
    }, 0) * 100) / 100,
  })).filter(x => x.delta !== 0);
  return (
    <Modal open title={t("Зміна: {what}", { what: title })} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-slate-50 px-3 py-2 font-medium text-slate-700">{changesSummary}</div>
        {consumers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase tracking-wide text-slate-400">{t("Впливає на")}:</span>
            {consumers.map(c => (
              <span key={c} className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700">{t(c)}</span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500">{t("Діє з")}</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-red-400 focus:outline-none" />
        </div>
        {isError ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">
            {t("Не вдалося завантажити превʼю впливу")}: {(error as any)?.message ?? ""}
          </div>
        ) : isFetching ? <Spinner /> : !items.length ? (
          <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-slate-500">
            {(data?.checkedRows ?? 0) > 0 ? (
              <div>{t("Перевірено рядків сводних: {n} — ця зміна їхніх цифр не міняє (значення й так збігаються). Оновиться профіль.", { n: data!.checkedRows })}</div>
            ) : (
              <>
                <div>{t("Від {date} рядків сводної в цієї людини нема — оновиться лише профіль (нові місяці порахуються вже по-новому).", { date: from })}</div>
                {(data?.workerMonths?.length ?? 0) > 0 && (
                  <div className="text-xs">
                    {t("Наявні сводні: {months}. Якщо зміна діє заднім числом — обери ранішу дату.", { months: data!.workerMonths.join(", ") })}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Зачепить у сводних")}</div>
            {items.map(it => (
              <label key={it.rowId} className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${it.locked ? "border-slate-100 bg-slate-50 opacity-70" : "cursor-pointer border-slate-200 hover:bg-slate-50"}`}>
                <input type="checkbox" className="mt-0.5" disabled={it.locked}
                  checked={!it.locked && !deselected.has(it.rowId)}
                  onChange={e => setDeselected(prev => {
                    const n = new Set(prev);
                    e.target.checked ? n.delete(it.rowId) : n.add(it.rowId);
                    return n;
                  })} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium text-slate-700">
                    {it.month} · {t(it.city)} · {it.factoryLabel}
                    {it.locked && <span className="flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700"><Lock className="h-3 w-3" /> {t("затверджено — не зміниться")}</span>}
                  </span>
                  {it.merge && (
                    <span className="mt-0.5 block text-xs font-medium text-teal-700">
                      🪡 {t("умови вирівнялись по всьому місяцю — сегменти зіллються в один рядок")}
                    </span>
                  )}
                  {it.split && (
                    <span className="mt-1 block space-y-0.5 text-xs">
                      <span className="block font-semibold text-violet-700">🧩 {t("місяць поріжеться на сегменти")}:</span>
                      {it.split.map((s, i) => (
                        <span key={i} className="flex items-center gap-1.5 pl-4 text-slate-600">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${SPLIT_DOT[i % SPLIT_DOT.length]}`} />
                          <span>
                            <span className={`font-semibold ${SPLIT_TEXT[i % SPLIT_TEXT.length]}`}>{ddmm(s.from)}–{ddmm(s.to)}</span>
                            {": "}{s.hours} {t("год")}{s.rateNetto != null ? ` × ${s.rateNetto} zł` : ""}
                            {s.doWyplaty != null ? ` → ${t("до виплати")} ${s.doWyplaty}` : ""}
                            {s.konto != null ? ` (${t("конто")} ${s.konto} / ${t("готівка")} ${s.gotowka ?? 0})` : ""}
                            {s.label ? ` · ${s.label}` : ""}
                          </span>
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {it.diffs.map(d => `${t(DIFF_KEY_LABEL[d.key] ?? d.key)}: ${fmtVal(d.from, t)} → ${fmtVal(d.to, t)}`).join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {totals.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50/70 px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-amber-700">{t("Сумарно по вибраних")}:</span>
            {totals.map(x => (
              <span key={x.label} className={`font-semibold ${x.delta > 0 ? "text-emerald-700" : "text-rose-700"}`}>
                {t(x.label)}: {x.delta > 0 ? "+" : ""}{x.delta} zł
              </span>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          {/* без превʼю не застосовуємо: помилка/фетч — наслідки невідомі */}
          {!isError && !isFetching && (
            <Button variant="secondary" loading={apply.isPending} onClick={() => apply.mutate([])}>{t("Лише профіль")}</Button>
          )}
          {selectedIds.length > 0 && (
            <Button loading={apply.isPending} onClick={() => apply.mutate(selectedIds)}>
              {t("Застосувати ({n})", { n: selectedIds.length })}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Історія змін профілю: журнал worker_changes (хто/що/коли, з якої дати діє)
function ChangesTimeline({ workerId, canUndo }: { workerId: number; canUndo?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  // «видалити зміну»: сервер повертає попереднє значення, перераховує зачеплені
  // сводні від дати набуття і зносить запис із журналу
  const removeChange = useMutation({
    mutationFn: (id: number) => del(`/svodni/profile-change/${id}`),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["worker"] });
      qc.invalidateQueries({ queryKey: ["worker-changes"] });
      qc.invalidateQueries({ queryKey: ["svodni"] });
      toast.success(r?.skippedLocked?.length
        ? t("Зміну видалено; затверджені місяці не чіпались: {m}", { m: r.skippedLocked.map((x: any) => x.month).join(", ") })
        : t("Зміну видалено, значення повернуто"));
    },
    onError: (e: any) => toast.error(e.message),
  });
  const { data: changes = [] } = useQuery<{
    id: number; field: string; oldValue: string | null; newValue: string | null;
    effectiveDate: string; appliedRows: { month: string }[] | null;
    skippedLocked: { month: string }[] | null; adminName: string | null; createdAt: string;
  }[]>({ queryKey: ["worker-changes", workerId], queryFn: () => get(`/workers/${workerId}/changes`) });
  // журнал зберігає id — для показу підтягуємо назви фабрик/посад
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: positions = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["positions"], queryFn: () => get("/positions") });
  const showVal = (field: string, v: string | null): string => {
    if (v == null || v === "") return "—";
    if (field === "factoryId") return factories.find(f => String(f.id) === v)?.name ?? v;
    if (field === "positionId") return positions.find(p => String(p.id) === v)?.name ?? v;
    return fmtVal(v, t);
  };
  if (!changes.length) return null;
  return (
    <Card className="mt-5 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
        <History className="h-4 w-4 text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-700">{t("Історія змін")}</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {changes.map(c => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-2 text-sm">
            <span className="font-medium text-slate-700">{t(CHANGE_FIELD_LABEL[c.field] ?? c.field)}:</span>
            <span className="text-slate-500">{showVal(c.field, c.oldValue)} → <span className="font-medium text-slate-700">{showVal(c.field, c.newValue)}</span></span>
            <span className="rounded bg-sky-50 px-1.5 text-xs font-medium text-sky-700">{t("діє з")} {c.effectiveDate}</span>
            {!!c.appliedRows?.length && <span className="rounded bg-emerald-50 px-1.5 text-xs text-emerald-700">{t("сводні: {n}", { n: c.appliedRows.length })}</span>}
            {!!c.skippedLocked?.length && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-700">🔒 {c.skippedLocked.map(s => s.month).join(", ")}</span>}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-slate-400">
              {c.adminName ?? "—"} · {new Date(c.createdAt).toLocaleDateString("uk-UA")}
              {canUndo && !["fired", "restored"].includes(c.field) && (
                <button type="button"
                  title={t("Видалити зміну: значення повернеться до попереднього, сводні перерахуються, запис зникне з історії")}
                  onClick={async () => {
                    if (await confirm({
                      title: t("Видалити зміну?"),
                      message: `${t(CHANGE_FIELD_LABEL[c.field] ?? c.field)}: ${showVal(c.field, c.newValue)} → ${showVal(c.field, c.oldValue)}. ${t("Профіль і зачеплені сводні повернуться до попереднього стану.")}`,
                      confirmText: t("Видалити"),
                    })) removeChange.mutate(c.id);
                  }}
                  className="rounded p-0.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
