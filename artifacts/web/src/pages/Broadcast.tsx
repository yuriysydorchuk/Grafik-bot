import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Send, Trash2, Search } from "lucide-react";
import { toast } from "sonner";
import { get, post, type Worker, type Factory } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";

type Target = "all" | "factory" | "selected";

export default function Broadcast() {
  const t = useT();
  const confirm = useConfirm();
  const { data: workers, isLoading } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: () => get("/workers") });
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>("all");
  const [factoryId, setFactoryId] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [q, setQ] = useState("");

  const active = useMemo(() => (workers ?? []).filter(w => w.isActive), [workers]);
  const linked = active.filter(w => w.telegramId);
  const filtered = useMemo(() => active.filter(w => !q || w.fullName.toLowerCase().includes(q.toLowerCase())), [active, q]);

  const recipientCount = useMemo(() => {
    if (target === "all") return linked.length;
    if (target === "factory") return linked.filter(w => String(w.factoryId) === factoryId).length;
    return active.filter(w => selected.has(w.id) && w.telegramId).length;
  }, [target, factoryId, selected, linked, active]);

  const send = useMutation({
    mutationFn: () => post<{ notified: number; skipped: number }>("/broadcast", {
      text, target,
      factoryId: target === "factory" ? Number(factoryId) : undefined,
      workerIds: target === "selected" ? [...selected] : undefined,
    }),
    onSuccess: (r) => { toast.success(t("Надіслано: {n}", { n: r.notified }), { description: r.skipped ? t("{n} пропущено (без Telegram/заблокували)", { n: r.skipped }) : undefined }); setText(""); },
    onError: (e: any) => toast.error(e.message),
  });

  const clearChats = useMutation({
    mutationFn: () => post<{ deleted: number; chats: number; skippedOld: number }>("/chat/clear"),
    onSuccess: (r) => toast.success(t("Видалено {a} повідомлень у {b} чатах", { a: r.deleted, b: r.chats }), { description: r.skippedOld ? t("{n} старші за 48 год — Telegram не дозволяє видалити", { n: r.skippedOld }) : undefined }),
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = (id: number) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (isLoading) return <Spinner />;

  const canSend = text.trim().length > 0 && recipientCount > 0 && (target !== "factory" || !!factoryId);

  return (
    <>
      <PageHeader title={t("Розсилка")} subtitle={t("Надіслати повідомлення працівникам у Telegram")} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-4">
            <label className="mb-1.5 block text-sm font-medium text-slate-600">{t("Текст повідомлення")}</label>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
              placeholder={t("Напишіть повідомлення…")}
              className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100" />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div className="text-sm text-slate-500">{t("Отримувачів:")} <span className="font-semibold text-slate-700">{recipientCount}</span></div>
              <Button className="ml-auto" loading={send.isPending} disabled={!canSend}
                onClick={async () => { if (await confirm({ title: t("Надіслати {n} працівникам?", { n: recipientCount }), confirmText: t("Надіслати") })) send.mutate(); }}>
                <Send className="h-4 w-4" /> {t("Надіслати")}
              </Button>
            </div>
          </Card>

          {target === "selected" && (
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600">{t("Оберіть працівників")} ({selected.size})</span>
                <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setSelected(new Set())}>{t("Очистити")}</button>
              </div>
              <div className="relative mb-2">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input placeholder={t("Пошук")} value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {filtered.map(w => (
                  <label key={w.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${w.telegramId ? "hover:bg-slate-50" : "opacity-50"}`}>
                    <input type="checkbox" disabled={!w.telegramId} checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                    <span className="flex-1 text-slate-700">{w.fullName}</span>
                    {w.factoryName && <Badge color="slate">{w.factoryName}</Badge>}
                    {!w.telegramId && <span className="text-xs text-amber-500">{t("без TG")}</span>}
                  </label>
                ))}
                {!filtered.length && <Empty>{t("Нікого не знайдено")}</Empty>}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium text-slate-600">{t("Кому надіслати")}</div>
            <div className="space-y-1.5">
              {([["all", t("Усім працівникам ({n})", { n: linked.length })], ["factory", t("Працівникам фабрики")], ["selected", t("Вибраним")]] as [Target, string][]).map(([val, label]) => (
                <label key={val} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input type="radio" name="target" checked={target === val} onChange={() => setTarget(val)} />
                  <span className="text-slate-700">{label}</span>
                </label>
              ))}
            </div>
            {target === "factory" && (
              <Select className="mt-2" value={factoryId} onChange={e => setFactoryId(e.target.value)}>
                <option value="">{t("— оберіть фабрику —")}</option>
                {factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
            )}
            <p className="mt-2 text-xs text-slate-400">{t("Повідомлення отримають лише ті, хто приєднаний до бота.")}</p>
          </Card>

          <Card className="p-4">
            <div className="mb-1 text-sm font-medium text-slate-600">{t("Очистити чати")}</div>
            <p className="mb-2 text-xs text-slate-400">{t("Видаляє нещодавні повідомлення бота й працівників (Telegram дозволяє лише молодші за 48 годин).")}</p>
            <Button variant="secondary" loading={clearChats.isPending}
              onClick={async () => { if (await confirm({ title: t("Очистити чати всім працівникам?"), message: t("Будуть видалені повідомлення за останні 48 годин. Старіші Telegram видалити не дозволяє."), danger: true, confirmText: t("Очистити") })) clearChats.mutate(); }}>
              <Trash2 className="h-4 w-4" /> {t("Очистити недавнє")}
            </Button>
          </Card>
        </div>
      </div>
    </>
  );
}
