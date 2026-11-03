"""Order thread (spec §6): request, acknowledge, validate, correct, send to the supplier."""

from __future__ import annotations

from datetime import datetime, timedelta

from dme.contract import (
    ORDER_DOC_FACTS, FaxDocument, Transition,
)
from dme.engine import calendar as cal
from dme.engine import rules
from dme.engine.policy import (  # §10 timer values
    ENGINE_FAX, ACK_BUSINESS_DAYS, SIGNATURE_BUSINESS_DAYS, MAX_NUDGES, POLL_EVERY, WAITING_FOR_FAX,
    fmt_day, fmt_time,
)


class OrderThread:
    """Engine mixin for the order thread."""

    def _order_request_text(self, correction: list[str] | None = None) -> str:
        p = self.patient
        head = "CORRECTION REQUEST" if correction else "ORDER REQUEST"
        lines = [f"{head} — to: {p.pcp_practice}" + (f", attn {self._office_owner}" if self._office_owner else ""),
                 f"From: care team for {p.name}. Reply fax: {ENGINE_FAX}.", ""]
        if correction:
            lines += ["Please review and re-sign:"] + [f"- {c}" for c in correction] + [
                "", "The coverage checklist (CGS, LCD L33788) is attached again. If the doctor assessed these at "
                "the visit, an addendum would cover it. We don't draft clinical text."]
            return "\n".join(lines)
        lines += ["PREFILLED STANDARD WRITTEN ORDER — for practitioner review and signature (D4)",
                  f"Patient: {p.name}   MBI: {p.mbi or '(on file at the practice)'}",
                  f"Item: Standard wheelchair   HCPCS: {rules.REQUIRED_HCPCS}   Qty: 1",
                  f"Ordering provider: {p.pcp_name}",
                  "Date: ________   Signature: ________________", "",
                  f"Please also send the visit note from {p.visit_date}.",
                  "Attached: public CGS coverage checklist for manual wheelchairs (criteria A–E plus F or G)."]
        return "\n".join(lines)

    async def _fax_request(self, text: str) -> FaxDocument:
        doc = await self._send_fax(self._office_fax, text)
        await self._fax_desk.receive_request(doc)
        return doc

    async def _order_request(self) -> None:
        if self.order_state != "VERBAL_IN_CHART":
            return
        doc = await self._fax_request(self._order_request_text())
        tx: list[Transition] = []
        self._move("order", "order", "REQUESTED", tx)
        due = self._arm_ack_timer()
        self.next_check["order"] = f"acknowledgment due {fmt_time(due)}"
        await self._event("order", "fax", "Request the order, checklist attached",
                          f"Faxed a prefilled order to {self._office_fax} for {self.patient.pcp_name} to review and "
                          "sign: K0001, quantity 1, her name and MBI (D4). Attached the public coverage checklist "
                          "and asked for the visit note. No supplier is committed yet, so the order comes back to "
                          "the engine (D5). Acknowledgment is due in 1 business day.", tx, fax_id=doc.id)
        self._start_polling()

    def _arm_ack_timer(self) -> datetime:
        self._request_gen += 1
        gen = self._request_gen
        due = cal.add_business_days(self._clock.now, ACK_BUSINESS_DAYS)
        self._at(due, lambda: self._ack_check(gen), "ack check")
        return due

    async def _ack_check(self, gen: int) -> None:
        if self.order_state != "REQUESTED" or gen != self._request_gen:
            return
        await self._nudge("No acknowledgment from the office",
                          "The 1-business-day acknowledgment deadline passed. NUDGE: call the front desk and "
                          "confirm the request actually landed.")

    async def _signature_check(self, gen: int) -> None:
        if self.order_state != "ACKNOWLEDGED" or gen != self._request_gen:
            return
        await self._nudge("Order still unsigned", "3 business days since the office acknowledged, still unsigned. "
                                                  "NUDGE: call the owner.")

    async def _nudge(self, title: str, detail: str) -> None:
        tx: list[Transition] = []
        self._move("order", "order", "NUDGE", tx)
        self._nudges += 1
        if self._nudges > MAX_NUDGES:
            self._move("order", "order", "ESC_UNSIGNED", tx)
            await self._escalate("ORDER_UNSIGNED", "order", tx, title="Order still unsigned after 3 nudges",
                                 detail="3 nudges and still unsigned, so ORDER_UNSIGNED. A relationship call to "
                                        "the practice is a person's job.")
            return
        self.next_check["order"] = "calling the front desk"
        await self._event("order", "timer", title, f"{detail} (nudge {self._nudges} of {MAX_NUDGES})", tx)
        self._in(timedelta(minutes=2), self._office_followup, "office follow-up")

    async def _office_followup(self, attempt: int = 1) -> None:
        if self.order_state not in ("NUDGE", "REQUESTED"):
            return
        who = self._office_owner or "the front desk"
        rec = await self._call(
            "office_followup", "order", "office", "office", f"{self.patient.pcp_practice} ({who})",
            f"Call {self.patient.pcp_practice}, {who}. We faxed a wheelchair order for {self.patient.pcp_name} to "
            f"sign, last sent to {self._office_fax}. Confirm they have it and who owns it. If not, ask for the "
            "right fax number.", may_disclose=["patient name", "order"])
        tx: list[Transition] = []
        if not self._reached(rec):
            when = cal.call_slot(self._clock.now + timedelta(hours=1))
            await self._event("order", "call", "Office doesn't pick up", f"Retry {fmt_time(when)}.", call_id=rec.id)
            self._at(when, lambda: self._office_followup(attempt + 1), "office follow-up retry")
            return
        if owner := self._f(rec, "owner_name"):
            self._office_owner = str(owner)
        if self._f(rec, "request_received") is True:
            if self.order_state == "NUDGE":
                self._move("order", "order", "REQUESTED", tx)
            self._move("order", "order", "ACKNOWLEDGED", tx)
            self._request_gen += 1
            gen = self._request_gen
            due = cal.add_business_days(self._clock.now, SIGNATURE_BUSINESS_DAYS)
            self._at(due, lambda: self._signature_check(gen), "signature check")
            self.next_check["order"] = f"signature due {fmt_day(due)}"
            await self._event("order", "call", f"{self._office_owner or 'The office'} confirms receipt",
                              f"{self._quote(rec, 'request_received')}: ACKNOWLEDGED"
                              + (f", with a named owner ({self._office_owner})" if self._office_owner else "")
                              + f". Signature is due {fmt_day(due)} (3 business days).", tx, call_id=rec.id)
            return
        new_fax = self._f(rec, "correct_fax")
        detail = f"{self._quote(rec, 'request_received')}. "
        changed = bool(new_fax and str(new_fax) != self._office_fax)
        if changed:
            detail += (f"The fax on file was outdated ({self._quote(rec, 'correct_fax')}). Resent to "
                       f"{new_fax}" + (f", addressed to {self._office_owner}" if self._office_owner else "")
                       + ". Back to REQUESTED.")
            self._office_fax = str(new_fax)
            title = '"We never got it"'
        else:
            detail += ("Resent on the same channel. Back to REQUESTED; the 1-business-day acknowledgment "
                       "timer runs again.")
            title = "Office can't find the request"
        doc = await self._fax_request(self._order_request_text())
        self._move("order", "order", "REQUESTED", tx)
        self._arm_ack_timer()
        await self._event("order", "call", title, detail, tx, call_id=rec.id, fax_id=doc.id)
        if changed:   # new channel: confirm it landed; otherwise the ack timer nudges again
            self.next_check["order"] = "confirming receipt"
            self._in(timedelta(minutes=30), self._office_followup, "confirm receipt")

    def _start_polling(self) -> None:
        if not self._polling:
            self._polling = True
            self._in(POLL_EVERY, self._poll_inbox, "check fax inbox")

    def _waiting_for_fax(self) -> bool:
        if self._done:
            return False
        return self.order_state in WAITING_FOR_FAX or (
            self._awaiting_new_note and self.order_state == "SENT_TO_SUPPLIER")

    async def _poll_inbox(self) -> None:
        """The office sends the signed order whenever it's ready; the engine checks its
        fax inbox hourly during business hours. Silent unless something arrives."""
        if not self._waiting_for_fax():
            self._polling = False
            return
        text = await self._fax_desk.next_signed_order()
        if text:
            await self._receive_order(text)
        if self._waiting_for_fax():
            self._in(POLL_EVERY, self._poll_inbox, "check fax inbox")
        else:
            self._polling = False

    async def _receive_order(self, text: str) -> None:
        facts = await self._runner.read_document(text, ORDER_DOC_FACTS)
        doc = FaxDocument(id=self._id("fax"), direction="inbound", to=ENGINE_FAX, sent_at=self._clock.now,
                          text=text, facts=facts)
        self.faxes[doc.id] = doc
        await self._emit({"type": "fax", "fax": doc.model_dump(mode="json")})
        if self._awaiting_new_note and self.order_state == "SENT_TO_SUPPLIER":
            await self._receive_new_note(text, doc.id, facts)
            return
        tx: list[Transition] = []
        if self.order_state == "NUDGE":
            self._move("order", "order", "REQUESTED", tx)
        if self.order_state == "REQUESTED":
            self._move("order", "order", "ACKNOWLEDGED", tx)   # a signed order proves someone owns it
        if self.order_state == "ESC_UNSIGNED":
            return
        self._move("order", "order", "RECEIVED", tx)
        v = rules.validate_order(self._with_notes_on_file(facts), self.patient.visit_date)

        if v.passed:
            self._move("order", "order", "VALIDATED", tx)
            self._order_text = self._documents_on_file()
            detail = ("6 of 6 order elements. HCPCS K0001. Quantity 1. Dated on or after the visit. VALIDATED. "
                      "The pre-screen finds no gaps.")
            target = self._committed_supplier()
            if target and await self._send_order_if_ready(target, tx, announce=False):
                detail += (f" {self._name(target)} is committed, so the order, her name and her MBI go to "
                           f"{self._name(target)} only (D3).")
                self.next_check["order"] = "waiting for the supplier's review"
            else:
                self.next_check["order"] = "waiting for a committed supplier"
            self._refresh_case(tx)
            await self._event("order", "fax", "Signed order passes validation", detail, tx, fax_id=doc.id)
            return

        self._last_problems = v.problems
        self._move("order", "order", "CORRECTION_REQUESTED", tx)
        if v.clinical or self._correction_loops >= self._loop_limit:
            self._move("order", "order", "ESC_CLINICAL", tx)
            why = (" ".join(v.clinical) if v.clinical else
                   f"Still failing after {self._loop_limit} correction loops: " + " ".join(v.problems))
            await self._escalate("ORDER_NEEDS_CLINICAL_FIX", "order", tx, title="Order needs the doctor's call",
                                 detail=f"{why} Choosing equipment is the doctor's call, so ORDER_NEEDS_CLINICAL_FIX.",
                                 context=v.problems)
            return
        self._correction_loops += 1
        detail = "Validator: " + " ".join(v.clerical) if v.clerical else "Validator: the order elements pass."
        if v.clerical and not v.clinical:
            detail += " The description agrees with a standard chair, so it's a clerical error, not a clinical one."
        if v.gaps:
            detail += " Pre-screen: no sentence addresses criterion " + "; ".join(v.gaps) + "."
        detail += f" CORRECTION_REQUESTED, loop {self._correction_loops} of {self._loop_limit}."
        self.next_check["order"] = f"calling {self._office_owner or 'the office'}"
        await self._event("order", "fax", "Signed order needs a correction", detail, tx, fax_id=doc.id)
        self._in(timedelta(minutes=5), lambda: self._office_correction(v.problems), "office correction call")

    async def _office_correction(self, problems: list[str], attempt: int = 1) -> None:
        if self.order_state != "CORRECTION_REQUESTED":
            return
        doc = await self._fax_request(self._order_request_text(correction=problems)) if attempt == 1 else None
        who = self._office_owner or "the front desk"
        rec = await self._call(
            "office_correction", "order", "office", "office", f"{self.patient.pcp_practice} ({who})",
            f"Call {who} about {self.patient.name}'s signed order. Name each problem exactly as given. For "
            "documentation gaps, name the checklist criteria and ask whether the doctor assessed them; an "
            "addendum would cover it. Never suggest clinical wording (D8).",
            may_disclose=["patient name", "order"], must_say=problems)
        tx: list[Transition] = []
        if not self._reached(rec):
            when = cal.call_slot(self._clock.now + timedelta(hours=1))
            await self._event("order", "call", "Office doesn't pick up", f"Retry {fmt_time(when)}.", call_id=rec.id)
            self._at(when, lambda: self._office_correction(problems, attempt + 1), "office correction retry")
            return
        if self._f(rec, "clinical_disagreement") is True:
            self._move("order", "order", "ESC_CLINICAL", tx)
            await self._escalate("ORDER_NEEDS_CLINICAL_FIX", "order", tx, title="The doctor intends a different chair",
                                 detail=f"{self._quote(rec, 'clinical_disagreement')}. Code and note disagree on the "
                                        "chair, so ORDER_NEEDS_CLINICAL_FIX.", call_ids=[rec.id])
            return
        due = cal.add_business_days(self._clock.now, SIGNATURE_BUSINESS_DAYS)
        loop = self._correction_loops
        self._at(due, lambda: self._correction_check(loop, problems), "correction check")
        self.next_check["order"] = f"corrected order due by {fmt_day(due)}"
        accepted = self._f(rec, "correction_accepted")
        await self._event("order", "call", "Ask for a corrected code and the missing criteria",
                          (f"The fix is accepted {self._quote(rec, 'correction_accepted')}. " if accepted else
                           "No quoted acceptance; the request stands. ")
                          + "Documentation questions go to the clinician. The engine named the criteria and "
                            "stopped there. It wrote no clinical text (D8).",
                          tx, call_id=rec.id, fax_id=doc.id if doc else None)
        self._start_polling()

    async def _correction_check(self, loop: int, problems: list[str]) -> None:
        """The office went quiet after a correction request. The table has no NUDGE edge
        out of CORRECTION_REQUESTED, so the engine re-calls without a state change and,
        after 3 nudges, escalates ORDER_UNSIGNED on the order thread."""
        if self.order_state != "CORRECTION_REQUESTED" or loop != self._correction_loops:
            return
        self._nudges += 1
        if self._nudges > MAX_NUDGES:
            await self._escalate("ORDER_UNSIGNED", "order", [], title="Corrected order never came back",
                                 detail=f"{MAX_NUDGES} nudges and the corrected order hasn't arrived, so "
                                        "ORDER_UNSIGNED. A relationship call to the practice is a person's job.")
            return
        await self._event("order", "timer", "Corrected order is overdue",
                          f"3 business days since the correction request (nudge {self._nudges} of {MAX_NUDGES}). "
                          "Calling the office again.")
        self._in(timedelta(minutes=2), lambda: self._office_correction(problems, attempt=2), "correction nudge")

    async def _send_order_if_ready(self, sid: str, tx: list[Transition], announce: bool = True) -> bool:
        """Send the validated order to `sid` if D3 allows: it must be the committed
        supplier, and once any supplier has been named to her, she must have approved
        this one (D10). Returns True if sent."""
        if self.order_state not in ("VALIDATED", "DOCS_OK") or self._order_text is None:
            return False
        if self.suppliers[sid].state != "COMMITTED" or self._order_supplier == sid:
            return False
        if self._named_to_patient and self._consented != sid:
            return False
        doc = await self._send_fax(f"{self._name(sid)} {self.suppliers[sid].supplier.phone}",
                                   f"Signed order + visit note + MBI for {self.patient.name} "
                                   f"(MBI {self.patient.mbi}).\n\n{self._order_text}")
        self._move("order", "order", "SENT_TO_SUPPLIER", tx)
        self._order_supplier = sid
        self.next_check["order"] = f"waiting for {self._name(sid)}'s review"
        self._in(timedelta(minutes=25), lambda: self._supplier_confirm(sid), f"confirm {sid}")
        if announce:
            await self._event("order", "fax", f"Order sent to {self._name(sid)}", "D3: committed supplier only.",
                              tx, fax_id=doc.id)
        return True

    def _with_notes_on_file(self, facts: dict) -> dict:
        """D8: the supplier gets every document the office sent (original note + any
        addendum), so a criterion documented in an earlier note still counts. Order
        fields (code, signature, date) come only from the newest document."""
        merged = dict(facts)
        for prev in self.faxes.values():
            if prev.direction != "inbound":
                continue
            for key, fact in prev.facts.items():
                if key.startswith("crit_") and rules.known(prev.facts, key) is True \
                        and rules.known(merged, key) is not True:
                    merged[key] = fact
        return merged

    def _documents_on_file(self) -> str:
        """Everything the office sent, newest first: what the supplier receives."""
        inbound = [f.text for f in self.faxes.values() if f.direction == "inbound"]
        return "\n\n----- earlier document -----\n\n".join(reversed(inbound))

    async def _receive_new_note(self, text: str, fax_id: str, facts: dict) -> None:
        """After DOCS_INSUFFICIENT → "re-visit booked": the new note/order goes to the
        same supplier for re-review. SENT_TO_SUPPLIER has no edge back to RECEIVED, so
        the validator runs without a state change."""
        v = rules.validate_order(self._with_notes_on_file(facts), self.patient.visit_date)
        sid = self._order_supplier
        if not v.passed or sid is None:
            await self._event("order", "fax", "New documentation still has problems",
                              "Validator: " + " ".join(v.problems) + " Asking the office again.", fax_id=fax_id)
            await self._fax_request(self._order_request_text(correction=v.problems))
            return
        self._awaiting_new_note = False
        self._order_text = self._documents_on_file()
        doc = await self._send_fax(f"{self._name(sid)} {self.suppliers[sid].supplier.phone}",
                                   f"Updated documentation for {self.patient.name} (MBI {self.patient.mbi}).\n\n{text}")
        self._clarified.discard(f"{sid}:confirm")
        self._in(timedelta(minutes=25), lambda: self._supplier_confirm(sid), f"confirm {sid}")
        self.next_check["order"] = f"waiting for {self._name(sid)}'s re-review"
        await self._event("order", "fax", f"New documentation sent to {self._name(sid)}",
                          "The new note passes the validator and pre-screen. Sent to the supplier for re-review.",
                          fax_id=doc.id)
