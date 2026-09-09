// Налаштування → Задачі: автоправила, загальні параметри, відповідальні по фабриках, шаблони.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Play } from "lucide-react";
import { get, post, patch, del, type Factory } from "../lib/api";
import { type AutoRuleRow, type TaskSettings, type TaskAdmin, type TaskTemplate } from "../lib/tasksApi";
import { Card, Spinner, Input, Label, Button, Select, Modal, Textarea, Badge } from "../components/ui";
import { useT } from "../lib/i18n";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";

export function TasksSettings() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = can(me, "tasksManage");
  const { data, isLoading } = useQuery<{ rules: AutoRuleRow[]; settings: TaskSettings }>({ queryKey: ["task-auto-rules"], queryFn: () => get("/task-auto-rules") });
  const { data: admins = [] } = useQuery<TaskAdmin[]>({ queryKey: ["task-admins"], queryFn: () => get("/tasks/admins") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const inv = () => { qc.invalidateQueries({ queryKey: ["task-auto-rules"] }); qc.invalidateQueries({ queryKey: ["factories"] }); };
  const upd = useMutation({ mutationFn: (v: { code: string; body: Record<string, unknown> }) => patch(`/task-auto-rules/${v.code}`, v.body), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const facUpd = useMutation({ mutationFn: (v: { id: number; body: Record<string, unknown> }) => patch(`/factories/${v.id}`, v.body), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const run = useMutation({ mutationFn: () => post<{ created: number; updated: number; resolved: number; reopened: number }>("/tasks/auto-run", { recompute: true }), onSuccess: r => { qc.invalidateQueries({ queryKey: ["tasks"] }); toast.success(t("Готово: створено {c}, оновлено {u}, закрито {r}", { c: r.created, u: r.updated, r: r.resolved })); }, onError: (e: any) => toast.error(e.message) });
  const [ladder, setLadder] = useState<string | null>(null);
  if (isLoading || !data) return <Spinner />;
  const s = data.settings;
  const admSel = (value: number | null, onChange: (v: number | null) => void, dis?: boolean) => (
    <select value={value ?? ""} disabled={dis} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)} className="rounded border border-slate-200 bg-white px-1.5 py-1 text-xs disabled:opacity-60"><option value="">—</option>{admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
  );
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-700">{t("Автозадачі")}</h3>{canManage && <Button variant="secondary" className="px-2.5 py-1 text-xs" loading={run.isPending} onClick={() => run.mutate()}><Play className="h-3.5 w-3.5" /> {t("Запустити зараз")}</Button>}</div>
        <p className="mb-3 text-xs text-slate-400">{t("Щоночі о 06:30 система перераховує легальність і створює одну задачу на випадок. Коли причина зникає, задача закривається сама. Масові випадки по фабриці згортаються в одну задачу, коли їх більше за поріг.")}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] uppercase tracking-wide text-slate-400"><th className="py-1.5 pr-2">{t("Джерело")}</th><th className="py-1.5 pr-2">{t("Увімк.")}</th><th className="py-1.5 pr-2">{t("За скільки днів")}</th><th className="py-1.5 pr-2">{t("Кому, якщо нема відповідального")}</th></tr></thead>
            <tbody>
              {data.rules.map(r => (
                <tr key={r.code} className="border-t border-slate-50">
                  <td className="py-1.5 pr-2"><div className="font-medium">{t(r.label)}</div><div className="text-xs text-slate-400">{t(r.description)}</div></td>
                  <td className="py-1.5 pr-2"><input type="checkbox" checked={r.enabled} disabled={!canManage} onChange={e => upd.mutate({ code: r.code, body: { enabled: e.target.checked } })} /></td>
                  <td className="py-1.5 pr-2">{r.code === "ua_notification" ? <span className="flex items-center gap-1 text-xs text-slate-500">{t("на")} <input type="number" min={1} defaultValue={Number(r.params?.stage1Days ?? 3)} disabled={!canManage} onBlur={e => upd.mutate({ code: r.code, body: { params: { stage1Days: Number(e.target.value) || 3 } } })} className="w-12 rounded border border-slate-200 px-1.5 py-1 text-xs" />-й {t("день роботи")}</span> : r.leadDays == null && !["doc_expiring", "contract", "absence_unexplained", "candidate_stale", "termination_zus"].includes(r.code) ? <span className="text-xs text-slate-400">{t("одразу")}</span> : <input type="number" min={0} defaultValue={r.leadDays ?? ""} disabled={!canManage} onBlur={e => upd.mutate({ code: r.code, body: { leadDays: e.target.value === "" ? null : Number(e.target.value) } })} className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs" placeholder={r.code === "doc_expiring" ? t("з правила") : ""} />}</td>
                  <td className="py-1.5 pr-2">{admSel(r.fallbackAdminId, v => upd.mutate({ code: r.code, body: { fallbackAdminId: v } }), !canManage)}{r.scheduler && <span className="ml-1 text-[10px] text-slate-400">{t("(спершу графікова фабрики)")}</span>}{r.code === "ua_notification" && <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-500">{t("Ступінь 2 (подає на praca.gov.pl)")}: {admSel((r.params?.stage2AdminId as number | null) ?? null, v => upd.mutate({ code: r.code, body: { params: { stage2AdminId: v } } }), !canManage)}<span className="text-slate-400">{t("порожньо = «кому, якщо нема відповідального» / головний")}</span></div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
          <span>{t("Драбина нагадувань")}: {ladder == null ? <b>{s.ladder.join(" · ")}</b> : <input value={ladder} onChange={e => setLadder(e.target.value)} onBlur={() => { upd.mutate({ code: "settings", body: { ladder: ladder.split(/[^\d]+/).filter(Boolean).map(Number) } }); setLadder(null); }} className="w-32 rounded border border-slate-200 px-1.5 py-0.5" autoFocus />} {t("дн.")}{canManage && ladder == null && <button onClick={() => setLadder(s.ladder.join(" "))} className="ml-1 text-slate-400 hover:text-slate-600"><Pencil className="inline h-3 w-3" /></button>}</span>
          <span>{t("Ескалація головному після")} <input type="number" min={0} defaultValue={s.escalationDays} disabled={!canManage} onBlur={e => upd.mutate({ code: "settings", body: { escalationDays: Number(e.target.value) } })} className="w-12 rounded border border-slate-200 px-1 py-0.5" /> {t("дн.")}</span>
          <span>{t("Згортати від")} <input type="number" min={1} defaultValue={s.groupAbove ?? 5} disabled={!canManage} onBlur={e => upd.mutate({ code: "settings", body: { groupAbove: Number(e.target.value) } })} className="w-12 rounded border border-slate-200 px-1 py-0.5" /> {t("випадків на фабрику")}</span>
          <span>{t("Дайджест")} <input type="time" defaultValue={s.digestTime} disabled={!canManage} onBlur={e => upd.mutate({ code: "settings", body: { digestTime: e.target.value } })} className="rounded border border-slate-200 px-1 py-0.5" /> · {t("підсумок дня")} <input type="time" defaultValue={s.eveningTime} disabled={!canManage} onBlur={e => upd.mutate({ code: "settings", body: { eveningTime: e.target.value } })} className="rounded border border-slate-200 px-1 py-0.5" /></span>
          <label className="flex items-center gap-1"><input type="checkbox" checked={s.skipWeekends} disabled={!canManage} onChange={e => upd.mutate({ code: "settings", body: { skipWeekends: e.target.checked } })} /> {t("без дайджесту у вихідні")}</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={s.rollover} disabled={!canManage} onChange={e => upd.mutate({ code: "settings", body: { rollover: e.target.checked } })} /> {t("переносити невиконане на наступний день")}</label>
          {/* дата запуску модуля: «старі» без документів/умов не дають движкових задач (services/taskLegacy.ts) */}
          <span title={t("Працівники, додані до цієї дати, у яких досі немає жодного документа й умови, задач легалізації не отримують; зʼявився перший документ або умова — далі як усі. Порожньо = вимкнено.")}>{t("Без задач для доданих до")} <input type="date" defaultValue={s.legacyBefore ?? ""} disabled={!canManage} onBlur={e => upd.mutate({ code: "settings", body: { legacyBefore: e.target.value || null } })} className="rounded border border-slate-200 px-1 py-0.5" /> {t("без документів і умов")}</span>
        </div>
        {/* автозапит документів у працівника (services/docRequests.ts) */}
        <div className="mt-3 rounded-lg border border-violet-100 bg-violet-50/40 p-3 text-xs text-slate-600">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 font-semibold text-slate-700"><input type="checkbox" checked={s.autoRequest} disabled={!canManage} onChange={e => upd.mutate({ code: "settings", body: { autoRequest: e.target.checked } })} /> {t("Автозапит документів у працівника")}</label>
            <span className="text-slate-400">{t("для типів «працівник надсилає сам» (Налаштування → Документи) і людей з Telegram")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span>{t("Нагадати працівнику через")} <input defaultValue={(s.workerLadder ?? [3, 7]).join(", ")} disabled={!canManage || !s.autoRequest} onBlur={e => upd.mutate({ code: "settings", body: { workerLadder: e.target.value.split(/[^\d]+/).filter(Boolean).map(Number) } })} className="w-20 rounded border border-slate-200 px-1 py-0.5" /> {t("дн. після запиту")}</span>
            <span>{t("Задача офісу «не надіслав» після")} <input type="number" min={1} defaultValue={s.silenceDays ?? 7} disabled={!canManage || !s.autoRequest} onBlur={e => upd.mutate({ code: "settings", body: { silenceDays: Number(e.target.value) } })} className="w-12 rounded border border-slate-200 px-1 py-0.5" /> {t("дн. мовчання")}</span>
            <span>{t("Завжди задача офісу, якщо до строку ≤")} <input type="number" min={0} defaultValue={s.officeThresholdDays ?? 7} disabled={!canManage || !s.autoRequest} onBlur={e => upd.mutate({ code: "settings", body: { officeThresholdDays: Number(e.target.value) } })} className="w-12 rounded border border-slate-200 px-1 py-0.5" /> {t("дн.")}</span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">{t("Файл від працівника одразу створює задачу «Перевірити завантажений документ» виконавцю; без Telegram — звичайна задача офісу.")}</p>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">{t("Відповідальні по фабриках")}</h3>
        <p className="mb-3 text-xs text-slate-400">{t("Відповідальний отримує автозадачі по документах, умовах і обов'язках працівників фабрики; графікова — про пропуски без пояснення. Те саме є в картці фабрики.")}</p>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-slate-400"><th className="py-1.5 pr-2">{t("Фабрика")}</th><th className="py-1.5 pr-2">{t("Відповідальний")}</th><th className="py-1.5 pr-2">{t("Графікова")}</th></tr></thead>
          <tbody>{factories.map(f => <tr key={f.id} className="border-t border-slate-50"><td className="py-1.5 pr-2 font-medium">{f.name}{f.companyName && <Badge color="blue">{f.companyName}</Badge>}</td><td className="py-1.5 pr-2">{admSel((f as any).responsibleAdminId ?? null, v => facUpd.mutate({ id: f.id, body: { responsibleAdminId: v } }), !canManage)}{!(f as any).responsibleAdminId && <span className="ml-1 text-[10px] text-amber-600">{t("→ за категорією / головний")}</span>}</td><td className="py-1.5 pr-2">{admSel((f as any).schedulerAdminId ?? null, v => facUpd.mutate({ id: f.id, body: { schedulerAdminId: v } }), !canManage)}</td></tr>)}</tbody>
        </table></div>
      </Card>

      <TemplatesCard canManage={canManage} admins={admins} />
    </div>
  );
}

function TemplatesCard({ canManage, admins }: { canManage: boolean; admins: TaskAdmin[] }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery<TaskTemplate[]>({ queryKey: ["task-templates"], queryFn: () => get("/task-templates") });
  const [edit, setEdit] = useState<Partial<TaskTemplate> | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["task-templates"] });
  const save = useMutation({ mutationFn: (v: Partial<TaskTemplate>) => v.id ? patch(`/task-templates/${v.id}`, v) : post("/task-templates", v), onSuccess: () => { inv(); setEdit(null); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: number) => del(`/task-templates/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });
  const TRIG: Record<string, string> = { manual: "вручну", worker_created: "при реєстрації працівника", worker_fired: "при звільненні" };
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-700">{t("Шаблони задач")}</h3>{canManage && <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setEdit({ kind: "task", checklist: [], trigger: "manual", reviewRequired: false, isActive: true })}><Plus className="h-3.5 w-3.5" /> {t("Новий шаблон")}</Button>}</div>
      <p className="mb-3 text-xs text-slate-400">{t("Чеклісти з кроками: онбординг, звільнення, закриття сводної. У назві можна писати {worker} — підставиться імʼя.")}</p>
      {!templates.length && <div className="text-sm text-slate-400">{t("Шаблонів ще немає")}</div>}
      <ul className="divide-y divide-slate-100 text-sm">{templates.map(x => <li key={x.id} className="flex items-center gap-2 py-2"><span className="font-medium">{x.name}</span><span className="text-xs text-slate-400">{x.checklist.length} {t("кроків")} · {t(TRIG[x.trigger] ?? x.trigger)}{x.recurrence ? ` · 🔁` : ""}{!x.isActive ? ` · ${t("вимкнено")}` : ""}</span>{canManage && <span className="ml-auto flex gap-1"><button onClick={() => setEdit(x)} className="rounded p-1 text-slate-400 hover:bg-slate-100"><Pencil className="h-4 w-4" /></button><button onClick={() => { if (confirm(t("Видалити шаблон?"))) remove.mutate(x.id); }} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button></span>}</li>)}</ul>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? t("Шаблон") : t("Новий шаблон")}>
          <div className="space-y-2 text-sm">
            <div><Label>{t("Назва")}</Label><Input value={edit.name ?? ""} onChange={e => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><Label>{t("Назва задачі")}</Label><Input value={edit.titleTemplate ?? ""} onChange={e => setEdit({ ...edit, titleTemplate: e.target.value })} placeholder="Онбординг: {worker}" /></div>
            <div><Label>{t("Опис")}</Label><Textarea rows={2} value={edit.description ?? ""} onChange={e => setEdit({ ...edit, description: e.target.value })} /></div>
            <div><Label>{t("Кроки (по одному в рядку)")}</Label><Textarea rows={5} value={(edit.checklist ?? []).join("\n")} onChange={e => setEdit({ ...edit, checklist: e.target.value.split("\n").map(x => x.trim()).filter(Boolean) })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>{t("Виконавець за замовч.")}</Label><Select value={edit.defaultAssigneeAdminId ?? ""} onChange={e => setEdit({ ...edit, defaultAssigneeAdminId: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{admins.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></div>
              <div><Label>{t("Строк через, дн.")}</Label><Input type="number" value={edit.dueInDays ?? ""} onChange={e => setEdit({ ...edit, dueInDays: e.target.value ? Number(e.target.value) : null })} /></div>
              <div><Label>{t("Запуск")}</Label><Select value={edit.trigger ?? "manual"} onChange={e => setEdit({ ...edit, trigger: e.target.value as any })}>{Object.entries(TRIG).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</Select></div>
              <div><Label>{t("Повторення")}</Label><Select value={edit.recurrence?.freq ?? ""} onChange={e => setEdit({ ...edit, recurrence: e.target.value ? { freq: e.target.value as any } : null })}><option value="">{t("ні")}</option><option value="daily">{t("щодня")}</option><option value="weekly">{t("щотижня")}</option><option value="monthly">{t("щомісяця")}</option></Select></div>
            </div>
            <div className="flex gap-4 text-xs"><label className="flex items-center gap-1"><input type="checkbox" checked={!!edit.reviewRequired} onChange={e => setEdit({ ...edit, reviewRequired: e.target.checked })} /> {t("перевірити перед закриттям")}</label><label className="flex items-center gap-1"><input type="checkbox" checked={edit.isActive !== false} onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> {t("активний")}</label></div>
            <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={() => setEdit(null)}>{t("Скасувати")}</Button><Button disabled={!edit.name || !edit.titleTemplate} loading={save.isPending} onClick={() => save.mutate(edit)}>{t("Зберегти")}</Button></div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
