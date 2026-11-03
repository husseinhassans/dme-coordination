# Frontend: live demo console

Vite + React 18 + TypeScript + Tailwind 3. One screen: the engine works Eleanor's case on
a fast-forwarded clock; you can take any party's seat and answer the phone, fax the order
back as the doctor's office, or decide escalations as the care advocate.

## Run

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc + vite build → dist/
```

With the backend running, the page connects to `ws://localhost:8000/ws`.

## Mock mode

No backend needed: open `http://localhost:5173/?mock=1`. The page also falls back to mock
mode automatically if the socket can't connect within ~2 s (a "Mock mode" badge shows in
the top bar).

The mock (`src/mock/`) replays the scripted run from `docs/state-machine.html` and speaks
the exact same WebSocket protocol as the backend, so every panel is exercised. It also
reacts to your seats:

- **Eleanor / Suppliers / Office calls** ring you; your replies are read into facts with
  verbatim quotes by a small keyword reader (`src/mock/extract.ts`), with one targeted
  clarifying question when a required fact is missing. Rules then route cost worries,
  declines, safety mentions, "delivered but no ticket" and unknowns to the advocate.
- **Office fax**: the composer is prefilled with a clean order; plant mistakes (K0003,
  no signature, thin note, qty 2) and the mock's validator catches them and runs the
  correction loop (max 2), escalating after that.
- **Advocate**: escalations wait for your decision; Pause and Close end the run.

The mock follows a fixed script around your answers; when you go off-script it says so
in the rule text.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_WS_URL` | `ws://localhost:8000/ws` | Engine WebSocket URL |

Fonts (IBM Plex) load from Google Fonts; offline, the page falls back to system fonts.

## Layout

```
src/
  types.ts              mirror of backend/dme/contract.py (+ protocol unions)
  lib/useEngine.ts      reducer + hook: socket or mock, live call state, send functions
  lib/transport.ts      WebSocket transport with fallback
  lib/machines.ts       state-machine data (ported from the design page) + derivation from transitions
  components/           TopBar, SeatBar, LeftColumn, CenterPane, FaxComposer, RightColumn,
                        Timeline, EscalationDrawer, StateMachine, Overlays
  mock/                 script.ts (the scripted run), extract.ts (facts + order validator), MockEngine.ts
```
