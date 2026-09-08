// Спільний превʼю PDF через pdf.js у <canvas> (профіль працівника, /sign/:token,
// бібліотека шаблонів, фактури). Рендеримо самі, а не <iframe>: вбудований
// переглядач браузера може бути налаштований «скачувати PDF», а на сторінці
// підпису ще й не має бути «чистого» URL завантаження.
//
// Чому окремий компонент, а не 4 копії циклу: копії малювали сторінку з
// ФІКСОВАНИМ масштабом (1.3–1.6 ≈ 800–950 px по ширині) і розтягували canvas на
// 100 % контейнера. На Retina (dpr 2) чи телефоні (dpr 3) браузер апскейлив
// картинку у 2–3 рази — текст виглядав «милом», і власник сприймав це як
// поганий PDF, хоча сам файл векторний і чіткий. Тут масштаб = ширина
// контейнера × devicePixelRatio (зі стелею), сторінки перемальовуються при
// зміні ширини, довгі документи малюються ліниво при прокрутці.
//
// Усі сторінки одразу отримують правильну висоту (aspect-ratio з розмірів
// сторінки) ще ДО рендеру — scrollHeight контейнера стабільний, тож логіка
// «догорнув до кінця» на /sign працює як і раніше.
import { useEffect, useRef, useState } from "react";

type Props = {
  /** URL (GET з cookie) або вже завантажені байти PDF */
  src: string | ArrayBuffer;
  /** Скільки сторінок показати (решта — «+N»); типово всі */
  maxPages?: number;
  className?: string;
  canvasClassName?: string;
  /** Текст перед повідомленням про помилку (i18n робить викликач) */
  errorLabel?: string;
  errorClassName?: string;
  onLoaded?: (numPages: number) => void;
};

const MAX_DPR = 3;          // вище — лише памʼять без видимої різниці
const MAX_CANVAS_PX = 4096; // стеля фізичної ширини (ліміти canvas у Safari/iOS)

export function PdfPreview({ src, maxPages, className, canvasClassName, errorLabel, errorClassName, onLoaded }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    let doc: any = null;
    let io: IntersectionObserver | null = null;
    let ro: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    // per-canvas стан: сторінка pdf.js, поточний render-task, ширина останнього рендеру
    const slots = new Map<HTMLCanvasElement, { page: any; task: any; renderedCssWidth: number; visible: boolean }>();

    const renderSlot = async (canvas: HTMLCanvasElement) => {
      const slot = slots.get(canvas);
      if (!slot || cancelled) return;
      const cssWidth = canvas.clientWidth || host.clientWidth;
      if (!cssWidth) return;
      if (Math.abs(cssWidth - slot.renderedCssWidth) < 2) return; // та сама ширина — нема що перемальовувати
      if (slot.task) { try { slot.task.cancel(); } catch { /* вже завершено */ } slot.task = null; }
      const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
      const base = slot.page.getViewport({ scale: 1 });
      const scale = Math.min(cssWidth * dpr, MAX_CANVAS_PX) / base.width;
      const vp = slot.page.getViewport({ scale });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const task = slot.page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp });
      slot.task = task;
      try {
        await task.promise;
        slot.renderedCssWidth = cssWidth;
      } catch (e: any) {
        // RenderingCancelledException при resize/unmount — не помилка
        if (e?.name !== "RenderingCancelledException" && !cancelled) setErr(String(e?.message ?? e).slice(0, 200));
      } finally {
        if (slot.task === task) slot.task = null;
      }
    };

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url" as any)).default as string;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        // ArrayBuffer передаємо копією — pdf.js «забирає» буфер у воркер (detached),
        // і повторний рендер того самого src (StrictMode, ререндер) упав би.
        doc = await pdfjs.getDocument(typeof src === "string" ? { url: src } : { data: src.slice(0) }).promise;
        if (cancelled || !ref.current) return;
        host.innerHTML = "";
        const pages = maxPages ? Math.min(doc.numPages, maxPages) : doc.numPages;

        io = new IntersectionObserver(entries => {
          for (const en of entries) {
            const canvas = en.target as HTMLCanvasElement;
            const slot = slots.get(canvas);
            if (!slot) continue;
            slot.visible = en.isIntersecting;
            if (en.isIntersecting) void renderSlot(canvas);
          }
        }, { rootMargin: "600px 0px" });

        for (let i = 1; i <= pages; i++) {
          const page = await doc.getPage(i);
          if (cancelled || !ref.current) return;
          const base = page.getViewport({ scale: 1 });
          const canvas = document.createElement("canvas");
          canvas.style.width = "100%";
          canvas.style.aspectRatio = `${base.width} / ${base.height}`;
          canvas.className = canvasClassName ?? "mb-2 block rounded border border-slate-200 bg-white";
          host.appendChild(canvas);
          slots.set(canvas, { page, task: null, renderedCssWidth: 0, visible: false });
          io.observe(canvas);
        }
        if (doc.numPages > pages) {
          const more = document.createElement("div");
          more.className = "pb-2 text-center text-xs text-slate-400";
          more.textContent = `+${doc.numPages - pages}`;
          host.appendChild(more);
        }
        onLoaded?.(doc.numPages);

        // Зміна ширини контейнера (ресайз вікна, згортання сайдбару) — перемалювати видимі
        ro = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            for (const [canvas, slot] of slots) if (slot.visible) void renderSlot(canvas);
          }, 150);
        });
        ro.observe(host);
      } catch (e: any) {
        // Текст помилки показуємо явно: глухе «PDF error» ховало справжню причину
        // (регресія — офіс не міг зрозуміти, чому працівник не бачить документ).
        if (!cancelled) setErr(String(e?.message ?? e).slice(0, 200));
      }
    })();

    return () => {
      cancelled = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      io?.disconnect();
      ro?.disconnect();
      for (const slot of slots.values()) { try { slot.task?.cancel(); } catch { /* noop */ } }
      slots.clear();
      try { doc?.destroy(); } catch { /* noop */ }
    };
  }, [src, maxPages, canvasClassName]);

  if (err) return <div className={errorClassName ?? "p-3 text-xs text-rose-500"}>{errorLabel ?? "PDF error:"} {err}</div>;
  return <div ref={ref} className={className} />;
}
