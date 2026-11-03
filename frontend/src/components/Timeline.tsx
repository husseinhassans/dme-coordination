import { useEffect, useRef } from "react";
import type { TimelineEvent } from "../types";
import { fmtDay, fmtTime } from "../lib/format";

const KIND_COLOR: Record<string, string> = { call: "var(--accent)", fax: "var(--accent)", timer: "var(--warn)", rule: "var(--ink)", system: "var(--muted)", escalation: "var(--human)", human: "var(--human)" };

export function Timeline({ events, selected, onSelect, threadFilter }: { events: TimelineEvent[]; selected: string | null; onSelect: (id: string | null) => void; threadFilter?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) return;
    const el = ref.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [events.length, selected]);

  let lastDay = "";
  return (
    <footer className="border-t border-line bg-surface">
      <div className="flex items-center gap-3 px-4 pt-1.5">
        <h3 className="text-[13px] font-semibold">Timeline</h3>
        <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
          {["call", "fax", "timer", "rule", "escalation", "human"].map((k) => (
            <span key={k} className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: KIND_COLOR[k] }} />{k}</span>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted">{events.length} events{selected ? " · click again to return to live" : " · click one to inspect"}</span>
      </div>
      <div ref={ref} className="scroll-thin flex items-stretch gap-1.5 overflow-x-auto px-4 pb-2 pt-1.5" role="list">
        {events.length === 0 && <div className="py-3 text-[12.5px] text-muted">Nothing yet. Press Start.</div>}
        {events.map((e) => {
          const day = fmtDay(e.at);
          const showDay = day !== lastDay;
          lastDay = day;
          const sel = selected === e.id;
          const dim = threadFilter && e.thread !== threadFilter && e.thread !== "case";
          return (
            <div key={e.id} className="flex items-stretch gap-1.5" role="listitem">
              {showDay && (
                <div className="flex w-[52px] shrink-0 flex-col justify-center border-l-2 border-line-strong pl-1.5 font-mono text-[10.5px] leading-tight text-muted">
                  {day.split(" ").map((p) => <span key={p}>{p}</span>)}
                </div>
              )}
              <button onClick={() => onSelect(sel ? null : e.id)} aria-pressed={sel}
                className={`anim-slide group flex w-[172px] shrink-0 flex-col gap-0.5 rounded-md border px-2 py-1 text-left transition-colors ${sel ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-[var(--surface-2)]"} ${dim ? "opacity-50" : ""}`}
                style={{ borderTop: `3px solid ${KIND_COLOR[e.kind]}` }}>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[10.5px] text-muted">{fmtTime(e.at)}</span>
                  <span className="font-mono text-[9.5px] uppercase tracking-wide" style={{ color: KIND_COLOR[e.kind] }}>{e.kind}</span>
                  <span className="ml-auto font-mono text-[9.5px] text-muted">{e.thread}</span>
                </span>
                <span className="line-clamp-2 text-[12px] leading-snug">{e.title}</span>
              </button>
            </div>
          );
        })}
      </div>
    </footer>
  );
}
