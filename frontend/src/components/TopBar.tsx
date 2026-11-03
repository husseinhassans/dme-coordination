import { useEffect, useRef, useState } from "react";
import { Bell, FastForward, Pause, Play, RotateCcw, SkipForward, Volume2, VolumeX, Workflow } from "lucide-react";
import type { CaseSnapshot } from "../types";
import type { ConnStatus } from "../lib/transport";
import { fmtDayW, fmtGap, fmtTimeW, msWall, wall, wallMs } from "../lib/format";
import { Chip } from "./ui";

export const SPEEDS: { label: string; pace: number }[] = [
  { label: "½×", pace: 3.2 },
  { label: "1×", pace: 1.6 },
  { label: "2×", pace: 0.8 },
  { label: "4×", pace: 0.4 },
  { label: "Max", pace: 0 },
];

function useAnimatedClock(iso: string | null | undefined) {
  const target = wall(iso);
  const targetMs = target ? wallMs(target) : 0;
  const [shown, setShown] = useState(targetMs);
  const [jump, setJump] = useState<{ gap: number; n: number } | null>(null);
  const prev = useRef(targetMs);
  useEffect(() => {
    const from = prev.current;
    prev.current = targetMs;
    if (!targetMs || !from || targetMs <= from) { setShown(targetMs); return; }
    const gap = targetMs - from;
    if (gap >= 30 * 60000) setJump((j) => ({ gap, n: (j?.n ?? 0) + 1 }));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(targetMs); return; }
    const dur = Math.min(900, 250 + Math.log10(gap / 60000 + 1) * 220);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(from + (targetMs - from) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetMs]);
  return { shown: shown ? msWall(Math.round(shown / 60000) * 60000) : null, jump };
}

export function TopBar(props: {
  snap: CaseSnapshot | null;
  status: ConnStatus;
  started: boolean;
  speedIdx: number;
  onSpeed: (i: number) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStep: () => void;
  muted: boolean;
  onMute: () => void;
  pendingEsc: number;
  bellHot: boolean;
  onBell: () => void;
  onMachines: () => void;
}) {
  const { snap, status, started } = props;
  const { shown, jump } = useAnimatedClock(snap?.now);
  const running = !!snap?.running;
  const done = !!snap?.done;

  return (
    <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="shrink-0"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M9 21h14M11 21v-7l5-4 5 4v7" stroke="var(--surface)" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="min-w-0 leading-tight">
          <h1 className="truncate text-[17px] font-bold">DME coordination engine</h1>
          <p className="truncate text-[11.5px] text-muted">{snap ? `${snap.patient.name}, ${snap.patient.age} · ${snap.patient.equipment} (${snap.patient.hcpcs})` : "Connecting…"}</p>
        </div>
      </div>

      {/* simulated clock */}
      <div className="relative ml-2 flex items-center gap-2 rounded-lg border border-line bg-[var(--surface-2)] px-3 py-1" aria-live="off">
        <span className="eyebrow">sim clock</span>
        <span className="font-mono text-[15px] font-medium tabular-nums">
          {shown ? <>{fmtDayW(shown)} <span className="text-muted">·</span> <span className="text-accent">{fmtTimeW(shown)}</span></> : "—"}
        </span>
        {running && <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
        {jump && (
          <span key={jump.n} className="ff-chip pointer-events-none absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 font-mono text-[10.5px] text-surface">
            <FastForward size={10} className="mr-1 inline" />+{fmtGap(jump.gap)}
          </span>
        )}
      </div>

      {/* controls */}
      <div className="flex items-center gap-1.5">
        <button className={`btn ${!started || done ? "btn-primary" : ""}`} onClick={props.onStart} title={started ? "Restart Eleanor's case from the beginning" : "Start Eleanor's case"}>
          {started ? <RotateCcw size={14} /> : <Play size={14} />}{started ? "Restart" : "Start"}
        </button>
        {running ? (
          <button className="btn" onClick={props.onPause} disabled={!started || done}><Pause size={14} />Pause</button>
        ) : (
          <button className="btn" onClick={props.onResume} disabled={!started || done}><Play size={14} />Resume</button>
        )}
        <button className="btn" onClick={props.onStep} disabled={!started || running || done} title="Advance one engine event while paused"><SkipForward size={14} />Step</button>
        <div className="seg ml-1" role="group" aria-label="Speed">
          {SPEEDS.map((s, i) => (
            <button key={s.label} aria-pressed={props.speedIdx === i} onClick={() => props.onSpeed(i)} title={s.pace ? `${s.pace}s between engine events` : "As fast as possible"}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {snap && started && <span className="hidden items-center gap-1.5 xl:flex"><span className="eyebrow">case</span><Chip state={snap.case_state} /></span>}
        <ConnBadge status={status} />
        <button className="btn btn-ghost px-1.5" onClick={props.onMachines} title="All four state machines" aria-label="Open state machines"><Workflow size={16} /></button>
        <button className="btn btn-ghost px-1.5" onClick={props.onMute} aria-pressed={props.muted} title={props.muted ? "Ring sound off" : "Ring sound on"} aria-label={props.muted ? "Unmute ring" : "Mute ring"}>
          {props.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <button className={`btn relative px-2 ${props.pendingEsc ? "border-human text-human" : "btn-ghost"}`} onClick={props.onBell} aria-label={`Escalation inbox, ${props.pendingEsc} open`}>
          <Bell size={16} className={props.bellHot ? "bell-ring" : ""} />
          <span className="hidden text-[12.5px] xl:inline">Advocate inbox</span>
          {props.pendingEsc > 0 && (
            <span className={`absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-human px-1 font-mono text-[10.5px] font-semibold text-surface ${props.bellHot ? "ring-pulse" : ""}`}>{props.pendingEsc}</span>
          )}
        </button>
      </div>
    </header>
  );
}

function ConnBadge({ status }: { status: ConnStatus }) {
  if (status === "mock") return <span className="tag mock" title="No backend: a scripted engine in the browser speaks the same protocol. Add ?mock=1 to force it.">Mock mode</span>;
  const map: Record<string, [string, string]> = { open: ["var(--ok)", "Live engine"], connecting: ["var(--warn)", "Connecting"], closed: ["var(--bad)", "Disconnected"] };
  const [c, l] = map[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <span className={`h-2 w-2 rounded-full ${status === "open" ? "live-dot" : ""}`} style={{ background: c }} />{l}
    </span>
  );
}
