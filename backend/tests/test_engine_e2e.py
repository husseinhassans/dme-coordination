"""End-to-end: the demo run of spec §11 with scripted parties (no LLM)."""

import asyncio
from datetime import date

from dme.engine.geo import load_directory
from dme.engine.orchestrator import INTAKE_OFFICE_FAX, Engine
from tests.fakes_engine import (
    Collector, ScriptedAdvocate, ScriptedCallRunner, ScriptedFaxDesk, ScriptedParties, eleanor,
)


async def run_demo():
    runner, desk, advocate, emit = ScriptedCallRunner(), ScriptedFaxDesk(), ScriptedAdvocate(), Collector()
    engine = Engine(patient=eleanor(), directory=load_directory(), call_runner=runner, parties=ScriptedParties(),
                    fax_desk=desk, advocate=advocate, emit=emit)
    runner.now = desk.now = engine.now
    engine.set_pace(0)
    await asyncio.wait_for(engine.run(), timeout=10)
    return engine, runner, desk, advocate, emit


def transitions(engine, machine, entity=None):
    return [(t.frm, t.to) for e in engine.events for t in e.transitions
            if t.machine == machine and (entity is None or t.entity == entity)]


async def test_demo_run_closes_on_thursday_nov_12():
    engine, runner, desk, advocate, emit = await run_demo()
    snap = engine.snapshot()

    assert snap.case_state == "CLOSED" and snap.done
    assert engine.now().date() == date(2026, 11, 12)
    assert [e.code for e in snap.escalations] == ["PATIENT_COST_CONCERN"]
    states = {s.supplier.id: s.state for s in snap.suppliers}
    assert states["lp"] == "GHOSTED" and states["ps"] == "DELIVERED"
    assert states["hh"] == states["ls"] == states["wc"] == "DISQUALIFIED"
    assert {states[s] for s in ("bm", "rs", "nc", "cl", "sl", "mm", "eh")} == {"NOT_CONTACTED"}
    reasons = {s.supplier.id: s.reason for s in snap.suppliers}
    assert (reasons["hh"], reasons["ls"], reasons["wc"]) == ("NOT_ACCEPTING", "NO_STOCK", "NO_ASSIGNMENT")
    assert snap.patient_state == "DELIVERY_VERIFIED" and snap.order_state == "DOCS_OK"

    # Every scripted call was used: no missing and no extra calls.
    assert all(not q for q in runner.script.values()), {k: len(q) for k, q in runner.script.items() if q}


async def test_demo_run_follows_the_page_story():
    engine, runner, desk, advocate, emit = await run_demo()

    # Order: lost fax → nudge → corrected fax → one correction loop → validated → re-sent on ghost.
    assert desk.requests[0].to == INTAKE_OFFICE_FAX
    assert desk.requests[1].to == "(312) 555-0197"
    order = transitions(engine, "order")
    assert order.count(("RECEIVED", "CORRECTION_REQUESTED")) == 1
    assert ("REQUESTED", "NUDGE") in order and ("NUDGE", "REQUESTED") in order
    assert order.count(("SENT_TO_SUPPLIER", "DOCS_OK")) == 2 and ("DOCS_OK", "SENT_TO_SUPPLIER") in order

    # Case: join twice, ghost drops it to OPEN, the cost concern blocks it once.
    case = transitions(engine, "case")
    assert case == [("OPEN", "HANDOFF_READY"), ("HANDOFF_READY", "DELIVERY_SCHEDULED"),
                    ("DELIVERY_SCHEDULED", "OPEN"), ("OPEN", "BLOCKED_ON_HUMAN"), ("BLOCKED_ON_HUMAN", "OPEN"),
                    ("OPEN", "HANDOFF_READY"), ("HANDOFF_READY", "DELIVERY_SCHEDULED"),
                    ("DELIVERY_SCHEDULED", "DELIVERED"), ("DELIVERED", "CLOSED")]

    # Patient: consent, missed window, cost escalation, advocate resume, delivery verified.
    assert transitions(engine, "patient") == [
        ("NOT_CONTACTED", "INFORMED"), ("INFORMED", "WINDOW_CONFIRMED"), ("WINDOW_CONFIRMED", "INFORMED"),
        ("INFORMED", "ESC_COST"), ("ESC_COST", "INFORMED"), ("INFORMED", "WINDOW_CONFIRMED"),
        ("WINDOW_CONFIRMED", "DELIVERY_VERIFIED")]
    assert transitions(engine, "supplier", "lp") == [
        ("NOT_CONTACTED", "CALLING"), ("CALLING", "QUALIFIED"), ("QUALIFIED", "COMMITTED"),
        ("COMMITTED", "CONFIRMED"), ("CONFIRMED", "GHOSTED")]
    assert transitions(engine, "supplier", "ps")[-3:] == [
        ("QUALIFIED", "COMMITTED"), ("COMMITTED", "CONFIRMED"), ("CONFIRMED", "DELIVERED")]

    # PHI (D3): scouting/hedge calls disclose nothing; PS gets the order only after her consent.
    for _, goal, _ in runner.goals:
        if goal.purpose == "supplier_screen" or (goal.purpose == "supplier_reconfirm" and goal.party_id == "ps"):
            assert goal.may_disclose == []
    order_faxes = [f for f in engine.faxes.values() if f.direction == "outbound" and "MBI 1EG4" in f.text]
    assert [f.to.split(" (")[0].startswith(n) for f, n in zip(order_faxes, ["Lincoln", "Prairie"])] == [True, True]
    decision = engine.escalations[0].resolved_at
    assert order_faxes[1].sent_at >= decision

    # The intro call says the rules-computed numbers.
    intro = next(g for _, g, _ in runner.goals if g.purpose == "patient_intro")
    assert any("$6.85" in s for s in intro.must_say) and any("$72" in s for s in intro.must_say)

    # Veterans Day: no party is called on Wed Nov 11; the advocate does work it.
    assert all(when.date() != date(2026, 11, 11) for when, _, _ in runner.goals)
    assert decision.date() == date(2026, 11, 11)

    # Ghost threshold is promised date + 1 business day, end of day.
    ghost = next(e for e in engine.events if any(t.to == "GHOSTED" for t in e.transitions))
    assert ghost.at.strftime("%Y-%m-%d %H:%M") == "2026-11-10 17:00"

    # Wire protocol: escalation + fax + call messages, call ids consistent.
    esc_msgs = [m["escalation"] for m in emit.of("escalation")]   # raised, then resolved
    assert [m["id"] for m in esc_msgs] == ["esc-001", "esc-001"]
    assert esc_msgs[0]["decision"] is None and esc_msgs[1]["decision"] == "Proceed and start a QMB application"
    started = [m["call_id"] for m in emit.of("call_started")]
    ended = [m["call_id"] for m in emit.of("call_ended")]
    assert started == ended == list(engine.calls)
    assert emit.of("snapshot")[-1]["case"]["case_state"] == "CLOSED"
    assert all(e.transitions or e.kind in ("system", "call", "rule", "fax", "human", "timer") for e in engine.events)


async def test_pause_and_step():
    runner, desk, advocate, emit = ScriptedCallRunner(), ScriptedFaxDesk(), ScriptedAdvocate(), Collector()
    engine = Engine(patient=eleanor(), directory=load_directory(), call_runner=runner, parties=ScriptedParties(),
                    fax_desk=desk, advocate=advocate, emit=emit)
    runner.now = desk.now = engine.now
    engine.set_pace(0)
    engine.pause()
    task = asyncio.create_task(engine.run())
    await asyncio.sleep(0.05)
    assert len(engine.events) == 1           # held after the first event
    engine.step()
    await asyncio.sleep(0.05)
    assert len(engine.events) == 2
    engine.resume()
    await asyncio.wait_for(task, timeout=10)
    assert engine.case_state == "CLOSED"
