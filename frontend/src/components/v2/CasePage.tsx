import { useMemo, useState } from "react";
import { AlertCircle, Bot, Check, CheckCircle2, ChevronDown, Clock3, FileText, HeartHandshake, Phone, PhoneCall, Stethoscope, Truck, UserRound } from "lucide-react";
import type { CaseSnapshot, Escalation, SeatMode, TimelineEvent } from "../../types";
import type { LiveCall } from "../../lib/useEngine";
import { fmtDate, fmtDay, fmtTime, fmtWhen, purposeLabel } from "../../lib/format";
import { headline, KIND_LABEL, plainTitle, supplierReason, tracks, type Track } from "../../lib/plain";
import { ESC_TITLE, Section } from "./shared";

// ------------------------------------------------------------------ header + headline

export function CaseHeader({ snap, pending }: { snap: CaseSnapshot; pending: Escalation[] }) {
  const p = snap.patient;
  const h = headline(snap, pending);
  const tone = h.mood === "needs" ? "border-human/40 bg-human-soft text-human" : h.mood === "done" ? "border-ok/30 bg-ok-soft text-ok" : "border-line bg-surface text-ink";
  const Icon = h.mood === "needs" ? AlertCircle : h.mood === "done" ? CheckCircle2 : Clock3;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <h1 className="text-[28px] font-semibold leading-none tracking-tight">{p.name}</h1>
        <div className="pb-0.5 text-[13.5px] text-muted">{p.age} · {p.equipment} ({p.hcpcs}) · Original Medicare Part B</div>
      </div>
      <div className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 ${tone}`}>
        <Icon size={20} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-[16.5px] font-semibold leading-snug">{h.text}</div>
          {h.sub && <div className="mt-0.5 text-[13px] text-muted">{h.sub}</div>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ progress tracks

const TRACK_ICON = { supplier: Truck, order: Stethoscope, patient: UserRound };

function TrackRow({ t, live }: { t: Track; live: boolean }) {
  const Icon = TRACK_ICON[t.key];
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-4 py-3.5 first:pt-1 last:pb-1">
      <div className="flex items-center gap-2 pt-0.5">
        <Icon size={16} className={t.flagged ? "text-human" : "text-muted"} />
        <span className="text-[14px] font-medium">{t.title}</span>
        {live && <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" title="On a call now" />}
      </div>
      <div className="min-w-0">
        <ol className="flex items-center gap-1.5" aria-label={`${t.title} progress`}>
          {t.steps.map((s, i) => (
            <li key={s.label} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className={`h-1.5 rounded-full transition-colors duration-500 ${s.state === "done" ? "bg-ok" : s.state === "now" ? "bg-accent/70" : s.state === "flag" ? "bg-human" : "bg-line"}`} />
              <span className={`truncate text-[11.5px] ${s.state === "todo" ? "text-muted/70" : s.state === "flag" ? "text-human" : "text-muted"}`}>
                {s.state === "done" && <Check size={10} className="mr-0.5 inline text-ok" />}{s.label}
                <span className="sr-only">{s.state}</span>
              </span>
              {i === t.steps.length - 1 && null}
            </li>
          ))}
        </ol>
        <div className={`mt-1.5 text-[13.5px] ${t.flagged ? "text-human" : ""}`}>{t.status}</div>
        {t.next && !["done", "—", "now"].includes(t.next) && <div className="text-[12px] text-muted">Next: {t.next}</div>}
      </div>
    </div>
  );
}

export function Tracks({ snap, liveThreads }: { snap: CaseSnapshot; liveThreads: Set<string> }) {
  const supplierLive = liveThreads.has("supplier");
  const ts = useMemo(() => tracks(snap, supplierLive), [snap, supplierLive]);
  return (
    <div className="card divide-y divide-line px-5 py-3">
      {ts.map((t) => <TrackRow key={t.key} t={t} live={liveThreads.has(t.key)} />)}
    </div>
  );
}

// ------------------------------------------------------------------ needs you

export function NeedsYou({ esc, snap, advocateSeat, onDecide, onOpenCall, replay }: {
  esc: Escalation; snap: CaseSnapshot; advocateSeat: SeatMode; onDecide: (id: string, option: string, note?: string) => void; onOpenCall: (id: string) => void;
  /** Replays are read-only: show the choices, then continue to the recorded decision. */
  replay?: { onContinue: () => void };
}) {
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const you = advocateSeat === "human";
  return (
    <div className="anim-fade overflow-hidden rounded-xl border-[1.5px] border-human/60 bg-surface shadow-[var(--shadow)]">
      <div className="flex items-center gap-2 border-b border-human/20 bg-human-soft px-4 py-2 text-[12.5px] text-human">
        <HeartHandshake size={15} /><b>Needs you</b><span className="text-human/80">· raised {fmtWhen(esc.raised_at)}</span>
        <span className="ml-auto text-muted">{esc.blocking ? `Only the ${esc.thread === "order" ? "order" : esc.thread} work waits on this` : "Nothing is waiting on this"}</span>
      </div>
      <div className="space-y-3 px-4 py-3.5">
        <div>
          <h3 className="text-[18px] font-semibold leading-snug">{ESC_TITLE[esc.code] ?? esc.code}</h3>
          <p className="mt-1 text-[14px]">{esc.question}</p>
        </div>
        {(esc.context.length > 0 || esc.numbers.length > 0) && (
          <div className="space-y-3">
            {esc.context.length > 0 && (
              <ul className="space-y-1 text-[13px]">{esc.context.map((c) => <li key={c} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted" />{c}</li>)}</ul>
            )}
            {esc.numbers.length > 0 && (
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 rounded-lg bg-[var(--bg)] px-3.5 py-2.5 text-[13px]">
                {esc.numbers.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="text-right tabular-nums">{v}</dd></div>)}
              </dl>
            )}
          </div>
        )}
        {esc.tried.length > 0 && <p className="text-[12.5px] text-muted">Already tried: {esc.tried.join(" · ")}</p>}
        {esc.call_ids.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {esc.call_ids.map((id) => {
              const c = snap.calls[id];
              return <button key={id} className="btn !py-0.5 text-[12.5px]" onClick={() => onOpenCall(id)}><PhoneCall size={12} />Hear the call{c ? ` with ${c.goal.party_name.split(" ")[0]}` : ""}</button>;
            })}
          </div>
        )}
        {replay ? (
          <div className="space-y-2.5 border-t border-line pt-3">
            <div className="flex flex-wrap gap-2">{esc.options.map((o) => <span key={o} className="rounded-lg border border-line px-3 py-1 text-[13px] text-muted">{o}</span>)}</div>
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn btn-human px-3.5 py-1.5 text-[13.5px]" onClick={replay.onContinue}>See what the care advocate chose</button>
              <span className="text-[12.5px] text-muted">The replay paused here. In a live run, you'd decide.</span>
            </div>
          </div>
        ) : sent ? (
          <p className="flex items-center gap-1.5 text-[13.5px]"><Check size={15} className="text-ok" />You chose <b>{sent}</b>. Sending to the engine…</p>
        ) : you ? (
          <div className="space-y-2 border-t border-line pt-3">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note for the record (optional): what you did, what she said…"
              className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-human" aria-label="Decision note" />
            <div className="flex flex-wrap gap-2">
              {esc.options.map((o, i) => (
                <button key={o} onClick={() => { setSent(o); onDecide(esc.id, o, note.trim() || undefined); }}
                  className={`rounded-lg border px-3.5 py-1.5 text-[13.5px] font-medium transition ${i === 0 ? "border-human bg-human text-surface hover:brightness-110" : "border-line-strong bg-surface text-ink hover:border-human hover:text-human"}`}>
                  {o}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 border-t border-line pt-3 text-[13px] text-muted"><Bot size={14} />The care advocate seat is on autopilot. It will decide in a moment.</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ on the phone now

const PARTY_ICON = { supplier: Truck, office: Stethoscope, patient: UserRound };

export function OnThePhone({ calls, onOpen }: { calls: LiveCall[]; onOpen: (id: string) => void }) {
  if (!calls.length) return null;
  return (
    <div className="space-y-2">
      {calls.map((c) => {
        const Icon = PARTY_ICON[c.party_kind];
        const last = c.transcript[c.transcript.length - 1];
        return (
          <button key={c.call_id} onClick={() => onOpen(c.call_id)} className="anim-fade flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-left shadow-[var(--shadow)] transition hover:border-accent">
            <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Icon size={15} /><span className="live-dot absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px]"><span className="font-medium">{c.status === "dialing" ? "Calling" : "On the phone with"} {c.party_name}</span><span className="text-muted"> · {purposeLabel(c.purpose).toLowerCase()}</span></div>
              <div className="truncate text-[12.5px] text-muted">{last ? `${last.speaker === "engine" ? "Assistant" : c.party_name.split(" ")[0]}: “${last.text}”` : "Ringing…"}</div>
            </div>
            <span className="shrink-0 text-[12.5px] text-accent">Listen in</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ activity

const KIND_ICON = { call: Phone, fax: FileText, timer: Clock3, rule: Check, system: Clock3, escalation: AlertCircle, human: HeartHandshake };

function ActivityRow({ ev, esc, onOpenCall, onOpenFax, fresh }: { ev: TimelineEvent; esc?: Escalation; onOpenCall: (id: string) => void; onOpenFax: (id: string) => void; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[ev.kind] ?? Clock3;
  const person = ev.kind === "escalation" || ev.kind === "human";
  return (
    <li className={`${fresh ? "anim-fade " : ""}relative pl-9`}>
      <span className={`absolute left-0 top-2.5 grid h-6 w-6 place-items-center rounded-full ${person ? "bg-human-soft text-human" : ev.kind === "call" || ev.kind === "fax" ? "bg-accent-soft text-accent" : "bg-[var(--bg)] text-muted"}`}><Icon size={12} /></span>
      <button onClick={() => setOpen((o) => !o)} className="group flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-[var(--surface-2)]" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <div className={`text-[13.5px] ${person ? "text-human" : ""}`}>{plainTitle(ev.title)}</div>
          <div className="text-[11.5px] text-muted">{KIND_LABEL[ev.kind] ?? ev.kind} · {fmtDay(ev.at)}, {fmtTime(ev.at)}</div>
        </div>
        <ChevronDown size={15} className={`mt-1 shrink-0 text-muted opacity-0 transition group-hover:opacity-100 ${open ? "rotate-180 opacity-100" : ""}`} />
      </button>
      {open && (
        <div className="anim-fade mb-2 ml-2 mr-2 space-y-2 rounded-lg bg-[var(--bg)] px-3 py-2.5 text-[13px] leading-relaxed">
          <p className="whitespace-pre-line">{ev.detail}</p>
          {esc?.decision && <p className="text-human">Decision: <b>{esc.decision}</b>{esc.decision_note ? ` · “${esc.decision_note}”` : ""}</p>}
          <div className="flex flex-wrap gap-1.5">
            {ev.call_id && <button className="btn !py-0.5 text-[12.5px]" onClick={() => onOpenCall(ev.call_id!)}><Phone size={12} />Open the call</button>}
            {ev.fax_id && <button className="btn !py-0.5 text-[12.5px]" onClick={() => onOpenFax(ev.fax_id!)}><FileText size={12} />Open the fax</button>}
          </div>
        </div>
      )}
    </li>
  );
}

export function Activity({ snap, escalations, onOpenCall, onOpenFax }: { snap: CaseSnapshot; escalations: Record<string, Escalation>; onOpenCall: (id: string) => void; onOpenFax: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const events = useMemo(() => [...snap.events].reverse(), [snap.events]);
  const shown = all ? events : events.slice(0, 8);
  if (!events.length) return null;
  return (
    <Section title="Activity" right={<span className="text-[12px] text-muted">{events.length} updates · click one to see why</span>}>
      <div className="card px-3 py-2">
        <ol className="relative before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-line">
          {shown.map((ev, i) => <ActivityRow key={ev.id} ev={ev} esc={ev.escalation_id ? escalations[ev.escalation_id] : undefined} onOpenCall={onOpenCall} onOpenFax={onOpenFax} fresh={i === 0} />)}
        </ol>
        {events.length > 8 && (
          <button className="mt-1 w-full rounded-lg py-1.5 text-[12.5px] text-accent hover:bg-[var(--surface-2)]" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${events.length}`}</button>
        )}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ side column

export function Details({ snap }: { snap: CaseSnapshot }) {
  const p = snap.patient;
  const rows: [string, string | null | undefined, string?][] = [
    ["Address", p.address, "collected on the first call"], ["Medicare ID", p.mbi, "read from her card on the first call"],
    ["Doctor", `${p.pcp_name}, ${p.pcp_practice}`], ["Office phone", p.pcp_phone], ["Visit", fmtDate(p.visit_date)],
  ];
  return (
    <Section title="Details">
      <dl className="card space-y-2 px-4 py-3 text-[13px]">
        {rows.map(([k, v, missing]) => (
          <div key={k}><dt className="text-[11.5px] text-muted">{k}</dt><dd className={v ? "" : "italic text-muted"}>{v || `Not yet: ${missing}`}</dd></div>
        ))}
      </dl>
    </Section>
  );
}

export function CostCard({ snap }: { snap: CaseSnapshot }) {
  if (!snap.cost.length) return null;
  return (
    <Section title="What Eleanor pays">
      <dl className="card space-y-1.5 px-4 py-3 text-[13px]">
        {snap.cost.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right tabular-nums">{v.split("→").pop()?.trim()}</dd></div>)}
      </dl>
      <p className="mt-1.5 px-1 text-[11.5px] text-muted">Medicare fee schedule for her area; computed by rules, never by the model.</p>
    </Section>
  );
}

export function Suppliers({ snap }: { snap: CaseSnapshot }) {
  const tried = [...snap.suppliers].filter((s) => s.state !== "NOT_CONTACTED").sort((a, b) => (a.supplier.miles ?? 99) - (b.supplier.miles ?? 99));
  if (!tried.length) return null;
  const good = (st: string) => ["QUALIFIED", "COMMITTED", "CONFIRMED", "DELIVERED"].includes(st);
  return (
    <Section title="Suppliers contacted" right={<span className="text-[12px] text-muted">{tried.length} of {snap.suppliers.length}</span>}>
      <ul className="card divide-y divide-line px-4 py-1 text-[13px]">
        {tried.map((s) => (
          <li key={s.supplier.id} className="flex items-start gap-2 py-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${good(s.state) ? "bg-ok" : s.state.startsWith("ESC") ? "bg-human" : ["CALLING", "NO_ANSWER"].includes(s.state) ? "bg-accent/60" : "bg-line-strong"}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate">{s.supplier.name}</div>
              <div className="text-[11.5px] text-muted">
                {s.supplier.miles != null ? `${s.supplier.miles.toFixed(1)} mi · ` : ""}
                {s.state === "DELIVERED" ? "delivered" : s.state === "CONFIRMED" ? "confirmed" : s.state === "COMMITTED" ? "took the referral" : s.state === "QUALIFIED" ? "qualified · backup" :
                  s.state === "CALLING" ? "calling now" : s.state === "NO_ANSWER" ? "no answer yet" : supplierReason(s.reason) || s.state.toLowerCase().replace(/_/g, " ")}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
