"""Unit tests for the engine's pure parts: calendar, machines, geo, rules."""

from datetime import date, datetime

import pytest

from dme.contract import Fact
from dme.engine import calendar as cal
from dme.engine import machines, rules
from dme.engine.geo import load_directory, rank_by_distance


def F(key, value, verified=True):
    return Fact(key=key, value=value, quote=f"q {key}", verified=verified)


def facts(**kv):
    return {k: F(k, v) for k, v in kv.items()}


# ---------------------------------------------------------------- calendar (D14)

def test_veterans_day_2026_is_skipped():
    assert not cal.is_business_day(date(2026, 11, 11))
    tue = datetime(2026, 11, 10, 10, 0)
    assert cal.add_business_days(tue, 1) == datetime(2026, 11, 12, 10, 0)


def test_holidays_fall_on_weekdays():
    assert all(d.weekday() < 5 for d in cal.FEDERAL_HOLIDAYS)
    assert date(2026, 11, 26) in cal.FEDERAL_HOLIDAYS and date(2027, 11, 25) in cal.FEDERAL_HOLIDAYS


def test_demo_runs_eight_business_days():
    assert cal.business_days_inclusive(date(2026, 11, 2), date(2026, 11, 12)) == 8


def test_call_slot_clamps_to_calling_hours():
    assert cal.call_slot(datetime(2026, 11, 9, 20, 35)) == datetime(2026, 11, 10, 9, 0)
    assert cal.call_slot(datetime(2026, 11, 11, 10, 0)) == datetime(2026, 11, 12, 9, 0)  # holiday
    assert cal.call_slot(datetime(2026, 11, 6, 7, 0)) == datetime(2026, 11, 6, 9, 0)
    assert cal.call_slot(datetime(2026, 11, 7, 12, 0)) == datetime(2026, 11, 9, 9, 0)  # Saturday


def test_advocate_works_on_federal_holidays():
    assert cal.advocate_slot(datetime(2026, 11, 10, 17, 11)) == datetime(2026, 11, 11, 9, 0)


def test_end_of_business_day_and_window_parsing():
    assert cal.end_of_business_day(date(2026, 11, 10)) == datetime(2026, 11, 10, 17, 0)
    ref = datetime(2026, 11, 6, 10, 40)
    assert cal.parse_window("Mon Nov 9, 13:00–16:00", ref) == (datetime(2026, 11, 9, 13), datetime(2026, 11, 9, 16))
    assert cal.parse_window("Monday, one to four", ref)[0].date() == date(2026, 11, 9)
    assert cal.parse_window("Thu Nov 12, 09:30", ref) == (datetime(2026, 11, 12, 9, 30), datetime(2026, 11, 12, 11, 30))
    assert cal.parse_window("2026-11-12 1-4pm", ref) == (datetime(2026, 11, 12, 13), datetime(2026, 11, 12, 16))
    assert cal.parse_window("soon", ref) is None


def test_sim_clock_orders_by_time_then_seq_and_skips_cancelled():
    clock = cal.SimClock(datetime(2026, 11, 2, 9))
    async def noop():
        return None
    a = clock.schedule(datetime(2026, 11, 2, 10), noop, "a")
    clock.schedule(datetime(2026, 11, 2, 9, 30), noop, "b")
    clock.schedule(datetime(2026, 11, 2, 9, 30), noop, "c")
    a.cancel()
    assert [clock.pop_next().label for _ in range(2)] == ["b", "c"]
    assert clock.pop_next() is None and clock.now == datetime(2026, 11, 2, 9, 30)


# ---------------------------------------------------------------- machines

def test_legal_move():
    assert machines.move("supplier", "CONFIRMED", "GHOSTED") == "GHOSTED"


@pytest.mark.parametrize("machine,frm,to", [
    ("supplier", "NOT_CONTACTED", "QUALIFIED"),
    ("order", "REQUESTED", "RECEIVED"),
    ("case", "HANDOFF_READY", "OPEN"),
    ("patient", "ESC_DECLINES", "WINDOW_CONFIRMED"),
    ("supplier", "DISQUALIFIED", "CALLING"),
])
def test_illegal_move_raises(machine, frm, to):
    with pytest.raises(machines.IllegalTransition):
        machines.move(machine, frm, to)


def test_added_resume_edges():
    for machine, frm, to in [("case", "DELIVERY_SCHEDULED", "BLOCKED_ON_HUMAN"), ("supplier", "QUALIFIED", "DISQUALIFIED"),
                             ("supplier", "ESC_AMBIGUOUS", "CALLING"), ("order", "ESC_DOCS", "SENT_TO_SUPPLIER"),
                             ("patient", "ESC_UNREACHABLE", "INFORMED")]:
        assert machines.can_move(machine, frm, to)


# ---------------------------------------------------------------- geo

def test_directory_ranking_matches_the_page():
    ranked = rank_by_distance(load_directory())
    assert [s.id for s in ranked] == ["lp", "hh", "ls", "wc", "ps", "bm", "rs", "nc", "cl", "sl", "mm", "eh"]
    miles = {s.id: s.miles for s in ranked}
    assert miles["lp"] == 0.3 and miles["hh"] == 0.9 and miles["ls"] == 1.3
    assert miles["wc"] == 2.1 and miles["ps"] == 2.1
    assert miles["mm"] == 9.4 and miles["eh"] == 10.0


# ---------------------------------------------------------------- qualify_supplier (§5, D9)

GOOD = dict(accepting_new_medicare=True, accepts_assignment_all_months=True, k0001_in_stock=True,
            serves_address=True, delivery_eta_days=3)


def test_all_pass_qualifies():
    assert rules.qualify_supplier(facts(**GOOD)).verdict == "QUALIFIED"


@pytest.mark.parametrize("override,reason", [
    ({"accepting_new_medicare": False}, "NOT_ACCEPTING"),
    ({"accepts_assignment_all_months": False}, "NO_ASSIGNMENT"),
    ({"k0001_in_stock": False, "restock_days": 21}, "NO_STOCK"),
    ({"serves_address": False}, "OUT_OF_AREA"),
    ({"delivery_eta_days": 11}, "TOO_SLOW"),
])
def test_each_disqualify_reason(override, reason):
    q = rules.qualify_supplier(facts(**{**GOOD, **override}))
    assert (q.verdict, q.reason) == ("DISQUALIFIED", reason)


def test_one_quoted_hard_fail_is_enough():
    q = rules.qualify_supplier(facts(accepting_new_medicare=False))
    assert (q.verdict, q.reason) == ("DISQUALIFIED", "NOT_ACCEPTING")


def test_thresholds_are_inclusive():
    assert rules.qualify_supplier(facts(**{**GOOD, "delivery_eta_days": 10})).verdict == "QUALIFIED"
    assert rules.qualify_supplier(facts(**{**GOOD, "k0001_in_stock": False, "restock_days": 14})).verdict == "QUALIFIED"


def test_unverified_quote_counts_as_unknown():
    f = facts(**GOOD)
    f["serves_address"] = F("serves_address", True, verified=False)
    q = rules.qualify_supplier(f)
    assert q.verdict == "NEEDS_CLARIFICATION" and "serves_address" in q.missing
    # An unverified hard fail doesn't disqualify either.
    f["accepting_new_medicare"] = F("accepting_new_medicare", False, verified=False)
    assert rules.qualify_supplier(f).verdict == "NEEDS_CLARIFICATION"


def test_out_of_stock_without_restock_needs_clarification():
    q = rules.qualify_supplier(facts(**{**GOOD, "k0001_in_stock": False}))
    assert q.verdict == "NEEDS_CLARIFICATION" and "restock_days" in q.missing


# ---------------------------------------------------------------- validate_order (§6, D7, D8)

ALL_CRIT = {k: True for k in rules.CRITERIA}
GOOD_ORDER = dict(beneficiary="Eleanor Martinez", description="Standard wheelchair", hcpcs="K0001", quantity=1,
                  practitioner="Sarah Chen, MD", order_date="2026-11-06", signed=True, **ALL_CRIT)


def test_good_order_passes():
    assert rules.validate_order(facts(**GOOD_ORDER), "2026-10-30").passed


def test_k0003_with_standard_description_is_clerical():
    v = rules.validate_order(facts(**{**GOOD_ORDER, "hcpcs": "K0003"}), "2026-10-30")
    assert not v.passed and not v.clinical and any("K0003" in c for c in v.clerical)


def test_code_naming_other_chair_is_clinical():
    v = rules.validate_order(facts(**{**GOOD_ORDER, "hcpcs": "K0003", "description": "Lightweight wheelchair"}),
                             "2026-10-30")
    assert v.clinical


def test_missing_elements_quantity_and_date_sanity():
    f = facts(**{**GOOD_ORDER, "quantity": 2, "order_date": "10/01/2026"})
    del f["signed"]
    v = rules.validate_order(f, "2026-10-30")
    text = " ".join(v.clerical)
    assert "Quantity is 2" in text and "signature" in text and "sanity check" in text


def test_mbi_or_npi_satisfy_name_elements():
    f = facts(**{**GOOD_ORDER, "mbi": "1EG4-TE5-MK73", "npi": "1234567893"})
    del f["beneficiary"], f["practitioner"]
    assert rules.validate_order(f, "2026-10-30").passed


def test_crit_not_known_true_is_a_gap():
    f = facts(**GOOD_ORDER)
    f["crit_B_walker_not_enough"] = F("crit_B_walker_not_enough", None, verified=False)
    f["crit_C_home_access"] = F("crit_C_home_access", True, verified=False)
    v = rules.validate_order(f, "2026-10-30")
    assert len(v.gaps) == 2 and v.gaps[0].startswith("B") and v.gaps[1].startswith("C")


# ---------------------------------------------------------------- cost (§2)

def test_cost_numbers():
    c = rules.cost_numbers()
    assert (str(c.share_early), str(c.fee_later), str(c.share_later)) == ("6.85", "25.70", "5.14")
    assert c.total_rounded == 72
    rows = dict(rules.cost_rows())
    assert rows["Her share, months 1–3"] == "$6.85 / mo"
    assert rows["Her share, months 4–13"] == "$5.14 / mo"
    assert rows["Her total over 13 months"] == "≈ $72"
    said = " ".join(rules.cost_must_say())
    assert "$6.85" in said and "$5.14" in said and "$72" in said and "$283" in said and "January" in said


# ---------------------------------------------------------------- escalation packets (§8)

def test_every_code_has_a_packet():
    codes = ["SUPPLIERS_EXHAUSTED", "ELIGIBILITY_CONFLICT", "ORDER_UNSIGNED", "ORDER_NEEDS_CLINICAL_FIX",
             "DOCS_INSUFFICIENT", "PATIENT_UNREACHABLE", "PATIENT_COST_CONCERN", "PATIENT_DECLINES",
             "AMBIGUOUS_CALL_OUTCOME", "SAFETY_CONCERN"]
    for code in codes:
        p = rules.escalation_packet(code)
        assert p.question and p.options
    assert rules.escalation_packet("SAFETY_CONCERN").blocking is False
    assert rules.escalation_packet("PATIENT_COST_CONCERN").options[1] == "Proceed and start a QMB application"


# ---------------------------------------------------------------- decision options (§8)

def test_every_option_maps_to_an_action():
    for code, options in rules.DECISIONS.items():
        assert rules.escalation_packet(code).options == [o.label for o in options]
        for o in options:
            assert rules.match_decision(code, o.label) == (o, False)


def test_decision_matching_prefers_specific_options():
    m = rules.match_decision
    assert m("PATIENT_COST_CONCERN", "Proceed + QMB")[0].action == "proceed_qmb"
    assert m("PATIENT_COST_CONCERN", "proceed")[0].action == "proceed"
    assert m("SUPPLIERS_EXHAUSTED", "Widen to 15 miles")[0].action == "widen"
    assert m("ORDER_UNSIGNED", "retry with contact Maria")[0].action == "retry_contact"


def test_unknown_option_defaults_to_first():
    opt, defaulted = rules.match_decision("ORDER_NEEDS_CLINICAL_FIX", "Pause")
    assert defaulted and opt.action == "confirm_k0001"
