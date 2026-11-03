import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, HeartHandshake, PhoneCall, X } from "lucide-react";
import type { CaseSnapshot, Escalation, SeatMode } from "../types";
import { fmtWhen } from "../lib/format";
import { Chip } from "./ui";

export function EscalationDrawer({ open, onClose, escalations, snap, selectedId, onSelect, onDecide, advocateSeat, onInspectCall }: {
  open: boolean; onClose: () => void; escalations: Escalation[]; snap: CaseSnapshot | null; selectedId: string | null; onSelect: (id: string) => void;
  onDecide: (id: string, option: string, note?: string) => void; advocateSeat: SeatMode; onInspectCall: (id: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  const sorted = useMemo(() => [...escalations].sort((a, b) => Number(!!a.decision) - Number(!!b.decision) || b.raised_at.localeCompare(a.raised_at)), [escalations]);
  const sel = escalations.find((e) => e.id === selectedId) ?? sorted[0];
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="anim-fade absolute inset-0 bg-black/25" onClick={onClose} aria-hidden />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Care advocate inbox" className="anim-slide relative flex h-full w-[min(760px,94vw)] flex-col border-l border-line bg-[var(--bg)] outline-none">
        <header className="flex items-center gap-2.5 border-b border-line bg-surface px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-human text-surface"><HeartHandshake size={16} /></span>
          <div className="leading-tight">
            <h2 className="text-[18px] font-bold">Care advocate inbox</h2>
            <p className="text-[12px] text-muted">The only ways a person gets pulled in. Each packet is the whole briefing; your answer is typed, so the engine knows where to resume.</p>
          </div>
          <button className="btn btn-ghost ml-auto px-1.5" onClick={onClose} aria-label="Close inbox"><X size={18} /></button>
        </header>
        <div className="flex min-h-0 flex-1">
          <ul className="scroll-thin w-[220px] shrink-0 overflow-y-auto border-r border-line bg-surface">
            {sorted.length === 0 && <li className="p-4 text-[12.5px] text-muted">No escalations yet. The engine handles everything else on its own.</li>}
            {sorted.map((e) => (
              <li key={e.id}>
                <button onClick={() => onSelect(e.id)} className={`w-full border-b border-line px-3 py-2 text-left ${sel?.id === e.id ? "bg-human-soft" : "hover:bg-[var(--surface-2)]"}`}>
                  <div className="flex items-center gap-1.5">
                    {!e.decision && <span className="live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-human" />}
                    <span className="truncate font-mono text-[11px] font-medium text-human">{e.code}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug">{e.question}</div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-muted">{fmtWhen(e.raised_at)}{e.decision ? " · decided" : ""}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="scroll-thin min-w-0 flex-1 overflow-y-auto p-4">
            {sel && <Packet key={sel.id} esc={sel} snap={snap} onDecide={onDecide} advocateSeat={advocateSeat} onInspectCall={onInspectCall} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Packet({ esc, snap, onDecide, advocateSeat, onInspectCall }: { esc: Escalation; snap: CaseSnapshot | null; onDecide: (id: string, option: string, note?: string) => void; advocateSeat: SeatMode; onInspectCall: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const decided = esc.decision ?? sent;
  const canDecide = !decided && advocateSeat === "human";
  const lead = snap?.suppliers.find((s) => ["CONFIRMED", "COMMITTED", "DELIVERED"].includes(s.state)) ?? snap?.suppliers.find((s) => s.state === "QUALIFIED");
  return (
    <div className="grid gap-3">
      <div className="rounded-lg border-[1.5px] border-human bg-human-soft p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip" data-tone="human">{esc.code}</span>
          <span className="text-[12px] text-muted">{esc.blocking ? `blocks the ${esc.thread} thread only` : "non-blocking: nothing stops"}</span>
          <span className="ml-auto font-mono text-[11px] text-muted">{esc.id} · {fmtWhen(esc.raised_at)}</span>
        </div>
        <p className="mt-2 text-[17px] font-semibold leading-snug text-human">{esc.question}</p>
      </div>

      {esc.numbers.length > 0 && (
        <section>
          <h4 className="eyebrow mb-1">Numbers · computed by rules</h4>
          <dl className="kv rounded-md border border-line bg-surface p-2.5">{esc.numbers.map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd className="font-mono text-[12px]">{v}</dd></div>)}</dl>
        </section>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {esc.tried.length > 0 && (
          <section>
            <h4 className="eyebrow mb-1">What was tried</h4>
            <ul className="list-disc space-y-0.5 pl-4 text-[12.5px]">{esc.tried.map((t) => <li key={t}>{t}</li>)}</ul>
          </section>
        )}
        {esc.context.length > 0 && (
          <section>
            <h4 className="eyebrow mb-1">Context</h4>
            <ul className="list-disc space-y-0.5 pl-4 text-[12.5px]">{esc.context.map((t) => <li key={t}>{t}</li>)}</ul>
          </section>
        )}
      </div>
      {snap && (
        <section>
          <h4 className="eyebrow mb-1">Thread states right now</h4>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span>case <Chip state={snap.case_state} /></span>
            <span>supplier <Chip state={lead?.state ?? "—"} /> {lead && <span className="text-muted">{lead.supplier.name}</span>}</span>
            <span>order <Chip state={snap.order_state} /></span>
            <span>patient <Chip state={snap.patient_state} /></span>
          </div>
        </section>
      )}
      {esc.call_ids.length > 0 && (
        <section>
          <h4 className="eyebrow mb-1">Transcripts</h4>
          <div className="flex flex-wrap gap-1.5">
            {esc.call_ids.map((id) => {
              const c = snap?.calls[id];
              return <button key={id} className="btn !py-0.5 text-[12px]" onClick={() => onInspectCall(id)}><PhoneCall size={12} />{c ? `${c.goal.party_name} · ${fmtWhen(c.started_at)}` : id}</button>;
            })}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-line bg-surface p-3">
        <h4 className="mb-1.5 text-[13.5px] font-semibold">{decided ? "Decision" : "Your decision"}</h4>
        {decided ? (
          <div className="grid gap-1 text-[13px]">
            <div className="flex items-center gap-1.5"><Check size={15} className="text-ok" /><b>{decided}</b>{esc.resolved_at && <span className="font-mono text-[11px] text-muted">· {fmtWhen(esc.resolved_at)}</span>}</div>
            {(esc.decision_note || note) && <p className="text-muted">{esc.decision_note ?? note}</p>}
            {Object.entries(esc.decision_fields ?? {}).map(([k, v]) => <div key={k} className="font-mono text-[11.5px]"><span className="text-muted">{k}</span> = {v}</div>)}
            {!esc.decision && <p className="text-[12px] text-muted">Sent. Waiting for the engine to confirm…</p>}
          </div>
        ) : (
          <>
            {advocateSeat !== "human" && <p className="mb-2 flex items-center gap-1.5 text-[12.5px] text-llm"><Bot size={13} />The advocate seat is on Autopilot: the scenario's scripted decision will apply. Switch the seat to You to decide.</p>}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} disabled={!canDecide} placeholder="Optional note for the record (what you did, what she said)…"
              className="mb-2 w-full resize-y rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-human disabled:opacity-50" aria-label="Decision note" />
            <div className="flex flex-wrap gap-2">
              {esc.options.map((o) => (
                <button key={o} disabled={!canDecide} onClick={() => { setSent(o); onDecide(esc.id, o, note.trim() || undefined); }}
                  className="rounded-md border border-human bg-surface px-3 py-1.5 text-[13px] font-medium text-human transition-colors hover:bg-human hover:text-surface disabled:opacity-45 disabled:hover:bg-surface disabled:hover:text-human">
                  {o}
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
