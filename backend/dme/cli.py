"""Run Eleanor's case headless, every seat on autopilot, and print the timeline.

    uv run python -m dme.cli            # transcripts summarized
    uv run python -m dme.cli --verbose  # every line of every call

Real LLM calls (needs ANTHROPIC_API_KEY). Takes a few minutes: about 25 calls.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

from dme.server.session import Session

DIM, BOLD, PINK, BLUE, TEAL, RESET = "\033[2m", "\033[1m", "\033[35m", "\033[34m", "\033[36m", "\033[0m"


async def main(verbose: bool, out: Path | None) -> int:
    started = time.monotonic()
    log: list[dict[str, Any]] = []

    async def printer(msg: dict[str, Any]) -> None:
        log.append(msg)
        t = msg.get("type")
        if t == "event":
            ev = msg["event"]
            when = ev["at"][5:16].replace("T", " ")
            color = PINK if ev["kind"] in ("escalation", "human") else BLUE if ev["kind"] in ("call", "fax") else ""
            moves = ", ".join(f"{x['entity']}:{x['frm']}→{x['to']}" for x in ev.get("transitions", []))
            print(f"{DIM}{when}{RESET} {color}{BOLD}{ev['kind']:<10}{RESET} {ev['title']}")
            print(f"{'':17}{DIM}{ev['detail']}{RESET}")
            if moves:
                print(f"{'':17}{TEAL}{moves}{RESET}")
        elif t == "utterance" and verbose:
            who = "Engine" if msg["speaker"] == "engine" else "Party "
            print(f"{'':19}{DIM}{who}: {msg['text']}{RESET}")
        elif t == "escalation" and not msg["escalation"].get("decision"):
            e = msg["escalation"]
            print(f"{PINK}{BOLD}{'':17}ESCALATION {e['code']}: {e['question']}{RESET}")
        elif t == "error":
            print(f"{PINK}ERROR {msg['message']}{RESET}")

    session = Session(emit=printer)
    session.seats.update({"supplier": "auto", "office": "auto", "patient": "auto", "advocate": "auto"})
    session._build()  # rebuild with the all-autopilot seats
    session.engine.set_pace(0)
    await session.engine.run()

    snap = session.engine.snapshot()
    mins = (time.monotonic() - started) / 60
    calls = len(snap.calls)
    print(f"\n{BOLD}Final:{RESET} case {snap.case_state} · order {snap.order_state} · patient {snap.patient_state}")
    print(f"{calls} calls · {len(snap.escalations)} escalation(s) · sim {snap.now:%a %b %d %H:%M} · {mins:.1f} real minutes")
    if out:
        out.write_text(json.dumps({"snapshot": snap.model_dump(mode="json"), "messages": log}, indent=1, default=str))
        print(f"Wrote {out}")
    return 0 if snap.case_state == "CLOSED" else 1


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--verbose", "-v", action="store_true", help="print every line of every call")
    p.add_argument("--out", type=Path, help="write the full run (snapshot + messages) as JSON")
    a = p.parse_args()
    sys.exit(asyncio.run(main(a.verbose, a.out)))
