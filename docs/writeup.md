# DME back-end coordination: writeup

*Draft. Numbers and the cut list get finalized after the build.*

## What I built, and how I decided

The job is coordination, not any single call. A care advocate's skill is noticing
when something has gone quiet and working around it. So I started from the failure
modes in the brief and designed the system around them, not around the happy path.

**1. The state machine first.** Before writing code I modeled the case as three
threads that run in parallel (supplier, order, patient) and one join that hands off
to delivery only when all three are ready. Every state, timer and escalation is in
`docs/state-machine.md`, with the Medicare rules it depends on checked against
primary sources (coverage criteria, order elements, the real rental fee for her ZIP,
the order-before-delivery list). That spec is what the code implements.

**2. Then the engine, with no AI in it.** Transitions, timers, a business-day
calendar, supplier qualification, the order validator and the cost math are plain
Python with tests. A scripted end-to-end test runs Eleanor's whole case and checks
that it closes with exactly one escalation.

**3. Then the LLM, only where language is messy.** The LLM writes what the engine
says on a call, and turns what the other side says into facts. Every fact must carry
a verbatim quote, and code checks the quote is really in the transcript. No quote
means unknown. The rules never see a fact the transcript can't back up.

**4. Then the demo.** Every outside party is a "seat" you can hand to an LLM persona
or take yourself in the browser. The engine can't tell the difference, which is the
same position it's in with real phone calls.

The demo run hits all five failure modes in the brief. The engine recovers from four
on its own: suppliers that can't serve her, a supplier that says yes and ghosts, an
order request lost to a wrong fax number, and an order with the wrong code. The fifth,
Eleanor wavering over cost, goes to a person on purpose.

## Technology and architecture

| Piece | Choice | Why |
|---|---|---|
| Engine | Python, hand-written state machines, a simulated clock | The coordination logic is the product. It should be readable, testable and impossible for a model to steer |
| LLM | Anthropic SDK, Claude Sonnet for the caller and extraction, Haiku for personas | Real calls, forced structured output for facts |
| Grounding | Quote-per-fact plus string verification | Self-reported model confidence isn't calibrated. A quote is checkable |
| Server | FastAPI + one WebSocket | Live two-way demo: the engine waits on a person exactly like it waits on a phone |
| UI | React + Vite + Tailwind | The demo vehicle, not the product |
| Not used | LangGraph / CrewAI-style agent frameworks | They let the model drive the workflow. Here rules drive it and the model only reads and writes language |

How a call works:

```
engine picks the next action ─► caller LLM speaks ─► party replies (persona or you)
   ▲                                                         │
   └── timer ◄── transition ◄── rules ◄── facts + verified quotes (LLM extraction)
```

Where AI is deliberately kept out: deciding anything, validating the order, computing
what she owes, timers and escalation triggers, and anything clinical. The engine names
which coverage criteria a visit note doesn't address, but never writes medical-necessity
text. Income and cost conversations go to a person.

## The cut list

- **Real voice and fax.** Calls are text and faxes are documents. The call layer has
  one interface, so a voice agent (e.g. ElevenLabs over Twilio) slots in without
  touching the engine.
- **Durable execution.** State lives in memory per demo session. Production needs
  durable timers that survive restarts (see What's next).
- **Escalation paths that don't fire in the demo** (unsigned order, clinical fix,
  documentation, unreachable, eligibility conflict) are specified and tested at the
  rules level but have no dedicated scenario.
- **Monthly rental oversight, repairs, appeals, Medicare Advantage, power mobility.**
- **Auth, persistence, multi-case scheduling.**

## What's next

**With one more day:** a scenario switcher that runs each escalation path end to end;
an evaluation harness that replays many persona variations (evasive suppliers, angry
patients, injection attempts) and scores extraction accuracy and wrong transitions;
and real voice on the patient calls, since that's where tone matters most.

**With two weeks:** move the engine onto a durable workflow runtime (Temporal) so
multi-day timers survive deploys. Add a supplier memory that learns who answers,
who ghosts and who stocks what. Integrate e-fax and the practice portals. Then shadow
real care advocates on live cases, with the engine proposing and the advocate
approving, to measure where it's wrong before it acts alone.

**Why that order:** evaluation before voice, because a convincing voice on top of
wrong extraction is worse than text. Durability before scale, because a case that
loses its timers is a patient who never gets called back.
