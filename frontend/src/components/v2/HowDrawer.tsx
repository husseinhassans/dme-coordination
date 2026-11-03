import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CaseSnapshot, MachineName, TimelineEvent } from "../../types";
import { deriveMachines, MACHINE_TITLE } from "../../lib/machines";
import { HeardPanel, RulesCard, ThesisStrip, type HeardSource } from "../RightColumn";
import { StateMachine } from "../StateMachine";
import { SupplierBoard } from "../LeftColumn";

type Tab = "decision" | "machines" | "suppliers";

/** The reviewer's view: facts with quotes, the rule that fired, and the state machines. */
export function HowDrawer({ open, onClose, snap, ev, heard, waiting }: { open: boolean; onClose: () => void; snap: CaseSnapshot | null; ev: TimelineEvent | null; heard: HeardSource | null; waiting: boolean }) {
  const [tab, setTab] = useState<Tab>("decision");
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  const views = deriveMachines(snap);
  return (
    <aside className="anim-slide fixed bottom-0 right-0 top-[57px] z-30 flex w-[min(560px,96vw)] flex-col border-l border-line bg-[var(--bg)] shadow-2xl" aria-label="How it decided">
      <header className="flex items-start gap-3 border-b border-line bg-surface px-5 pb-0 pt-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold">How it decided</h2>
          <p className="text-[12.5px] text-muted">The model only listens and reports facts, each with the exact words it heard. Plain code makes every decision.</p>
          <nav className="mt-2.5 flex gap-4 text-[13px]" role="tablist">
            {([["decision", "Latest decision"], ["machines", "State machines"], ["suppliers", "Supplier board"]] as [Tab, string][]).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 pb-2 ${tab === k ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>{l}</button>
            ))}
          </nav>
        </div>
        <button className="btn btn-ghost -mr-1.5 px-1.5" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {tab === "decision" && (
          <>
            <ThesisStrip />
            <HeardPanel src={heard} />
            <RulesCard ev={ev} snap={snap} waiting={waiting} label="latest" />
          </>
        )}
        {tab === "machines" && (["case", "supplier", "order", "patient"] as MachineName[]).map((m) => (
          <figure key={m} className="card p-3">
            <figcaption className="mb-1 text-[13.5px] font-semibold">{MACHINE_TITLE[m]}</figcaption>
            <StateMachine machine={m} view={views[m]} />
          </figure>
        ))}
        {tab === "suppliers" && snap && <SupplierBoard snap={snap} callingId={snap.suppliers.find((s) => s.state === "CALLING")?.supplier.id ?? null} />}
      </div>
    </aside>
  );
}
