# DME Coordination Engine

Prototype for the DME back-end coordination take-home. An engine runs a Medicare
durable-medical-equipment case (Eleanor Martinez, standard manual wheelchair, K0001)
from "intake done" to "delivered and billed right", calling suppliers, the doctor's
office and the patient itself, and handing the case to a person only for ten named reasons.

The demo is interactive: every outside party is a "seat" that runs on autopilot (an
LLM playing the part with hidden facts) or that you take over in the browser.

- Design spec: [`docs/state-machine.md`](docs/state-machine.md)
- Design page: [`docs/state-machine.html`](docs/state-machine.html)
- Brief: [`docs/assignment.md`](docs/assignment.md)

Run instructions: coming with the build.
