// React port of drawMachine() from docs/state-machine.html.
import { useId } from "react";
import type { MachineName } from "../types";
import { M, type MachineView } from "../lib/machines";

const NW = 136, NH = 32;

function clip(cx: number, cy: number, tx: number, ty: number): [number, number] {
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const t = Math.min(dx ? (NW / 2 + 3) / Math.abs(dx) : Infinity, dy ? (NH / 2 + 3) / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

export function StateMachine({ machine, view, mini = false, className = "" }: { machine: MachineName; view: MachineView; mini?: boolean; className?: string }) {
  const m = M[machine];
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const pos = Object.fromEntries(m.nodes.map((n) => [n[0], [n[1], n[2]] as const]));
  const mk = (on: boolean) => `url(#${uid}-${machine}-${on ? "o" : "b"})`;

  const edges = m.edges.map(([from, to, label, o]) => {
    const [x1, y1] = pos[from], [x2, y2] = pos[to];
    const isDone = view.done.has(`${from}>${to}`);
    let d: string, lx: number, ly: number;
    if (o.b) {
      const len = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
      const cx = (x1 + x2) / 2 + nx * o.b, cy = (y1 + y2) / 2 + ny * o.b;
      const p0 = clip(x1, y1, cx, cy), p1 = clip(x2, y2, cx, cy);
      d = `M${p0[0]},${p0[1]} Q${cx},${cy} ${p1[0]},${p1[1]}`;
      lx = 0.25 * p0[0] + 0.5 * cx + 0.25 * p1[0]; ly = 0.25 * p0[1] + 0.5 * cy + 0.25 * p1[1];
    } else {
      const p0 = clip(x1, y1, x2, y2), p1 = clip(x2, y2, x1, y1);
      d = `M${p0[0]},${p0[1]} L${p1[0]},${p1[1]}`;
      lx = (p0[0] + p1[0]) / 2; ly = (p0[1] + p1[1]) / 2;
    }
    const lo = o.lo ?? [0, 0];
    return { key: `${from}>${to}`, d, isDone, label, x: lx + lo[0], y: ly + lo[1] + 3.5, a: o.a ?? "middle" };
  });

  return (
    <svg className={`sm ${mini ? "sm-mini" : ""} ${className}`} viewBox={`0 0 ${m.w} ${m.h}`} role="img" aria-label={`${machine} state machine; current: ${[...view.active].join(", ") || "not started"}`}>
      <defs>
        {(["b", "o"] as const).map((id) => (
          <marker key={id} id={`${uid}-${machine}-${id}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={id === "o" ? "mk-on" : "mk-base"} />
          </marker>
        ))}
      </defs>
      {edges.map((e) => (
        <g key={e.key} className={`e${e.isDone ? " done" : ""}`}>
          <path d={e.d} markerEnd={mk(e.isDone)} />
        </g>
      ))}
      {!mini && edges.map((e) => (
        <g key={`l-${e.key}`} className={`e${e.isDone ? " done" : ""}`}>
          <text x={e.x} y={e.y} textAnchor={e.a}>{e.label}</text>
        </g>
      ))}
      {m.nodes.map(([id, x, y, label, kind]) => {
        const state = view.active.has(id) ? "on" : view.visited.has(id) ? "visited" : "";
        const count = view.counts?.[id];
        return (
          <g key={id} className={`n ${kind ?? ""} ${state}`}>
            <title>{`${id}${count ? ` · ${count}` : ""}`}</title>
            <rect x={x - NW / 2} y={y - NH / 2} width={NW} height={NH} rx={6} />
            {state === "on" && <rect className="halo" x={x - NW / 2 - 4} y={y - NH / 2 - 4} width={NW + 8} height={NH + 8} rx={9} />}
            <text x={x} y={y + 4} textAnchor="middle">{label}</text>
            {!!count && (
              <g className="badge">
                <circle cx={x + NW / 2 - 2} cy={y - NH / 2 + 1} r={mini ? 13 : 9} />
                <text x={x + NW / 2 - 2} y={y - NH / 2 + (mini ? 6.5 : 4.5)} textAnchor="middle">{count}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
