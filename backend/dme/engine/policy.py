"""Timer values and policy constants (spec §10, D9, D13), plus label helpers.
Product policy lives here so nobody mistakes it for a Medicare rule."""

from __future__ import annotations

from datetime import datetime, timedelta

# request goes there and is lost; the office follow-up call yields the right one.
INTAKE_OFFICE_FAX = "(312) 555-0199"
ENGINE_FAX = "care team (engine)"

IN_FLIGHT = 3                                    # §10: supplier candidates in flight
POD_CHASES = 4   # proof-of-delivery calls after she confirms delivery, then a person
RETRY_DELAYS = [timedelta(hours=4), 1, 2]        # §10: +4h, +1 bd, +2 bd (ints = business days)
MAX_RETRIES = 3                                  # §5: a candidate missing every retry is UNREACHABLE
PATIENT_MAX_TRIES = 4                            # §7: 4 tries over 3 business days
RECONFIRM_BUSINESS_DAYS = 5                      # §10
ACK_BUSINESS_DAYS = 1                            # §10
SIGNATURE_BUSINESS_DAYS = 3                      # §10
MAX_NUDGES = 3                                   # §10
MAX_CORRECTION_LOOPS = 2                         # §10
ADVOCATE_TURNAROUND = timedelta(minutes=90)      # assumption: queue answers ~90 min into a working slot
CALL_MINUTES = {"answered": 2, "voicemail": 1, "no_answer": 1, "hung_up": 1}
POLL_EVERY = timedelta(hours=1)                  # how often the engine checks its fax inbox

WAITING_FOR_FAX = {"REQUESTED", "NUDGE", "ACKNOWLEDGED", "CORRECTION_REQUESTED"}



def fmt_day(dt: datetime) -> str:
    return f"{dt:%a} {dt:%b} {dt.day}"


def fmt_time(dt: datetime) -> str:
    return f"{fmt_day(dt)} {dt:%H:%M}"
