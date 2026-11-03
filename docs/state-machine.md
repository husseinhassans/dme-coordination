# DME Coordination Engine — State Machine Spec (v2)

Source of truth for the prototype. `state-machine.html` renders it; the code implements it.
v2 folds in a full audit: every external fact is sourced (§2), every design choice that a
reviewer could challenge is stated with its reason (§3), and the demo run now exercises
all five failure modes from the brief, including one that genuinely needs a person.

---

## 1. Where this sits

```
Intake (done)  ──►  COORDINATION ENGINE  ──►  Supplier delivers + bills Medicare (K0001-RR)
                        │       ▲
                        ▼       │ typed decision
                 Care advocate queue (async, escalation packets)
```

The engine owns one case from "intake complete" to "equipment delivered and the billed
code matches the order." All three outside parties are reached by voice or fax:

| Party | Real channel | Prototype | What we need from them |
|---|---|---|---|
| 12 enrolled suppliers | Outbound phone | LLM roleplays a supplier with a hidden persona | Takes new Medicare patients, accepts assignment for all rental months, K0001 stock, serves her address, ETA |
| PCP office (Dr. Chen) | Phone + fax | LLM roleplays the front desk; faxes are mocked documents | Signed standard written order, visit note that addresses coverage criteria |
| Eleanor | Phone | LLM roleplays the patient | MBI, address, consent to supplier, delivery window, cost understanding |

## 2. Verified facts the design depends on

| # | Fact | Source |
|---|---|---|
| F1 | K0001 for home use needs criteria A–E plus F or G. A: mobility limit impairs an MRADL (toileting, dressing…). B: cane/walker can't resolve it. C: home is accessible. D: she'll use it regularly at home. E: she's willing. F: can self-propel, or G: has a caregiver. "Difficulty walking" is not enough. Use only outside the home is non-covered. | CGS/Noridian physician letter summarizing LCD L33788, rev. Oct 2026 |
| F2 | Insufficient documentation causes 79.7% of manual-wheelchair improper payments. | CMS MLN compliance tips, 2024 period |
| F3 | Standard written order (SWO) elements: beneficiary name or MBI, item description, quantity, treating practitioner name or NPI, order date, practitioner signature. **No supplier name.** It must reach the supplier before the claim. | CMS DMEPOS order requirements page |
| F4 | Someone other than the practitioner may prepare the SWO (non-power items); the practitioner must sign it. | DME MAC standard documentation requirements (A55426 lineage) |
| F5 | K0001 is **not** on the Face-to-Face / Written-Order-Prior-to-Delivery list. K0002–K0007 and E1161 are. | CMS list PDF, effective 10/28/2026 |
| F6 | K0001 is capped rental: up to 13 continuous months, then she owns it. Months 1–3 pay the fee; months 4–13 pay 75% of it. | CMS DMEPOS fee schedule background (DMEBACK 2026) |
| F7 | ZIP 60614 is in the former Chicago competitive-bidding area. Q4 2026 K0001-RR allowed amount there: **$34.27/month**. | CMS DMEPOS fee schedule DME26-D, Former CBA files |
| F8 | Competitive bidding is in a gap period until the 2028 round, so any enrolled supplier may furnish K0001. | CMS Round 2028 timeline; DME MAC CBP pages |
| F9 | A supplier that doesn't accept assignment can charge above the Medicare amount; the limiting charge doesn't apply to DME. | CMS letter to NAIC; archived medicare.gov |
| F10 | 2026 Part B deductible is $283. It resets each January. | CMS 2026 Part B amounts, as reported Nov 2025 (trade press; confirm on the CMS fact sheet) |
| F11 | A new capped-rental period only starts after a 60+ day break in medical need. Prior wheelchair rentals surface as "same or similar" in the supplier's eligibility check. | Noridian new capped rental period guidance |
| F12 | QMB (Illinois 2026: ~$1,330/mo individual income, $9,950 assets) pays all Medicare cost-sharing, and suppliers may not bill a QMB enrollee for it. | IL Dept. on Aging 2026 MSP chart; 42 USC 1396a(n)(3)(B) |

**Her cost, computed by rules, never by the LLM:**

| Item | Amount |
|---|---|
| Medicare-allowed rental, months 1–3 | $34.27/mo → she pays 20% = **$6.85/mo** |
| Months 4–13 (75% of fee) | $25.70/mo → she pays **$5.14/mo** |
| Her 20% over 13 months | **≈ $72** |
| Plus | any unmet 2026 deductible (up to $283); the 2027 deductible applies to 2027 rental months until met |

Deductible status is unknown, so the disclosure is a range. If she qualifies for QMB she owes $0.

## 3. Decisions and assumptions (each one a reviewer could challenge)

| # | Decision | Why |
|---|---|---|
| D1 | **Assumption:** intake captured a HIPAA authorization naming the company, consent to automated calls, and her phone number. | The PCP office won't release records without it; AI-voice calls need consent (TCPA). The engine checks both at case open and stops if missing. |
| D2 | Every automated call opens by saying it's an automated assistant for her care team. | Disclosure; trust with an elderly patient. |
| D3 | **Minimum necessary PHI.** Scouting calls describe "a Part B patient in 60614." Her name, MBI and order go only to the committed supplier. Voicemails carry a callback number and no health details. | HIPAA minimum-necessary standard. |
| D4 | The engine prepares a prefilled SWO for Dr. Chen to review and sign, and attaches the public CGS coverage checklist with the request. | F4 allows it. Sending the checklist up front prevents the documentation gap behind F2 instead of recovering from it. The engine never writes clinical text. |
| D5 | The office sends the signed order to the engine, which validates it and relays it to the supplier. If a supplier is already committed when the order is requested, the order is addressed to that supplier with a copy to the engine. | Validation before the supplier sees it avoids rework. Because the SWO has no supplier name (F3), the same signed order moves to a replacement supplier without going back to the doctor. E-ordering platforms already relay orders this way. |
| D6 | Delivery waits for a validated order even though K0001 isn't on the order-before-delivery list (F5). | Suppliers rarely deliver unsigned, and a wrong code (e.g. K0003, which *is* on the list) would make the delivered chair unbillable. |
| D7 | Validator checks: the six SWO elements, HCPCS = K0001, quantity 1, description consistent with the code. It also sanity-checks order date ≥ visit date. | The first four are Medicare requirements or claim-matching. The date check is our sanity rule, not a Medicare rule. |
| D8 | The LLM may **pre-screen** the visit note against criteria A–G and list criteria with no supporting sentence, each with a quote. A gap triggers a neutral request to the office with the checklist. | A false positive only costs a polite request. Pass/fail on coverage stays with the supplier and Medicare. The LLM never drafts the missing text. |
| D9 | Supplier qualification thresholds (ETA ≤ 10 days, restock ≤ 14 days) are product policy in config, not Medicare rules. | Stated so nobody mistakes them for regulation. |
| D10 | Eleanor chooses the supplier. The engine proposes the best qualified one and asks her consent before scheduling. | Beneficiaries have the right to choose their supplier. |
| D11 | "Delivered" requires the supplier's proof of delivery **and** her confirmation. A mismatch is AMBIGUOUS_CALL_OUTCOME. | Suppliers must keep proof of delivery; the patient is the independent check. |
| D12 | **LLM output must be grounded.** Every extracted fact carries a verbatim quote from the transcript or document. Rules accept a fact only if the quote is found by string match. No quote means `unknown`. No self-reported confidence scores. | Checkable. Self-reported LLM confidence isn't calibrated. |
| D13 | Patient contact policy: calls 9:00–18:00 local, her stated best time, at most one routine call a day. Urgent updates (a missed delivery) may add one same-day call. | Elderly patient; call fatigue drives disengagement, which is a listed failure mode. |
| D14 | Business days are Mon–Fri excluding federal holidays, for every timer. | One calendar for all threads. The demo run crosses Veterans Day (Wed Nov 11) and handles it. The internal care-advocate queue isn't bound by it: escalations are worked every weekday. |
| D15 | The intro call asks whether she had a wheelchair after her March knee surgery. | Same-or-similar (F11) is the most common silent claim killer for a repeat item. Asking early is cheap. |

## 4. Shape: one orchestrator, three threads, one join

Every thread runs the same loop:

```
pick next action ─► make the call/fax (voice or mock) ─► LLM: transcript → grounded facts
      ▲                                                          │
      └──── set timer ◄── transition ◄── RULES evaluate facts ◄──┘
                                  └──► escalation (typed packet) when a rule says so
```

Build the loop once and each thread is configuration: its scripts, its fact schema, its
rules table, its timers. That's why the whole loop is buildable in the time box.

**The join** fires the handoff only when all three hold:
1. Order thread = `DOCS_OK` (validated, at the committed supplier, notes accepted).
2. Supplier thread has one candidate `CONFIRMED` (has the order, eligibility clean, date set).
3. Patient thread = `WINDOW_CONFIRMED` (consented to that supplier, window agreed).

**Case states:** `OPEN` · `HANDOFF_READY` · `DELIVERY_SCHEDULED` · `DELIVERED` · `CLOSED` ·
`BLOCKED_ON_HUMAN(code)` · `PAUSED` (inpatient stay; DME isn't paid during one) · `ABANDONED`.

**Escalations are thread-scoped.** A blocking escalation stops only its own thread. The case
shows `BLOCKED_ON_HUMAN` only while the join is waiting on that thread. Other threads keep
working. Non-blocking escalations (SAFETY_CONCERN) stop nothing.

## 5. Supplier thread (per candidate)

Candidates ranked by straight-line distance from her confirmed address; 3 in flight.
Once one commits, keep one more qualified as a warm backup without asking it to commit.

```
NOT_CONTACTED ─dial─► CALLING
CALLING ─no pickup─► NO_ANSWER ─retry (+4h, +1d, +2d)─► CALLING
NO_ANSWER ─3 misses─► UNREACHABLE
CALLING ─answered─► facts ─► rules:
    any hard fail ─► DISQUALIFIED(reason)
    all pass      ─► QUALIFIED
    required fact unknown ─► one clarifying call ─► still unknown ─► ESC AMBIGUOUS_CALL_OUTCOME
QUALIFIED ─accepts referral─► COMMITTED (reconfirm if the order isn't ready in 5 business days)
COMMITTED ─reconfirm fails─► DISQUALIFIED
COMMITTED ─order + MBI sent, eligibility clean, date set─► CONFIRMED
COMMITTED ─eligibility shows same/similar or plan mismatch─► ESC ELIGIBILITY_CONFLICT
CONFIRMED ─proof of delivery + patient confirms─► DELIVERED
CONFIRMED ─promised date +1 business day, no delivery─► GHOSTED ─► next candidate
all candidates terminal, none committed ─► ESC SUPPLIERS_EXHAUSTED
```

| Fact (each needs a quote) | Hard fail if |
|---|---|
| accepting_new_medicare | false |
| accepts_assignment_all_months | false (F9) |
| k0001_in_stock / restock_days | out and restock > 14 days |
| serves_address | false |
| delivery_eta_days | > 10 |

Reasons: `NOT_ACCEPTING` · `NO_ASSIGNMENT` · `NO_STOCK` · `OUT_OF_AREA` · `TOO_SLOW` · `GHOSTED` · `UNREACHABLE`

## 6. Order thread

```
VERBAL_IN_CHART ─fax prefilled SWO + CGS checklist + note request─► REQUESTED
REQUESTED ─office names an owner─► ACKNOWLEDGED
REQUESTED ─no ack in 1 business day─► NUDGE ─resend on corrected/alt channel─► REQUESTED
ACKNOWLEDGED ─unsigned after 3 business days─► NUDGE ─3 nudges─► ESC ORDER_UNSIGNED
ACKNOWLEDGED ─signed order + note arrive─► RECEIVED
RECEIVED ─validator (D7) + note pre-screen (D8)─►
    pass ─► VALIDATED
    clerical error or note gap ─► CORRECTION_REQUESTED ─re-signed / addendum─► RECEIVED (max 2 loops)
    code and note disagree on the chair she needs ─► ESC ORDER_NEEDS_CLINICAL_FIX
VALIDATED ─to committed supplier─► SENT_TO_SUPPLIER
SENT_TO_SUPPLIER ─supplier accepts notes─► DOCS_OK
SENT_TO_SUPPLIER ─supplier rejects notes after the addendum loop─► ESC DOCS_INSUFFICIENT
DOCS_OK ─supplier ghosts─► SENT_TO_SUPPLIER (same order, new supplier)
```

## 7. Patient thread

```
NOT_CONTACTED ─intro call─► INFORMED
    (AI disclosure, confirm address + MBI, prior wheelchair?, cost range, best time to call)
NOT_CONTACTED ─no pickup─► NO_ANSWER ─reached─► INFORMED
NO_ANSWER ─4 tries over 3 business days─► ESC PATIENT_UNREACHABLE
INFORMED ─supplier + date ready; she consents to supplier and window─► WINDOW_CONFIRMED
WINDOW_CONFIRMED ─missed or slipped > 2 days─► INFORMED
WINDOW_CONFIRMED ─post-delivery call confirms─► DELIVERY_VERIFIED
INFORMED ─can't pay / cost confusion / wants to stop over cost─► ESC PATIENT_COST_CONCERN
INFORMED ─declines the chair for non-cost reasons─► ESC PATIENT_DECLINES
any call ─fall, injury, acute distress─► ESC SAFETY_CONCERN (non-blocking, immediate)
ESC_* ─human decision: proceed─► INFORMED (engine resumes)
```

## 8. Escalations: the only reasons a person gets pulled in

| Code | Blocks | Raised when (rules) | Why a person | Decision options |
|---|---|---|---|---|
| SUPPLIERS_EXHAUSTED | supplier | every candidate terminal | widen radius, out-of-directory supplier, other payment | widen to N mi · add supplier · pause |
| ELIGIBILITY_CONFLICT | supplier | supplier's check shows same/similar or a plan mismatch | break-in-need facts (F11) can't be verified by phone; liability | proceed (new period justified) · transfer to prior supplier · close |
| ORDER_UNSIGNED | order | 3 nudges, still unsigned | relationship call to the practice | retry with contact X · pause |
| ORDER_NEEDS_CLINICAL_FIX | order | code and note disagree on the chair | choosing equipment is the doctor's call | doctor confirms K0001 · new code → re-run qualification |
| DOCS_INSUFFICIENT | order | supplier still rejects notes after the addendum loop | clinician must document, maybe re-examine; AI never drafts | re-visit booked · close |
| PATIENT_UNREACHABLE | patient | 4 tries over 3 business days | welfare check, emergency contact | reached → resume · pause |
| PATIENT_COST_CONCERN | patient | grounded fact: can't pay, confused, or stopping over cost | financial conversation, QMB/MSP screening (F12), keeping her engaged | proceed · proceed + MSP application · pause · close |
| PATIENT_DECLINES | patient | declines for non-cost reasons | criterion E; a person should hear why | proceed · close |
| AMBIGUOUS_CALL_OUTCOME | that thread | required fact still unknown after a clarifying call, or POD/patient mismatch | a person reviews the recording | set fact = … |
| SAFETY_CONCERN | nothing | fall, injury, acute distress mentioned | welfare; never automated | acknowledged |

**Invariant:** the LLM produces grounded facts; rules produce every transition and every
escalation. Each packet carries: what was tried, transcripts, the state of all threads,
the computed numbers, the one question, and the allowed answers. The human's answer is
typed, so the engine knows exactly where to resume.

## 9. Where the LLM sits, and where it doesn't

| Step | Who | Why |
|---|---|---|
| Write the call script for a party and goal | LLM | Language; guardrailed template, disclosure line fixed |
| Transcript → facts, each with a verbatim quote | LLM | Messy speech; quotes make it checkable (D12) |
| Fax → order fields, with quotes | LLM | Document reading |
| Pre-screen visit note against A–G, gaps with quotes | LLM | Flags only; a false positive costs one polite request (D8) |
| Patient-facing wording | LLM | Numbers injected from rules, never generated |
| Qualify / disqualify a supplier | Rules | Auditable |
| Validate the order | Rules | A claim rejection is expensive; must be exact |
| Compute her cost | Rules | Money; from the fee file (F6, F7) |
| Timers, retries, escalations | Rules | Predictable and explainable |
| Medical-necessity text, coverage judgment, income screening | Never AI | Clinical, compliance and personal-finance decisions |

## 10. Timers (business days per D14)

| Timer | Value |
|---|---|
| Supplier no-answer retry | +4h, +1d, +2d (max 3) |
| Supplier candidates in flight | 3, plus 1 warm backup after a commit |
| Supplier commitment reconfirm | 5 business days |
| Ghost threshold | promised date +1 business day |
| Office acknowledgment | 1 business day |
| Signature | 3 business days, 3 nudges |
| Correction / addendum loops | 2 max |
| Patient retry | 4 tries over 3 business days |
| Clarifying call for an unknown fact | 1 |
| Escalation unanswered | 1 business day → notify a supervisor |

## 11. Demo run (matches `state-machine.html`)

Mocked address 2236 N Seminary Ave, 60614. Suppliers ranked by distance. Hidden personas:

| Supplier | Mi | Persona |
|---|---|---|
| Lincoln Park DME | 0.3 | Accepts, confirms Mon delivery, then ghosts |
| Halsted Home Health | 0.9 | Not taking new Medicare patients |
| Lakeshore HME | 1.3 | Two no-answers, then out of K0001 for 3 weeks |
| Windy City | 2.1 | Won't accept assignment on rentals |
| Prairie State | 2.1 | Reliable; warm backup, delivers after the ghost |
| Niles, Evanston | 9–10 | Ranked last |

Office: first fax went to an outdated number. The signed order comes back coded K0003 (EHR
default) and the note doesn't address criteria B and C. One loop fixes both.

Eleanor: after the missed delivery she says she may stop because of a surgery bill. That's
the run's one escalation, PATIENT_COST_CONCERN. A care advocate explains the $72, starts a
QMB screen, and she proceeds.

All five brief failure modes appear: supplier can't serve, supplier ghosts, request falls
in a hole, order is wrong, patient disengages over cost. Four are recovered by the engine.
One goes to a person, because it should.

Outcome: closed Thu Nov 12, 8 business days (Veterans Day excluded), 1 escalation.

## 12. Out of scope (stated in the writeup)

Real voice, real fax, monthly rental oversight after delivery, repairs, Medicare Advantage
plans, power mobility, appeals, persistent storage, auth, UI polish.
