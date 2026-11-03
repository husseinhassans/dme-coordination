"""Human seats: the browser takes the place of a supplier, the office, Eleanor or the
care advocate. Each class implements the same contract the autopilot does, so the
engine can't tell a person from an LLM persona (that's the point of the demo).

Every human wait is bounded. A seat that doesn't answer behaves like a phone that
rings out or a person who stops talking, which the engine already handles.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable

from dme.contract import (
    CallGoal,
    Escalation,
    FaxDocument,
    Party,
    PartyKind,
    SeatMode,
    Utterance,
)

Emit = Callable[[dict[str, Any]], Awaitable[None]]

RING_TIMEOUT_S = 90        # unanswered ring → no answer
TURN_TIMEOUT_S = 240       # silent human → treated as hanging up
DECIDE_TIMEOUT_S = None    # escalations wait for the person (that's the job)


class Inbox:
    """Futures keyed by id, resolved by incoming WebSocket messages."""

    def __init__(self) -> None:
        self._waiting: dict[str, asyncio.Future[Any]] = {}

    def expect(self, key: str) -> asyncio.Future[Any]:
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._waiting[key] = fut
        return fut

    def resolve(self, key: str, value: Any) -> bool:
        fut = self._waiting.pop(key, None)
        if fut and not fut.done():
            fut.set_result(value)
            return True
        return False

    def cancel_all(self) -> None:
        for fut in self._waiting.values():
            if not fut.done():
                fut.cancel()
        self._waiting.clear()


class HumanParty:
    """A supplier, the office or Eleanor, played by the person in the browser."""

    def __init__(self, kind: PartyKind, party_id: str, name: str, emit: Emit, inbox: Inbox,
                 current_call: Callable[[], str | None]) -> None:
        self.kind = kind
        self.id = party_id
        self.name = name
        self._emit = emit
        self._inbox = inbox
        self._current_call = current_call

    async def pick_up(self, goal: CallGoal) -> bool:
        call_id = self._current_call() or "unknown"
        await self._emit({"type": "ringing", "call_id": call_id, "party_kind": self.kind,
                          "party_name": self.name})
        try:
            answer = await asyncio.wait_for(self._inbox.expect(f"pickup:{call_id}"), RING_TIMEOUT_S)
        except asyncio.TimeoutError:
            return False
        return bool(answer)

    async def reply(self, transcript: list[Utterance]) -> str | None:
        call_id = self._current_call() or "unknown"
        await self._emit({"type": "your_turn", "call_id": call_id})
        try:
            text = await asyncio.wait_for(self._inbox.expect(f"say:{call_id}"), TURN_TIMEOUT_S)
        except asyncio.TimeoutError:
            return None
        return text or None


class SeatPartyProvider:
    """contract.PartyProvider: hands the engine the human seat or the autopilot persona,
    decided at call time, so seats can be switched mid-run."""

    def __init__(self, seats: dict[str, SeatMode], autopilot: Callable[[PartyKind, str], Party],
                 human: Callable[[PartyKind, str], Party]) -> None:
        self._seats = seats
        self._autopilot = autopilot
        self._human = human

    def seat(self, kind: PartyKind) -> SeatMode:
        return self._seats.get(kind, "auto")

    def get(self, kind: PartyKind, party_id: str) -> Party:
        return self._human(kind, party_id) if self.seat(kind) == "human" else self._autopilot(kind, party_id)


class SeatFaxDesk:
    """contract.OfficeFaxDesk that routes to the autopilot desk or to the browser's fax
    composer, depending on who holds the office seat when the request arrives."""

    def __init__(self, seats: dict[str, SeatMode], autopilot_desk: Any, emit: Emit) -> None:
        self._seats = seats
        self._auto = autopilot_desk
        self._emit = emit
        self._human_outbox: list[str] = []
        self._human_requests: dict[str, FaxDocument] = {}

    def _human(self) -> bool:
        return self._seats.get("office", "auto") == "human"

    async def receive_request(self, request: FaxDocument) -> None:
        # The autopilot desk always sees the request too, so switching the seat back to
        # Autopilot mid-case still produces a signed order.
        await self._auto.receive_request(request)
        if self._human():
            request_id = uuid.uuid4().hex[:8]
            self._human_requests[request_id] = request
            await self._emit({"type": "fax_requested", "request_id": request_id,
                              "prefill": prefill_from_request(request.text),
                              "request_text": request.text, "to": request.to})

    def human_sent(self, request_id: str, text: str) -> None:
        self._human_outbox.append(text)

    async def next_signed_order(self) -> str | None:
        if self._human_outbox:
            return self._human_outbox.pop(0)
        if self._human():
            return None
        return await self._auto.next_signed_order()


def prefill_from_request(request_text: str) -> str:
    """The order the office would sign: the engine's prefilled order plus a visit note
    the human edits. Mistakes are planted by the reviewer in the UI."""
    return (
        "STANDARD WRITTEN ORDER\n"
        "Patient: Eleanor Martinez   MBI: 1EG4-TE5-MK73\n"
        "Item: Standard wheelchair   HCPCS: K0001   Qty: 1\n"
        "Ordering provider: Sarah Chen, MD   NPI: 1234567893\n"
        "Date: 11/04/2026\n"
        "Signature: /s/ Sarah Chen, MD (electronically signed)\n"
        "\n"
        "VISIT NOTE 10/30/2026 (excerpt)\n"
        "Gait: unable to walk to bathroom without stopping to rest; near-fall at home 10/2.\n"
        "Patient cannot safely reach the bathroom using her walker because of fatigue and poor balance.\n"
        "Lives in an elevator building; doorways in her apartment are wide enough for a wheelchair.\n"
        "Plan: standard wheelchair for daily use in apartment. Patient agrees. Daughter assists with transfers."
    )


class SeatAdvocate:
    """contract.AdvocateProvider. Human seat: wait for the browser's "decide". Autopilot:
    apply a scripted decision after a short pause so the demo keeps moving."""

    def __init__(self, seats: dict[str, SeatMode], inbox: Inbox,
                 scripted: Callable[[Escalation], tuple[str, str | None, dict[str, str]]],
                 auto_delay_s: float = 3.0) -> None:
        self._seats = seats
        self._inbox = inbox
        self._scripted = scripted
        self._delay = auto_delay_s

    async def decide(self, escalation: Escalation) -> tuple[str, str | None, dict[str, str]]:
        waiter = self._inbox.expect(f"decide:{escalation.id}")
        if self._seats.get("advocate", "human") == "human":
            return await waiter  # (option, note, fields)
        # Autopilot advocate: a human can still answer first during the pause.
        try:
            return await asyncio.wait_for(asyncio.shield(waiter), self._delay)
        except asyncio.TimeoutError:
            self._inbox.resolve(f"decide:{escalation.id}", None)
            return self._scripted(escalation)
