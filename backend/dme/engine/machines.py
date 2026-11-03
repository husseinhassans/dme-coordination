"""The four transition tables: the edges of the `M` object in docs/state-machine.html,
plus the resume edges marked "added" (so every escalation can be answered and the case
continues). Every state change in the engine goes through `move`, so a transition the
design doesn't draw can't happen silently.
"""

from __future__ import annotations

from typing import Literal

Machine = Literal["case", "supplier", "order", "patient"]

TRANSITIONS: dict[Machine, frozenset[tuple[str, str]]] = {
    "case": frozenset({
        ("OPEN", "HANDOFF_READY"),                 # join fires
        ("HANDOFF_READY", "DELIVERY_SCHEDULED"),   # window agreed
        ("DELIVERY_SCHEDULED", "DELIVERED"),       # POD + patient
        ("DELIVERED", "CLOSED"),                   # code matches
        ("DELIVERY_SCHEDULED", "OPEN"),            # supplier ghosted
        ("OPEN", "BLOCKED_ON_HUMAN"),              # escalation
        ("BLOCKED_ON_HUMAN", "OPEN"),              # decision
        ("BLOCKED_ON_HUMAN", "ABANDONED"),         # closed by human
        ("DELIVERY_SCHEDULED", "PAUSED"),          # admitted
        ("PAUSED", "OPEN"),                        # discharged
        # added: an escalation can block the case after the join has fired
        ("HANDOFF_READY", "BLOCKED_ON_HUMAN"),     # escalation
        ("DELIVERY_SCHEDULED", "BLOCKED_ON_HUMAN"),  # escalation
    }),
    "supplier": frozenset({
        ("NOT_CONTACTED", "CALLING"),     # dial
        ("CALLING", "NO_ANSWER"),         # no pickup
        ("NO_ANSWER", "CALLING"),         # retry
        ("NO_ANSWER", "UNREACHABLE"),     # 3 misses
        ("CALLING", "QUALIFIED"),         # quoted facts pass
        ("CALLING", "DISQUALIFIED"),      # hard fail
        ("CALLING", "ESC_AMBIGUOUS"),     # no quote x2
        ("QUALIFIED", "COMMITTED"),       # takes referral
        ("COMMITTED", "CONFIRMED"),       # order + eligibility
        ("COMMITTED", "DISQUALIFIED"),    # reconfirm fails
        ("COMMITTED", "ESC_ELIGIBILITY"), # same/similar
        ("CONFIRMED", "GHOSTED"),         # promised +1d
        ("CONFIRMED", "DELIVERED"),       # POD
        ("GHOSTED", "ESC_EXHAUSTED"),     # none left
        # added: resume edges and a dropped backup
        ("QUALIFIED", "DISQUALIFIED"),    # no longer available
        ("ESC_AMBIGUOUS", "CALLING"),     # fact set by human
        ("ESC_ELIGIBILITY", "COMMITTED"), # proceed: new rental period justified
        ("ESC_EXHAUSTED", "GHOSTED"),     # search widened
        ("UNREACHABLE", "NOT_CONTACTED"), # search widened
    }),
    "order": frozenset({
        ("VERBAL_IN_CHART", "REQUESTED"),            # fax + checklist
        ("REQUESTED", "ACKNOWLEDGED"),               # owner named
        ("ACKNOWLEDGED", "RECEIVED"),                # signed
        ("RECEIVED", "VALIDATED"),                   # rules pass
        ("REQUESTED", "NUDGE"),                      # no ack 1d
        ("NUDGE", "REQUESTED"),                      # resend
        ("ACKNOWLEDGED", "NUDGE"),                   # unsigned 3d
        ("NUDGE", "ESC_UNSIGNED"),                   # 3 nudges
        ("RECEIVED", "CORRECTION_REQUESTED"),        # error or gap
        ("CORRECTION_REQUESTED", "RECEIVED"),        # re-signed
        ("CORRECTION_REQUESTED", "ESC_CLINICAL"),    # clinical change
        ("VALIDATED", "SENT_TO_SUPPLIER"),           # to committed
        ("SENT_TO_SUPPLIER", "DOCS_OK"),             # notes OK
        ("DOCS_OK", "SENT_TO_SUPPLIER"),             # re-sent on ghost
        ("SENT_TO_SUPPLIER", "ESC_DOCS"),            # still short
        # added: resume edges
        ("ESC_UNSIGNED", "REQUESTED"),               # retry via contact
        ("ESC_CLINICAL", "CORRECTION_REQUESTED"),    # doctor confirms K0001
        ("ESC_DOCS", "SENT_TO_SUPPLIER"),            # re-visit done
    }),
    "patient": frozenset({
        ("NOT_CONTACTED", "INFORMED"),            # intro call
        ("NOT_CONTACTED", "NO_ANSWER"),           # no pickup
        ("NO_ANSWER", "INFORMED"),                # reached
        ("NO_ANSWER", "ESC_UNREACHABLE"),         # 4 tries, 3d
        ("INFORMED", "WINDOW_CONFIRMED"),         # consents
        ("WINDOW_CONFIRMED", "INFORMED"),         # missed or slipped
        ("WINDOW_CONFIRMED", "DELIVERY_VERIFIED"),  # post-delivery call
        ("INFORMED", "ESC_COST"),                 # cost concern
        ("ESC_COST", "INFORMED"),                 # human: proceed
        ("INFORMED", "ESC_DECLINES"),             # declines
        # added: resume edges
        ("ESC_UNREACHABLE", "INFORMED"),          # reached
        ("ESC_DECLINES", "INFORMED"),             # proceed
    }),
}

INITIAL: dict[Machine, str] = {
    "case": "OPEN",
    "supplier": "NOT_CONTACTED",
    "order": "VERBAL_IN_CHART",
    "patient": "NOT_CONTACTED",
}


class IllegalTransition(Exception):
    """A rule tried to make a move the state diagram doesn't allow."""

    def __init__(self, machine: str, frm: str, to: str) -> None:
        super().__init__(f"{machine}: {frm} -> {to} is not in the transition table")
        self.machine, self.frm, self.to = machine, frm, to


def can_move(machine: Machine, current: str, to: str) -> bool:
    return (current, to) in TRANSITIONS[machine]


def move(machine: Machine, current: str, to: str) -> str:
    """Return `to` if the table allows current -> to, else raise IllegalTransition."""
    if not can_move(machine, current, to):
        raise IllegalTransition(machine, current, to)
    return to
