// Plain-English view of the engine state, for the advocate view. The engine's state
// names stay in the "How it decided" drawer; everything here reads like a status note.
import type { CaseSnapshot, Escalation, SupplierStatus } from "../types";
import { factKnown } from "../types";
import { fmtDay, fmtWhen } from "./format";

export type StepState = "done" | "now" | "todo" | "flag";
export interface Track { key: "supplier" | "order" | "patient"; title: string; steps: { label: string; state: StepState }[]; status: string; flagged: boolean; next?: string }

const val = (s: SupplierStatus | undefined, k: string) => {
  const f = s?.facts[k];
  return f && factKnown(f) ? String(f.value) : null;
};

export function leadSupplier(snap: CaseSnapshot): SupplierStatus | undefined {
  const by = (...st: string[]) => snap.suppliers.find((s) => st.includes(s.state));
  return by("DELIVERED") ?? by("CONFIRMED") ?? by("COMMITTED") ?? by("ESC_ELIGIBILITY", "ESC_AMBIGUOUS");
}

function steps(labels: string[], reached: number, flagged: boolean): Track["steps"] {
  // reached = number of steps complete; the next one is "now" (or "flag" if a person is needed)
  return labels.map((label, i) => ({ label, state: i < reached ? "done" : i === reached ? (flagged ? "flag" : "now") : "todo" }));
}

const SUP_REASON: Record<string, string> = {
  NOT_ACCEPTING: "not taking new Medicare patients", NO_ASSIGNMENT: "won't accept Medicare assignment",
  NO_STOCK: "no K0001 in stock", OUT_OF_AREA: "doesn't deliver to her address", TOO_SLOW: "delivery too slow",
  GHOSTED: "missed the delivery", UNREACHABLE: "never answered",
};
export const supplierReason = (r?: string | null) => (r ? SUP_REASON[r] ?? r.toLowerCase().replace(/_/g, " ") : "");

export function supplierTrack(snap: CaseSnapshot, calling = false): Track {
  const lead = leadSupplier(snap);
  const called = snap.suppliers.filter((s) => s.state !== "NOT_CONTACTED").length;
  const qualified = snap.suppliers.filter((s) => ["QUALIFIED", "COMMITTED", "CONFIRMED", "DELIVERED"].includes(s.state)).length;
  const flagged = snap.suppliers.some((s) => s.state.startsWith("ESC_"));
  const reached = !lead ? 0 : lead.state === "COMMITTED" ? 1 : lead.state === "CONFIRMED" ? 2 : lead.state === "DELIVERED" ? 4 : 1;
  let status: string;
  if (!lead) status = called ? `Called ${called} of ${snap.suppliers.length} nearby suppliers · ${qualified} qualified so far` : calling ? "Calling the closest suppliers first" : "Starts once her address is confirmed";
  else if (lead.state === "DELIVERED") status = `${lead.supplier.name} delivered the chair`;
  else if (lead.state === "CONFIRMED") status = `${lead.supplier.name} confirmed${val(lead, "delivery_date") ? ` for ${val(lead, "delivery_date")}` : ""}`;
  else if (lead.state === "COMMITTED") status = `${lead.supplier.name} accepted the referral; waiting on the signed order`;
  else status = `${lead.supplier.name} needs a person to check something`;
  const backup = snap.suppliers.find((s) => s.state === "QUALIFIED" && s !== lead);
  return { key: "supplier", title: "Supplier", steps: steps(["Find", "Accepted", "Confirmed", "Delivered"], reached, flagged), status, flagged,
    next: backup && lead && lead.state !== "DELIVERED" ? `Backup: ${backup.supplier.name}` : snap.next_check.supplier };
}

const ORDER_REACHED: Record<string, number> = {
  VERBAL_IN_CHART: 0, REQUESTED: 0, NUDGE: 0, ACKNOWLEDGED: 0, RECEIVED: 1, CORRECTION_REQUESTED: 1,
  VALIDATED: 2, SENT_TO_SUPPLIER: 3, DOCS_OK: 4, ESC_UNSIGNED: 0, ESC_CLINICAL: 1, ESC_DOCS: 3,
};
const ORDER_STATUS: Record<string, string> = {
  VERBAL_IN_CHART: "Dr. Chen ordered it verbally; nothing signed yet",
  REQUESTED: "Order request faxed to Dr. Chen's office",
  NUDGE: "Following up with the office; no reply yet",
  ACKNOWLEDGED: "Office has the request; waiting on Dr. Chen's signature",
  RECEIVED: "Signed order received; checking it",
  CORRECTION_REQUESTED: "Order had a problem; asked the office to fix it",
  VALIDATED: "Signed order checks out against Medicare's rules",
  SENT_TO_SUPPLIER: "Order and notes sent to the supplier",
  DOCS_OK: "Supplier accepted the paperwork",
  ESC_UNSIGNED: "Office hasn't sent the signed order; needs a person",
  ESC_CLINICAL: "Order needs a clinical fix only Dr. Chen can make",
  ESC_DOCS: "Supplier says the notes aren't enough",
};
export function orderTrack(snap: CaseSnapshot): Track {
  const st = snap.order_state;
  const flagged = st.startsWith("ESC_");
  return { key: "order", title: "Doctor's order", steps: steps(["Requested", "Signed", "Checked", "With supplier"], ORDER_REACHED[st] ?? 0, flagged),
    status: ORDER_STATUS[st] ?? st, flagged, next: snap.next_check.order };
}

const PAT_REACHED: Record<string, number> = { NOT_CONTACTED: 0, NO_ANSWER: 0, INFORMED: 1, WINDOW_CONFIRMED: 2, DELIVERY_VERIFIED: 3, ESC_UNREACHABLE: 0, ESC_COST: 1, ESC_DECLINES: 1 };
const PAT_STATUS: Record<string, string> = {
  NOT_CONTACTED: "Not called yet", NO_ANSWER: "Didn't answer; will try again",
  INFORMED: "Knows the plan and her costs", WINDOW_CONFIRMED: "Approved the supplier and the delivery window",
  DELIVERY_VERIFIED: "Confirmed the chair arrived", ESC_UNREACHABLE: "Can't reach her; needs a person",
  ESC_COST: "Worried about the cost; needs a person", ESC_DECLINES: "Doesn't want to go ahead; needs a person",
};
export function patientTrack(snap: CaseSnapshot): Track {
  const st = snap.patient_state;
  const flagged = st.startsWith("ESC_");
  return { key: "patient", title: "Eleanor", steps: steps(["Informed", "Approved", "Has the chair"], PAT_REACHED[st] ?? 0, flagged),
    status: PAT_STATUS[st] ?? st, flagged, next: snap.next_check.patient };
}

export const tracks = (snap: CaseSnapshot, supplierCalling = false) => [supplierTrack(snap, supplierCalling), orderTrack(snap), patientTrack(snap)];

/** Engine event titles keep a few internal words; soften them for the activity log. */
export function plainTitle(t: string): string {
  return t
    .replace(/\(([A-Z_]{4,})\)/g, (_, r: string) => `(${supplierReason(r)})`)
    .replace(/marked GHOSTED/g, "marked a no-show")
    .replace(/ghost threshold/gi, "no-show deadline")
    .replace(/\b([A-Z]+_[A-Z_]+)\b/g, (m) => m.toLowerCase().replace(/_/g, " "));
}

export type Mood = "idle" | "working" | "needs" | "done" | "stopped";
export function headline(snap: CaseSnapshot, pending: Escalation[]): { mood: Mood; text: string; sub?: string } {
  const lead = leadSupplier(snap);
  if (snap.case_state === "CLOSED") return { mood: "done", text: `Wheelchair delivered. Case closed ${fmtDay(snap.now)}.`, sub: lead ? `${lead.supplier.name} delivered and is billing K0001 on assignment.` : undefined };
  if (snap.case_state === "ABANDONED") return { mood: "stopped", text: "Case closed without a delivery." };
  if (pending.length) return { mood: "needs", text: pending.length === 1 ? "One thing needs you." : `${pending.length} things need you.`, sub: "Everything else keeps moving while you decide." };
  if (snap.case_state === "PAUSED") return { mood: "stopped", text: "Case paused by the care advocate." };
  if (snap.case_state === "DELIVERY_SCHEDULED" && lead && snap.patient_state === "INFORMED")
    return { mood: "working", text: `Delivery missed. Chasing ${lead.supplier.name} and lining up the backup.`, sub: "Eleanor said nobody came. If the supplier doesn't answer by the next business day, the backup takes over." };
  if (snap.case_state === "DELIVERY_SCHEDULED" && lead) {
    const d = val(lead, "delivery_date");
    return { mood: "working", text: `Delivery scheduled with ${lead.supplier.name}${d ? `, ${d}` : ""}.`, sub: "Eleanor approved. The engine checks in with her after the window." };
  }
  if (snap.case_state === "HANDOFF_READY" && lead) return { mood: "working", text: `Order and supplier are ready. Getting Eleanor's OK on ${lead.supplier.name}.` };
  if (!snap.events.length) return { mood: "idle", text: "Not started." };
  const parts = [lead ? null : "finding a supplier", ["VALIDATED", "SENT_TO_SUPPLIER", "DOCS_OK"].includes(snap.order_state) ? null : "getting a signed order from Dr. Chen"].filter(Boolean);
  return { mood: "working", text: parts.length ? `Working on it: ${parts.join(" and ")}.` : "Working on it." };
}

/** Event kind → plain label for the activity log. */
export const KIND_LABEL: Record<string, string> = { call: "Call", fax: "Fax", timer: "Follow-up", rule: "Update", system: "System", escalation: "Needs a person", human: "Care advocate" };

export const when = fmtWhen;
