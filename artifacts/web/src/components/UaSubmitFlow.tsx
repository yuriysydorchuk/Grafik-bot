// Подача powiadomienia роботом praca.gov.pl з задачі ступеня 2 (13.10.2026). Три екрани в одній
// модалці: 1) анкета — усе, що робот впише у форму PSZ-PPWPU, у порядку секцій форми, прогалини
// червоним, звідси ж запуск; 2) хід роботи — смуга кроків, поле для коду SMS; 3) Wydruk —
// офіційний PDF заповненої форми з порталу і рішення: підписати / чернетка / скасувати.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "wouter";
import { get, post, upload } from "../lib/api";
import { Modal, Button, Spinner, Input, Label, cn } from "./ui";
import { useT } from "../lib/i18n";

interface Payload {
  workerId: number; workerName: string; companyId: number | null; companyName: string; contextPattern: string;
  miejscowosc: string; kraz: string; email: string; telefon: string;
  cudzoziemiec: { imie: string; kolejneImiona: string; nazwisko: string; obywatelstwo: string; dokRodzaj: string; panstwoWydania: string; seriaNr: string; dataWydania: string; dataWaznosci: string; pesel: string; dataUrodzenia: string; plec: string; tytulPobytu: string };
  praca: { dataPodjecia: string; pkdVersion: string; pkd: string; stanowisko: string; zawodKod: string; miejsce: { kodPocztowy: string; wojewodztwo: string; powiat: string; gmina: string; miejscowosc: string; ulica: string; nrDomu: string; nrLokalu: string }; infoDodatkowe: string; rodzajUmowy: string; godzinMiesiac: string; stawkaGodz: string; stawkaMies: string };
  liczby: { umowaOPrace: string; cywilne: string };
  warnings?: string[];
  podpis: { funkcja: string; pelnomocnik: boolean };
  zalaczniki?: { label: string; fileName: string; url?: string; mime?: string | null; kind?: "passport" | "company" }[];
}
interface Preview { payload: Payload; missing: string[]; account: { id: number; label: string; contextName: string; signerFunction: string | null } | null }
interface Submission { id: number; status: string; step: string | null; error: string | null; previewFile: string | null; finishedAt: string | null }

const OPEN = new Set(["queued", "running", "awaiting_code", "review", "signing"]);
const STAGE_OF: Record<string, number> = { queued: 0, running: 1, awaiting_code: 1, review: 2, signing: 3, submitted: 4, done: 4, failed: -1, cancelled: -1 };

export interface UaQueueItem { workerId: number; companyId: number | null; name: string }
type ItemState = { status: "pending" | "active" | "done" | "failed" | "skipped"; submissionId?: number; previewFile?: string | null };

// Черга людей: для кожного по черзі — анкета → робот → Wydruk → рішення; далі наступний.
// Один акаунт виконує одну подачу за раз, тож послідовно; підсумок з PDF кожного внизу.
// taskId null — запуск з профілю працівника (плюсик біля Powiadomienie, 14.10.2026): ті самі три екрани,
// ендпойнти під /praca-gov/workers/:id (cap legalization) замість гейту задачі.
export function UaSubmitFlow({ taskId, queue, onClose, onDone }: { taskId: number | null; queue: UaQueueItem[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [i, setI] = useState(0);
  const url = (kind: "ua-preview" | "ua-submit" | "ua-submission", workerId: number) => taskId != null ? `/tasks/${taskId}/${kind}/${workerId}` : `/praca-gov/workers/${workerId}/${kind}`;
  const [states, setStates] = useState<ItemState[]>(() => queue.map((_, k) => ({ status: k === 0 ? "active" : "pending" })));
  const cur = queue[i];
  const setState = (k: number, patch: Partial<ItemState>) => setStates(st => st.map((x, j) => j === k ? { ...x, ...patch } : x));
  const advance = () => { const n = i + 1; if (n < queue.length) { setI(n); setState(n, { status: "active" }); } };
  // уже є відкрита подача по цій людині (модалку закривали) — продовжуємо її, а не стартуємо нову
  const { data: openSub, isLoading: openLoading } = useQuery<{ submissionId: number | null }>({ queryKey: ["ua-open-submission", taskId, cur?.workerId, cur?.companyId], queryFn: () => get(`${url("ua-submission", cur!.workerId)}${cur!.companyId != null ? `?companyId=${cur!.companyId}` : ""}`), enabled: !!cur && states[i]?.submissionId == null && states[i]?.status === "active", staleTime: 0 });
  useEffect(() => { if (openSub?.submissionId && states[i]?.submissionId == null) setState(i, { submissionId: openSub.submissionId }); }, [openSub?.submissionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: prev, isLoading, error } = useQuery<Preview>({ queryKey: ["ua-preview", taskId, cur?.workerId, cur?.companyId], queryFn: () => get(`${url("ua-preview", cur!.workerId)}${cur!.companyId != null ? `?companyId=${cur!.companyId}` : ""}`), enabled: !!cur && states[i]?.submissionId == null && states[i]?.status === "active" && openSub != null && !openSub.submissionId });
  const start = useMutation({
    mutationFn: (overrides: Payload) => post<{ submissionId: number }>(url("ua-submit", cur!.workerId), { companyId: cur!.companyId, overrides }),
    onSuccess: d => setState(i, { submissionId: d.submissionId }),
    onError: (e: any) => toast.error(e.message),
  });
  const multi = queue.length > 1;
  const finishedAll = states.every(x => ["done", "failed", "skipped"].includes(x.status));
  return (
    <Modal open onClose={onClose} title={multi ? `${t("Автоматична подача")} · ${i + 1}/${queue.length} · ${cur?.name ?? ""}` : `${t("Powiadomienie")} · ${cur?.name ?? ""}`} size="2xl">
      {multi && (
        <ol className="mb-3 flex flex-wrap gap-1 text-xs">
          {queue.map((q, k) => <li key={`${q.workerId}:${q.companyId ?? 0}`} className={cn("rounded-full px-2 py-0.5", states[k]!.status === "done" ? "bg-emerald-50 text-emerald-700" : states[k]!.status === "failed" ? "bg-rose-50 text-rose-700" : states[k]!.status === "skipped" ? "bg-slate-100 text-slate-400 line-through" : states[k]!.status === "active" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-500")}>{k + 1}. {q.name}</li>)}
        </ol>
      )}
      {!cur || finishedAll
        ? <Summary queue={queue} states={states} onClose={onClose} />
        : states[i]!.submissionId == null
          ? (isLoading || openLoading ? <Spinner /> : error ? <div className="space-y-2"><p className="text-sm text-rose-600">{(error as any).message}</p>{multi && <Button variant="secondary" onClick={() => { setState(i, { status: "skipped" }); advance(); }}>{t("Пропустити")}</Button>}</div>
            : prev ? <PreviewScreen key={`${cur.workerId}:${cur.companyId ?? 0}`} prev={prev} onStart={p => start.mutate(p)} starting={start.isPending} onClose={onClose} onSkip={multi ? () => { setState(i, { status: "skipped" }); advance(); } : undefined} onRefresh={() => { qc.invalidateQueries({ queryKey: ["ua-preview"] }); qc.invalidateQueries({ queryKey: ["worker-docs"] }); }} /> : null)
          : <RunScreen key={states[i]!.submissionId} id={states[i]!.submissionId!} onClose={onClose} onFinished={(ok, previewFile) => { setState(i, { status: ok ? "done" : "failed", previewFile }); onDone(); advance(); }} />}
    </Modal>
  );
}

function Summary({ queue, states, onClose }: { queue: UaQueueItem[]; states: ItemState[]; onClose: () => void }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-100 text-sm">
        {queue.map((q, k) => <li key={k} className="flex items-center gap-3 py-1.5">
          <span className={cn("rounded-full px-2 py-0.5 text-xs", states[k]!.status === "done" ? "bg-emerald-50 text-emerald-700" : states[k]!.status === "failed" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500")}>{states[k]!.status === "done" ? t("готово") : states[k]!.status === "failed" ? t("помилка") : t("пропущено")}</span>
          <span className="font-medium text-slate-800">{q.name}</span>
          {states[k]!.submissionId && states[k]!.previewFile && <a className="ml-auto text-blue-600 hover:underline" href={`/api/praca-gov/submissions/${states[k]!.submissionId}/preview`} target="_blank" rel="noreferrer">Wydruk ↗</a>}
        </li>)}
      </ul>
      <div className="flex justify-end"><Button onClick={onClose}>{t("Закрити")}</Button></div>
    </div>
  );
}

// ── екран 1: анкета (редагована; правки йдуть лише в цю подачу) ──────────────
type Setter = (path: string, v: string) => void;
function getPath(o: any, path: string): string { return String(path.split(".").reduce((a, k) => a?.[k], o) ?? ""); }
function setPath(o: any, path: string, v: string): any { const out = structuredClone(o); const ks = path.split("."); let d = out; for (const k of ks.slice(0, -1)) d = d[k]; d[ks[ks.length - 1]!] = v; return out; }

// Обовʼязкові поля — дзеркало services/pracaGov/payload.ts missingOf()
const REQUIRED = new Set(["miejscowosc", "cudzoziemiec.imie", "cudzoziemiec.nazwisko", "cudzoziemiec.obywatelstwo", "cudzoziemiec.seriaNr", "cudzoziemiec.dataWydania", "cudzoziemiec.dataWaznosci", "cudzoziemiec.dataUrodzenia", "cudzoziemiec.plec", "cudzoziemiec.tytulPobytu", "praca.dataPodjecia", "praca.pkd", "praca.stanowisko", "praca.zawodKod", "praca.miejsce.wojewodztwo", "praca.miejsce.powiat", "praca.miejsce.gmina", "praca.godzinMiesiac", "praca.stawkaGodz", "praca.stawkaMies", "liczby.umowaOPrace", "liczby.cywilne", "podpis.funkcja"]);

function F({ l, path, form, set, type, options, placeholder, readOnly }: { l: string; path: string; form: Payload; set: Setter; type?: string; options?: string[]; placeholder?: string; readOnly?: boolean }) {
  const v = getPath(form, path); const req = REQUIRED.has(path); const bad = req && !v;
  const cls = cn("w-full rounded-md border px-2 py-1 text-sm text-slate-800 outline-none focus:border-red-400 focus:ring-1 focus:ring-red-200", bad ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white", readOnly && "bg-slate-50 text-slate-500");
  return (
    <label className="flex items-center gap-2 py-0.5 text-sm">
      <span className="w-[44%] shrink-0 text-slate-500">{l}{req && <span className="text-rose-500"> *</span>}</span>
      {options
        ? <select value={v} onChange={e => set(path, e.target.value)} className={cls} disabled={readOnly}><option value="">—</option>{options.map(o => <option key={o} value={o}>{o}</option>)}</select>
        : <input value={v} onChange={e => set(path, e.target.value)} type={type ?? "text"} placeholder={placeholder} readOnly={readOnly} className={cls} />}
    </label>
  );
}
function Static({ l, v }: { l: string; v: string }) {
  return <div className="flex items-center gap-2 py-0.5 text-sm"><span className="w-[44%] shrink-0 text-slate-500">{l}</span><span className="text-slate-500 italic">{v}</span></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>{children}</div>;
}

function PreviewScreen({ prev, onStart, starting, onClose, onSkip, onRefresh }: { prev: Preview; onStart: (p: Payload) => void; starting: boolean; onClose: () => void; onSkip?: () => void; onRefresh?: () => void }) {
  const t = useT();
  const [form, setForm] = useState<Payload>(prev.payload);
  // після дозавантаження паспорта анкету перечитано — підхоплюємо лише залучники, правки людини лишаються
  useEffect(() => { setForm(f => ({ ...f, zalaczniki: prev.payload.zalaczniki })); }, [prev.payload.zalaczniki]);
  const passport = (form.zalaczniki ?? []).find(z => z.kind === "passport" || z.label === "Paszport");
  const hasPassport = !!passport;
  const [showPassport, setShowPassport] = useState(true); // бічна панель зі сканом — звірити дані cudzoziemca очима
  const passUpload = useMutation({
    mutationFn: (f: File) => { const fd = new FormData(); fd.append("file", f); return upload(`/praca-gov/workers/${form.workerId}/passport-file`, fd); },
    onSuccess: () => { toast.success(t("Скан паспорта додано в профіль")); onRefresh?.(); }, onError: (e: any) => toast.error(e.message),
  });
  const set: Setter = (path, v) => setForm(f => {
    let n = setPath(f, path, v);
    // місячна сума = ставка × години, поки її не правили руками
    if (path === "praca.stawkaGodz" || path === "praca.godzinMiesiac") { const r = parseFloat(getPath(n, "praca.stawkaGodz").replace(",", ".")); const h = parseInt(getPath(n, "praca.godzinMiesiac"), 10); if (r > 0 && h > 0) n = setPath(n, "praca.stawkaMies", (Math.round(r * h * 100) / 100).toFixed(2).replace(".", ",")); }
    return n;
  });
  const missing = [...REQUIRED].filter(p => !getPath(form, p));
  const ok = missing.length === 0 && !!prev.account;
  const edited = JSON.stringify(form) !== JSON.stringify(prev.payload);
  const passUploadInput = (label: string, cls: string) => (
    <label className={cls}>
      {passUpload.isPending ? "…" : label}
      <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) passUpload.mutate(f); e.target.value = ""; }} />
    </label>
  );
  return (
    <div className={cn("gap-4", passport && showPassport && "xl:grid xl:grid-cols-[minmax(0,1fr)_380px]")}>
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <span>{t("Фірма")}: <b className="text-slate-800">{form.companyName || "—"}</b></span>
        <span>{t("Контекст на порталі")}: <b className="text-slate-800">{prev.account?.contextName || form.contextPattern}</b></span>
        <span>{t("Акаунт")}: <b className="text-slate-800">{prev.account?.label ?? t("нема — додайте в Налаштуваннях → praca.gov.pl")}</b></span>
        <span className="ml-auto text-slate-400">{t("Правки тут — лише для цієї подачі; сталі дані правте в профілі та Налаштуваннях → praca.gov.pl")}</span>
      </div>
      {(prev.payload.warnings ?? []).map(w => <div key={w} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">⚠ {w}</div>)}
      {missing.length > 0 && <div className="rounded-md border border-rose-100 bg-rose-50 px-3 py-1.5 text-xs text-rose-700">{t("Бракує")}: {missing.length} {t("пол.")} — {t("допишіть червоні поля або")} <Link href={`/workers/${form.workerId}`} className="underline">{t("профіль працівника")}</Link> · <Link href="/settings?tab=pracaGov" className="underline">praca.gov.pl</Link></div>}
      <div className="grid gap-x-8 md:grid-cols-2">
        <div>
          <Section title="1. Podmiot powierzający pracę">
            <Static l="Nazwa / NIP / REGON" v={t("з реєстрації організації на порталі")} />
            <F l="Miejscowość (sporządzenia)" path="miejscowosc" form={form} set={set} />
            <F l="Numer KRAZ" path="kraz" form={form} set={set} />
            <F l="1.2 e-mail" path="email" form={form} set={set} type="email" />
            <F l="1.3 Nr telefonu" path="telefon" form={form} set={set} />
          </Section>
          <Section title="2. Dane cudzoziemca">
            <F l="Imię" path="cudzoziemiec.imie" form={form} set={set} /><F l="Kolejne imiona" path="cudzoziemiec.kolejneImiona" form={form} set={set} /><F l="Nazwisko" path="cudzoziemiec.nazwisko" form={form} set={set} />
            <F l="Obywatelstwo" path="cudzoziemiec.obywatelstwo" form={form} set={set} placeholder="Ukraina" /><Static l="Rodzaj dokumentu" v="Paszport" /><F l="Państwo wydania" path="cudzoziemiec.panstwoWydania" form={form} set={set} />
            <F l="Seria i nr" path="cudzoziemiec.seriaNr" form={form} set={set} /><F l="Data wydania" path="cudzoziemiec.dataWydania" form={form} set={set} type="date" /><F l="Data ważności" path="cudzoziemiec.dataWaznosci" form={form} set={set} type="date" />
            <F l="PESEL" path="cudzoziemiec.pesel" form={form} set={set} /><F l="Data urodzenia" path="cudzoziemiec.dataUrodzenia" form={form} set={set} type="date" /><F l="Płeć" path="cudzoziemiec.plec" form={form} set={set} options={["Kobieta", "Mężczyzna"]} /><F l="Tytuł pobytu" path="cudzoziemiec.tytulPobytu" form={form} set={set} options={["OCHRONA CZASOWA", "OCHRONA UZUPEŁNIAJĄCA", "POBYT CZASOWY", "POBYT CZŁONKA RODZINY OBYWATELA UE", "POBYT HUMANITARNY", "POBYT NA PODSTAWIE ART. 108 UST. 1 PKT 1, ART. 206 UST. 1 PKT 2 LUB 223 USTAWY O CUDZOZIEMCACH"]} />
          </Section>
          <Section title="4. Liczba osób u pracodawcy">
            <F l="umowa o pracę" path="liczby.umowaOPrace" form={form} set={set} type="number" /><F l="umowy cywilnoprawne" path="liczby.cywilne" form={form} set={set} type="number" />
          </Section>
          <Section title="Załączniki">
            {(form.zalaczniki ?? []).map((z, k) => (
              <div key={k} className="flex items-center gap-2 py-0.5 text-sm">
                <span className="w-[44%] shrink-0 text-slate-500">{z.label}</span>
                {z.url ? <a href={z.url} target="_blank" rel="noreferrer" className="truncate text-blue-600 hover:underline" title={t("Відкрити файл")}>{z.fileName}</a> : <span className="truncate text-slate-500 italic">{z.fileName}</span>}
                {z.kind === "passport" && passUploadInput(t("замінити"), "shrink-0 cursor-pointer text-xs text-slate-400 hover:text-slate-700 underline")}
                {z.kind === "passport" && <button type="button" onClick={() => setShowPassport(v => !v)} className="shrink-0 text-xs text-slate-400 hover:text-slate-700 underline">{showPassport ? t("сховати") : t("показати збоку")}</button>}
                {z.kind === "company" && <Link href="/settings?tab=pracaGov" className="shrink-0 text-xs text-slate-400 hover:text-slate-700 underline">{t("змінити")}</Link>}
              </div>
            ))}
            {!hasPassport && (
              <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                <span>⚠ {t("Скану паспорта в профілі нема — подача піде без нього.")}</span>
                {passUploadInput(t("Додати скан паспорта"), "cursor-pointer rounded-md border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-900 hover:bg-amber-100")}
              </div>
            )}
            {!(form.zalaczniki ?? []).some(z => z.label !== "Paszport") && <Static l="88Z" v={t("нема — додайте в Налаштуваннях → praca.gov.pl → Фірми")} />}
          </Section>
          <Section title="Osoba podpisująca">
            <Static l="Imię, nazwisko, PESEL" v={t("з акаунта на порталі")} /><F l="Pełniona funkcja" path="podpis.funkcja" form={form} set={set} /><Static l="Pełnomocnik" v={form.podpis.pelnomocnik ? "tak (z załącznikiem pełnomocnictwa)" : "nie — uprawnienie bezpośrednie"} />
          </Section>
        </div>
        <div>
          <Section title="3. Informacje o oferowanej pracy">
            <F l="Data podjęcia pracy" path="praca.dataPodjecia" form={form} set={set} type="date" />
            <F l="3.1 Klasyfikacja PKD" path="praca.pkdVersion" form={form} set={set} options={["PKD_2007", "PKD_2025"]} /><F l="Symbol PKD (роботи)" path="praca.pkd" form={form} set={set} placeholder="1039Z" />
            <F l="3.2 Stanowisko / rodzaj pracy" path="praca.stanowisko" form={form} set={set} />
            <F l="3.3 Kod zawodu (KZiS)" path="praca.zawodKod" form={form} set={set} placeholder="932101" />
            <F l="3.4 Kod pocztowy" path="praca.miejsce.kodPocztowy" form={form} set={set} placeholder="20-404" /><F l="Województwo" path="praca.miejsce.wojewodztwo" form={form} set={set} /><F l="Powiat" path="praca.miejsce.powiat" form={form} set={set} /><F l="Gmina" path="praca.miejsce.gmina" form={form} set={set} />
            <F l="Miejscowość" path="praca.miejsce.miejscowosc" form={form} set={set} /><F l="Ulica" path="praca.miejsce.ulica" form={form} set={set} /><F l="Nr domu / lokalu" path="praca.miejsce.nrDomu" form={form} set={set} /><F l="Informacje dodatkowe" path="praca.infoDodatkowe" form={form} set={set} />
            <F l="3.5 Rodzaj umowy" path="praca.rodzajUmowy" form={form} set={set} options={["Umowa zlecenie / Umowa o świadczenie usług", "Umowa o dzieło", "Umowa o pracę na czas określony", "Umowa o pracę na czas nieokreślony", "Umowa o pracę na okres próbny"]} />
            <F l="3.6 Liczba godzin w miesiącu" path="praca.godzinMiesiac" form={form} set={set} type="number" />
            <F l="3.7 Stawka godzinowa brutto, zł" path="praca.stawkaGodz" form={form} set={set} /><F l="miesięczne na podstawie stawki, zł" path="praca.stawkaMies" form={form} set={set} />
          </Section>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
        {edited && <span className="mr-auto text-xs text-amber-700">{t("є правки — підуть лише в цю подачу")}</span>}
        {onSkip && <Button variant="secondary" onClick={onSkip}>{t("Пропустити")}</Button>}
        <Button variant="secondary" onClick={onClose}>{t("Закрити")}</Button>
        <Button onClick={() => onStart(form)} loading={starting} disabled={!ok || passUpload.isPending} title={ok ? "" : t("Заповніть прогалини й додайте акаунт")}>{t("Заповнити форму на порталі")} →</Button>
      </div>
    </div>
    {/* бічна панель: скан паспорта поряд із секцією 2, щоб звірити імʼя/номер/дати очима (прохання власника 19.10.2026) */}
    {passport && showPassport && passport.url && (
      <aside className="hidden xl:block">
        <div className="sticky top-0 space-y-1">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400"><span>Paszport</span><a href={passport.url} target="_blank" rel="noreferrer" className="normal-case font-normal text-blue-600 hover:underline">{t("відкрити")} ↗</a></div>
          {/^image\//.test(passport.mime ?? "") || /\.(jpe?g|png)$/i.test(passport.fileName)
            ? <a href={passport.url} target="_blank" rel="noreferrer"><img src={passport.url} alt="Paszport" className="max-h-[75vh] w-full rounded-lg border border-slate-200 object-contain bg-slate-50" /></a>
            : <iframe src={passport.url} title="Paszport" className="h-[75vh] w-full rounded-lg border border-slate-200 bg-white" />}
        </div>
      </aside>
    )}
    </div>
  );
}

// ── екран 2/3: хід роботи та Wydruk ───────────────────────────────────────────
const STEPS = ["Вхід на portal", "Заповнення", "Перевірка Wydruk", "Підписання", "Завершено"];

function RunScreen({ id, onClose, onFinished }: { id: number; onClose: () => void; onFinished: (ok: boolean, previewFile: string | null) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const { data: s } = useQuery<Submission>({ queryKey: ["praca-gov-submission", id], queryFn: () => get(`/praca-gov/submissions/${id}`), refetchInterval: q => (q.state.data && !OPEN.has(q.state.data.status) ? false : 2000) });
  const inv = () => qc.invalidateQueries({ queryKey: ["praca-gov-submission", id] });
  const sendCode = useMutation({ mutationFn: () => post(`/praca-gov/submissions/${id}/code`, { code }), onSuccess: () => { setCode(""); inv(); }, onError: (e: any) => toast.error(e.message) });
  const decide = useMutation({ mutationFn: (decision: "save_draft" | "sign" | "cancel") => post(`/praca-gov/submissions/${id}/decision`, { decision }), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  const cancel = useMutation({ mutationFn: () => post(`/praca-gov/submissions/${id}/cancel`), onSuccess: inv, onError: (e: any) => toast.error(e.message) });
  useEffect(() => { if (s && !OPEN.has(s.status)) onFinished(s.status === "done" || s.status === "submitted", s.previewFile ?? null); }, [s?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Spinner />;
  const stage = STAGE_OF[s.status] ?? 0;
  const failed = s.status === "failed" || s.status === "cancelled";
  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-2 text-xs">
        {STEPS.map((lab, i) => {
          const done = stage > i, cur = stage === i && !failed;
          return <li key={lab} className="flex items-center gap-2">
            <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold", done ? "bg-emerald-500 text-white" : cur ? "bg-red-600 text-white" : "bg-slate-200 text-slate-500")}>{done ? "✓" : i + 1}</span>
            <span className={cn(cur ? "font-semibold text-slate-800" : "text-slate-500")}>{t(lab)}</span>
            {i < STEPS.length - 1 && <span className="h-px w-6 bg-slate-200" />}
          </li>;
        })}
      </ol>
      <div className={cn("rounded-lg px-3 py-2 text-sm", failed ? "bg-rose-50 text-rose-800" : s.status === "done" ? "bg-emerald-50 text-emerald-800" : "bg-slate-50 text-slate-700")}>
        {OPEN.has(s.status) && s.status !== "review" && <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-red-600 align-middle" />}
        {s.error ?? s.step}
      </div>
      {s.status === "awaiting_code" && (
        <div className="flex items-end gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <div><Label>{t("Код з SMS profilu zaufanego")}</Label><Input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="w-40" autoFocus /></div>
          <Button onClick={() => sendCode.mutate()} loading={sendCode.isPending} disabled={code.length < 4}>{t("Передати код")}</Button>
          <span className="text-xs text-amber-800">{t("або відповісти в боті")}</span>
        </div>
      )}
      {s.status === "review" && (
        <>
          <p className="text-xs text-slate-500">{t("Нижче — офіційний Wydruk заповненої форми з praca.gov.pl: саме це піде на підпис. Перевірте кожне поле. «Підписати й надіслати» = підпис вашим profilem zaufanym (код SMS) і відправка до urzędu; відкликати подане повідомлення портал не дозволяє.")}</p>
          {s.previewFile
            ? <iframe title="Wydruk" src={`/api/praca-gov/submissions/${s.id}/preview`} className="h-[70vh] w-full rounded-lg border border-slate-200 bg-white" />
            : <p className="text-sm text-rose-600">{t("Wydruk не вдалося отримати")}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <Button variant="secondary" onClick={() => decide.mutate("cancel")} loading={decide.isPending}>{t("Скасувати")}</Button>
            <Button variant="secondary" onClick={() => decide.mutate("save_draft")} loading={decide.isPending} title={t("Zapis do schowka praca.gov.pl — далі підпис руками на порталі")}>{t("Чернетка на порталі")}</Button>
            <Button onClick={() => decide.mutate("sign")} loading={decide.isPending} title={t("Чернетка в schowek → підпис profilem zaufanym (код SMS) → відправка → потвердження в профіль")}>{t("Підписати й надіслати")}</Button>
          </div>
        </>
      )}
      {OPEN.has(s.status) && s.status !== "review" && (
        <div className="flex justify-end"><Button variant="secondary" onClick={() => cancel.mutate()} loading={cancel.isPending}>{t("Зупинити робота")}</Button></div>
      )}
      {!OPEN.has(s.status) && <div className="flex justify-end"><Button onClick={onClose}>{t("Закрити")}</Button></div>}
    </div>
  );
}
