import { HeartPulse, Pause, Play, RotateCcw, Volume2, VolumeX, Workflow } from "lucide-react";
import type { CaseSnapshot, Escalation } from "../../types";
import { fmtDay, fmtTime } from "../../lib/format";
import { headline } from "../../lib/plain";

export const SPEEDS = [{ label: "1×", pace: 1.6 }, { label: "2×", pace: 0.8 }, { label: "4×", pace: 0.4 }];

export function Header({ snap, sourceLabel, started, speedIdx, onSpeed, onPause, onResume, onNewRun, how, onHow, muted, onMute, showHow }: {
  snap: CaseSnapshot | null; sourceLabel: string; started: boolean; speedIdx: number; onSpeed: (i: number) => void; onPause: () => void; onResume: () => void;
  onNewRun: () => void; how: boolean; onHow: () => void; muted: boolean; onMute: () => void; showHow: boolean;
}) {
  const running = !!snap?.running;
  return (
    <header className="sticky top-0 z-20 flex h-[57px] items-center gap-4 border-b border-line bg-surface/95 px-5 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-surface"><HeartPulse size={17} /></span>
        <div className="leading-tight">
          <div className="text-[14.5px] font-semibold">Care coordination</div>
          <div className="text-[11.5px] text-muted">Durable medical equipment</div>
        </div>
      </div>
      <span className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-muted">{sourceLabel}</span>

      {started && snap && (
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right leading-tight" title="Simulated clock: two weeks of calls and faxes play out in minutes">
            <div className="text-[13px] font-medium tabular-nums">{fmtDay(snap.now)} · {fmtTime(snap.now)}</div>
            <div className="text-[11px] text-muted">simulated time</div>
          </div>
          {!snap.done && (
            <div className="flex items-center gap-1 rounded-lg border border-line p-0.5">
              <button className="btn btn-ghost !px-1.5 !py-1" onClick={running ? onPause : onResume} aria-label={running ? "Pause" : "Resume"}>{running ? <Pause size={14} /> : <Play size={14} />}</button>
              {SPEEDS.map((s, i) => (
                <button key={s.label} onClick={() => onSpeed(i)} aria-pressed={speedIdx === i}
                  className={`rounded-md px-1.5 py-0.5 text-[12px] ${speedIdx === i ? "bg-[var(--bg)] font-medium text-ink" : "text-muted hover:text-ink"}`}>{s.label}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={`flex items-center gap-1.5 ${started ? "" : "ml-auto"}`}>
        <button className="btn btn-ghost !px-1.5" onClick={onMute} aria-label={muted ? "Unmute ringer" : "Mute ringer"} title={muted ? "Ringer off" : "Ringer on"}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
        {started && <button className="btn" onClick={onNewRun}><RotateCcw size={14} />New run</button>}
        {showHow && <button className={`btn ${how ? "!border-accent !bg-accent-soft !text-accent" : ""}`} onClick={onHow} aria-pressed={how}><Workflow size={14} />How it decided</button>}
      </div>
    </header>
  );
}

const SAMPLES = [
  { name: "Robert Kim", meta: "81 · Hospital bed", status: "Delivery Thu" },
  { name: "Dolores Price", meta: "69 · Oxygen concentrator", status: "Waiting on signed order" },
  { name: "James Okafor", meta: "77 · Rolling walker", status: "Delivered" },
  { name: "Ana Ruiz", meta: "74 · CPAP", status: "Supplier confirmed" },
  { name: "Walter Briggs", meta: "83 · Commode chair", status: "Finding a supplier" },
];

export function Queue({ snap, pending }: { snap: CaseSnapshot | null; pending: Escalation[] }) {
  const h = snap ? headline(snap, pending) : null;
  const dot = h?.mood === "needs" ? "bg-human" : h?.mood === "done" ? "bg-ok" : h?.mood === "working" ? "bg-accent" : "bg-line-strong";
  return (
    <nav className="flex h-full flex-col border-r border-line bg-surface" aria-label="Cases">
      <div className="px-4 pb-2 pt-4">
        <div className="text-[13px] font-semibold">Your cases</div>
        <div className="text-[12px] text-muted">{pending.length ? <span className="text-human">{pending.length} need{pending.length === 1 ? "s" : ""} you</span> : "Nothing needs you"}</div>
      </div>
      <ul className="px-2">
        <li>
          <div className="flex items-start gap-2.5 rounded-lg bg-accent-soft/70 px-2.5 py-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot} ${h?.mood === "needs" ? "live-dot" : ""}`} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">Eleanor Martinez</div>
              <div className="text-[12px] text-muted">72 · Manual wheelchair</div>
              <div className={`mt-0.5 line-clamp-2 text-[12px] ${h?.mood === "needs" ? "text-human" : ""}`}>{h?.text ?? "Not started"}</div>
            </div>
          </div>
        </li>
        {SAMPLES.map((s) => (
          <li key={s.name} className="flex items-start gap-2.5 px-2.5 py-2 opacity-55" aria-disabled>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.status === "Delivered" ? "bg-ok" : "bg-accent/50"}`} />
            <div className="min-w-0">
              <div className="text-[13.5px]">{s.name}</div>
              <div className="text-[12px] text-muted">{s.meta}</div>
              <div className="text-[12px]">{s.status}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-auto px-4 py-3 text-[11.5px] leading-snug text-muted">Other cases are placeholders to show the queue. Only Eleanor's case runs.</p>
    </nav>
  );
}
