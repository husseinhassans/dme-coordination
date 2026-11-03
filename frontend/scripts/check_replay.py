#!/usr/bin/env python3
"""Sanity-check a replay file: python3 scripts/check_replay.py [public/replays/eleanor.json]"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "public", "replays", "eleanor.json")
data = json.load(open(path))
meta, msgs = data["meta"], data["messages"]
errors = []

snaps = [(i, m["case"]) for i, m in enumerate(msgs) if m["type"] == "snapshot"]
if not snaps:
    sys.exit("no snapshots")
last_i, final = snaps[-1]
if last_i != len(msgs) - 1:
    errors.append(f"last message is {msgs[-1]['type']}, not the final snapshot")
if final.get("case_state") != "CLOSED":
    errors.append(f"final case_state {final.get('case_state')}")
if not final.get("done") or final.get("running"):
    errors.append("final snapshot should be done and not running")
if "events" not in final or "faxes" not in final or not final.get("calls"):
    errors.append("final snapshot must carry full events, faxes and calls")

# same inflation as ReplayEngine
def inflate(c):
    ev = c["events"] if "events" in c else final["events"][: c.get("events_upto", 0)]
    fx = c["faxes"] if "faxes" in c else {k: final["faxes"][k] for k in c.get("fax_ids", [])}
    return ev, fx

started, ended, seen_events, seen_faxes = set(), set(), [], set()
prev_now, prev_events = "", -1
for i, m in enumerate(msgs):
    t = m["type"]
    if t == "call_started":
        if m["call_id"] in started:
            errors.append(f"#{i} duplicate call_started {m['call_id']}")
        started.add(m["call_id"])
    elif t in ("utterance", "facts", "call_ended"):
        if m["call_id"] not in started:
            errors.append(f"#{i} {t} for {m['call_id']} before call_started")
        if m["call_id"] in ended:
            errors.append(f"#{i} {t} for {m['call_id']} after call_ended")
        if t == "call_ended":
            ended.add(m["call_id"])
    elif t == "event":
        seen_events.append(m["event"]["id"])
    elif t == "fax":
        seen_faxes.add(m["fax"]["id"])
    elif t == "snapshot":
        c = m["case"]
        ev, fx = inflate(c)
        if c["now"] < prev_now:
            errors.append(f"#{i} sim clock went backwards {prev_now} -> {c['now']}")
        if len(ev) < prev_events:
            errors.append(f"#{i} events shrank")
        ids = {e["id"] for e in ev}
        missing = [e for e in seen_events if e not in ids]
        if missing:
            errors.append(f"#{i} snapshot lacks already-emitted events {missing}")
        if seen_faxes - set(fx):
            errors.append(f"#{i} snapshot lacks already-emitted faxes {seen_faxes - set(fx)}")
        if set(c["seats"].values()) != {"auto"} or set(c["seats"]) != {"supplier", "office", "patient", "advocate"}:
            errors.append(f"#{i} seats not all auto: {c['seats']}")
        if i != last_i and c.get("calls"):
            errors.append(f"#{i} intermediate snapshot still has calls")
        prev_now, prev_events = c["now"], len(ev)

if started - ended:
    errors.append(f"calls never ended: {sorted(started - ended)}")
if len(started) != meta["calls"]:
    errors.append(f"meta.calls {meta['calls']} != {len(started)} call_started")
if len(final["escalations"]) != meta["escalations"]:
    errors.append("meta.escalations mismatch")
if set(final["calls"]) != started:
    errors.append("final snapshot calls != call_started ids")

size = os.path.getsize(path)
print(f"{path}: {size:,} bytes, {len(msgs)} messages, {len(snaps)} snapshots, {len(started)} calls")
if errors:
    print("\n".join("FAIL " + e for e in errors))
    sys.exit(1)
print("OK")
