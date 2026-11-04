#!/usr/bin/env python3
"""Slim a recorded engine run into a replay file for the frontend's ReplayEngine.

Usage: python3 scripts/slim_replay.py [../runs/live-3.json] [public/replays/eleanor.json]

Input:  {snapshot: CaseSnapshot, messages: ServerMsg[]}  (as written by the live runner)
Output: {meta: {...}, messages: ServerMsg[]}

Intermediate snapshots drop their `calls` map (the frontend reducer builds live calls
from call_started / utterance / facts / call_ended); only the final snapshot keeps it.

Snapshot `events` and `faxes` grow monotonically and are always a prefix / subset of the
final snapshot's, so intermediate snapshots store references instead of copies:
    "events_upto": n          -> events = final.events[:n]
    "fax_ids": ["fax-001"]    -> faxes  = {id: final.faxes[id]}
ReplayEngine (src/lib/replay.ts) re-inflates them before emitting, so the reducer sees
ordinary full snapshots. The script verifies the prefix/subset property and falls back
to inline copies for any snapshot where it doesn't hold.

Everything else (escalations, suppliers, states, next_check, cost, now) stays inline.
Seats are rewritten to all "auto" since the recorded run was fully automatic and a
replay is read-only.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_IN = os.path.join(HERE, "..", "..", "runs", "live-3.json")
DEFAULT_OUT = os.path.join(HERE, "..", "public", "replays", "eleanor.json")
AUTO_SEATS = {"supplier": "auto", "office": "auto", "patient": "auto", "advocate": "auto"}


def slim(run: dict, recorded_at: str) -> dict:
    msgs = run["messages"]
    snap_idx = [i for i, m in enumerate(msgs) if m["type"] == "snapshot"]
    if not snap_idx:
        raise SystemExit("run has no snapshot messages")
    last = snap_idx[-1]
    final_events = msgs[last]["case"]["events"]
    final_faxes = msgs[last]["case"]["faxes"]
    out = []
    for i, m in enumerate(msgs):
        if m["type"] == "snapshot":
            case = dict(m["case"])
            case["seats"] = dict(AUTO_SEATS)
            if i != last:
                case["calls"] = {}
                ev = case["events"]
                if ev == final_events[: len(ev)]:
                    del case["events"]
                    case["events_upto"] = len(ev)
                fx = case["faxes"]
                if all(final_faxes.get(k) == v for k, v in fx.items()):
                    del case["faxes"]
                    case["fax_ids"] = list(fx)
                # the run is still going until the final pair of snapshots says done
                case["running"] = not case.get("done", False)
            else:
                case["running"] = False
                case["done"] = True
            m = {"type": "snapshot", "case": case}
        out.append(m)

    first = msgs[snap_idx[0]]["case"]
    final = out[last]["case"]
    calls = sum(1 for m in msgs if m["type"] == "call_started")
    meta = {
        "title": f"{final['patient']['name']}: {final['patient']['equipment']}",
        "recorded_at": recorded_at,
        "calls": calls,
        "escalations": len(final["escalations"]),
        "final_state": final["case_state"],
        "sim_start": first["now"],
        "sim_end": final["now"],
        "api_spend_usd": float(os.environ.get("SPEND_USD", "0")) or None,  # from the CLI's "~$X API spend" line
        "note": (
            "A recorded live run: every call, fax and decision was made by the real engine "
            "and LLM-played parties, with all seats on autopilot (including the advocate, "
            "who answered the cost-concern escalation). Replay is read-only."
        ),
    }
    return {"meta": meta, "messages": out}


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IN
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    with open(src) as f:
        run = json.load(f)
    recorded_at = dt.datetime.fromtimestamp(os.path.getmtime(src)).replace(microsecond=0).isoformat()
    data = slim(run, recorded_at)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "w") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {dst}: {os.path.getsize(dst):,} bytes, {len(data['messages'])} messages")
    print(json.dumps(data["meta"], indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
