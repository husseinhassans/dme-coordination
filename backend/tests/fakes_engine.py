"""Scripted stand-ins for the LLM call runner, the parties, the office fax desk and the
care advocate. They reproduce the demo run of spec §11 / docs/state-machine.html EVENTS.

Facts carry quotes, and `verified` is set by a real substring check against what the
party "said" (or the document text), simulating the grounding step of D12.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

from dme.contract import CallGoal, CallRecord, Escalation, Fact, FactSpec, FaxDocument, Patient, Utterance

# ---------------------------------------------------------------------------
# Script: (purpose, party_id) -> calls in order
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    outcome: str = "answered"
    says: list[str] = field(default_factory=list)                 # the party's lines
    facts: dict[str, tuple[object, str | None]] = field(default_factory=dict)  # key -> (value, quote)
    safety: str | None = None                                     # quote of a fall/injury mention


NO_ANSWER = Turn(outcome="no_answer")


def demo_script() -> dict[tuple[str, str], list[Turn]]:
    return {
        ("patient_intro", "patient"): [Turn(
            says=["Yes, go ahead.", "2236 North Seminary, second floor, there's an elevator. The number is 1EG4-TE5-MK73.",
                  "I had my knee done in March, so probably.", "Just the walker. I still use it.", "Mornings."],
            facts={"address": ("2236 N Seminary Ave, 2nd fl, Chicago 60614", "2236 North Seminary, second floor"),
                   "mbi": ("1EG4-TE5-MK73", "1EG4-TE5-MK73"),
                   "prior_wheelchair": (False, "Just the walker."),
                   "deductible_met": (None, "so probably"),
                   "best_time": ("mornings", "Mornings.")})],
        ("supplier_screen", "lp"): [Turn(
            says=["Yep, and yep.", "We've got standard chairs on the floor and we're right down the street. Once the "
                  "paperwork's in, we can usually deliver in three days.", "Sure, send it over. Ask for Dev."],
            facts={"accepting_new_medicare": (True, "Yep, and yep."),
                   "accepts_assignment_all_months": (True, "Yep, and yep."),
                   "k0001_in_stock": (True, "We've got standard chairs on the floor"),
                   "serves_address": (True, "we're right down the street"),
                   "delivery_eta_days": (3, "we can usually deliver in three days"),
                   "accepts_referral": (True, "Sure, send it over."),
                   "contact_name": ("Dev", "Ask for Dev.")})],
        ("supplier_screen", "hh"): [Turn(
            says=["Not right now, hon. We're full up on new Medicare patients until January."],
            facts={"accepting_new_medicare": (False, "We're full up on new Medicare patients until January.")})],
        ("supplier_screen", "ls"): [NO_ANSWER, NO_ANSWER, Turn(
            says=["Standard chairs? We're out. Next shipment's about three weeks."],
            facts={"k0001_in_stock": (False, "We're out."), "restock_days": (21, "about three weeks")})],
        ("supplier_screen", "wc"): [Turn(
            says=["We're enrolled, but we don't take assignment on rentals. She'd pay us and Medicare reimburses her."],
            facts={"accepts_assignment_all_months": (False, "we don't take assignment on rentals")})],
        ("supplier_screen", "ps"): [Turn(
            says=["Yes to all of it. We cover the whole North Side. Delivery's about four business days after we "
                  "get the order. I'm Ana."],
            facts={"accepting_new_medicare": (True, "Yes to all of it."),
                   "accepts_assignment_all_months": (True, "Yes to all of it."),
                   "k0001_in_stock": (True, "Yes to all of it."),
                   "serves_address": (True, "We cover the whole North Side."),
                   "delivery_eta_days": (4, "about four business days after we get the order"),
                   "contact_name": ("Ana", "I'm Ana.")})],
        ("office_followup", "office"): [
            Turn(says=["I don't see anything from yesterday. Which number did you use?",
                       "That's the old fax. Use 0197, and put it to Maria's attention. She does all the equipment "
                       "paperwork."],
                 facts={"request_received": (False, "I don't see anything from yesterday."),
                        "correct_fax": ("(312) 555-0197", "Use 0197"),
                        "owner_name": ("Maria", "put it to Maria's attention")}),
            Turn(says=["Got it, it's here now. Dr. Chen's in clinic tomorrow, I'll put it in front of her."],
                 facts={"request_received": (True, "Got it, it's here now."),
                        "expected_signing": ("Wed Nov 4", "Dr. Chen's in clinic tomorrow")})],
        ("office_correction", "office"): [Turn(
            says=["Our EHR defaults to K0003, I'll fix that. I'll show her the checklist. She's in tomorrow morning."],
            facts={"correction_accepted": (True, "I'll fix that.")})],
        ("supplier_confirm", "lp"): [Turn(
            says=["Got the order and the note. Eligibility's clean, no other wheelchair on file, and she's Original "
                  "Medicare. Note covers it. How's Monday, one to four?"],
            facts={"order_received": (True, "Got the order and the note."),
                   "eligibility_clean": (True, "Eligibility's clean, no other wheelchair on file"),
                   "docs_sufficient": (True, "Note covers it."),
                   "delivery_date": ("Mon Nov 9, 13:00–16:00", "Monday, one to four")})],
        ("patient_consent", "patient"): [
            Turn(says=["That's fine. Monday works. My daughter Rosa will be here."],
                 facts={"consents_to_supplier": (True, "That's fine."), "window_ok": (True, "Monday works."),
                        "caregiver_present": ("Rosa (daughter)", "My daughter Rosa will be here.")}),
            Turn(says=["Honestly, I don't know if I want to keep doing this. I just got a bill for fourteen hundred "
                       "dollars from the knee surgery. I can't take on another bill every month. Maybe I'll just "
                       "manage with the walker.", "I suppose."],
                 facts={"consents_to_supplier": (None, "I don't know if I want to keep doing this."),
                        "cost_concern": (True, "I can't take on another bill every month.")})],
        ("patient_delivery_check", "patient"): [
            Turn(says=["No. Nobody came. Rosa took the afternoon off for this."],
                 facts={"delivered": (False, "Nobody came.")}),
            Turn(says=["It's here. The driver showed Rosa how to fold it."],
                 facts={"delivered": (True, "It's here.")})],
        ("supplier_delivery_check", "lp"): [NO_ANSWER, Turn(outcome="voicemail")],
        ("supplier_reconfirm", "ps"): [Turn(
            says=["We could. We're closed tomorrow for Veterans Day, so Thursday morning is the earliest. If you need "
                  "us, send the order whenever and I'll check first thing Thursday."],
            facts={"still_available": (True, "We could."),
                   "earliest_delivery": ("Thu Nov 12, 09:00–12:00", "Thursday morning is the earliest"),
                   "accepts_referral": (True, "send the order whenever")})],
        ("supplier_confirm", "ps"): [Turn(
            says=["Got it all. Eligibility's clean, no other wheelchair on file. The note's fine. She's our first "
                  "stop, around nine-thirty."],
            facts={"order_received": (True, "Got it all."),
                   "eligibility_clean": (True, "Eligibility's clean, no other wheelchair on file."),
                   "docs_sufficient": (True, "The note's fine."),
                   "delivery_date": ("Thu Nov 12, 09:30", "She's our first stop, around nine-thirty.")})],
        ("supplier_delivery_check", "ps"): [Turn(
            says=["Delivered at nine-forty and Rosa signed the delivery ticket. We're billing K0001 with RR and KH, "
                  "first rental month, on assignment."],
            facts={"delivered": (True, "Delivered at nine-forty"),
                   "proof_of_delivery": (True, "Rosa signed the delivery ticket"),
                   "billed_hcpcs": ("K0001", "We're billing K0001"),
                   "on_assignment": (True, "on assignment")})],
    }


# ---------------------------------------------------------------------------
# Documents (state-machine.html DOC1 / DOC2)
# ---------------------------------------------------------------------------

DOC1 = ("STANDARD WRITTEN ORDER\nPatient: Eleanor Martinez   MBI: 1EG4-TE5-MK73\n"
        "Item: Standard wheelchair   HCPCS: K0003   Qty: 1\nOrdering provider: Sarah Chen, MD   NPI: 1234567893\n"
        "Date: 11/04/2026\nSignature: /s/ Sarah Chen, MD (electronically signed)\n\n"
        "VISIT NOTE 10/30/2026 (excerpt)\n"
        "Gait: unable to walk to bathroom without stopping to rest; near-fall at home 10/2.\n"
        "Plan: standard wheelchair for daily use in apartment. Patient agrees. Daughter assists with transfers.")
# The corrected order is the real one the autopilot office sends: order + addendum only.
# Criteria A, D, E and F/G live in DOC1's note, so the engine must combine documents (D8).
from dme.llm.personas import DOC2  # noqa: E402

# A complete first-time order: correct code, and a note that covers every criterion.
FULL_ORDER = DOC1.replace("HCPCS: K0003", "HCPCS: K0001").replace("Date: 11/04/2026", "Date: 11/06/2026") + (
    "\nPatient could not safely reach the bathroom using her walker because of fatigue and poor balance. "
    "She reports the doorways in her apartment are wide enough for a wheelchair.")

_COMMON = {
    "beneficiary": ("Eleanor Martinez", "Patient: Eleanor Martinez"),
    "mbi": ("1EG4-TE5-MK73", "MBI: 1EG4-TE5-MK73"),
    "description": ("Standard wheelchair", "Item: Standard wheelchair"),
    "quantity": (1, "Qty: 1"),
    "practitioner": ("Sarah Chen, MD", "Ordering provider: Sarah Chen, MD"),
    "npi": ("1234567893", "NPI: 1234567893"),
    "signed": (True, "/s/ Sarah Chen, MD"),
    "crit_A_mradl": (True, "unable to walk to bathroom without stopping to rest"),
    "crit_D_home_use": (True, "daily use in apartment"),
    "crit_E_willing": (True, "Patient agrees."),
    "crit_FG_propel_or_caregiver": (True, "Daughter assists with transfers."),
}
DOC_FACTS = {
    "K0003": {**_COMMON, "hcpcs": ("K0003", "HCPCS: K0003"), "order_date": ("2026-11-04", "Date: 11/04/2026"),
              "crit_B_walker_not_enough": (None, None), "crit_C_home_access": (None, None)},
    "K0001": {**_COMMON, "hcpcs": ("K0001", "HCPCS: K0001"), "order_date": ("2026-11-06", "Date: 11/06/2026"),
              "crit_B_walker_not_enough": (True, "could not safely reach the bathroom using her walker"),
              "crit_C_home_access": (True, "doorways in her apartment are wide enough for a wheelchair")},
}


def grounded(key: str, value: object, quote: str | None, source: str) -> Fact:
    """A fact whose quote is verified by substring match against the source (D12)."""
    return Fact(key=key, value=value, quote=quote, verified=bool(quote) and quote in source)


# ---------------------------------------------------------------------------
# Fakes implementing the contract protocols
# ---------------------------------------------------------------------------


class ScriptedCallRunner:
    def __init__(self, script: dict[tuple[str, str], list[Turn]] | None = None) -> None:
        self.script = script if script is not None else demo_script()
        self.now: Callable[[], datetime] = lambda: datetime(2026, 11, 2, 9, 0)
        self.goals: list[tuple[datetime, CallGoal, str]] = []   # (when, goal, outcome)

    async def run(self, goal: CallGoal, party, *, call_id: str | None = None) -> CallRecord:
        key = (goal.purpose, goal.party_id)
        queue = self.script.get(key)
        if not queue:
            raise AssertionError(f"unexpected call {key} at {self.now()}")
        turn = queue.pop(0)
        said = " ".join(turn.says)
        transcript = [Utterance(speaker="engine", text=goal.brief)] + [
            Utterance(speaker="party", text=line) for line in turn.says]
        facts = {k: grounded(k, v, q, said) for k, (v, q) in turn.facts.items()}
        self.goals.append((self.now(), goal, turn.outcome))
        safety = grounded("safety_concern", True, turn.safety, said) if turn.safety else None
        return CallRecord(id=call_id or "runner-id", goal=goal, seat="auto", started_at=self.now(),
                          outcome=turn.outcome, transcript=transcript if turn.outcome == "answered" else [],
                          facts=facts, safety_flag=safety)  # type: ignore[arg-type]

    async def read_document(self, text: str, facts: list[FactSpec]) -> dict[str, Fact]:
        table = dict(DOC_FACTS["K0003" if "K0003" in text else "K0001"])
        if m := re.search(r"Item: (.+?)   HCPCS", text):   # read the item line as written
            table["description"] = (m[1], f"Item: {m[1]}")
        return {spec.key: grounded(spec.key, *table.get(spec.key, (None, None)), text) for spec in facts}


@dataclass
class SimpleParty:
    kind: str
    id: str
    name: str

    async def pick_up(self, goal: CallGoal) -> bool:
        return True

    async def reply(self, transcript: list[Utterance]) -> str | None:
        return None


class ScriptedParties:
    def get(self, kind, party_id):
        return SimpleParty(kind, party_id, party_id)

    def seat(self, kind):
        return "auto"


class ScriptedFaxDesk:
    """The old number (312) 555-0199 is a black hole. The signed order (with the K0003
    mistake) comes back Thu Nov 5 11:40; the corrected one Fri Nov 6 10:15."""
    GOOD_FAX = "(312) 555-0197"

    def __init__(self) -> None:
        self.now: Callable[[], datetime] = lambda: datetime(2026, 11, 2, 9, 0)
        self.requests: list[FaxDocument] = []
        self.sent: list[str] = []

    async def receive_request(self, request: FaxDocument) -> None:
        self.requests.append(request)

    def _got(self, prefix: str) -> bool:
        return any(r.to == self.GOOD_FAX and r.text.startswith(prefix) for r in self.requests)

    async def next_signed_order(self) -> str | None:
        now = self.now()
        if not self.sent and self._got("ORDER REQUEST") and now >= datetime(2026, 11, 5, 11, 40):
            self.sent.append(DOC1)
            return DOC1
        if len(self.sent) == 1 and self._got("CORRECTION REQUEST") and now >= datetime(2026, 11, 6, 10, 15):
            self.sent.append(DOC2)
            return DOC2
        return None


class ScriptedAdvocate:
    def __init__(self, decisions: dict[str, tuple[str, str | None, dict[str, str]]] | None = None) -> None:
        self.seen: list[Escalation] = []
        self.decisions = decisions or {}

    async def decide(self, esc: Escalation) -> tuple[str, str | None, dict[str, str]]:
        self.seen.append(esc)
        if esc.code in self.decisions:
            return self.decisions[esc.code]
        if esc.code != "PATIENT_COST_CONCERN":
            raise AssertionError(f"unexpected escalation {esc.code}")
        return ("Proceed and start a QMB application",
                "Called Eleanor for 25 minutes. Walked through the $72 total. Started a QMB application.",
                {"supplier_consent": "Prairie State Medical Supply", "window": "Thu Nov 12, 09:00–12:00",
                 "qmb_application": "started, outcome pending"})


class Collector:
    """emit(): every message must be plain JSON (the server json.dumps it)."""

    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def __call__(self, msg: dict) -> None:
        json.dumps(msg)
        self.messages.append(msg)

    def of(self, kind: str) -> list[dict]:
        return [m for m in self.messages if m["type"] == kind]


def eleanor() -> Patient:
    return Patient(name="Eleanor Martinez", age=78, plan="Original Medicare (Part B)",
                   equipment="standard manual wheelchair", hcpcs="K0001", pcp_name="Dr. Sarah Chen",
                   pcp_practice="Sunrise Family Medicine", pcp_phone="(312) 555-0190", visit_date="2026-10-30")
