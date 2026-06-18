import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import App from "./App";
import { ConfirmProvider } from "./components/confirm";
import { LangProvider } from "./lib/i18n";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <LangProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
      <Toaster richColors position="top-right" />
    </LangProvider>
  </QueryClientProvider>,
);
