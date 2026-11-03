"""Pure rules: supplier qualification, order validation, cost disclosure and escalation
packets. No I/O, no LLM. The LLM hands over grounded facts; these functions decide
(spec §9: "rules produce every transition and every escalation").

Only `Fact.known` counts: a fact whose quote wasn't verified is treated as unknown (D12).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from dme.contract import ORDER_DOC_FACTS, DisqualifyReason, EscalationCode, Fact, ThreadName

# ---------------------------------------------------------------------------
# Supplier qualification (spec §5, D9)
# ---------------------------------------------------------------------------

# Product policy, not Medicare rules (D9).
MAX_DELIVERY_ETA_DAYS = 10
MAX_RESTOCK_DAYS = 14

SUPPLIER_REQUIRED = ["accepting_new_medicare", "accepts_assignment_all_months", "k0001_in_stock",
                     "serves_address", "delivery_eta_days"]


def known(facts: dict[str, Fact], key: str):
    """The fact's value if it is known (value present AND quote verified), else None."""
    f = facts.get(key)
    return f.value if f is not None and f.known else None


def _as_int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Qualification:
    verdict: Literal["QUALIFIED", "DISQUALIFIED", "NEEDS_CLARIFICATION"]
    reason: DisqualifyReason | None = None
    missing: tuple[str, ...] = ()
    explanation: str = ""


def qualify_supplier(facts: dict[str, Fact]) -> Qualification:
    """§5 table. Hard fails are checked first: one quoted hard fail is enough, even if
    every other fact is unknown. Otherwise a required fact that isn't known means a
    clarifying call."""
    if known(facts, "accepting_new_medicare") is False:
        return Qualification("DISQUALIFIED", "NOT_ACCEPTING", explanation=
                             "Hard fail on accepting_new_medicare, so DISQUALIFIED (NOT_ACCEPTING).")
    if known(facts, "accepts_assignment_all_months") is False:
        return Qualification("DISQUALIFIED", "NO_ASSIGNMENT", explanation=
                             "Hard fail on assignment. Without it her cost isn't held to 20% (F9). "
                             "DISQUALIFIED (NO_ASSIGNMENT).")
    restock = _as_int(known(facts, "restock_days"))
    if known(facts, "k0001_in_stock") is False and restock is not None and restock > MAX_RESTOCK_DAYS:
        return Qualification("DISQUALIFIED", "NO_STOCK", explanation=
                             f"Out of stock and restock is {restock} days away, more than "
                             f"{MAX_RESTOCK_DAYS} (D9), so DISQUALIFIED (NO_STOCK).")
    if known(facts, "serves_address") is False:
        return Qualification("DISQUALIFIED", "OUT_OF_AREA", explanation=
                             "Doesn't deliver to her address, so DISQUALIFIED (OUT_OF_AREA).")
    eta = _as_int(known(facts, "delivery_eta_days"))
    if eta is not None and eta > MAX_DELIVERY_ETA_DAYS:
        return Qualification("DISQUALIFIED", "TOO_SLOW", explanation=
                             f"Delivery ETA {eta} days is over the {MAX_DELIVERY_ETA_DAYS}-day policy "
                             "(D9), so DISQUALIFIED (TOO_SLOW).")

    missing = [k for k in SUPPLIER_REQUIRED if known(facts, k) is None]
    if "k0001_in_stock" not in missing and known(facts, "k0001_in_stock") is False and restock is None:
        missing.append("restock_days")
    if eta is None and "delivery_eta_days" not in missing:
        missing.append("delivery_eta_days")
    if missing:
        return Qualification("NEEDS_CLARIFICATION", missing=tuple(missing), explanation=
                             "No quoted answer for " + ", ".join(missing) + ", so these stay unknown (D12).")
    return Qualification("QUALIFIED", explanation="Every hard check has a verified quote and passes, so QUALIFIED.")


# ---------------------------------------------------------------------------
# Order validation (spec §6, D7) and note pre-screen gaps (D8)
# ---------------------------------------------------------------------------

REQUIRED_HCPCS = "K0001"
CRITERIA = {f.key: f.description for f in ORDER_DOC_FACTS if f.key.startswith("crit_")}
CRITERIA_LABEL = {
    "crit_A_mradl": "A (mobility limit impairs a daily activity at home)",
    "crit_B_walker_not_enough": "B (a cane or walker can't resolve it)",
    "crit_C_home_access": "C (home can accommodate a wheelchair)",
    "crit_D_home_use": "D (will use it regularly at home)",
    "crit_E_willing": "E (willing to use it)",
    "crit_FG_propel_or_caregiver": "F or G (can self-propel, or has a caregiver)",
}

# Words that name a different chair than a standard one (K0002-K0007, power).
_OTHER_CHAIR = re.compile(r"light ?weight|high[- ]strength|heavy[- ]duty|hemi|ultra|power|tilt|recline|bariatric")


@dataclass
class OrderValidation:
    clerical: list[str] = field(default_factory=list)  # fixable by the office (re-sign)
    gaps: list[str] = field(default_factory=list)      # criteria with no supporting sentence (D8)
    clinical: list[str] = field(default_factory=list)  # code and note disagree on the chair

    @property
    def passed(self) -> bool:
        return not (self.clerical or self.gaps or self.clinical)

    @property
    def problems(self) -> list[str]:
        return self.clinical + self.clerical + [f"The note doesn't address criterion {g}." for g in self.gaps]


def parse_date(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    s = value.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _norm_code(v) -> str | None:
    return str(v).strip().upper() if v is not None else None


def validate_order(facts: dict[str, Fact], visit_date: str | date | None) -> OrderValidation:
    """D7: the six SWO elements, HCPCS = K0001, quantity 1, description consistent with
    the code, and (our sanity rule, not Medicare's) order date >= visit date.
    D8: any crit_* fact not known-true is a gap to ask the office about."""
    v = OrderValidation()

    # Six SWO elements (F3). Beneficiary = name or MBI; practitioner = name or NPI.
    if known(facts, "beneficiary") is None and known(facts, "mbi") is None:
        v.clerical.append("Missing beneficiary name or MBI.")
    description = known(facts, "description")
    if description is None:
        v.clerical.append("Missing item description.")
    qty = _as_int(known(facts, "quantity"))
    if qty is None:
        v.clerical.append("Missing quantity.")
    elif qty != 1:
        v.clerical.append(f"Quantity is {qty}; it must be 1.")
    if known(facts, "practitioner") is None and known(facts, "npi") is None:
        v.clerical.append("Missing practitioner name or NPI.")
    order_date = parse_date(known(facts, "order_date"))
    if order_date is None:
        v.clerical.append("Missing order date.")
    if known(facts, "signed") is not True:
        v.clerical.append("Missing practitioner signature.")

    # HCPCS and description must agree on a standard chair.
    code = _norm_code(known(facts, "hcpcs"))
    desc = str(description).lower() if description else ""
    names_other_chair = bool(_OTHER_CHAIR.search(desc))
    if code is None:
        v.clerical.append("Missing HCPCS code.")
    elif code != REQUIRED_HCPCS:
        if names_other_chair:
            v.clinical.append(f'Order is coded {code} and describes "{description}", not a standard '
                              "wheelchair. Choosing the chair is the doctor's call.")
        else:
            v.clerical.append(f'HCPCS {code} doesn\'t match the description "{description or "?"}"; '
                              f"a standard wheelchair is {REQUIRED_HCPCS}.")
    elif names_other_chair:
        v.clinical.append(f'Order is coded {REQUIRED_HCPCS} but describes "{description}".')

    # Sanity check, labelled as ours (D7).
    visit = parse_date(visit_date)
    if order_date and visit and order_date < visit:
        v.clerical.append(f"Order date {order_date} is before the visit {visit} "
                          "(our sanity check, not a Medicare rule).")

    # Pre-screen gaps (D8).
    v.gaps = [CRITERIA_LABEL.get(k, k) for k in CRITERIA if known(facts, k) is not True]
    return v


# ---------------------------------------------------------------------------
# Her cost (spec §2 table; F6, F7, F10, F12). Computed here, never by the LLM.
# ---------------------------------------------------------------------------

FEE_K0001_RR = Decimal("34.27")     # F7: Q4 2026 allowed, former Chicago CBA
LATER_MONTH_FACTOR = Decimal("0.75")  # F6: months 4-13 pay 75% of the fee
COINSURANCE = Decimal("0.20")
DEDUCTIBLE_2026 = 283               # F10
QMB_IL_INCOME_2026 = "~$1,330 / mo"  # F12
QMB_IL_ASSETS_2026 = "$9,950"


def _cents(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class CostNumbers:
    fee_early: Decimal
    fee_later: Decimal
    share_early: Decimal
    share_later: Decimal
    total_share: Decimal

    @property
    def total_rounded(self) -> int:
        return int(self.total_share.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def cost_numbers() -> CostNumbers:
    fee_early = FEE_K0001_RR
    fee_later = _cents(FEE_K0001_RR * LATER_MONTH_FACTOR)
    share_early = _cents(fee_early * COINSURANCE)
    share_later = _cents(fee_later * COINSURANCE)
    return CostNumbers(fee_early, fee_later, share_early, share_later, 3 * share_early + 10 * share_later)


def cost_rows() -> list[tuple[str, str]]:
    """Rows for CaseSnapshot.cost and escalation packets."""
    c = cost_numbers()
    return [
        ("Medicare-allowed rental, months 1–3", f"${c.fee_early} / mo"),
        ("Her share, months 1–3", f"${c.share_early} / mo"),
        ("Medicare-allowed rental, months 4–13 (75%)", f"${c.fee_later} / mo"),
        ("Her share, months 4–13", f"${c.share_later} / mo"),
        ("Her total over 13 months", f"≈ ${c.total_rounded}"),
        ("2026 Part B deductible", f"any unmet part of ${DEDUCTIBLE_2026}; resets in January"),
        ("2027 deductible", "applies to 2027 rental months until met"),
        ("If she qualifies for QMB", "$0, and suppliers can't bill her"),
    ]


def cost_must_say() -> list[str]:
    """Exact strings the intro call must say (CallGoal.must_say). Numbers injected,
    never generated (§9)."""
    c = cost_numbers()
    return [
        f"about ${c.share_early} a month for the first three months",
        f"then about ${c.share_later} a month",
        f"roughly ${c.total_rounded} in all over 13 months, after which the chair is hers",
        f"plus any part of this year's ${DEDUCTIBLE_2026} Part B deductible she hasn't met; "
        "the deductible starts over in January",
    ]


def qmb_rows() -> list[tuple[str, str]]:
    return [("Illinois QMB, 2026", f"income ≤ {QMB_IL_INCOME_2026}, assets ≤ {QMB_IL_ASSETS_2026}")]


# ---------------------------------------------------------------------------
# Escalation packets (spec §8)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EscalationPacket:
    code: EscalationCode
    thread: ThreadName
    blocking: bool
    question: str
    options: list[str]


@dataclass(frozen=True)
class DecisionOption:
    """One answer the advocate can give, and the engine action it maps to."""
    label: str
    action: str
    keywords: tuple[str, ...]


def _o(label: str, action: str, *keywords: str) -> DecisionOption:
    return DecisionOption(label, action, keywords or (label.lower(),))


# §8 decision options. Every option maps to exactly one engine action.
#   close / pause (non-patient) / transfer / new_code → the case is ABANDONED with the reason
#   (PAUSED is reserved for an inpatient stay, §4).
DECISIONS: dict[EscalationCode, list[DecisionOption]] = {
    "SUPPLIERS_EXHAUSTED": [_o("Widen to N miles", "widen", "widen", "mile", "radius"),
                            _o("Add an out-of-directory supplier", "add_supplier", "add", "out-of-directory"),
                            _o("Pause", "pause", "pause", "stop")],
    "ELIGIBILITY_CONFLICT": [_o("Proceed (new rental period justified)", "proceed", "proceed", "justified"),
                             _o("Transfer to the prior supplier", "transfer", "transfer", "prior"),
                             _o("Close the case", "close", "close")],
    "ORDER_UNSIGNED": [_o("Retry with contact X", "retry_contact", "retry", "contact"),
                       _o("Pause", "pause", "pause", "stop")],
    "ORDER_NEEDS_CLINICAL_FIX": [_o("Doctor confirms K0001", "confirm_k0001", "k0001", "confirm"),
                                 _o("New code: re-run qualification", "new_code", "new code", "re-run")],
    "DOCS_INSUFFICIENT": [_o("Re-visit booked", "revisit", "re-visit", "revisit", "visit"),
                          _o("Close the case", "close", "close")],
    "PATIENT_UNREACHABLE": [_o("Reached: resume", "reached", "reached", "resume"),
                            _o("Pause", "pause", "pause", "stop")],
    "PATIENT_COST_CONCERN": [_o("Proceed", "proceed", "proceed"),
                             _o("Proceed and start a QMB application", "proceed_qmb", "qmb", "msp"),
                             _o("Pause 30 days", "pause_30", "pause"),
                             _o("Close the case", "close", "close")],
    "PATIENT_DECLINES": [_o("Proceed", "proceed", "proceed"), _o("Close the case", "close", "close")],
    "AMBIGUOUS_CALL_OUTCOME": [_o("Set fact", "set_fact", "set", "fact")],
    "SAFETY_CONCERN": [_o("Acknowledged", "acknowledged", "ack")],
}

# When an answer matches several options, the more specific / more final one wins.
_MATCH_FIRST = ("close", "transfer", "new_code", "pause", "pause_30", "proceed_qmb", "add_supplier")


def match_decision(code: EscalationCode, decision: str | None) -> tuple[DecisionOption, bool]:
    """Map the advocate's typed option to a DecisionOption. Returns (option, defaulted):
    an unrecognised answer is treated as the first option, and `defaulted` says so."""
    options = DECISIONS[code]
    text = (decision or "").strip().lower()
    for o in options:
        if text == o.label.lower():
            return o, False
    ordered = sorted(options, key=lambda o: (o.action not in _MATCH_FIRST, options.index(o)))
    for o in ordered:
        if text and any(k in text for k in o.keywords):
            return o, False
    return options[0], True


_PACKETS: dict[EscalationCode, tuple[ThreadName, bool, str]] = {
    "SUPPLIERS_EXHAUSTED": ("supplier", True,
                            "Every supplier in the directory is out and none committed. How should we widen "
                            "the search? (fields for a new supplier: name, phone, address)"),
    "ELIGIBILITY_CONFLICT": ("supplier", True,
                             "The supplier's eligibility check shows a same/similar item or a plan mismatch. "
                             "Is a new rental period justified?"),
    "ORDER_UNSIGNED": ("order", True,
                       "The office hasn't signed the order after 3 nudges. Who should we contact? "
                       "(fields: contact, fax)"),
    "ORDER_NEEDS_CLINICAL_FIX": ("order", True,
                                 "The code and the note disagree on which chair she needs. What did the doctor "
                                 "intend?"),
    "DOCS_INSUFFICIENT": ("order", True,
                          "The supplier still rejects the documentation after the addendum loop. What next?"),
    "PATIENT_UNREACHABLE": ("patient", True,
                            "Eleanor hasn't answered 4 calls over 3 business days. Can someone reach her? "
                            "(fields: address, mbi if collected)"),
    "PATIENT_COST_CONCERN": ("patient", True, "Does Eleanor want to go ahead, and does she need help paying?"),
    "PATIENT_DECLINES": ("patient", True, "Eleanor declined the chair for a non-cost reason. Should we proceed?"),
    "AMBIGUOUS_CALL_OUTCOME": ("case", True,
                               "A required fact is still unknown after a clarifying call. What is its value?"),
    "SAFETY_CONCERN": ("case", False,
                       "A fall, injury or acute distress was mentioned on a call. Please check on her welfare."),
}


def escalation_packet(code: EscalationCode, thread: ThreadName | None = None,
                      question: str | None = None) -> EscalationPacket:
    """The §8 row for `code`. AMBIGUOUS_CALL_OUTCOME and SAFETY_CONCERN take the thread
    of the call that raised them; a specific question may replace the generic one."""
    default_thread, blocking, default_q = _PACKETS[code]
    return EscalationPacket(code, thread or default_thread, blocking, question or default_q,
                            [o.label for o in DECISIONS[code]])
