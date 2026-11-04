import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import type { CaseSnapshot, MachineName, TimelineEvent } from "../../types";
import { deriveMachines, MACHINE_TITLE } from "../../lib/machines";
import { HeardPanel, RulesCard, ThesisStrip, type HeardSource } from "../RightColumn";
import { StateMachine } from "../StateMachine";
import { SupplierBoard } from "../LeftColumn";

type Tab = "decision" | "machines" | "suppliers";

/** Plain-language reading of each machine, shown under the enlarged diagram. */
const EXPLAIN: Record<MachineName, { what: string; steps: string[]; people: string }> = {
  case: {
    what: "The whole case, from intake to a correct bill. It waits on the three threads below and moves only when all of them are ready.",
    steps: [
      "Open: the supplier, order and patient threads run in parallel.",
      "Handoff ready: a supplier is confirmed and has a valid signed order (the join).",
      "Delivery scheduled: Eleanor approved the supplier and the delivery window.",
      "Delivered: the supplier's proof of delivery and Eleanor both say it arrived.",
      "Closed: the billed code matches the order (K0001), so the claim won't be denied.",
    ],
    people: "If any thread needs a person, the case goes to Blocked on human and comes back after the decision. If the supplier ghosts, it goes back to Open and the backup takes over.",
  },
  supplier: {
    what: "One copy runs for each supplier in the directory. This is how a phone number becomes a supplier we trust with her order.",
    steps: [
      "Calling: we ask whether they take new Medicare patients, accept assignment, have a K0001 in stock and deliver to her.",
      "Qualified: every answer passed, each backed by the exact words they said.",
      "Took referral: they agreed to take her. We keep one more qualified supplier as a backup.",
      "Has order, date set: they have the signed order, eligibility is clean and a delivery day is set.",
      "Delivered: they confirm delivery with a signed ticket.",
    ],
    people: "No answer means a retry; 3 misses means Unreachable. A failed check means Disqualified. Promised but didn't deliver means Ghosted: the referral is withdrawn in writing and the backup is used. A person steps in only if every supplier is used up, an answer stays unclear, or eligibility conflicts.",
  },
  order: {
    what: "Getting Dr. Chen's signed order, which Medicare requires, right the first time.",
    steps: [
      "Requested: we fax a prefilled order plus the coverage checklist for the doctor to sign.",
      "Acknowledged: someone at the office confirms they have it, and we get a name.",
      "Received and Validated: code checks the 6 required elements, K0001, quantity 1, and the date.",
      "Sent to supplier: the order goes only to the committed supplier, and follows the referral if that supplier drops.",
      "Docs OK: the supplier confirms the paperwork supports coverage.",
    ],
    people: "No reply means a nudge call (up to 3). A person steps in if it stays unsigned, if the visit note needs a clinical fix (the doctor writes it, never the AI), or if the supplier says the documents aren't enough.",
  },
  patient: {
    what: "Keeping Eleanor informed and getting her yes. Nothing is scheduled without her approval.",
    steps: [
      "Informed: the intro call explains what she'll pay (about $72 over 13 months) and collects her address and Medicare number.",
      "Approved: she agrees to the supplier and the delivery window.",
      "Delivery verified: she confirms the chair arrived.",
    ],
    people: "If we can't reach her, she's worried about cost, or she declines, a person takes over. That's a conversation about trust and money, so the engine hands over a briefing instead of persuading her.",
  },
};


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
            <div className="mt-4 grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-6 border-t border-line pt-4 text-[14px] leading-relaxed">
              <div>
                <p className="mb-2 font-medium">{EXPLAIN[zoom].what}</p>
                <ol className="list-decimal space-y-1 pl-5">{EXPLAIN[zoom].steps.map((t) => <li key={t}>{t}</li>)}</ol>
              </div>
              <div>
                <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-human">When it goes off the happy path</p>
                <p>{EXPLAIN[zoom].people}</p>
                <p className="mt-3 text-[12.5px] text-muted">Filled blue: where it is now. Bold outline: states it has passed through. Blue arrows: transitions taken. Dashed pink: hand-off to a person. Plain code moves every arrow; the AI only reports what was said.</p>
              </div>
            </div>
          </div>
        </div>, document.body
      )}
    </aside>
  );
}
