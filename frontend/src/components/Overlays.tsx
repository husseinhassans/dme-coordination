import { useEffect } from "react";
import { X } from "lucide-react";
import type { MachineName } from "../types";
import { MACHINE_TITLE, type MachineView } from "../lib/machines";
import type { Toast } from "../lib/useEngine";
import { StateMachine } from "./StateMachine";

export function MachinesModal({ open, focus, views, onClose, label }: { open: boolean; focus: MachineName | null; views: Record<MachineName, MachineView>; onClose: () => void; label: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  const list: MachineName[] = focus ? [focus] : ["case", "supplier", "order", "patient"];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6">
      <div className="anim-fade absolute inset-0 bg-black/35" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label="State machines" className="anim-fade relative max-h-full w-[min(1180px,96vw)] overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-2xl scroll-thin">
        <div className="mb-3 flex items-start gap-3">
          <div>
            <h2 className="text-[22px] font-bold">{focus ? MACHINE_TITLE[focus] : "State machines"}</h2>
            <p className="text-[12.5px] text-muted">Filled blue is the current state. Blue arrows are transitions this run has taken. Dashed pink boxes are the only exits to a person. {label}</p>
          </div>
          <button className="btn btn-ghost ml-auto px-1.5" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className={`grid gap-4 ${focus ? "" : "lg:grid-cols-2"}`}>
          {list.map((m) => (
            <figure key={m} className={`rounded-lg border border-line p-3 ${!focus && m === "case" ? "lg:col-span-2" : ""}`}>
              {!focus && <figcaption className="mb-1 font-display text-[15px] font-semibold">{MACHINE_TITLE[m]}</figcaption>}
              <StateMachine machine={m} view={views[m]} />
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toasts({ toasts, onDismiss, onAction }: { toasts: Toast[]; onDismiss: (id: number) => void; onAction: (t: Toast) => void }) {
  useEffect(() => {
    const timers = toasts.filter((t) => t.tone !== "human").map((t) => setTimeout(() => onDismiss(t.id), 6000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, onDismiss]);
  return (
    <div className="pointer-events-none fixed bottom-[132px] right-4 z-30 grid w-[360px] gap-2" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className={`anim-slide pointer-events-auto rounded-lg border bg-surface p-3 shadow-lg ${t.tone === "human" ? "border-human" : t.tone === "bad" ? "border-bad" : "border-line"}`}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className={`text-[13.5px] font-semibold ${t.tone === "human" ? "text-human" : t.tone === "bad" ? "text-bad" : ""}`}>{t.title}</div>
              {t.body && <p className="mt-0.5 text-[12.5px] text-muted">{t.body}</p>}
            </div>
            <button className="text-muted hover:text-ink" onClick={() => onDismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
          </div>
          {t.action && <button className="btn btn-human mt-2 !py-0.5 text-[12.5px]" onClick={() => { onAction(t); onDismiss(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
