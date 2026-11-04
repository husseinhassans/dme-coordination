"""Patient thread (spec §7): intro, consent to supplier + window, post-delivery check."""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from dme.contract import (
    CallRecord, Transition,
)
from dme.engine import calendar as cal
from dme.engine import rules
from dme.engine.policy import (  # §10 timer values
    RETRY_DELAYS, PATIENT_MAX_TRIES, fmt_time,
)


class PatientThread:
    """Engine mixin for the patient thread."""

    def _patient_slot(self, delay: timedelta, urgent: bool = False) -> datetime:
        """D13: 09:00-18:00, at most one routine call a day (urgent may add one)."""
        when = cal.call_slot(self._clock.now + delay)
        last = self._last_routine_patient_call
        if not urgent and last is not None and last.date() == when.date():
            when = cal.call_slot(datetime.combine(cal.next_business_day(when), cal.CALL_OPEN))
        return when

    async def _patient_call(self, purpose: str, brief: str, urgent: bool = False, **kw) -> CallRecord:
        if not urgent:
            self._last_routine_patient_call = self._clock.now
        return await self._call(purpose, "patient", "patient", "patient", self.patient.name, brief, **kw)

    def _retry_at(self, first: datetime, tries: int) -> datetime:
        """§10 retry schedule measured from the first try: +4h, +1 bd, +2 bd."""
        d = RETRY_DELAYS[min(tries, len(RETRY_DELAYS)) - 1]
        when = first + d if isinstance(d, timedelta) else cal.add_business_days(first, d)
        return cal.call_slot(max(when, self._clock.now))

    async def _patient_intro(self) -> None:
        if self.patient_state not in ("NOT_CONTACTED", "NO_ANSWER"):
            return
        self._patient_first_try = self._patient_first_try or self._clock.now
        rec = await self._patient_call(
            "patient_intro",
            f"Intro call to {self.patient.name}, {self.patient.age}, about the {self.patient.equipment} "
            f"{self.patient.pcp_name} noted at her visit on {self.patient.visit_date}. Open with the "
            "automated-assistant disclosure (D2). Confirm her home address and read her Medicare number "
            "from her card. Explain the cost using the exact numbers given. Ask whether she had a "
            "wheelchair after her March knee surgery (D15) and the best time to reach her.",
            may_disclose=["patient name", "PCP name", "visit date"], must_say=rules.cost_must_say())
        tx: list[Transition] = []
        if not self._reached(rec):
            self._patient_tries += 1
            if self.patient_state == "NOT_CONTACTED":
                self._move("patient", "patient", "NO_ANSWER", tx)
            if self._patient_tries >= PATIENT_MAX_TRIES:
                self._move("patient", "patient", "ESC_UNREACHABLE", tx)
                await self._escalate("PATIENT_UNREACHABLE", "patient", tx, title="Eleanor can't be reached",
                                     detail=f"{PATIENT_MAX_TRIES} tries over 3 business days with no answer, "
                                            "so PATIENT_UNREACHABLE. A person may need a welfare check.",
                                     call_ids=[rec.id])
                return
            when = self._retry_at(self._patient_first_try, self._patient_tries)
            self.next_check["patient"] = f"retry {fmt_time(when)}"
            await self._event("patient", "call", "Eleanor doesn't answer",
                              f"No answer (try {self._patient_tries} of {PATIENT_MAX_TRIES}). Voicemail has a "
                              f"callback number only (D3). Retry {fmt_time(when)}.", tx, call_id=rec.id)
            self._at(when, self._patient_intro, "patient intro retry")
            return

        address, mbi = self._f(rec, "address"), self._f(rec, "mbi")
        if address:
            self.patient.address = str(address)
            if m := re.search(r"\b(\d{5})\b", str(address)):
                self.patient.zip = m[1]
            self.patient.zip = self.patient.zip or "60614"
        if mbi:
            self.patient.mbi = str(mbi)
        self._move("patient", "patient", "INFORMED", tx)
        prior = self._f(rec, "prior_wheelchair")
        notes = ["Patient INFORMED. The cost range was given with rules-computed numbers."]
        deductible = self._f(rec, "deductible_met")
        notes.append("She confirmed the deductible is met." if deductible is True else
                     "The deductible isn't confirmed, so it stays unknown and the cost stays a range.")
        notes.append("She reports a prior wheelchair: the supplier's same/similar check matters (F11, D15)."
                     if prior is True else
                     "No prior wheelchair is reported, though the supplier's eligibility check is the real "
                     "test (D15)." if prior is False else "Prior wheelchair is unknown (D15).")
        if address:
            notes.append("The address unblocks supplier ranking.")
        self.next_check["patient"] = "when a supplier and date are ready"
        await self._event("patient", "call", f"Intro call to {self.patient.name}", " ".join(notes), tx,
                          call_id=rec.id)
        if address:
            self._in(timedelta(minutes=2), self._rank_suppliers, "rank suppliers", call=False)
        elif "patient:intro" not in self._clarified:
            self._clarified.add("patient:intro")
            self._at(self._patient_slot(timedelta(hours=2), urgent=True), self._patient_clarify_address,
                     "clarify address")
        else:
            await self._ambiguous("patient", ["address"], rec.id, kind="address")

    async def _patient_clarify_address(self) -> None:
        rec = await self._patient_call("patient_intro", "Clarifying call: confirm her home street address.",
                                       urgent=True, may_disclose=["patient name"])
        address = self._f(rec, "address")
        if address:
            self.patient.address = str(address)
            await self._event("patient", "call", "Address confirmed", "Her address is now quoted.",
                              call_id=rec.id)
            self._in(timedelta(minutes=2), self._rank_suppliers, "rank suppliers", call=False)
        else:
            await self._ambiguous("patient", ["address"], rec.id, kind="address")

    def _propose(self, sid: str, window_text: str, delay: timedelta, urgent: bool = False) -> None:
        """Ask her to approve a supplier + window (D10)."""
        if self._proposal_pending:
            return
        self._proposal_pending = True
        when = self._patient_slot(delay, urgent=urgent)
        self.next_check["patient"] = f"asking her to approve {self._name(sid)} {fmt_time(when)}"
        self._at(when, lambda: self._patient_consent(sid, window_text, urgent), "patient consent call")

    async def _patient_consent(self, sid: str, window_text: str, urgent: bool, attempt: int = 1) -> None:
        self._proposal_pending = False
        if self.patient_state != "INFORMED" or self._blocked("patient"):
            return
        name = self._name(sid)
        switching = bool(self._named_to_patient - {sid})
        self._named_to_patient.add(sid)
        brief = (f"Ask {self.patient.name} whether {name} may provide her wheelchair and whether the "
                 f"delivery window {window_text} works (D10). "
                 + ("The previous supplier didn't follow through; apologise briefly. " if switching else "")
                 + "Don't persuade. If she asks about cost, answer from the case file.")
        rec = await self._patient_call("patient_consent", brief, urgent=urgent,
                                       may_disclose=["patient name", "supplier name", "delivery window"],
                                       must_say=[name, window_text])
        tx: list[Transition] = []
        if not self._reached(rec):
            if attempt >= PATIENT_MAX_TRIES:
                await self._escalate("PATIENT_UNREACHABLE", "patient", tx, title="Eleanor can't be reached",
                                     detail="4 tries with no answer while a supplier waits for her approval.",
                                     call_ids=[rec.id])
                return
            when = cal.call_slot(self._clock.now + timedelta(hours=3))
            await self._event("patient", "call", "Eleanor doesn't answer",
                              f"No answer. Retry {fmt_time(when)}.", call_id=rec.id)
            self._at(when, lambda: self._patient_consent(sid, window_text, urgent, attempt + 1), "consent retry")
            return

        if self._f(rec, "cost_concern") is True:
            self._move("patient", "patient", "ESC_COST", tx)
            await self._escalate_cost(rec, sid, window_text, tx)
            return
        if self._f(rec, "declines") is True or self._f(rec, "consents_to_supplier") is False:
            self._move("patient", "patient", "ESC_DECLINES", tx)
            await self._escalate("PATIENT_DECLINES", "patient", tx, title="Eleanor declines",
                                 detail=f"She declines for a non-cost reason: {self._quote(rec, 'declines')}. "
                                        "Criterion E is willingness; a person should hear why.",
                                 call_ids=[rec.id], sid=sid)
            return
        if self._f(rec, "consents_to_supplier") is True and self._f(rec, "window_ok") is True:
            self._move("patient", "patient", "WINDOW_CONFIRMED", tx)
            self._consented = sid
            self._patient_window = cal.parse_window(window_text, self._clock.now)
            self._patient_window_text = window_text
            self._refresh_case(tx)
            joined = self.case_state == "DELIVERY_SCHEDULED"
            await self._event("patient", "call", f"Eleanor approves {name} and the window",
                              f"Consent {self._quote(rec, 'consents_to_supplier')} and window "
                              f"{self._quote(rec, 'window_ok')} are quoted, so WINDOW_CONFIRMED."
                              + (" The join fires and the case is DELIVERY_SCHEDULED." if joined else ""),
                              tx, call_id=rec.id)
            await self._after_consent(sid)
            return
        missing = [k for k in ("consents_to_supplier", "window_ok") if self._f(rec, k) is None]
        key = f"patient:consent:{sid}"
        if key not in self._clarified:
            self._clarified.add(key)
            await self._event("patient", "call", "Her answer isn't clear",
                              f"No verified quote for {', '.join(missing)}. One clarifying call (§10).",
                              call_id=rec.id)
            self._at(self._patient_slot(timedelta(hours=1), urgent=True),
                     lambda: self._patient_consent(sid, window_text, True), "clarify consent")
        else:
            await self._ambiguous("patient", missing, rec.id, kind="consent", sid=sid)

    async def _escalate_cost(self, rec: CallRecord, sid: str | None, window_text: str | None,
                             tx: list[Transition]) -> None:
        numbers = rules.cost_rows() + rules.qmb_rows()
        context = [f"She said: {self._quote(rec, 'cost_concern')}",
                   *([f"{self._name(sid)} is ready: {window_text}."] if sid else []),
                   *[f"{self._name(w)} was told in writing not to deliver or bill. Medicare "
                     "pays only with a signed delivery ticket, so she won't pay twice." for w in self._withdrawn],
                   ("The order is validated and reusable; no new paperwork is needed." if self._order_text
                    else f"The order is {self.order_state.replace('_', ' ').lower()}.")]
        await self._escalate(
            "PATIENT_COST_CONCERN", "patient", tx, title="Eleanor raises a cost concern",
            detail=f"cost_concern is true with a quote ({self._quote(rec, 'cost_concern')}), so "
                   "PATIENT_COST_CONCERN. The patient thread stops. The join can't fire without her consent, "
                   "so the case is BLOCKED_ON_HUMAN. The supplier and order threads keep running. The engine "
                   "didn't try to talk her into it.",
            numbers=numbers, context=context, call_ids=[rec.id], sid=sid)

    async def _repropose(self) -> None:
        sid = self._confirmed_supplier()
        if sid and sid in self._promised and self._promised[sid][1] < self._clock.now:
            sid = None                         # it already missed its window: don't offer it again
        sid = sid or self._best_backup()
        if sid is None or self.patient_state != "INFORMED":
            return
        self._propose(sid, self._window_for(sid), timedelta(0))

    async def _after_consent(self, sid: str) -> None:
        """She approved `sid`: commit it if needed, then the order may go there (D3)."""
        s = self.suppliers[sid]
        if s.state == "QUALIFIED":
            if self._f(s.facts, "accepts_referral") is True:
                tx: list[Transition] = []
                self._sup_move(sid, "COMMITTED", tx)
                self._on_commit(sid)
                sent = await self._send_order_if_ready(sid, tx, announce=False)
                self._refresh_case(tx)
                await self._event(
                    "supplier", "rule", f"Engine resumes: order to {self._name(sid)}",
                    f"With her consent, the order, her name and her MBI may go to {self._name(sid)} (D3). "
                    f"Its earlier quote {self._quote(s.facts, 'accepts_referral')} counts as accepting the "
                    "referral, so COMMITTED." + (" The validated order is re-sent as is (D5)." if sent else ""),
                    tx)
            else:
                self._in(timedelta(minutes=10), lambda: self._ask_to_commit(sid), "ask to commit")
        elif s.state == "COMMITTED":
            tx = []
            if await self._send_order_if_ready(sid, tx, announce=False):
                self._refresh_case(tx)
                await self._event("order", "fax", f"Order sent to {self._name(sid)}",
                                  "She approved this supplier, so it may receive her details (D3).", tx)

    async def _patient_delivery_check(self, sid: str, attempt: int = 1) -> None:
        if self.patient_state != "WINDOW_CONFIRMED" or self._consented != sid:
            return
        rec = await self._patient_call("patient_delivery_check",
                                       f"Ask {self.patient.name} whether the wheelchair from {self._name(sid)} "
                                       "arrived.", urgent=True,
                                       may_disclose=["patient name", "supplier name"])
        tx: list[Transition] = []
        delivered = self._f(rec, "delivered")
        if not self._reached(rec) or delivered is None:
            if attempt < PATIENT_MAX_TRIES:
                when = cal.call_slot(self._clock.now + timedelta(hours=2))
                await self._event("patient", "call", "Delivery not confirmed yet",
                                  f"No verified answer. Try again {fmt_time(when)}.", call_id=rec.id)
                self._at(when, lambda: self._patient_delivery_check(sid, attempt + 1), "delivery recheck")
            return
        if delivered is True:
            self._patient_said_delivered = True
            self._move("patient", "patient", "DELIVERY_VERIFIED", tx)
            self.next_check["patient"] = "done"
            await self._event("patient", "call", "It's here",
                              f"{self._quote(rec, 'delivered')}: DELIVERY_VERIFIED from her side. The supplier's "
                              "proof of delivery is still needed (D11).", tx, call_id=rec.id)
            self._in(timedelta(minutes=15), lambda: self._supplier_delivery_check(sid), f"POD {sid}")
            return
        self._move("patient", "patient", "INFORMED", tx)
        ghost = cal.end_of_business_day(cal.add_business_days(self._promised[sid][1], 1))
        self.next_check["patient"] = "update once the supplier is sorted"
        self.next_check["supplier"] = f"calling {self._name(sid)}"
        await self._event("patient", "call", "Nobody came",
                          f"{self._quote(rec, 'delivered')}: the window was missed, so the patient goes back to "
                          f"INFORMED. Check with the supplier now. The ghost threshold is {fmt_time(ghost)}.",
                          tx, call_id=rec.id)
        self._in(timedelta(minutes=5), lambda: self._supplier_delivery_check(sid), f"missed delivery {sid}")
        if self._f(rec, "cost_concern") is True:
            # Same rule as the consent call: a cost worry goes to a person, whichever call it comes up on.
            tx = []
            self._move("patient", "patient", "ESC_COST", tx)
            await self._escalate_cost(rec, None, None, tx)

