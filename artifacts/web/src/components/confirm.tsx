import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./ui";
import { useT } from "../lib/i18n";

type Opts = { title: string; message?: string; confirmText?: string; danger?: boolean };
type Resolver = (v: boolean) => void;

const Ctx = createContext<(o: Opts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<{ opts: Opts; resolve: Resolver } | null>(null);

  const confirm = useCallback((opts: Opts) => new Promise<boolean>((resolve) => setState({ opts, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {state && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4" onClick={() => close(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${state.opts.danger ? "bg-rose-100 text-rose-600" : "bg-red-100 text-red-600"}`}>
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-slate-800">{state.opts.title}</h3>
                {state.opts.message && <p className="mt-1 text-sm text-slate-500">{state.opts.message}</p>}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => close(false)}>{t("Скасувати")}</Button>
              <Button variant={state.opts.danger ? "danger" : "primary"} onClick={() => close(true)}>{state.opts.confirmText ?? t("Підтвердити")}</Button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
