"""Autopilot parties: LLM-roleplayed suppliers, the PCP office, and Eleanor (spec §11).

Each persona is a `contract.Party`. What a persona *knows and will say* is decided by
plain code from its state, the simulated clock and the call's purpose; the persona model
(DME_PERSONA_MODEL) only turns that into natural, short, in-character speech.

* Availability (`pick_up`) is pure code: weekends, Veterans Day, Lakeshore's two missed
  calls, Lincoln Park going silent after it confirms.
* `goal.purpose` is used only to choose which slice of the hidden script applies (a real
  supplier knows whether it has received an order). Personas never see the goal's fact
  list or what the engine wants to hear.
* Dates ("Monday", "Thursday morning") are computed from the simulated clock with the
  same business-day calendar as the spec (D14), never hardcoded.

The office and the fax desk share state: the front desk's "we never got it" vs. Maria's
"got it" depends on whether a request actually reached the current fax number.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from dme.contract import CallGoal, FaxDocument, PartyKind, Utterance

from .client import LLM

Clock = Callable[[], datetime]

# ---------------------------------------------------------------------------
# Calendar (D14): Mon-Fri, excluding federal holidays in the demo window
# ---------------------------------------------------------------------------

HOLIDAYS = {date(2026, 11, 11), date(2026, 11, 26), date(2026, 12, 25), date(2027, 1, 1)}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in HOLIDAYS


def add_business_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if is_business_day(d):
            n -= 1
    return d


def spoken_day(d: date, today: date) -> str:
    if d == today:
        return "today"
    if d == today + timedelta(days=1):
        return "tomorrow"
    return d.strftime("%A")


# ---------------------------------------------------------------------------
# Order documents the office faxes back (verbatim from docs/state-machine.html)
# ---------------------------------------------------------------------------

DOC1 = (
    "STANDARD WRITTEN ORDER\nPatient: Eleanor Martinez   MBI: 1EG4-TE5-MK73\n"
    "Item: Standard wheelchair   HCPCS: K0003   Qty: 1\nOrdering provider: Sarah Chen, MD   NPI: 1234567893\n"
    "Date: 11/04/2026\nSignature: /s/ Sarah Chen, MD (electronically signed)\n\n"
    "VISIT NOTE 10/30/2026 (excerpt)\n"
    "Gait: unable to walk to bathroom without stopping to rest; near-fall at home 10/2.\n"
    "Plan: standard wheelchair for daily use in apartment. Patient agrees. Daughter assists with transfers."
)
DOC2 = (
    "STANDARD WRITTEN ORDER (corrected)\nPatient: Eleanor Martinez   MBI: 1EG4-TE5-MK73\n"
    "Item: Standard wheelchair   HCPCS: K0001   Qty: 1\nOrdering provider: Sarah Chen, MD   NPI: 1234567893\n"
    "Date: 11/06/2026\nSignature: /s/ Sarah Chen, MD (electronically signed)\n\n"
    "ADDENDUM 11/06/2026 to visit of 10/30/2026\n"
    "At the 10/30 visit, patient could not safely reach the bathroom using her walker because of fatigue "
    "and poor balance. She lives in an elevator building and reports the doorways in her apartment are wide "
    "enough for a wheelchair.\n/s/ Sarah Chen, MD"
)

OLD_FAX = "(312) 555-0199"
NEW_FAX = "(312) 555-0197"

# ---------------------------------------------------------------------------
# Shared persona prompt
# ---------------------------------------------------------------------------

PERSONA_FRAME = """\
You are playing a real person answering a phone call, in a training simulation. Stay in \
character the whole time. You are a human; never say or hint that you are an AI, a \
model, a simulation or a character.

How you talk:
- 1 to 3 short sentences per turn, like real phone speech. No lists, no stage \
directions, no speaker label, no quotation marks around your words.
- Answer what you are asked. Don't volunteer facts nobody asked about unless a real \
person naturally would (a short aside is fine).
- When a topic in "What you'd say" comes up, use that wording closely: same facts, same \
numbers. Never invent other facts, prices or dates; if asked something your notes don't \
cover, say you're not sure or you'd have to check.
- If the caller says goodbye or the conversation is clearly finished, say a brief goodbye.
- If you want to end the call abruptly, reply with exactly: [hangs up]

Output only the words you say out loud."""

HANGUP = "[hangs up]"
MAX_PERSONA_TURNS = 8


def _messages(transcript: list[Utterance]) -> list[dict]:
    """Persona's view: engine = user, party (us) = assistant."""
    msgs: list[dict] = []
    for u in transcript:
        role = "user" if u.speaker == "engine" else "assistant"
        if msgs and msgs[-1]["role"] == role:
            msgs[-1] = {"role": role, "content": msgs[-1]["content"] + "\n" + u.text}
        else:
            msgs.append({"role": role, "content": u.text})
    if not msgs or msgs[0]["role"] != "user":
        msgs.insert(0, {"role": "user", "content": "[Phone rings. You pick up.]"})
    return msgs


def _clean(text: str, speaker_names: tuple[str, ...] = ()) -> str:
    """Drop a stray speaker label ("Ana: ...") only if it is one of this persona's own
    names, so colon-led speech like "Standard chairs: we're out" is kept intact."""
    text = text.strip()
    for name in speaker_names:
        if name and text.casefold().startswith(name.casefold() + ":"):
            text = text[len(name) + 1:]
            break
    return text.strip().strip('"').strip()


class PersonaParty:
    """Base class. Subclasses define `available`, `persona` and `situation`."""

    kind: PartyKind
    seat = "auto"

    def __init__(self, *, id: str, name: str, llm: LLM, now: Clock) -> None:
        self.id = id
        self.name = name
        self.llm = llm
        self.now = now
        self.attempts = 0          # times dialled
        self.answered = 0          # times picked up
        self.goal: CallGoal | None = None
        self._turns = 0

    # --- hooks for subclasses -------------------------------------------------
    def available(self, goal: CallGoal) -> bool:
        return True

    def on_answer(self, goal: CallGoal) -> None:
        """State change when this call is picked up."""

    def persona(self) -> str:
        raise NotImplementedError

    def situation(self, goal: CallGoal) -> str:
        raise NotImplementedError

    def speaker_names(self) -> tuple[str, ...]:
        """Labels the model might wrongly prefix a reply with."""
        return (self.name, self.name.split()[0])

    # --- Party protocol -------------------------------------------------------
    async def pick_up(self, goal: CallGoal) -> bool:
        self.attempts += 1
        if not self.available(goal):
            return False
        self.answered += 1
        self.goal = goal
        self._turns = 0
        self.on_answer(goal)
        return True

    async def reply(self, transcript: list[Utterance]) -> str | None:
        assert self.goal is not None, "reply() before pick_up()"
        self._turns += 1
        if self._turns > MAX_PERSONA_TURNS:
            return None
        now = self.now()
        system = (
            f"{PERSONA_FRAME}\n\n## Who you are\n{self.persona()}\n\n"
            f"## Right now\nIt is {now:%A, %B} {now.day}, {now:%Y}, {now:%-I:%M %p}.\n"
            f"{self.situation(self.goal)}"
        )
        text = _clean(await self.llm.text(role="persona", system=system,
                                          messages=_messages(transcript), max_tokens=1200),
                      self.speaker_names())
        if not text or HANGUP in text.casefold():
            return None
        return text


# ---------------------------------------------------------------------------
# Suppliers
# ---------------------------------------------------------------------------


@dataclass
class SupplierProfile:
    contact: str
    voice: str                        # how they talk
    accepting: str                    # what they'd say about new Medicare patients
    assignment: str                   # ... about assignment on rentals
    stock: str                        # ... about K0001 stock
    area: str                         # ... about delivering to 60614 / Lincoln Park
    eta: str                          # ... about delivery speed
    referral: str = "Sure, send it over."
    eta_days: int = 5                 # business days from order to delivery
    window: str = "between one and four"
    qualifies: bool = True            # can actually take this patient


PROFILES: dict[str, SupplierProfile] = {
    "lp": SupplierProfile(
        contact="Dev", voice="Upbeat and quick, says 'yep' a lot.",
        accepting="Yep.", assignment="Yep, all the rental months.",
        stock="We've got standard chairs on the floor.", area="We're right down the street.",
        eta="Once the paperwork's in, we can usually deliver in three days.",
        referral="Sure, send it over. Ask for Dev.", eta_days=3, window="one to four"),
    "hh": SupplierProfile(
        contact="Linda", voice="Warm, a bit tired, calls people 'hon'.",
        accepting="Not right now, hon. We're full up on new Medicare patients until January.",
        assignment="We do, for patients we have.", stock="We have some standard chairs.",
        area="We cover Lincoln Park.", eta="Usually about a week.",
        referral="I can't take a new Medicare referral until January, sorry.", qualifies=False),
    "ls": SupplierProfile(
        contact="Marcus", voice="Busy, short answers.",
        accepting="Yeah, we take Medicare.", assignment="Yes, we accept assignment.",
        stock="Standard chairs? We're out. Next shipment's about three weeks.",
        area="Yeah, 60614's fine.", eta="Once they're back in, a few days.",
        referral="We can't do anything until the shipment's in.", qualifies=False),
    "wc": SupplierProfile(
        contact="Tom", voice="Matter-of-fact.",
        accepting="We're enrolled with Medicare, sure.",
        assignment="We're enrolled, but we don't take assignment on rentals. She'd pay us and Medicare reimburses her.",
        stock="We have K0001s.", area="We deliver all over the city.", eta="Four or five days.",
        referral="Only if she's fine paying us directly.", qualifies=False),
    "ps": SupplierProfile(
        contact="Ana", voice="Friendly, efficient, says yes to everything.",
        accepting="Yes to all of it.", assignment="Yes, every rental month.",
        stock="Yes, we have standard chairs in stock.", area="We cover the whole North Side.",
        eta="Delivery's about four business days after we get the order. I'm Ana.",
        referral="Sure, send the order whenever.", eta_days=4, window="nine to twelve"),
    "bm": SupplierProfile(
        contact="Grace", voice="Careful and polite.",
        accepting="Yes, we're taking new Medicare patients.", assignment="We accept assignment, all months.",
        stock="We have standard chairs in stock.", area="Yes, we deliver to 60614.",
        eta="About five business days from the order.", eta_days=5),
    "rs": SupplierProfile(
        contact="Luis", voice="Easygoing.",
        accepting="Yeah, we take new Medicare patients.", assignment="Yes, we take assignment.",
        stock="We've got a few K0001s.", area="Lincoln Park's no problem.",
        eta="Usually about six business days.", eta_days=6),
    "nc": SupplierProfile(
        contact="Priya", voice="Professional.",
        accepting="We are accepting new Medicare patients.", assignment="Yes, assignment for all months.",
        stock="Yes, in stock.", area="We serve the North Side, including 60614.",
        eta="Five business days, typically.", eta_days=5),
    "cl": SupplierProfile(
        contact="Joe", voice="Chatty.",
        accepting="Sure, we take Medicare.", assignment="Yes, we accept assignment.",
        stock="We're out of standard chairs today, but a shipment comes in about five days.",
        area="We deliver citywide.", eta="About a week after the order.", eta_days=7),
    "sl": SupplierProfile(
        contact="Dana", voice="Brisk.",
        accepting="Yes.", assignment="Yes, we take assignment on rentals.",
        stock="We have them.", area="Yes, we go up to Lincoln Park.",
        eta="Seven business days or so.", eta_days=7),
    "mm": SupplierProfile(
        contact="Rick", voice="Friendly, suburban.",
        accepting="Yes, we take new Medicare patients.", assignment="We accept assignment.",
        stock="We have standard chairs.",
        area="Oh, we don't deliver into the city, sorry. We only cover the northwest suburbs.",
        eta="A few days, in our area.", referral="Not for an address in the city, sorry.", qualifies=False),
    "eh": SupplierProfile(
        contact="Beth", voice="Kind, precise.",
        accepting="Yes, we are.", assignment="Yes, all months.", stock="Yes, in stock.",
        area="We don't deliver south of Howard Street, so 60614 is outside our area.",
        eta="Three or four days, in our area.", referral="I'm afraid that's outside our area.", qualifies=False),
}

SUPPLIER_NAMES: dict[str, str] = {
    "lp": "Lincoln Park DME Services", "hh": "Halsted Home Health Supply",
    "ls": "Lakeshore Home Medical Equipment", "wc": "Windy City Mobility & DME",
    "ps": "Prairie State Medical Supply", "bm": "Belmont Medical Equipment",
    "rs": "Roosevelt Medical Supply Co", "nc": "Northside CarePlus Equipment",
    "cl": "ChicagoLand Durable Medical", "sl": "South Loop Medical Supply",
    "mm": "Midwest Mobility Solutions", "eh": "Evanston Home Medical",
}


class SupplierPersona(PersonaParty):
    """One supplier. Special behaviour (spec §11):
    lp - qualifies, takes the referral, confirms when it has the order, then never answers again.
    ls - the first `ls_missed_calls` dials ring out; then out of K0001 for ~3 weeks.
    ps - closed on Veterans Day; on a reconfirm before then, earliest is the next open
         morning and "send the order whenever"; confirms and delivers.
    """

    kind: PartyKind = "supplier"

    def __init__(self, id: str, *, llm: LLM, now: Clock, ls_missed_calls: int = 2) -> None:
        super().__init__(id=id, name=SUPPLIER_NAMES[id], llm=llm, now=now)
        self.p = PROFILES[id]
        self.ls_missed_calls = ls_missed_calls
        self.ghosting = False        # lp after confirming
        self.has_order = False
        self.delivered = False
        self.delivery_day: date | None = None

    def available(self, goal: CallGoal) -> bool:
        now = self.now()
        if now.weekday() >= 5 or not (time(8, 0) <= now.time() < time(18, 0)):
            return False
        if self.id == "ps" and now.date() in HOLIDAYS:
            return False
        if self.ghosting:
            return False
        if self.id == "ls" and self.attempts <= self.ls_missed_calls:
            return False
        return True

    def on_answer(self, goal: CallGoal) -> None:
        if goal.purpose == "supplier_confirm":
            self.has_order = True
            if self.delivery_day is None:
                self.delivery_day = self._delivery_day()
            if self.id == "lp":
                self.ghosting = True     # answers this call, never again
        if (goal.purpose == "supplier_delivery_check" and self.has_order and self.id != "lp"
                and self.delivery_day is not None and self.now().date() >= self.delivery_day):
            self.delivered = True

    def _delivery_day(self) -> date:
        """lp offers the next business day; ps comes the same morning if called early."""
        now = self.now()
        if self.id == "ps" and now.time() < time(9, 0):
            return now.date()
        return add_business_days(now.date(), 1)

    def speaker_names(self) -> tuple[str, ...]:
        return (self.p.contact, self.name)

    def persona(self) -> str:
        p = self.p
        return (f"You are {p.contact}, who answers the phone at {self.name}, a Chicago medical-equipment "
                f"supplier enrolled with Medicare. {p.voice} You know your business well and talk "
                "like a busy, real person.")

    def situation(self, goal: CallGoal) -> str:
        p, now = self.p, self.now()
        today = now.date()
        if goal.purpose == "supplier_screen":
            return (
                "A care team's automated assistant is asking whether you can take a Medicare patient "
                "for a standard manual wheelchair (K0001).\n\nWhat you'd say:\n"
                f"- New Medicare patients: {p.accepting}\n- Assignment on rentals: {p.assignment}\n"
                f"- K0001 stock: {p.stock}\n- Delivering to ZIP 60614 (Lincoln Park): {p.area}\n"
                f"- How fast: {p.eta}\n- If they ask you to take the referral: {p.referral}\n"
                f"- If asked who to ask for: {p.contact}.\n"
                + ("" if p.qualifies else "If your first answer already rules you out, keep it short; "
                   "you don't need to go through everything else.")
            )
        if goal.purpose == "supplier_reconfirm":
            if not p.qualifies:
                return f"They're checking whether you can still take the referral. What you'd say: {p.referral}"
            earliest = add_business_days(today, 1)
            if self.id == "ps":
                closed = [d for d in (today + timedelta(days=i) for i in range(1, 4)) if d in HOLIDAYS]
                day = spoken_day(earliest, today)
                why = (f"We're closed {spoken_day(closed[0], today)} for Veterans Day, so {day} morning is the earliest."
                       if closed else f"{day.capitalize()} morning is the earliest.")
                return (
                    "Last week you told this care team you could take a K0001 referral. They're checking "
                    f"if you could still take it.\n\nWhat you'd say: We could. {why} If you need us, send the "
                    f"order whenever and I'll check first thing {day}."
                )
            return (f"They're checking you can still take the referral. What you'd say: Yes, still fine. "
                    f"Earliest delivery would be {spoken_day(add_business_days(today, p.eta_days), today)} "
                    "once we have the order.")
        if goal.purpose == "supplier_confirm":
            day = self.delivery_day or self._delivery_day()
            when = spoken_day(day, today)
            if self.id == "ps":
                slot = "She's our first stop, around nine-thirty." if day == today else f"{when}, {p.window}."
                say = f"Got it all. Eligibility's clean, no other wheelchair on file. The note's fine. {slot}"
            else:
                say = (f"Got the order and the note. Eligibility's clean, no other wheelchair on file, and she's "
                       f"Original Medicare. Note covers it. How's {when}, {p.window}?")
            return ("This morning you received the patient's signed order, her Medicare number and the visit "
                    "note by fax, and you ran the eligibility check.\n\nWhat you'd say: " + say)
        if goal.purpose == "supplier_delivery_check":
            if self.delivered:
                return ("You delivered the chair this morning.\n\nWhat you'd say: Delivered at nine-forty and Rosa "
                        "signed the delivery ticket. We're billing K0001 with RR and KH, first rental month, "
                        "on assignment.")
            return "You haven't delivered anything for this patient. Say so plainly."
        return "You don't know what this is about; ask them to explain, and help if you can."


# ---------------------------------------------------------------------------
# PCP office: fax desk + front desk / Maria
# ---------------------------------------------------------------------------


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


class AutopilotFaxDesk:
    """contract.OfficeFaxDesk for autopilot (spec §11, html EVENTS).

    * Requests to the old fax (312) 555-0199 are lost.
    * After a request reaches (312) 555-0197, DOC1 (K0003, thin note) comes back
      `sign_delay_business_days` later at 11:40. Default 2 matches the html timeline
      (reached Tue 09:40, "Dr. Chen's in clinic tomorrow", order dated Wed, fax Thu 11:40).
    * After a correction request (a second request to 0197 once DOC1 is out, or
      `note_correction_requested` from the office call), DOC2 comes back the next
      business day at 10:15.
    """

    def __init__(self, now: Clock, *, sign_delay_business_days: int = 2,
                 signed_at: time = time(11, 40), corrected_at: time = time(10, 15)) -> None:
        self.now = now
        self.sign_delay = sign_delay_business_days
        self.signed_at = signed_at
        self.corrected_at = corrected_at
        self.received: list[FaxDocument] = []
        self.lost: list[FaxDocument] = []
        self.reached_at: datetime | None = None
        self.correction_at: datetime | None = None
        self.doc1_sent = False
        self.doc2_sent = False

    def request_reached(self) -> bool:
        return self.reached_at is not None

    def note_correction_requested(self, at: datetime) -> None:
        if self.doc1_sent and self.correction_at is None:
            self.correction_at = at

    async def receive_request(self, request: FaxDocument) -> None:
        if not _digits(request.to).endswith(_digits(NEW_FAX)):
            self.lost.append(request)        # old number: goes nowhere
            return
        self.received.append(request)
        if self.doc1_sent:
            self.note_correction_requested(request.sent_at)
        elif self.reached_at is None:
            self.reached_at = request.sent_at

    def _due(self, start: datetime, days: int, at: time) -> datetime:
        return datetime.combine(add_business_days(start.date(), days), at)

    async def next_signed_order(self) -> str | None:
        now = self.now()
        if self.reached_at and not self.doc1_sent and now >= self._due(self.reached_at, self.sign_delay, self.signed_at):
            self.doc1_sent = True
            return DOC1
        if self.correction_at and not self.doc2_sent and now >= self._due(self.correction_at, 1, self.corrected_at):
            self.doc2_sent = True
            return DOC2
        return None


class OfficePersona(PersonaParty):
    """Sunrise Family Medicine: the front desk, or Maria once a request has landed."""

    kind: PartyKind = "office"

    def __init__(self, *, llm: LLM, now: Clock, fax_desk: AutopilotFaxDesk,
                 id: str = "sunrise", name: str = "Sunrise Family Medicine") -> None:
        super().__init__(id=id, name=name, llm=llm, now=now)
        self.fax_desk = fax_desk

    def available(self, goal: CallGoal) -> bool:
        now = self.now()
        return is_business_day(now.date()) and time(8, 0) <= now.time() < time(17, 0)

    def on_answer(self, goal: CallGoal) -> None:
        if goal.purpose == "office_correction":
            self.fax_desk.note_correction_requested(self.now())

    def speaker_names(self) -> tuple[str, ...]:
        return ("Maria", "Front desk", self.name)

    def _is_maria(self) -> bool:
        return self.fax_desk.request_reached()

    def persona(self) -> str:
        if self._is_maria():
            return ("You are Maria at Sunrise Family Medicine, Dr. Sarah Chen's practice. You handle all the "
                    "medical-equipment paperwork. Organised, friendly, brief.")
        return ("You work the front desk at Sunrise Family Medicine, Dr. Sarah Chen's practice. Busy phones, "
                "helpful but brisk.")

    def situation(self, goal: CallGoal) -> str:
        today = self.now().date()
        if goal.purpose == "office_correction":
            return ("You have the signed wheelchair order Dr. Chen sent back. The caller will point out problems "
                    "with it.\n\nWhat you'd say: if they mention the code is K0003 but should be K0001: Our EHR "
                    "defaults to K0003, I'll fix that. If they mention the checklist or the note: I'll show her "
                    f"the checklist. She's in {spoken_day(add_business_days(today, 1), today)} morning. "
                    "You don't decide clinical questions; Dr. Chen does.")
        if not self.fax_desk.request_reached():
            return ("Nothing has come in by fax about a wheelchair order for this patient.\n\nWhat you'd say: "
                    "I don't see anything from yesterday. Which number did you use? Once you hear (or if they "
                    f"can't say) the number: if it was {OLD_FAX[-4:]}, that's the old fax. Use {NEW_FAX[-4:]} "
                    f"(the full number is {NEW_FAX}), and put it to Maria's attention. She does all the "
                    "equipment paperwork.")
        clinic = spoken_day(add_business_days(today, 1), today)
        return ("The wheelchair order request is on your desk now.\n\nWhat you'd say: Got it, it's here now. "
                f"Dr. Chen's in clinic {clinic}, I'll put it in front of her.")


# ---------------------------------------------------------------------------
# Eleanor
# ---------------------------------------------------------------------------


class PatientPersona(PersonaParty):
    """Eleanor Martinez (spec §11). Call `note_advocate_call()` once a care advocate has
    spoken with her (the human-decision step); after that she is reassured."""

    kind: PartyKind = "patient"

    def __init__(self, *, llm: LLM, now: Clock, id: str = "eleanor", name: str = "Eleanor Martinez") -> None:
        super().__init__(id=id, name=name, llm=llm, now=now)
        self.consent_calls = 0
        self.missed_delivery = False
        self.advocate_called = False

    def note_advocate_call(self) -> None:
        self.advocate_called = True

    def available(self, goal: CallGoal) -> bool:
        return time(8, 30) <= self.now().time() < time(20, 0)

    def on_answer(self, goal: CallGoal) -> None:
        if goal.purpose == "patient_consent":
            self.consent_calls += 1
        if goal.purpose == "patient_delivery_check" and not self.advocate_called:
            self.missed_delivery = True

    def persona(self) -> str:
        return (
            "You are Eleanor Martinez, 78, a retired school librarian living alone in Chicago. Kind, polite, a "
            "little hard of hearing: if the caller asks several things at once you may only answer the part you "
            "caught. You are best in the mornings. Your daughter Rosa helps you. Your doctor, Dr. Chen, said at "
            "your visit last Friday that you should get a wheelchair, because walking to the bathroom wears you "
            "out.\n\nPrivate facts (share only when asked):\n"
            "- Address: 2236 North Seminary, second floor; there's an elevator.\n"
            "- Medicare number on your card: 1EG4-TE5-MK73.\n"
            "- You had your knee done in March. After it you only used a walker, never a wheelchair. You still use the walker.\n"
            "- Deductible this year: you think it's probably met because of the knee surgery, but you aren't sure.\n"
            "- Best time to call: mornings."
        )

    def situation(self, goal: CallGoal) -> str:
        if goal.purpose == "patient_intro":
            return ("This is the first call about the wheelchair.\n\nWhat you'd say, when asked:\n"
                    "- address: 2236 North Seminary, second floor, there's an elevator.\n"
                    "- Medicare number: The number is 1EG4-TE5-MK73.\n"
                    "- deductible met?: I had my knee done in March, so probably.\n"
                    "- wheelchair after the surgery?: Just the walker. I still use it.\n"
                    "- best time: Mornings.")
        if goal.purpose == "patient_consent":
            if self.advocate_called or not self.missed_delivery:
                return ("They're asking if a supplier can bring your chair at a certain time. You're happy with it."
                        "\n\nWhat you'd say: That's fine. [the day they said] works. My daughter Rosa will be here.")
            return ("Yesterday a supplier was supposed to bring the chair and nobody came; Rosa took the "
                    "afternoon off for nothing. This week you also got a $1,400 bill from the knee surgery, and "
                    "you're worried about money.\n\nWhat you'd say when they ask about a new supplier: Honestly, "
                    "I don't know if I want to keep doing this. I just got a bill for fourteen hundred dollars from "
                    "the knee surgery. I can't take on another bill every month. Maybe I'll just manage with the "
                    "walker.\nIf they offer to have someone from the care team call you: I suppose.\n"
                    "Don't agree to the new supplier on this call.")
        if goal.purpose == "patient_delivery_check":
            if self.advocate_called:
                return ("The chair came this morning; the driver showed Rosa how to fold it.\n\n"
                        "What you'd say: It's here. The driver showed Rosa how to fold it.")
            return ("Nobody came with the chair this afternoon. Rosa took the afternoon off for it.\n\n"
                    "What you'd say: No. Nobody came. Rosa took the afternoon off for this.")
        return "You're not sure what this call is about; ask them gently."


# ---------------------------------------------------------------------------
# Convenience: the whole autopilot cast for one case
# ---------------------------------------------------------------------------


class AutopilotCast:
    """All autopilot parties for Eleanor's case, sharing one clock and one fax desk.
    `get(kind, party_id)` matches PartyProvider.get; any office/patient id returns the
    single office / patient persona."""

    def __init__(self, *, llm: LLM, now: Clock) -> None:
        self.fax_desk = AutopilotFaxDesk(now)
        self.office = OfficePersona(llm=llm, now=now, fax_desk=self.fax_desk)
        self.patient = PatientPersona(llm=llm, now=now)
        self.suppliers = {sid: SupplierPersona(sid, llm=llm, now=now) for sid in SUPPLIER_NAMES}

    def get(self, kind: PartyKind, party_id: str) -> PersonaParty:
        if kind == "supplier":
            return self.suppliers[party_id]
        return self.office if kind == "office" else self.patient
