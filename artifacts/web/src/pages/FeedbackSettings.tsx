// Налаштування → Зголошення (лише головний адмін): миттєвий пуш по вагах/типах, нагадування
// й автопідтвердження, ролі без віджета, підказка дубля.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, put, type RoleDef } from "../lib/api";
import { Card, Spinner, Input } from "../components/ui";
import { useT } from "../lib/i18n";
import type { FeedbackSettings as S } from "../lib/feedbackApi";

const INSTANT: { k: string; label: string }[] = [
  { k: "blocks", label: "проблема · блокує роботу" }, { k: "hinders", label: "проблема · заважає" }, { k: "minor", label: "проблема · дрібниця" }, { k: "wish", label: "побажання" }, { k: "question", label: "питання" },
];

export function FeedbackSettings() {
  const t = useT();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery<S>({ queryKey: ["feedback-settings"], queryFn: () => get("/feedback/admin/settings") });
  const { data: roles = [] } = useQuery<RoleDef[]>({ queryKey: ["roles"], queryFn: () => get("/roles") });
  const save = useMutation({ mutationFn: (v: Partial<S>) => put<S>("/feedback/admin/settings", v), onSuccess: r => { qc.setQueryData(["feedback-settings"], r); toast.success(t("Збережено")); }, onError: (e: any) => toast.error(e.message) });
  if (isLoading || !s) return <Spinner />;
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter(x => x !== k) : [...list, k]);
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-700">{t("Миттєвий пуш головному")}</h3>
        <p className="mb-3 text-xs text-slate-400">{t("Решта зголошень потрапляє у вечірній підсумок (час вечірнього підсумку задач). Тип сповіщення «Зголошення» вмикається в ролях.")}</p>
        <div className="flex flex-wrap gap-3">
          {INSTANT.map(x => <label key={x.k} className="flex items-center gap-1.5 text-sm text-slate-700"><input type="checkbox" checked={s.instantKinds.includes(x.k)} onChange={() => save.mutate({ instantKinds: toggle(s.instantKinds, x.k) })} />{t(x.label)}</label>)}
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-700">{t("Підтвердження автора")}</h3>
        <p className="mb-3 text-xs text-slate-400">{t("Після статусу «виправлено» автор отримує пуш із кнопками «Працює» / «Досі ні».")}</p>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">{t("Нагадати через, днів")}<Input type="number" min={0} className="w-20" defaultValue={s.remindDays} onBlur={e => { const v = Number(e.target.value); if (v !== s.remindDays) save.mutate({ remindDays: v }); }} /><span className="text-xs text-slate-400">({t("0 = не нагадувати")})</span></label>
          <label className="flex items-center gap-2">{t("Автопідтвердити через, днів")}<Input type="number" min={1} className="w-20" defaultValue={s.confirmDays} onBlur={e => { const v = Number(e.target.value); if (v !== s.confirmDays) save.mutate({ confirmDays: v }); }} /></label>
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-700">{t("Інше")}</h3>
        <label className="mb-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={s.dedupHint} onChange={e => save.mutate({ dedupHint: e.target.checked })} />{t("Підказка дубля під час набору («схоже на №…», «у мене теж»)")}</label>
        <label className="mb-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={s.packWarn} onChange={e => save.mutate({ packWarn: e.target.checked })} />{t("Попереджати перед «Пакетом для Claude» про незамазані скріншоти з фінансових сторінок")}</label>
        <p className="mb-3 text-xs text-slate-400">{t("Буфер «хлібних крихт»: останні 5 хв або 200 подій у вкладці, на сервер іде лише зі зголошенням; значення текстових полів не записуються.")}</p>
        <div className="mb-1 text-xs font-semibold uppercase text-slate-400">{t("Ролі без віджета")}</div>
        <p className="mb-2 text-xs text-slate-400">{t("Кнопка зголошення не показується цим ролям (головний бачить завжди).")}</p>
        <div className="flex flex-wrap gap-3">
          {roles.filter(r => r.key !== "owner").map(r => <label key={r.key} className="flex items-center gap-1.5 text-sm text-slate-700"><input type="checkbox" checked={s.widgetOffRoles.includes(r.key)} onChange={() => save.mutate({ widgetOffRoles: toggle(s.widgetOffRoles, r.key) })} />{r.label}</label>)}
        </div>
      </Card>
    </div>
  );
}
