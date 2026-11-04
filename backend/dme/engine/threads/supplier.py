"""Supplier thread (spec §5): rank, scout, qualify, commit, confirm, deliver or ghost."""

from __future__ import annotations

from datetime import datetime, timedelta

from dme.contract import (
    CallRecord, Transition,
)
from dme.engine import calendar as cal
from dme.engine import rules
from dme.engine.geo import rank_by_distance
from dme.engine.policy import (  # §10 timer values
    IN_FLIGHT, POD_CHASES, RETRY_DELAYS, MAX_RETRIES, RECONFIRM_BUSINESS_DAYS, fmt_day, fmt_time,
)


class SupplierThread:
    """Engine mixin for the supplier thread."""

    def _blocked(self, thread: str) -> bool:
        return any(e.thread == thread for e in self._open_blocking.values())

    def _best_backup(self) -> str | None:
        return next((sid for sid in self._ranked if self.suppliers[sid].state == "QUALIFIED"), None)

    def _window_for(self, sid: str) -> str:
        facts = self.suppliers[sid].facts
        if (v := self._f(facts, "delivery_date")) is not None:
            return str(v)                      # a date they committed to
        if (v := self._f(facts, "earliest_delivery")) is not None:
            # Only their earliest, not a promise: say so (they confirm once they have the order).
            return f"as early as {v}, once they confirm the exact time"
        eta = self._f(facts, "delivery_eta_days")
        return f"within {eta} business days of the order" if eta else "as soon as the order is received"

    async def _rank_suppliers(self) -> None:
        if self._ranked_once:
            return
        self._ranked_once = True
        ranked = rank_by_distance([s.supplier for s in self.suppliers.values()])
        for d in ranked:
            self.suppliers[d.id].supplier = d
        self._ranked = [d.id for d in ranked]
        last = ", ".join(f"{d.name.split()[0]} {d.miles}" for d in ranked[-2:])
        await self._event("supplier", "rule", f"Rank {len(ranked)} suppliers by distance",
                          "The directory has only name, phone and address, so suppliers are ranked by "
                          f"straight-line distance from {self.patient.zip or 'her address'}. Last: {last} mi. "
                          f"The {IN_FLIGHT} nearest are called. Scouting calls never use her name (D3).")
        self._pump()

    def _pump(self) -> None:
        """Keep the search moving (§5, §10): 3 in flight until one commits, then one warm
        backup. Re-evaluated when a batch of first dials has resolved, or a candidate drops."""
        if self._pending_dials or self._blocked("supplier") or self._done:
            return
        if self.case_state in ("DELIVERY_SCHEDULED", "DELIVERED", "CLOSED"):
            return
        committed = self._committed_supplier()
        backup = self._best_backup()
        if committed and backup:
            return
        if not committed and backup:
            if not self._named_to_patient:
                self._in(timedelta(minutes=5), lambda: self._ask_to_commit(backup), "ask to commit")
            return
        in_flight = [sid for sid in self._ranked if self.suppliers[sid].state in ("CALLING", "NO_ANSWER")]
        fresh = [sid for sid in self._ranked if self.suppliers[sid].state == "NOT_CONTACTED"]
        to_dial = fresh[:max(0, IN_FLIGHT - len(in_flight))]
        if not to_dial:
            if not committed and not in_flight:
                self._in(timedelta(minutes=1), self._suppliers_exhausted, "suppliers exhausted", call=False)
            return
        for i, sid in enumerate(to_dial):
            self._pending_dials.add(sid)
            self._in(timedelta(minutes=6 + i), lambda sid=sid: self._supplier_dial(sid), f"dial {sid}")
        if committed:
            names = " and ".join(self._name(s).split(" ")[0] for s in to_dial)
            self.next_check["supplier"] = f"calling {names} for a backup"
            self._in(timedelta(0), lambda: self._event(
                "supplier", "rule", "One committed, so keep a backup warm",
                "A commitment isn't a delivery. Policy is to keep one more qualified supplier without asking "
                f"it to commit. Calling the next {len(to_dial)} by distance."), "backup note", call=False)
        else:
            self.next_check["supplier"] = f"calling the top {len(to_dial)}"

    async def _suppliers_exhausted(self) -> None:
        if self._committed_supplier() or self._best_backup() or self._blocked("supplier"):
            return
        tx: list[Transition] = []
        ghosted = [sid for sid in self._ranked if self.suppliers[sid].state == "GHOSTED"]
        if ghosted:
            self._sup_move(ghosted[-1], "ESC_EXHAUSTED", tx)
        tried = ", ".join(f"{self._name(s)}: {self.suppliers[s].reason or self.suppliers[s].state}"
                          for s in self._ranked)
        await self._escalate("SUPPLIERS_EXHAUSTED", "supplier", tx, title="No supplier left",
                             detail="Every candidate is terminal and none committed, so SUPPLIERS_EXHAUSTED.",
                             context=[tried])

    async def _supplier_dial(self, sid: str) -> None:
        """Scouting call (supplier_screen). No PHI (D3)."""
        s = self.suppliers[sid]
        if s.state not in ("NOT_CONTACTED", "NO_ANSWER", "CALLING") or self._blocked("supplier"):
            self._pending_dials.discard(sid)
            return
        tx: list[Transition] = []
        if s.state != "CALLING":
            self._sup_move(sid, "CALLING", tx)
        self._first_try.setdefault(sid, self._clock.now)
        committed = self._committed_supplier()
        brief = (f"Scouting call to {s.supplier.name}. A Medicare Part B patient in ZIP "
                 f"{self.patient.zip or '60614'} needs a standard manual wheelchair, HCPCS K0001, rental. "
                 "Do not name the patient (D3). Ask: taking new Medicare patients, accepting assignment for "
                 "every rental month, K0001 in stock (else restock days), delivers to the ZIP, business days "
                 "from order to delivery. "
                 + ("We already have a supplier; ask only whether they could take it, without asking them to "
                    "commit." if committed else "If everything checks out, ask whether they'll take the referral."))
        rec = await self._call("supplier_screen", "supplier", "supplier", sid, s.supplier.name, brief,
                               may_disclose=[])
        self._merge_facts(sid, rec)
        await self._after_screen(sid, rec, tx)
        self._pending_dials.discard(sid)
        self._pump()

    async def _after_screen(self, sid: str, rec: CallRecord, tx: list[Transition]) -> None:
        s = self.suppliers[sid]
        name = s.supplier.name
        if not self._reached(rec):
            s.misses += 1
            self._sup_move(sid, "NO_ANSWER", tx)
            if s.misses > MAX_RETRIES:
                self._sup_move(sid, "UNREACHABLE", tx)
                s.reason = "UNREACHABLE"
                await self._event("supplier", "call", f"{name} is unreachable",
                                  f"{s.misses} unanswered calls (the first plus {MAX_RETRIES} retries), "
                                  "so UNREACHABLE.", tx, call_id=rec.id)
                return
            when = self._retry_at(self._first_try[sid], s.misses)
            await self._event("supplier", "call", f"{name} doesn't answer",
                              f"NO_ANSWER (miss {s.misses}). Retry {fmt_time(when)} (§10: +4h, +1 bd, +2 bd).",
                              tx, call_id=rec.id)
            self._at(when, lambda: self._supplier_dial(sid), f"retry {sid}")
            return

        await self._evaluate_screen(sid, tx, rec.id)

    async def _evaluate_screen(self, sid: str, tx: list[Transition], call_id: str | None) -> None:
        """§5 rules over every known fact for this supplier (calls + advocate-set facts)."""
        s = self.suppliers[sid]
        name = s.supplier.name
        q = rules.qualify_supplier(s.facts)
        if q.verdict == "DISQUALIFIED":
            self._sup_move(sid, "DISQUALIFIED", tx)
            s.reason = q.reason
            await self._event("supplier", "call", f"{name}: disqualified ({q.reason})", q.explanation, tx,
                              call_id=call_id)
            return
        if q.verdict == "NEEDS_CLARIFICATION":
            key = f"{sid}:screen"
            if key not in self._clarified:
                self._clarified.add(key)
                await self._event("supplier", "call", f"{name}: answers unclear",
                                  q.explanation + " One clarifying call (§10).", tx, call_id=call_id)
                self._in(timedelta(hours=1), lambda: self._supplier_dial(sid), f"clarify {sid}")
                return
            self._sup_move(sid, "ESC_AMBIGUOUS", tx)
            await self._ambiguous("supplier", list(q.missing), call_id, tx, kind="supplier_screen", sid=sid)
            return

        self._sup_move(sid, "QUALIFIED", tx)
        detail = q.explanation
        if self._committed_supplier() is None and not self._named_to_patient \
                and self._f(s.facts, "accepts_referral") is True:
            self._sup_move(sid, "COMMITTED", tx)
            due = self._on_commit(sid)
            detail += (f" It took the referral ({self._quote(s.facts, 'accepts_referral')}), so COMMITTED. "
                       f"Reconfirm if the order isn't ready by {fmt_day(due)}.")
            sent = await self._send_order_if_ready(sid, tx, announce=False)
            if sent:
                detail += " The validated order goes to it now (D3, D5)."
            title = f"{name} qualifies and takes the referral"
        elif self._committed_supplier() is not None:
            detail += " Kept as the warm backup. It isn't asked to commit."
            title = f"{name} qualifies as the backup"
        else:
            title = f"{name} qualifies"
        await self._event("supplier", "call", title, detail, tx, call_id=call_id)

    def _on_commit(self, sid: str) -> datetime:
        """§10: reconfirm a commitment if the order isn't ready in 5 business days."""
        due = cal.call_slot(cal.add_business_days(self._clock.now, RECONFIRM_BUSINESS_DAYS))
        self.next_check["supplier"] = f"reconfirm {self._name(sid)} by {fmt_day(due)}"
        self._at(due, lambda: self._reconfirm_commitment(sid), f"reconfirm {sid}")
        return due

    async def _reconfirm_commitment(self, sid: str) -> None:
        s = self.suppliers[sid]
        if s.state != "COMMITTED" or self._order_supplier == sid:
            return
        rec = await self._call("supplier_reconfirm", "supplier", "supplier", sid, s.supplier.name,
                               f"Reconfirm with {s.supplier.name} that they can still take the K0001 referral "
                               "for a Part B patient in our care; the signed order is still in progress. "
                               "No patient details (D3).", may_disclose=[])
        self._merge_facts(sid, rec)
        tx: list[Transition] = []
        if self._reached(rec) and self._f(rec, "still_available") is False:
            self._sup_move(sid, "DISQUALIFIED", tx)
            s.reason = "NOT_ACCEPTING"
            await self._event("supplier", "call", f"{s.supplier.name} drops the referral",
                              "Reconfirm failed, so DISQUALIFIED. The search resumes.", tx, call_id=rec.id)
            self._pump()
            return
        due = self._on_commit(sid)
        await self._event("supplier", "call", f"{s.supplier.name} still holds the referral",
                          f"Reconfirmed. Next check by {fmt_day(due)}.", tx, call_id=rec.id)

    async def _ask_to_commit(self, sid: str) -> None:
        """A qualified supplier is asked to take the referral (D10 consent first if switching)."""
        s = self.suppliers[sid]
        if s.state != "QUALIFIED" or self._committed_supplier():
            return
        consented = self._consented == sid
        rec = await self._call("supplier_reconfirm", "supplier", "supplier", sid, s.supplier.name,
                               f"Ask {s.supplier.name} to take the K0001 referral and give its earliest delivery "
                               "day." + ("" if consented else " Do not name the patient (D3)."),
                               may_disclose=["patient name", "MBI"] if consented else [])
        self._merge_facts(sid, rec)
        tx: list[Transition] = []
        if self._reached(rec) and self._f(rec, "accepts_referral") is True:
            self._sup_move(sid, "COMMITTED", tx)
            self._on_commit(sid)
            await self._send_order_if_ready(sid, tx, announce=False)
            self._refresh_case(tx)
            await self._event("supplier", "call", f"{s.supplier.name} takes the referral",
                              f"{self._quote(rec, 'accepts_referral')}, so COMMITTED.", tx, call_id=rec.id)
            return
        if self._reached(rec) and self._f(rec, "still_available") is False:
            self._drop_backup(sid, tx)
        await self._event("supplier", "call", f"{s.supplier.name} doesn't take the referral",
                          "No quoted acceptance. Looking further down the list.", tx, call_id=rec.id)
        self._pump()

    async def _supplier_confirm(self, sid: str, attempt: int = 1) -> None:
        """After the order + MBI are sent: has the order, eligibility clean, date set (§5)."""
        s = self.suppliers[sid]
        if s.state != "COMMITTED" or self._order_supplier != sid or self.order_state != "SENT_TO_SUPPLIER":
            return
        rec = await self._call("supplier_confirm", "supplier", "supplier", sid, s.supplier.name,
                               f"Confirm {s.supplier.name} received {self.patient.name}'s signed order, MBI and "
                               "visit note; ask whether their eligibility check is clean (no same/similar "
                               "wheelchair, right plan), whether the notes support coverage, and the delivery "
                               "day and window.",
                               may_disclose=["patient name", "MBI", "order", "visit note"])
        self._merge_facts(sid, rec)
        tx: list[Transition] = []
        name = s.supplier.name
        if not self._reached(rec):
            if attempt > MAX_RETRIES:
                self._sup_move(sid, "DISQUALIFIED", tx)
                s.reason = "UNREACHABLE"
                await self._event("supplier", "call", f"{name} stops answering",
                                  "The committed supplier missed every retry, so DISQUALIFIED.", tx,
                                  call_id=rec.id)
                self._pump()
                return
            when = self._retry_at(self._clock.now, attempt)
            await self._event("supplier", "call", f"{name} doesn't answer", f"Retry {fmt_time(when)}.",
                              call_id=rec.id)
            self._at(when, lambda: self._supplier_confirm(sid, attempt + 1), f"confirm retry {sid}")
            return
        await self._evaluate_confirm(sid, rec.id)

    async def _evaluate_confirm(self, sid: str, call_id: str | None) -> None:
        """§5 COMMITTED → CONFIRMED: has the order, eligibility clean, date set. Also re-run
        after the advocate sets a fact or overrides an eligibility conflict."""
        s = self.suppliers[sid]
        name = s.supplier.name
        facts = s.facts
        tx: list[Transition] = []
        call_ids = [call_id] if call_id else []
        override = sid in self._eligibility_override
        if self._f(facts, "eligibility_clean") is False and not override:
            self._sup_move(sid, "ESC_ELIGIBILITY", tx)
            await self._escalate("ELIGIBILITY_CONFLICT", "supplier", tx, title="Eligibility conflict",
                                 detail=f"The supplier's check isn't clean: {self._quote(facts, 'eligibility_clean')}. "
                                        "Break-in-need facts (F11) can't be verified by phone, so "
                                        "ELIGIBILITY_CONFLICT.", call_ids=call_ids, sid=sid)
            return
        if self._f(facts, "docs_sufficient") is False:
            self._move("order", "order", "ESC_DOCS", tx)
            await self._escalate("DOCS_INSUFFICIENT", "order", tx, title="Supplier rejects the notes",
                                 detail=f"The supplier says the documentation is short "
                                        f"({self._quote(facts, 'docs_sufficient')}) after the addendum loop, so "
                                        "DOCS_INSUFFICIENT. A clinician must document; the AI never drafts.",
                                 call_ids=call_ids, sid=sid)
            return
        needed = ["order_received", "docs_sufficient", "delivery_date"] + ([] if override else ["eligibility_clean"])
        missing = [k for k in needed if self._f(facts, k) in (None, False)]
        window = cal.parse_window(str(self._f(facts, "delivery_date")), self._clock.now) \
            if "delivery_date" not in missing else None
        if missing or window is None:
            missing = missing or ["delivery_date"]
            key = f"{sid}:confirm"
            if key not in self._clarified:
                self._clarified.add(key)
                await self._event("supplier", "call", f"{name}: confirmation incomplete",
                                  f"No verified quote for {', '.join(missing)}. One clarifying call (§10).",
                                  call_id=call_id)
                self._in(timedelta(hours=1), lambda: self._supplier_confirm(sid), f"clarify confirm {sid}")
            else:
                await self._ambiguous("supplier", missing, call_id, kind="supplier_confirm", sid=sid)
            return

        self._sup_move(sid, "CONFIRMED", tx)
        self._move("order", "order", "DOCS_OK", tx)
        self._promised[sid] = window
        self._promised_text[sid] = str(self._f(facts, "delivery_date"))
        ghost_at = cal.end_of_business_day(cal.add_business_days(window[1], 1))
        self._at(ghost_at, lambda: self._ghost_check(sid), f"ghost check {sid}")
        self._refresh_case(tx)
        self.next_check["supplier"] = f"delivery {self._promised_text[sid]}"
        self.next_check["order"] = "done"
        eligibility = ("is overridden by the care advocate (new rental period justified)" if override
                       else f"is clean {self._quote(facts, 'eligibility_clean')}")
        detail = (f"Supplier CONFIRMED: it has the order {self._quote(facts, 'order_received')}, eligibility "
                  f"{eligibility}, and a date is set {self._quote(facts, 'delivery_date')}. Order DOCS_OK.")
        if self.case_state == "DELIVERY_SCHEDULED":
            detail += " Her window was already approved, so the join fires: DELIVERY_SCHEDULED."
        elif self.case_state == "HANDOFF_READY":
            detail += " Two of three join inputs are ready. Next, Eleanor must approve the supplier and window (D10)."
        await self._event("supplier", "call", f"{name} confirms", detail, tx, call_id=call_id)
        if self.case_state == "HANDOFF_READY" and self.patient_state == "INFORMED":
            self._propose(sid, self._promised_text[sid], timedelta(minutes=20))

    def _schedule_delivery_checks(self, sid: str) -> None:
        """After the agreed window: post-delivery call to her (§7), then POD from the supplier."""
        ends = [w[1] for w in (self._promised.get(sid), self._patient_window) if w]
        after = max(ends) + timedelta(minutes=30)
        if (sid, after) in self._delivery_checks:   # the join can re-fire after an escalation
            return
        self._delivery_checks.add((sid, after))
        self.next_check["patient"] = f"post-delivery check {fmt_time(cal.call_slot(after))}"
        self._at(cal.call_slot(after), lambda: self._patient_delivery_check(sid), "post-delivery check")


    async def _supplier_delivery_check(self, sid: str) -> None:
        """POD + billed code (D11). Also used to chase a missed delivery."""
        s = self.suppliers[sid]
        if s.state != "CONFIRMED":
            return
        rec = await self._call("supplier_delivery_check", "supplier", "supplier", sid, s.supplier.name,
                               f"Ask {s.supplier.name} whether {self.patient.name}'s wheelchair was delivered, "
                               "whether a delivery ticket was signed, and which HCPCS code they bill. A "
                               "voicemail carries a callback number and an order reference only (D3).",
                               may_disclose=["patient name", "order reference"])
        self._merge_facts(sid, rec)
        name = s.supplier.name
        if not self._reached(rec):
            n = self._post_miss_misses[sid] = self._post_miss_misses.get(sid, 0) + 1
            title = "Voicemail" if rec.outcome == "voicemail" else f"{name} doesn't answer"
            if self._patient_said_delivered:
                # She has the chair; only the paperwork is missing. A supplier that delivered
                # isn't a ghost, so keep chasing the proof of delivery each business day, then
                # hand it to a person (D11).
                if n < POD_CHASES:
                    when = cal.call_slot(cal.add_business_days(self._clock.now, 1))  # type: ignore[arg-type]
                    await self._event("supplier", "call", title,
                                      f"Eleanor already has the chair, so this isn't a no-show: only the proof of "
                                      f"delivery is missing. Retry {fmt_time(when)} (attempt {n} of {POD_CHASES}).",
                                      call_id=rec.id)
                    self._at(when, lambda: self._supplier_delivery_check(sid), f"retry POD {sid}")
                else:
                    await self._event("supplier", "call", title,
                                      f"{POD_CHASES} tries and no proof of delivery. A person chases the signed "
                                      "delivery ticket (D11).", call_id=rec.id)
                    await self._ambiguous("supplier", ["delivered"], rec.id, kind="pod_mismatch", sid=sid)
                return
            if n == 1:
                when = cal.call_slot(self._clock.now + RETRY_DELAYS[0])  # type: ignore[operator]
                await self._event("supplier", "call", title, f"No answer. Retry {fmt_time(when)}.", call_id=rec.id)
                self._at(when, lambda: self._supplier_delivery_check(sid), f"retry POD {sid}")
            else:
                await self._event("supplier", "call", title,
                                  f"Miss {n} since the promised date. Any voicemail has a callback number and an "
                                  "order reference, and no health details (D3).", call_id=rec.id)
                backup = self._best_backup()
                if backup and self._patient_said_delivered is False:
                    self._in(timedelta(hours=1), lambda: self._hedge_backup(backup, sid), f"hedge {backup}")
            return

        pod, says_delivered = self._f(rec, "proof_of_delivery"), self._f(rec, "delivered")
        if pod is True and self._patient_said_delivered:
            await self._complete_delivery(sid, rec.id)
            return
        if (pod is True or says_delivered is True) and not self._patient_said_delivered:
            await self._ambiguous("supplier", ["delivered"], rec.id, kind="pod_mismatch", sid=sid)
            return
        await self._event("supplier", "call", f"{name} hasn't delivered",
                          "No proof of delivery. The ghost threshold still stands.", call_id=rec.id)

    async def _complete_delivery(self, sid: str, call_id: str | None) -> None:
        """D11: POD and her confirmation agree → DELIVERED; billed code = order → CLOSED."""
        s = self.suppliers[sid]
        tx: list[Transition] = []
        self._sup_move(sid, "DELIVERED", tx)
        if self.case_state == "DELIVERY_SCHEDULED":
            self._move("case", "case", "DELIVERED", tx)
        billed = str(self._f(s.facts, "billed_hcpcs") or "").upper()
        self.next_check["supplier"] = "done"
        if rules.REQUIRED_HCPCS in billed:
            await self._event("supplier", "call", "Proof of delivery and billing code",
                              f"Proof of delivery {self._quote(s.facts, 'proof_of_delivery')} and her account agree "
                              f"(D11). The billed code {self._quote(s.facts, 'billed_hcpcs')} matches the validated "
                              "order. DELIVERED.", tx, call_id=call_id)
            if self.case_state == "DELIVERED":
                await self._close_case([], "The billed code matches the order.")
            return
        await self._event("supplier", "call", "Delivered, but the billed code is off",
                          f"Billed {billed or 'unknown'} vs. ordered K0001.", tx, call_id=call_id)
        await self._ambiguous("supplier", ["billed_hcpcs"], call_id, kind="billing", sid=sid)

    def _drop_backup(self, sid: str, tx: list[Transition]) -> None:
        """A qualified backup says it can no longer take the referral."""
        self._sup_move(sid, "DISQUALIFIED", tx)
        self.suppliers[sid].reason = "NOT_ACCEPTING"

    async def _hedge_backup(self, bid: str, failing: str) -> None:
        """§11: the committed supplier missed and isn't answering, so check the backup
        before the ghost threshold. Her name isn't shared (D3)."""
        b = self.suppliers[bid]
        if b.state != "QUALIFIED" or self.suppliers[failing].state != "CONFIRMED":
            return
        rec = await self._call("supplier_reconfirm", "supplier", "supplier", bid, b.supplier.name,
                               f"{b.supplier.name} qualified earlier for a K0001 referral for a Part B patient in "
                               f"{self.patient.zip or '60614'}. Ask whether they could still take it this week, "
                               "their earliest delivery day, and whether they'd take it if we send the order. "
                               "Do not name the patient (D3).", may_disclose=[])
        self._merge_facts(bid, rec)
        tx: list[Transition] = []
        if self._reached(rec) and self._f(rec, "still_available") is False:
            self._drop_backup(bid, tx)
        ghost = cal.end_of_business_day(cal.add_business_days(self._promised[failing][1], 1))
        self.next_check["supplier"] = f"ghost threshold {fmt_time(ghost)}"
        await self._event("supplier", "call", "Hedge: check the backup before the ghost threshold",
                          f"{self._name(failing)} missed and isn't answering, so the backup is checked before the "
                          f"threshold. Earliest: {self._quote(rec, 'earliest_delivery')}. Her name isn't shared. "
                          f"{b.supplier.name} is {b.state}.", tx, call_id=rec.id)

    async def _ghost_check(self, sid: str) -> None:
        """§5: promised date +1 business day with no delivery → GHOSTED → next candidate."""
        s = self.suppliers[sid]
        if s.state != "CONFIRMED" or self._patient_said_delivered:
            return  # she has the chair: a missing proof of delivery is chased, not ghosted
        tx: list[Transition] = []
        self._sup_move(sid, "GHOSTED", tx)
        s.reason = "GHOSTED"
        if self.patient_state == "WINDOW_CONFIRMED":
            self._move("patient", "patient", "INFORMED", tx)
        self._consented = None
        self._patient_window = None
        self._refresh_case(tx)
        backup = self._best_backup()
        detail = (f"Promised date +1 business day, no delivery, so GHOSTED. The case drops back to "
                  f"{self.case_state}. ")
        if backup:
            detail += (f"{self._name(backup)} is next, but Eleanor has to approve the switch before her details "
                       "go anywhere (D3, D10). The validated order is reused, with no new request to the doctor "
                       "(D5).")
            self.next_check["supplier"] = f"{self._name(backup)}, after Eleanor approves"
        await self._event("supplier", "timer", f"{s.supplier.name} marked GHOSTED", detail, tx)
        await self._withdraw(sid)
        if backup:
            self._propose(backup, self._window_for(backup), timedelta(minutes=10), urgent=True)
        else:
            self._pump()


    async def _withdraw(self, sid: str) -> None:
        """Close the loop with a no-show: in writing, don't deliver and don't bill her.
        They already hold her order, so this shares nothing new (D3)."""
        name = self._name(sid)
        self._withdrawn[sid] = self._clock.now
        doc = await self._send_fax(
            name,
            f"To: {name}\nRe: wheelchair referral for {self.patient.name} (HCPCS {self.patient.hcpcs})\n\n"
            "This referral is withdrawn because the promised delivery didn't happen and we couldn't reach you. "
            "Please don't deliver, and don't submit a claim to Medicare or bill the patient for this order. "
            "Call the care team if a chair was in fact delivered.",
            thread="supplier")
        await self._event("supplier", "fax", f"Referral withdrawn from {name}",
                          "Told in writing not to deliver or bill her. Medicare pays a supplier only with a signed "
                          "delivery ticket, so she can't be billed twice; this makes that explicit. If they "
                          "answer that they did deliver, a person reviews it (D11).", fax_id=doc.id)

    def _supplier_by_ref(self, ref: str | None) -> str | None:
        """Accept a supplier id or (part of) its name, as typed by the advocate."""
        if not ref:
            return None
        r = ref.strip().lower()
        if r in self.suppliers:
            return r
        return next((sid for sid, s in self.suppliers.items()
                     if s.supplier.name.lower() == r or r in s.supplier.name.lower()), None)

