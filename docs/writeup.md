# DME back-end coordination: writeup

## What I built, and how I decided

The job is coordination, not any single call. A care advocate's skill is noticing when
something has gone quiet and working around it. So I designed from the brief's five
failure modes, not from the happy path, and built in this order.

**1. The state machine, on paper.** I modeled the case as three threads running in
parallel (supplier, order, patient) and one join. The join schedules delivery only when
all three are ready: a confirmed supplier, a validated signed order at that supplier, and
Eleanor's consent to both the supplier and the window. Every state, timer and escalation
is in `docs/state-machine.md`. The Medicare rules it depends on are checked against
primary sources: LCD L33788 criteria, the six order elements, the $34.27 rental fee in
her ZIP, and the fact that K0001 is not on the order-before-delivery list.

**2. The engine, with no AI in it.** Transitions, timers, a business-day calendar,
supplier qualification, the order validator and the cost math are plain Python with tests.

**3. The LLM, only where language is messy.** It does three jobs:
- It writes the assistant's lines on a call.
- It turns what the other side says, or what a fax says, into facts.
- It plays the other parties in the demo.

Every fact must carry a verbatim quote. Code checks that quote against the other party's
words only, so the assistant can't quote itself. No match means unknown, and rules never
act on an unknown. Every call also gets a **case file**: the engine's record of the case,
rendered in plain sentences and filtered to what that party may hear (minimum necessary).
The caller answers questions from it, such as what she'll pay or what happened with the
last supplier. Nothing in it comes from a model.

**4. The demo.** Every outside party is a seat. An LLM persona with hidden facts can
fill it, or a reviewer can, from the browser. The engine can't tell the difference, which
is the position it's in with real phone calls.

The demo run hits all five failure modes. The engine recovers from four on its own:
- **Suppliers that can't serve her:** one isn't taking new Medicare patients, one has no
  K0001 in stock, one won't accept assignment.
- **A request lost to an outdated fax number.**
- **A signed order coded K0003 for a standard chair**, with two coverage criteria
  unaddressed.
- **A supplier that confirms, misses delivery and goes silent.** The engine checks the
  backup before the no-show deadline, then withdraws the referral in writing.

The fifth, Eleanor wavering over cost, goes to a person on purpose. Income, benefits
screening (QMB) and a patient deciding whether she can afford care need trust and
judgment, so the engine hands over a briefing instead of trying to persuade her.

Full live runs found three bugs the scripted tests missed:
- A corrected order was checked without the original visit note, so it was wrongly
  rejected.
- A retry loop ran to 184 calls. That's why there's now a dollar cap and a call cap.
- A supplier was marked a no-show after Eleanor had already said the chair arrived.

A test where I played Eleanor found two more gaps. The assistant couldn't answer "how
much was it again?", which is why the case file exists. And it promised a callback the
engine never scheduled.

## Technology and architecture

| Piece | Choice | Why |
|---|---|---|
| Engine | Python, hand-written state machines, a simulated clock | The workflow is the product: readable, testable, and not steerable by a model |
| LLM | Anthropic SDK. Claude Sonnet for the caller and extraction; Haiku for personas | Extraction accuracy is what rules depend on; the personas are only demo actors |
| Grounding | Quote per fact, plus string verification | Self-reported model confidence isn't calibrated. A quote is checkable |
| Case file | Rendered from engine state before each call, filtered per party | One source of truth. The model reads it and never writes it |
| Server | FastAPI + one WebSocket | The engine waits on a person in the browser exactly as it waits on a phone |
| UI | React, Vite, Tailwind; browser speech to read calls aloud | The demo vehicle, not the product |
| Guards | Per-run $ cap (from token usage), 60-call cap | A runaway loop can't spend real money |
| Not used | LangGraph / CrewAI-style agent frameworks | They let the model choose the next step. Here rules choose it |

```
engine picks the next action ─► caller LLM speaks (brief + case file) ─► party replies
   ▲                                                                          │
   └── timer ◄── transition ◄── rules ◄── facts + verified quotes (LLM extraction)
```

**Where AI is deliberately kept out:**
- every decision and transition;
- order validation and cost math;
- timers and escalation triggers;
- anything clinical. The engine names which criteria a visit note doesn't address, but
  never writes medical-necessity text.

**What's mocked:**
- Calls are text, and faxes are documents.
- The clock is simulated.
- Suppliers answer eligibility questions in persona.

**What's real:** every LLM call, the rules, the Medicare facts and the directory.

## The cut list

- **Real voice and fax.** The call layer is one interface, so a voice agent over
  telephony slots in without touching the engine. I'd do it after evaluation, not before.
- **Durable execution.** State is in memory. Production needs timers that survive a
  restart.
- **A live scenario picker.** Nine of the ten escalation paths don't fire in the demo
  run. Each has a scenario test that triggers it and checks the case recovers, but you
  can't pick one from the UI.
- **Rental-month oversight, repairs, appeals, Medicare Advantage, power mobility,
  multi-case scheduling, auth.**
- **The 3-hour box.** I went well past it, using AI heavily as allowed. The core is the
  engine plus the grounding layer (`backend/dme/engine`, `backend/dme/llm`). The UI,
  replay and read-aloud came after. With a strict 3 hours, I'd have shipped the engine
  with text calls in the terminal (`python -m dme.cli`).

## What's next

**One more day:** an evaluation harness. It would replay many persona variations
(evasive, angry, confused, injection attempts) and score extraction accuracy and wrong
transitions. Plus the scenario picker, so every escalation can be shown live.

**Two weeks:**
- Move the engine onto a durable workflow runtime (e.g. Temporal).
- Add e-fax and practice-portal integration.
- Add shared supplier memory: what one case learns about a supplier (not taking
  Medicare, out of stock, missed a delivery) informs ranking on the next nearby case,
  with an expiry per fact and no patient data.
- Run shadow mode with real care advocates: the engine proposes, the advocate approves,
  and we measure where it's wrong before it acts alone.

**Why that order:** evaluation before voice, because a convincing voice on top of wrong
extraction is worse than text. Durability before scale, because a case that loses its
timers is a patient who never gets called back.
