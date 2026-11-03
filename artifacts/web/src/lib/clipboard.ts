// Копіювання в буфер з тостом. Фолбек на execCommand — для середовищ без Clipboard API
// (Telegram Mini App, http без secure context). Один тост на всі копіювання (id), щоб
// подвійний клік не плодив два.
import { toast } from "sonner";

export async function copyText(value: string, t: (s: string) => string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = value; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) { toast.error(t("Не вдалося скопіювати"), { id: "copy" }); return; }
  }
  toast.success(`${t("Скопійовано")}: ${value.length > 40 ? value.slice(0, 40) + "…" : value}`, { id: "copy", duration: 1500 });
}

// YYYY-MM-DD → DD.MM.YYYY (польські формуляри й офіс копіюють дати в цьому вигляді)
export const dateForCopy = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)}` : v;
