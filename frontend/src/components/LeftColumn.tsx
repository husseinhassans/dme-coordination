import { Maximize2, MapPin } from "lucide-react";
import type { CaseSnapshot, MachineName, SupplierStatus } from "../types";
import type { MachineView } from "../lib/machines";
import { fmtDate, tone } from "../lib/format";
import { StateMachine } from "./StateMachine";
import { Card, Chip } from "./ui";

export function CaseSummary({ snap, views, onExpand }: { snap: CaseSnapshot; views: Record<MachineName, MachineView>; onExpand: (m: MachineName) => void }) {
  const p = snap.patient;
  const started = snap.events.length > 0;
  return (
    <Card title={<span className="flex items-center gap-2">Case <Chip state={started ? snap.case_state : null} label={started ? snap.case_state : "NOT STARTED"} /></span>}
      right={<span className="font-mono text-[10.5px] text-muted">{snap.case_id}</span>}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft font-display text-[15px] font-semibold text-accent" aria-hidden>EM</div>
        <div className="min-w-0 leading-snug">
          <div className="text-[15px] font-semibold">{p.name}, {p.age}</div>
          <div className="text-[12px] text-muted">{p.plan}</div>
        </div>
      </div>
      <dl className="kv mt-2.5">
        <dt>Equipment</dt><dd>{p.equipment} <span className="font-mono text-[11.5px]">{p.hcpcs}</span></dd>
        <dt>PCP</dt><dd>{p.pcp_name} · {p.pcp_practice}</dd>
        <dt>Visit</dt><dd>{fmtDate(p.visit_date)}</dd>
        <dt>Address</dt><dd className={p.address ? "" : "italic text-muted"}>{p.address ? <><MapPin size={11} className="mr-0.5 inline text-muted" />{p.address}{p.zip ? ` ${p.zip}` : ""}</> : "unknown · intro call collects it"}</dd>
        <dt>MBI</dt><dd className={p.mbi ? "font-mono text-[11.5px]" : "italic text-muted"}>{p.mbi ?? "unknown · from her card"}</dd>
      </dl>
      <button className="group mt-2.5 block w-full rounded-md border border-line bg-[var(--surface-2)] p-1.5 text-left hover:border-accent" onClick={() => onExpand("case")} aria-label="Expand the case state machine">
        <div className="mb-0.5 flex items-center justify-between"><span className="eyebrow">case machine</span><Maximize2 size={11} className="text-muted group-hover:text-accent" /></div>
        <StateMachine machine="case" view={views.case} mini />
      </button>
      {snap.cost.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 flex items-center gap-1.5"><span className="eyebrow">her cost</span><span className="tag rules">rules</span></div>
          <table className="w-full text-[12px]">
            <tbody>
              {snap.cost.map(([k, v]) => (
                <tr key={k} className="border-t border-line first:border-t-0">
                  <td className="py-0.5 pr-2 text-muted">{k}</td>
                  <td className="py-0.5 text-right font-mono text-[11.5px] tabular-nums">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const THREADS: { key: "supplier" | "order" | "patient"; title: string }[] = [
  { key: "supplier", title: "Supplier" },
  { key: "order", title: "Order" },
  { key: "patient", title: "Patient" },
];

function leadSupplier(sups: SupplierStatus[]): SupplierStatus | undefined {
  const rank = ["DELIVERED", "CONFIRMED", "COMMITTED", "ESC_ELIGIBILITY", "ESC_AMBIGUOUS", "QUALIFIED", "CALLING"];
  for (const r of rank) { const s = sups.find((x) => x.state === r); if (s) return s; }
  return undefined;
}

export function ThreadCards({ snap, views, onExpand, activeThread }: { snap: CaseSnapshot; views: Record<MachineName, MachineView>; onExpand: (m: MachineName) => void; activeThread: string | null }) {
  const started = snap.events.length > 0;
  const lead = leadSupplier(snap.suppliers);
  const inFlight = snap.suppliers.filter((s) => !["NOT_CONTACTED", "DISQUALIFIED", "UNREACHABLE", "GHOSTED"].includes(s.state)).length;
  const info = {
    supplier: {
      state: lead?.state ?? (started ? "SEARCHING" : null),
      who: lead ? lead.supplier.name : `${inFlight} in flight of ${snap.suppliers.length}`,
    },
    order: { state: snap.order_state, who: `${snap.patient.pcp_practice} · ${snap.patient.pcp_name}` },
    patient: { state: snap.patient_state, who: snap.patient.name },
  };
  return (
    <div className="grid gap-2">
      {THREADS.map(({ key, title }) => {
        const i = info[key];
        const t = tone(i.state);
        const live = activeThread === key;
        return (
          <section key={key} className={`card relative overflow-hidden ${live ? "ring-1 ring-accent" : ""}`}>
            <span className="absolute inset-y-0 left-0 w-1" style={{ background: t ? `var(--${t === "live" ? "accent" : t})` : "var(--line-strong)" }} aria-hidden />
            <div className="flex items-start gap-2 py-2 pl-3.5 pr-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="text-[13.5px] font-semibold">{title}</h3>
                  {started && i.state ? <Chip state={i.state} /> : <span className="chip">—</span>}
                  {live && <span className="tag call">on a call</span>}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted" title={i.who}>{i.who}</div>
                <div className="mt-1 text-[12px] leading-snug"><span className="text-muted">Next: </span>{started ? snap.next_check[key] ?? "—" : "—"}</div>
              </div>
              <button className="group w-[118px] shrink-0 rounded-md border border-line bg-[var(--surface-2)] p-1 hover:border-accent" onClick={() => onExpand(key)} aria-label={`Expand the ${title.toLowerCase()} state machine`} title="Expand diagram">
                <StateMachine machine={key} view={views[key]} mini />
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function SupplierBoard({ snap, callingId }: { snap: CaseSnapshot; callingId: string | null }) {
  const rows = [...snap.suppliers].sort((a, b) => (a.supplier.miles ?? 99) - (b.supplier.miles ?? 99));
  return (
    <Card title="Supplier board" right={<span className="text-[11px] text-muted">by distance · facts only from calls</span>} bodyClass="pb-1.5">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted">
            <th className="py-1 pl-3.5 font-medium">Supplier</th><th className="py-1 text-right font-medium">mi</th><th className="py-1 pl-2 pr-3.5 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const calling = callingId === s.supplier.id;
            return (
              <tr key={s.supplier.id} className={`border-t border-line align-top ${calling ? "bg-accent-soft" : ""}`}>
                <td className="max-w-0 py-1 pl-3.5">
                  <div className="truncate font-medium" title={`${s.supplier.name} · ${s.supplier.phone} · ${s.supplier.address}`}>{s.supplier.name}</div>
                  {s.reason && <div className="truncate text-[11px] text-muted" title={s.reason}>{s.reason}</div>}
                </td>
                <td className="py-1 text-right font-mono text-[11px] tabular-nums text-muted">{s.supplier.miles != null ? s.supplier.miles.toFixed(1) : "—"}</td>
                <td className="py-1 pl-2 pr-3.5 text-right">
                  {calling ? <span className="chip" data-tone="live"><span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />CALLING</span> : <Chip state={s.state} label={s.state.replace("NOT_CONTACTED", "—")} className={s.state === "NOT_CONTACTED" ? "!border-transparent !bg-transparent text-muted" : ""} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
