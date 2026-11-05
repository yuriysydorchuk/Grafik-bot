// Імʼя файлу при скачуванні документа/умови працівника (зголошення #21, 05.11.2026): раніше віддавали
// оригінальну назву з телефону («IMG_20261014_093211.jpg», «skan.pdf») — у «Завантаженнях» не видно,
// чий це документ. Тепер: <Тип>_<NAZWISKO IMIE>_<дата>.<розширення>. Збережений шлях і file_name
// у БД не чіпаємо — це лише заголовок Content-Disposition.
// Імʼя — КАПСОМ (правило згенерованих файлів, nameCaps); діакритика лишається (filename*=UTF-8).
const MIME_EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };
const part = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\.{2,}/g, ".").replace(/\s+/g, " ").trim().replace(/ /g, "_").slice(0, 70);

export function workerFileDownloadName(o: {
  label: string | null | undefined;      // тип документа / назва файлу умови
  fullName: string | null | undefined;   // імʼя працівника
  date?: string | null;                  // YYYY-MM-DD (дата документа; без неї — пропускається)
  fileName?: string | null;              // оригінальна назва — лише заради розширення
  mime?: string | null;
  suffix?: string | null;                // напр. «v2» — попередня версія файлу
  fallback: string;                      // якщо ні типу, ні імені (document-123)
}): string {
  const extFromName = /\.([A-Za-z0-9]{2,5})$/.exec(o.fileName ?? "")?.[1]?.toLowerCase();
  const ext = extFromName ?? MIME_EXT[(o.mime ?? "").toLowerCase()] ?? "";
  const parts = [part(o.label ?? ""), part((o.fullName ?? "").toLocaleUpperCase("pl-PL")), /^\d{4}-\d{2}-\d{2}/.test(o.date ?? "") ? o.date!.slice(0, 10) : "", part(o.suffix ?? "")].filter(Boolean);
  const base = parts.length ? parts.join("_") : part(o.fallback);
  return ext ? `${base}.${ext}` : base;
}

/** Заголовок Content-Disposition з UTF-8-імʼям (+ ASCII-фолбек для старих клієнтів). */
export function contentDisposition(disposition: "inline" | "attachment", name: string): string {
  const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
