// Публічна сторінка онлайн-підписання умови (/sign/:token, §5/§6 плану
// worker-docs-signing). БЕЗ сесії — токен у шляху єдина авторизація. Аудиторія —
// працівник (не офіс), тому UI 5-мовний (uk/en/es/ru/pl) власним маленьким
// словником — lib/i18n.tsx панелі покриває лише uk/en(+частково ru).
//
// Anti-screenshot — чесні межі (§6 плану): це deterrents, не захист. PDF
// рендериться в canvas (без «чистого» URL завантаження), водяний знак з
// іменем+часом+хвостом токена на кожній сторінці, user-select вимкнено,
// контекстне меню заблоковане. Справжній скриншот ОС це не зупинить.
import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { Card, Button, Spinner } from "../components/ui";
import { PdfPreview } from "../components/PdfPreview";

type Lang = "uk" | "en" | "es" | "ru" | "pl";
const STR: Record<string, Record<Lang, string>> = {
  loading: { uk: "Завантаження…", en: "Loading…", es: "Cargando…", ru: "Загрузка…", pl: "Ładowanie…" },
  invalidTitle: { uk: "Лінк недійсний", en: "Invalid link", es: "Enlace no válido", ru: "Ссылка недействительна", pl: "Nieprawidłowy link" },
  contact: { uk: "Зверніться до офісу за новим посиланням.", en: "Contact the office for a new link.", es: "Contacta con la oficina para un nuevo enlace.", ru: "Обратитесь в офис за новой ссылкой.", pl: "Skontaktuj się z biurem po nowy link." },
  title: { uk: "Підписання документів", en: "Sign your documents", es: "Firma de documentos", ru: "Подписание документов", pl: "Podpisanie dokumentów" },
  period: { uk: "Період", en: "Period", es: "Período", ru: "Период", pl: "Okres" },
  warn: { uk: "⚠️ Документ персоналізований і відстежується. Поширення заборонене.", en: "⚠️ This document is personalized and tracked. Sharing is prohibited.", es: "⚠️ Este documento está personalizado y monitorizado. Prohibido compartirlo.", ru: "⚠️ Документ персонализирован и отслеживается. Распространение запрещено.", pl: "⚠️ Dokument jest spersonalizowany i monitorowany. Udostępnianie zabronione." },
  scrollHint: { uk: "Прогорніть документи до кінця, щоб продовжити.", en: "Scroll through the documents to the end to continue.", es: "Desplázate por los documentos hasta el final para continuar.", ru: "Прокрутите документы до конца, чтобы продолжить.", pl: "Przewiń dokumenty do końca, aby kontynuować." },
  consent: { uk: "Я ознайомився(-лась) з документами і підписую їх власноручно (простий електронний підпис).", en: "I have reviewed the documents and sign them myself (simple electronic signature).", es: "He revisado los documentos y los firmo yo mismo(a) (firma electrónica simple).", ru: "Я ознакомился(-лась) с документами и подписываю их собственноручно (простая электронная подпись).", pl: "Zapoznałem(-am) się z dokumentami i podpisuję je własnoręcznie (prosty podpis elektroniczny)." },
  signHere: { uk: "Поставте підпис пальцем нижче:", en: "Sign with your finger below:", es: "Firma con el dedo abajo:", ru: "Поставьте подпись пальцем ниже:", pl: "Złóż podpis palcem poniżej:" },
  browserHint: { uk: "💡 Сторінка відкрита у вбудованому вікні Telegram — для чіткого підпису без тремтіння натисни ••• вгорі й вибери «Відкрити в Safari»/«Відкрити в браузері».", en: "💡 This page is open inside Telegram's built-in browser — for a smooth, precise signature tap ••• at the top and choose \"Open in Safari\"/\"Open in browser\".", es: "💡 Esta página está abierta en el navegador integrado de Telegram — para una firma nítida y sin temblores, toca ••• arriba y elige «Abrir en Safari»/«Abrir en el navegador».", ru: "💡 Страница открыта во встроенном окне Telegram — для чёткой подписи без дрожания нажми ••• вверху и выбери «Открыть в Safari»/«Открыть в браузере».", pl: "💡 Strona jest otwarta we wbudowanej przeglądarce Telegram — dla wyraźnego podpisu bez drgań kliknij ••• u góry i wybierz „Otwórz w Safari”/„Otwórz w przeglądarce”." },
  clear: { uk: "Очистити", en: "Clear", es: "Borrar", ru: "Очистить", pl: "Wyczyść" },
  submit: { uk: "Підписати", en: "Sign", es: "Firmar", ru: "Подписать", pl: "Podpisz" },
  successTitle: { uk: "✅ Підписано!", en: "✅ Signed!", es: "✅ ¡Firmado!", ru: "✅ Подписано!", pl: "✅ Podpisano!" },
  successBody: { uk: "Дякуємо! Документи підписано. Копію надішле офіс.", en: "Thank you! The documents are signed. The office will send you a copy.", es: "¡Gracias! Los documentos están firmados. La oficina te enviará una copia.", ru: "Спасибо! Документы подписаны. Копию пришлёт офис.", pl: "Dziękujemy! Dokumenty podpisane. Kopię prześle biuro." },
  error: { uk: "Помилка", en: "Error", es: "Error", ru: "Ошибка", pl: "Błąd" },
};

type Meta = { workerName: string | null; language: string | null; factoryName: string | null; dateFrom: string | null; dateTo: string | null; files: { id: number; title: string; sortOrder: number; groupLabel: string | null }[] };

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: { "X-Requested-With": "grafik" } });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `Помилка ${r.status}`);
  return data as T;
}
async function apiPost<T>(path: string, body?: any): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "grafik" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `Помилка ${r.status}`);
  return data as T;
}

export default function Sign() {
  const [, params] = useRoute("/sign/:token");
  const token = params?.token ?? "";
  const [langState, setLangState] = useState<Lang>("uk");
  const s = (k: keyof typeof STR) => STR[k]![langState];

  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"signed" | null>(null);
  const [consentOk, setConsentOk] = useState(false);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [sigClearKey, setSigClearKey] = useState(0); // «Очистити»: force-remount SignaturePad (реально стирає canvas)
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) return;
    apiGet<Meta>(`/sign/${token}`).then(m => {
      setMeta(m);
      if (m.language && (["uk", "en", "es", "ru", "pl"] as const).includes(m.language as Lang)) setLangState(m.language as Lang);
    }).catch(e => setError(e.message));
  }, [token]);

  // Заблокувати контекстне меню (deterrent, не захист — §6 плану)
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  function checkScrolledToEnd() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setScrolledToEnd(true);
  }

  // Короткий документ (уміщується без скролу) інакше НІКОЛИ не викликав би
  // onScroll — чекбокс згоди лишався б заблокованим назавжди (реальний баг:
  // працівник бачив документи, але не міг підписати). ResizeObserver
  // перевіряє одразу, щойно контент (canvas-сторінки PDF) домальовується.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !meta) return;
    checkScrolledToEnd();
    const ro = new ResizeObserver(checkScrolledToEnd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  async function handleConsent(checked: boolean) {
    setConsentOk(checked);
    if (checked) apiPost(`/sign/${token}/consent`).catch(() => {});
  }

  async function submitSignature() {
    if (!signature) return;
    setBusy(true);
    try {
      await apiPost(`/sign/${token}`, { signature });
      setOutcome("signed");
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  const wmLabel = `${meta?.workerName ?? ""} · ${new Date().toLocaleString("pl-PL")} · ${token.slice(-6)}`;

  if (error) return (
    <Centered><Card className="max-w-md p-6 text-center"><h1 className="mb-2 text-lg font-bold text-rose-600">{s("invalidTitle")}</h1><p className="text-sm text-slate-500">{s("contact")}</p></Card></Centered>
  );
  if (outcome === "signed") return (
    <Centered><Card className="max-w-md p-6 text-center"><h1 className="mb-2 text-lg font-bold text-emerald-600">{s("successTitle")}</h1><p className="text-sm text-slate-500">{s("successBody")}</p></Card></Centered>
  );
  if (!meta) return <Centered><Spinner /></Centered>;

  return (
    <div className="min-h-dvh bg-slate-100 px-3 py-4 select-none sm:px-6" style={{ userSelect: "none" }}>
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-lg font-bold text-slate-800">{s("title")}</h1>
        <p className="mb-1 text-sm text-slate-500">{meta.workerName}{meta.factoryName ? ` · ${meta.factoryName}` : ""}</p>
        {(meta.dateFrom || meta.dateTo) && <p className="mb-3 text-xs text-slate-400">{s("period")}: {meta.dateFrom ?? "—"}{meta.dateTo ? ` → ${meta.dateTo}` : ""}</p>}
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">{s("warn")}</p>

        <Card className="mb-4 overflow-hidden">
          <div ref={scrollRef} onScroll={checkScrolledToEnd} className="relative max-h-[70vh] overflow-y-auto p-2">
            <Watermark label={wmLabel} />
            {(() => {
              const multiGroup = new Set(meta.files.map(f => f.groupLabel)).size > 1;
              let lastGroup: string | null | undefined = undefined;
              return meta.files.map(f => {
                const showGroup = multiGroup && f.groupLabel !== lastGroup;
                lastGroup = f.groupLabel;
                return (
                  <div key={f.id} className="mb-3">
                    {showGroup && f.groupLabel && <div className="mb-1.5 mt-2 border-b border-slate-200 px-1 pb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{f.groupLabel}</div>}
                    <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{f.title}</div>
                    <PdfPages url={`/api/sign/${token}/file/${f.id}`} />
                  </div>
                );
              });
            })()}
          </div>
        </Card>

        {!scrolledToEnd && <p className="mb-3 text-center text-xs text-slate-400">{s("scrollHint")}</p>}

        <Card className="mb-4 p-4">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={consentOk} disabled={!scrolledToEnd} onChange={e => handleConsent(e.target.checked)} className="mt-0.5" />
            <span>{s("consent")}</span>
          </label>
        </Card>

        {consentOk && (
          <Card className="mb-4 p-4">
            {/* Немає надійного способу з JS відрізнити вбудований браузер
                Telegram від звичайного Safari/Chrome (однакові UA) — показуємо
                підказку завжди, а не за фрагільною евристикою: якщо людина вже
                в Safari/Chrome, порада просто нерелевантна й нічого не заважає. */}
            <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700">{s("browserHint")}</p>
            <div className="mb-2 text-sm font-medium text-slate-700">{s("signHere")}</div>
            <SignaturePad key={sigClearKey} onChange={setSignature} />
            <button type="button" onClick={() => { setSignature(null); setSigClearKey(k => k + 1); }} className="mt-1 text-xs text-slate-400 hover:text-slate-600">{s("clear")}</button>
          </Card>
        )}

        <Button disabled={!consentOk || !signature || busy} onClick={submitSignature} className="w-full justify-center">{s("submit")}</Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">{children}</div>;
}

// Діагональний водяний знак поверх canvas-рендеру (deterrent — §6 плану):
// джерело витоку ідентифікується (ПІБ+час+хвіст токена), не блокує сам витік.
function Watermark({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden opacity-[0.08]">
      <div className="grid grid-cols-2 gap-8" style={{ transform: "rotate(-28deg) scale(1.4)" }}>
        {Array.from({ length: 40 }).map((_, i) => (
          <span key={i} className="whitespace-nowrap text-xs font-semibold text-slate-900">{label}</span>
        ))}
      </div>
    </div>
  );
}

// PDF рендериться в canvas через pdf.js (спільний PdfPreview) — без прямого URL
// «завантажити файл», усі сторінки, чітко на телефоні (dpr 3). Сторінки одразу
// мають правильну висоту, тож перевірка «догорнув до кінця» вище бачить повний
// scrollHeight ще до фактичного малювання.
function PdfPages({ url }: { url: string }) {
  return <PdfPreview src={url} />;
}

// Підпис пальцем — звичайний canvas (без нової залежності): pointer events,
// експорт у PNG через toDataURL.
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  // Межі реального чорнила (CSS-координати) — потрібні, щоб експортувати
  // ОБРІЗАНИЙ підпис, а не весь canvas. Людина зазвичай малює маленьку
  // закарлючку в частині широкого полотна; весь canvas (переважно порожній)
  // всередині {%Podpis%} object-fit:contain box (120×40px у документі)
  // масштабується цілком — і сам підпис виходить крихітним. Обрізання по
  // чорнилу+відступ вирішує це без зміни розміру самого полотна для малювання.
  const bbox = useRef({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    // Backing store в CSS-пікселях (560×180 логічних) розтягувався на реальну
    // ширину картки (часто 700-900px CSS-пікселів на телефоні, помножені ще й
    // на devicePixelRatio 2-3 для рендеру) — лінія малювалась у низькій
        // роздільності й «розмазувалась» при масштабуванні, звідси скарга
    // «видно пікселі». Ставимо фізичний розмір canvas = CSS-розмір × dpr і
    // масштабуємо контекст назад — типовий рецепт чіткого HiDPI-canvas.
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.scale(dpr, dpr);
    // Полотно без явно намальованого білого тла лишається ПРОЗОРИМ, і крізь
    // нього видно CSS bg-white — а той у темній темі перефарбовується (як і
    // решта bg-white/slate-* в панелі) в темний колір. Підпис темним чорнилом
    // на такому тлі майже не видно під час малювання. Малюємо справжні білі
    // пікselі — «папір» лишається білим незалежно від теми пристрою.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1e293b";
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (cssW / r.width), y: (e.clientY - r.top) * (cssH / r.height) };
    };
    const growBbox = (p: { x: number; y: number }) => {
      const b = bbox.current;
      b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y);
    };
    // Обрізає canvas по межах чорнила (+відступ) і повертає PNG лише цієї
    // ділянки — щоб маленька закарлючка не губилась у порожньому object-fit:
    // contain боксі документа.
    const exportCropped = (): string => {
      const b = bbox.current;
      if (!Number.isFinite(b.minX)) return canvas.toDataURL("image/png");
      const pad = 12;
      const x0 = Math.max(0, b.minX - pad), y0 = Math.max(0, b.minY - pad);
      const x1 = Math.min(cssW, b.maxX + pad), y1 = Math.min(cssH, b.maxY + pad);
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      const crop = document.createElement("canvas");
      crop.width = Math.round(w * dpr); crop.height = Math.round(h * dpr);
      const cctx = crop.getContext("2d")!;
      cctx.drawImage(canvas, x0 * dpr, y0 * dpr, w * dpr, h * dpr, 0, 0, crop.width, crop.height);
      return crop.toDataURL("image/png");
    };
    // touch-action:none на canvas не завжди рятує на iOS, а у вбудованому
    // браузері Telegram — тим паче: рубер-бенд/pull-to-refresh спрацьовує ще
    // ДО того, як встигає відпрацювати preventDefault на pointermove. Трьома
    // шарами: (1) overscroll-behavior:none на html/body — вимикає сам
    // rubber-band-відскок на рівні CSS, а не лише реагує на нього в JS;
    // (2) блокування скролу/touch-action body на час активного жесту;
    // (3) stopPropagation, щоб жест не сплив до батьківських скрол-контейнерів.
    const htmlStyle = document.documentElement.style;
    const bodyStyle = document.body.style;
    const prevHtmlOverscroll = htmlStyle.overscrollBehavior;
    htmlStyle.overscrollBehavior = "none";
    let prevOverflow = "", prevTouchAction = "", prevBodyOverscroll = "";
    const down = (e: PointerEvent) => {
      drawing.current = true;
      prevOverflow = bodyStyle.overflow; prevTouchAction = bodyStyle.touchAction; prevBodyOverscroll = bodyStyle.overscrollBehavior;
      bodyStyle.overflow = "hidden"; bodyStyle.touchAction = "none"; bodyStyle.overscrollBehavior = "none";
      const p = pos(e); last.current = p; ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.01, p.y + 0.01); ctx.stroke(); // крапка на дотик без руху
      growBbox(p);
      e.preventDefault(); e.stopPropagation();
    };
    const move = (e: PointerEvent) => {
      if (!drawing.current) return;
      const p = pos(e);
      // Квадратична крива через середину відрізка — пряме lineTo на кожен
      // pointermove давало ламану «в пікселях» лінію на швидких рухах
      // (замало точок за низької частоти подій у TG-вебвʼю).
      const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
      ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
      ctx.stroke();
      last.current = p; hasInk.current = true;
      growBbox(p);
      onChangeRef.current(exportCropped());
      e.preventDefault(); e.stopPropagation();
    };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      bodyStyle.overflow = prevOverflow; bodyStyle.touchAction = prevTouchAction; bodyStyle.overscrollBehavior = prevBodyOverscroll;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      bodyStyle.overflow = prevOverflow; bodyStyle.touchAction = prevTouchAction; bodyStyle.overscrollBehavior = prevBodyOverscroll;
      htmlStyle.overscrollBehavior = prevHtmlOverscroll;
    };
  }, []);

  // 200 CSS px (було 160) — комфортніше місце для пальця; на реальних
  // згенерованих Umowa бокс підпису (120×40px, object-fit:contain) приймає це
  // без спотворень чи обрізання, перевірено рендером тестового підпису.
  return <canvas ref={canvasRef} style={{ touchAction: "none", height: 200 }} className="w-full rounded-lg border-2 border-dashed border-slate-300 bg-white" />;
}
