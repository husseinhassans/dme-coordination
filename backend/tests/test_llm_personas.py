"""Autopilot persona state machines (spec §11), with FakeLLM standing in for speech."""

from datetime import datetime

from dme.contract import CallGoal, FaxDocument, Utterance
from dme.llm.client import FakeLLM
from dme.llm.personas import (
    DOC1, DOC2, NEW_FAX, OLD_FAX, AutopilotCast, add_business_days, spoken_day,
)


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def G(purpose, kind="supplier", pid="x"):
    return CallGoal(purpose=purpose, thread="supplier", party_kind=kind, party_id=pid, party_name="?",
                    brief="", facts=[])


def cast(t):
    clock = Clock(t)
    llm = FakeLLM(text_fn=lambda system, messages: "Okay.")
    return AutopilotCast(llm=llm, now=clock), clock, llm


def test_calendar_skips_weekend_and_veterans_day():
    from datetime import date
    assert add_business_days(date(2026, 11, 6), 1) == date(2026, 11, 9)      # Fri -> Mon
    assert add_business_days(date(2026, 11, 10), 1) == date(2026, 11, 12)    # Tue -> Thu
    assert spoken_day(date(2026, 11, 9), date(2026, 11, 6)) == "Monday"


async def test_lakeshore_misses_two_then_answers():
    c, clock, _ = cast(datetime(2026, 11, 2, 9, 12))
    ls = c.suppliers["ls"]
    assert not await ls.pick_up(G("supplier_screen"))
    clock.t = datetime(2026, 11, 2, 13, 12)
    assert not await ls.pick_up(G("supplier_screen"))
    clock.t = datetime(2026, 11, 3, 10, 5)
    assert await ls.pick_up(G("supplier_screen"))


async def test_lincoln_park_ghosts_after_confirm():
    c, clock, llm = cast(datetime(2026, 11, 6, 10, 40))
    lp = c.suppliers["lp"]
    assert await lp.pick_up(G("supplier_confirm"))
    await lp.reply([Utterance(speaker="engine", text="Hi Dev")])
    assert "Monday" in llm.calls[-1]["system"]        # next business day after Fri
    clock.t = datetime(2026, 11, 9, 16, 35)
    assert not await lp.pick_up(G("supplier_delivery_check"))


async def test_prairie_state_closed_veterans_day_and_hedge_wording():
    c, clock, llm = cast(datetime(2026, 11, 10, 10, 0))
    ps = c.suppliers["ps"]
    assert await ps.pick_up(G("supplier_reconfirm"))
    await ps.reply([Utterance(speaker="engine", text="Hi Ana")])
    sys = llm.calls[-1]["system"]
    assert "closed tomorrow for Veterans Day" in sys and "Thursday morning" in sys and "send the order whenever" in sys
    clock.t = datetime(2026, 11, 11, 10, 0)
    assert not await ps.pick_up(G("supplier_reconfirm"))


async def test_persona_never_sees_goal_facts_and_hangs_up_token():
    c, _, llm = cast(datetime(2026, 11, 2, 9, 11))
    hh = c.suppliers["hh"]
    llm.text_fn = lambda s, m: "[hangs up]"
    assert await hh.pick_up(G("supplier_screen"))
    assert await hh.reply([Utterance(speaker="engine", text="Hi")]) is None
    assert "accepting_new_medicare" not in llm.calls[-1]["system"]
    assert "full up on new Medicare patients until January" in llm.calls[-1]["system"]


async def test_fax_desk_old_number_lost_then_doc1_then_doc2():
    c, clock, _ = cast(datetime(2026, 11, 2, 9, 5))
    desk, office = c.fax_desk, c.office
    await desk.receive_request(FaxDocument(id="f1", direction="outbound", to=OLD_FAX, sent_at=clock.t, text="req"))
    assert desk.lost and not desk.request_reached()
    clock.t = datetime(2026, 11, 3, 9, 2)
    assert await office.pick_up(G("office_followup", "office", "sunrise"))
    assert "I don't see anything from yesterday" in office.situation(office.goal)
    clock.t = datetime(2026, 11, 3, 9, 40)
    await desk.receive_request(FaxDocument(id="f2", direction="outbound", to=NEW_FAX, sent_at=clock.t, text="req"))
    assert "Got it, it's here now" in office.situation(office.goal)
    clock.t = datetime(2026, 11, 4, 12, 0)
    assert await desk.next_signed_order() is None
    clock.t = datetime(2026, 11, 5, 11, 40)
    assert await desk.next_signed_order() == DOC1
    assert await desk.next_signed_order() is None
    clock.t = datetime(2026, 11, 5, 11, 45)
    assert await office.pick_up(G("office_correction", "office", "sunrise"))
    clock.t = datetime(2026, 11, 6, 10, 0)
    assert await desk.next_signed_order() is None
    clock.t = datetime(2026, 11, 6, 10, 15)
    assert await desk.next_signed_order() == DOC2


async def test_eleanor_arc():
    c, clock, _ = cast(datetime(2026, 11, 6, 11, 0))
    el = c.patient
    assert await el.pick_up(G("patient_consent", "patient", "eleanor"))
    assert "That's fine" in el.situation(el.goal)
    clock.t = datetime(2026, 11, 9, 16, 30)
    await el.pick_up(G("patient_delivery_check", "patient", "eleanor"))
    assert "Nobody came" in el.situation(el.goal)
    clock.t = datetime(2026, 11, 10, 17, 10)
    await el.pick_up(G("patient_consent", "patient", "eleanor"))
    assert "fourteen hundred dollars" in el.situation(el.goal)
    el.note_advocate_call()
    clock.t = datetime(2026, 11, 12, 11, 0)
    await el.pick_up(G("patient_delivery_check", "patient", "eleanor"))
    assert "It's here" in el.situation(el.goal)


def test_clean_strips_only_own_speaker_label():
    from dme.llm.personas import _clean
    assert _clean("Ana: Yes to all of it.", ("Ana",)) == "Yes to all of it."
    assert _clean("Standard chairs: we're out.", ("Marcus",)) == "Standard chairs: we're out."
