"""The case file: every call reads the engine's record, filtered for who's on the line.

Also the fixes from the Nov 3 live test: a no-show supplier is told in writing not to
bill, a backup's "earliest" isn't presented as a promise, a cost worry raised on any
patient call goes to a person, and the caller never plants a cost worry itself.
"""

from dme.contract import CALL_PURPOSES, CallGoal
from dme.llm.caller import _goal_block
from tests.fakes_engine import Turn, demo_script
from tests.test_engine_scenarios import codes, run


def goals(engine, purpose=None, party=None):
    return [g for _, g, _ in engine._runner.goals
            if (purpose is None or g.purpose == purpose) and (party is None or g.party_id == party)]


async def test_every_patient_call_can_answer_the_cost():
    engine = await run(demo_script())
    patient_goals = goals(engine, party="patient")
    assert len(patient_goals) >= 4
    for g in patient_goals:
        text = " ".join(g.case_file)
        assert "$6.85" in text and "$5.14" in text and "$72" in text, g.purpose
        assert "charged by two suppliers" in text, g.purpose
        assert "1EG4-TE5-MK73" not in text, "her Medicare number is never echoed back"


async def test_scouted_suppliers_get_no_patient_details():
    engine = await run(demo_script())
    for g in goals(engine, "supplier_screen") + goals(engine, "supplier_reconfirm"):
        text = " ".join(g.case_file)
        assert "Eleanor" not in text and "Martinez" not in text and "2236" not in text, (g.purpose, text)


async def test_later_calls_remember_earlier_ones():
    engine = await run(demo_script())
    later = goals(engine, "patient_delivery_check")[0]
    assert any("Earlier" in line and "That's fine." in line for line in later.case_file)


async def test_no_show_supplier_is_told_not_to_bill():
    engine = await run(demo_script())
    assert "lp" in engine._withdrawn
    fax = next(f for f in engine.faxes.values() if f.to == "Lincoln Park DME Services")
    assert "don't submit a claim" in fax.text
    assert any(e.title == "Referral withdrawn from Lincoln Park DME Services" for e in engine.events)
    switch = goals(engine, "patient_consent")[-1]   # asking her to approve the backup
    assert any("told them in writing" in line and "owes them nothing" in line for line in switch.case_file)
    cost = next(e for e in engine.escalations if e.code == "PATIENT_COST_CONCERN")
    assert any("won't pay twice" in line for line in cost.context)


async def test_backup_earliest_day_is_not_offered_as_a_promise():
    engine = await run(demo_script())
    switch = goals(engine, "patient_consent", "patient")[-1]
    assert any(m.startswith("as early as ") for m in switch.must_say), switch.must_say


async def test_cost_worry_on_the_delivery_check_goes_to_a_person():
    script = demo_script()
    script[("patient_delivery_check", "patient")][0] = Turn(
        says=["No. Nobody came. And am I going to get charged for a chair I never got?"],
        facts={"delivered": (False, "Nobody came."),
               "cost_concern": (True, "am I going to get charged for a chair I never got?")})
    engine = await run(script, stop_when_unscripted=True)
    assert codes(engine)[0] == "PATIENT_COST_CONCERN"
    assert any(t.to == "ESC_COST" for e in engine.events for t in e.transitions)


def test_caller_sees_the_case_file_and_never_plants_a_cost_worry():
    goal = CallGoal(purpose="patient_delivery_check", thread="patient", party_kind="patient", party_id="patient",
                    party_name="Eleanor Martinez", brief="Ask whether it arrived.",
                    facts=list(CALL_PURPOSES["patient_delivery_check"]), case_file=["What she pays: about $6.85"])
    block = _goal_block(goal, {})
    assert "Case file" in block and "about $6.85" in block
    cost_line = next(line for line in block.splitlines() if "worried about the cost" in line)
    assert "never ask" in cost_line and "STILL NEEDED" not in cost_line
