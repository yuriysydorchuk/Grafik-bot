import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Route, Switch, Redirect } from "wouter";
import { get, type Me } from "./lib/api";
import { isTelegramWebApp, telegramLogin } from "./lib/telegram";
import { canAccessPage } from "./lib/roles";
import { useT, useLang } from "./lib/i18n";
import { Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Workers from "./pages/Workers";
import WorkerDetail from "./pages/WorkerDetail";
import Recruitment from "./pages/Recruitment";
import Broadcast from "./pages/Broadcast";
import Drivers from "./pages/Drivers";
import Factories from "./pages/Factories";
import Orders from "./pages/Orders";
import Schedule from "./pages/Schedule";
import DriverShifts from "./pages/DriverShifts";
import Availability from "./pages/Availability";
import Reports from "./pages/Reports";
import Reliability from "./pages/Reliability";
import Hours from "./pages/Hours";
import Absences from "./pages/Absences";
import Advances from "./pages/Advances";
import Trips from "./pages/Trips";
import Mileage from "./pages/Mileage";
import Finance from "./pages/Finance";
import BankStatements from "./pages/BankStatements";
import CashRegister from "./pages/CashRegister";
import Cashflow from "./pages/Cashflow";
import Balance from "./pages/Balance";
import Obligations from "./pages/Obligations";
import Invoices from "./pages/Invoices";
import Pnl from "./pages/Pnl";
import Payroll from "./pages/Payroll";
import Svodni from "./pages/Svodni";
import Hostels from "./pages/Hostels";
import Ksef from "./pages/Ksef";
import Settings from "./pages/Settings";
import Admins from "./pages/Admins";
import Security from "./pages/Security";

// Compact УКР/EN/РУС switcher for the Telegram Mini App (the full Layout with its own
// toggle is hidden there). Mirrors LangToggle in components/Layout.tsx.
function TgLangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-semibold">
      {(["uk", "en", "ru"] as const).map(l => (
        <button key={l} onClick={() => setLang(l)}
          className={`rounded-md px-2 py-1 transition ${lang === l ? "bg-red-50 text-red-700" : "text-slate-400"}`}>
          {l === "uk" ? "УКР" : l === "en" ? "EN" : "РУС"}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const t = useT();
  const { applyLang } = useLang();
  const onLogin = location.pathname.startsWith("/login");
  // Inside Telegram (Mini App) the launch hash carries initData — trade it for a session
  // BEFORE the me-query runs, otherwise its 401 bounces us to /login and drops the hash.
  const [tgReady, setTgReady] = useState(!isTelegramWebApp);
  useEffect(() => {
    if (!isTelegramWebApp) return;
    telegramLogin().finally(() => setTgReady(true));
  }, []);
  const { data: me, isLoading, isError } = useQuery<Me>({
    queryKey: ["me"], queryFn: () => get("/auth/me"), enabled: !onLogin && tgReady,
  });
  // Server-stored language wins: the TG webview forgets localStorage between openings.
  const serverLang = me?.lang;
  useEffect(() => { if (serverLang) applyLang(serverLang); }, [serverLang]); // eslint-disable-line react-hooks/exhaustive-deps

  if (onLogin) return <Login />;
  if (!tgReady || isLoading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (isError || !me) return <Login />;

  // Inside Telegram the panel is a single-purpose Mini App: driver assignments only,
  // no site chrome and no other pages — regardless of the user's web role.
  if (isTelegramWebApp) {
    return (
      <div className="min-h-dvh bg-slate-50 px-3 py-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-3 flex justify-end"><TgLangToggle /></div>
          {canAccessPage(me, "/driver-shifts")
            ? <DriverShifts />
            : <div className="py-10 text-center text-sm text-slate-500">{t("Ваша роль не має доступу до призначень водіїв.")}</div>}
        </div>
      </div>
    );
  }

  const guard = (path: string, el: React.ReactNode) =>
    canAccessPage(me, path) ? el : <Redirect to="/" />;

  return (
    <Layout me={me}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/schedule" component={Schedule} />
        <Route path="/driver-shifts">{() => guard("/driver-shifts", <DriverShifts />)}</Route>
        <Route path="/orders">{() => guard("/orders", <Orders />)}</Route>
        <Route path="/availability">{() => guard("/availability", <Availability />)}</Route>
        <Route path="/reliability">{() => guard("/reliability", <Reliability />)}</Route>
        <Route path="/hours">{() => guard("/hours", <Hours />)}</Route>
        <Route path="/absences">{() => guard("/absences", <Absences />)}</Route>
        <Route path="/advances">{() => guard("/advances", <Advances />)}</Route>
        <Route path="/reports">{() => guard("/reports", <Reports />)}</Route>
        <Route path="/trips">{() => guard("/trips", <Trips />)}</Route>
        <Route path="/mileage">{() => guard("/mileage", <Mileage />)}</Route>
        <Route path="/finance">{() => guard("/finance", <Finance />)}</Route>
        <Route path="/bank">{() => guard("/bank", <BankStatements />)}</Route>
        <Route path="/cash">{() => guard("/cash", <CashRegister />)}</Route>
        <Route path="/cashflow">{() => guard("/cashflow", <Cashflow />)}</Route>
        <Route path="/balance">{() => guard("/balance", <Balance />)}</Route>
        <Route path="/obligations">{() => guard("/obligations", <Obligations />)}</Route>
        <Route path="/invoices">{() => guard("/invoices", <Invoices />)}</Route>
        <Route path="/pnl">{() => guard("/pnl", <Pnl />)}</Route>
        <Route path="/payroll">{() => guard("/payroll", <Payroll />)}</Route>
        <Route path="/svodni">{() => guard("/svodni", <Svodni />)}</Route>
        <Route path="/hostels">{() => guard("/hostels", <Hostels />)}</Route>
        <Route path="/ksef">{() => guard("/ksef", <Ksef />)}</Route>
        <Route path="/workers/:id">{() => guard("/workers", <WorkerDetail />)}</Route>
        <Route path="/workers">{() => guard("/workers", <Workers />)}</Route>
        <Route path="/recruitment">{() => guard("/recruitment", <Recruitment />)}</Route>
        <Route path="/broadcast">{() => guard("/broadcast", <Broadcast />)}</Route>
        <Route path="/drivers">{() => guard("/drivers", <Drivers />)}</Route>
        <Route path="/factories">{() => guard("/factories", <Factories />)}</Route>
        <Route path="/settings">{() => guard("/settings", <Settings />)}</Route>
        <Route path="/admins">{() => guard("/admins", <Admins me={me} />)}</Route>
        <Route path="/security">{() => guard("/security", <Security />)}</Route>
        <Route><Redirect to="/" /></Route>
      </Switch>
    </Layout>
  );
}
