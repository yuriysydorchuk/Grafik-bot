import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Building2, Factory as FactoryIcon, Send, Clock, CalendarCheck, UserX, Activity, Gift,
  FileText, Plus, Pencil, Trash2, ExternalLink, AlertTriangle, Briefcase, Users, Upload, Car, Cake, IdCard
} from "lucide-react";
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
          <BirthDateRow workerId={w.id} birthDate={w.birthDate ?? null} />
          <LegalStatusRow workerId={w.id} legalStatus={(w.legalStatus as LegalStatus | null) ?? null} />
          <NotifyHoursRow workerId={w.id} notifyHours={w.notifyHours ?? null} />
          {w.hourlyRate != null && <Info icon={Clock} label={t("Ставка")} value={`${w.effectiveRate ?? w.hourlyRate} zł/${t("год")}${w.positionRate != null ? " · " + t("за посадою") : ""}${w.isStudent ? " · " + t("Студент") : ""}${w.under26 ? " · <26" : ""}`} />}
        </div>
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

      {editing && (
        <WorkerModal worker={workerForEdit} factories={factories} companies={companies} isOwner={isOwner}
          onClose={() => setEditing(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["worker", id] }); qc.invalidateQueries({ queryKey: ["workers"] }); setEditing(false); }} />
      )}
    </>
  );
}

function Info({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{label}:</span>
      <span className="truncate font-medium text-slate-700">{value}</span>
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
// Форма легалізації: select із канонічних статусів (двосторонній синк зі сводними)
function LegalStatusRow({ workerId, legalStatus }: { workerId: number; legalStatus: LegalStatus | null }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: string) => patch(`/workers/${workerId}`, { legalStatus: v || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worker"] }),
    onError: (e: any) => toast.error(e.message),
  });
  const badge = legalStatus ? LEGAL_BADGE[legalStatus] : null;
  return (
    <div className="flex items-center gap-2">
      <IdCard className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Форма легалізації")}:</span>
      <select value={legalStatus ?? ""} onChange={e => save.mutate(e.target.value)}
        className="rounded border border-transparent bg-transparent py-0.5 pr-5 text-sm font-medium text-slate-700 hover:border-slate-300 focus:border-red-400 focus:outline-none">
        <option value="">—</option>
        {LEGAL_STATUSES.map(s => <option key={s} value={s}>{t(LEGAL_LABEL[s])}</option>)}
      </select>
      {badge && <span className={`rounded px-1 text-[10px] font-medium ${badge.cls}`}>{badge.short}</span>}
    </div>
  );
}

// Години в повідомленні (powiadomienie — дозвіл на працю): показуються в сводній
function NotifyHoursRow({ workerId, notifyHours }: { workerId: number; notifyHours: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { notifyHours: draft === "" ? null : Number(draft) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <div className="flex items-center gap-2">
      <Clock className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Год. у повідомленні")}:</span>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="number" min={0} value={draft} onChange={e => setDraft(e.target.value)}
            className="w-20 rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={() => save.mutate()}>{t("Зберегти")}</button>
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

function BirthDateRow({ workerId, birthDate }: { workerId: number; birthDate: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(birthDate ?? "");
  const save = useMutation({
    mutationFn: () => patch(`/workers/${workerId}`, { birthDate: draft || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worker"] }); setEditing(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const under26 = birthDate ? new Date(birthDate + "T00:00:00").getTime() > Date.now() - 26 * 365.25 * 86400000 : null;
  return (
    <div className="flex items-center gap-2">
      <Cake className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="text-slate-400">{t("Дата народження")}:</span>
      {editing ? (
        <span className="flex items-center gap-1">
          <input type="date" value={draft} onChange={e => setDraft(e.target.value)}
            className="rounded border border-slate-300 px-1 py-0.5 text-xs" />
          <button className="text-xs font-medium text-emerald-600" onClick={() => save.mutate()}>{t("Зберегти")}</button>
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
