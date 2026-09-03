// «Надіслати працівнику» — файл документа профілю або файл умови: у Telegram
// (бот, файлом) або на email (з анкети; можна вписати іншу адресу).
// endpoint — POST-шлях бекенду (routes/documentDelivery.ts), модалка лише шле
// {via, email}. Адреса за замовчуванням — з GET /workers/:id/delivery-targets.
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send, Mail } from "lucide-react";
import { get, post } from "../lib/api";
import { Button, Modal, Input, Label } from "./ui";
import { useT } from "../lib/i18n";

type Targets = { telegram: boolean; email: string | null; language: string };

export function SendFileModal({ workerId, title, endpoint, onClose }: { workerId: number; title: string; endpoint: string; onClose: () => void }) {
  const t = useT();
  const { data: targets, isLoading } = useQuery<Targets>({ queryKey: ["delivery-targets", workerId], queryFn: () => get(`/workers/${workerId}/delivery-targets`) });
  const [via, setVia] = useState<"telegram" | "email">("telegram");
  const [email, setEmail] = useState("");
  useEffect(() => {
    if (!targets) return;
    setVia(targets.telegram ? "telegram" : "email");
    setEmail(targets.email ?? "");
  }, [targets]);
  const send = useMutation({
    mutationFn: () => post<{ ok: boolean; to: string }>(endpoint, { via, email: via === "email" ? email.trim() : undefined }),
    onSuccess: r => { toast.success(via === "telegram" ? t("Надіслано в Telegram") : t("Надіслано на {email}", { email: r.to })); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSend = via === "telegram" ? !!targets?.telegram : emailOk;

  const opt = (key: "telegram" | "email", icon: React.ReactNode, label: string, hint: string, disabled: boolean) => (
    <button type="button" disabled={disabled} onClick={() => setVia(key)}
      className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${via === key ? "border-red-300 bg-red-50 text-slate-800" : "border-slate-200 text-slate-600 hover:bg-slate-50"} disabled:cursor-not-allowed disabled:opacity-50`}>
      {icon}
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block truncate text-xs text-slate-400">{hint}</span>
      </span>
    </button>
  );

  return (
    <Modal open onClose={onClose} title={t("Надіслати працівнику")}>
      <div className="space-y-3">
        <p className="truncate text-sm text-slate-600" title={title}>{title}</p>
        {isLoading ? <p className="text-sm text-slate-400">…</p> : (
          <div className="flex gap-2">
            {opt("telegram", <Send className="h-4 w-4 shrink-0 text-sky-500" />, "Telegram", targets?.telegram ? t("бот надішле файлом") : t("не привʼязаний"), !targets?.telegram)}
            {opt("email", <Mail className="h-4 w-4 shrink-0 text-amber-500" />, "Email", targets?.email ?? t("адреси в анкеті немає"), false)}
          </div>
        )}
        {via === "email" && (
          <div>
            <Label>{t("Адреса email")}</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="imie@example.com" />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={send.isPending} disabled={!canSend} onClick={() => send.mutate()}><Send className="h-3.5 w-3.5" /> {t("Надіслати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// Друк файла без відкриття нової вкладки: прихований iframe, print() після
// завантаження. PDF (вбудований переглядач Chrome) і зображення. Якщо браузер
// не дає print() з iframe — файл відкривається у вкладці, друк звідти (Ctrl+P).
export function printFile(url: string, mime: string | null | undefined) {
  const isImage = !!mime?.startsWith("image/");
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  const cleanup = () => setTimeout(() => iframe.remove(), 60_000);
  const fallback = () => { iframe.remove(); window.open(url, "_blank", "noopener"); };
  try {
    if (isImage) {
      const d = iframe.contentDocument!;
      d.open();
      d.write(`<!doctype html><html><head><style>html,body{margin:0}img{max-width:100%;max-height:100vh}</style></head><body><img src="${url}" onload="setTimeout(function(){window.print()},50)"></body></html>`);
      d.close();
      cleanup();
      return;
    }
    iframe.onload = () => { try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); cleanup(); } catch { fallback(); } };
    iframe.src = url;
  } catch { fallback(); }
}
