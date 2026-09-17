// Вкладка «Кампанія «Приведи друга»» на /broadcast (17.09.2026): персональна розсилка
// в бот мовою кожного працівника з його реферальним кодом (API routes/referralCampaign.ts).
// Параметри (суми, дедлайн, телефони) редагуються тут, тексти — bot/i18n.ts camp.*.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Send, Search, Eye } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Empty, Label } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

type Params = {
  rate: number; bonus1: number; bonus3: number; bonus5: number; minShifts: number; friendBonus: number;
  deadline: string; phoneUk: string; phoneEn: string; officeAddress: string; officeHours: string;
};
type Recipient = {
  id: number; fullName: string; telegramId: string | null; language: string | null; isActive: boolean;
  factoryId: number | null; factoryName: string | null; isOffice: boolean; isAdmin: boolean; referralCode: string | null;
};
type Info = { defaults: Params; languages: string[]; recipients: Recipient[] };
type Preview = { worker: string; friend: string; friendBtn: string; link: string };
type SendResult = { notified: number; skipped: number; failed: { id: number; fullName: string; error: string }[] };

const LANG_NAME: Record<string, string> = { uk: "Українська", en: "English", es: "Español", ru: "Русский", pl: "Polski" };

export default function ReferralCampaignPanel() {
  const t = useT();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<Info>({ queryKey: ["referral-campaign"], queryFn: () => get("/referral-campaign") });
  const [params, setParams] = useState<Params | null>(null);
  const [inclActive, setInclActive] = useState(true);
  const [inclFired, setInclFired] = useState(true);
  const [exclOffice, setExclOffice] = useState(true);
  const [exclAdmins, setExclAdmins] = useState(true);
  const [excluded, setExcluded] = useState<Set<number>>(new Set()); // ручні зняті галочки
  const [q, setQ] = useState("");
  const [prevLang, setPrevLang] = useState("uk");
  const [prevActive, setPrevActive] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => { if (data && !params) setParams(data.defaults); }, [data, params]);

  const base = useMemo(() => (data?.recipients ?? []).filter(r =>
    (r.isActive ? inclActive : inclFired) && !(exclOffice && r.isOffice) && !(exclAdmins && r.isAdmin),
  ), [data, inclActive, inclFired, exclOffice, exclAdmins]);
  const chosen = useMemo(() => base.filter(r => !excluded.has(r.id)), [base, excluded]);
  const filtered = useMemo(() => base.filter(r => !q || r.fullName.toLowerCase().includes(q.toLowerCase())), [base, q]);
  const byLang = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of chosen) { const l = r.language || "uk"; m.set(l, (m.get(l) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [chosen]);

  const doPreview = useMutation({
    mutationFn: () => post<Preview>("/referral-campaign/preview", { lang: prevLang, isActive: prevActive, params }),
    onSuccess: setPreview,
    onError: (e: any) => toast.error(e.message),
  });
  const send = useMutation({
    mutationFn: () => post<SendResult>("/referral-campaign/send", { workerIds: chosen.map(r => r.id), params }),
    onSuccess: (r) => toast.success(t("Надіслано: {n}", { n: r.notified }), {
      description: r.failed.length ? t("Не доставлено ({n}): {names}", { n: r.failed.length, names: r.failed.slice(0, 5).map(f => f.fullName).join(", ") }) : undefined,
      duration: 10000,
    }),
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !params) return <Spinner />;

  // зміна умов скидає прев'ю — щоб оператор не підтвердив відправку по застарілому тексту
  const upd = (k: keyof Params, v: string | number) => { setParams({ ...params, [k]: v }); setPreview(null); };
  const num = (k: keyof Params) => ({ type: "number" as const, value: String(params[k]), onChange: (e: any) => upd(k, Number(e.target.value)) });
  const str = (k: keyof Params) => ({ value: String(params[k]), onChange: (e: any) => upd(k, e.target.value) });
  const toggle = (id: number) => setExcluded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card className="p-4">
          <div className="mb-3 text-sm font-medium text-slate-600">{t("Умови кампанії")}</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <div><Label>{t("Ставка до, zł/год")}</Label><Input {...num("rate")} /></div>
            <div><Label>{t("Бонус за 1 друга, zł")}</Label><Input {...num("bonus1")} /></div>
            <div><Label>{t("Разом за 3 друзів, zł")}</Label><Input {...num("bonus3")} /></div>
            <div><Label>{t("Разом за 5 друзів, zł")}</Label><Input {...num("bonus5")} /></div>
            <div><Label>{t("Виплата після N змін")}</Label><Input {...num("minShifts")} /></div>
            <div><Label>{t("Бонус другові, zł")}</Label><Input {...num("friendBonus")} /></div>
            <div><Label>{t("Дедлайн набору")}</Label><Input type="date" {...str("deadline")} /></div>
            <div><Label>{t("Телефон (укр / рос)")}</Label><Input {...str("phoneUk")} /></div>
            <div><Label>{t("Телефон (англ / укр)")}</Label><Input {...str("phoneEn")} /></div>
            <div className="md:col-span-2"><Label>{t("Адреса офісу")}</Label><Input {...str("officeAddress")} /></div>
            <div><Label>{t("Години офісу")}</Label><Input {...str("officeHours")} placeholder="пн–пт 9:00–16:00" /></div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Eye className="h-4 w-4 text-slate-400" />
            <span className="text-sm font-medium text-slate-600">{t("Прев'ю")}</span>
            <Select value={prevLang} onChange={e => setPrevLang(e.target.value)} className="w-40">
              {(data?.languages ?? ["uk"]).map(l => <option key={l} value={l}>{LANG_NAME[l] ?? l}</option>)}
            </Select>
            <Select value={prevActive ? "active" : "fired"} onChange={e => setPrevActive(e.target.value === "active")} className="w-40">
              <option value="active">{t("активному")}</option>
              <option value="fired">{t("звільненому")}</option>
            </Select>
            <Button variant="secondary" loading={doPreview.isPending} onClick={() => doPreview.mutate()}>{t("Показати")}</Button>
          </div>
          {preview ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-slate-400">{t("1. Працівнику")}</div>
                <div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: preview.worker }} />
              </div>
              <div>
                <div className="mb-1 text-xs text-slate-400">{t("2. Для пересилання другові")}</div>
                <div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: preview.friend }} />
                <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-center text-sm text-blue-600">{preview.friendBtn}</div>
              </div>
            </div>
          ) : <p className="text-xs text-slate-400">{t("Оберіть мову й натисніть «Показати», щоб побачити обидва повідомлення з поточними умовами.")}</p>}
        </Card>

        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-600">{t("Отримувачі")} ({chosen.length}/{base.length})</span>
            <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setExcluded(new Set())}>{t("Повернути всіх")}</button>
          </div>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input placeholder={t("Пошук")} value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
          </div>
          <div className="max-h-96 space-y-0.5 overflow-y-auto">
            {filtered.map(r => (
              <label key={r.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                <input type="checkbox" checked={!excluded.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="flex-1 text-slate-700">{r.fullName}</span>
                <span className="font-mono text-xs text-slate-400">{r.referralCode ?? "—"}</span>
                <Badge color="slate">{(r.language || "uk").toUpperCase()}</Badge>
                {!r.isActive && <Badge color="amber">{t("звільнений")}</Badge>}
                {r.factoryName && <Badge color="slate">{r.factoryName}</Badge>}
              </label>
            ))}
            {!filtered.length && <Empty>{t("Нікого не знайдено")}</Empty>}
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-slate-600">{t("Аудиторія")}</div>
          <div className="space-y-1.5 text-sm text-slate-700">
            <label className="flex items-center gap-2"><input type="checkbox" checked={inclActive} onChange={e => setInclActive(e.target.checked)} /> {t("Активні працівники")}</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={inclFired} onChange={e => setInclFired(e.target.checked)} /> {t("Звільнені (з Telegram)")}</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={exclOffice} onChange={e => setExclOffice(e.target.checked)} /> {t("Без офісних (фабрика Biuro)")}</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={exclAdmins} onChange={e => setExclAdmins(e.target.checked)} /> {t("Без адмінів панелі")}</label>
          </div>
          <div className="mt-3 text-xs text-slate-500">
            {byLang.map(([l, n]) => <div key={l}>{LANG_NAME[l] ?? l}: <b>{n}</b></div>)}
          </div>
          <p className="mt-2 text-xs text-slate-400">{t("Кожен отримає 2 повідомлення своєю мовою: умови зі своїм кодом і готовий текст для пересилання другові з кнопкою.")}</p>
          <Button className="mt-3 w-full" loading={send.isPending} disabled={!chosen.length}
            onClick={async () => { if (await confirm({ title: t("Надіслати кампанію {n} працівникам?", { n: chosen.length }), message: t("Це реальні повідомлення людям у Telegram. Перевірте прев'ю кожною мовою."), confirmText: t("Надіслати") })) send.mutate(); }}>
            <Send className="h-4 w-4" /> {t("Надіслати кампанію")}
          </Button>
        </Card>
      </div>
    </div>
  );
}
