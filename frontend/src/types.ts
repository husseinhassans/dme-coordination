// Mirror of backend/dme/contract.py. Datetimes arrive as ISO strings; Python tuples
// arrive as 2-element arrays. Keep in sync with the contract by hand.

export type CaseState =
  | "OPEN" | "HANDOFF_READY" | "DELIVERY_SCHEDULED" | "DELIVERED" | "CLOSED"
  | "BLOCKED_ON_HUMAN" | "PAUSED" | "ABANDONED";
export type SupplierState =
  | "NOT_CONTACTED" | "CALLING" | "NO_ANSWER" | "UNREACHABLE" | "QUALIFIED" | "DISQUALIFIED"
  | "COMMITTED" | "CONFIRMED" | "GHOSTED" | "DELIVERED"
  | "ESC_AMBIGUOUS" | "ESC_EXHAUSTED" | "ESC_ELIGIBILITY";
export type OrderState =
  | "VERBAL_IN_CHART" | "REQUESTED" | "NUDGE" | "ACKNOWLEDGED" | "RECEIVED"
  | "CORRECTION_REQUESTED" | "VALIDATED" | "SENT_TO_SUPPLIER" | "DOCS_OK"
  | "ESC_UNSIGNED" | "ESC_CLINICAL" | "ESC_DOCS";
export type PatientState =
  | "NOT_CONTACTED" | "NO_ANSWER" | "INFORMED" | "WINDOW_CONFIRMED" | "DELIVERY_VERIFIED"
  | "ESC_UNREACHABLE" | "ESC_COST" | "ESC_DECLINES";
export type ThreadName = "supplier" | "order" | "patient" | "case";
export type PartyKind = "supplier" | "office" | "patient";
/** Seats on the wire include the advocate, which is never called. */
export type SeatKey = PartyKind | "advocate";
export type SeatMode = "auto" | "human";

export type EscalationCode =
  | "SUPPLIERS_EXHAUSTED" | "ELIGIBILITY_CONFLICT" | "ORDER_UNSIGNED" | "ORDER_NEEDS_CLINICAL_FIX"
  | "DOCS_INSUFFICIENT" | "PATIENT_UNREACHABLE" | "PATIENT_COST_CONCERN" | "PATIENT_DECLINES"
  | "AMBIGUOUS_CALL_OUTCOME" | "SAFETY_CONCERN";
export type DisqualifyReason =
  | "NOT_ACCEPTING" | "NO_ASSIGNMENT" | "NO_STOCK" | "OUT_OF_AREA" | "TOO_SLOW" | "GHOSTED" | "UNREACHABLE";

export interface DirectorySupplier {
  id: string;
  name: string;
  phone: string;
  address: string;
  miles?: number | null;
}

export interface Patient {
  name: string;
  age: number;
  plan: string;
  equipment: string;
  hcpcs: string;
  pcp_name: string;
  pcp_practice: string;
  pcp_phone: string;
  visit_date: string;
  address?: string | null;
  zip?: string | null;
  mbi?: string | null;
}

export interface FactSpec {
  key: string;
  type: "bool" | "int" | "str" | "date";
  description: string;
  required: boolean;
}

export interface Fact {
  key: string;
  value: unknown;
  quote?: string | null;
  verified: boolean;
}
/** `Fact.known` is a Python property and is not serialized. */
export const factKnown = (f: Fact) => f.verified && f.value !== null && f.value !== undefined;

export interface Utterance {
  speaker: "engine" | "party";
  text: string;
  at?: string | null;
}

export interface CallGoal {
  purpose: string;
  thread: ThreadName;
  party_kind: PartyKind;
  party_id: string;
  party_name: string;
  brief: string;
  facts: FactSpec[];
  may_disclose: string[];
  must_say: string[];
  max_turns: number;
}

export type CallOutcome = "answered" | "no_answer" | "hung_up" | "voicemail";

export interface CallRecord {
  id: string;
  goal: CallGoal;
  seat: SeatMode;
  started_at: string;
  outcome: CallOutcome;
  transcript: Utterance[];
  facts: Record<string, Fact>;
  safety_flag?: Fact | null;
}

export interface FaxDocument {
  id: string;
  direction: "outbound" | "inbound";
  to: string;
  sent_at: string;
  text: string;
  facts: Record<string, Fact>;
}

export interface Escalation {
  id: string;
  code: EscalationCode;
  thread: ThreadName;
  blocking: boolean;
  raised_at: string;
  question: string;
  options: string[];
  numbers: [string, string][];
  tried: string[];
  context: string[];
  call_ids: string[];
  decision?: string | null;
  decision_note?: string | null;
  decision_fields: Record<string, string>;
  resolved_at?: string | null;
}

export type EventKind = "call" | "fax" | "timer" | "rule" | "system" | "escalation" | "human";
export type MachineName = "case" | "supplier" | "order" | "patient";

export interface Transition {
  machine: MachineName;
  entity: string;
  frm: string | null;
  to: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  thread: ThreadName;
  kind: EventKind;
  title: string;
  detail: string;
  transitions: Transition[];
  call_id?: string | null;
  fax_id?: string | null;
  escalation_id?: string | null;
}

export interface SupplierStatus {
  supplier: DirectorySupplier;
  state: SupplierState;
  reason?: string | null;
  misses: number;
  facts: Record<string, Fact>;
}

export interface CaseSnapshot {
  case_id: string;
  patient: Patient;
  now: string;
  running: boolean;
  case_state: CaseState;
  order_state: OrderState;
  patient_state: PatientState;
  suppliers: SupplierStatus[];
  next_check: Record<string, string>;
  seats: Partial<Record<SeatKey, SeatMode>>;
  events: TimelineEvent[];
  calls: Record<string, CallRecord>;
  faxes: Record<string, FaxDocument>;
  escalations: Escalation[];
  cost: [string, string][];
  done: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type ServerMsg =
  | { type: "snapshot"; case: CaseSnapshot }
  | { type: "event"; event: TimelineEvent }
  | { type: "call_started"; call_id: string; party_kind: PartyKind; party_id: string; party_name: string; seat: SeatMode; purpose: string }
  | { type: "ringing"; call_id: string; party_kind: PartyKind; party_name: string }
  | { type: "utterance"; call_id: string; speaker: "engine" | "party"; text: string }
  | { type: "your_turn"; call_id: string }
  | { type: "facts"; call_id: string; facts: Record<string, Fact> }
  | { type: "call_ended"; call_id: string; outcome: CallOutcome }
  | { type: "fax_requested"; request_id: string; prefill: string; request_text: string }
  | { type: "fax"; fax: FaxDocument }
  | { type: "escalation"; escalation: Escalation }
  | { type: "error"; message: string };

export type ControlAction = "pause" | "resume" | "step" | "speed";

export type ClientMsg =
  | { type: "start" }
  | { type: "seat"; party_kind: SeatKey; mode: SeatMode }
  | { type: "control"; action: ControlAction; value?: number }
  | { type: "pickup"; call_id: string }
  | { type: "let_ring"; call_id: string }
  | { type: "say"; call_id: string; text: string }
  | { type: "hangup"; call_id: string }
  | { type: "send_fax"; request_id: string; text: string }
  | { type: "decide"; escalation_id: string; option: string; note?: string; fields?: Record<string, string> };
