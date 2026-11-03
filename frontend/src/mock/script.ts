// The scripted session the mock engine replays. Translated from docs/state-machine.html
// EVENTS, with fact keys aligned to contract.py CALL_PURPOSES / ORDER_DOC_FACTS.
import type { CallOutcome, DirectorySupplier, EventKind, Patient, PartyKind, ThreadName } from "../types";

export interface MockSupplier extends DirectorySupplier {
  /** Hidden persona: drives the mock only. Never rendered. */
  persona: string;
}

export const SUPPLIERS: MockSupplier[] = [
  { id: "lp", name: "Lincoln Park DME Services", phone: "(312) 555-0468", address: "2401 N Lincoln Ave, Chicago, IL 60614", miles: 0.3, persona: "Says yes to everything, confirms a date, then never shows." },
  { id: "hh", name: "Halsted Home Health Supply", phone: "(773) 555-0356", address: "2870 N Halsted St, Chicago, IL 60657", miles: 0.9, persona: "Not taking new Medicare patients until January." },
  { id: "ls", name: "Lakeshore Home Medical Equipment", phone: "(312) 555-0142", address: "1820 N Clark St, Chicago, IL 60614", miles: 1.3, persona: "Rarely answers before noon. Out of K0001 for three weeks." },
  { id: "wc", name: "Windy City Mobility & DME", phone: "(312) 555-0177", address: "435 W Erie St, Chicago, IL 60654", miles: 2.1, persona: "Won't accept assignment on rentals." },
  { id: "ps", name: "Prairie State Medical Supply", phone: "(773) 555-0211", address: "3344 N Western Ave, Chicago, IL 60618", miles: 2.1, persona: "Reliable. Closed Veterans Day." },
  { id: "bm", name: "Belmont Medical Equipment", phone: "(773) 555-0447", address: "3400 W Belmont Ave, Chicago, IL 60618", miles: 3.2, persona: "Would qualify. Never needed." },
  { id: "rs", name: "Roosevelt Medical Supply Co", phone: "(312) 555-0319", address: "1147 W Roosevelt Rd, Chicago, IL 60608", miles: 3.8, persona: "" },
  { id: "nc", name: "Northside CarePlus Equipment", phone: "(773) 555-0288", address: "5215 N Clark St, Chicago, IL 60640", miles: 3.9, persona: "" },
  { id: "cl", name: "ChicagoLand Durable Medical", phone: "(312) 555-0301", address: "900 S Wabash Ave, Chicago, IL 60605", miles: 3.9, persona: "" },
  { id: "sl", name: "South Loop Medical Supply", phone: "(312) 555-0490", address: "1530 S State St, Chicago, IL 60605", miles: 4.5, persona: "" },
  { id: "mm", name: "Midwest Mobility Solutions", phone: "(847) 555-0402", address: "6601 W Touhy Ave, Niles, IL 60714", miles: 9.4, persona: "Doesn't deliver into the city." },
  { id: "eh", name: "Evanston Home Medical", phone: "(847) 555-0533", address: "1700 Central St, Evanston, IL 60201", miles: 10.0, persona: "Doesn't deliver south of Howard St." },
];

export const PATIENT: Patient = {
  name: "Eleanor Martinez",
  age: 72,
  plan: "Original Medicare Part B, no Medigap",
  equipment: "Standard manual wheelchair",
  hcpcs: "K0001",
  pcp_name: "Dr. Sarah Chen",
  pcp_practice: "Sunrise Family Medicine",
  pcp_phone: "(312) 555-0190",
  visit_date: "2026-10-30",
  address: null,
  zip: null,
  mbi: null,
};

export const COST: [string, string][] = [
  ["Allowed rental, months 1–3", "$34.27/mo → her 20% $6.85"],
  ["Months 4–13 (75% of fee)", "$25.70/mo → her 20% $5.14"],
  ["Her 20% over 13 months", "≈ $72"],
  ["Unmet 2026 deductible", "up to $283"],
  ["If she qualifies for QMB", "$0"],
];

export const REQUEST_TEXT = `ORDER REQUEST — please review, sign and return
To: Sunrise Family Medicine, attn. equipment paperwork
Re: Eleanor Martinez, DOB on file · visit 10/30/2026

Prefilled standard written order for Dr. Chen's review and signature:
  Item: Standard manual wheelchair   HCPCS: K0001   Qty: 1
  Ordering provider: Sarah Chen, MD

Attached: CGS coverage checklist for manual wheelchairs (criteria A–G).
Please also return the 10/30 visit note. Callback: (312) 555-0100.`;

/** A clean order the reviewer can return as the office (all six elements, criteria A–G addressed). */
export const CLEAN_ORDER = `STANDARD WRITTEN ORDER
Patient: Eleanor Martinez   MBI: 1EG4-TE5-MK73
Item: Standard manual wheelchair   HCPCS: K0001   Qty: 1
Ordering provider: Sarah Chen, MD   NPI: 1234567893
Date: 11/04/2026
Signature: /s/ Sarah Chen, MD (electronically signed)

VISIT NOTE 10/30/2026 (excerpt)
Gait: unable to walk to bathroom without stopping to rest; near-fall at home 10/2.
Patient could not safely reach the bathroom using her walker because of fatigue and poor balance.
She lives in an elevator building and the doorways in her apartment are wide enough for a wheelchair.
Plan: standard wheelchair for daily use in apartment. Patient agrees. Daughter assists with transfers.`;

export const DOC1 = `STANDARD WRITTEN ORDER
Patient: Eleanor Martinez   MBI: 1EG4-TE5-MK73
Item: Standard wheelchair   HCPCS: K0003   Qty: 1
Ordering provider: Sarah Chen, MD   NPI: 1234567893
Date: 11/04/2026
Signature: /s/ Sarah Chen, MD (electronically signed)

VISIT NOTE 10/30/2026 (excerpt)
Gait: unable to walk to bathroom without stopping to rest; near-fall at home 10/2.
Plan: standard wheelchair for daily use in apartment. Patient agrees. Daughter assists with transfers.`;

export const DOC2 = `STANDARD WRITTEN ORDER (corrected)
Patient: Eleanor Martinez   MBI: 1EG4-TE5-MK73
Item: Standard wheelchair   HCPCS: K0001   Qty: 1
Ordering provider: Sarah Chen, MD   NPI: 1234567893
Date: 11/06/2026
Signature: /s/ Sarah Chen, MD (electronically signed)

ADDENDUM 11/06/2026 to visit of 10/30/2026
At the 10/30 visit, patient could not safely reach the bathroom using her walker because of fatigue and poor balance. She lives in an elevator building and reports the doorways in her apartment are wide enough for a wheelchair.
/s/ Sarah Chen, MD`;

export interface Line {
  s: "engine" | "party";
  text: string;
  /** Fact keys this engine line asks about (used when a person answers). */
  asks?: string[];
}

export interface ScriptCall {
  purpose: string;
  party_kind: PartyKind;
  party_id: string;
  party_name: string;
  brief: string;
  outcome?: CallOutcome;
  lines: Line[];
  /** key -> [value, quote]. value null = unknown. */
  facts: Record<string, [unknown, string | null]>;
  /** Required fact keys for this call (from CALL_PURPOSES). */
  required: string[];
}

export type SetSpec = {
  case?: string | string[];
  order?: string | string[];
  patient?: string | string[];
  sup?: Record<string, string | string[]>;
  reason?: Record<string, string>;
  next?: Record<string, string>;
};

export interface PacketSpec {
  code: import("../types").EscalationCode;
  thread: ThreadName;
  blocking: boolean;
  question: string;
  options: string[];
  numbers: [string, string][];
  tried: string[];
  context: string[];
  scripted: { option: string; note: string; fields: Record<string, string> };
}

export interface Step {
  key: string;
  at: string;
  th: ThreadName;
  kind: EventKind;
  title: string;
  detail: string;
  call?: ScriptCall;
  fax?: { direction: "outbound" | "inbound"; to: string; text: string };
  /** Inbound signed order from the office: the office seat may fax it instead. */
  officeOrder?: 1 | 2;
  packet?: PacketSpec;
  set: SetSpec;
  patientUpdate?: Partial<Patient>;
  /** Skip this step when the predicate on mock flags is true. */
  skipIf?: string;
}

const SN = Object.fromEntries(SUPPLIERS.map((s) => [s.id, s.name]));
const sup = (id: string): Pick<ScriptCall, "party_kind" | "party_id" | "party_name"> => ({ party_kind: "supplier", party_id: id, party_name: SN[id] });
const office = { party_kind: "office" as const, party_id: "sunrise", party_name: "Sunrise Family Medicine" };
const eleanor = { party_kind: "patient" as const, party_id: "eleanor", party_name: "Eleanor Martinez" };

const SCREEN_REQ = ["accepting_new_medicare", "accepts_assignment_all_months", "k0001_in_stock", "serves_address", "delivery_eta_days"];

export const STEPS: Step[] = [
  { key: "open", at: "2026-11-02T09:00:00", th: "case", kind: "system", title: "Case opened from intake",
    detail: "Preconditions checked: HIPAA authorization and consent to automated calls are on file (D1). Case OPEN. Three threads start in parallel. Intake has no home address and no Medicare number, so the first patient call collects them.",
    set: { case: "OPEN", order: "VERBAL_IN_CHART", patient: "NOT_CONTACTED", next: { supplier: "after her address is confirmed", order: "fax the order request now", patient: "intro call now" } } },

  { key: "intro", at: "2026-11-02T09:02:00", th: "patient", kind: "call", title: "Intro call to Eleanor",
    call: { purpose: "patient_intro", ...eleanor, required: ["address", "mbi", "prior_wheelchair"],
      brief: "Introduce the care team, confirm her address and MBI, ask about a prior wheelchair, explain the cost range, ask the best time to call.",
      lines: [
        { s: "engine", text: "Hi, is this Eleanor Martinez? I'm an automated assistant calling for your care team about the wheelchair Dr. Chen noted at your visit on Friday. Is now a good time?" },
        { s: "party", text: "Yes, go ahead." },
        { s: "engine", text: "I'll get the signed order from Dr. Chen's office and find a supplier near you. Can you confirm your home address, and read me the Medicare number on your red, white and blue card?", asks: ["address", "mbi"] },
        { s: "party", text: "2236 North Seminary, second floor, there's an elevator. The number is 1EG4-TE5-MK73." },
        { s: "engine", text: "Thank you. On cost: Medicare rents the chair by the month, and it's yours after 13 months. Your share is about $6.85 a month for three months, then about $5.14, roughly $72 in all. You'd also owe any part of this year's $283 deductible you haven't met. Have you met it this year?", asks: ["deductible_met"] },
        { s: "party", text: "I had my knee done in March, so probably." },
        { s: "engine", text: "After the knee surgery, did you have a wheelchair, or only a walker?", asks: ["prior_wheelchair"] },
        { s: "party", text: "Just the walker. I still use it." },
        { s: "engine", text: "When's the best time to reach you?", asks: ["best_time"] },
        { s: "party", text: "Mornings." },
      ],
      facts: {
        address: ["2236 N Seminary Ave, 2nd fl, Chicago 60614", "2236 North Seminary, second floor"],
        mbi: ["1EG4-TE5-MK73", "1EG4-TE5-MK73"],
        deductible_met: [null, "I had my knee done in March, so probably."],
        prior_wheelchair: [false, "Just the walker."],
        best_time: ["mornings", "Mornings."],
      } },
    detail: "Patient INFORMED. \"Probably\" isn't a confirmation, so deductible_met stays unknown and the cost stays a range. No prior wheelchair is reported; the supplier's eligibility check is the real test (D15). The address unblocks supplier ranking.",
    patientUpdate: { address: "2236 N Seminary Ave, 2nd fl, Chicago, IL", zip: "60614", mbi: "1EG4-TE5-MK73" },
    set: { patient: "INFORMED", next: { patient: "when a supplier and date are ready" } } },

  { key: "rank", at: "2026-11-02T09:04:00", th: "supplier", kind: "rule", title: "Rank 12 suppliers by distance",
    detail: "The directory has only name, phone and address, so suppliers are ranked by straight-line distance from 60614. Niles and Evanston rank last. The three nearest are called in parallel. Scouting calls never use her name (D3).",
    set: { next: { supplier: "calling the top 3" } } },

  { key: "req", at: "2026-11-02T09:05:00", th: "order", kind: "fax", title: "Request the order, checklist attached",
    fax: { direction: "outbound", to: "Sunrise Family Medicine · (312) 555-0199", text: REQUEST_TEXT },
    detail: "Faxed a prefilled order for Dr. Chen to review and sign: K0001, quantity 1, Eleanor's name and MBI (D4). Attached the public coverage checklist and asked for the Oct 30 visit note. No supplier is committed yet, so the order comes back to the engine (D5). Acknowledgment due in 1 business day.",
    set: { order: "REQUESTED", next: { order: "acknowledgment due Tue 09:00" } } },

  { key: "lp1", at: "2026-11-02T09:10:00", th: "supplier", kind: "call", title: "Lincoln Park qualifies and takes the referral",
    call: { purpose: "supplier_screen", ...sup("lp"), required: SCREEN_REQ,
      brief: "Screen for a Part B patient in 60614 needing K0001. Do not name the patient.",
      lines: [
        { s: "engine", text: "Hi, this is an automated assistant calling for a patient care team. We have a Medicare Part B patient near Lincoln and Fullerton, ZIP 60614, who needs a standard manual wheelchair, K0001. Are you taking new Medicare patients, and do you accept assignment for all the rental months?", asks: ["accepting_new_medicare", "accepts_assignment_all_months"] },
        { s: "party", text: "Yep, and yep." },
        { s: "engine", text: "Do you have K0001 in stock, do you deliver to her area, and how fast?", asks: ["k0001_in_stock", "serves_address", "delivery_eta_days"] },
        { s: "party", text: "We've got standard chairs on the floor and we're right down the street. Once the paperwork's in, we can usually deliver in three days." },
        { s: "engine", text: "Will you take the referral? We'll send her details and the signed order this week.", asks: ["accepts_referral", "contact_name"] },
        { s: "party", text: "Sure, send it over. Ask for Dev." },
      ],
      facts: {
        accepting_new_medicare: [true, "Yep, and yep."], accepts_assignment_all_months: [true, "Yep, and yep."],
        k0001_in_stock: [true, "We've got standard chairs on the floor"], serves_address: [true, "we're right down the street"],
        delivery_eta_days: [3, "we can usually deliver in three days"], accepts_referral: [true, "Sure, send it over."], contact_name: ["Dev", "Ask for Dev."],
      } },
    detail: "Every hard check has a quote and passes, so QUALIFIED. It took the referral, so COMMITTED. Reconfirm if the order isn't ready by Mon Nov 9.",
    set: { sup: { lp: ["CALLING", "QUALIFIED", "COMMITTED"] }, reason: { lp: "took the referral" }, next: { supplier: "reconfirm by Mon Nov 9" } } },

  { key: "hh1", at: "2026-11-02T09:11:00", th: "supplier", kind: "call", title: "Halsted isn't taking new Medicare patients",
    call: { purpose: "supplier_screen", ...sup("hh"), required: ["accepting_new_medicare"],
      brief: "Screen for a Part B patient in 60614 needing K0001.",
      lines: [
        { s: "engine", text: "Hi, this is an automated assistant calling for a patient care team. Are you taking new Medicare Part B patients for a standard wheelchair, K0001, in 60614?", asks: ["accepting_new_medicare", "k0001_in_stock"] },
        { s: "party", text: "Not right now, hon. We're full up on new Medicare patients until January." },
      ],
      facts: { accepting_new_medicare: [false, "We're full up on new Medicare patients until January."] } },
    detail: "Hard fail on accepting_new_medicare, so DISQUALIFIED (NOT_ACCEPTING). One quoted hard fail is enough. Nothing else is asked.",
    set: { sup: { hh: ["CALLING", "DISQUALIFIED"] }, reason: { hh: "NOT_ACCEPTING" } } },

  { key: "ls1", at: "2026-11-02T09:12:00", th: "supplier", kind: "call", title: "Lakeshore doesn't answer",
    call: { purpose: "supplier_screen", ...sup("ls"), required: [], brief: "Screen.", outcome: "no_answer", lines: [], facts: {} },
    detail: "NO_ANSWER. Retry in 4 hours.",
    set: { sup: { ls: ["CALLING", "NO_ANSWER"] }, reason: { ls: "retry 13:12" } } },

  { key: "backup", at: "2026-11-02T09:20:00", th: "supplier", kind: "rule", title: "One committed, so keep a backup warm",
    detail: "A commitment isn't a delivery. Policy is to keep one more qualified supplier warm without asking it to commit. Calling the next two by distance.",
    set: {} },

  { key: "wc1", at: "2026-11-02T09:22:00", th: "supplier", kind: "call", title: "Windy City won't accept assignment",
    call: { purpose: "supplier_screen", ...sup("wc"), required: ["accepts_assignment_all_months"],
      brief: "Screen.",
      lines: [
        { s: "engine", text: "Hi, this is an automated assistant for a patient care team. For a K0001 rental for a Part B patient, do you accept assignment for all the rental months?", asks: ["accepts_assignment_all_months"] },
        { s: "party", text: "We're enrolled, but we don't take assignment on rentals. She'd pay us and Medicare reimburses her." },
      ],
      facts: { accepts_assignment_all_months: [false, "we don't take assignment on rentals"] } },
    detail: "Hard fail on assignment. Without it her cost isn't held to 20% (F9). DISQUALIFIED (NO_ASSIGNMENT).",
    set: { sup: { wc: ["CALLING", "DISQUALIFIED"] }, reason: { wc: "NO_ASSIGNMENT" } } },

  { key: "ps1", at: "2026-11-02T09:30:00", th: "supplier", kind: "call", title: "Prairie State qualifies as the backup",
    call: { purpose: "supplier_screen", ...sup("ps"), required: SCREEN_REQ,
      brief: "Screen. Do not ask for a commitment: warm backup.",
      lines: [
        { s: "engine", text: "Hi, this is an automated assistant for a patient care team. For a standard K0001 for a Part B patient in 60614: are you taking new Medicare patients, accepting assignment for all rental months, do you have K0001 in stock, do you deliver there, and how fast?", asks: ["accepting_new_medicare", "accepts_assignment_all_months", "k0001_in_stock", "serves_address", "delivery_eta_days", "contact_name"] },
        { s: "party", text: "Yes to all of it. We cover the whole North Side. Delivery's about four business days after we get the order. I'm Ana." },
      ],
      facts: {
        accepting_new_medicare: [true, "Yes to all of it."], accepts_assignment_all_months: [true, "Yes to all of it."],
        k0001_in_stock: [true, "Yes to all of it."], serves_address: [true, "We cover the whole North Side."],
        delivery_eta_days: [4, "about four business days after we get the order"], contact_name: ["Ana", "I'm Ana."],
      } },
    detail: "QUALIFIED and kept as the warm backup. It isn't asked to commit.",
    set: { sup: { ps: ["CALLING", "QUALIFIED"] }, reason: { ps: "warm backup" } } },

  { key: "ls2", at: "2026-11-02T13:12:00", th: "supplier", kind: "call", title: "Lakeshore still doesn't answer",
    call: { purpose: "supplier_screen", ...sup("ls"), required: [], brief: "Retry.", outcome: "no_answer", lines: [], facts: {} },
    detail: "Second miss. Retry next business day.",
    set: { sup: { ls: ["CALLING", "NO_ANSWER"] }, reason: { ls: "2 misses · retry Tue" } } },

  { key: "nudge", at: "2026-11-03T09:00:00", th: "order", kind: "timer", title: "No acknowledgment from the office",
    detail: "The 1-business-day acknowledgment deadline passed. NUDGE: call the front desk and confirm the request actually landed.",
    set: { order: "NUDGE", next: { order: "calling the front desk" } } },

  { key: "hole", at: "2026-11-03T09:02:00", th: "order", kind: "call", title: "\"We never got it\"",
    call: { purpose: "office_followup", ...office, party_name: "Sunrise front desk", required: ["request_received"],
      brief: "Confirm the order request landed; find the owner.",
      lines: [
        { s: "engine", text: "Hi, this is an automated assistant for Eleanor Martinez's care team. We faxed a wheelchair order for Dr. Chen to sign yesterday and wanted to confirm you received it.", asks: ["request_received"] },
        { s: "party", text: "I don't see anything from yesterday. Which number did you use?" },
        { s: "engine", text: "We used (312) 555-0199. Who handles equipment paperwork there?", asks: ["correct_fax", "owner_name"] },
        { s: "party", text: "That's the old fax. Use 0197, and put it to Maria's attention. She does all the equipment paperwork." },
      ],
      facts: { request_received: [false, "I don't see anything from yesterday."], correct_fax: ["(312) 555-0197", "Use 0197"], owner_name: ["Maria", "put it to Maria's attention"] } },
    detail: "Resent to the corrected fax, addressed to the named owner. Back to REQUESTED. The practice record now has the new fax number, so the next case avoids this.",
    set: { order: "REQUESTED" } },

  { key: "maria1", at: "2026-11-03T09:40:00", th: "order", kind: "call", title: "Maria confirms receipt",
    call: { purpose: "office_followup", ...office, party_name: "Maria, Sunrise", required: ["request_received"],
      brief: "Confirm the resent request reached Maria.",
      lines: [
        { s: "engine", text: "Hi Maria, this is the automated assistant for Eleanor Martinez's care team. I just resent the wheelchair order to your attention. Did it come through, and when might Dr. Chen sign?", asks: ["request_received", "expected_signing"] },
        { s: "party", text: "Got it, it's here now. Dr. Chen's in clinic tomorrow, I'll put it in front of her." },
      ],
      facts: { request_received: [true, "Got it, it's here now."], owner_name: ["Maria", null], expected_signing: ["Wed Nov 4", "Dr. Chen's in clinic tomorrow"] } },
    detail: "ACKNOWLEDGED, with a named owner. Signature is due Fri Nov 6 (3 business days).",
    set: { order: "ACKNOWLEDGED", next: { order: "signature due Fri Nov 6" } } },

  { key: "ls3", at: "2026-11-03T10:05:00", th: "supplier", kind: "call", title: "Lakeshore is out of K0001",
    call: { purpose: "supplier_screen", ...sup("ls"), required: ["k0001_in_stock"],
      brief: "Screen.",
      lines: [
        { s: "engine", text: "Hi, this is an automated assistant for a patient care team. Do you have a standard wheelchair, K0001, in stock for a Part B patient in 60614?", asks: ["k0001_in_stock", "restock_days"] },
        { s: "party", text: "Standard chairs? We're out. Next shipment's about three weeks." },
      ],
      facts: { k0001_in_stock: [false, "We're out."], restock_days: [21, "about three weeks"] } },
    detail: "Out of stock and restock is more than 14 days away (D9), so DISQUALIFIED (NO_STOCK).",
    set: { sup: { ls: ["CALLING", "DISQUALIFIED"] }, reason: { ls: "NO_STOCK" } } },

  { key: "fax1", at: "2026-11-05T11:40:00", th: "order", kind: "fax", officeOrder: 1, title: "Signed order has the wrong code and a thin note",
    fax: { direction: "inbound", to: "engine", text: DOC1 },
    detail: "Validator: HCPCS K0003 (lightweight) doesn't match the description \"standard wheelchair\". K0003 is also on the order-before-delivery list (F5). The description and the note agree on a standard chair, so it's a clerical error, not a clinical one. Pre-screen: no sentence addresses criterion B or C. CORRECTION_REQUESTED for both, loop 1 of 2.",
    set: { order: ["RECEIVED", "CORRECTION_REQUESTED"], next: { order: "calling Maria" } } },

  { key: "maria2", at: "2026-11-05T11:45:00", th: "order", kind: "call", title: "Ask for a corrected code and the missing criteria", skipIf: "orderValid",
    call: { purpose: "office_correction", ...office, party_name: "Maria, Sunrise", required: ["correction_accepted"],
      brief: "Ask for a re-signed K0001 and route the B/C documentation question to the doctor. Write no clinical text.",
      lines: [
        { s: "engine", text: "Hi Maria, two things on Eleanor Martinez's order. It's coded K0003, a lightweight chair, but the description and the note both say standard, K0001. Could Dr. Chen re-sign it as K0001? And the supplier will need the note to address criteria B and C on the checklist we sent: whether a walker is enough at home, and whether her home fits a wheelchair. If Dr. Chen assessed those at the visit, an addendum would cover it.", asks: ["correction_accepted", "clinical_disagreement"] },
        { s: "party", text: "Our EHR defaults to K0003, I'll fix that. I'll show her the checklist. She's in tomorrow morning." },
      ],
      facts: { correction_accepted: [true, "I'll fix that."], clinical_disagreement: [false, "Our EHR defaults to K0003"] } },
    detail: "The clerical fix is accepted. The documentation question goes to the clinician. The engine named the criteria and stopped there. It wrote no clinical text (D8).",
    set: { next: { order: "corrected order due Fri" } } },

  { key: "fax2", at: "2026-11-06T10:15:00", th: "order", kind: "fax", officeOrder: 2, title: "Corrected order and addendum pass",
    fax: { direction: "inbound", to: "engine", text: DOC2 },
    detail: "6 of 6 order elements. HCPCS K0001. Quantity 1. Dated after the visit. VALIDATED. The pre-screen finds no gaps. Lincoln Park is committed, so the order, her name and her MBI go to Lincoln Park only (D3).",
    set: { order: ["RECEIVED", "VALIDATED", "SENT_TO_SUPPLIER"], next: { order: "waiting for the supplier's review" } } },

  { key: "dev", at: "2026-11-06T10:40:00", th: "supplier", kind: "call", title: "Lincoln Park confirms and offers Monday",
    call: { purpose: "supplier_confirm", ...sup("lp"), party_name: "Dev, Lincoln Park DME", required: ["order_received", "eligibility_clean", "docs_sufficient", "delivery_date"],
      brief: "Confirm the order arrived, eligibility is clean, docs are sufficient; get a delivery date.",
      lines: [
        { s: "engine", text: "Hi Dev, this is the automated assistant for Eleanor Martinez's care team. We faxed her order, MBI and visit note this morning. Did it all arrive, is her eligibility clean, does the note cover it, and when can you deliver?", asks: ["order_received", "eligibility_clean", "docs_sufficient", "delivery_date"] },
        { s: "party", text: "Got the order and the note. Eligibility's clean, no other wheelchair on file, and she's Original Medicare. Note covers it. How's Monday, one to four?" },
      ],
      facts: { order_received: [true, "Got the order and the note."], eligibility_clean: [true, "Eligibility's clean, no other wheelchair on file"], docs_sufficient: [true, "Note covers it."], delivery_date: ["Mon Nov 9, 13:00–16:00", "Monday, one to four"] } },
    detail: "Supplier CONFIRMED: it has the order, eligibility is clean, and a date is set. Order DOCS_OK. Two of three join inputs are ready. Next, Eleanor must approve the supplier and the window (D10).",
    set: { sup: { lp: "CONFIRMED" }, reason: { lp: "delivery Mon Nov 9, 13–16" }, order: "DOCS_OK", next: { supplier: "delivery Mon Nov 9, 13–16", order: "done" } } },

  { key: "consent1", at: "2026-11-06T11:00:00", th: "patient", kind: "call", title: "Eleanor approves the supplier and window",
    call: { purpose: "patient_consent", ...eleanor, required: ["consents_to_supplier", "window_ok"],
      brief: "Ask her to approve Lincoln Park DME Services and Monday 13:00–16:00.",
      lines: [
        { s: "engine", text: "Good morning, Eleanor, it's the automated assistant from your care team. We found a supplier for your chair: Lincoln Park DME Services, a few blocks from you. Is it all right with you if they provide it? They can bring it Monday between one and four.", asks: ["consents_to_supplier", "window_ok", "caregiver_present"] },
        { s: "party", text: "That's fine. Monday works. My daughter Rosa will be here." },
      ],
      facts: { consents_to_supplier: [true, "That's fine."], window_ok: [true, "Monday works."], caregiver_present: ["Rosa (daughter)", "My daughter Rosa will be here."] } },
    detail: "WINDOW_CONFIRMED. All three join inputs hold: the join fires and the case is DELIVERY_SCHEDULED.",
    set: { patient: "WINDOW_CONFIRMED", case: ["HANDOFF_READY", "DELIVERY_SCHEDULED"], next: { patient: "post-delivery check Mon 16:30" } } },

  { key: "nobody", at: "2026-11-09T16:30:00", th: "patient", kind: "call", title: "Nobody came",
    call: { purpose: "patient_delivery_check", ...eleanor, required: ["delivered"],
      brief: "Post-delivery check.",
      lines: [
        { s: "engine", text: "Hi Eleanor, it's the automated assistant from your care team. Did the wheelchair arrive this afternoon?", asks: ["delivered"] },
        { s: "party", text: "No. Nobody came. Rosa took the afternoon off for this." },
      ],
      facts: { delivered: [false, "Nobody came."] } },
    detail: "The window was missed, so the patient goes back to INFORMED. Check with the supplier now. The ghost threshold is Tue end of day.",
    set: { patient: "INFORMED", next: { patient: "update once the supplier is sorted", supplier: "calling Lincoln Park" } } },

  { key: "lp-na", at: "2026-11-09T16:35:00", th: "supplier", kind: "call", title: "Lincoln Park doesn't answer",
    call: { purpose: "supplier_delivery_check", ...sup("lp"), required: [], brief: "Ask about the missed delivery.", outcome: "no_answer", lines: [], facts: {} },
    detail: "No answer. Retry tomorrow morning.",
    set: { reason: { lp: "missed window · 1 unanswered" } } },

  { key: "lp-vm", at: "2026-11-10T09:00:00", th: "supplier", kind: "call", title: "Voicemail for Dev",
    call: { purpose: "supplier_delivery_check", ...sup("lp"), required: [], brief: "Ask about the missed delivery.", outcome: "voicemail",
      lines: [{ s: "engine", text: "Hi Dev, this is the care team's automated assistant calling about yesterday's delivery, reference DME-1042. Please call us back at (312) 555-0100." }], facts: {} },
    detail: "Second miss since the promised date. The voicemail has a callback number and an order reference, and no health details (D3).",
    set: { reason: { lp: "missed window · 2 unanswered" } } },

  { key: "hedge", at: "2026-11-10T10:00:00", th: "supplier", kind: "call", title: "Hedge: check the backup before the ghost threshold",
    call: { purpose: "supplier_reconfirm", ...sup("ps"), party_name: "Ana, Prairie State", required: ["still_available", "earliest_delivery"],
      brief: "Re-check the warm backup. Do not share her name.",
      lines: [
        { s: "engine", text: "Hi Ana, it's the automated assistant from the care team. Last week you qualified for a K0001 referral for a patient in 60614. If we need you, could you still take it this week, and what's the earliest delivery?", asks: ["still_available", "earliest_delivery", "accepts_referral"] },
        { s: "party", text: "We could. We're closed tomorrow for Veterans Day, so Thursday morning is the earliest. If you need us, send the order whenever and I'll check first thing Thursday." },
      ],
      facts: { still_available: [true, "We could."], earliest_delivery: ["Thu Nov 12 AM", "Thursday morning is the earliest"], accepts_referral: [true, "send the order whenever"] } },
    detail: "Lincoln Park missed and isn't answering, so the backup is checked before the threshold. Her name isn't shared. Prairie State stays QUALIFIED.",
    set: { reason: { ps: "warm backup · Thu AM" }, next: { supplier: "ghost threshold Tue end of day" } } },

  { key: "ghost", at: "2026-11-10T17:00:00", th: "supplier", kind: "timer", title: "Lincoln Park marked GHOSTED",
    detail: "Promised date +1 business day, no delivery, two unanswered calls, so GHOSTED. The case drops back to OPEN. Prairie State is next, but Eleanor has to approve the switch before her details go anywhere (D3, D10). The validated order is reused, with no new request to the doctor (D5).",
    set: { sup: { lp: "GHOSTED" }, reason: { lp: "GHOSTED" }, case: "OPEN", next: { supplier: "Prairie State, after Eleanor approves", patient: "calling Eleanor now" } } },

  { key: "waver", at: "2026-11-10T17:10:00", th: "patient", kind: "call", title: "Eleanor wavers over cost",
    call: { purpose: "patient_consent", ...eleanor, required: ["consents_to_supplier", "window_ok"],
      brief: "Apologize for the miss; ask her to approve Prairie State and Thursday morning.",
      lines: [
        { s: "engine", text: "Eleanor, I'm sorry about yesterday. Lincoln Park didn't follow through, so we've stopped working with them. Prairie State Medical Supply, about two miles away, can bring the chair Thursday morning. Is it all right if we send them your order?", asks: ["consents_to_supplier", "window_ok", "cost_concern"] },
        { s: "party", text: "Honestly, I don't know if I want to keep doing this. I just got a bill for fourteen hundred dollars from the knee surgery. I can't take on another bill every month. Maybe I'll just manage with the walker." },
        { s: "engine", text: "I understand. Would it be all right if someone from your care team calls you tomorrow to go through the cost with you?" },
        { s: "party", text: "I suppose." },
      ],
      facts: { consents_to_supplier: [null, "I don't know if I want to keep doing this."], window_ok: [null, null], cost_concern: [true, "I can't take on another bill every month."], declines: [null, "Maybe I'll just manage with the walker."] } },
    detail: "cost_concern is true with a quote, so PATIENT_COST_CONCERN. The patient thread stops. The join can't fire without her consent, so the case is BLOCKED_ON_HUMAN. The supplier and order threads don't stop: Prairie State stays warm and the order stays valid. The engine didn't try to talk her into it. It only asked permission for a person to call.",
    set: { patient: "ESC_COST", case: "BLOCKED_ON_HUMAN", next: { patient: "with a care advocate" } } },

  { key: "esc", at: "2026-11-10T17:11:00", th: "patient", kind: "escalation", title: "Packet to the care advocate queue", skipIf: "consentedEarly",
    packet: {
      code: "PATIENT_COST_CONCERN", thread: "patient", blocking: true,
      question: "Does Eleanor want to go ahead, and does she need help paying?",
      options: ["Proceed", "Proceed and start a QMB application", "Pause 30 days", "Close the case"],
      numbers: [["Her share, months 1–3", "$6.85 / mo"], ["Her share, months 4–13", "$5.14 / mo"], ["Her total over 13 months", "≈ $72"], ["2026 deductible", "likely met (she said \"probably\")"], ["2027 deductible", "applies to 2027 rental months until met"], ["If she qualifies for QMB", "$0, and suppliers can't bill her"], ["Illinois QMB, 2026", "income ≤ ~$1,330 / mo, assets ≤ $9,950"]],
      tried: ["Mon Nov 2: intro call, cost range explained", "Fri Nov 6: she approved Lincoln Park and the Monday window", "Mon Nov 9: Lincoln Park didn't deliver. Rosa took the afternoon off", "Tue Nov 10: asked her to approve Prairie State. She raised a $1,400 surgery bill"],
      context: ["The visit note says she can't safely reach the bathroom with her walker, so managing with the walker carries risk.", "Prairie State can deliver Thursday morning. It is closed Wednesday for Veterans Day.", "The order is validated and reusable. No new paperwork is needed."],
      scripted: { option: "Proceed and start a QMB application",
        note: "Called Eleanor for 25 minutes. Walked through the $72 total and explained that the surgery bill is separate. Her income is about $1,250 a month from Social Security, so she likely qualifies for QMB. Started the application with her. She wants the chair, approved Prairie State, and confirmed Thursday 9 to 12.",
        fields: { supplier_consent: "Prairie State Medical Supply", window: "Thu Nov 12, 09:00–12:00", qmb_application: "started, outcome pending" } },
    },
    detail: "Escalation raised by rule from a quoted fact. The packet is the advocate's whole briefing.",
    set: {} },

  { key: "resume", at: "2026-11-11T10:35:00", th: "supplier", kind: "rule", title: "Engine resumes: order to Prairie State",
    detail: "With her consent, the order, her name and her MBI go to Prairie State (D3). Ana's Tuesday quote, \"send the order whenever,\" counts as accepting the referral, so COMMITTED. Prairie State is closed for the holiday, so confirmation is due Thu 08:00 (D14).",
    set: { sup: { ps: "COMMITTED" }, reason: { ps: "took the referral" }, order: "SENT_TO_SUPPLIER", next: { supplier: "confirmation due Thu 08:00", order: "waiting for Prairie State's review" } } },

  { key: "ana", at: "2026-11-12T08:15:00", th: "supplier", kind: "call", title: "Prairie State confirms",
    call: { purpose: "supplier_confirm", ...sup("ps"), party_name: "Ana, Prairie State", required: ["order_received", "eligibility_clean", "docs_sufficient", "delivery_date"],
      brief: "Confirm the order, eligibility, docs and the delivery time.",
      lines: [
        { s: "engine", text: "Good morning Ana, it's the care team's automated assistant. Checking that you received Eleanor Martinez's order and note, that eligibility is clean, and when you'll deliver.", asks: ["order_received", "eligibility_clean", "docs_sufficient", "delivery_date"] },
        { s: "party", text: "Got it all. Eligibility's clean, no other wheelchair on file. The note's fine. She's our first stop, around nine-thirty." },
      ],
      facts: { order_received: [true, "Got it all."], eligibility_clean: [true, "Eligibility's clean, no other wheelchair on file."], docs_sufficient: [true, "The note's fine."], delivery_date: ["Thu Nov 12 ~09:30", "She's our first stop, around nine-thirty."] } },
    detail: "Supplier CONFIRMED. Order DOCS_OK. Her window was already approved, so the join fires again: DELIVERY_SCHEDULED.",
    set: { sup: { ps: "CONFIRMED" }, reason: { ps: "delivery Thu ~09:30" }, order: "DOCS_OK", case: ["HANDOFF_READY", "DELIVERY_SCHEDULED"], next: { supplier: "delivery ~09:30", order: "done" } } },

  { key: "arrived", at: "2026-11-12T11:00:00", th: "patient", kind: "call", title: "It's here",
    call: { purpose: "patient_delivery_check", ...eleanor, required: ["delivered"],
      brief: "Post-delivery check.",
      lines: [
        { s: "engine", text: "Hi Eleanor, it's the automated assistant from your care team. Did the chair arrive?", asks: ["delivered"] },
        { s: "party", text: "It's here. The driver showed Rosa how to fold it." },
      ],
      facts: { delivered: [true, "It's here."] } },
    detail: "DELIVERY_VERIFIED from her side. The supplier's proof of delivery is still needed (D11).",
    set: { patient: "DELIVERY_VERIFIED", next: { patient: "done" } } },

  { key: "pod", at: "2026-11-12T11:15:00", th: "supplier", kind: "call", title: "Proof of delivery and billing code",
    call: { purpose: "supplier_delivery_check", ...sup("ps"), party_name: "Ana, Prairie State", required: ["delivered", "proof_of_delivery", "billed_hcpcs"],
      brief: "Get proof of delivery and the billed code.",
      lines: [
        { s: "engine", text: "Hi Ana, it's the care team's assistant. Eleanor says the chair arrived. Was a delivery ticket signed, and what code are you billing?", asks: ["delivered", "proof_of_delivery", "billed_hcpcs", "on_assignment"] },
        { s: "party", text: "Delivered at nine-forty and Rosa signed the delivery ticket. We're billing K0001 with RR and KH, first rental month, on assignment." },
      ],
      facts: { delivered: [true, "Delivered at nine-forty"], proof_of_delivery: [true, "Rosa signed the delivery ticket"], billed_hcpcs: ["K0001", "We're billing K0001"], on_assignment: [true, "on assignment"] } },
    detail: "The proof of delivery and her account agree (D11). The billed code matches the validated order. DELIVERED.",
    set: { sup: { ps: "DELIVERED" }, reason: { ps: "POD signed · billed K0001-RR" }, case: "DELIVERED", next: { supplier: "done" } } },

  { key: "closed", at: "2026-11-12T11:16:00", th: "case", kind: "system", title: "Case closed",
    detail: "CLOSED after 8 business days, with Veterans Day excluded. The engine recovered on its own from a lost fax, a wrong code with a thin note, three suppliers that couldn't serve her, and a supplier that ghosted. One thing went to a person: her worry about cost.",
    set: { case: "CLOSED", next: { supplier: "—", order: "—", patient: "—" } } },
];
