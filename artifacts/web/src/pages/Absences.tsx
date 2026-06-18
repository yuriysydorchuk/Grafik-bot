import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { get, post, DAY_UK, SHIFT_UK, type DayCode, type ShiftCode } from "../lib/api";
import { monthOptions } from "../lib/dates";
import { Card, Spinner, Select, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT, useLang } from "../lib/i18n";

interface Absence {
  name: string; code: string | null; factory: string | null;
  date: string; day: DayCode; shift: ShiftCode; reason: string | null; excused: boolean;
}
interface AbsenceRequest {
  id: number; workerId: number; name: string | null; factory: string | null;
  date: string; day: DayCode; shift: ShiftCode; reason: string | null; status: string; createdAt: string;
  substitutes: { id: number; name: string }[];
}

const fmtDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });

export default function Absences() {
  const t = useT();
  const { lang } = useLang();
  const months = useMemo(() => monthOptions(lang === "en" ? "en-US" : "uk-UA"), [lang]);
  const qc = useQueryClient();
  const [month, setMonth] = useState(months[0]!.value);
  const [filter, setFilter] = useState<"all" | "excused" | "noshow">("all");
  const { data, isFetching } = useQuery<{ month: string; absences: Absence[]; total: number; excused: number; noShow: number }>({
    queryKey: ["absences", month], queryFn: () => get(`/absences?month=${month}`),
  });
  const { data: requests = [] } = useQuery<AbsenceRequest[]>({ queryKey: ["absence-requests"], queryFn: () => get("/absence-requests") });
  const pending = requests.filter(r => r.status === "pending");
  const decide = useMutation({
    mutationFn: (v: { id: number; action: "approve" | "reject" }) => post(`/absence-requests/${v.id}/${v.action}`),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["absence-requests"] }); qc.invalidateQueries({ queryKey: ["absences", month] }); toast.success(v.action === "approve" ? t("Прийнято") : t("Відхилено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const substitute = useMutation({
    mutationFn: (v: { id: number; workerId: number }) => post(`/absence-requests/${v.id}/substitute`, { workerId: v.workerId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["absence-requests"] }); qc.invalidateQueries({ queryKey: ["absences", month] }); toast.success(t("Заміну призначено")); },
    onError: (e: any) => toast.error(e.message),
  });

  const rows = useMemo(() => {
    const all = data?.absences ?? [];
    return filter === "all" ? all : all.filter(a => filter === "excused" ? a.excused : !a.excused);
  }, [data, filter]);

  return (
    <>
      <PageHeader title={t("Відсутності")} subtitle={t("Пропуски змін із причинами (із затвердженого графіку)")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <Select value={filter} onChange={e => setFilter(e.target.value as any)} className="w-48">
          <option value="all">{t("Усі пропуски")}</option>
          <option value="excused">{t("Тільки відпросились")}</option>
          <option value="noshow">{t("Тільки нез'явлення")}</option>
        </Select>
        {data && (
          <div className="flex gap-2">
            <Badge color="slate">{t("Усього:")} {data.total}</Badge>
            <Badge color="amber">{t("Відпросились:")} {data.excused}</Badge>
            <Badge color="rose">{t("Нез'явлення:")} {data.noShow}</Badge>
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <Card className="mb-5 border-amber-200 bg-amber-50/40 p-4">
          <div className="mb-2 text-sm font-semibold text-slate-700">🙋 {t("Зголошення відсутності на розгляді")} ({pending.length})</div>
          <div className="space-y-2">
            {pending.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700">{r.name ?? "—"} {r.factory && <Badge color="slate">{r.factory}</Badge>}</div>
                  <div className="text-sm text-slate-500">{fmtDate(r.date)} · {DAY_UK[r.day]} · {SHIFT_UK[r.shift]}</div>
                  {r.reason && <div className="mt-0.5 text-sm text-slate-600">📝 {r.reason}</div>}
                  {r.substitutes.length > 0 ? (
                    <div className="mt-1.5">
                      <div className="text-xs font-medium text-slate-500">{t("Можливі заміни (доступні на цю зміну):")}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.substitutes.map(s => (
                          <button key={s.id} onClick={() => substitute.mutate({ id: r.id, workerId: s.id })} disabled={substitute.isPending}
                            className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                            ↪ {t("Призначити")} {s.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : <div className="mt-1 text-xs text-slate-400">{t("Доступних замін не знайдено")}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => decide.mutate({ id: r.id, action: "approve" })} disabled={decide.isPending} className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Check className="h-4 w-4" /> {t("Прийняти")}</button>
                  <button onClick={() => decide.mutate({ id: r.id, action: "reject" })} disabled={decide.isPending} className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"><X className="h-4 w-4" /> {t("Відхилити")}</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {isFetching && !data ? <Spinner /> : !rows.length ? <Empty>{t("За цей місяць немає пропусків")}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">{t("Дата")}</th><th className="px-4 py-2.5">{t("День")}</th>
                <th className="px-4 py-2.5">{t("Працівник")}</th><th className="px-4 py-2.5">{t("Фабрика")}</th>
                <th className="px-4 py-2.5 text-center">{t("Зміна")}</th><th className="px-4 py-2.5">{t("Тип")}</th>
                <th className="px-4 py-2.5">{t("Причина")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((a, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{fmtDate(a.date)}</td>
                  <td className="px-4 py-2.5 text-slate-500">{DAY_UK[a.day]}</td>
                  <td className="px-4 py-2.5 text-slate-700">{a.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{a.factory ?? "—"}</td>
                  <td className="px-4 py-2.5 text-center text-slate-500">{SHIFT_UK[a.shift]}</td>
                  <td className="px-4 py-2.5">{a.excused ? <Badge color="amber">{t("Відпросився")}</Badge> : <Badge color="rose">{t("Нез'явлення")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-slate-600">{a.reason || <span className="text-slate-300">{t("— без причини —")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
