import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import App from "./App";
import { ConfirmProvider } from "./components/confirm";
import { LangProvider } from "./lib/i18n";
import { useTheme } from "./lib/theme";
import "./index.css";

// sonner needs the resolved theme explicitly — its "system" mode can't see our toggle.
function ThemedToaster() {
  const { dark } = useTheme();
  return <Toaster richColors position="top-right" theme={dark ? "dark" : "light"} />;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <LangProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
      <ThemedToaster />
    </LangProvider>
  </QueryClientProvider>,
);
