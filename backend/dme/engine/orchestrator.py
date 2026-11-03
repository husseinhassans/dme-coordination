"""The coordination engine: one case, three threads (supplier, order, patient) and a
join (spec §4-8).

Design
------
* One discrete-event loop. Every thread step is an action on the SimClock heap,
  (sim_time, seq, action). The loop pops the earliest action, jumps the clock to it
  and awaits it. Sim time never runs in real time.
* Calls and faxes are awaited inline. A human seat may take real minutes; sim time
  stands still meanwhile (a call is "instant" plus a fixed duration).
* Escalations are thread-scoped (§4). The advocate is asked immediately, but the
  decision is applied by a timer at the earliest moment the advocate queue would
  answer (next weekday working hour + turnaround). Other threads' timers due before
  then keep running. SAFETY_CONCERN never blocks: its decision is recorded whenever
  it arrives.
* Every state change goes through machines.move and is recorded as a Transition on
  the TimelineEvent that explains it. After each event the engine emits the event,
  a full snapshot, then waits `pace` seconds (honouring pause/step).
"""

from __future__ import annotations

import asyncio
import itertools
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable

from dme import contract as C
from dme.contract import (
    CALL_PURPOSES, CallGoal, CallRecord, CaseSnapshot, DirectorySupplier, Escalation,
    Fact, FaxDocument, Patient, SupplierStatus, ThreadName, TimelineEvent, Transition,
)
from dme.engine import calendar as cal
from dme.engine import machines, rules
from dme.engine.escalations import EscalationsMixin
from dme.engine.policy import (  # §10 timer values
    INTAKE_OFFICE_FAX, CALL_MINUTES, MAX_CORRECTION_LOOPS,
)
from dme.engine.threads.order import OrderThread
from dme.engine.threads.patient import PatientThread
from dme.engine.threads.supplier import SupplierThread


class Engine(EscalationsMixin, PatientThread, SupplierThread, OrderThread):
    """Public API per dme.contract (Engine block). Extra public attribute:
    `current_call_id`, the id of the call in progress (None between calls), so a
    human seat can key its prompts to the call the engine announced."""

    def __init__(self, *, patient: Patient, directory: list[DirectorySupplier],
                 call_runner: C.CallRunner, parties: C.PartyProvider, fax_desk: C.OfficeFaxDesk,
                 advocate: C.AdvocateProvider, emit: C.Emit,
                 start: datetime = datetime(2026, 11, 2, 9, 0)) -> None:
        self.patient = patient.model_copy(deep=True)
        self._runner = call_runner
        self._parties = parties
        self._fax_desk = fax_desk
        self._advocate = advocate
        self._emit_fn: Callable[[dict], Awaitable[None]] = emit
        self._clock = cal.SimClock(start)
        self._started_at = start

        # Machine states
        self.case_state: str = machines.INITIAL["case"]
        self.order_state: str = machines.INITIAL["order"]
        self.patient_state: str = machines.INITIAL["patient"]
        self.suppliers: dict[str, SupplierStatus] = {
            s.id: SupplierStatus(supplier=s) for s in directory}
        self._ranked: list[str] = [s.id for s in directory]

        # Records
        self.events: list[TimelineEvent] = []
        self.calls: dict[str, CallRecord] = {}
        self.faxes: dict[str, FaxDocument] = {}
        self.escalations: list[Escalation] = []
        self.next_check: dict[str, str] = {"supplier": "after her address is confirmed",
                                           "order": "now", "patient": "now"}
        self._ids = {k: itertools.count(1) for k in ("ev", "call", "fax", "esc")}
        self.current_call_id: str | None = None

        # Pacing / control
        self._pace = 1.0
        self._paused = False
        self._step_credits = 0
        self._wake = asyncio.Event()
        self._running = False
        self._done = False

        # Supplier thread
        self._pending_dials: set[str] = set()
        self._first_try: dict[str, datetime] = {}
        self._eligibility_override: set[str] = set()  # advocate: new rental period justified
        self._delivery_checks: set[tuple[str, datetime]] = set()
        self._promised: dict[str, tuple[datetime, datetime]] = {}
        self._promised_text: dict[str, str] = {}
        self._clarified: set[str] = set()            # "<entity>:<purpose>" that already had one
        self._post_miss_misses: dict[str, int] = {}
        self._confirm_misses: dict[str, int] = {}
        self._ranked_once = False

        # Order thread
        self._office_fax = INTAKE_OFFICE_FAX
        self._office_owner: str | None = None
        self._request_gen = 0
        self._nudges = 0
        self._correction_loops = 0
        self._loop_limit = MAX_CORRECTION_LOOPS       # +1 when the doctor confirms K0001
        self._last_problems: list[str] = []
        self._awaiting_new_note = False               # DOCS_INSUFFICIENT → re-visit booked
        self._order_text: str | None = None          # the validated signed order
        self._order_supplier: str | None = None      # who holds the order now
        self._polling = False

        # Patient thread
        self._patient_tries = 0
        self._patient_first_try: datetime | None = None
        self._named_to_patient: set[str] = set()     # suppliers proposed to her (D10)
        self._consented: str | None = None           # supplier she approved
        self._patient_window: tuple[datetime, datetime] | None = None
        self._patient_window_text: str | None = None
        self._patient_said_delivered = False
        self._last_routine_patient_call: datetime | None = None
        self._proposal_pending = False

        # Escalations
        self._open_blocking: dict[str, Escalation] = {}   # esc id -> escalation
        self._esc_ctx: dict[str, dict[str, Any]] = {}
        self._blocked_after_join = False

    # ------------------------------------------------------------------ API

    async def run(self) -> None:
        """Run until CLOSED / ABANDONED, nothing left to do, or cancelled."""
        self._running = True
        try:
            await self._open_case()
            while not self._done:
                timer = self._clock.pop_next()
                if timer is None:
                    await self._event("case", "system", "Engine idle",
                                      "No timers are pending and the case isn't closed. "
                                      "Waiting on nothing the engine can act on.")
                    break
                await timer.action()
        finally:
            self._running = False
            await self._emit_snapshot()

    def snapshot(self) -> CaseSnapshot:
        return CaseSnapshot(
            case_id="case-001",
            patient=self.patient,
            now=self._clock.now,
            running=self._running and not self._paused,
            case_state=self.case_state,  # type: ignore[arg-type]
            order_state=self.order_state,  # type: ignore[arg-type]
            patient_state=self.patient_state,  # type: ignore[arg-type]
            suppliers=[self.suppliers[sid] for sid in self._ranked],
            next_check=dict(self.next_check),
            seats={k: self._parties.seat(k) for k in ("supplier", "office", "patient")},
            events=list(self.events),
            calls=dict(self.calls),
            faxes=dict(self.faxes),
            escalations=list(self.escalations),
            cost=rules.cost_rows(),
            done=self._done,
        )

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False
        self._wake.set()

    def step(self) -> None:
        """Pause (if running) and let exactly one more event through."""
        self._paused = True
        self._step_credits += 1
        self._wake.set()

    def set_pace(self, seconds_between_events: float) -> None:
        self._pace = max(0.0, float(seconds_between_events))

    def now(self) -> datetime:
        return self._clock.now

    # ------------------------------------------------------- plumbing

    def _id(self, kind: str) -> str:
        return f"{kind}-{next(self._ids[kind]):03d}"

    def _at(self, when: datetime, action: Callable[[], Awaitable[None]], label: str) -> cal.Timer:
        return self._clock.schedule(when, action, label)

    def _in(self, delta: timedelta, action: Callable[[], Awaitable[None]], label: str,
            call: bool = True) -> cal.Timer:
        when = self._clock.now + delta
        return self._at(cal.call_slot(when) if call else when, action, label)

    async def _emit(self, msg: dict) -> None:
        await self._emit_fn(msg)

    async def _emit_snapshot(self) -> None:
        await self._emit({"type": "snapshot", "case": self.snapshot().model_dump(mode="json")})

    async def _pace_gate(self) -> None:
        await asyncio.sleep(self._pace)  # sleep(0) still yields so the server stays responsive
        while self._paused and self._step_credits == 0:
            self._wake.clear()
            await self._wake.wait()
        if self._paused and self._step_credits:
            self._step_credits -= 1

    async def _event(self, thread: ThreadName, kind: C.EventKind, title: str, detail: str,
                     tx: list[Transition] | None = None, *, call_id: str | None = None,
                     fax_id: str | None = None, escalation_id: str | None = None) -> TimelineEvent:
        ev = TimelineEvent(id=self._id("ev"), at=self._clock.now, thread=thread, kind=kind, title=title,
                           detail=detail, transitions=list(tx or []), call_id=call_id, fax_id=fax_id,
                           escalation_id=escalation_id)
        self.events.append(ev)
        await self._emit({"type": "event", "event": ev.model_dump(mode="json")})
        await self._emit_snapshot()
        await self._pace_gate()
        return ev

    # State moves -------------------------------------------------------

    def _move(self, machine: machines.Machine, entity: str, to: str, tx: list[Transition]) -> None:
        current = self._state_of(machine, entity)
        machines.move(machine, current, to)
        if machine == "case":
            self.case_state = to
        elif machine == "order":
            self.order_state = to
        elif machine == "patient":
            self.patient_state = to
        else:
            self.suppliers[entity].state = to  # type: ignore[assignment]
        tx.append(Transition(machine=machine, entity=entity, frm=current, to=to))

    def _state_of(self, machine: machines.Machine, entity: str) -> str:
        if machine == "case":
            return self.case_state
        if machine == "order":
            return self.order_state
        if machine == "patient":
            return self.patient_state
        return self.suppliers[entity].state

    def _sup_move(self, sid: str, to: str, tx: list[Transition]) -> None:
        self._move("supplier", sid, to, tx)

    def _name(self, sid: str) -> str:
        return self.suppliers[sid].supplier.name

    # Calls ---------------------------------------------------------------

    async def _call(self, purpose: str, thread: ThreadName, kind: C.PartyKind, party_id: str,
                    party_name: str, brief: str, *, may_disclose: list[str] | None = None,
                    must_say: list[str] | None = None) -> CallRecord:
        """Build the CallGoal from CALL_PURPOSES, run it through the call runner, store it."""
        goal = CallGoal(purpose=purpose, thread=thread, party_kind=kind, party_id=party_id,
                        party_name=party_name, brief=brief, facts=list(CALL_PURPOSES[purpose]),
                        may_disclose=list(may_disclose or []), must_say=list(must_say or []))
        call_id = self._id("call")
        self.current_call_id = call_id
        await self._emit({"type": "call_started", "call_id": call_id, "party_kind": kind,
                          "party_id": party_id, "party_name": party_name,
                          "seat": self._parties.seat(kind), "purpose": purpose})
        try:
            record = await self._runner.run(goal, self._parties.get(kind, party_id), call_id=call_id)
        finally:
            self.current_call_id = None
        record = record.model_copy(update={"id": call_id, "goal": goal})
        self.calls[call_id] = record
        await self._emit({"type": "call_ended", "call_id": call_id, "outcome": record.outcome})
        self._clock.advance(timedelta(minutes=CALL_MINUTES.get(record.outcome, 1)))
        if record.safety_flag is not None and record.safety_flag.known and record.safety_flag.value is True:
            await self._raise_safety(record)
        return record

    @staticmethod
    def _reached(rec: CallRecord) -> bool:
        """Answered, or hung up after saying something we could ground."""
        return rec.outcome == "answered" or (rec.outcome == "hung_up" and any(f.known for f in rec.facts.values()))

    @staticmethod
    def _f(record: CallRecord | dict[str, Fact], key: str):
        facts = record.facts if isinstance(record, CallRecord) else record
        return rules.known(facts, key)

    @staticmethod
    def _quote(record: CallRecord | dict[str, Fact], key: str) -> str:
        facts = record.facts if isinstance(record, CallRecord) else record
        f = facts.get(key)
        return f'"{f.quote}"' if f is not None and f.known and f.quote else "(no quote)"

    def _merge_facts(self, sid: str, record: CallRecord) -> None:
        """Newer known facts win; an unknown never overwrites a known one."""
        for key, fact in record.facts.items():
            if fact.known or key not in self.suppliers[sid].facts:
                self.suppliers[sid].facts[key] = fact

    async def _send_fax(self, to: str, text: str, thread: ThreadName = "order") -> FaxDocument:
        doc = FaxDocument(id=self._id("fax"), direction="outbound", to=to, sent_at=self._clock.now, text=text)
        self.faxes[doc.id] = doc
        await self._emit({"type": "fax", "fax": doc.model_dump(mode="json")})
        return doc

    # ------------------------------------------------------- case & join (§4)

    def _confirmed_supplier(self) -> str | None:
        return next((sid for sid in self._ranked if self.suppliers[sid].state == "CONFIRMED"), None)

    def _committed_supplier(self) -> str | None:
        return next((sid for sid in self._ranked if self.suppliers[sid].state in ("COMMITTED", "CONFIRMED")),
                    None)

    def _join_input_ready(self, thread: str) -> bool:
        sup = self._confirmed_supplier()
        if thread == "supplier":
            return sup is not None
        if thread == "order":
            return self.order_state == "DOCS_OK" and self._order_supplier == sup
        if thread == "patient":
            return self.patient_state in ("WINDOW_CONFIRMED", "DELIVERY_VERIFIED") and self._consented == sup
        return True

    def _join_blocked(self) -> bool:
        """§4: BLOCKED_ON_HUMAN only while the join waits on a thread that has an open
        blocking escalation. After the join has fired (HANDOFF_READY / DELIVERY_SCHEDULED),
        any open blocking escalation holds the case: it can't move on without that thread."""
        if self.case_state in ("HANDOFF_READY", "DELIVERY_SCHEDULED") or \
                (self.case_state == "BLOCKED_ON_HUMAN" and self._blocked_after_join):
            return bool(self._open_blocking)
        return any(not self._join_input_ready(e.thread) for e in self._open_blocking.values())

    def _refresh_case(self, tx: list[Transition]) -> None:
        """Recompute the case state from the threads. Only legal moves are made."""
        if self.case_state in ("CLOSED", "ABANDONED", "DELIVERED", "PAUSED"):
            return
        blocked = self._join_blocked()
        if self.case_state in ("OPEN", "HANDOFF_READY", "DELIVERY_SCHEDULED") and blocked:
            self._blocked_after_join = self.case_state != "OPEN"
            self._move("case", "case", "BLOCKED_ON_HUMAN", tx)
            return
        if self.case_state == "BLOCKED_ON_HUMAN":
            if blocked:
                return
            self._move("case", "case", "OPEN", tx)
        sup = self._confirmed_supplier()
        if self.case_state == "OPEN" and self._join_input_ready("supplier") and self._join_input_ready("order"):
            self._move("case", "case", "HANDOFF_READY", tx)
        if self.case_state == "HANDOFF_READY" and self._join_input_ready("patient"):
            self._move("case", "case", "DELIVERY_SCHEDULED", tx)
            self._schedule_delivery_checks(sup)  # type: ignore[arg-type]
        if self.case_state == "DELIVERY_SCHEDULED" and sup is None:
            self._move("case", "case", "OPEN", tx)

    async def _open_case(self) -> None:
        await self._event(
            "case", "system", "Case opened from intake",
            "Preconditions checked: HIPAA authorization and consent to automated calls are on file "
            "(assumption D1). Case OPEN. Three threads start in parallel. Intake has no home address "
            "and no Medicare number, so the first patient call collects them.")
        self._in(timedelta(minutes=2), self._patient_intro, "patient intro call")
        self._in(timedelta(minutes=5), self._order_request, "order request fax")

    async def _close_case(self, tx: list[Transition], detail: str) -> None:
        self._move("case", "case", "CLOSED", tx)
        self._done = True
        self.next_check = {"supplier": "—", "order": "—", "patient": "—"}
        days = cal.business_days_inclusive(self._started_at, self._clock.now)
        n_esc = len([e for e in self.escalations if e.code != "SAFETY_CONCERN"])
        await self._event("case", "system", "Case closed",
                          f"{detail} CLOSED after {days} business days (holidays excluded), "
                          f"with {n_esc} escalation{'s' if n_esc != 1 else ''}.", tx)

    async def _abandon(self, tx: list[Transition], why: str, thread: ThreadName,
                       escalation_id: str | None = None) -> None:
        """ABANDONED is reached only through BLOCKED_ON_HUMAN."""
        if self.case_state in ("OPEN", "HANDOFF_READY", "DELIVERY_SCHEDULED"):
            self._move("case", "case", "BLOCKED_ON_HUMAN", tx)
        if self.case_state == "BLOCKED_ON_HUMAN":
            self._move("case", "case", "ABANDONED", tx)
        self._done = True
        await self._event(thread, "human", "Case closed by the care advocate", why, tx,
                          escalation_id=escalation_id)

