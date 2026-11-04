"""Escalations (spec §8): raise a packet, ask the advocate, apply the typed decision.

Every option in rules.DECISIONS maps to one action here, so the engine always knows
where to resume. An answer that matches no option is treated as the first option, and
the timeline says so. close / pause (outside the patient cost flow) / transfer /
new code end the case: ABANDONED, reached through BLOCKED_ON_HUMAN.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from dme.contract import CallRecord, DirectorySupplier, Escalation, EscalationCode, Fact, SupplierStatus, ThreadName, Transition
from dme.engine import calendar as cal
from dme.engine import rules
from dme.engine.policy import ADVOCATE_TURNAROUND, fmt_day

ADVOCATE_QUOTE = "set by care advocate"

# Actions that end the case, with the reason the timeline gives.
ENDING_ACTIONS = {
    "close": "The case is closed.",
    "pause": "Paused by the care advocate. PAUSED is reserved for an inpatient stay (§4), so the engine "
             "stops working the case (ABANDONED); a person picks it up later.",
    "transfer": "She stays with her prior supplier, which continues the existing rental (F11). The engine's "
                "case ends here.",
    "new_code": "The doctor wants a different chair. This prototype coordinates K0001 only (spec §12), so the "
                "case goes back to the care team.",
}


class EscalationsMixin:
    """Engine mixin. State lives on Engine; see orchestrator.py."""

    # ------------------------------------------------------------ raising

    def _tried(self, thread: ThreadName) -> list[str]:
        return [f"{fmt_day(r.started_at)}: {r.goal.purpose.replace('_', ' ')} with {r.goal.party_name} "
                f"({r.outcome})" for r in self.calls.values() if r.goal.thread == thread]

    async def _escalate(self, code: EscalationCode, thread: ThreadName, tx: list[Transition], *,
                        title: str, detail: str, question: str | None = None,
                        numbers: list[tuple[str, str]] | None = None, context: list[str] | None = None,
                        call_ids: list[str] | None = None, **ctx: Any) -> Escalation:
        packet = rules.escalation_packet(code, thread, question)
        esc = Escalation(id=self._id("esc"), code=code, thread=packet.thread, blocking=packet.blocking,
                         raised_at=self._clock.now, question=packet.question, options=packet.options,
                         numbers=numbers or [], tried=self._tried(thread), context=context or [],
                         call_ids=call_ids or [])
        self.escalations.append(esc)
        self._esc_ctx[esc.id] = ctx
        if esc.blocking:
            self._open_blocking[esc.id] = esc
            self.next_check[thread] = "with a care advocate"
        self._refresh_case(tx)
        await self._event(thread, "escalation", title, detail, tx, escalation_id=esc.id)
        await self._emit({"type": "escalation", "escalation": esc.model_dump(mode="json")})
        decision = asyncio.ensure_future(self._advocate.decide(esc))
        if esc.blocking:
            when = cal.advocate_slot(self._clock.now) + ADVOCATE_TURNAROUND
            self._at(when, lambda: self._apply_decision(esc, decision), f"advocate decides {code}")
        else:
            decision.add_done_callback(lambda t: self._record_decision(esc, t))
        return esc

    async def _ambiguous(self, thread: ThreadName, missing: list[str], call_id: str | None,
                         tx: list[Transition] | None = None, **ctx: Any) -> None:
        if ctx.get("kind") == "billing":
            # The code was heard (and quoted); it just isn't the ordered one. Say that.
            sid = ctx.get("sid")
            billed = self._f(self.suppliers[sid].facts, "billed_hcpcs") if sid else None
            who = self._name(sid) if sid else "The supplier"
            heard = f"{who} says it will bill {billed}" if billed else f"{who} didn't give a billing code"
            await self._escalate(
                "AMBIGUOUS_CALL_OUTCOME", thread, tx if tx is not None else [],
                title="Billing code doesn't match the order",
                detail=f"{heard}, but the validated order is K0001. A wrong code on the claim gets it "
                       "denied and can leave her with the bill, so a person sorts it out before the "
                       "claim goes in (D11).",
                question=f"{heard}; the order is K0001. Call them to correct it, then enter the code "
                         "they'll bill. (fields: billed_hcpcs)",
                call_ids=[call_id] if call_id else [], **ctx)
            return
        await self._escalate(
            "AMBIGUOUS_CALL_OUTCOME", thread, tx if tx is not None else [],
            title="Required fact still unknown",
            detail=f"No verified quote for {', '.join(missing)} after a clarifying call, so "
                   "AMBIGUOUS_CALL_OUTCOME. A person reviews the recording (D12).",
            question=f"What is the value of {', '.join(missing)}? Please review the call. "
                     f"(fields: {', '.join(missing)})",
            call_ids=[call_id] if call_id else [], **ctx)

    async def _raise_safety(self, record: CallRecord) -> None:
        """SAFETY_CONCERN: immediate, non-blocking, never moves a machine."""
        await self._escalate("SAFETY_CONCERN", record.goal.thread, [], title="Safety concern mentioned",
                             detail=f"The {record.goal.party_kind} mentioned a fall, injury or distress: "
                                    f'"{record.safety_flag.quote}". A person checks on her welfare. '  # type: ignore[union-attr]
                                    "Nothing stops (non-blocking).", call_ids=[record.id])

    # ------------------------------------------------------------ deciding

    def _record_decision(self, esc: Escalation, task: asyncio.Future) -> None:
        if task.cancelled() or task.exception() is not None:
            return
        option, note, fields = task.result()
        esc.decision, esc.decision_note, esc.decision_fields = option, note, dict(fields or {})
        esc.resolved_at = self._clock.now

    async def _apply_decision(self, esc: Escalation, task: asyncio.Future) -> None:
        """Typed decision → the action its option maps to (§8 invariant)."""
        option, note, fields = await task
        esc.decision, esc.decision_note, esc.decision_fields = option, note, dict(fields or {})
        esc.resolved_at = self._clock.now
        self._open_blocking.pop(esc.id, None)
        await self._emit({"type": "escalation", "escalation": esc.model_dump(mode="json")})
        opt, defaulted = rules.match_decision(esc.code, option)
        self._esc_ctx[esc.id].update(label=opt.label, defaulted=defaulted)
        if opt.action in ENDING_ACTIONS:
            await self._abandon([], self._decision_detail(esc, ENDING_ACTIONS[opt.action]), esc.thread,
                                escalation_id=esc.id)
            return
        handler = {
            "PATIENT_COST_CONCERN": self._resume_patient,
            "PATIENT_DECLINES": self._resume_patient,
            "PATIENT_UNREACHABLE": self._resume_unreachable,
            "AMBIGUOUS_CALL_OUTCOME": self._resume_ambiguous,
            "SUPPLIERS_EXHAUSTED": self._resume_exhausted,
            "ELIGIBILITY_CONFLICT": self._resume_eligibility,
            "ORDER_UNSIGNED": self._resume_unsigned,
            "ORDER_NEEDS_CLINICAL_FIX": self._resume_clinical,
            "DOCS_INSUFFICIENT": self._resume_docs,
        }[esc.code]
        await handler(esc, opt.action)

    def _decision_title(self, esc: Escalation) -> str:
        ctx = self._esc_ctx[esc.id]
        return f"Care advocate decides: {ctx['label'] if ctx.get('defaulted') else esc.decision}"

    def _decision_detail(self, esc: Escalation, tail: str) -> str:
        ctx = self._esc_ctx[esc.id]
        parts = [f"A typed decision came back on {esc.code}."]
        if ctx.get("defaulted"):
            parts.append(f'"{esc.decision}" isn\'t one of the options, so it is treated as the first option, '
                         f'"{ctx["label"]}".')
        if esc.decision_note:
            parts.append(f"Note: {esc.decision_note}")
        parts.append(tail)
        return " ".join(parts)

    async def _decided(self, esc: Escalation, tail: str, tx: list[Transition]) -> None:
        self._refresh_case(tx)
        await self._event(esc.thread, "human", self._decision_title(esc), self._decision_detail(esc, tail),
                          tx, escalation_id=esc.id)

    def _advocate_facts(self, esc: Escalation) -> dict[str, Fact]:
        return {k: Fact(key=k, value=self._coerce(v), quote=f"{ADVOCATE_QUOTE}: {v}", verified=True)
                for k, v in esc.decision_fields.items()}

    @staticmethod
    def _coerce(v: str):
        low = str(v).strip().lower()
        if low in ("true", "yes"):
            return True
        if low in ("false", "no"):
            return False
        return int(low) if low.isdigit() else v

    # ------------------------------------------------------------ patient (§7)

    async def _resume_patient(self, esc: Escalation, action: str) -> None:
        """ESC_COST / ESC_DECLINES ─proceed─► INFORMED. decision_fields may carry
        supplier_consent (id or name) and window, which record her consent directly."""
        tx: list[Transition] = []
        if self.patient_state in ("ESC_COST", "ESC_DECLINES"):
            self._move("patient", "patient", "INFORMED", tx)
        if action == "pause_30":
            self.next_check["patient"] = "re-propose in 30 days"
            await self._decided(esc, "Paused for 30 days, then the engine asks her again.", tx)
            self._at(cal.call_slot(self._clock.now + timedelta(days=30)), self._repropose, "re-propose")
            return
        sid = self._supplier_by_ref(esc.decision_fields.get("supplier_consent"))
        window_text = esc.decision_fields.get("window")
        window = cal.parse_window(window_text, self._clock.now) if window_text else None
        tail = "The engine resumes the patient thread and asks her again."
        if sid and window:
            self._move("patient", "patient", "WINDOW_CONFIRMED", tx)
            self._consented, self._patient_window, self._patient_window_text = sid, window, window_text
            self._named_to_patient.add(sid)
            tail = (f"Her consent to {self._name(sid)} and the window {window_text} are recorded, "
                    "so the patient thread is WINDOW_CONFIRMED.")
            if action == "proceed_qmb":
                tail += " The QMB outcome is tracked but doesn't block delivery."
            self.next_check["patient"] = "post-delivery check after the window"
        await self._decided(esc, tail, tx)
        if sid and window:
            self._in(timedelta(minutes=5), lambda: self._after_consent(sid), "after consent", call=False)
        else:
            self._in(timedelta(minutes=5), self._repropose, "re-propose")

    async def _resume_unreachable(self, esc: Escalation, action: str) -> None:
        """reached: ESC_UNREACHABLE ─reached─► INFORMED. Fields may carry address and mbi."""
        tx: list[Transition] = []
        f = esc.decision_fields
        if f.get("address"):
            self.patient.address = f["address"]
        if f.get("mbi"):
            self.patient.mbi = f["mbi"]
        if self.patient_state == "ESC_UNREACHABLE":
            self._move("patient", "patient", "INFORMED", tx)
        await self._decided(esc, "She was reached. The engine resumes the patient thread.", tx)
        if not self._ranked_once:
            if self.patient.address:
                self._in(timedelta(minutes=2), self._rank_suppliers, "rank suppliers", call=False)
            else:
                self._clarified.add("patient:intro")
                self._at(self._patient_slot(timedelta(minutes=10), urgent=True), self._patient_clarify_address,
                         "clarify address")
        else:
            self._in(timedelta(minutes=5), self._repropose, "re-propose")

    # ------------------------------------------------------------ ambiguous (D12)

    async def _resume_ambiguous(self, esc: Escalation, action: str) -> None:
        """set fact: the advocate's fields become verified facts (quote "set by care
        advocate") and the same rules re-run."""
        ctx = self._esc_ctx[esc.id]
        facts = self._advocate_facts(esc)
        kind, sid = ctx.get("kind"), ctx.get("sid")
        set_text = ", ".join(f"{k} = {v}" for k, v in esc.decision_fields.items()) or "nothing"
        tx: list[Transition] = []

        if kind in ("supplier_screen", "supplier_confirm", "pod_mismatch", "billing"):
            self.suppliers[sid].facts.update(facts)
        if kind == "supplier_screen" and self.suppliers[sid].state == "ESC_AMBIGUOUS":
            self._sup_move(sid, "CALLING", tx)

        if not esc.decision_fields and kind in ("supplier_screen", "supplier_confirm", "pod_mismatch", "billing"):
            # Nothing was set, so re-running the same rule would just raise the same question again.
            n = self._empty_answers[(kind, sid)] = self._empty_answers.get((kind, sid), 0) + 1
            if n == 1 and kind == "supplier_confirm":
                when = cal.call_slot(cal.add_business_days(self._clock.now, 1))
                self._clarified.discard(f"{sid}:confirm")
                self.next_check["supplier"] = f"calling {self._name(sid)} again {fmt_day(when)}"
                await self._decided(esc, f"Nothing was set, so the engine calls {self._name(sid)} once more "
                                         f"on {fmt_day(when)} instead of asking again.", tx)
                self._at(when, lambda: self._supplier_confirm(sid), f"confirm again {sid}")
                return
            self.next_check[esc.thread] = "waiting for a person to set the missing fact"
            await self._decided(esc, "Nothing was set, and asking again would loop, so this thread waits for a "
                                     "person to set the fact.", tx)
            return
        await self._decided(esc, f"Advocate-set facts: {set_text}. The rules re-run.", tx)

        if kind == "address":
            if "address" in facts:
                self.patient.address = str(facts["address"].value)
            self._in(timedelta(minutes=2), self._rank_suppliers, "rank suppliers", call=False)
        elif kind == "consent":
            if self._f(facts, "consents_to_supplier") is True and self._f(facts, "window_ok") is True \
                    and self.patient_state == "INFORMED":
                tx2: list[Transition] = []
                self._move("patient", "patient", "WINDOW_CONFIRMED", tx2)
                self._consented = sid
                self._refresh_case(tx2)
                await self._event("patient", "rule", "Consent recorded from the advocate",
                                  "Her consent and window are now known, so WINDOW_CONFIRMED.", tx2)
                self._in(timedelta(minutes=5), lambda: self._after_consent(sid), "after consent", call=False)
            else:
                self._in(timedelta(minutes=5), self._repropose, "re-propose")
        elif kind == "supplier_screen":
            await self._evaluate_screen(sid, [], None)
            self._pump()
        elif kind == "supplier_confirm":
            await self._evaluate_confirm(sid, None)
        elif kind == "pod_mismatch":
            await self._resolve_pod(sid, self._f(facts, "delivered"))
        elif kind == "billing":
            billed = str(self._f(facts, "billed_hcpcs") or "").upper()
            if rules.REQUIRED_HCPCS in billed and self.case_state == "DELIVERED":
                await self._close_case([], "The advocate confirmed the billed code matches the order.")
            else:
                await self._ambiguous("supplier", ["billed_hcpcs"], None, kind="billing", sid=sid)

    async def _resolve_pod(self, sid: str, delivered: Any) -> None:
        """D11 mismatch settled by a person: delivered → verify and close; not delivered →
        the supplier's proof is contradicted, so it is treated as ghosted now."""
        if delivered is True:
            tx: list[Transition] = []
            self._patient_said_delivered = True
            if self.patient_state == "INFORMED":
                self._consented = sid
                self._move("patient", "patient", "WINDOW_CONFIRMED", tx)
            self._refresh_case(tx)
            if self.patient_state == "WINDOW_CONFIRMED":
                self._move("patient", "patient", "DELIVERY_VERIFIED", tx)
            await self._event("patient", "human", "Delivery confirmed by the care advocate",
                              "The advocate confirmed the chair arrived, so DELIVERY_VERIFIED (D11).", tx)
            await self._complete_delivery(sid, None)
        else:
            await self._ghost_check(sid)

    # ------------------------------------------------------------ supplier (§5)

    async def _resume_exhausted(self, esc: Escalation, action: str) -> None:
        """widen / add supplier. ESC_EXHAUSTED is a marker on the last ghosted candidate:
        it goes back to GHOSTED. Unreachable candidates get a fresh start (misses reset),
        and a named out-of-directory supplier joins the list. Then the search resumes."""
        tx: list[Transition] = []
        for sid in self._ranked:
            if self.suppliers[sid].state == "ESC_EXHAUSTED":
                self._sup_move(sid, "GHOSTED", tx)
        f = esc.decision_fields
        added: list[str] = []
        if action == "add_supplier" and f.get("name"):
            sid = f"x{len(self.suppliers) + 1}"
            try:
                miles = float(f["miles"]) if f.get("miles") else None
            except ValueError:
                miles = None
            d = DirectorySupplier(id=sid, name=f["name"], phone=f.get("phone", ""), address=f.get("address", ""),
                                  miles=miles)
            self.suppliers[sid] = SupplierStatus(supplier=d)
            self._ranked.append(sid)
            added.append(d.name)
        reopened = []
        for sid in self._ranked:
            s = self.suppliers[sid]
            if s.state == "UNREACHABLE":
                self._sup_move(sid, "NOT_CONTACTED", tx)
                s.misses, s.reason = 0, None
                self._first_try.pop(sid, None)
                reopened.append(s.supplier.name)
        parts = []
        if added:
            parts.append(f"Added {', '.join(added)} (out of directory).")
        elif action == "add_supplier":
            parts.append("No supplier name was given (fields: name, phone, address), so the search is widened.")
        if reopened:
            parts.append(f"Unreachable suppliers get a fresh start: {', '.join(reopened)}.")
        if not added and not reopened:
            parts.append("Every directory supplier has already answered, so there is nobody new to call. "
                         "The engine will ask again; adding a supplier by name is the way forward.")
        await self._decided(esc, " ".join(parts), tx)
        self._pump()

    async def _resume_eligibility(self, esc: Escalation, action: str) -> None:
        """proceed: ESC_ELIGIBILITY ─new rental period justified─► COMMITTED, then confirm."""
        sid = self._esc_ctx[esc.id]["sid"]
        tx: list[Transition] = []
        self._sup_move(sid, "COMMITTED", tx)
        self._eligibility_override.add(sid)
        await self._decided(esc, f"A new rental period is justified, so {self._name(sid)} is COMMITTED again "
                                 "and its confirmation is re-checked with the eligibility conflict overridden.", tx)
        await self._evaluate_confirm(sid, None)

    # ------------------------------------------------------------ order (§6)

    async def _resume_unsigned(self, esc: Escalation, action: str) -> None:
        """retry via contact: ESC_UNSIGNED ─retry via contact─► REQUESTED, nudge count reset.
        Fields: contact (who to address), fax (a new number, optional)."""
        f = esc.decision_fields
        if f.get("contact"):
            self._office_owner = f["contact"]
        if f.get("fax"):
            self._office_fax = f["fax"]
        self._nudges = 0
        tx: list[Transition] = []
        if self.order_state == "ESC_UNSIGNED":
            self._move("order", "order", "REQUESTED", tx)
            await self._decided(esc, f"Resending the order to {self._office_fax}"
                                     + (f", attention {self._office_owner}" if self._office_owner else "")
                                     + ". Nudges start over.", tx)
            await self._fax_request(self._order_request_text())
            self._arm_ack_timer()
            self._in(timedelta(minutes=30), self._office_followup, "confirm receipt")
        else:   # raised while waiting on a correction (no state change)
            await self._decided(esc, "Asking the office again for the corrected order. Nudges start over.", tx)
            self._in(timedelta(minutes=5), lambda: self._office_correction(self._last_problems), "office correction")
        self._start_polling()

    async def _resume_clinical(self, esc: Escalation, action: str) -> None:
        """doctor confirms K0001: ESC_CLINICAL ─doctor confirms K0001─► CORRECTION_REQUESTED,
        with one more correction loop allowed."""
        tx: list[Transition] = []
        self._move("order", "order", "CORRECTION_REQUESTED", tx)
        self._loop_limit += 1
        self._correction_loops += 1
        problems = ["The doctor confirmed a standard wheelchair, K0001. Please re-sign the order as K0001 "
                    "with a matching description."] + [p for p in self._last_problems if p.startswith("The note")]
        self._last_problems = problems
        await self._decided(esc, f"The doctor confirmed K0001, so one more correction loop is allowed "
                                 f"(loop {self._correction_loops} of {self._loop_limit}).", tx)
        self._in(timedelta(minutes=5), lambda: self._office_correction(problems), "office correction")
        self._start_polling()

    async def _resume_docs(self, esc: Escalation, action: str) -> None:
        """re-visit done: ESC_DOCS ─re-visit done─► SENT_TO_SUPPLIER. The engine waits for
        the new note, then the supplier re-reviews it."""
        tx: list[Transition] = []
        self._move("order", "order", "SENT_TO_SUPPLIER", tx)
        self._awaiting_new_note = True
        self.next_check["order"] = "waiting for the new visit note"
        await self._decided(esc, "A re-visit is booked. The order stays with the supplier; the new note goes to "
                                 "it for re-review when the office sends it. The AI never drafts it.", tx)
        await self._fax_request(self._order_request_text(correction=[
            "The supplier says the documentation doesn't support coverage. A re-visit is booked; please send "
            "the new signed visit note when it's ready."]))
        self._start_polling()
