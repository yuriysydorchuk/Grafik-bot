// «Лінки реєстрації» (/signup-links, cap signupLinks, 11.10.2026): персональний лінк/QR
// рекрутера чи офіс-менеджера на фабрику (?start=rec<токен> у бота → скан паспорта + анкета).
// Хто зареєструвався — записується за лінком (workers.signup_link_id): лічильники тут,
// список людей у модалці, рядок «Привів(ла)» у профілі. Головний/owner бачать усіх рекрутерів.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, QrCode, RefreshCw, Users, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { get, post, type Factory } from "../lib/api";
import { Button, Select, Card, Spinner, Modal, Empty, Badge } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useMe } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useConfirm } from "../components/confirm";

interface SignupLinkRow {
  id: number; token: string; url: string; factoryId: number; factoryName: string;
  adminId: number; adminName: string; createdAt: string; rotatedAt: string | null;
  registered: number; active: number; started: number;
}
interface LinkWorker {
  id: number; fullName: string; workerCode: string | null; factoryId: number | null; factoryName: string | null;
  createdAt: string; firstWorkDate: string | null; isActive: boolean; firedAt: string | null;
}

const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleDateString("pl-PL") : "—";
const qrSrc = (id: number, token: string) => `/api/signup-links/${id}/qr.png?v=${token}`; // token у query — щоб після «Оновити» картинка не бралась із кешу

export default function SignupLinks() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const seesAll = !!me && (me.isMain || me.role === "owner");
  const [all, setAll] = useState(false);
  const showAll = seesAll && all;
  const { data: links, isLoading } = useQuery<SignupLinkRow[]>({ queryKey: ["signup-links", showAll], queryFn: () => get(`/signup-links${showAll ? "?all=1" : ""}`) });
  const { data: factories } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const [factoryId, setFactoryId] = useState("");
  const [qrFor, setQrFor] = useState<SignupLinkRow | null>(null);
  const [listFor, setListFor] = useState<SignupLinkRow | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["signup-links"] });

  const copy = (url: string) => { navigator.clipboard?.writeText(url); toast.success(t("Лінк скопійовано"), { description: url }); };
  const create = useMutation({
    mutationFn: (fid: number) => post<SignupLinkRow>("/signup-links", { factoryId: fid }),
    onSuccess: (r) => { inv(); copy(r.url); },
    onError: (e: any) => toast.error(e.message),
  });
  const rotate = useMutation({
    mutationFn: (id: number) => post<SignupLinkRow>(`/signup-links/${id}/rotate`),
    onSuccess: (r) => { inv(); setQrFor(q => (q && q.id === r.id ? r : q)); toast.success(t("Лінк оновлено — старий більше не працює")); },
    onError: (e: any) => toast.error(e.message),
  });
  const onRotate = async (l: SignupLinkRow) => {
    if (!(await confirm({ title: t("Оновити лінк для «{name}»? Старий лінк і QR перестануть працювати; уже зареєстровані люди лишаться за вами.", { name: l.factoryName }), confirmText: t("Так, оновити"), danger: true }))) return;
    rotate.mutate(l.id);
  };

  const pickable = (factories ?? []).filter(f => !f.isOffice);
  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title={t("Лінки реєстрації")} subtitle={t("Персональний лінк або QR на фабрику: хто зареєструється за ним — записується як приведений вами (видно в профілі працівника).")} />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56">
            <div className="mb-1 text-xs font-medium text-slate-500">{t("Фабрика")}</div>
            <Select value={factoryId} onChange={e => setFactoryId(e.target.value)}>
              <option value="">{t("Оберіть фабрику")}</option>
              {pickable.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </div>
          <Button onClick={() => factoryId && create.mutate(Number(factoryId))} disabled={!factoryId || create.isPending}><Link2 className="h-4 w-4" /> {t("Отримати лінк")}</Button>
          {seesAll && (
            <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5 text-sm">
              <button type="button" onClick={() => setAll(false)} className={`rounded-md px-3 py-1 ${!all ? "bg-white font-medium text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{t("Мої лінки")}</button>
              <button type="button" onClick={() => setAll(true)} className={`rounded-md px-3 py-1 ${all ? "bg-white font-medium text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{t("Усі рекрутери")}</button>
            </div>
          )}
        </div>
      </Card>

      {!links?.length ? <Empty>{t("Немає лінків — оберіть фабрику вгорі й отримайте свій лінк.")}</Empty> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">{t("Фабрика")}</th>
                {showAll && <th className="px-3 py-2">{t("Рекрутер")}</th>}
                <th className="px-3 py-2">{t("Лінк")}</th>
                <th className="px-3 py-2 text-right">{t("Зареєстровано")}</th>
                <th className="px-3 py-2 text-right">{t("Активних")}</th>
                <th className="px-3 py-2 text-right">{t("Вийшли на роботу")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {links.map(l => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium">{l.factoryName}</td>
                  {showAll && <td className="px-3 py-2">{l.adminName}</td>}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <code className="max-w-72 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs" title={l.url}>{l.url}</code>
                      <button type="button" onClick={() => copy(l.url)} className="rounded p-1 text-slate-500 hover:bg-slate-100" title={t("Копіювати")}><Copy className="h-4 w-4" /></button>
                      <button type="button" onClick={() => setQrFor(l)} className="rounded p-1 text-slate-500 hover:bg-slate-100" title={t("QR-код")}><QrCode className="h-4 w-4" /></button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => setListFor(l)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-blue-700 hover:bg-blue-50" title={t("Зареєстровані за лінком")}><Users className="h-3.5 w-3.5" /> {l.registered}</button>
                  </td>
                  <td className="px-3 py-2 text-right">{l.active}</td>
                  <td className="px-3 py-2 text-right">{l.started}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => onRotate(l)} disabled={rotate.isPending} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100" title={t("Оновити лінк")}><RefreshCw className="h-3.5 w-3.5" /> {t("Оновити лінк")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={!!qrFor} onClose={() => setQrFor(null)} title={qrFor ? `${t("QR-код")} — ${qrFor.factoryName}` : ""}>
        {qrFor && (
          <div className="flex flex-col items-center gap-3">
            <img src={qrSrc(qrFor.id, qrFor.token)} alt="QR" className="h-64 w-64 rounded-lg bg-white p-2" />
            <p className="text-center text-xs text-slate-500">{t("Роздрукуйте QR або надішліть лінк: {url}", { url: qrFor.url })}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => copy(qrFor.url)}><Copy className="h-4 w-4" /> {t("Копіювати")}</Button>
              <a href={qrSrc(qrFor.id, qrFor.token)} download={`qr-${qrFor.factoryName}.png`} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"><QrCode className="h-4 w-4" /> PNG</a>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!listFor} onClose={() => setListFor(null)} title={listFor ? `${t("Зареєстровані за лінком")} — ${listFor.factoryName}` : ""} size="lg">
        {listFor && <LinkWorkers linkId={listFor.id} />}
      </Modal>
    </>
  );
}

function LinkWorkers({ linkId }: { linkId: number }) {
  const t = useT();
  const { data, isLoading } = useQuery<LinkWorker[]>({ queryKey: ["signup-link-workers", linkId], queryFn: () => get(`/signup-links/${linkId}/workers`) });
  if (isLoading) return <Spinner />;
  if (!data?.length) return <Empty>{t("Ніхто ще не зареєструвався за цим лінком.")}</Empty>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase text-slate-500">
        <tr><th className="py-1 pr-3">{t("Працівник")}</th><th className="py-1 pr-3">{t("Фабрика")}</th><th className="py-1 pr-3">{t("Дата реєстрації")}</th><th className="py-1 pr-3">{t("Перший робочий день")}</th><th className="py-1">{t("Статус")}</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.map(w => (
          <tr key={w.id}>
            <td className="py-1.5 pr-3"><Link href={`/workers/${w.id}`} className="font-medium text-blue-700 hover:underline">{w.fullName}</Link>{w.workerCode && <span className="ml-1 font-mono text-xs text-slate-400">{w.workerCode}</span>}</td>
            <td className="py-1.5 pr-3">{w.factoryName ?? "—"}</td>
            <td className="py-1.5 pr-3">{fmtDate(w.createdAt)}</td>
            <td className="py-1.5 pr-3">{fmtDate(w.firstWorkDate)}</td>
            <td className="py-1.5">{w.isActive ? <Badge color="green">{t("Активний")}</Badge> : <Badge color="rose">{t("Звільнений")}</Badge>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
