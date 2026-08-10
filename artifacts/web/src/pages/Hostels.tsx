// «Хостели» — дві вкладки:
// 1) «Хостели» — довідник житла: місто → хостел (модель оренди, ціна, кауція),
//    мешканці (hostel_stays: хто живе, з якої дати, скільки платить) і привʼязані
//    рахунки за оренду/медіа. Фінансовий шар (ціни/кауції/фактури/маржа) — лише viewFinance.
// 2) «Зняття з ЗП» — ручний реєстр знять за місяць (джерело колонки Hostel у сводній)
//    + генерація знять із проживань (прорейт по днях).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Home, Plus, Trash2, Pencil, LogOut, FileText, Users, Wand2 } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { get, post, patch, del } from "../lib/api";
import { Card, Spinner, Select, Empty, Badge, Button, Input, Modal, Label } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { monthOptions } from "../lib/dates";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";

type HostelRow = { id: number; workerId: number; workerName: string | null; city: string | null; factoryId: number | null; factoryLabel: string | null; amount: number; note: string | null };
type DeductionsData = { month: string; months: string[]; rows: HostelRow[] };

type Resident = {
  stayId: number; workerId: number; workerName: string; workerActive: boolean;
  fromDate: string; toDate: string | null; monthlyRate: number | null; rateIsCustom: boolean; note: string | null;
};
type HostelInvoice = { id: number; number: string | null; issueDate: string | null; amount: number; counterparty: string | null; category: string | null };
type Hostel = {
  id: number; name: string; city: string; address: string | null; rentModel: "whole" | "per_place";
  places: number | null; workerRate: number | null; landlord: string | null;
  companyId: number | null; companyName: string | null; active: boolean; note: string | null;
  residents: Resident[]; currentCount: number;
  // фінансовий шар (лише viewFinance)
  monthlyCost?: number | null; kaucja?: number | null; kaucjaNote?: string | null;
  invoices?: HostelInvoice[]; invoicesTotal?: number; rentCost?: number | null; deducted?: number; margin?: number | null;
};
type RegistryData = { month: string; canFinance: boolean; hostels: Hostel[] };

const r2 = (n: number) => Math.round(n * 100) / 100;
const zl = (n: number) => `${n.toFixed(2)} zł`;
const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export default function Hostels() {
  const t = useT();
  const me = useMe();
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState(months[0]!.value);
  const [tab, setTab] = useState<"registry" | "grid" | "payments" | "deductions">("registry");
  const canOps = can(me, "hostelOps") || can(me, "viewFinance");

  return (
    <>
      <PageHeader title={t("Хостели")} subtitle={t("Житло по містах: хто де живе, що воно коштує і скільки знімаємо з зарплат")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium w-fit">
          {([["registry", t("Хостели")], ["grid", t("Шахматка")], ["payments", t("Платежі")], ["deductions", t("Зняття з ЗП")]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-md px-4 py-1.5 ${tab === k ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        <Select value={month} onChange={e => setMonth(e.target.value)} className="w-56">
          {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
      </div>
      {tab === "registry" && <RegistryTab month={month} canFin={can(me, "viewFinance")} canSvodni={can(me, "svodni") || can(me, "hostelOps")} />}
      {tab === "grid" && <GridTab month={month} canOps={canOps} />}
      {tab === "payments" && <PaymentsTab month={month} canOps={canOps} />}
      {tab === "deductions" && <DeductionsTab month={month} canSvodni={can(me, "svodni")} />}
    </>
  );
}

// ── Вкладка «Хостели» (довідник) ─────────────────────────────────────────────

function RegistryTab({ month, canFin, canSvodni }: { month: string; canFin: boolean; canSvodni: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Hostel | "new" | null>(null);
  const [staying, setStaying] = useState<Hostel | null>(null);
  const [editStay, setEditStay] = useState<{ hostel: Hostel; r: Resident } | null>(null);
  const { data, isFetching } = useQuery<RegistryData>({ queryKey: ["hostels-registry", month], queryFn: () => get(`/hostels/registry?month=${month}`) });

  const remove = useMutation({
    mutationFn: (id: number) => del(`/hostels/registry/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels-registry"] }); toast.success(t("Видалено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const endStay = useMutation({
    mutationFn: (stayId: number) => patch(`/hostels/stays/${stayId}`, { toDate: new Date().toISOString().slice(0, 10) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels-registry"] }); toast.success(t("Виселено")); },
    onError: (e: any) => toast.error(e.message),
  });
  const dropStay = useMutation({
    mutationFn: (stayId: number) => del(`/hostels/stays/${stayId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels-registry"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const byCity = useMemo(() => {
    const m = new Map<string, Hostel[]>();
    for (const h of data?.hostels ?? []) (m.get(h.city) ?? m.set(h.city, []).get(h.city)!).push(h);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  return (
    <>
      {canFin && (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> {t("Додати хостел")}</Button>
        </div>
      )}
      {editing && <HostelModal hostel={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {staying && <AddStayModal hostel={staying} onClose={() => setStaying(null)} />}
      {editStay && <EditStayModal hostel={editStay.hostel} r={editStay.r} onClose={() => setEditStay(null)} />}
      {isFetching && !data ? <Spinner /> : !byCity.length ? (
        <Empty>{t("Хостелів ще немає — додай перший кнопкою вище")}</Empty>
      ) : (
        <div className="space-y-6">
          {byCity.map(([city, hostels]) => (
            <div key={city}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-bold uppercase tracking-wide text-slate-500">{t(city)}</span>
                <Badge color="slate">{hostels.length}</Badge>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {hostels.map(h => (
                  <Card key={h.id} className={`overflow-hidden ${h.active ? "" : "opacity-60"}`}>
                    <div className="flex items-start gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
                      <Home className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold tracking-tight text-slate-800">{h.name}</span>
                          <Badge color="blue">{h.rentModel === "per_place" ? t("за місце") : t("цілий будинок")}</Badge>
                          {h.places != null && <Badge color="slate">{h.places} {t("місць")}</Badge>}
                          {!h.active && <Badge color="rose">{t("неактивний")}</Badge>}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          {[h.address, h.landlord && `${t("орендодавець")}: ${h.landlord}`, h.companyName].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {canSvodni && h.active && (
                          <Button variant="ghost" onClick={() => setStaying(h)} title={t("Поселити працівника")}>
                            <Plus className="h-4 w-4" /> {t("Поселити")}
                          </Button>
                        )}
                        {canFin && (
                          <>
                            <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title={t("Редагувати")} onClick={() => setEditing(h)}>
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button className="rounded p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500" title={t("Видалити")}
                              onClick={() => window.confirm(`${h.name}: ${t("видалити хостел?")}`) && remove.mutate(h.id)}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {canFin && (
                      <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-slate-100 px-4 py-2 text-xs">
                        {h.monthlyCost != null && (
                          <span className="text-slate-500">{t("Оренда:")} <b className="tabular-nums text-slate-700">{zl(h.monthlyCost)}</b>{h.rentModel === "per_place" ? ` / ${t("місце")}` : ` / ${t("міс")}`}</span>
                        )}
                        {h.kaucja != null && (
                          <span className="text-slate-500" title={h.kaucjaNote ?? undefined}>{t("Кауція:")} <b className="tabular-nums text-slate-700">{zl(h.kaucja)}</b></span>
                        )}
                        {h.workerRate != null && (
                          <span className="text-slate-500">{t("З мешканця:")} <b className="tabular-nums text-slate-700">{zl(h.workerRate)}</b> / {t("міс")}</span>
                        )}
                      </div>
                    )}

                    <div className="px-4 py-2">
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                        <Users className="h-3.5 w-3.5" /> {t("Мешканці місяця")} · {h.residents.length}
                      </div>
                      {!h.residents.length ? (
                        <div className="py-1 text-xs text-slate-400">{t("Ніхто не заселений")}</div>
                      ) : (
                        <table className="w-full text-sm">
                          <tbody className="divide-y divide-slate-100">
                            {h.residents.map(r => (
                              <tr key={r.stayId} className="group">
                                <td className="py-1 pr-2">
                                  <Link href={`/workers/${r.workerId}`} className="text-slate-700 hover:text-red-600 hover:underline">{r.workerName}</Link>
                                  {!r.workerActive && <Badge color="rose">{t("звільнений")}</Badge>}
                                </td>
                                <td className="py-1 pr-2 text-xs tabular-nums text-slate-400">
                                  {fmtD(r.fromDate)} → {r.toDate ? fmtD(r.toDate) : t("живе")}
                                </td>
                                <td className="py-1 text-right text-xs tabular-nums text-slate-600">
                                  {r.monthlyRate != null ? <span title={r.rateIsCustom ? t("індивідуальна плата") : t("типова плата хостелу")}>{zl(r.monthlyRate)}{r.rateIsCustom ? " *" : ""}</span> : "—"}
                                </td>
                                {canSvodni && (
                                  <td className="w-20 py-1 text-right">
                                    <span className="invisible inline-flex gap-0.5 group-hover:visible">
                                      <button className="rounded p-1 text-slate-400 hover:bg-slate-100" title={t("Редагувати проживання")} onClick={() => setEditStay({ hostel: h, r })}>
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                      {!r.toDate && (
                                        <button className="rounded p-1 text-slate-400 hover:bg-amber-50 hover:text-amber-600" title={t("Виселити (закрити сьогоднішнім днем)")}
                                          onClick={() => window.confirm(`${r.workerName}: ${t("виселити сьогоднішнім днем?")}`) && endStay.mutate(r.stayId)}>
                                          <LogOut className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                      <button className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500" title={t("Видалити запис")}
                                        onClick={() => window.confirm(`${r.workerName}: ${t("видалити запис проживання?")}`) && dropStay.mutate(r.stayId)}>
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </span>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    {canFin && (
                      <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-xs">
                        {(h.invoices?.length ?? 0) > 0 && (
                          <div className="mb-1.5 space-y-0.5">
                            {h.invoices!.map(i => (
                              <div key={i.id} className="flex items-center gap-1.5 text-slate-500">
                                <FileText className="h-3 w-3 shrink-0 text-slate-300" />
                                <span className="truncate">{i.number ?? "—"}{i.counterparty ? ` · ${i.counterparty}` : ""}{i.category ? ` · ${i.category}` : ""}</span>
                                <span className="ml-auto shrink-0 tabular-nums">{zl(i.amount)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                          <span className="text-slate-500">{t("Коштує:")} <b className="tabular-nums text-slate-700">{(h.invoicesTotal ?? 0) > 0 ? zl(h.invoicesTotal!) : h.rentCost != null ? `~${zl(h.rentCost)}` : "—"}</b>{(h.invoicesTotal ?? 0) > 0 ? ` (${t("фактури")})` : h.rentCost != null ? ` (${t("за договором")})` : ""}</span>
                          <span className="text-slate-500">{t("Знято з мешканців:")} <b className="tabular-nums text-slate-700">{zl(h.deducted ?? 0)}</b></span>
                          {h.margin != null && (
                            <span className={`ml-auto font-semibold tabular-nums ${h.margin >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{h.margin >= 0 ? "+" : ""}{zl(h.margin)}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function HostelModal({ hostel, onClose }: { hostel: Hostel | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: hostel?.name ?? "", city: hostel?.city ?? "", address: hostel?.address ?? "",
    rentModel: hostel?.rentModel ?? "whole", monthlyCost: hostel?.monthlyCost != null ? String(hostel.monthlyCost) : "",
    places: hostel?.places != null ? String(hostel.places) : "", workerRate: hostel?.workerRate != null ? String(hostel.workerRate) : "",
    kaucja: hostel?.kaucja != null ? String(hostel.kaucja) : "", kaucjaNote: hostel?.kaucjaNote ?? "",
    landlord: hostel?.landlord ?? "", companyId: hostel?.companyId != null ? String(hostel.companyId) : "",
    active: hostel?.active ?? true, note: hostel?.note ?? "",
  });
  const { data: meta } = useQuery<{ companies: { id: number; name: string }[] }>({ queryKey: ["invoices-meta"], queryFn: () => get("/invoices/meta") });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name, city: f.city, address: f.address || null, rentModel: f.rentModel,
        monthlyCost: f.monthlyCost || null, places: f.places || null, workerRate: f.workerRate || null,
        kaucja: f.kaucja || null, kaucjaNote: f.kaucjaNote || null, landlord: f.landlord || null,
        companyId: f.companyId ? Number(f.companyId) : null, active: f.active, note: f.note || null,
      };
      return hostel ? patch(`/hostels/registry/${hostel.id}`, body) : post("/hostels/registry", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels-registry"] }); toast.success(t("Збережено")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={hostel ? t("Редагувати хостел") : t("Додати хостел")} size="lg">
      <div className="grid grid-cols-2 gap-3">
        <div><Label>{t("Назва")}</Label><Input value={f.name} onChange={set("name")} autoFocus /></div>
        <div><Label>{t("Місто")}</Label><Input value={f.city} onChange={set("city")} placeholder={t("Люблін / Познань / Лодзь…")} /></div>
        <div className="col-span-2"><Label>{t("Адреса")}</Label><Input value={f.address} onChange={set("address")} /></div>
        <div>
          <Label>{t("Модель оренди")}</Label>
          <Select value={f.rentModel} onChange={set("rentModel")}>
            <option value="whole">{t("цілий будинок")}</option>
            <option value="per_place">{t("платимо за місце")}</option>
          </Select>
        </div>
        <div><Label>{f.rentModel === "per_place" ? t("Ціна за місце, zł/міс") : t("Оренда, zł/міс")}</Label><Input value={f.monthlyCost} onChange={set("monthlyCost")} inputMode="decimal" /></div>
        <div><Label>{t("Кількість місць")}</Label><Input value={f.places} onChange={set("places")} inputMode="numeric" /></div>
        <div><Label>{t("Плата мешканця, zł/міс")}</Label><Input value={f.workerRate} onChange={set("workerRate")} inputMode="decimal" placeholder={t("типове зняття з ЗП")} /></div>
        <div><Label>{t("Кауція, zł")}</Label><Input value={f.kaucja} onChange={set("kaucja")} inputMode="decimal" /></div>
        <div><Label>{t("Примітка до кауції")}</Label><Input value={f.kaucjaNote} onChange={set("kaucjaNote")} placeholder={t("коли внесена, умови повернення…")} /></div>
        <div><Label>{t("Орендодавець")}</Label><Input value={f.landlord} onChange={set("landlord")} /></div>
        <div>
          <Label>{t("Фірма-платник")}</Label>
          <Select value={f.companyId} onChange={set("companyId")}>
            <option value="">—</option>
            {(meta?.companies ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="col-span-2"><Label>{t("Нотатка")}</Label><Input value={f.note} onChange={set("note")} /></div>
        {hostel && (
          <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={f.active} onChange={e => setF(s => ({ ...s, active: e.target.checked }))} />
            {t("Активний (зʼявляється у списках)")}
          </label>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
        <Button loading={save.isPending} disabled={!f.name.trim() || !f.city.trim()} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
      </div>
    </Modal>
  );
}

function WorkerPicker({ workerId, setWorkerId }: { workerId: number | null; setWorkerId: (id: number | null) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const needle = q.trim().toLowerCase();
  const found = needle.length >= 2 ? (workers ?? []).filter(w => w.fullName.toLowerCase().includes(needle)).slice(0, 8) : [];
  const sel = (workers ?? []).find(w => w.id === workerId);
  if (sel) return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
      <span className="font-medium">{sel.fullName}</span>
      <button className="ml-auto text-xs text-slate-400 hover:text-rose-500" onClick={() => setWorkerId(null)}>✕</button>
    </div>
  );
  return (
    <>
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("Пошук по імені…")} autoFocus />
      {found.length > 0 && (
        <div className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {found.map(w => (
            <button key={w.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-red-50" onClick={() => setWorkerId(w.id)}>
              {w.fullName}
              {w.factoryName && <span className="text-xs text-slate-400">{w.factoryName}</span>}
              {w.isActive === false && <Badge color="rose">{t("звільнений")}</Badge>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function AddStayModal({ hostel, onClose }: { hostel: Hostel; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState(new Date().toISOString().slice(0, 10));
  const [rate, setRate] = useState("");
  const add = useMutation({
    mutationFn: () => post("/hostels/stays", { hostelId: hostel.id, workerId, fromDate, monthlyRate: rate || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels-registry"] }); toast.success(t("Заселено")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${t("Поселити в")} ${hostel.name}`}>
      <div className="space-y-3">
        <div><Label>{t("Працівник")}</Label><WorkerPicker workerId={workerId} setWorkerId={setWorkerId} /></div>
        <div><Label>{t("Від дати")}</Label><Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} /></div>
        <div>
          <Label>{t("Плата, zł/міс")}</Label>
          <Input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal"
            placeholder={hostel.workerRate != null ? `${t("типово")} ${hostel.workerRate}` : t("необовʼязково")} />
        </div>
        <p className="text-xs text-slate-400">{t("Якщо у працівника є відкрите проживання в іншому хостелі — воно закриється днем перед новим.")}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={add.isPending} disabled={!workerId || !fromDate} onClick={() => add.mutate()}>{t("Поселити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditStayModal({ hostel, r, onClose }: { hostel: Hostel; r: Resident; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [fromDate, setFromDate] = useState(r.fromDate);
  const [toDate, setToDate] = useState(r.toDate ?? "");
  const [rate, setRate] = useState(r.rateIsCustom && r.monthlyRate != null ? String(r.monthlyRate) : "");
  const save = useMutation({
    mutationFn: () => patch(`/hostels/stays/${r.stayId}`, { fromDate, toDate: toDate || null, monthlyRate: rate || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels-registry"] }); toast.success(t("Збережено")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={`${r.workerName} · ${hostel.name}`}>
      <div className="space-y-3">
        <div><Label>{t("Від дати")}</Label><Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} /></div>
        <div><Label>{t("До дати (порожньо = живе)")}</Label><Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} /></div>
        <div>
          <Label>{t("Плата, zł/міс (порожньо = типова хостелу)")}</Label>
          <Input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal"
            placeholder={hostel.workerRate != null ? `${t("типово")} ${hostel.workerRate}` : ""} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} disabled={!fromDate} onClick={() => save.mutate()}>{t("Зберегти")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Вкладка «Зняття з ЗП» (ручний реєстр, джерело колонки Hostel у сводній) ──

function DeductionsTab({ month, canSvodni }: { month: string; canSvodni: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data, isFetching } = useQuery<DeductionsData>({ queryKey: ["hostels", month], queryFn: () => get(`/hostels?month=${month}`) });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/hostels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hostels"] }),
    onError: (e: any) => toast.error(e.message),
  });
  const edit = useMutation({
    mutationFn: (p: { id: number; amount: number }) => patch(`/hostels/${p.id}`, { amount: p.amount }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hostels"] }),
    onError: (e: any) => toast.error(e.message),
  });
  const fill = useMutation({
    mutationFn: () => post("/hostels/fill-deductions", { month }),
    onSuccess: (r: { created: number; skippedExisting: number; skippedNoRate: number; total: number }) => {
      qc.invalidateQueries({ queryKey: ["hostels"] });
      toast.success(`${t("Створено:")} ${r.created} (${r.total.toFixed(2)} zł) · ${t("пропущено (уже є):")} ${r.skippedExisting} · ${t("без ставки:")} ${r.skippedNoRate}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  // місто → фабрика → рядки
  const groups = useMemo(() => {
    const byCity = new Map<string, Map<string, HostelRow[]>>();
    for (const r of data?.rows ?? []) {
      const c = r.city ?? "—";
      const f = r.factoryLabel ?? t("Без фабрики");
      const m = byCity.get(c) ?? byCity.set(c, new Map()).get(c)!;
      (m.get(f) ?? m.set(f, []).get(f)!).push(r);
    }
    return [...byCity.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, t]);
  const total = r2((data?.rows ?? []).reduce((a, r) => a + r.amount, 0));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {data && <Badge color="green">{t("Знято разом:")} {total.toFixed(2)} zł</Badge>}
        {data && <Badge color="slate">{data.rows.length} {t("ос.")}</Badge>}
        {canSvodni && (
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" loading={fill.isPending}
              onClick={() => window.confirm(t("Заповнити зняття місяця з проживань? Люди, що вже мають зняття, будуть пропущені.")) && fill.mutate()}>
              <Wand2 className="h-4 w-4" /> {t("Заповнити з хостелів")}
            </Button>
            <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати зняття")}</Button>
          </div>
        )}
      </div>
      {adding && <AddHostelModal month={month} onClose={() => setAdding(false)} />}
      {isFetching && !data ? <Spinner /> : !groups.length ? (
        <Empty>{t("За цей місяць знять за хостел немає")}</Empty>
      ) : (
        <div className="space-y-5">
          {groups.map(([city, byFactory]) => (
            <Card key={city} className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
                <Home className="h-4 w-4 text-slate-400" />
                <span className="text-sm font-bold tracking-tight text-slate-800">{t(city)}</span>
                <Badge color="slate">{[...byFactory.values()].reduce((a, rs) => a + rs.length, 0)} {t("ос.")}</Badge>
                <span className="ml-auto text-sm font-semibold tabular-nums text-slate-700">
                  {r2([...byFactory.values()].flat().reduce((a, r) => a + r.amount, 0)).toFixed(2)} zł
                </span>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {[...byFactory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([factory, rows]) => [
                    <tr key={`f-${factory}`} className="bg-slate-50/80">
                      <td className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">{factory}</td>
                      <td className="px-4 py-1.5 text-right text-[11px] font-semibold tabular-nums text-slate-500">
                        {r2(rows.reduce((a, r) => a + r.amount, 0)).toFixed(2)} zł
                      </td>
                      <td />
                    </tr>,
                    ...rows.map(r => (
                      <tr key={r.id} className="group hover:bg-red-50/30">
                        <td className="px-4 py-1.5 pl-8 text-slate-700">
                          {r.workerName ?? `#${r.workerId}`}
                          {r.note && <span className="ml-2 text-xs text-slate-400">{r.note}</span>}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">
                          <AmountCell value={r.amount} onSave={(v) => edit.mutate({ id: r.id, amount: v })} />
                        </td>
                        <td className="w-10 px-2 text-right">
                          <button type="button" title={t("Видалити")}
                            onClick={() => window.confirm(`${r.workerName ?? r.workerId}: ${t("видалити зняття?")}`) && remove.mutate(r.id)}
                            className="invisible rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500 group-hover:visible">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function AmountCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => { const v = Number(draft.replace(",", ".")); if (Number.isFinite(v) && v > 0 && v !== value) onSave(v); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
        className="w-24 rounded-md border border-red-400 px-1 py-0.5 text-right text-sm focus:outline-none" />
    );
  }
  return (
    <button type="button" onClick={() => { setDraft(String(value)); setEditing(true); }}
      title={t("Клікни, щоб редагувати")}
      className="cursor-text rounded px-1 tabular-nums hover:bg-red-50 hover:ring-1 hover:ring-red-200">
      {value.toFixed(2)}
    </button>
  );
}

function AddHostelModal({ month, onClose }: { month: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const add = useMutation({
    mutationFn: () => post("/hostels", { month, workerId, amount: Number(amount.replace(",", ".")) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hostels"] }); toast.success(t("Додано")); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Додати зняття за хостел")}>
      <div className="space-y-3">
        <div><Label>{t("Працівник")}</Label><WorkerPicker workerId={workerId} setWorkerId={setWorkerId} /></div>
        <div><Label>{t("Сума, zł")}</Label><Input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={add.isPending} disabled={!workerId || !(Number(amount.replace(",", ".")) > 0)} onClick={() => add.mutate()}>{t("Додати")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Вкладка «Шахматка» — кімнати × мешканці за місяць ────────────────────────

type GridRoom = { id: number; label: string; capacity: number | null; roomType: string | null; basePrice: number | null; occupants: GridOccupant[] };
type GridOccupant = { stayId: number; workerId: number | null; name: string; roomId: number | null; fromDate: string; toDate: string | null; payer: string | null; note: string | null };
type GridData = { month: string; rooms: GridRoom[]; unassigned: GridOccupant[] };
type HostelOption = { id: number; name: string; city: string | null };

function GridTab({ month, canOps }: { month: string; canOps: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: options = [] } = useQuery<HostelOption[]>({ queryKey: ["hostels-options"], queryFn: () => get("/hostels/options") });
  const [hostelId, setHostelId] = useState<string>("");
  const effId = hostelId || (options[0] ? String(options[0].id) : "");
  const { data, isLoading } = useQuery<GridData>({
    queryKey: ["hostel-grid", effId, month],
    queryFn: () => get(`/hostels/${effId}/grid?month=${month}`),
    enabled: !!effId,
  });
  const [addingRoom, setAddingRoom] = useState(false);

  const totalCap = (data?.rooms ?? []).reduce((s, r) => s + (r.capacity ?? 0), 0);
  const totalOcc = (data?.rooms ?? []).reduce((s, r) => s + r.occupants.length, 0) + (data?.unassigned.length ?? 0);

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <Select value={effId} onChange={e => setHostelId(e.target.value)} className="w-64">
          {options.map(h => <option key={h.id} value={h.id}>{h.name}{h.city ? ` (${h.city})` : ""}</option>)}
        </Select>
        <span className="text-sm text-slate-500">{t("зайнято")} <b>{totalOcc}</b> / {totalCap || "?"} {t("місць")}</span>
        {canOps && <Button variant="secondary" onClick={() => setAddingRoom(true)}><Plus className="h-4 w-4" /> {t("Кімната")}</Button>}
      </div>
      {isLoading ? <Spinner /> : !data ? <Empty>{t("Оберіть хостел")}</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.rooms.map(room => {
            const free = room.capacity != null ? room.capacity - room.occupants.length : null;
            return (
              <Card key={room.id} className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-semibold text-slate-700">
                    {room.label} {room.roomType === "family" && <Badge color="blue">{t("сімейна")}</Badge>}
                  </div>
                  <div className="text-xs text-slate-400">
                    {room.capacity != null && (
                      free! > 0 ? <Badge color="green">{t("вільно")} {free}</Badge>
                        : free === 0 ? <Badge color="amber">{t("повна")}</Badge>
                        : <Badge color="rose">{t("перебір")} {-free!}</Badge>
                    )}
                  </div>
                </div>
                {room.basePrice != null && <div className="mb-1 text-xs text-slate-400">{zl(room.basePrice)}/{t("міс")}</div>}
                {!room.occupants.length ? <div className="text-sm text-slate-300">{t("порожньо")}</div> : (
                  <ul className="space-y-1 text-sm">
                    {room.occupants.map(o => (
                      <li key={o.stayId} className="flex items-center justify-between gap-2">
                        <span className="truncate text-slate-600">
                          {o.workerId != null
                            ? <Link href={`/workers/${o.workerId}`} className="hover:text-red-600 hover:underline">{o.name}</Link>
                            : <span title={t("мешканець без профілю в базі")}>{o.name} ·</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                          {o.payer === "payroll" ? t("з ЗП") : o.payer === "self" ? t("готівка") : ""}
                          <a href={`/api/hostels/stays/${o.stayId}/umowa`} target="_blank" rel="noreferrer"
                            title={t("Umowa najmu (друк)")} className="rounded p-0.5 hover:bg-red-50 hover:text-red-600">
                            <FileText className="h-3.5 w-3.5" />
                          </a>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
          {data.unassigned.length > 0 && (
            <Card className="border-dashed p-3">
              <div className="mb-2 font-semibold text-slate-500">{t("Без кімнати")}</div>
              <ul className="space-y-1 text-sm">
                {data.unassigned.map(o => <li key={o.stayId} className="text-slate-600">{o.name}</li>)}
              </ul>
            </Card>
          )}
        </div>
      )}
      {addingRoom && effId && (
        <RoomModal hostelId={Number(effId)} onClose={() => setAddingRoom(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["hostel-grid"] }); setAddingRoom(false); }} />
      )}
    </>
  );
}

function RoomModal({ hostelId, onClose, onSaved }: { hostelId: number; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [f, setF] = useState({ label: "", capacity: "", roomType: "", basePrice: "" });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => post("/hostels/rooms", {
      hostelId, label: f.label, capacity: f.capacity ? Number(f.capacity) : null,
      roomType: f.roomType || null, basePrice: f.basePrice ? Number(f.basePrice) : null,
    }),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Нова кімната")}>
      <div className="space-y-3">
        <div><Label>{t("Назва")}</Label><Input value={f.label} onChange={set("label")} placeholder={t("Номер 1")} autoFocus /></div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>{t("Місць")}</Label><Input type="number" value={f.capacity} onChange={set("capacity")} /></div>
          <div><Label>{t("Тип")}</Label>
            <Select value={f.roomType} onChange={set("roomType")}>
              <option value="">{t("звичайна")}</option><option value="family">{t("сімейна")}</option>
            </Select></div>
          <div><Label>{t("Ціна, зл/міс")}</Label><Input type="number" value={f.basePrice} onChange={set("basePrice")} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => f.label.trim() && save.mutate()}>{t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Вкладка «Платежі» — готівка/картка мешканців за місяць ───────────────────

type PaymentRow = { id: number; hostelId: number; hostelName: string | null; workerId: number | null; residentName: string | null; amount: number; method: string; note: string | null };

function PaymentsTab({ month, canOps }: { month: string; canOps: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ months: string[]; rows: PaymentRow[] }>({
    queryKey: ["hostel-payments", month],
    queryFn: () => get(`/hostels/payments?month=${month}`),
  });
  const { data: options = [] } = useQuery<HostelOption[]>({ queryKey: ["hostels-options"], queryFn: () => get("/hostels/options") });
  const [adding, setAdding] = useState(false);
  const inv = () => qc.invalidateQueries({ queryKey: ["hostel-payments"] });
  const remove = useMutation({ mutationFn: (id: number) => del(`/hostels/payments/${id}`), onSuccess: () => { inv(); toast.success(t("Видалено")); }, onError: (e: any) => toast.error(e.message) });

  const rows = data?.rows ?? [];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const byMethod = (m: string) => rows.filter(r => r.method === m).reduce((s, r) => s + r.amount, 0);

  return (
    <>
      <div className="mb-3 flex items-center gap-4 text-sm text-slate-500">
        <span>{t("Разом")}: <b>{zl(r2(total))}</b></span>
        <span>{t("готівка")}: {zl(r2(byMethod("cash")))}</span>
        <span>{t("з ЗП (історія)")}: {zl(r2(byMethod("payroll")))}</span>
        {canOps && <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {t("Додати платіж")}</Button>}
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? <Spinner /> : !rows.length ? <Empty>{t("Немає платежів за цей місяць")}</Empty> : (
          <table className="w-full min-w-120 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2.5">{t("Хостел")}</th><th className="px-3 py-2.5">{t("Мешканець")}</th>
                <th className="px-3 py-2.5 text-right">{t("Сума")}</th><th className="px-3 py-2.5">{t("Спосіб")}</th>
                <th className="px-3 py-2.5">{t("Нотатка")}</th><th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-600">{r.hostelName ?? "—"}</td>
                  <td className="px-3 py-2 font-medium text-slate-700">{r.residentName ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{zl(r.amount)}</td>
                  <td className="px-3 py-2">
                    {r.method === "cash" ? <Badge color="green">{t("готівка")}</Badge>
                      : r.method === "card" ? <Badge color="blue">{t("картка")}</Badge>
                      : <Badge color="slate">{t("з ЗП")}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{r.note ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    {canOps && (
                      <button onClick={() => remove.mutate(r.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adding && (
        <PaymentModal month={month} options={options} onClose={() => setAdding(false)} onSaved={() => { inv(); setAdding(false); }} />
      )}
    </>
  );
}

function PaymentModal({ month, options, onClose, onSaved }: { month: string; options: HostelOption[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data: workers = [] } = useQuery<{ id: number; fullName: string }[]>({ queryKey: ["workers-light"], queryFn: () => get("/workers") });
  const [f, setF] = useState({ hostelId: options[0] ? String(options[0].id) : "", workerId: "", residentName: "", amount: "", method: "cash", note: "" });
  const set = (k: keyof typeof f) => (e: any) => setF(s => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => post("/hostels/payments", {
      month, hostelId: Number(f.hostelId), workerId: f.workerId ? Number(f.workerId) : null,
      residentName: f.residentName, amount: Number(f.amount), method: f.method, note: f.note,
    }),
    onSuccess: () => { toast.success(t("Збережено")); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Modal open onClose={onClose} title={t("Новий платіж мешканця")}>
      <div className="space-y-3">
        <div><Label>{t("Хостел")}</Label>
          <Select value={f.hostelId} onChange={set("hostelId")}>
            {options.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </Select></div>
        <div><Label>{t("Працівник (якщо є в базі)")}</Label>
          <Select value={f.workerId} onChange={set("workerId")}>
            <option value="">—</option>
            {workers.map((w: any) => <option key={w.id} value={w.id}>{w.fullName}</option>)}
          </Select></div>
        {!f.workerId && <div><Label>{t("Або імʼя мешканця")}</Label><Input value={f.residentName} onChange={set("residentName")} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <div><Label>{t("Сума, зл")}</Label><Input type="number" value={f.amount} onChange={set("amount")} autoFocus /></div>
          <div><Label>{t("Спосіб")}</Label>
            <Select value={f.method} onChange={set("method")}>
              <option value="cash">{t("готівка")}</option><option value="card">{t("картка")}</option>
            </Select></div>
        </div>
        <div><Label>{t("Нотатка")}</Label><Input value={f.note} onChange={set("note")} /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          <Button loading={save.isPending} onClick={() => f.hostelId && Number(f.amount) > 0 && save.mutate()}>{t("Створити")}</Button>
        </div>
      </div>
    </Modal>
  );
}
