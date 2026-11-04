import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import type { CaseSnapshot, MachineName, TimelineEvent } from "../../types";
import { deriveMachines, MACHINE_TITLE } from "../../lib/machines";
import { HeardPanel, RulesCard, ThesisStrip, type HeardSource } from "../RightColumn";
import { StateMachine } from "../StateMachine";
import { SupplierBoard } from "../LeftColumn";

type Tab = "decision" | "machines" | "suppliers";

/** The reviewer's view: facts with quotes, the rule that fired, and the state machines. */
export function HowDrawer({ open, onClose, snap, ev, heard, waiting }: { open: boolean; onClose: () => void; snap: CaseSnapshot | null; ev: TimelineEvent | null; heard: HeardSource | null; waiting: boolean }) {
  const [tab, setTab] = useState<Tab>("decision");
  // The diagrams are drawn ~1000px wide; in the drawer they shrink to half. Click one to see it full size.
  const [zoom, setZoom] = useState<MachineName | null>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { if (zoom) setZoom(null); else onClose(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose, zoom]);
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
          <figure key={m} className="card cursor-zoom-in p-3 hover:border-accent" onClick={() => setZoom(m)} title="Click to enlarge">
            <figcaption className="mb-1 flex items-center text-[13.5px] font-semibold">{MACHINE_TITLE[m]}<span className="ml-auto flex items-center gap-1 text-[11.5px] font-normal text-muted"><Maximize2 size={12} />Enlarge</span></figcaption>
            <StateMachine machine={m} view={views[m]} />
          </figure>
        ))}
        {tab === "suppliers" && snap && <SupplierBoard snap={snap} callingId={snap.suppliers.find((s) => s.state === "CALLING")?.supplier.id ?? null} />}
      </div>
      {zoom && createPortal(
        <div className="fixed inset-0 z-50 flex flex-col bg-black/50 p-6" onClick={() => setZoom(null)}>
          <div className="scroll-thin mx-auto flex max-h-full w-[min(1500px,96vw)] flex-col overflow-auto rounded-2xl bg-surface p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              {(["case", "supplier", "order", "patient"] as MachineName[]).map((m) => (
                <button key={m} onClick={() => setZoom(m)} className={`rounded-full border px-3 py-1 text-[13px] ${zoom === m ? "border-accent bg-accent text-surface" : "border-line text-muted hover:text-ink"}`}>{MACHINE_TITLE[m]}</button>
              ))}
              <button className="btn btn-ghost ml-auto px-1.5" onClick={() => setZoom(null)} aria-label="Close"><X size={20} /></button>
            </div>
            <div className="min-w-[1100px]"><StateMachine machine={zoom} view={views[zoom]} /></div>
            <p className="mt-2 text-[12px] text-muted">Blue: where the case is now. Bold outline: states it has been through. Blue arrows: transitions taken. Dashed: hand-offs to a person.</p>
          </div>
        </div>, document.body
      )}
    </aside>
  );
}
