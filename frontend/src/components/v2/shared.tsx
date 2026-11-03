import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import type { CallRecord, CaseSnapshot, EscalationCode } from "../../types";
import type { LiveCall } from "../../lib/useEngine";
import { ORDER_FACTS, PURPOSE_FACTS } from "../../lib/purposes";
import type { HeardSource } from "../RightColumn";

export const recToLive = (r: CallRecord): LiveCall => ({
  call_id: r.id, party_kind: r.goal.party_kind, party_id: r.goal.party_id, party_name: r.goal.party_name, seat: r.seat, purpose: r.goal.purpose,
  status: "ended", outcome: r.outcome, transcript: r.transcript, facts: { ...r.facts, ...(r.safety_flag ? { safety_concern: r.safety_flag } : {}) },
  factOrder: Object.keys(r.facts), yourTurn: false, startedAt: r.started_at, seq: 0,
});

export function heardForCall(c: LiveCall): HeardSource {
  return { label: c.party_name, facts: c.facts, order: c.factOrder, expected: PURPOSE_FACTS[c.purpose] ?? [], live: c.status !== "ended" && c.status !== "ringing", kind: "call" };
}
export function heardForFax(snap: CaseSnapshot, id: string): HeardSource | null {
  const f = snap.faxes[id];
  if (!f || f.direction !== "inbound") return null;
  return { label: `signed order ${f.id}`, facts: f.facts, order: ORDER_FACTS.map(([k]) => k).filter((k) => f.facts[k]), expected: ORDER_FACTS, live: false, kind: "fax" };
}

export const ESC_TITLE: Record<EscalationCode, string> = {
  SUPPLIERS_EXHAUSTED: "No supplier nearby can take her",
  ELIGIBILITY_CONFLICT: "A supplier found a coverage conflict",
  ORDER_UNSIGNED: "Dr. Chen's office isn't sending the signed order",
  ORDER_NEEDS_CLINICAL_FIX: "The order needs Dr. Chen's clinical judgment",
  DOCS_INSUFFICIENT: "The supplier says the notes don't support coverage",
  PATIENT_UNREACHABLE: "We can't reach Eleanor",
  PATIENT_COST_CONCERN: "Eleanor is worried about the cost",
  PATIENT_DECLINES: "Eleanor doesn't want to go ahead",
  AMBIGUOUS_CALL_OUTCOME: "A call didn't give a clear answer",
  SAFETY_CONCERN: "Possible safety concern",
};

export function Modal({ open, onClose, title, sub, children, wide = false }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6">
      <div className="anim-fade absolute inset-0 bg-[rgb(15_23_32/0.32)]" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" className={`anim-fade relative flex max-h-[min(860px,92vh)] w-full flex-col overflow-hidden rounded-2xl border border-line bg-[var(--bg)] shadow-2xl ${wide ? "max-w-[1120px]" : "max-w-[760px]"}`}>
        <header className="flex items-start gap-3 border-b border-line bg-surface px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[18px] font-semibold leading-tight">{title}</h2>
            {sub && <p className="mt-0.5 text-[12.5px] text-muted">{sub}</p>}
          </div>
          <button className="btn btn-ghost -mr-1.5 px-1.5" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Section({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted" style={{ fontFamily: "IBM Plex Sans, system-ui, sans-serif" }}>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
