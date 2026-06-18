import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Trash2, UserCheck, Phone, Send, Search, SlidersHorizontal, Mail, Hand,
  PhoneCall, MessageSquare, CalendarClock, Clock, Pencil, Gift, StickyNote, Users as UsersIcon, ArrowRightLeft,
} from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, del, type Candidate, type Factory, type Worker, type Funnel, type Staff } from "../lib/api";
import { Button, Input, Select, Label, Card, Spinner, Badge, Modal, Empty, cn } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { dotClass, topClass } from "../lib/colors";

const initials = (n: string) => n.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const overdue = (iso?: string | null) => !!iso && new Date(iso).getTime() < Date.now();
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function Recruitment() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const { data: funnels = [], isLoading: loadingFunnels } = useQuery<Funnel[]>({ queryKey: ["funnels"], queryFn: () => get("/funnels") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: workers = [] } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: () => get("/workers") });
  const { data: staff = [] } = useQuery<Staff[]>({ queryKey: ["staff"], queryFn: () => get("/staff") });
  const [detailId, setDetailId] = useState<number | null>(null);

  const [funnelId, setFunnelId] = useState<number | null>(null);
  const active = funnels.find(f => f.id === funnelId) ?? funnels[0];
  const isReferral = active?.kind === "referral";

  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showFilter, setShowFilter] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [converting, setConverting] = useState<Candidate | null>(null);
  const [bonusFor, setBonusFor] = useState<Candidate | null>(null);

  const { data: cands = [], isFetching } = useQuery<Candidate[]>({
    queryKey: ["candidates", active?.id, q], enabled: !!active,
    queryFn: () => get(`/candidates?funnelId=${active!.id}&q=${encodeURIComponent(q)}`),
  });
  const inv = () => qc.invalidateQueries({ queryKey: ["candidates"] });

  const setStage = useMutation({
    mutationFn: (v: { id: number; stage: string }) => patch(`/candidates/${v.id}`, { stage: v.stage }),
    onSuccess: () => inv(), onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/candidates/${id}`),
    onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["funnels"] }); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message),
  });

  const byStage = useMemo(() => {
    const m = new Map<string, Candidate[]>();
    for (const s of active?.stages ?? []) m.set(s.key, []);
    for (const c of cands) (m.get(c.stage) ?? m.set(c.stage, []).get(c.stage)!).push(c);
    return m;
  }, [cands, active]);

  if (loadingFunnels) return <Spinner />;
  if (!active) return <Empty>{t("Немає воронок. Створіть першу в Налаштуваннях → Воронки.")}</Empty>;

  const visibleStages = (active.stages ?? []).filter(s => !hidden.has(s.key));
  const drop = (stageKey: string) => {
    if (dragId == null) return;
    const c = cands.find(x => x.id === dragId);
    setDragId(null);
    if (c && c.stage !== stageKey) setStage.mutate({ id: c.id, stage: stageKey });
  };

  return (
    <>
      <PageHeader title={t("Рекрутація")} subtitle={t("Воронки кандидатів — від заявки до виходу на роботу")}
        action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати кандидата")}</Button>} />

      {/* Funnel switcher */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {funnels.map(f => (
          <button key={f.id} onClick={() => { setFunnelId(f.id); setHidden(new Set()); }}
            className={cn("rounded-lg px-3 py-1.5 text-sm font-medium transition",
              active.id === f.id ? "bg-red-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-red-300")}>
            {f.name} <span className={cn("ml-1 text-xs", active.id === f.id ? "text-red-100" : "text-slate-400")}>{f.count}</span>
          </button>
        ))}
      </div>

      {/* Toolbar: search + filter */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input placeholder={t("Пошук: ім'я, телефон, Telegram, нотатки…")} value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button variant="secondary" onClick={() => setShowFilter(s => !s)}>
          <SlidersHorizontal className="h-4 w-4" /> {t("Етапи")}{hidden.size > 0 ? ` (${visibleStages.length}/${active.stages.length})` : ""}
        </Button>
        {isFetching && <span className="text-xs text-slate-400">{t("Завантаження…")}</span>}
      </div>
      {showFilter && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {active.stages.map(s => {
            const on = !hidden.has(s.key);
            return (
              <button key={s.key} onClick={() => setHidden(prev => { const n = new Set(prev); n.has(s.key) ? n.delete(s.key) : n.add(s.key); return n; })}
                className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition",
                  on ? "bg-slate-100 text-slate-700" : "bg-white text-slate-300 ring-1 ring-slate-200")}>
                <span className={cn("h-2 w-2 rounded-full", on ? dotClass(s.color) : "bg-slate-200")} /> {s.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Horizontal kanban */}
      <div className="-mx-4 overflow-x-auto px-4 pb-3 md:-mx-8 md:px-8">
        <div className="flex gap-3" style={{ minWidth: "min-content" }}>
          {visibleStages.map(s => {
            const list = byStage.get(s.key) ?? [];
            return (
              <div key={s.key} onDragOver={e => e.preventDefault()} onDrop={() => drop(s.key)}
                className={cn("flex w-72 shrink-0 flex-col rounded-xl border border-t-4 border-slate-200 bg-slate-50/60", topClass(s.color))}>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-sm font-semibold text-slate-700">{s.label}</span>
                  <span className="rounded-full bg-white px-2 text-xs font-medium text-slate-500">{list.length}</span>
                </div>
                <div className="flex-1 space-y-2 px-2 pb-2">
                  {list.map(c => (
                    <CandidateCard key={c.id} c={c} isReferral={!!isReferral} onDragStart={() => setDragId(c.id)}
                      onOpen={() => setDetailId(c.id)}
                      onDelete={async () => { if (await confirm({ title: t("Видалити {name}?", { name: c.fullName }), danger: true, confirmText: t("Видалити") })) remove.mutate(c.id); }} />
                  ))}
                  {!list.length && <div className="px-1 py-3 text-center text-xs text-slate-300">{t("порожньо")}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-400">💡 {t("Перетягуйте картки між колонками, щоб змінити етап. Гортайте вбік, щоб побачити всі етапи.")}</p>

      {detailId != null && active && (
        <CandidateDetail id={detailId} funnel={active} factories={factories} workers={workers} staff={staff} meId={me?.id ?? null}
          onClose={() => setDetailId(null)} onChanged={() => { inv(); qc.invalidateQueries({ queryKey: ["funnels"] }); }}
          onEdit={c => setEditing(c)} onConvert={c => setConverting(c)} onBonus={c => setBonusFor(c)} />
      )}
      {adding && active && <CandidateModal funnel={active} factories={factories} workers={workers} staff={staff} onClose={() => setAdding(false)} onSaved={() => { inv(); qc.invalidateQueries({ queryKey: ["funnels"] }); setAdding(false); }} />}
      {editing && active && <CandidateModal candidate={editing} funnel={active} factories={factories} workers={workers} staff={staff} onClose={() => setEditing(null)} onSaved={() => { inv(); qc.invalidateQueries({ queryKey: ["candidate"] }); setEditing(null); }} />}
      {converting && <ConvertModal candidate={converting} factories={factories} onClose={() => setConverting(null)} onDone={() => { inv(); qc.invalidateQueries({ queryKey: ["workers"] }); setConverting(null); }} />}
      {bonusFor && <BonusModal candidate={bonusFor} onClose={() => setBonusFor(null)} onDone={() => { inv(); setBonusFor(null); }} />}
    </>
  );
}

function CandidateCard({ c, isReferral, onDragStart, onOpen, onDelete }: {
  c: Candidate; isReferral: boolean; onDragStart: () => void; onOpen: () => void; onDelete: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  return (
    <div draggable onDragStart={onDragStart} onClick={onOpen}
      className="group cursor-pointer rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition hover:border-red-300 hover:shadow active:cursor-grabbing">
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 font-medium text-slate-800">{c.fullName}</div>
        <button onClick={onDelete} className="shrink-0 rounded p-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600" title={t("Видалити")}><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      {c.phone && <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500"><Phone className="h-3 w-3" /> {c.phone}</div>}
      {c.telegramId && <div className="flex items-center gap-1 text-xs text-slate-400"><Send className="h-3 w-3" /> {c.telegramId}</div>}
      {isReferral && c.referrerName && <div className="mt-1 text-xs text-slate-500">🙋 {t("Запросив:")} <span className="font-medium text-slate-700">{c.referrerName}</span></div>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {c.factoryName && <Badge color="slate">{c.factoryName}</Badge>}
        {c.workerId && (c.workerActive ? <Badge color="green">👷 {t("активний")}{c.workerCode ? ` · ${c.workerCode}` : ""}</Badge> : <Badge color="slate">{t("переведений")}</Badge>)}
        {isReferral && c.workerId && (c.bonusPaid
          ? <Badge color="red">💰 {t("бонус виплачено")}{c.bonusAmount != null ? ` · ${c.bonusAmount} zł` : ""}</Badge>
          : c.referrerName ? <Badge color="amber">⏳ {t("бонус очікує")}</Badge> : null)}
      </div>
      {/* CRM footer: assignee + follow-up */}
      <div className="mt-2 flex items-center gap-2">
        {c.assignedName
          ? <span className="inline-flex items-center gap-1 text-xs text-slate-500" title={t("В обробці: {name}", { name: c.assignedName })}>
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-[9px] font-bold text-red-700">{initials(c.assignedName)}</span>
            </span>
          : <span className="text-[11px] text-slate-300">{t("не призначено")}</span>}
        {c.nextActionAt && (
          <span className={cn("ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            overdue(c.nextActionAt) ? "bg-rose-50 text-rose-600" : "bg-sky-50 text-sky-600")}>
            <Clock className="h-3 w-3" /> {fmtWhen(c.nextActionAt)}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Candidate detail drawer (CRM) ─────────────────────────────────────────────
const ACT_ICON: Record<string, any> = {
  created: Plus, stage: ArrowRightLeft, assigned: Hand, note: StickyNote, call: PhoneCall,
  message: MessageSquare, meeting: CalendarClock, converted: UserCheck, bonus: Gift, updated: Pencil, funnel: ArrowRightLeft,
};

function CandidateDetail({ id, funnel, factories, workers, staff, meId, onClose, onChanged, onEdit, onConvert, onBonus }: {
  id: number; funnel: Funnel; factories: Factory[]; workers: Worker[]; staff: Staff[]; meId: number | null;
  onClose: () => void; onChanged: () => void; onEdit: (c: Candidate) => void; onConvert: (c: Candidate) => void; onBonus: (c: Candidate) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const isReferral = funnel.kind === "referral";
  const { data: c, isLoading } = useQuery<Candidate>({ queryKey: ["candidate", id], queryFn: () => get(`/candidates/${id}`) });
  const [note, setNote] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["candidate", id] }); onChanged(); };

  const setStage = useMutation({ mutationFn: (stage: string) => patch(`/candidates/${id}`, { stage }), onSuccess: refresh, onError: (e: any) => toast.error(e.message) });
  const assign = useMutation({ mutationFn: (adminId: number | null) => post(`/candidates/${id}/assign`, { adminId }), onSuccess: refresh, onError: (e: any) => toast.error(e.message) });
  const followup = useMutation({ mutationFn: (when: string | null) => post(`/candidates/${id}/followup`, { when }), onSuccess: refresh, onError: (e: any) => toast.error(e.message) });
  const addAct = useMutation({
    mutationFn: (v: { kind: string; detail: string }) => post(`/candidates/${id}/activity`, v),
    onSuccess: () => { setNote(""); refresh(); }, onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={isLoading || !c ? t("Кандидат") : c.fullName} size="xl">
      {isLoading || !c ? <Spinner /> : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* Left: details + actions */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={c.stage} onChange={e => setStage.mutate(e.target.value)} className="w-44">
                {funnel.stages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
              <Badge color="slate">{funnel.name}</Badge>
              <button onClick={() => onEdit(c)} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" /> {t("Редагувати")}</button>
            </div>

            <div className="rounded-xl border border-slate-200 p-3 text-sm">
              {c.phone && <div className="flex items-center gap-2 text-slate-600"><Phone className="h-3.5 w-3.5 text-slate-400" /> {c.phone}</div>}
              {c.email && <div className="flex items-center gap-2 text-slate-600"><Mail className="h-3.5 w-3.5 text-slate-400" /> {c.email}</div>}
              {c.telegramId && <div className="flex items-center gap-2 text-slate-600"><Send className="h-3.5 w-3.5 text-slate-400" /> {c.telegramId}</div>}
              {c.factoryName && <div className="flex items-center gap-2 text-slate-600"><UsersIcon className="h-3.5 w-3.5 text-slate-400" /> {c.factoryName}</div>}
              {isReferral && c.referrerName && <div className="mt-1 text-slate-500">🙋 {t("Запросив:")} <b className="text-slate-700">{c.referrerName}</b></div>}
              {c.notes && <div className="mt-1 whitespace-pre-line text-slate-600">📝 {c.notes}</div>}
              {!c.phone && !c.email && !c.telegramId && !c.factoryName && !c.notes && <div className="text-slate-400">{t("Немає контактних даних")}</div>}
            </div>

            {/* Assignment */}
            <div>
              <Label>{t("Відповідальний (хто в обробці)")}</Label>
              <div className="flex gap-2">
                <Select value={c.assignedAdminId ?? ""} onChange={e => assign.mutate(e.target.value ? Number(e.target.value) : null)} className="flex-1">
                  <option value="">{t("— не призначено —")}</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                {c.assignedAdminId !== meId && meId != null && (
                  <Button variant="secondary" onClick={() => assign.mutate(meId)} loading={assign.isPending}><Hand className="h-4 w-4" /> {t("Взяти")}</Button>
                )}
              </div>
            </div>

            {/* Follow-up */}
            <div>
              <Label>{t("Наступний контакт")}</Label>
              <div className="flex gap-2">
                <Input type="datetime-local" value={toLocalInput(c.nextActionAt)} onChange={e => followup.mutate(e.target.value ? new Date(e.target.value).toISOString() : null)} className="flex-1" />
                {c.nextActionAt && <Button variant="secondary" onClick={() => followup.mutate(null)}>✕</Button>}
              </div>
            </div>

            {/* Referral actions */}
            {isReferral && (
              <div className="flex gap-2">
                {!c.workerId
                  ? <Button variant="success" className="flex-1" onClick={() => onConvert(c)}><UserCheck className="h-4 w-4" /> {t("У працівники")}</Button>
                  : c.referrerName && !c.bonusPaid
                    ? <Button className="flex-1" onClick={() => onBonus(c)}><Gift className="h-4 w-4" /> {t("Виписати бонус")}</Button>
                    : null}
              </div>
            )}
          </div>

          {/* Right: activity timeline */}
          <div className="flex flex-col">
            <div className="mb-2 text-sm font-semibold text-slate-700">{t("Історія дій")}</div>
            {/* quick log */}
            <div className="mb-2 flex flex-wrap gap-1.5">
              <button onClick={() => addAct.mutate({ kind: "call", detail: t("Телефонний дзвінок") })} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><PhoneCall className="h-3.5 w-3.5" /> {t("Дзвінок")}</button>
              <button onClick={() => addAct.mutate({ kind: "message", detail: t("Написав повідомлення") })} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><MessageSquare className="h-3.5 w-3.5" /> {t("Повідомлення")}</button>
              <button onClick={() => addAct.mutate({ kind: "meeting", detail: t("Зустріч / співбесіда") })} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><CalendarClock className="h-3.5 w-3.5" /> {t("Зустріч")}</button>
            </div>
            <div className="mb-3 flex gap-2">
              <Input value={note} onChange={e => setNote(e.target.value)} placeholder={t("Додати нотатку…")} onKeyDown={e => { if (e.key === "Enter" && note.trim()) addAct.mutate({ kind: "note", detail: note.trim() }); }} />
              <Button onClick={() => note.trim() && addAct.mutate({ kind: "note", detail: note.trim() })} loading={addAct.isPending}>{t("Додати")}</Button>
            </div>
            <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
              {(c.activity ?? []).length === 0 && <div className="py-6 text-center text-sm text-slate-400">{t("Ще немає дій")}</div>}
              {(c.activity ?? []).map(a => {
                const Icon = ACT_ICON[a.kind] ?? StickyNote;
                return (
                  <div key={a.id} className="flex gap-2 text-sm">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500"><Icon className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-slate-700">{a.detail || a.kind}</div>
                      <div className="text-[11px] text-slate-400">{a.adminName ? `${a.adminName} · ` : ""}{fmtWhen(a.createdAt)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ISO → value for <input type="datetime-local"> (local time, no seconds)
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso); const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CandidateModal({ candidate, funnel, factories, workers, staff, onClose, onSaved }: {
  candidate?: Candidate; funnel: Funnel; factories: Factory[]; workers: Worker[]; staff: Staff[]; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const isEdit = !!candidate;
  const [fullName, setFullName] = useState(candidate?.fullName ?? "");
  const [phone, setPhone] = useState(candidate?.phone ?? "");
  const [email, setEmail] = useState(candidate?.email ?? "");
  const [stage, setStage] = useState(candidate?.stage ?? funnel.stages[0]?.key ?? "");
  const [factoryId, setFactoryId] = useState(candidate?.factoryId ? String(candidate.factoryId) : "");
  const [referrerWorkerId, setReferrerWorkerId] = useState(candidate?.referrerWorkerId ? String(candidate.referrerWorkerId) : "");
  const [assignedAdminId, setAssignedAdminId] = useState(candidate?.assignedAdminId ? String(candidate.assignedAdminId) : "");
  const [notes, setNotes] = useState(candidate?.notes ?? "");
  const isReferral = funnel.kind === "referral";
  const body = () => ({
    fullName, phone, email, notes, stage, funnelId: funnel.id,
    factoryId: factoryId ? Number(factoryId) : null,
    referrerWorkerId: referrerWorkerId ? Number(referrerWorkerId) : null,
    assignedAdminId: assignedAdminId ? Number(assignedAdminId) : null,
  });
  const save = useMutation({
    mutationFn: () => isEdit ? patch(`/candidates/${candidate!.id}`, body()) : post(`/candidates`, body()),
    onSuccess: () => { toast.success(isEdit ? t("Збережено") : t("Додано")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={isEdit ? t("Редагувати кандидата") : t("Новий кандидат")}>
      <div className="space-y-3">
        <div><Label>{t("Ім'я та прізвище")}</Label><Input value={fullName} onChange={e => setFullName(e.target.value)} autoFocus /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{t("Телефон")}</Label><Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+48…" /></div>
          <div><Label>Email</Label><Input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@…" /></div>
        </div>
        <div><Label>{t("Відповідальний")}</Label>
          <Select value={assignedAdminId} onChange={e => setAssignedAdminId(e.target.value)}>
            <option value="">{t("— не призначено —")}</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div><Label>{t("Етап")}</Label>
          <Select value={stage} onChange={e => setStage(e.target.value)}>
            {funnel.stages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
        </div>
        <div><Label>{t("Фабрика (куди плануємо)")}</Label>
          <Select value={factoryId} onChange={e => setFactoryId(e.target.value)}>
            <option value="">{t("— не обрано —")}</option>
            {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>
        {isReferral && (
          <div><Label>{t("Хто запросив (працівник)")}</Label>
            <Select value={referrerWorkerId} onChange={e => setReferrerWorkerId(e.target.value)}>
              <option value="">{t("— ніхто / самостійно —")}</option>
              {workers.filter(w => w.isActive).map(w => <option key={w.id} value={w.id}>{w.fullName}</option>)}
            </Select>
          </div>
        )}
        <div><Label>{t("Нотатки")}</Label><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t("коментар рекрутера")} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => fullName.trim() && save.mutate()}>{isEdit ? t("Зберегти") : t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ConvertModal({ candidate, factories, onClose, onDone }: { candidate: Candidate; factories: Factory[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [factoryId, setFactoryId] = useState(candidate.factoryId ? String(candidate.factoryId) : "");
  const convert = useMutation({
    mutationFn: () => post(`/candidates/${candidate.id}/convert`, { factoryId: factoryId ? Number(factoryId) : null }),
    onSuccess: () => { toast.success(t("{name} — тепер активний працівник", { name: candidate.fullName })); onDone(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Перевести в працівники")}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{t("Створити активного працівника")} <b>{candidate.fullName}</b>{candidate.telegramId ? t(" (з його Telegram)") : ""}. {t("Далі можна буде виписати бонус тому, хто запросив.")}</p>
        <div><Label>{t("Фабрика")}</Label>
          <Select value={factoryId} onChange={e => setFactoryId(e.target.value)}>
            <option value="">{t("— без фабрики —")}</option>
            {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={convert.isPending} onClick={() => convert.mutate()}>{t("Перевести")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function BonusModal({ candidate, onClose, onDone }: { candidate: Candidate; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [amount, setAmount] = useState(candidate.bonusAmount != null ? String(candidate.bonusAmount) : "");
  const pay = useMutation({
    mutationFn: () => post(`/candidates/${candidate.id}/bonus`, { bonusPaid: true, bonusAmount: amount.trim() === "" ? null : Number(amount.replace(",", ".")) }),
    onSuccess: () => { toast.success(t("Бонус позначено виплаченим")); onDone(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Виписати бонус")}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{t("Бонус за запрошення")} <b>{candidate.fullName}</b> {t("для")} <b>{candidate.referrerName}</b>. {t("Після підтвердження він отримає сповіщення в Telegram.")}</p>
        <div><Label>{t("Сума бонусу (zł, необов'язково)")}</Label><Input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder={t("напр. 200")} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={pay.isPending} onClick={() => pay.mutate()}>{t("Позначити виплаченим")}</Button>
        </div>
      </div>
    </Modal>
  );
}
