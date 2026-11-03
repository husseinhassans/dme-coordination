"""One demo session: an Engine, the autopilot cast, the human seats, and the controls.

Seats can change at any time. The engine asks the PartyProvider for the other side
of each call when it dials, so taking a seat mid-run works on the next call.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable

from pydantic import BaseModel

from dme.contract import Escalation, PartyKind, Patient, SeatMode
from dme.engine.geo import load_directory
from dme.engine.orchestrator import Engine
from dme.llm import AnthropicLLM, AutopilotCast, LLMCallRunner
from dme.server.seats import HumanParty, Inbox, SeatAdvocate, SeatFaxDesk, SeatPartyProvider

log = logging.getLogger("dme.session")
Emit = Callable[[dict[str, Any]], Awaitable[None]]

PARTY_NAMES = {"office": "Sunrise Family Medicine", "patient": "Eleanor Martinez"}
MAX_CALLS_PER_RUN = 60   # cost guard: the demo run needs ~25; a loop gets paused, not billed forever


def eleanor() -> Patient:
    """Intake record from the brief. Address and MBI are unknown until the first call."""
    return Patient(
        name="Eleanor Martinez", age=72, plan="Original Medicare (Part B), no supplemental plan",
        equipment="Standard manual wheelchair", hcpcs="K0001",
        pcp_name="Dr. Sarah Chen", pcp_practice="Sunrise Family Medicine", pcp_phone="(312) 555-0198",
        visit_date="2026-10-30",
    )


def jsonable(value: Any) -> Any:
    """Pydantic models (and containers of them) to plain JSON-ready data."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


class Session:
    def __init__(self, emit: Emit) -> None:
        self._broadcast = emit
        self.seats: dict[str, SeatMode] = {"supplier": "auto", "office": "auto", "patient": "auto", "advocate": "human"}
        self.inbox = Inbox()
        self.task: asyncio.Task[None] | None = None
        self._calls_by_party: dict[tuple[str, str], str] = {}
        self._build()

    # ------------------------------------------------------------------ wiring

    def _build(self) -> None:
        self.inbox.cancel_all()
        self._calls_by_party.clear()
        self._call_count = 0
        self._auto_decided: dict[str, int] = {}
        self.directory = load_directory()
        self._names = {s.id: s.name for s in self.directory}
        llm = AnthropicLLM()
        self.cast = AutopilotCast(llm=llm, now=self._now)
        self.runner = LLMCallRunner(llm, on_utterance=self._on_utterance, on_facts=self._on_facts, now=self._now)
        self.fax_desk = SeatFaxDesk(self.seats, self.cast.fax_desk, self.emit)
        self.parties = SeatPartyProvider(self.seats, autopilot=self.cast.get, human=self._human_party)
        self.advocate = SeatAdvocate(self.seats, self.inbox, scripted=self._scripted_decision)
        self.engine = Engine(
            patient=eleanor(), directory=self.directory, call_runner=self.runner,
            parties=self.parties, fax_desk=self.fax_desk, advocate=self.advocate, emit=self.emit,
        )

    def _now(self):  # simulated clock, owned by the engine
        return self.engine.now() if getattr(self, "engine", None) else None

    def _human_party(self, kind: PartyKind, party_id: str) -> HumanParty:
        name = PARTY_NAMES.get(kind) or self._names.get(party_id, party_id)
        party = HumanParty(kind, party_id, name, self.emit, self.inbox,
                           current_call=lambda: self._calls_by_party.get((kind, party_id)))
        party.seat = "human"  # read by the call runner for CallRecord.seat
        return party

    # ------------------------------------------------------------------ outbound

    async def emit(self, msg: dict[str, Any]) -> None:
        msg = jsonable(msg)
        if msg.get("type") == "call_started":
            self._calls_by_party[(msg.get("party_kind"), msg.get("party_id"))] = msg.get("call_id")
            msg["seat"] = self.parties.seat(msg.get("party_kind"))
            self._call_count += 1
            if self._call_count == MAX_CALLS_PER_RUN:
                self.engine.pause()
                await self._broadcast({"type": "error", "message": (
                    f"Paused after {MAX_CALLS_PER_RUN} calls. A normal run needs about 25, so something is "
                    "looping. Press Resume to continue anyway.")})
        if msg.get("type") == "snapshot" and isinstance(msg.get("case"), dict):
            msg["case"]["seats"] = dict(self.seats)
        await self._broadcast(msg)

    async def _on_utterance(self, call_id: str, speaker: str, text: str) -> None:
        await self.emit({"type": "utterance", "call_id": call_id, "speaker": speaker, "text": text})

    async def _on_facts(self, call_id: str, facts: dict) -> None:
        await self.emit({"type": "facts", "call_id": call_id, "facts": facts})

    def snapshot_msg(self) -> dict[str, Any]:
        case = jsonable(self.engine.snapshot())
        case["seats"] = dict(self.seats)
        return {"type": "snapshot", "case": case}

    def hello(self) -> dict[str, Any]:
        return self.snapshot_msg()

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    # ------------------------------------------------------------------ advocate autopilot

    def _scripted_decision(self, esc: Escalation) -> tuple[str, str | None, dict[str, str]]:
        """What the autopilot advocate does: the run's cost conversation (spec §11),
        or the first allowed answer for any other code."""
        # Never give the same non-final answer twice: a second escalation of the same kind
        # means the first answer didn't work, so the autopilot advocate pauses the case.
        seen = self._auto_decided.get(esc.code, 0)
        self._auto_decided[esc.code] = seen + 1
        prefer = "Pause" if seen or esc.code == "SUPPLIERS_EXHAUSTED" else "QMB"
        option = next((o for o in esc.options if prefer.lower() in o.lower()),
                      next((o for o in esc.options if "close" in o.lower()), esc.options[0]) if prefer == "Pause"
                      else esc.options[0])
        note = ("Called Eleanor for 25 minutes. Walked through the $72 total; the surgery bill is separate. "
                "Income is about $1,250 a month, so she likely qualifies for QMB. Started the application. "
                "She wants the chair and approves the next supplier.") if esc.code == "PATIENT_COST_CONCERN" else None
        # No typed fields, same as the UI's decide: the engine re-proposes the supplier and
        # window to Eleanor on its next call, now that a person has talked it through.
        self.cast.patient.note_advocate_call()
        return option, note, {}

    # ------------------------------------------------------------------ inbound

    async def start(self) -> None:
        if self.running:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._build()
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            await self.engine.run()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface to the UI
            log.exception("engine crashed")
            await self.emit({"type": "error", "message": f"Engine stopped: {exc}"})
        finally:
            await self.emit(self.snapshot_msg())

    async def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "start":
            await self.start()
        elif kind == "seat":
            seat_key, mode = msg["party_kind"], msg["mode"]
            if seat_key not in self.seats or mode not in ("auto", "human"):
                raise ValueError(f"unknown seat {seat_key}={mode}")
            self.seats[seat_key] = mode
            await self.emit(self.snapshot_msg())
        elif kind == "control":
            action = msg.get("action")
            if action == "pause":
                self.engine.pause()
            elif action == "resume":
                self.engine.resume()
            elif action == "step":
                self.engine.step()
            elif action == "speed":
                self.engine.set_pace(float(msg.get("value", 1.0)))
            await self.emit(self.snapshot_msg())
        elif kind == "pickup":
            self.inbox.resolve(f"pickup:{msg['call_id']}", True)
        elif kind == "let_ring":
            self.inbox.resolve(f"pickup:{msg['call_id']}", False)
        elif kind == "say":
            self.inbox.resolve(f"say:{msg['call_id']}", str(msg.get("text", "")).strip() or None)
        elif kind == "hangup":
            self.inbox.resolve(f"say:{msg['call_id']}", None)
        elif kind == "send_fax":
            self.fax_desk.human_sent(msg["request_id"], msg["text"])
        elif kind == "decide":
            decided = self.inbox.resolve(
                f"decide:{msg['escalation_id']}",
                (msg["option"], msg.get("note"), {str(k): str(v) for k, v in (msg.get("fields") or {}).items()}),
            )
            if decided:
                self.cast.patient.note_advocate_call()
        else:
            raise ValueError(f"unknown message type {kind!r}")
