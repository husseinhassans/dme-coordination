// Ported verbatim from docs/state-machine.html (the `M` object).
import type { CaseSnapshot, MachineName, TimelineEvent } from "../types";

type EdgeOpt = { lo?: [number, number]; b?: number; a?: "start" | "middle" | "end" };
export type NodeDef = [id: string, x: number, y: number, label: string, kind?: "ok" | "warn" | "bad" | "esc"];
export type EdgeDef = [from: string, to: string, label: string, opt: EdgeOpt];
export interface MachineDef { w: number; h: number; nodes: NodeDef[]; edges: EdgeDef[] }

export const M: Record<MachineName, MachineDef> = {
  case: { w: 980, h: 196, nodes: [
      ["OPEN", 90, 70, "Open"], ["HANDOFF_READY", 290, 70, "Handoff ready"], ["DELIVERY_SCHEDULED", 490, 70, "Delivery scheduled"],
      ["DELIVERED", 690, 70, "Delivered", "ok"], ["CLOSED", 890, 70, "Closed", "ok"],
      ["BLOCKED_ON_HUMAN", 90, 166, "Blocked on human", "esc"], ["ABANDONED", 290, 166, "Abandoned", "bad"], ["PAUSED", 490, 166, "Paused (inpatient)", "warn"]],
    edges: [
      ["OPEN", "HANDOFF_READY", "join fires", { lo: [0, 18] }], ["HANDOFF_READY", "DELIVERY_SCHEDULED", "window agreed", { lo: [0, 18] }],
      ["DELIVERY_SCHEDULED", "DELIVERED", "POD + patient", { lo: [0, 18] }], ["DELIVERED", "CLOSED", "code matches", { lo: [0, 18] }],
      ["DELIVERY_SCHEDULED", "OPEN", "supplier ghosted", { b: 62 }],
      ["OPEN", "BLOCKED_ON_HUMAN", "escalation", { b: 26, lo: [-6, 0], a: "end" }], ["BLOCKED_ON_HUMAN", "OPEN", "decision", { b: 26, lo: [6, 0], a: "start" }],
      ["BLOCKED_ON_HUMAN", "ABANDONED", "closed by human", {}],
      ["DELIVERY_SCHEDULED", "PAUSED", "admitted", { lo: [6, 0], a: "start" }], ["PAUSED", "OPEN", "discharged", { lo: [0, -6] }], ["HANDOFF_READY", "BLOCKED_ON_HUMAN", "escalation", {}], ["DELIVERY_SCHEDULED", "BLOCKED_ON_HUMAN", "", {}]] },
  supplier: { w: 960, h: 316, nodes: [
      ["NOT_CONTACTED", 80, 46, "Not contacted"], ["CALLING", 260, 46, "Calling"], ["QUALIFIED", 460, 46, "Qualified", "ok"],
      ["COMMITTED", 660, 46, "Took referral", "ok"], ["CONFIRMED", 870, 46, "Has order, date set", "ok"],
      ["NO_ANSWER", 260, 160, "No answer", "warn"], ["DISQUALIFIED", 460, 160, "Disqualified", "bad"], ["GHOSTED", 660, 160, "Ghosted", "bad"], ["DELIVERED", 870, 160, "Delivered", "ok"],
      ["UNREACHABLE", 260, 274, "Unreachable", "bad"], ["ESC_AMBIGUOUS", 460, 274, "Human: ambiguous", "esc"], ["ESC_EXHAUSTED", 660, 274, "Human: exhausted", "esc"], ["ESC_ELIGIBILITY", 870, 274, "Human: eligibility", "esc"]],
    edges: [
      ["NOT_CONTACTED", "CALLING", "dial", { lo: [0, -8] }], ["CALLING", "NO_ANSWER", "no pickup", { b: 26, lo: [-6, 0], a: "end" }], ["NO_ANSWER", "CALLING", "retry", { b: 26, lo: [6, 0], a: "start" }],
      ["NO_ANSWER", "UNREACHABLE", "3 misses", { lo: [6, 0], a: "start" }], ["CALLING", "QUALIFIED", "quoted facts pass", { lo: [0, -8] }],
      ["CALLING", "DISQUALIFIED", "hard fail", {}], ["CALLING", "ESC_AMBIGUOUS", "no quote ×2", { lo: [-30, 0] }],
      ["QUALIFIED", "COMMITTED", "takes referral", { lo: [0, -8] }], ["COMMITTED", "CONFIRMED", "order + eligibility", { lo: [0, -8] }],
      ["COMMITTED", "DISQUALIFIED", "reconfirm fails", {}], ["COMMITTED", "ESC_ELIGIBILITY", "same/similar", { lo: [4, 30] }], ["CONFIRMED", "GHOSTED", "promised +1d", {}],
      ["CONFIRMED", "DELIVERED", "POD", { lo: [6, 0], a: "start" }], ["GHOSTED", "ESC_EXHAUSTED", "none left", { lo: [6, 0], a: "start" }], ["QUALIFIED", "DISQUALIFIED", "no longer available", { lo: [6, 0], a: "start" }], ["ESC_AMBIGUOUS", "CALLING", "fact set", { b: 30 }], ["ESC_ELIGIBILITY", "COMMITTED", "proceed", { b: 30 }], ["ESC_EXHAUSTED", "GHOSTED", "widened", { b: 26, lo: [-6, 0], a: "end" }], ["UNREACHABLE", "NOT_CONTACTED", "widened", {}]] },
  order: { w: 1000, h: 316, nodes: [
      ["VERBAL_IN_CHART", 80, 46, "Verbal in chart"], ["REQUESTED", 250, 46, "Requested"], ["ACKNOWLEDGED", 420, 46, "Acknowledged"],
      ["RECEIVED", 590, 46, "Received"], ["VALIDATED", 760, 46, "Validated", "ok"],
      ["NUDGE", 250, 160, "Nudge, alt channel", "warn"], ["CORRECTION_REQUESTED", 590, 160, "Correction asked", "warn"],
      ["SENT_TO_SUPPLIER", 760, 160, "Sent to supplier"], ["DOCS_OK", 926, 160, "Docs OK", "ok"],
      ["ESC_UNSIGNED", 250, 274, "Human: unsigned", "esc"], ["ESC_CLINICAL", 590, 274, "Human: clinical fix", "esc"], ["ESC_DOCS", 760, 274, "Human: docs short", "esc"]],
    edges: [
      ["VERBAL_IN_CHART", "REQUESTED", "fax + checklist", { lo: [0, -8] }], ["REQUESTED", "ACKNOWLEDGED", "owner named", { lo: [0, -8] }],
      ["ACKNOWLEDGED", "RECEIVED", "signed", { lo: [0, -8] }], ["RECEIVED", "VALIDATED", "rules pass", { lo: [0, -8] }],
      ["REQUESTED", "NUDGE", "no ack 1d", { b: 26, lo: [-6, 0], a: "end" }], ["NUDGE", "REQUESTED", "resend", { b: 26, lo: [6, 0], a: "start" }],
      ["ACKNOWLEDGED", "NUDGE", "unsigned 3d", {}], ["NUDGE", "ESC_UNSIGNED", "3 nudges", { lo: [6, 0], a: "start" }],
      ["RECEIVED", "CORRECTION_REQUESTED", "error or gap", { b: 26, lo: [-6, 0], a: "end" }], ["CORRECTION_REQUESTED", "RECEIVED", "re-signed", { b: 26, lo: [6, 0], a: "start" }],
      ["CORRECTION_REQUESTED", "ESC_CLINICAL", "clinical change", { lo: [6, 0], a: "start" }],
      ["VALIDATED", "SENT_TO_SUPPLIER", "to committed", { lo: [6, 0], a: "start" }],
      ["SENT_TO_SUPPLIER", "DOCS_OK", "notes OK", { lo: [0, 20] }], ["DOCS_OK", "SENT_TO_SUPPLIER", "re-sent on ghost", { b: 30 }],
      ["SENT_TO_SUPPLIER", "ESC_DOCS", "still short", { lo: [6, 0], a: "start" }], ["ESC_UNSIGNED", "REQUESTED", "retry via contact", { b: -170, lo: [-4, 0], a: "end" }], ["ESC_CLINICAL", "CORRECTION_REQUESTED", "K0001 confirmed", { b: 26, lo: [-6, 0], a: "end" }], ["ESC_DOCS", "SENT_TO_SUPPLIER", "re-visit done", { b: 26, lo: [-6, 0], a: "end" }]] },
  patient: { w: 800, h: 316, nodes: [
      ["NOT_CONTACTED", 90, 46, "Not contacted"], ["INFORMED", 290, 46, "Informed"], ["WINDOW_CONFIRMED", 500, 46, "Supplier + window OK", "ok"],
      ["DELIVERY_VERIFIED", 710, 46, "Delivery verified", "ok"], ["NO_ANSWER", 90, 160, "No answer", "warn"],
      ["ESC_UNREACHABLE", 90, 274, "Human: unreachable", "esc"], ["ESC_COST", 330, 274, "Human: cost concern", "esc"], ["ESC_DECLINES", 540, 274, "Human: declines", "esc"]],
    edges: [
      ["NOT_CONTACTED", "INFORMED", "intro call", { lo: [0, 20] }], ["NOT_CONTACTED", "NO_ANSWER", "no pickup", { lo: [-6, 0], a: "end" }],
      ["NO_ANSWER", "INFORMED", "reached", {}], ["NO_ANSWER", "ESC_UNREACHABLE", "4 tries, 3d", { lo: [6, 0], a: "start" }],
      ["INFORMED", "WINDOW_CONFIRMED", "consents", { lo: [0, 20] }], ["WINDOW_CONFIRMED", "INFORMED", "missed or slipped", { b: 30 }],
      ["WINDOW_CONFIRMED", "DELIVERY_VERIFIED", "post-delivery call", { lo: [0, 20] }],
      ["INFORMED", "ESC_COST", "cost concern", { lo: [-6, 0], a: "end" }], ["ESC_COST", "INFORMED", "human: proceed", { b: 34, lo: [4, 0], a: "start" }],
      ["INFORMED", "ESC_DECLINES", "declines", {}], ["ESC_UNREACHABLE", "INFORMED", "reached", {}], ["ESC_DECLINES", "INFORMED", "proceed", { b: 30 }]] },
};

export const MACHINE_TITLE: Record<MachineName, string> = { case: "Case", supplier: "Supplier thread (per candidate)", order: "Order thread", patient: "Patient thread" };

export interface MachineView { active: Set<string>; visited: Set<string>; done: Set<string>; counts?: Record<string, number> }

const INITIAL: Record<MachineName, string> = { case: "OPEN", supplier: "NOT_CONTACTED", order: "VERBAL_IN_CHART", patient: "NOT_CONTACTED" };

/**
 * Replays TimelineEvent.transitions up to and including `uptoId` (or all events) to get
 * the current, visited and traversed-edge sets for every machine.
 */
export function deriveMachines(snap: CaseSnapshot | null, uptoId?: string | null): Record<MachineName, MachineView> {
  const events: TimelineEvent[] = snap?.events ?? [];
  let list = events;
  if (uptoId) { const i = events.findIndex((e) => e.id === uptoId); if (i >= 0) list = events.slice(0, i + 1); }
  const cur: Record<"case" | "order" | "patient", string> = { case: INITIAL.case, order: INITIAL.order, patient: INITIAL.patient };
  const sup: Record<string, string> = {};
  for (const s of snap?.suppliers ?? []) sup[s.supplier.id] = INITIAL.supplier;
  const view = (Object.keys(M) as MachineName[]).reduce((acc, k) => {
    acc[k] = { active: new Set(), visited: new Set(), done: new Set() };
    return acc;
  }, {} as Record<MachineName, MachineView>);
  const started = list.length > 0;
  if (started) for (const k of ["case", "order", "patient"] as const) view[k].visited.add(cur[k]);
  view.supplier.visited.add(INITIAL.supplier);

  for (const e of list) for (const t of e.transitions) {
    const v = view[t.machine];
    if (!v) continue;
    if (t.frm && t.frm !== t.to) v.done.add(`${t.frm}>${t.to}`);
    if (t.frm) v.visited.add(t.frm);
    v.visited.add(t.to);
    if (t.machine === "supplier") sup[t.entity] = t.to;
    else cur[t.machine] = t.to;
  }

  const live = !uptoId && snap;
  if (started || live) {
    view.case.active.add(live && started ? snap.case_state : cur.case);
    view.order.active.add(live && started ? snap.order_state : cur.order);
    view.patient.active.add(live && started ? snap.patient_state : cur.patient);
  }
  const counts: Record<string, number> = {};
  const supStates = live ? Object.fromEntries((snap?.suppliers ?? []).map((s) => [s.supplier.id, s.state])) : sup;
  for (const st of Object.values(supStates)) { counts[st] = (counts[st] ?? 0) + 1; view.supplier.active.add(st); }
  view.supplier.counts = counts;
  if (!started) { view.case.active.clear(); view.order.active.clear(); view.patient.active.clear(); }
  return view;
}
