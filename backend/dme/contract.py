"""Shared contract between the engine, the LLM layer, the server and the UI.

Every other module imports its types from here. Change this file only with care:
three components are built against it in parallel. The spec it implements is
docs/state-machine.md (v2).

Core idea: the engine never knows whether the other side of a call is an LLM
persona ("autopilot") or a person typing in the browser ("human seat"). Both
implement `Party`. The engine only ever sees transcripts and quote-verified facts.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# States (names match docs/state-machine.md and the page's diagrams exactly)
# ---------------------------------------------------------------------------

CaseState = Literal[
    "OPEN", "HANDOFF_READY", "DELIVERY_SCHEDULED", "DELIVERED", "CLOSED",
    "BLOCKED_ON_HUMAN", "PAUSED", "ABANDONED",
]
SupplierState = Literal[
    "NOT_CONTACTED", "CALLING", "NO_ANSWER", "UNREACHABLE", "QUALIFIED", "DISQUALIFIED",
    "COMMITTED", "CONFIRMED", "GHOSTED", "DELIVERED",
    "ESC_AMBIGUOUS", "ESC_EXHAUSTED", "ESC_ELIGIBILITY",
]
OrderState = Literal[
    "VERBAL_IN_CHART", "REQUESTED", "NUDGE", "ACKNOWLEDGED", "RECEIVED",
    "CORRECTION_REQUESTED", "VALIDATED", "SENT_TO_SUPPLIER", "DOCS_OK",
    "ESC_UNSIGNED", "ESC_CLINICAL", "ESC_DOCS",
]
PatientState = Literal[
    "NOT_CONTACTED", "NO_ANSWER", "INFORMED", "WINDOW_CONFIRMED", "DELIVERY_VERIFIED",
    "ESC_UNREACHABLE", "ESC_COST", "ESC_DECLINES",
]
ThreadName = Literal["supplier", "order", "patient", "case"]
PartyKind = Literal["supplier", "office", "patient"]
SeatMode = Literal["auto", "human"]

EscalationCode = Literal[
    "SUPPLIERS_EXHAUSTED", "ELIGIBILITY_CONFLICT", "ORDER_UNSIGNED", "ORDER_NEEDS_CLINICAL_FIX",
    "DOCS_INSUFFICIENT", "PATIENT_UNREACHABLE", "PATIENT_COST_CONCERN", "PATIENT_DECLINES",
    "AMBIGUOUS_CALL_OUTCOME", "SAFETY_CONCERN",
]
DisqualifyReason = Literal[
    "NOT_ACCEPTING", "NO_ASSIGNMENT", "NO_STOCK", "OUT_OF_AREA", "TOO_SLOW", "GHOSTED", "UNREACHABLE",
]

# ---------------------------------------------------------------------------
# Static data
# ---------------------------------------------------------------------------


class DirectorySupplier(BaseModel):
    """One row of the Medicare supplier directory. Exactly three source columns, plus
    `id` and `miles` (straight-line distance from the patient, computed by the engine)."""
    id: str
    name: str
    phone: str
    address: str
    miles: float | None = None


class Patient(BaseModel):
    name: str
    age: int
    plan: str
    equipment: str
    hcpcs: str
    pcp_name: str
    pcp_practice: str
    pcp_phone: str
    visit_date: str            # ISO date of the PCP visit
    address: str | None = None  # unknown at intake; collected on the intro call
    zip: str | None = None
    mbi: str | None = None


# ---------------------------------------------------------------------------
# Facts: the only thing the LLM layer hands the engine
# ---------------------------------------------------------------------------


class FactSpec(BaseModel):
    """A fact the engine needs from a call or document."""
    key: str
    type: Literal["bool", "int", "str", "date"]
    description: str   # what it means, written for the extraction model
    required: bool = True
    ask: bool = True   # False: listen for it, never ask (e.g. a cost worry the caller mustn't plant)


class Fact(BaseModel):
    key: str
    value: Any = None          # None when unknown
    quote: str | None = None   # verbatim from the OTHER party's words / the document
    verified: bool = False     # set by code: quote found by normalized substring match

    @property
    def known(self) -> bool:
        return self.verified and self.value is not None


class Utterance(BaseModel):
    speaker: Literal["engine", "party"]
    text: str
    at: datetime | None = None


# ---------------------------------------------------------------------------
# Calls
# ---------------------------------------------------------------------------


class CallGoal(BaseModel):
    """What the engine wants from one call. The LLM layer decides how to talk."""
    purpose: str                      # e.g. "supplier_screen" (see CALL_PURPOSES)
    thread: ThreadName
    party_kind: PartyKind
    party_id: str
    party_name: str
    brief: str                        # situation for the caller model, plain English
    facts: list[FactSpec]
    may_disclose: list[str] = Field(default_factory=list)   # PHI allowed on this call (D3)
    must_say: list[str] = Field(default_factory=list)       # e.g. exact cost numbers (rules-computed)
    # The engine's record of the case, filtered for this party (D3). The caller answers
    # questions from it; it is rendered from engine state, never written by a model.
    case_file: list[str] = Field(default_factory=list)
    max_turns: int = 8


CallOutcome = Literal["answered", "no_answer", "hung_up", "voicemail"]


class CallRecord(BaseModel):
    id: str
    goal: CallGoal
    seat: SeatMode
    started_at: datetime
    outcome: CallOutcome
    transcript: list[Utterance] = Field(default_factory=list)
    facts: dict[str, Fact] = Field(default_factory=dict)
    safety_flag: Fact | None = None   # always extracted: fall/injury/distress mention


class FaxDocument(BaseModel):
    id: str
    direction: Literal["outbound", "inbound"]
    to: str
    sent_at: datetime
    text: str
    facts: dict[str, Fact] = Field(default_factory=dict)   # inbound: extracted order fields + criteria


# ---------------------------------------------------------------------------
# The other side of the line
# ---------------------------------------------------------------------------


class Party(Protocol):
    """Anything that can be called: an LLM persona or a human in the browser."""
    kind: PartyKind
    id: str
    name: str

    async def pick_up(self, goal: CallGoal) -> bool:
        """False = no answer (rings out). A human seat can also press 'let it ring'."""

    async def reply(self, transcript: list[Utterance]) -> str | None:
        """Next thing the party says, given the call so far. None = hangs up."""


class OfficeFaxDesk(Protocol):
    """Where order requests go and signed orders come back from."""

    async def receive_request(self, request: FaxDocument) -> None: ...

    async def next_signed_order(self) -> str | None:
        """Text of the next signed order + note the office sends back, or None if
        nothing is ready yet. Autopilot: scenario-driven. Human seat: the UI form."""


class CallRunner(Protocol):
    """Implemented by dme.llm. The engine calls this and gets a finished record."""

    async def run(self, goal: CallGoal, party: Party, *, call_id: str | None = None) -> CallRecord:
        """The engine generates call_id, emits call_started with it, then passes it here
        so live utterance/facts hooks and human-seat ringing share the same id."""

    async def read_document(self, text: str, facts: list[FactSpec]) -> dict[str, Fact]: ...


class PartyProvider(Protocol):
    """Implemented by the server. Returns the autopilot persona or the human seat."""

    def get(self, kind: PartyKind, party_id: str) -> Party: ...

    def seat(self, kind: PartyKind) -> SeatMode: ...


class AdvocateProvider(Protocol):
    """Implemented by the server. Human seat waits for a "decide" message; autopilot
    applies the scenario's scripted decision. Returns (option, note, fields)."""

    async def decide(self, escalation: "Escalation") -> tuple[str, str | None, dict[str, str]]: ...


Emit = Any  # async callable(msg: dict) -> None, msg shaped per the WebSocket protocol below

# Engine public API (implemented in dme.engine.orchestrator):
#
#   class Engine:
#       def __init__(self, *, patient: Patient, directory: list[DirectorySupplier],
#                    call_runner: CallRunner, parties: PartyProvider, fax_desk: OfficeFaxDesk,
#                    advocate: AdvocateProvider, emit: Emit,
#                    start: datetime = datetime(2026, 11, 2, 9, 0)): ...
#       async def run(self) -> None          # until CLOSED / ABANDONED, or cancelled
#       def snapshot(self) -> CaseSnapshot
#       def pause(self) -> None; def resume(self) -> None; def step(self) -> None
#       def set_pace(self, seconds_between_events: float) -> None   # 0 = as fast as possible
#       def now(self) -> datetime                                   # simulated clock
#
#   The engine emits "event", "snapshot", "escalation", "fax", "call_started", "call_ended".
#   The LLM call runner emits "utterance" and "facts" through hooks the server wires in.
#   Human seats (server) emit "ringing", "your_turn", "fax_requested".


# ---------------------------------------------------------------------------
# Escalations and the timeline
# ---------------------------------------------------------------------------


class Escalation(BaseModel):
    id: str
    code: EscalationCode
    thread: ThreadName
    blocking: bool
    raised_at: datetime
    question: str
    options: list[str]
    numbers: list[tuple[str, str]] = Field(default_factory=list)
    tried: list[str] = Field(default_factory=list)
    context: list[str] = Field(default_factory=list)
    call_ids: list[str] = Field(default_factory=list)
    decision: str | None = None
    decision_note: str | None = None
    decision_fields: dict[str, str] = Field(default_factory=dict)
    resolved_at: datetime | None = None


EventKind = Literal["call", "fax", "timer", "rule", "system", "escalation", "human"]


class Transition(BaseModel):
    machine: Literal["case", "supplier", "order", "patient"]
    entity: str        # "case", "order", "patient", or a supplier id
    frm: str | None
    to: str


class TimelineEvent(BaseModel):
    id: str
    at: datetime
    thread: ThreadName
    kind: EventKind
    title: str
    detail: str                      # the rule's reasoning, plain English
    transitions: list[Transition] = Field(default_factory=list)
    call_id: str | None = None
    fax_id: str | None = None
    escalation_id: str | None = None


class SupplierStatus(BaseModel):
    supplier: DirectorySupplier
    state: SupplierState = "NOT_CONTACTED"
    reason: str | None = None
    misses: int = 0
    facts: dict[str, Fact] = Field(default_factory=dict)


class CaseSnapshot(BaseModel):
    """Everything the UI needs to redraw. Sent on connect and after every event."""
    case_id: str
    patient: Patient
    now: datetime
    running: bool
    case_state: CaseState
    order_state: OrderState
    patient_state: PatientState
    suppliers: list[SupplierStatus]
    next_check: dict[str, str]                  # thread -> human-readable next action
    seats: dict[PartyKind, SeatMode]
    events: list[TimelineEvent]
    calls: dict[str, CallRecord]
    faxes: dict[str, FaxDocument]
    escalations: list[Escalation]
    cost: list[tuple[str, str]]                 # rules-computed disclosure rows
    done: bool = False


# ---------------------------------------------------------------------------
# Call purposes: the fact schemas, owned here so engine and LLM layer agree
# ---------------------------------------------------------------------------

B, I, S = "bool", "int", "str"


def _f(key: str, type_: str, desc: str, required: bool = True, ask: bool = True) -> FactSpec:
    return FactSpec(key=key, type=type_, description=desc, required=required, ask=ask)  # type: ignore[arg-type]


_COST_WORRY = ("She is worried about the cost, says she can't afford it, wants to stop over cost, or asks for "
               "someone to call her about money. A plain question about the price, answered, is not a worry")


CALL_PURPOSES: dict[str, list[FactSpec]] = {
    # Supplier scouting. Never names the patient (D3).
    "supplier_screen": [
        _f("accepting_new_medicare", B, "Supplier is currently taking new Medicare Part B patients"),
        _f("accepts_assignment_all_months", B, "Supplier accepts Medicare assignment for every rental month"),
        _f("k0001_in_stock", B, "Has a standard manual wheelchair (HCPCS K0001) in stock now"),
        _f("restock_days", I, "If out of stock, days until restock", required=False),
        _f("serves_address", B, "Delivers to the patient's area/ZIP"),
        _f("delivery_eta_days", I, "Business days from receiving the order to delivery"),
        _f("accepts_referral", B, "Agrees to take this patient's referral", required=False),
        _f("contact_name", S, "Name of the person to ask for", required=False),
    ],
    # Re-check a qualified backup / a committed supplier whose hold is aging.
    "supplier_reconfirm": [
        _f("still_available", B, "Can still take the referral now"),
        _f("earliest_delivery", S, "Earliest delivery day they state"),
        _f("accepts_referral", B, "Agrees to take the referral / says to send the order", required=False),
    ],
    # After the order + MBI are sent to the committed supplier.
    "supplier_confirm": [
        _f("order_received", B, "Supplier has the signed order and visit note"),
        _f("eligibility_clean", B, "Their eligibility check found no conflict (no same/similar wheelchair, right plan)"),
        _f("docs_sufficient", B, "Supplier says the documentation supports coverage"),
        _f("delivery_date", S, "The delivery day and window they offer or agree to. It's provisional until the "
                               "patient approves, which is expected: an offered day counts"),
    ],
    "supplier_delivery_check": [
        _f("delivered", B, "Supplier says the chair was delivered"),
        _f("proof_of_delivery", B, "A delivery ticket / proof of delivery was signed"),
        _f("billed_hcpcs", S, "HCPCS code they are billing"),
        _f("on_assignment", B, "Billing on assignment", required=False),
    ],
    "office_followup": [
        _f("request_received", B, "Office has the order request"),
        _f("owner_name", S, "Person at the office who owns the paperwork", required=False),
        _f("correct_fax", S, "A corrected fax number or channel they give", required=False),
        _f("expected_signing", S, "When they expect the doctor to sign", required=False),
    ],
    "office_correction": [
        _f("correction_accepted", B, "Office agrees to fix the clerical error / route the documentation question to the doctor"),
        _f("clinical_disagreement", B, "Office says the doctor actually intends a different chair", required=False),
    ],
    "patient_intro": [
        _f("address", S, "Patient's home street address"),
        _f("mbi", S, "Medicare Beneficiary Identifier read from her card"),
        _f("prior_wheelchair", B, "She had/has a wheelchair from a prior episode (e.g. after surgery)"),
        _f("deductible_met", B, "She states she has met this year's Part B deductible", required=False),
        _f("best_time", S, "Best time of day to reach her", required=False),
    ],
    "patient_consent": [
        _f("consents_to_supplier", B, "She agrees to the named supplier providing the chair"),
        _f("window_ok", B, "She agrees to the delivery window"),
        _f("cost_concern", B, _COST_WORRY, required=False, ask=False),
        _f("declines", B, "She declines the chair for a non-cost reason", required=False, ask=False),
        _f("caregiver_present", S, "Someone who will be there / helps her", required=False),
    ],
    "patient_delivery_check": [
        _f("delivered", B, "She says the chair arrived"),
        _f("cost_concern", B, _COST_WORRY, required=False, ask=False),
    ],
}

# Always extracted on every call in addition to the purpose facts (D-SAFETY).
SAFETY_FACT = _f("safety_concern", B, "The person mentions a fall, an injury, or acute distress", required=False, ask=False)

# Order document fields (fax → facts). Quotes come from the document text.
ORDER_DOC_FACTS: list[FactSpec] = [
    _f("beneficiary", S, "Patient name on the order"),
    _f("mbi", S, "MBI on the order", required=False),
    _f("description", S, "Item description"),
    _f("hcpcs", S, "HCPCS code on the order"),
    _f("quantity", I, "Quantity"),
    _f("practitioner", S, "Ordering practitioner name"),
    _f("npi", S, "Practitioner NPI", required=False),
    _f("order_date", "date", "Order date"),
    _f("signed", B, "The order carries the practitioner's signature"),
    # Pre-screen (D8): "mentioned" only if a sentence in the note addresses it.
    _f("crit_A_mradl", B, "Note describes a mobility limitation that impairs a daily activity at home (toileting, dressing...)"),
    _f("crit_B_walker_not_enough", B, "Note says a cane or walker can't resolve the limitation"),
    _f("crit_C_home_access", B, "Note addresses whether the home can accommodate a wheelchair"),
    _f("crit_D_home_use", B, "Note says she'll use it regularly at home"),
    _f("crit_E_willing", B, "Note says she is willing to use it"),
    _f("crit_FG_propel_or_caregiver", B, "Note says she can self-propel or has a caregiver"),
]

# ---------------------------------------------------------------------------
# WebSocket protocol (server <-> browser). JSON, discriminated by "type".
# ---------------------------------------------------------------------------
#
# server -> client
#   {"type":"snapshot", "case": CaseSnapshot}                    on connect + after every engine event
#   {"type":"event", "event": TimelineEvent}
#   {"type":"call_started", "call_id", "party_kind", "party_id", "party_name", "seat", "purpose"}
#   {"type":"ringing", "call_id", "party_kind", "party_name"}   human seat: waiting for pickup/let_ring
#   {"type":"utterance", "call_id", "speaker":"engine"|"party", "text"}
#   {"type":"your_turn", "call_id"}                              human seat: engine waits for "say"/"hangup"
#   {"type":"facts", "call_id", "facts": {key: Fact}}           after each party turn (live extraction)
#   {"type":"call_ended", "call_id", "outcome"}
#   {"type":"fax_requested", "request_id", "prefill": str, "request_text": str}   human office seat
#   {"type":"fax", "fax": FaxDocument}
#   {"type":"escalation", "escalation": Escalation}
#   {"type":"error", "message"}
#
# client -> server
#   {"type":"start"}                                   start (or restart) Eleanor's case
#   {"type":"seat", "party_kind", "mode":"auto"|"human"}
#   {"type":"control", "action":"pause"|"resume"|"step"|"speed", "value"?: number}
#   {"type":"pickup", "call_id"}  |  {"type":"let_ring", "call_id"}
#   {"type":"say", "call_id", "text"}  |  {"type":"hangup", "call_id"}
#   {"type":"send_fax", "request_id", "text"}
#   {"type":"decide", "escalation_id", "option", "note"?: str, "fields"?: {str:str}}
#
# Human advocate: escalations always wait for a "decide" message unless the
# advocate seat is "auto", in which case the scenario's scripted decision applies
# after a short delay. The advocate seat key is "advocate" in the seats map on the
# wire (it is not a PartyKind because it is never called).
