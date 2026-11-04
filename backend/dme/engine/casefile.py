"""The case file: one source of truth the caller reads on every call.

The engine owns the case record (patient, suppliers, order, cost, every past call).
Before each call it renders the part of that record the person on the line may hear,
in plain sentences, and the caller answers questions from it. The brief says what this
call is *for*; the case file says what is *true*. Nothing in it is written by a model.

Minimum necessary (D3) is enforced here, not in the prompt: a supplier being scouted
gets no patient details at all, only its own earlier calls with us.
"""

from __future__ import annotations

from dme.engine import rules
from dme.engine.policy import fmt_day

_PURPOSE = {
    "patient_intro": "intro call", "patient_consent": "asked her to approve a supplier and a delivery time",
    "patient_delivery_check": "asked whether the chair arrived", "supplier_screen": "screening call",
    "supplier_reconfirm": "checked they could still take the referral", "supplier_commit": "asked them to take the referral",
    "supplier_confirm": "confirmed the order and delivery", "supplier_delivery_check": "asked whether it was delivered",
    "office_followup": "checked on the order request", "office_correction": "asked for a corrected order",
}
_ORDER_PLAIN = {
    "VERBAL_IN_CHART": "Dr. Chen's office hasn't been asked for the signed order yet",
    "REQUESTED": "we've asked Dr. Chen's office for the signed order and are waiting",
    "ACKNOWLEDGED": "Dr. Chen's office has the request and is getting it signed",
    "NUDGE": "we're following up with Dr. Chen's office on the signed order",
    "RECEIVED": "the signed order has arrived and is being checked",
    "CORRECTION_REQUESTED": "the signed order needed a correction, and Dr. Chen's office is fixing it",
    "VALIDATED": "the signed order is complete",
    "SENT_TO_SUPPLIER": "the signed order has been sent to the supplier",
    "DOCS_OK": "the signed order is complete and the supplier has it",
}


_NEVER_ECHO = {"mbi"}


class CaseFileMixin:
    """Engine mixin: renders the case record for one call."""

    def _case_file(self, kind: str, party_id: str, may_disclose: list[str]) -> list[str]:
        if kind == "patient":
            lines = self._file_for_patient()
        elif kind == "office":
            lines = self._file_for_office()
        else:
            lines = self._file_for_supplier(party_id, "patient name" in may_disclose)
        return lines + self._history(party_id, phi="patient name" in may_disclose or kind == "patient")

    # ------------------------------------------------------------- audiences

    def _file_for_patient(self) -> list[str]:
        p, c = self.patient, rules.cost_numbers()
        lines = [
            f"The chair: a {p.equipment.lower()}, which {p.pcp_name} recommended at her visit on "
            f"{p.visit_date}. Medicare Part B covers it as a rental.",
            f"What she pays: about ${c.share_early} a month for the first three months, then about "
            f"${c.share_later} a month, roughly ${c.total_rounded} in all over 13 months, after which the chair "
            f"is hers. Medicare pays the other 80%. Plus any part of this year's ${rules.DEDUCTIBLE_2026} Part B "
            "deductible she hasn't met; the deductible starts over in January.",
            "She pays only for months she has the chair. A supplier can't bill Medicare for a chair it never "
            "delivered, because Medicare needs a signed delivery ticket, so she won't be charged by two suppliers "
            "for one chair.",
            "If money is tight, a state program (QMB) may cover her share completely. Someone from her care team "
            "can help her check; you can't decide that.",
        ]
        if p.address:
            lines.append(f"Her address on file: {p.address}.")
        lines.append("The order: Dr. Chen's office has signed it and it's complete." if self._order_text
                     else f"The order: {self._order_plain()}.")
        lines += self._supplier_story(for_patient=True)
        return lines

    def _file_for_office(self) -> list[str]:
        p = self.patient
        lines = [f"Patient: {p.name}, {p.age}, seen by {p.pcp_name} on {p.visit_date}. "
                 f"Order needed: {p.equipment} ({p.hcpcs}).",
                 f"Where the order stands: {self._order_plain()}.",
                 f"Last fax sent to: {self._office_fax}."]
        if self._office_owner:
            lines.append(f"The person at the office who owns it: {self._office_owner}.")
        if self._last_problems:
            lines.append("Problems found on the last signed order: " + " ".join(self._last_problems))
        return lines

    def _file_for_supplier(self, sid: str, phi: bool) -> list[str]:
        s = self.suppliers.get(sid)
        if s is None:
            return []
        lines = [f"Needed: a standard manual wheelchair ({self.patient.hcpcs}), Medicare Part B rental, "
                 f"delivered in ZIP {self.patient.zip or '60614'}."]
        if sid in self._withdrawn:
            lines.append(f"We withdrew this referral in writing on {fmt_day(self._withdrawn[sid])}.")
        if phi:
            lines.append(f"Patient: {self.patient.name}. The order: {self._order_plain()}.")
            if self._consented == sid and self._patient_window_text:
                lines.append(f"She approved this supplier and the delivery time {self._patient_window_text}.")
        return lines

    # --------------------------------------------------------------- pieces

    def _order_plain(self) -> str:
        return _ORDER_PLAIN.get(self.order_state, "a person on the care team is sorting out the order")

    def _supplier_story(self, for_patient: bool) -> list[str]:
        lines = []
        for sid, when in self._withdrawn.items():
            what = "didn't deliver as promised" if self.suppliers[sid].state == "GHOSTED" else "stopped answering us"
            lines.append(f"{self._name(sid)} {what}. On {fmt_day(when)} we told them in writing "
                         "not to deliver and not to bill her. She owes them nothing.")
        if self._consented:
            lines.append(f"She approved {self._name(self._consented)}, delivering {self._patient_window_text}.")
        return lines

    def _history(self, party_id: str, phi: bool) -> list[str]:
        """Earlier calls with this same party, with what they told us (quoted)."""
        out = []
        for r in self.calls.values():
            if r.goal.party_id != party_id:
                continue
            what = _PURPOSE.get(r.goal.purpose, r.goal.purpose.replace("_", " "))
            if r.outcome == "no_answer":
                out.append(f"Earlier, {fmt_day(r.started_at)}: {what}; nobody answered.")
                continue
            # Never echo identifiers back (D3): her Medicare number stays out of the file.
            said = [f'"{f.quote}"' for k, f in r.facts.items() if f.known and f.quote and k not in _NEVER_ECHO]
            line = f"Earlier, {fmt_day(r.started_at)}: {what}."
            if said:
                line += (" She said: " if r.goal.party_kind == "patient" else " They said: ") + "; ".join(dict.fromkeys(said)) + "."
            out.append(line if phi else line.replace(self.patient.name, "the patient"))
        return out
