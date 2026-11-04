# DME Coordination Engine

Prototype for the DME back-end coordination take-home. An engine runs a Medicare
durable-medical-equipment case (Eleanor Martinez, standard manual wheelchair, K0001)
from "intake done" to "delivered and billed right". It calls suppliers, the doctor's
office and Eleanor, and hands the case to a person only for one of ten named reasons.

**The model only listens and talks. Plain code makes every decision.**

- Writeup: [`docs/writeup.md`](docs/writeup.md)
- Design spec (states, timers, Medicare sources, decisions D1–D15): [`docs/state-machine.md`](docs/state-machine.md)
- Design page: [`docs/state-machine.html`](docs/state-machine.html)

## Run the demo

Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
export DME_ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_API_KEY; only needed for live runs
./run.sh                                   # builds the UI once, then serves http://localhost:8000
```

Open http://localhost:8000 and pick one of these:

- **Watch a real run.** This is a recorded live run: real Claude calls, every call, fax
  and decision. It needs no key and no network. Tick "Read the calls aloud" to hear it.
  It pauses when the case needs a person.
- **Run it live.** Real model calls. Tick the parties you want to play yourself:
  - **the supplier, Eleanor or the office:** your phone rings, and the doctor's office gets a fax composer;
  - **the care advocate:** you decide the hand-offs.

  Everyone else is an LLM persona with hidden facts. A run costs about $1 and is
  hard-capped by `DME_BUDGET_USD` (default $3) and 60 calls.

**"How it decided"** (top right) shows the rule that fired, every state machine with the
path taken, and the supplier board. Open any call to see the transcript next to the facts
the model extracted, each with the exact quote it rests on.

Without a key, the replay works and `?mock=1` gives a scripted practice mode.

## Other ways to run it

```bash
cd backend
uv run python -m dme.cli --verbose        # whole case in the terminal, all parties on autopilot
uv run pytest -q -m "not live"            # 89 tests: rules, transitions, every escalation path, e2e
uv run pytest -q -m live                  # 6 tests against the real API, incl. prompt injection
```

## What's mocked, what's real

| Mocked | Real |
|---|---|
| Phone calls are text. The other side is an LLM persona or you | Every LLM call (Claude Sonnet as the caller and extractor, Haiku for personas) |
| Faxes are documents | The rules, the order validator and the cost math |
| The clock is simulated: business days, 9–6 calling hours, Veterans Day closed | Medicare facts (LCD L33788, SWO elements, the $34.27 fee in her ZIP), cited in the spec |
| Suppliers' eligibility checks are answered by the supplier persona | The supplier directory from the brief |
| The other patients in the queue are labeled placeholders | |

State lives in memory, so restarting the server ends the run.
