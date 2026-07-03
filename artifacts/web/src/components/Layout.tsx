import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, CalendarRange, ClipboardList, CheckSquare,
  Users, Truck, LogOut, Menu, X,
  FolderOpen, Activity, Route, Clock, CalendarX, Wallet, HandCoins, UserPlus, Megaphone, Settings as SettingsIcon, Gauge,
  PanelLeftClose, PanelLeftOpen, type LucideIcon,
} from "lucide-react";
import { cn } from "./ui";
import { post, type Me } from "../lib/api";
import { canAccessPage } from "../lib/roles";
import { NotificationBell } from "./NotificationBell";
import { useT, useLang } from "../lib/i18n";

function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-semibold">
      {(["uk", "en"] as const).map(l => (
        <button key={l} onClick={() => setLang(l)}
          className={cn("rounded-md px-2 py-1 transition", lang === l ? "bg-red-50 text-red-700" : "text-slate-400 hover:text-slate-600")}>
          {l === "uk" ? "УКР" : "EN"}
        </button>
      ))}
    </div>
  );
}

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { title?: string; items: NavItem[] };

const NAV: NavGroup[] = [
  { items: [{ href: "/", label: "Огляд", icon: LayoutDashboard }] },
  {
    title: "Планування",
    items: [
      { href: "/schedule", label: "Графіки", icon: CalendarRange },
      { href: "/driver-shifts", label: "Призначення водіїв", icon: Truck },
      { href: "/orders", label: "Замовлення", icon: ClipboardList },
      { href: "/availability", label: "Доступність", icon: CheckSquare },
    ],
  },
  {
    title: "Персонал",
    items: [
      { href: "/workers", label: "Працівники", icon: Users },
      { href: "/drivers", label: "Водії", icon: Truck },
      { href: "/recruitment", label: "Рекрутація", icon: UserPlus },
      { href: "/broadcast", label: "Розсилка", icon: Megaphone },
    ],
  },
  {
    title: "Аналітика",
    items: [
      { href: "/reliability", label: "Надійність", icon: Activity },
      { href: "/hours", label: "Облік годин", icon: Clock },
      { href: "/absences", label: "Відсутності", icon: CalendarX },
      { href: "/advances", label: "Аванси", icon: HandCoins },
      { href: "/trips", label: "Поїздки", icon: Route },
      { href: "/mileage", label: "Звіт по пробігу", icon: Gauge },
      { href: "/reports", label: "Звіти / Drive", icon: FolderOpen },
    ],
  },
  {
    title: "Фінанси",
    items: [{ href: "/finance", label: "Фінанси", icon: Wallet }],
  },
  {
    items: [{ href: "/settings", label: "Налаштування", icon: SettingsIcon }],
  },
];

const ALL_ITEMS = NAV.flatMap(g => g.items);
const titleFor = (loc: string) => {
  const match = ALL_ITEMS
    .filter(i => (i.href === "/" ? loc === "/" : loc.startsWith(i.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "Euro Support";
};

function Brand({ rail = false }: { rail?: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 px-5 py-5">
      <img src="/logo.png" alt="Euro Support" className="h-10 w-10 shrink-0 object-contain" />
      <div className={cn("leading-tight", rail && "hidden group-hover/nav:block")}>
        <div className="text-sm font-bold tracking-tight text-slate-800">Euro Support</div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t("Панель графіків")}</div>
      </div>
    </div>
  );
}

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("navCollapsed") === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => { const n = !c; try { localStorage.setItem("navCollapsed", n ? "1" : "0"); } catch { /* ignore */ } return n; });
  const t = useT();

  async function logout() {
    await post("/auth/logout");
    location.href = "/login";
  }

  const groups = NAV
    .map(g => ({ ...g, items: g.items.filter(i => canAccessPage(me, i.href)) }))
    .filter(g => g.items.length > 0);

  // `rail` = collapsed icon-only mode (labels appear on hover via the group/nav peer)
  const renderSidebar = (rail: boolean) => (
    <>
      <Brand rail={rail} />
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {groups.map((group, gi) => (
          <div key={gi}>
            {group.title && (
              <div className={cn("mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400", rail && "hidden group-hover/nav:block")}>
                {t(group.title)}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = href === "/" ? loc === "/" : loc.startsWith(href);
                return (
                  <Link key={href} href={href} onClick={() => setOpen(false)} title={rail ? t(label) : undefined}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                      active ? "bg-red-50 text-red-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                    )}>
                    {active && <span className="absolute left-0 h-5 w-1 rounded-r-full bg-red-600" />}
                    <Icon className={cn("h-[18px] w-[18px] shrink-0 transition", active ? "text-red-600" : "text-slate-400 group-hover:text-slate-600")} />
                    <span className={cn("truncate", rail && "hidden group-hover/nav:inline")}>{t(label)}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-slate-100 p-3">
        <div className="mb-2 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-semibold text-red-700">
            {me.name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className={cn("min-w-0 leading-tight", rail && "hidden group-hover/nav:block")}>
            <div className="truncate text-sm font-medium text-slate-700">{me.name}{me.isMain && " 👑"}</div>
            <div className="text-[11px] text-slate-400">{t(me.roleLabel ?? "Користувач")}</div>
          </div>
        </div>
        <button onClick={logout} title={rail ? t("Вийти") : undefined} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-rose-50 hover:text-rose-600">
          <LogOut className="h-4 w-4 shrink-0" /> <span className={cn(rail && "hidden group-hover/nav:inline")}>{t("Вийти")}</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* desktop sidebar: when collapsed it's a slim rail that floats open (w-64) on hover */}
      <div className={cn("relative hidden shrink-0 md:block", collapsed ? "w-16" : "w-64")}>
        <aside className={cn(
          "group/nav fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-200 bg-white transition-[width] duration-200",
          collapsed ? "w-16 hover:w-64 hover:shadow-xl" : "w-64",
        )}>
          {renderSidebar(collapsed)}
        </aside>
      </div>

      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col bg-white shadow-xl">{renderSidebar(false)}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile header */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur md:hidden">
          <button onClick={() => setOpen(!open)} className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <img src="/logo.png" alt="Euro Support" className="h-7 w-7 object-contain" />
          <span className="font-semibold text-slate-800">{t(titleFor(loc))}</span>
          <div className="ml-auto flex items-center gap-2"><LangToggle /><NotificationBell /></div>
        </header>
        {/* desktop top bar */}
        <header className="sticky top-0 z-30 hidden items-center gap-2 border-b border-slate-200 bg-white/80 px-8 py-2.5 backdrop-blur md:flex">
          <button onClick={toggleCollapsed} title={t("Згорнути меню")} className="-ml-2 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700">
            {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </button>
          <span className="text-sm font-semibold text-slate-700">{t(titleFor(loc))}</span>
          <div className="ml-auto flex items-center gap-2"><LangToggle /><NotificationBell /></div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-800">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
