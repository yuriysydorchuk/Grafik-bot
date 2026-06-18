import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FolderOpen, FileSpreadsheet, ExternalLink, Clock, Truck, FileText, Activity, CalendarX, ArrowRight } from "lucide-react";
import { get } from "../lib/api";
import { Card, Spinner, Empty } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { useT } from "../lib/i18n";

const onSite = [
  { href: "/hours", label: "Облік годин", icon: Clock, color: "text-emerald-600 bg-emerald-50" },
  { href: "/absences", label: "Відсутності й причини", icon: CalendarX, color: "text-rose-600 bg-rose-50" },
  { href: "/reliability", label: "Надійність явки", icon: Activity, color: "text-red-600 bg-red-50" },
  { href: "/trips", label: "Поїздки водіїв", icon: Truck, color: "text-sky-600 bg-sky-50" },
];

interface Reports {
  folders: { root: string | null; schedules: string | null; hours: string | null; trips: string | null; reports: string | null };
  scheduleFiles: { week: string; weekStart: string; factory: string; link: string | null }[];
}

export default function Reports() {
  const t = useT();
  const { data, isLoading } = useQuery<Reports>({ queryKey: ["reports"], queryFn: () => get("/reports") });
  if (isLoading || !data) return <Spinner />;

  const folders = [
    { label: "Графіки (Excel)", link: data.folders.schedules, icon: FileSpreadsheet, color: "text-red-600 bg-red-50" },
    { label: "Облік годин", link: data.folders.hours, icon: Clock, color: "text-emerald-600 bg-emerald-50" },
    { label: "Поїздки водіїв", link: data.folders.trips, icon: Truck, color: "text-sky-600 bg-sky-50" },
    { label: "Рапорти", link: data.folders.reports, icon: FileText, color: "text-amber-600 bg-amber-50" },
  ];

  return (
    <>
      <PageHeader title={t("Звіти")} subtitle={t("Усі дані доступні просто на сайті; Google Drive — додаткове сховище файлів")}
        action={data.folders.root ? <a href={data.folders.root} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><FolderOpen className="h-4 w-4" /> {t("Відкрити Drive")}</a> : undefined} />

      {/* On-site data — the primary source */}
      <h3 className="mb-2 text-sm font-semibold text-slate-700">{t("Дані на сайті")}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {onSite.map(s => (
          <Link key={s.href} href={s.href}
            className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
            <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl ${s.color}`}><s.icon className="h-5 w-5" /></div>
            <div className="flex items-center gap-1 text-sm font-medium text-slate-700">{t(s.label)} <ArrowRight className="h-3.5 w-3.5 text-slate-400" /></div>
          </Link>
        ))}
      </div>

      {/* Google Drive — backup copies */}
      <h3 className="mb-2 mt-8 text-sm font-semibold text-slate-700">{t("Резервні копії в Google Drive")}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {folders.map(f => (
          <a key={f.label} href={f.link ?? "#"} target="_blank" rel="noreferrer"
            className={`block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition ${f.link ? "hover:shadow-md" : "pointer-events-none opacity-50"}`}>
            <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl ${f.color}`}><f.icon className="h-5 w-5" /></div>
            <div className="flex items-center gap-1 text-sm font-medium text-slate-700">{t(f.label)} <ExternalLink className="h-3.5 w-3.5 text-slate-400" /></div>
          </a>
        ))}
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3.5"><h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700"><FileSpreadsheet className="h-4 w-4" /> {t("Готові графіки (Excel по тижнях)")}</h3></div>
        {!data.scheduleFiles.length ? <Empty>{t("Ще немає згенерованих файлів. Вони з'являються після «Затвердити графік».")}</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">{t("Тиждень")}</th><th className="px-4 py-2">{t("Фабрика")}</th><th className="px-4 py-2 text-right">{t("Файл")}</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.scheduleFiles.map((f, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{f.week}</td>
                  <td className="px-4 py-2.5 text-slate-500">{f.factory}</td>
                  <td className="px-4 py-2.5 text-right">
                    {f.link ? <a href={f.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-red-600 hover:underline">{t("Відкрити")} <ExternalLink className="h-3.5 w-3.5" /></a> : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
