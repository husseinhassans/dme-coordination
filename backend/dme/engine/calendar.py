"""Business-day calendar and the simulated clock (spec D13, D14, §10).

One calendar serves every thread: business days are Mon-Fri minus US federal holidays.
The simulated clock never runs in real time. It jumps from one scheduled action to
the next, popped from a heap ordered by (sim_time, seq).
"""

from __future__ import annotations

import heapq
import itertools
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Awaitable, Callable

# US federal holidays, observed dates (a Saturday holiday is observed Friday,
# a Sunday holiday Monday). Spec D14: the demo crosses Veterans Day, Wed 2026-11-11.
FEDERAL_HOLIDAYS: frozenset[date] = frozenset({
    # 2026
    date(2026, 1, 1),    # New Year's Day
    date(2026, 1, 19),   # Martin Luther King Jr. Day
    date(2026, 2, 16),   # Washington's Birthday
    date(2026, 5, 25),   # Memorial Day
    date(2026, 6, 19),   # Juneteenth
    date(2026, 7, 3),    # Independence Day (Jul 4 is a Saturday)
    date(2026, 9, 7),    # Labor Day
    date(2026, 10, 12),  # Columbus Day
    date(2026, 11, 11),  # Veterans Day
    date(2026, 11, 26),  # Thanksgiving
    date(2026, 12, 25),  # Christmas
    # 2027
    date(2027, 1, 1),    # New Year's Day
    date(2027, 1, 18),   # Martin Luther King Jr. Day
    date(2027, 2, 15),   # Washington's Birthday
    date(2027, 5, 31),   # Memorial Day
    date(2027, 6, 18),   # Juneteenth (Jun 19 is a Saturday)
    date(2027, 7, 5),    # Independence Day (Jul 4 is a Sunday)
    date(2027, 9, 6),    # Labor Day
    date(2027, 10, 11),  # Columbus Day
    date(2027, 11, 11),  # Veterans Day
    date(2027, 11, 25),  # Thanksgiving
    date(2027, 12, 24),  # Christmas (Dec 25 is a Saturday)
    date(2027, 12, 31),  # New Year's Day 2028 (Jan 1 is a Saturday)
})

BUSINESS_OPEN = time(9, 0)
BUSINESS_CLOSE = time(17, 0)   # end of business day: the ghost threshold (§10)
CALL_OPEN = time(9, 0)         # D13: calls to parties 09:00-18:00 local
CALL_CLOSE = time(18, 0)


def _as_date(d: date | datetime) -> date:
    return d.date() if isinstance(d, datetime) else d


def is_business_day(d: date | datetime) -> bool:
    """D14: Mon-Fri and not a federal holiday."""
    day = _as_date(d)
    return day.weekday() < 5 and day not in FEDERAL_HOLIDAYS


def next_business_day(d: date | datetime) -> date:
    """The first business day strictly after `d`."""
    day = _as_date(d) + timedelta(days=1)
    while not is_business_day(day):
        day += timedelta(days=1)
    return day


def add_business_days(start: datetime, n: int) -> datetime:
    """Move `n` business days forward, keeping the time of day.
    Starting on a non-business day counts from the next business day."""
    day = start.date()
    for _ in range(n):
        day = next_business_day(day)
    return datetime.combine(day, start.time())


def end_of_business_day(d: date | datetime) -> datetime:
    return datetime.combine(_as_date(d), BUSINESS_CLOSE)


def business_days_inclusive(first: date | datetime, last: date | datetime) -> int:
    """Count business days in [first, last]. Mon Nov 2 → Thu Nov 12, 2026 is 8."""
    day, end, count = _as_date(first), _as_date(last), 0
    while day <= end:
        count += is_business_day(day)
        day += timedelta(days=1)
    return count


def call_slot(at: datetime) -> datetime:
    """D13: earliest moment at or after `at` when a party may be called
    (a business day, 09:00-18:00 local)."""
    if is_business_day(at) and CALL_OPEN <= at.time() < CALL_CLOSE:
        return at
    day = at.date() if (is_business_day(at) and at.time() < CALL_OPEN) else next_business_day(at)
    return datetime.combine(day, CALL_OPEN)


def advocate_slot(at: datetime) -> datetime:
    """D14: the internal care-advocate queue is worked every weekday, holidays
    included, 09:00-17:00."""
    if at.weekday() < 5 and BUSINESS_OPEN <= at.time() < BUSINESS_CLOSE:
        return at
    day = at.date() if (at.weekday() < 5 and at.time() < BUSINESS_OPEN) else at.date() + timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return datetime.combine(day, BUSINESS_OPEN)


# ---------------------------------------------------------------------------
# Delivery windows stated on calls ("Mon Nov 9, 13:00-16:00", "Thursday morning")
# ---------------------------------------------------------------------------

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
_WEEKDAYS = {d: i for i, d in enumerate(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])}
_ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_MONTH_DAY = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b")
_WEEKDAY = re.compile(r"\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b")
_TIME = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b")


def parse_window(text: str, ref: datetime) -> tuple[datetime, datetime] | None:
    """Best-effort parse of a stated delivery day + window. Returns None when no day
    can be found. No time → 09:00-17:00; one time → a 2-hour window from it."""
    s = text.lower()
    day: date | None = None
    if m := _ISO.search(s):
        day = date(int(m[1]), int(m[2]), int(m[3]))
        s = s[:m.start()] + s[m.end():]
    elif m := _MONTH_DAY.search(s):
        day = date(ref.year, _MONTHS[m[1]], int(m[2]))
        if day < ref.date() - timedelta(days=30):
            day = date(ref.year + 1, day.month, day.day)
        s = s[:m.start()] + s[m.end():]
    elif m := _WEEKDAY.search(s):
        ahead = (_WEEKDAYS[m[1]] - ref.weekday()) % 7
        day = ref.date() + timedelta(days=ahead)
    elif "tomorrow" in s:
        day = ref.date() + timedelta(days=1)
    elif "today" in s:
        day = ref.date()
    if day is None:
        return None

    hours: list[time] = []
    for m in _TIME.finditer(s):
        hour, minute, ampm = int(m[1]), int(m[2] or 0), m[3]
        if hour > 23 or minute > 59:
            continue
        if ampm == "pm" and hour < 12:
            hour += 12
        elif ampm is None and 1 <= hour <= 6:
            hour += 12   # "1-4" on a delivery call means the afternoon
        hours.append(time(hour, minute))
    if len(hours) >= 2:
        start, end = hours[0], hours[1]
    elif len(hours) == 1:
        start = hours[0]
        end = (datetime.combine(day, start) + timedelta(hours=2)).time()
    elif "morning" in s or " am" in s:
        start, end = time(9, 0), time(12, 0)
    elif "afternoon" in s:
        start, end = time(13, 0), time(17, 0)
    else:
        start, end = BUSINESS_OPEN, BUSINESS_CLOSE
    return datetime.combine(day, start), datetime.combine(day, end)


# ---------------------------------------------------------------------------
# Simulated clock with a timer queue
# ---------------------------------------------------------------------------

Action = Callable[[], Awaitable[None]]


@dataclass
class Timer:
    at: datetime
    label: str
    action: Action
    cancelled: bool = False

    def cancel(self) -> None:
        self.cancelled = True


@dataclass(order=True)
class _Entry:
    at: datetime
    seq: int
    timer: Timer = field(compare=False)


class SimClock:
    """Simulated time. `schedule` pushes (sim_time, seq, action) on a heap; `pop_next`
    returns the earliest live timer and jumps the clock to it. The clock never moves
    backwards: an action due in the past runs at the current time."""

    def __init__(self, start: datetime) -> None:
        self.now = start
        self._heap: list[_Entry] = []
        self._seq = itertools.count()

    def schedule(self, at: datetime, action: Action, label: str = "") -> Timer:
        timer = Timer(at=at, label=label, action=action)
        heapq.heappush(self._heap, _Entry(at, next(self._seq), timer))
        return timer

    def advance(self, delta: timedelta) -> None:
        self.now += delta

    def pop_next(self) -> Timer | None:
        while self._heap:
            entry = heapq.heappop(self._heap)
            if entry.timer.cancelled:
                continue
            self.now = max(self.now, entry.at)
            return entry.timer
        return None

    def pending(self) -> list[Timer]:
        return [e.timer for e in sorted(self._heap) if not e.timer.cancelled]
