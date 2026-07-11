import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldOff, LogOut, Monitor, MapPin } from "lucide-react";
import { toast } from "sonner";
import { get, post, type SessionRow, type LoginEventRow } from "../lib/api";
import { Card, Spinner, Badge, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

const fmt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// A loopback / private-range address has no public geolocation — label it plainly instead of "—".
const isLocalIp = (ip: string | null): boolean => {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/, "");
  return v === "::1" || v === "127.0.0.1" || /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v);
};

const EVENT_LABEL: Record<LoginEventRow["event"], string> = {
  success: "Успішний вхід",
  bad_password: "Невірний пароль",
  bad_2fa: "Невірний 2FA-код",
  no_telegram: "Без Telegram (2FA неможливий)",
  logout: "Вихід",
};
const EVENT_COLOR: Record<LoginEventRow["event"], "green" | "rose" | "amber" | "slate"> = {
  success: "green", bad_password: "rose", bad_2fa: "rose", no_telegram: "amber", logout: "slate",
};

export default function Security() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: sessions, isLoading } = useQuery<SessionRow[]>({ queryKey: ["security-sessions"], queryFn: () => get("/security/sessions") });
  const { data: events } = useQuery<LoginEventRow[]>({ queryKey: ["security-events"], queryFn: () => get("/security/login-events") });
  const inv = () => { qc.invalidateQueries({ queryKey: ["security-sessions"] }); qc.invalidateQueries({ queryKey: ["security-events"] }); };

  const revoke = useMutation({
    mutationFn: (id: string) => post(`/security/sessions/${id}/revoke`),
    onSuccess: () => { inv(); toast.success(t("Сесію заблоковано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const logoutAll = useMutation({
    mutationFn: (adminId: number) => post(`/security/admins/${adminId}/logout-everywhere`),
    onSuccess: () => { inv(); toast.success(t("Вихід на всіх пристроях виконано")); },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Spinner />;

  return (
    <>
      <PageHeader title={t("Безпека / Сесії")} subtitle={t("Хто заходив у панель, коли, звідки — і блокування підозрілих сесій")} />

      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Monitor className="h-4 w-4 text-red-600" /> {t("Активні сесії")}</h3>
      <Card className="overflow-x-auto">
        {!sessions?.length ? <Empty>{t("Немає сесій")}</Empty> : (
          <table className="w-full min-w-140 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">{t("Адмін")}</th>
                <th className="px-4 py-2.5">{t("Пристрій")}</th>
                <th className="px-4 py-2.5">{t("Звідки")}</th>
                <th className="px-4 py-2.5">{t("Вхід")}</th>
                <th className="px-4 py-2.5">{t("Активність")}</th>
                <th className="px-4 py-2.5">{t("Стан")}</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.map(s => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{s.adminName ?? `#${s.adminId}`}{s.current && <span className="ml-2"><Badge color="blue">{t("цей пристрій")}</Badge></span>}</td>
                  <td className="px-4 py-2.5 text-slate-500">{s.device ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">
                    <div className="flex items-center gap-1">{s.geo && <MapPin className="h-3 w-3 text-slate-400" />}{s.geo ?? (isLocalIp(s.ip) ? t("локальна мережа") : "—")}</div>
                    {s.ip && <div className="font-mono text-xs text-slate-500">{s.ip}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 tabular-nums">{fmt(s.createdAt)}</td>
                  <td className="px-4 py-2.5 text-slate-500 tabular-nums">{fmt(s.lastSeenAt)}</td>
                  <td className="px-4 py-2.5">{s.active ? <Badge color="green">{t("активна")}</Badge> : <Badge color="slate">{t("заблокована")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      {s.active && !s.current && (
                        <button onClick={async () => { if (await confirm({ title: t("Заблокувати цю сесію?"), message: `${s.adminName ?? ""} · ${s.device ?? ""} · ${s.geo ?? s.ip ?? ""}`, danger: true, confirmText: t("Заблокувати") })) revoke.mutate(s.id); }}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title={t("Заблокувати сесію")}><ShieldOff className="h-4 w-4" /></button>
                      )}
                      {s.active && (
                        <button onClick={async () => { if (await confirm({ title: t("Вийти на всіх пристроях для {name}?", { name: s.adminName ?? `#${s.adminId}` }), message: t("Усі активні сесії цього адміна буде завершено."), danger: true, confirmText: t("Вийти скрізь") })) logoutAll.mutate(s.adminId); }}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600" title={t("Вийти на всіх пристроях")}><LogOut className="h-4 w-4" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <h3 className="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold text-slate-700">{t("Журнал входів")}</h3>
      <Card className="overflow-x-auto">
        {!events?.length ? <Empty>{t("Журнал порожній")}</Empty> : (
          <table className="w-full min-w-140 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">{t("Коли")}</th>
                <th className="px-4 py-2.5">{t("Подія")}</th>
                <th className="px-4 py-2.5">{t("Адмін / логін")}</th>
                <th className="px-4 py-2.5">{t("Пристрій")}</th>
                <th className="px-4 py-2.5">{t("Звідки")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map(e => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500 tabular-nums">{fmt(e.at)}</td>
                  <td className="px-4 py-2.5"><Badge color={EVENT_COLOR[e.event]}>{t(EVENT_LABEL[e.event])}</Badge></td>
                  <td className="px-4 py-2.5 text-slate-600">{e.adminName ?? e.usernameTried ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">{e.device ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">
                    <div className="flex items-center gap-1">{e.geo && <MapPin className="h-3 w-3 text-slate-400" />}{e.geo ?? (isLocalIp(e.ip) ? t("локальна мережа") : "—")}</div>
                    {e.ip && <div className="font-mono text-xs text-slate-500">{e.ip}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
