import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, Clock3, FileText, Phone, PhoneIncoming, PhoneOff, PhoneOutgoing, Send, Stethoscope, Truck, UserRound, X } from "lucide-react";
import type { CaseSnapshot, Escalation, FaxDocument, PartyKind, TimelineEvent } from "../types";
import type { LiveCall } from "../lib/useEngine";
import { fmtTime, fmtWhen, purposeLabel } from "../lib/format";
import { Chip, Tag, Typing } from "./ui";

const PARTY_ICON: Record<PartyKind, typeof Truck> = { supplier: Truck, office: Stethoscope, patient: UserRound };

const YOU_ARE: Record<PartyKind, (name: string) => string> = {
  patient: () => "You're Eleanor Martinez, 72. Knee surgery in March, uses a walker, lives on a fixed income. Answer however she might.",
  supplier: (n) => `You're the person who answers the phone at ${n}. The engine knows only your name, phone and address. Everything else comes from what you say.`,
  office: () => "You're the front desk at Sunrise Family Medicine (Dr. Sarah Chen's practice).",
};

export function RingingCard({ call, onPickup, onLetRing }: { call: LiveCall; onPickup: () => void; onLetRing: () => void }) {
  const Icon = PARTY_ICON[call.party_kind];
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, [call.call_id]);
  return (
    <div className="card anim-fade flex flex-1 flex-col items-center justify-center gap-5 border-human px-6 py-10 text-center">
      <div className="ring-pulse grid h-20 w-20 place-items-center rounded-full bg-human text-surface">
        <PhoneIncoming size={34} className="ring-shake" />
      </div>
      <div>
        <div className="eyebrow !text-human">Incoming · your seat</div>
        <h2 className="mt-1 text-[26px] font-bold leading-tight">The engine is calling {call.party_name}</h2>
        <p className="mx-auto mt-2 max-w-[54ch] text-[13.5px] text-muted">
          <Icon size={13} className="mr-1 inline" />{YOU_ARE[call.party_kind](call.party_name)}
          {call.purpose && <> This is a <b className="text-ink">{purposeLabel(call.purpose).toLowerCase()}</b>.</>}
        </p>
      </div>
      <div className="flex gap-3">
        <button ref={ref} className="btn btn-human px-5 py-2 text-[15px]" onClick={onPickup}><Phone size={16} />Pick up</button>
        <button className="btn px-4 py-2 text-[14px]" onClick={onLetRing}><PhoneOff size={15} />Let it ring</button>
      </div>
      <p className="text-[12px] text-muted">Letting it ring is a fact too: the rules record NO_ANSWER and schedule a retry.</p>
    </div>
  );
}

function Bubble({ speaker, text, you, partyName, animate }: { speaker: "engine" | "party"; text: string; you: boolean; partyName: string; animate: boolean }) {
  const engine = speaker === "engine";
  return (
    <div className={`${animate ? "anim-bubble " : ""}flex ${engine ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed ${engine ? "rounded-bl-md bg-accent-soft" : you ? "rounded-br-md bg-human-soft" : "rounded-br-md border border-line bg-surface"}`}>
        <div className={`mb-0.5 font-mono text-[10.5px] uppercase tracking-wide ${engine ? "text-accent" : you ? "text-human" : "text-muted"}`}>
          {engine ? "Engine · automated assistant" : you ? `You · as ${partyName}` : partyName}
        </div>
        {text}
      </div>
    </div>
  );
}

export function CallView({ call, live, onSay, onHangup, inspectNote }: { call: LiveCall; live: boolean; onSay: (t: string) => void; onHangup: () => void; inspectNote?: string }) {
  const Icon = PARTY_ICON[call.party_kind];
  const you = call.seat === "human";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [call.transcript.length, call.yourTurn]);
  useEffect(() => { if (call.yourTurn) inputRef.current?.focus(); }, [call.yourTurn]);
  const last = call.transcript[call.transcript.length - 1];
  const active = call.status !== "ended";
  const typing = live && active && !call.yourTurn && call.status === "connected";
  const typingWho = !last || last.speaker === "party" ? "engine" : "party";
  const submit = () => { const t = draft.trim(); if (!t) return; onSay(t); setDraft(""); };

  const status = call.status === "ended"
    ? <Chip state={call.outcome === "answered" ? "DONE" : "NO_ANSWER"} label={call.outcome === "answered" ? "ended" : (call.outcome ?? "ended").replace("_", " ")} />
    : call.status === "ringing" ? <span className="chip" data-tone="human">ringing</span>
    : call.status === "dialing" ? <span className="chip" data-tone="live"><PhoneOutgoing size={11} />dialing…</span>
    : <span className="chip" data-tone="live"><span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />on the line</span>;

  return (
    <div className={`card flex min-h-0 flex-1 flex-col ${you && active ? "border-human" : ""}`}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${you ? "bg-human-soft text-human" : "bg-[var(--bg)] text-muted"}`}><Icon size={17} /></span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[17px] font-semibold">{call.party_name}</h2>
            {status}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
            <span>{purposeLabel(call.purpose)}</span>
            <span aria-hidden>·</span>
            {you ? <span className="text-human">seat: You</span> : <span className="inline-flex items-center gap-1 text-llm"><Bot size={12} />seat: Autopilot (LLM persona)</span>}
            {call.startedAt && <><span aria-hidden>·</span><span className="font-mono text-[11px]">{fmtWhen(call.startedAt)}</span></>}
          </div>
        </div>
        <span className="font-mono text-[10.5px] text-muted">{call.call_id}</span>
      </header>
      {inspectNote && <div className="border-b border-line bg-[var(--surface-2)] px-4 py-1.5 text-[12px] text-muted">{inspectNote}</div>}
      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3" aria-live="polite">
        {call.transcript.length === 0 && (
          <div className="grid h-full place-items-center text-[13px] text-muted">
            {call.status === "ended" ? (call.outcome === "no_answer" ? "No answer. Nothing was said, so there are no facts." : "No transcript.") : <span className="inline-flex items-center gap-2"><PhoneOutgoing size={14} />Dialing {call.party_name}…</span>}
          </div>
        )}
        {call.transcript.map((u, i) => <Bubble key={i} speaker={u.speaker} text={u.text} you={you} partyName={call.party_name} animate={live} />)}
        {typing && (
          <div className={`flex ${typingWho === "engine" ? "justify-start" : "justify-end"}`}>
            <div className={`rounded-2xl px-3 py-2 ${typingWho === "engine" ? "bg-accent-soft text-accent" : "border border-line bg-surface text-muted"}`}><Typing /></div>
          </div>
        )}
        {call.status === "ended" && call.transcript.length > 0 && (
          <div className="pt-1 text-center font-mono text-[11px] text-muted">— call ended · {call.outcome?.replace("_", " ")} —</div>
        )}
      </div>
      {live && you && active && call.status === "connected" && (
        <footer className="border-t border-line p-3">
          <div className="flex items-end gap-2">
            <textarea ref={inputRef} rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!call.yourTurn}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder={call.yourTurn ? `Reply as ${call.party_name}…  (Enter to send, Shift+Enter for a new line)` : "The engine is talking…"}
              className="min-h-[52px] flex-1 resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] outline-none placeholder:text-muted focus:border-human disabled:opacity-60" aria-label="Your reply" />
            <div className="flex flex-col gap-1.5">
              <button className="btn btn-human" onClick={submit} disabled={!call.yourTurn || !draft.trim()}><Send size={14} />Send</button>
              <button className="btn" onClick={onHangup} disabled={!call.yourTurn}><PhoneOff size={14} />Hang up</button>
            </div>
          </div>
          {call.yourTurn && <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-human"><span className="live-dot h-1.5 w-1.5 rounded-full bg-human" />Your turn. The engine is waiting.</div>}
        </footer>
      )}
    </div>
  );
}

export function IdlePanel({ snap, children }: { snap: CaseSnapshot; children?: React.ReactNode }) {
  const blocked = snap.case_state === "BLOCKED_ON_HUMAN";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="card flex items-start gap-3 px-4 py-3">
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${blocked ? "bg-human-soft text-human" : "bg-accent-soft text-accent"}`}><Clock3 size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold">{snap.done ? "Run finished" : !snap.running ? "Paused between actions" : blocked ? "Waiting on a person for one thread; the others keep working" : "No call right now. The engine is waiting on its timers."}</div>
          <dl className="kv mt-1">
            {(["supplier", "order", "patient"] as const).map((k) => (
              <div key={k} className="contents"><dt className="capitalize">{k}</dt><dd>{snap.next_check[k] ?? "—"}</dd></div>
            ))}
          </dl>
        </div>
      </div>
      {children}
    </div>
  );
}

export function Welcome({ onStart, mock }: { onStart: () => void; mock: boolean }) {
  return (
    <div className="card flex flex-1 flex-col justify-center gap-5 px-8 py-8">
      <div>
        <div className="eyebrow">Live demo</div>
        <h2 className="mt-1 text-[28px] font-bold leading-tight">Watch the engine coordinate Eleanor's wheelchair, or take a seat and push back.</h2>
        <p className="mt-2 max-w-[66ch] text-[14px] text-muted">
          The engine calls 12 suppliers, chases Dr. Chen's office for a signed order, and keeps Eleanor informed. The LLM only listens and reports facts with quotes. Rules make every decision. A person gets pulled in only for one of ten named reasons.
        </p>
      </div>
      <ol className="grid gap-2.5 text-[13.5px] md:grid-cols-3">
        <li className="rounded-lg border border-line p-3"><b className="font-display text-[15px]">1 · Pick your seats.</b><br /><span className="text-muted">Each party is Autopilot (an LLM with a hidden persona) or You. The care advocate seat starts as You.</span></li>
        <li className="rounded-lg border border-line p-3"><b className="font-display text-[15px]">2 · Press Start.</b><br /><span className="text-muted">The simulated clock fast-forwards through two weeks of calls, faxes and timers.</span></li>
        <li className="rounded-lg border border-line p-3"><b className="font-display text-[15px]">3 · Answer the phone.</b><br /><span className="text-muted">When a call reaches your seat it rings here. Say anything. Watch what the engine heard and what the rules did.</span></li>
      </ol>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary px-5 py-2 text-[15px]" onClick={onStart}><Phone size={15} />Start Eleanor's case</button>
        {mock && <span className="text-[12.5px] text-muted">Mock mode: a scripted engine runs in your browser and speaks the same protocol as the backend.</span>}
      </div>
    </div>
  );
}

export function FaxView({ fax, inspectNote }: { fax: FaxDocument; inspectNote?: string }) {
  return (
    <div className="card flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--bg)] text-muted"><FileText size={17} /></span>
        <div className="min-w-0 flex-1 leading-tight">
          <h2 className="text-[17px] font-semibold">{fax.direction === "inbound" ? "Fax received" : "Fax sent"}</h2>
          <div className="text-[12px] text-muted">{fax.direction === "inbound" ? "from Sunrise Family Medicine" : `to ${fax.to}`} · <span className="font-mono text-[11px]">{fmtWhen(fax.sent_at)}</span></div>
        </div>
        <Tag kind="fax">{fax.direction}</Tag>
        <span className="font-mono text-[10.5px] text-muted">{fax.id}</span>
      </header>
      {inspectNote && <div className="border-b border-line bg-[var(--surface-2)] px-4 py-1.5 text-[12px] text-muted">{inspectNote}</div>}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <pre className="paper whitespace-pre-wrap break-words rounded-md border border-dashed border-line-strong px-4 py-3 font-mono text-[12.5px] leading-6">{fax.text}</pre>
      </div>
    </div>
  );
}

export function EventView({ ev, esc, onOpenEsc }: { ev: TimelineEvent; esc?: Escalation; onOpenEsc: (id: string) => void }) {
  return (
    <div className="card flex flex-1 flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-2"><Tag kind={ev.kind} /><span className="font-mono text-[12px] text-muted">{fmtWhen(ev.at)}</span></div>
      <h2 className="text-[22px] font-bold leading-tight">{ev.title}</h2>
      <p className="max-w-[70ch] whitespace-pre-line text-[14px]">{ev.detail}</p>
      {esc && (
        <div className="rounded-lg border-[1.5px] border-human bg-human-soft p-3">
          <div className="flex items-center gap-2"><span className="chip" data-tone="human">{esc.code}</span>{esc.decision ? <span className="text-[12.5px] text-muted">decided: <b className="text-ink">{esc.decision}</b></span> : <span className="text-[12.5px] text-human">waiting for a decision</span>}</div>
          <p className="mt-1.5 text-[15px] font-semibold text-human">{esc.question}</p>
          <button className="btn mt-2" onClick={() => onOpenEsc(esc.id)}>Open the packet</button>
        </div>
      )}
    </div>
  );
}

export function DoneBanner({ snap }: { snap: CaseSnapshot }) {
  const counts = useMemo(() => ({
    calls: Object.keys(snap.calls).length,
    faxes: Object.keys(snap.faxes).length,
    esc: snap.escalations.filter((e) => e.code !== "SAFETY_CONCERN").length,
  }), [snap]);
  const closed = snap.case_state === "CLOSED";
  return (
    <div className={`card anim-fade flex items-center gap-3 px-4 py-3 ${closed ? "border-ok" : ""}`}>
      <CheckCircle2 size={22} className={closed ? "text-ok" : "text-muted"} />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{closed ? `Case closed ${fmtWhen(snap.now)}` : `Run ended: ${snap.case_state}`}</div>
        <div className="text-[12.5px] text-muted">{counts.calls} calls · {counts.faxes} faxes · {counts.esc} escalation{counts.esc === 1 ? "" : "s"} to a person · click any event below to inspect it</div>
      </div>
    </div>
  );
}

export function InspectBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 py-1.5 text-[12.5px] text-accent">
      <span className="font-medium">Inspecting</span><span className="truncate text-ink">{label}</span>
      <button className="btn ml-auto !py-0.5" onClick={onBack}><X size={13} />Back to live</button>
    </div>
  );
}

export const fmtCallTime = fmtTime;
