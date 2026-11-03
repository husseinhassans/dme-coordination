// Tiny keyword "LLM" for mock mode: reads a person's typed reply into facts, each
// with a verbatim quote, and reads faxed orders with a rules validator. The real
// backend does the reading with a model; the grounding rule (quote must be found)
// is the same.
import type { Fact } from "../types";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]+/g, " ").trim();
/** Quote is accepted only if found by normalized substring match (D12). */
export const verifyQuote = (quote: string | null | undefined, source: string) =>
  !!quote && norm(source).includes(norm(quote));

export const mkFact = (key: string, value: unknown, quote: string | null, source: string): Fact => ({
  key,
  value: value === undefined ? null : value,
  quote,
  verified: verifyQuote(quote, source),
});

// --------------------------------------------------------------------------
// Replies
// --------------------------------------------------------------------------

const clauses = (text: string) =>
  text.split(/(?<=[.!?;])\s+|,\s+|\s+(?=\bbut\b)/i).map((c) => c.trim()).filter(Boolean);

const NEG = /\b(no|nope|not|don't|dont|doesn't|didn't|can't|cannot|won't|isn't|aren't|never|nobody|nothing|out of|we're out|full up|none)\b/i;
const HEDGE = /\b(maybe|probably|i think|not sure|i guess|perhaps|might|i suppose|kind of|sort of|depends|we'll see|possibly)\b/i;
const POS = /\b(yes|yep|yeah|yup|sure|of course|absolutely|we do|we are|we can|we could|got it|fine|works|ok|okay|correct|that's right|definitely|it's here|arrived|send it|go ahead|sounds good|i agree|please do)\b/i;

const NUMWORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, a: 1, an: 1 };

function find(text: string, re: RegExp): string | null {
  for (const c of clauses(text)) if (re.test(c)) return c;
  return null;
}

function boolFact(text: string, re?: RegExp): [boolean | null, string] | null {
  const pool = re ? clauses(text).filter((c) => re.test(c)) : clauses(text);
  for (const c of pool) {
    if (NEG.test(c)) return [false, c];
    if (HEDGE.test(c)) return [null, c];
    if (POS.test(c) || re) return [true, c];
  }
  return null;
}

/** Prefer a clause about the topic; fall back to a plain yes/no answer. */
function topicBool(text: string, re: RegExp): [boolean | null, string] | null {
  return boolFact(text, re) ?? boolFact(text);
}

function daysFact(text: string, weeksAs: number): [number, string] | null {
  const m = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|a|an)\s+(business\s+)?(day|days|week|weeks)\b/i);
  if (!m) {
    const t = find(text, /\b(tomorrow)\b/i);
    return t ? [1, t] : null;
  }
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMWORDS[m[1].toLowerCase()] ?? 1;
  const days = /week/i.test(m[3]) ? n * weeksAs : n;
  return [days, m[0]];
}

type Extractor = (text: string) => [unknown, string] | null;

const KEYED: Record<string, Extractor> = {
  address: (t) => { const m = t.match(/\b\d{2,5}\s+(?:[NSEW]\.?\s+|north\s+|south\s+|east\s+|west\s+)?[A-Za-z][A-Za-z ]+?(?=[,.]|$)/i); return m ? [m[0].trim(), m[0].trim()] : null; },
  mbi: (t) => { const m = t.match(/\b\d[A-Z0-9]{3}-?[A-Z0-9]{3}-?[A-Z0-9]{4}\b/i); return m ? [m[0].toUpperCase(), m[0]] : null; },
  delivery_eta_days: (t) => daysFact(t, 5),
  restock_days: (t) => daysFact(t, 7),
  best_time: (t) => { const c = find(t, /\b(morning|mornings|afternoon|afternoons|evening|evenings|after \d+|before \d+|noon|any ?time)\b/i); return c ? [c.replace(/[.!]$/, ""), c] : null; },
  contact_name: (t) => { const m = t.match(/\b(?:ask for|I'm|I am|this is|my name is|talk to)\s+([A-Z][a-z]+)/); return m ? [m[1], m[0]] : null; },
  owner_name: (t) => { const m = t.match(/\b(?:ask for|attention of|to|I'm|I am|this is|talk to|that's)\s+([A-Z][a-z]+)/); return m ? [m[1], m[0]] : null; },
  correct_fax: (t) => { const m = t.match(/\(?\d{3}\)?[\s-]?\d{3}-\d{4}|\b0\d{3}\b|\b\d{3}-\d{4}\b/); return m ? [m[0], m[0]] : null; },
  delivery_date: (t) => { const c = find(t, /\b(monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|today|next week|\d{1,2}\/\d{1,2}|morning|afternoon)\b/i); return c ? [c.replace(/[.!?]$/, ""), c] : null; },
  earliest_delivery: (t) => KEYED.delivery_date(t),
  expected_signing: (t) => KEYED.delivery_date(t),
  billed_hcpcs: (t) => { const m = t.match(/\b[KE]\d{4}\b/i); return m ? [m[0].toUpperCase(), m[0]] : null; },
  caregiver_present: (t) => { const c = find(t, /\b(daughter|son|husband|wife|neighbor|friend|rosa|someone|caregiver|aide)\b/i); return c ? [c, c] : null; },
  proof_of_delivery: (t) => topicBool(t, /\b(ticket|signed|signature|proof|pod|paperwork)\b/i),
  delivered: (t) => topicBool(t, /\b(deliver|delivered|arrived|here|came|dropped|brought|showed up|got it|received)\b/i),
  k0001_in_stock: (t) => topicBool(t, /\b(stock|on the floor|have (one|them|it)|in house|available|out|shipment|chairs?)\b/i),
  serves_address: (t) => topicBool(t, /\b(deliver|cover|area|serve|down the street|north side|zip|go there|come out)\b/i),
  accepting_new_medicare: (t) => topicBool(t, /\b(new|medicare|taking|accepting|patients|full)\b/i),
  accepts_assignment_all_months: (t) => topicBool(t, /\b(assignment|assign|rental|months)\b/i),
  // Never inferred from a bare "yes": these need their own words.
  cost_concern: (t) => { const c = find(t, COST); return c ? [true, c] : null; },
  declines: (t) => { const c = find(t, DECLINE); return c ? [true, c] : null; },
  clinical_disagreement: (t) => { const c = find(t, /\b(K000[2-7]|lightweight|different chair|meant|intends?)\b/i); return c ? [!NEG.test(c), c] : null; },
};

const BOOL_KEYS = new Set([
  "accepting_new_medicare", "accepts_assignment_all_months", "k0001_in_stock", "serves_address", "accepts_referral",
  "still_available", "order_received", "eligibility_clean", "docs_sufficient", "delivered", "proof_of_delivery",
  "on_assignment", "request_received", "correction_accepted", "clinical_disagreement", "prior_wheelchair",
  "deductible_met", "consents_to_supplier", "window_ok", "cost_concern", "declines",
]);

const COST = /\b(can't afford|cannot afford|can't pay|cannot pay|too expensive|too much|another bill|can't take on|no money|money is tight|on a fixed income|worried about (the )?(cost|money|bill|price)|how much (will|does)|what will (it|this) cost)\b/i;
const DECLINE = /\b(don't want|do not want|no thanks|not interested|manage with the walker|don't need|rather not|cancel|stop this|forget it)\b/i;
const SAFETY = /\b(fell|fall|fallen|hurt|injur\w*|bleeding|chest pain|can't breathe|dizzy|faint\w*|emergency|er\b|hospital)\b/i;

export function extractReply(text: string, asks: string[], partyKind: string): Record<string, Fact> {
  const out: Record<string, Fact> = {};
  for (const key of asks) {
    const ex = KEYED[key];
    let r = ex ? ex(text) : null;
    if (!r && BOOL_KEYS.has(key) && !ex) r = boolFact(text);
    if (r) out[key] = mkFact(key, r[0], r[1], text);
  }
  if (partyKind === "patient") {
    const c = find(text, COST);
    if (c) out.cost_concern = mkFact("cost_concern", true, c, text);
    const d = find(text, DECLINE);
    if (d) out.declines = mkFact("declines", true, d, text);
  }
  return out;
}

export function detectSafety(text: string): Fact | null {
  const c = find(text, SAFETY);
  return c ? mkFact("safety_concern", true, c, text) : null;
}

// --------------------------------------------------------------------------
// Orders (fax → fields, then the D7 validator and the D8 note pre-screen)
// --------------------------------------------------------------------------

export const CRITERIA: { key: string; label: string; re: RegExp; also?: RegExp }[] = [
  { key: "crit_A_mradl", label: "A · mobility limit impairs a daily activity", re: /\b(bathroom|toilet\w*|dress\w*|bathing|kitchen|meals?)\b/i },
  { key: "crit_B_walker_not_enough", label: "B · cane or walker can't resolve it", re: /\b(walker|cane)\b/i, also: /\b(could not|cannot|can't|unable|not safe\w*|insufficient|not enough|isn't enough)\b/i },
  { key: "crit_C_home_access", label: "C · home can accommodate a wheelchair", re: /\b(doorways?|wide enough|elevator|accessible|accommodate|ramp)\b/i },
  { key: "crit_D_home_use", label: "D · will use it regularly at home", re: /\b(daily|regular\w*|at home|in (her |the )?apartment|home use)\b/i },
  { key: "crit_E_willing", label: "E · she is willing to use it", re: /\b(agrees|willing|wants to use|motivated)\b/i },
  { key: "crit_FG_propel_or_caregiver", label: "F/G · can self-propel or has a caregiver", re: /\b(self-propel\w*|propel\w*|caregiver|daughter|son|spouse|husband|wife|assists?)\b/i },
];

export interface OrderIssue { kind: "clerical" | "gap" | "clinical"; text: string }
export interface OrderReading {
  facts: Record<string, Fact>;
  issues: OrderIssue[];
  valid: boolean;
  clinical: boolean;
  criteriaMet: Set<string>;
  hcpcs: string | null;
}

const toIso = (mdY: string) => { const [m, d, y] = mdY.split("/"); return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; };

export function readOrder(text: string, visitDate: string, priorCriteria: Set<string> = new Set()): OrderReading {
  const facts: Record<string, Fact> = {};
  const put = (key: string, value: unknown, quote: string | null) => { facts[key] = mkFact(key, value, quote, text); };
  const field = (re: RegExp) => { const m = text.match(re); return m ? { v: m[1].trim(), q: m[0].trim() } : null; };

  const blank = text.search(/\n\s*\n/);
  const orderPart = blank >= 0 ? text.slice(0, blank) : text;
  const notePart = blank >= 0 ? text.slice(blank) : "";

  const ben = field(/Patient:\s*(.+?)(?=\s{2,}|\s+MBI:|$)/m);
  put("beneficiary", ben?.v ?? null, ben?.q ?? null);
  const mbi = field(/MBI:\s*([0-9A-Z-]{11,13})/);
  put("mbi", mbi?.v ?? null, mbi?.q ?? null);
  const desc = field(/Item:\s*(.+?)(?=\s{2,}|\s+HCPCS:|$)/m);
  put("description", desc?.v ?? null, desc?.q ?? null);
  const hc = field(/HCPCS:\s*([A-Z]\d{4})/);
  put("hcpcs", hc?.v ?? null, hc?.q ?? null);
  const qty = field(/Qty:\s*(\d+)/);
  put("quantity", qty ? Number(qty.v) : null, qty?.q ?? null);
  const pr = field(/(?:Ordering provider|Practitioner):\s*(.+?)(?=\s{2,}|\s+NPI:|$)/m);
  put("practitioner", pr?.v ?? null, pr?.q ?? null);
  const npi = field(/NPI:\s*(\d{10})/);
  put("npi", npi?.v ?? null, npi?.q ?? null);
  const dt = field(/^Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/m);
  put("order_date", dt ? toIso(dt.v) : null, dt?.q ?? null);
  const sig = orderPart.match(/\/s\/[^\n]+/);
  put("signed", sig ? true : null, sig ? sig[0].trim() : null);

  const sentences = notePart.split(/(?<=[.;])\s+|\n/).map((s) => s.trim()).filter(Boolean);
  const met = new Set(priorCriteria);
  for (const c of CRITERIA) {
    const s = sentences.find((x) => c.re.test(x) && (!c.also || c.also.test(x)));
    if (s) { put(c.key, true, s); met.add(c.key); }
    else if (priorCriteria.has(c.key)) { put(c.key, true, null); facts[c.key].verified = true; facts[c.key].quote = "(in the earlier note)"; }
    else put(c.key, null, null);
  }

  const issues: OrderIssue[] = [];
  let clinical = false;
  if (!ben) issues.push({ kind: "clerical", text: "No beneficiary name on the order." });
  if (!desc) issues.push({ kind: "clerical", text: "No item description." });
  if (!pr) issues.push({ kind: "clerical", text: "No treating practitioner named." });
  if (!dt) issues.push({ kind: "clerical", text: "No order date." });
  if (!sig) issues.push({ kind: "clerical", text: "No practitioner signature. An unsigned order can't be relayed." });
  if (!hc) issues.push({ kind: "clerical", text: "No HCPCS code." });
  else if (hc.v !== "K0001") {
    if (desc && /light|ultra|K000[2-7]/i.test(desc.v) && /light/i.test(notePart)) {
      clinical = true;
      issues.push({ kind: "clinical", text: `HCPCS ${hc.v} and the note both point to a different chair than the K0001 she was evaluated for. Choosing equipment is the doctor's call.` });
    } else {
      issues.push({ kind: "clerical", text: `HCPCS ${hc.v} doesn't match the description "${desc?.v ?? "?"}". ${/K000[2-7]/.test(hc.v) ? `${hc.v} is on the order-before-delivery list (F5) with its own criteria.` : ""}`.trim() });
    }
  }
  if (qty && Number(qty.v) !== 1) issues.push({ kind: "clerical", text: `Quantity ${qty.v}, expected 1.` });
  if (dt && toIso(dt.v) < visitDate) issues.push({ kind: "clerical", text: `Order dated ${dt.v}, before the ${visitDate} visit.` });
  for (const c of CRITERIA) if (!met.has(c.key)) issues.push({ kind: "gap", text: `No sentence addresses criterion ${c.label}.` });

  return { facts, issues, valid: issues.length === 0, clinical, criteriaMet: met, hcpcs: hc?.v ?? null };
}
