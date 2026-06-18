import { useQuery } from "@tanstack/react-query";
import { Route, Switch, Redirect } from "wouter";
import { get, type Me } from "./lib/api";
import { canAccessPage } from "./lib/roles";
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
import Trips from "./pages/Trips";
import Finance from "./pages/Finance";
import Settings from "./pages/Settings";
import Admins from "./pages/Admins";

export default function App() {
  const onLogin = location.pathname.startsWith("/login");
  const { data: me, isLoading, isError } = useQuery<Me>({
    queryKey: ["me"], queryFn: () => get("/auth/me"), enabled: !onLogin,
  });

  if (onLogin) return <Login />;
  if (isLoading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (isError || !me) return <Login />;

  const guard = (path: string, el: React.ReactNode) =>
    canAccessPage(me.role, path) ? el : <Redirect to="/" />;

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
        <Route path="/reports">{() => guard("/reports", <Reports />)}</Route>
        <Route path="/trips">{() => guard("/trips", <Trips />)}</Route>
        <Route path="/finance">{() => guard("/finance", <Finance />)}</Route>
        <Route path="/workers/:id">{() => guard("/workers", <WorkerDetail />)}</Route>
        <Route path="/workers">{() => guard("/workers", <Workers />)}</Route>
        <Route path="/recruitment">{() => guard("/recruitment", <Recruitment />)}</Route>
        <Route path="/broadcast">{() => guard("/broadcast", <Broadcast />)}</Route>
        <Route path="/drivers">{() => guard("/drivers", <Drivers />)}</Route>
        <Route path="/factories">{() => guard("/factories", <Factories />)}</Route>
        <Route path="/settings">{() => guard("/settings", <Settings />)}</Route>
        <Route path="/admins">{() => guard("/admins", <Admins me={me} />)}</Route>
        <Route><Redirect to="/" /></Route>
      </Switch>
    </Layout>
  );
}
