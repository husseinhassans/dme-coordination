"""Off-demo paths: every escalation can be answered and the case continues.

Each test starts from the demo script (spec §11), changes one thing so a different
escalation fires, answers it with its non-close option, and checks the case recovers.
The demo's own cost concern still happens later in most runs.
"""

import asyncio

from dme.engine.geo import load_directory
from dme.engine.orchestrator import Engine
from tests.fakes_engine import (
    FULL_ORDER,
    DOC1, DOC2, NO_ANSWER, Collector, ScriptedAdvocate, ScriptedCallRunner, ScriptedFaxDesk, ScriptedParties, Turn,
    demo_script, eleanor,
)

ALL = ["lp", "hh", "ls", "wc", "ps", "bm", "rs", "nc", "cl", "sl", "mm", "eh"]


async def run(script, decisions=None, desk=None, stop_when_unscripted=False):
    runner, desk = ScriptedCallRunner(script), desk or ScriptedFaxDesk()
    engine = Engine(patient=eleanor(), directory=load_directory(), call_runner=runner, parties=ScriptedParties(),
                    fax_desk=desk, advocate=ScriptedAdvocate(decisions), emit=Collector())
    runner.now = desk.now = engine.now
    engine.set_pace(0)
    try:
        await asyncio.wait_for(engine.run(), timeout=10)
    except AssertionError as e:   # the script ran out: fine if the test only checks the resume
        if not stop_when_unscripted or "unexpected call" not in str(e):
            raise
    return engine


def codes(engine):
    return [e.code for e in engine.escalations]


def moved(engine, machine, frm, to):
    return any(t.machine == machine and t.frm == frm and t.to == to for e in engine.events for t in e.transitions)


def refuses(*sids):
    script = demo_script()
    for sid in sids:
        script[("supplier_screen", sid)] = [Turn(says=["No, we're full."],
                                                 facts={"accepting_new_medicare": (False, "we're full")})]
    return script


# ---------------------------------------------------------------- non-blocking safety

async def test_safety_concern_never_blocks():
    script = demo_script()
    intro = script[("patient_intro", "patient")][0]
    intro.says.append("I slipped in the bathroom last week but I'm okay.")
    intro.safety = "I slipped in the bathroom last week"
    engine = await run(script, {"SAFETY_CONCERN": ("Acknowledged", None, {})})
    assert codes(engine) == ["SAFETY_CONCERN", "PATIENT_COST_CONCERN"]
    assert engine.escalations[0].blocking is False and engine.escalations[0].decision == "Acknowledged"
    assert engine.case_state == "CLOSED"
    assert sum(t.to == "BLOCKED_ON_HUMAN" for e in engine.events for t in e.transitions) == 1


# ---------------------------------------------------------------- patient thread

async def test_patient_unreachable_then_reached_resumes():
    script = demo_script()
    script[("patient_intro", "patient")] = [NO_ANSWER] * 4
    engine = await run(script, {"PATIENT_UNREACHABLE": (
        "Reached: resume", "Reached her daughter's phone.",
        {"address": "2236 N Seminary Ave, Chicago 60614", "mbi": "1EG4-TE5-MK73"})})
    assert codes(engine) == ["PATIENT_UNREACHABLE", "PATIENT_COST_CONCERN"]
    assert moved(engine, "patient", "ESC_UNREACHABLE", "INFORMED")
    assert engine.case_state == "CLOSED"


async def test_patient_declines_then_proceed_resumes():
    script = demo_script()
    script[("patient_consent", "patient")][0] = Turn(says=["I don't want strangers in the apartment."],
                                                     facts={"declines": (True, "I don't want strangers")})
    engine = await run(script, {"PATIENT_DECLINES": (
        "Proceed", "Her daughter will be there.", {"supplier_consent": "lp", "window": "Mon Nov 9, 13:00–16:00"})})
    assert codes(engine) == ["PATIENT_DECLINES", "PATIENT_COST_CONCERN"]
    assert moved(engine, "patient", "ESC_DECLINES", "INFORMED")
    assert engine.case_state == "CLOSED"


# ---------------------------------------------------------------- supplier thread

async def test_ambiguous_supplier_fact_set_by_advocate():
    script = demo_script()
    script[("supplier_screen", "hh")] = [Turn(says=["Hm, let me check."]), Turn(says=["I'd have to ask."])]
    engine = await run(script, {"AMBIGUOUS_CALL_OUTCOME": ("Set fact", None, {"accepting_new_medicare": "false"})})
    assert codes(engine) == ["AMBIGUOUS_CALL_OUTCOME", "PATIENT_COST_CONCERN"]
    assert moved(engine, "supplier", "ESC_AMBIGUOUS", "CALLING")
    hh = engine.suppliers["hh"]
    assert hh.state == "DISQUALIFIED" and hh.facts["accepting_new_medicare"].quote.startswith("set by care advocate")
    assert engine.case_state == "CLOSED"


async def test_eligibility_conflict_proceed_confirms():
    script = demo_script()
    script[("supplier_confirm", "lp")][0].says[0] = (
        "Got the order and the note. We see a wheelchair rental on file from March. Note covers it. "
        "How's Monday, one to four?")
    script[("supplier_confirm", "lp")][0].facts["eligibility_clean"] = (False, "We see a wheelchair rental on file")
    engine = await run(script, {"ELIGIBILITY_CONFLICT": ("Proceed (new rental period justified)", None, {})})
    assert codes(engine) == ["ELIGIBILITY_CONFLICT", "PATIENT_COST_CONCERN"]
    assert moved(engine, "supplier", "ESC_ELIGIBILITY", "COMMITTED")
    assert engine.case_state == "CLOSED"


async def test_suppliers_exhausted_add_supplier_continues():
    script = refuses(*ALL)
    script[("supplier_screen", "x13")] = demo_script()[("supplier_screen", "lp")]
    script[("supplier_confirm", "x13")] = [Turn(
        says=["Got it all. Eligibility's clean. Note's fine. Monday one to four."],
        facts={"order_received": (True, "Got it all."), "eligibility_clean": (True, "Eligibility's clean."),
               "docs_sufficient": (True, "Note's fine."), "delivery_date": ("Mon Nov 9, 13:00–16:00", "Monday one to four")})]
    script[("patient_delivery_check", "patient")] = [Turn(says=["It's here."], facts={"delivered": (True, "It's here.")})]
    script[("supplier_delivery_check", "x13")] = demo_script()[("supplier_delivery_check", "ps")]
    engine = await run(script, {"SUPPLIERS_EXHAUSTED": (
        "Add an out-of-directory supplier", None, {"name": "Austin Mobility", "phone": "(773) 555-0999"})})
    assert codes(engine) == ["SUPPLIERS_EXHAUSTED"]
    assert engine.suppliers["x13"].state == "DELIVERED"
    assert engine.case_state == "CLOSED"


async def test_suppliers_exhausted_widen_retries_unreachable():
    script = refuses(*ALL[:-1])
    script[("supplier_screen", "eh")] = [NO_ANSWER] * 4 + demo_script()[("supplier_screen", "lp")]
    engine = await run(script, {"SUPPLIERS_EXHAUSTED": ("Widen to 15 miles", None, {})}, stop_when_unscripted=True)
    assert codes(engine) == ["SUPPLIERS_EXHAUSTED"]
    assert moved(engine, "supplier", "UNREACHABLE", "NOT_CONTACTED")
    assert engine.suppliers["eh"].state in ("COMMITTED", "CONFIRMED")


async def test_suppliers_exhausted_pause_abandons():
    script = refuses(*ALL)
    engine = await run(script, {"SUPPLIERS_EXHAUSTED": ("Pause", None, {})})
    assert codes(engine) == ["SUPPLIERS_EXHAUSTED"] and engine.case_state == "ABANDONED"


# ---------------------------------------------------------------- order thread

class ValidAtGoodFax(ScriptedFaxDesk):
    """Returns the good order as soon as a request reaches the right fax."""
    async def next_signed_order(self):
        if not self.sent and self._got("ORDER REQUEST"):
            self.sent.append(FULL_ORDER)
            return FULL_ORDER
        return None


async def test_order_unsigned_retry_with_contact():
    script = demo_script()
    not_here = Turn(says=["I don't see anything."], facts={"request_received": (False, "I don't see anything.")})
    script[("office_followup", "office")] = [not_here] * 3 + [
        Turn(says=["Got it, it's here now."], facts={"request_received": (True, "Got it, it's here now.")})]
    engine = await run(script, {"ORDER_UNSIGNED": (
        "Retry with contact X", None, {"contact": "Maria", "fax": "(312) 555-0197"})}, desk=ValidAtGoodFax())
    assert codes(engine) == ["ORDER_UNSIGNED", "PATIENT_COST_CONCERN"]
    assert moved(engine, "order", "ESC_UNSIGNED", "REQUESTED")
    assert engine.case_state == "CLOSED"


class ClinicalThenFixed(ScriptedFaxDesk):
    async def next_signed_order(self):
        if not self.sent and self._got("ORDER REQUEST"):
            self.sent.append("lightweight")
            return DOC1.replace("Item: Standard wheelchair", "Item: Lightweight wheelchair")
        if len(self.sent) == 1 and self._got("CORRECTION REQUEST"):
            self.sent.append(DOC2)
            return DOC2
        return None


async def test_clinical_fix_doctor_confirms_k0001():
    engine = await run(demo_script(), {"ORDER_NEEDS_CLINICAL_FIX": ("Doctor confirms K0001", None, {})},
                       desk=ClinicalThenFixed())
    assert codes(engine) == ["ORDER_NEEDS_CLINICAL_FIX", "PATIENT_COST_CONCERN"]
    assert moved(engine, "order", "ESC_CLINICAL", "CORRECTION_REQUESTED")
    assert engine.case_state == "CLOSED"


async def test_unknown_option_is_treated_as_first():
    engine = await run(demo_script(), {"ORDER_NEEDS_CLINICAL_FIX": ("Pause", None, {})}, desk=ClinicalThenFixed())
    decided = next(e for e in engine.events if e.kind == "human" and e.escalation_id == engine.escalations[0].id)
    assert "treated as the first option" in decided.detail
    assert engine.case_state == "CLOSED"


class RevisitDesk(ScriptedFaxDesk):
    async def next_signed_order(self):
        doc = await super().next_signed_order()
        if doc:
            return doc
        if len(self.sent) == 2 and any("re-visit is booked" in r.text for r in self.requests):
            self.sent.append(DOC2)
            return DOC2
        return None


async def test_docs_insufficient_revisit_then_rereview():
    script = demo_script()
    script[("supplier_confirm", "lp")].insert(0, Turn(
        says=["Got the order, but the note doesn't support coverage."],
        facts={"order_received": (True, "Got the order"), "docs_sufficient": (False, "doesn't support coverage")}))
    engine = await run(script, {"DOCS_INSUFFICIENT": ("Re-visit booked", None, {})}, desk=RevisitDesk())
    assert codes(engine) == ["DOCS_INSUFFICIENT", "PATIENT_COST_CONCERN"]
    assert moved(engine, "order", "ESC_DOCS", "SENT_TO_SUPPLIER")
    assert engine.case_state == "CLOSED"


class SilentAfterCorrectionDesk(ScriptedFaxDesk):
    async def next_signed_order(self):
        if not self.sent and self._got("ORDER REQUEST"):
            self.sent.append(DOC1)
            return DOC1
        return None


async def test_office_silent_after_correction_escalates_unsigned():
    script = demo_script()
    ok = Turn(says=["I'll fix that."], facts={"correction_accepted": (True, "I'll fix that.")})
    script[("office_correction", "office")] = [ok] * 3
    script[("supplier_reconfirm", "lp")] = [Turn(says=["Still here."], facts={"still_available": (True, "Still here.")})
                                            for _ in range(5)]
    engine = await run(script, {"ORDER_UNSIGNED": ("Pause", None, {})}, desk=SilentAfterCorrectionDesk())
    assert codes(engine) == ["ORDER_UNSIGNED"]
    assert engine.order_state == "CORRECTION_REQUESTED" and engine.case_state == "ABANDONED"


# ---------------------------------------------------------------- delivered but no paperwork

async def test_supplier_silent_after_patient_confirms_is_not_ghosted():
    """Live run 2: she said the chair arrived, then the supplier missed two POD calls and
    the ghost timer fired anyway. A supplier that delivered isn't a no-show."""
    script = demo_script()
    pod = script[("supplier_delivery_check", "ps")]
    script[("supplier_delivery_check", "ps")] = [NO_ANSWER, NO_ANSWER, *pod]
    engine = await run(script)
    assert not any(t.to == "GHOSTED" and t.entity == "ps" for e in engine.events for t in e.transitions)
    assert engine.snapshot().case_state == "CLOSED"


async def test_supplier_never_sends_pod_goes_to_a_person():
    script = demo_script()
    script[("supplier_delivery_check", "ps")] = [NO_ANSWER] * 4
    decisions = {"AMBIGUOUS_CALL_OUTCOME": ("Set fact", "Got the signed ticket by fax.", {"delivered": "yes", "billed_hcpcs": "K0001"})}
    engine = await run(script, decisions=decisions, stop_when_unscripted=True)
    assert not any(t.to == "GHOSTED" and t.entity == "ps" for e in engine.events for t in e.transitions)
    assert "AMBIGUOUS_CALL_OUTCOME" in codes(engine)
    assert engine.snapshot().case_state == "CLOSED"
