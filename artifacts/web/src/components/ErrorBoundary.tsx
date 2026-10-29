// Межа помилок рендеру (docs/tasks/2026-10-29-feedback-module.md): замість білого екрана —
// картка «Щось зламалось» з кнопками «Зголосити» (віджет відкривається з уже прикріпленою
// помилкою) і «Оновити». Скидається при зміні маршруту (key у App.tsx).
import { Component, type ReactNode } from "react";
import { record } from "../lib/breadcrumbs";

type P = { children: ReactNode; onReport: (e: { message: string; stack?: string; source?: string }) => void; labels: { title: string; sub: string; report: string; reload: string } };
type S = { error: Error | null };

export class ErrorBoundary extends Component<P, S> {
  state: S = { error: null };
  static getDerivedStateFromError(error: Error): S { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const comp = (info.componentStack ?? "").split("\n").map(s => s.trim()).filter(Boolean)[0];
    record({ type: "error", text: `render: ${error.message}${comp ? ` — ${comp}` : ""}` });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const l = this.props.labels;
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-rose-200 bg-rose-50/60 p-6 text-center">
        <div className="text-base font-semibold text-slate-800">{l.title}</div>
        <div className="mt-1 text-sm text-slate-500">{l.sub}</div>
        <pre className="mt-3 max-h-24 overflow-auto rounded-lg bg-white/70 p-2 text-left font-mono text-[11px] text-rose-700">{error.message}</pre>
        <div className="mt-4 flex justify-center gap-2">
          <button onClick={() => this.props.onReport({ message: error.message, stack: String(error.stack ?? "").slice(0, 1500) })} className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-700">{l.report}</button>
          <button onClick={() => location.reload()} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{l.reload}</button>
        </div>
      </div>
    );
  }
}
