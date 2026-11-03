import { ArrowDown, ArrowRight, Ear, Gavel, Lightbulb } from "lucide-react";
import type { CaseSnapshot, Fact, SeatKey, SeatMode, TimelineEvent } from "../types";
import { fmtValue, fmtWhen } from "../lib/format";
import { HARD_FAIL_NOTE } from "../lib/purposes";
import { Chip, Tag, Typing } from "./ui";

export interface HeardSource {
  label: string;
  facts: Record<string, Fact>;
  order: string[];
  expected: [string, boolean][];
  live: boolean;
  kind: "call" | "fax";
}

function factStatus(f: Fact) {
  if (!f.quote) return { tone: "warn", icon: "?", text: "no quote → unknown" };
  if (!f.verified) return { tone: "bad", icon: "✕", text: "quote not in transcript → rejected" };
  if (f.value === null || f.value === undefined) return { tone: "warn", icon: "~", text: "hedged → unknown" };
  return { tone: "ok", icon: "✓", text: "quote found" };
}

function FactRow({ f, isNew }: { f: Fact; isNew: boolean }) {
  const s = factStatus(f);
  const known = s.tone === "ok";
  return (
    <li className={`grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 border-t border-line px-3 py-1.5 first:border-t-0 ${isNew ? "anim-fact" : ""}`}>
      <div className="min-w-0">
        <span className="font-mono text-[11.5px] text-muted">{f.key}</span>
        <span className="mx-1 text-muted">=</span>
        <span className={`font-mono text-[12px] font-medium ${known ? "" : "text-warn"}`}>{known ? fmtValue(f.value) : "unknown"}</span>
        {HARD_FAIL_NOTE[f.key] && <span className="ml-1.5 text-[10.5px] text-muted">({HARD_FAIL_NOTE[f.key]})</span>}
      </div>
      <span className={`whitespace-nowrap text-[11px] font-semibold`} style={{ color: `var(--${s.tone})` }}>{s.icon} {s.text}</span>
      {f.quote && <q className={`col-span-2 text-[12.5px] italic leading-snug ${f.verified ? "text-ink" : "text-bad line-through"}`}>{f.quote}</q>}
    </li>
  );
}

export function HeardPanel({ src }: { src: HeardSource | null }) {
  const keys = src ? [...src.order, ...Object.keys(src.facts).filter((k) => !src.order.includes(k))] : [];
  const pending = src ? src.expected.filter(([k]) => !src.facts[k]) : [];
  const verified = keys.filter((k) => src && factStatus(src.facts[k]).tone === "ok").length;
  return (
    <section className="card overflow-hidden border-llm">
      <header className="flex items-center gap-2 bg-llm-soft px-3 py-2">
        <Ear size={15} className="text-llm" />
        <h3 className="text-[14px] font-semibold text-llm">What the engine heard</h3>
        <Tag kind="llm">LLM · listens</Tag>
        {src && <span className="ml-auto text-[11.5px] text-muted">{verified}/{keys.length} grounded</span>}
      </header>
      {!src ? (
        <p className="px-3 py-4 text-[12.5px] text-muted">Facts appear here as a call happens. Each one needs a verbatim quote from the other party. No quote, no fact.</p>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px] text-muted">
            <span className="truncate">{src.kind === "fax" ? "Read from fax:" : "From the call with"} <b className="text-ink">{src.label}</b></span>
            {src.live && <span className="ml-auto inline-flex items-center gap-1 text-llm">listening <Typing /></span>}
          </div>
          <ul className="max-h-[46vh] overflow-y-auto scroll-thin">
            {keys.map((k) => <FactRow key={k} f={src.facts[k]} isNew={src.live} />)}
            {pending.map(([k, req]) => (
              <li key={k} className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11.5px] text-muted first:border-t-0">
                <span className="font-mono">{k}</span>{req && <span className="text-[10px] uppercase tracking-wide">required</span>}
                <span className="ml-auto italic">{src.live ? "listening…" : "not heard"}</span>
              </li>
            ))}
            {keys.length === 0 && pending.length === 0 && <li className="px-3 py-3 text-[12.5px] text-muted">Nothing to extract on this one.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

export function RulesCard({ ev, snap, waiting, label }: { ev: TimelineEvent | null; snap: CaseSnapshot | null; waiting: boolean; label: string }) {
  const supName = (id: string) => snap?.suppliers.find((s) => s.supplier.id === id)?.supplier.name ?? id;
  return (
    <section className="card overflow-hidden" style={{ borderLeft: "4px solid var(--ink)" }}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Gavel size={15} />
        <h3 className="text-[14px] font-semibold">Rules decide</h3>
        <Tag kind="rules">Rules · code</Tag>
        <span className="ml-auto text-[11.5px] text-muted">{label}</span>
      </header>
      {waiting && (
        <div className="flex items-center gap-2 border-b border-line bg-[var(--surface-2)] px-3 py-1.5 text-[12px] text-muted">
          <Typing /> rules run when the call ends, on the facts above
        </div>
      )}
      {!ev ? (
        <p className="px-3 py-4 text-[12.5px] text-muted">Every transition and every escalation comes from a rule, with its reasoning in plain English.</p>
      ) : (
        <div key={ev.id} className="anim-fade grid gap-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5"><Tag kind={ev.kind} /><span className="font-mono text-[11px] text-muted">{fmtWhen(ev.at)}</span></div>
          <div className="text-[14px] font-semibold leading-snug">{ev.title}</div>
          <p className="whitespace-pre-line text-[12.5px] leading-relaxed">{ev.detail}</p>
          {ev.transitions.length > 0 && (
            <ul className="grid gap-1 border-t border-dashed border-line pt-2">
              {ev.transitions.map((t, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                  <span className="w-[86px] truncate font-mono text-muted" title={t.machine === "supplier" ? supName(t.entity) : t.machine}>{t.machine === "supplier" ? supName(t.entity).split(" ").slice(0, 2).join(" ") : t.machine}</span>
                  {t.frm ? <Chip state={t.frm} /> : <span className="chip">start</span>}
                  <ArrowRight size={12} className="text-accent" />
                  <Chip state={t.to} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function ThesisStrip() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-[11.5px] text-muted">
      <span className="font-medium text-llm">LLM turns words into quoted facts</span>
      <ArrowDown size={12} className="-rotate-90" />
      <span className="font-medium text-ink">rules turn facts into decisions</span>
    </div>
  );
}

const HINTS: Record<SeatKey, { title: string; tips: [string, string][] }> = {
  patient: { title: "As Eleanor", tips: [
    ["\"I can't afford another bill.\"", "cost_concern → PATIENT_COST_CONCERN, a person calls her"],
    ["\"I fell in the bathroom last week.\"", "safety_concern → non-blocking SAFETY_CONCERN"],
    ["\"Maybe, I'll think about it.\"", "a hedge stays unknown; one clarifying question, then a person"],
    ["Let it ring", "NO_ANSWER and a retry, not a guess"],
  ] },
  supplier: { title: "As a supplier", tips: [
    ["\"We delivered it, but nobody signed a ticket.\"", "D11: no proof of delivery → AMBIGUOUS_CALL_OUTCOME"],
    ["\"We don't take assignment on rentals.\"", "hard fail → DISQUALIFIED (NO_ASSIGNMENT)"],
    ["\"Probably, I'd have to check.\"", "no quote for a yes → unknown, never assumed"],
  ] },
  office: { title: "As the doctor's office", tips: [
    ["Plant K0003", "the validator catches the code/description mismatch"],
    ["Thin the note", "the pre-screen names criteria B and C with no sentence"],
    ["Drop the signature", "unsigned orders never reach a supplier"],
  ] },
  advocate: { title: "As the care advocate", tips: [
    ["Pick \"Pause 30 days\"", "a typed decision: the case pauses, nothing is guessed"],
    ["Add a note", "it lands in the timeline as the human step"],
  ] },
};

export function HintsCard({ seats, mock }: { seats: Partial<Record<SeatKey, SeatMode>>; mock: boolean }) {
  const mine = (Object.keys(HINTS) as SeatKey[]).filter((k) => seats[k] === "human" && k !== "advocate");
  const list: SeatKey[] = mine.length ? mine : ["advocate"];
  return (
    <section className="card px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Lightbulb size={14} className="text-warn" />
        <h3 className="text-[13.5px] font-semibold">Try to break it</h3>
        {!mine.length && <span className="ml-auto text-[11px] text-muted">take a seat above for more</span>}
      </div>
      <div className="grid gap-2">
        {list.map((k) => (
          <div key={k}>
            <div className="eyebrow mb-0.5">{HINTS[k].title}</div>
            <ul className="grid gap-1">
              {HINTS[k].tips.map(([say, then]) => (
                <li key={say} className="text-[12px] leading-snug"><span className="font-medium">{say}</span> <span className="text-muted">→ {then}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {mock && <p className="mt-2 border-t border-dashed border-line pt-1.5 text-[11px] text-muted">Mock mode reads your replies with keyword rules instead of a model, and replays a fixed script around them.</p>}
    </section>
  );
}
