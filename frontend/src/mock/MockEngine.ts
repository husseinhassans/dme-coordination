// Mock engine: replays the scripted session over the same WebSocket protocol the
// backend speaks, and lets the reviewer take any seat. Serial by design: while it
// waits for a person (pickup, reply, fax, decision) the whole run waits.
import type {
  CallOutcome, CallRecord, CaseSnapshot, ClientMsg, Escalation, Fact, FaxDocument, MachineName,
  SeatKey, SeatMode, ServerMsg, SupplierStatus, TimelineEvent, Transition, Utterance,
} from "../types";
import type { Transport } from "../lib/transport";
import { COST, CLEAN_ORDER, PATIENT, STEPS, SUPPLIERS, type PacketSpec, type ScriptCall, type SetSpec, type Step } from "./script";
import { detectSafety, extractReply, mkFact, readOrder, verifyQuote } from "./extract";

type Waiter<T> = { resolve: (v: T) => void };
type PickupResult = "pickup" | "let_ring" | "timeout";
type SayResult = { kind: "say"; text: string } | { kind: "hangup" };

const BASE_PACE = 1.6; // seconds between events at 1x
const MIN = 60_000;

const addMin = (iso: string, minutes: number) => {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  return new Date(d.getTime() + minutes * MIN).toISOString().slice(0, 19);
};

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export class MockEngine implements Transport {
  private onMessage: (m: ServerMsg) => void;
  private token = 0;
  private snap!: CaseSnapshot;
  private queue: Step[] = [];
  private paused = false;
  private stepPermits = 0;
  private gateWaiter: (() => void) | null = null;
  private pace = BASE_PACE;
  private seats: Record<SeatKey, SeatMode> = { supplier: "auto", office: "auto", patient: "auto", advocate: "human" };
  private ids = { ev: 0, call: 0, fax: 0, esc: 0, req: 0 };
  private flags = { orderValid: false, orderDynamic: false, consentedEarly: false, orderLoops: 0 };
  private criteria = new Set<string>();
  private rings: Record<string, number> = {};
  private pickupW = new Map<string, Waiter<PickupResult>>();
  private sayW = new Map<string, Waiter<SayResult>>();
  private faxW = new Map<string, Waiter<string>>();
  private decideW = new Map<string, Waiter<{ option: string; note?: string; fields?: Record<string, string> }>>();
  private closed = false;

  constructor(onMessage: (m: ServerMsg) => void) {
    this.onMessage = onMessage;
    this.reset();
    setTimeout(() => this.emitSnapshot(), 0);
  }

  // ---------------------------------------------------------------- transport
  send(m: ClientMsg) {
    switch (m.type) {
      case "start": this.start(); break;
      case "seat":
        this.seats[m.party_kind] = m.mode;
        this.snap.seats = { ...this.seats };
        this.emitSnapshot();
        break;
      case "control":
        if (m.action === "pause") { this.paused = true; this.snap.running = false; this.emitSnapshot(); }
        else if (m.action === "resume") { this.paused = false; this.snap.running = true; this.openGate(); this.emitSnapshot(); }
        else if (m.action === "step") { this.stepPermits++; this.openGate(); }
        else if (m.action === "speed" && typeof m.value === "number") this.pace = Math.max(0, m.value);
        break;
      case "pickup": this.pickupW.get(m.call_id)?.resolve("pickup"); break;
      case "let_ring": this.pickupW.get(m.call_id)?.resolve("let_ring"); break;
      case "say": {
        const w = this.sayW.get(m.call_id);
        if (w) w.resolve({ kind: "say", text: m.text });
        else this.emit({ type: "error", message: "It isn't your turn on that call." });
        break;
      }
      case "hangup": this.sayW.get(m.call_id)?.resolve({ kind: "hangup" }); break;
      case "send_fax": this.faxW.get(m.request_id)?.resolve(m.text); break;
      case "decide": this.decideW.get(m.escalation_id)?.resolve({ option: m.option, note: m.note, fields: m.fields }); break;
    }
  }

  close() { this.closed = true; this.token++; }

  // ---------------------------------------------------------------- lifecycle
  private reset() {
    this.queue = STEPS.map((s) => ({ ...s }));
    this.ids = { ev: 0, call: 0, fax: 0, esc: 0, req: 0 };
    this.flags = { orderValid: false, orderDynamic: false, consentedEarly: false, orderLoops: 0 };
    this.criteria = new Set();
    this.rings = {};
    for (const m of [this.pickupW, this.sayW, this.faxW, this.decideW]) m.clear();
    const suppliers: SupplierStatus[] = SUPPLIERS.map(({ persona: _p, ...s }) => ({
      supplier: s, state: "NOT_CONTACTED", reason: (s.miles ?? 0) > 9 ? "ranked last: likely out of area" : null, misses: 0, facts: {},
    }));
    this.snap = {
      case_id: `mock-${Date.now().toString(36)}`,
      patient: clone(PATIENT),
      now: "2026-11-02T09:00:00",
      running: false,
      case_state: "OPEN",
      order_state: "VERBAL_IN_CHART",
      patient_state: "NOT_CONTACTED",
      suppliers,
      next_check: { case: "press Start", supplier: "—", order: "—", patient: "—" },
      seats: { ...this.seats },
      events: [],
      calls: {},
      faxes: {},
      escalations: [],
      cost: COST,
      done: false,
    };
  }

  private start() {
    this.token++;
    this.reset();
    this.paused = false;
    this.snap.running = true;
    this.emitSnapshot();
    const t = this.token;
    void this.run(t);
  }

  private alive(t: number) { return !this.closed && t === this.token; }

  private async run(t: number) {
    await this.sleep(400);
    while (this.alive(t) && this.queue.length) {
      await this.gate(t);
      if (!this.alive(t)) return;
      const step = this.queue.shift()!;
      if (step.skipIf && (this.flags as unknown as Record<string, unknown>)[step.skipIf]) continue;
      if (step.key === "fax2" && this.flags.orderDynamic) continue;
      if (step.key === "maria2" && this.flags.orderDynamic) continue;
      if (step.at > this.snap.now) this.snap.now = step.at;
      const stop = await this.exec(step, t);
      if (!this.alive(t) || stop) return;
      await this.sleep(this.pace * 1000);
    }
    if (this.alive(t)) {
      this.snap.running = false;
      this.snap.done = true;
      this.emitSnapshot();
    }
  }

  private gate(t: number): Promise<void> {
    if (!this.paused) return Promise.resolve();
    if (this.stepPermits > 0) { this.stepPermits--; return Promise.resolve(); }
    return new Promise((resolve) => {
      this.gateWaiter = () => {
        if (!this.alive(t)) return resolve();
        if (!this.paused) { this.gateWaiter = null; resolve(); }
        else if (this.stepPermits > 0) { this.stepPermits--; this.gateWaiter = null; resolve(); }
      };
    });
  }
  private openGate() { this.gateWaiter?.(); }

  private factor() { return Math.min(2, Math.max(0.08, this.pace / BASE_PACE)); }
  private sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
  private speakDelay(text: string) { return Math.min(2400, Math.max(550, text.length * 16)) * this.factor(); }

  // ---------------------------------------------------------------- emit
  private emit(m: ServerMsg) { if (!this.closed) this.onMessage(clone(m)); }
  private emitSnapshot() { this.emit({ type: "snapshot", case: this.snap }); }

  private pushEvent(e: Omit<TimelineEvent, "id" | "at"> & { at?: string }) {
    const ev: TimelineEvent = { id: `ev-${String(++this.ids.ev).padStart(3, "0")}`, at: e.at ?? this.snap.now, ...e } as TimelineEvent;
    this.snap.events.push(ev);
    this.emit({ type: "event", event: ev });
    this.emitSnapshot();
    return ev;
  }

  // ---------------------------------------------------------------- state
  private hop(machine: MachineName, entity: string, to: string, out: Transition[]) {
    let frm: string | null;
    if (machine === "case") { frm = this.snap.case_state; this.snap.case_state = to as never; }
    else if (machine === "order") { frm = this.snap.order_state; this.snap.order_state = to as never; }
    else if (machine === "patient") { frm = this.snap.patient_state; this.snap.patient_state = to as never; }
    else {
      const s = this.snap.suppliers.find((x) => x.supplier.id === entity)!;
      frm = s.state; s.state = to as never;
      if (to === "NO_ANSWER") s.misses++;
    }
    if (frm !== to) out.push({ machine, entity: machine === "supplier" ? entity : machine, frm, to });
  }

  private apply(set: SetSpec): Transition[] {
    const out: Transition[] = [];
    const arr = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    if (set.sup) for (const id in set.sup) for (const v of arr(set.sup[id])) this.hop("supplier", id, v, out);
    for (const v of arr(set.order)) this.hop("order", "order", v, out);
    for (const v of arr(set.patient)) this.hop("patient", "patient", v, out);
    for (const v of arr(set.case)) this.hop("case", "case", v, out);
    if (set.reason) for (const id in set.reason) { const s = this.snap.suppliers.find((x) => x.supplier.id === id); if (s) s.reason = set.reason[id]; }
    if (set.next) Object.assign(this.snap.next_check, set.next);
    return out;
  }

  // ---------------------------------------------------------------- steps
  private async exec(step: Step, t: number): Promise<boolean> {
    if (step.call) return this.execCall(step, step.call, t);
    if (step.officeOrder) return this.execOrderFax(step, t);
    if (step.fax) {
      const fax = this.addFax(step.fax.direction, step.fax.to, step.fax.text, {});
      this.emit({ type: "fax", fax });
      this.pushEvent({ thread: step.th, kind: "fax", title: step.title, detail: step.detail, transitions: this.apply(step.set), fax_id: fax.id });
      return false;
    }
    if (step.packet) return this.execEscalation(step, step.packet, t, step.set);
    this.pushEvent({ thread: step.th, kind: step.kind, title: step.title, detail: step.detail, transitions: this.apply(step.set) });
    return false;
  }

  private addFax(direction: "outbound" | "inbound", to: string, text: string, facts: Record<string, Fact>): FaxDocument {
    const fax: FaxDocument = { id: `fax-${String(++this.ids.fax).padStart(2, "0")}`, direction, to, sent_at: this.snap.now, text, facts };
    this.snap.faxes[fax.id] = fax;
    return fax;
  }

  private newCall(sc: ScriptCall, seat: SeatMode, th: Step["th"]): CallRecord {
    const id = `call-${String(++this.ids.call).padStart(2, "0")}`;
    const rec: CallRecord = {
      id, seat, started_at: this.snap.now, outcome: "answered", transcript: [], facts: {}, safety_flag: null,
      goal: { purpose: sc.purpose, thread: th, party_kind: sc.party_kind, party_id: sc.party_id, party_name: sc.party_name, brief: sc.brief, facts: [], may_disclose: [], must_say: [], max_turns: 8 },
    };
    this.emit({ type: "call_started", call_id: id, party_kind: sc.party_kind, party_id: sc.party_id, party_name: sc.party_name, seat, purpose: sc.purpose });
    return rec;
  }

  private say(rec: CallRecord, speaker: Utterance["speaker"], text: string) {
    rec.transcript.push({ speaker, text, at: this.snap.now });
    this.emit({ type: "utterance", call_id: rec.id, speaker, text });
  }

  private endCall(rec: CallRecord, outcome: CallOutcome) {
    rec.outcome = outcome;
    this.snap.calls[rec.id] = rec;
    this.emit({ type: "call_ended", call_id: rec.id, outcome });
  }

  private partyText(rec: CallRecord) { return rec.transcript.filter((u) => u.speaker === "party").map((u) => u.text).join("\n"); }

  private supplierHop(sc: ScriptCall, to: string, out: Transition[]) {
    if (sc.party_kind === "supplier") this.hop("supplier", sc.party_id, to, out);
  }

  private async execCall(step: Step, sc: ScriptCall, t: number): Promise<boolean> {
    const scriptedMiss = sc.outcome && sc.outcome !== "answered";
    const seat: SeatMode = scriptedMiss || (this.rings[step.key] ?? 0) >= 2 ? "auto" : this.seats[sc.party_kind];
    const rec = this.newCall(sc, seat, step.th);

    if (seat === "auto") {
      if (scriptedMiss) {
        await this.sleep(1400 * this.factor());
        for (const l of sc.lines) { this.say(rec, l.s, l.text); await this.sleep(this.speakDelay(l.text)); }
        this.endCall(rec, sc.outcome!);
        this.pushEvent({ thread: step.th, kind: "call", title: step.title, detail: step.detail, transitions: this.apply(step.set), call_id: rec.id });
        return false;
      }
      await this.sleep(700 * this.factor());
      const source: string[] = [];
      for (const l of sc.lines) {
        if (!this.alive(t)) return true;
        await this.sleep(this.speakDelay(l.text) * (l.s === "party" ? 1 : 0.8));
        this.say(rec, l.s, l.text);
        if (l.s === "party") {
          source.push(l.text);
          const src = source.join("\n");
          const facts: Record<string, Fact> = {};
          for (const [k, [v, q]] of Object.entries(sc.facts)) if (q && verifyQuote(q, l.text)) facts[k] = mkFact(k, v, q, src);
          if (Object.keys(facts).length) { Object.assign(rec.facts, facts); await this.sleep(350 * this.factor()); this.emit({ type: "facts", call_id: rec.id, facts }); }
        }
      }
      const src = source.join("\n");
      const rest: Record<string, Fact> = {};
      for (const [k, [v, q]] of Object.entries(sc.facts)) if (!rec.facts[k]) rest[k] = mkFact(k, v, q, src);
      if (Object.keys(rest).length) { Object.assign(rec.facts, rest); this.emit({ type: "facts", call_id: rec.id, facts: rest }); }
      this.snapSupplierFacts(sc, rec);
      if (step.patientUpdate) Object.assign(this.snap.patient, step.patientUpdate);
      await this.sleep(500 * this.factor());
      this.endCall(rec, "answered");
      this.pushEvent({ thread: step.th, kind: "call", title: step.title, detail: step.detail, transitions: this.apply(step.set), call_id: rec.id });
      return false;
    }

    // ---- a person holds this seat
    this.emit({ type: "ringing", call_id: rec.id, party_kind: sc.party_kind, party_name: sc.party_name });
    const pick = await new Promise<PickupResult>((resolve) => {
      this.pickupW.set(rec.id, { resolve });
      setTimeout(() => resolve("timeout"), 45_000);
    });
    this.pickupW.delete(rec.id);
    if (!this.alive(t)) return true;

    if (pick !== "pickup") {
      this.endCall(rec, "no_answer");
      const n = (this.rings[step.key] = (this.rings[step.key] ?? 0) + 1);
      const out: Transition[] = [];
      this.supplierHop(sc, "CALLING", out);
      this.supplierHop(sc, "NO_ANSWER", out);
      if (sc.party_kind === "patient" && this.snap.patient_state === "NOT_CONTACTED") this.hop("patient", "patient", "NO_ANSWER", out);
      const nextAt = this.queue[0]?.at;
      let retryAt = addMin(this.snap.now, n === 1 ? 240 : 60);
      if (nextAt && retryAt >= nextAt) retryAt = addMin(this.snap.now, 2);
      const who = sc.party_name;
      this.pushEvent({
        thread: step.th, kind: "call", title: `${who} didn't pick up`, call_id: rec.id, transitions: out,
        detail: `${pick === "timeout" ? "Rang out." : "You let it ring."} NO_ANSWER is a fact the rules can use: a retry is scheduled ${n === 1 ? "in 4 hours" : "again shortly"}.${n >= 2 ? " (Mock mode: the next attempt is answered by autopilot so the scripted run can continue. The live engine would keep counting toward UNREACHABLE.)" : ""}`,
      });
      this.queue.unshift({ ...step, at: retryAt, title: `Retry: ${step.title.replace(/^Retry: /, "")}` });
      return false;
    }

    // connected
    const asked = new Set<string>();
    let hungUp = false;
    const engineLines = sc.lines.filter((l) => l.s === "engine");
    for (let i = 0; i < engineLines.length && !hungUp; i++) {
      const line = engineLines[i];
      let tries = 0;
      let text = line.text;
      for (;;) {
        await this.sleep(this.speakDelay(text) * 0.7);
        if (!this.alive(t)) return true;
        this.say(rec, "engine", text);
        this.emit({ type: "your_turn", call_id: rec.id });
        const r = await new Promise<SayResult>((resolve) => this.sayW.set(rec.id, { resolve }));
        this.sayW.delete(rec.id);
        if (!this.alive(t)) return true;
        if (r.kind === "hangup") { hungUp = true; break; }
        this.say(rec, "party", r.text);
        const asks = line.asks ?? [];
        asks.forEach((a) => asked.add(a));
        const got = extractReply(r.text, asks, sc.party_kind);
        const safety = detectSafety(r.text);
        if (safety) rec.safety_flag = safety;
        // re-verify against the whole party transcript so far
        const src = this.partyText(rec);
        for (const f of Object.values(got)) f.verified = verifyQuote(f.quote, src);
        const fresh: Record<string, Fact> = { ...got };
        if (safety) fresh.safety_concern = safety;
        if (Object.keys(fresh).length) {
          Object.assign(rec.facts, got);
          await this.sleep(300);
          this.emit({ type: "facts", call_id: rec.id, facts: fresh });
        }
        const answered = asks.length === 0 || asks.some((a) => got[a] && got[a].value !== null);
        const stillMissing = asks.filter((a) => sc.required.includes(a) && !(rec.facts[a] && rec.facts[a].verified && rec.facts[a].value !== null));
        if (tries >= 1 || (answered && stillMissing.length === 0)) break;
        tries++;
        text = answered && stillMissing.length
          ? `Thanks. And ${stillMissing.map((k) => CLARIFY[k] ?? k.replace(/_/g, " ")).join(", and ")}?`
          : `Sorry, I want to be sure I have this right. ${line.text.replace(/^(Hi|Good morning|Hello)[^.?!]*[.?!]\s*/i, "")}`;
      }
    }
    if (!hungUp) {
      const bye = "Thank you, that's everything I needed for now. Goodbye.";
      await this.sleep(this.speakDelay(bye) * 0.6);
      this.say(rec, "engine", bye);
    }
    // anything asked but never heard is recorded as unknown
    for (const k of asked) if (!rec.facts[k]) rec.facts[k] = { key: k, value: null, quote: null, verified: false };
    const unk: Record<string, Fact> = {};
    for (const k of asked) if (rec.facts[k].quote === null) unk[k] = rec.facts[k];
    if (Object.keys(unk).length) this.emit({ type: "facts", call_id: rec.id, facts: unk });
    this.snapSupplierFacts(sc, rec);
    if (step.patientUpdate) {
      const v = (k: string) => (rec.facts[k]?.verified && rec.facts[k].value ? String(rec.facts[k].value) : null);
      Object.assign(this.snap.patient, step.patientUpdate, v("address") ? { address: v("address") } : {}, v("mbi") ? { mbi: v("mbi") } : {});
    }
    this.endCall(rec, hungUp ? "hung_up" : "answered");
    return this.evaluateHuman(step, sc, rec, t);
  }

  private snapSupplierFacts(sc: ScriptCall, rec: CallRecord) {
    if (sc.party_kind !== "supplier") return;
    const s = this.snap.suppliers.find((x) => x.supplier.id === sc.party_id);
    if (s) Object.assign(s.facts, rec.facts);
  }

  /** Rules over the facts a person gave. Mirrors the spec closely enough to demo. */
  private async evaluateHuman(step: Step, sc: ScriptCall, rec: CallRecord, t: number): Promise<boolean> {
    const f = rec.facts;
    const val = (k: string) => (f[k] && f[k].verified ? f[k].value : null);
    const base = { thread: step.th, kind: "call" as const, call_id: rec.id };

    if (rec.safety_flag) {
      const esc = this.raise({
        code: "SAFETY_CONCERN", thread: step.th, blocking: false,
        question: `${sc.party_name} mentioned something that sounds like a fall, an injury or distress. Please check on her.`,
        options: ["Acknowledged"], numbers: [], tried: [`${this.fmt()}: ${step.title}`],
        context: [`Quote: "${rec.safety_flag.quote}"`, "Non-blocking: no thread stops. A person always handles welfare."],
        scripted: { option: "Acknowledged", note: "Called her back; she is OK.", fields: {} },
      }, [rec.id]);
      this.pushEvent({ ...base, kind: "escalation", title: "SAFETY_CONCERN raised (non-blocking)", detail: `safety_concern = true with the quote "${rec.safety_flag.quote}". Welfare is never automated, so a person is notified immediately. Nothing else stops.`, transitions: [], escalation_id: esc.id, call_id: rec.id });
      void this.awaitDecision(esc, t, { option: "Acknowledged", note: "Checked in with her.", fields: {} }).then((d) => {
        if (!this.alive(t)) return;
        this.pushEvent({ thread: step.th, kind: "human", title: `Advocate: ${d.option}`, detail: d.note || "Safety concern acknowledged. Nothing else changes.", transitions: [], escalation_id: esc.id });
      });
    }

    // Patient: cost or decline → a person, by rule.
    if (sc.party_kind === "patient" && (val("cost_concern") === true || val("declines") === true) && step.key !== "waver") {
      const cost = val("cost_concern") === true;
      const out: Transition[] = [];
      this.hop("patient", "patient", cost ? "ESC_COST" : "ESC_DECLINES", out);
      this.hop("case", "case", "BLOCKED_ON_HUMAN", out);
      const q = cost ? f.cost_concern.quote : f.declines.quote;
      this.pushEvent({ ...base, title: cost ? "She raised a cost worry" : "She declined", transitions: out, detail: `${cost ? "cost_concern" : "declines"} = true with the quote "${q}". The rules route this to a person (${cost ? "PATIENT_COST_CONCERN" : "PATIENT_DECLINES"}). The engine doesn't argue with her. The patient thread stops; the others keep going.` });
      return this.execEscalation(step, cost ? COST_PACKET(q ?? "", this.fmt()) : DECLINE_PACKET(q ?? "", this.fmt()), t, step.set, [rec.id]);
    }

    if (step.key === "waver") {
      if (val("cost_concern") === true || val("declines") === true) {
        this.pushEvent({ ...base, title: step.title, detail: step.detail, transitions: this.apply(step.set) });
        return false;
      }
      if (val("consents_to_supplier") === true) {
        this.flags.consentedEarly = true;
        this.pushEvent({ ...base, title: "Eleanor approves Prairie State", transitions: this.apply({ patient: "WINDOW_CONFIRMED", next: { patient: "post-delivery check Thu 11:00" } }),
          detail: `consents_to_supplier = true ("${f.consents_to_supplier.quote}"). WINDOW_CONFIRMED. No escalation: the engine only pulls in a person for a named, quoted reason, and there wasn't one.` });
        return false;
      }
    }

    // Supplier says delivered but no proof → D11 mismatch.
    if (sc.purpose === "supplier_delivery_check" && val("delivered") === true && val("proof_of_delivery") !== true) {
      return this.ambiguous(step, sc, rec, t, `delivered = true but proof_of_delivery is ${val("proof_of_delivery") === false ? `false ("${f.proof_of_delivery.quote}")` : "unknown"}. "Delivered" needs the supplier's proof of delivery and her confirmation (D11), so the rules won't mark it DELIVERED.`);
    }

    // Supplier screen: hard fails disqualify.
    if (sc.purpose === "supplier_screen") {
      const fails: [string, string][] = [];
      if (val("accepting_new_medicare") === false) fails.push(["NOT_ACCEPTING", "accepting_new_medicare"]);
      if (val("accepts_assignment_all_months") === false) fails.push(["NO_ASSIGNMENT", "accepts_assignment_all_months"]);
      const rd = val("restock_days");
      if (val("k0001_in_stock") === false && (rd === null || (rd as number) > 14)) fails.push(["NO_STOCK", "k0001_in_stock"]);
      if (val("serves_address") === false) fails.push(["OUT_OF_AREA", "serves_address"]);
      const eta = val("delivery_eta_days");
      if (typeof eta === "number" && eta > 10) fails.push(["TOO_SLOW", "delivery_eta_days"]);
      const scriptSet = step.set.sup?.[sc.party_id];
      const scriptDisq = (Array.isArray(scriptSet) ? scriptSet : [scriptSet]).includes("DISQUALIFIED");
      if (!fails.length && scriptDisq && sc.required.every((k) => val(k) !== null)) {
        const out: Transition[] = [];
        this.supplierHop(sc, "CALLING", out);
        this.supplierHop(sc, "QUALIFIED", out);
        const s = this.snap.suppliers.find((x) => x.supplier.id === sc.party_id); if (s) s.reason = "qualified on your answers";
        this.pushEvent({ ...base, title: `${sc.party_name} qualifies`, transitions: out,
          detail: `Every fact the rules needed has a quote and none is a hard fail, so QUALIFIED. It is kept as an extra backup. (The scripted persona would have failed here; mock mode only asks the scripted question, the live engine asks the full screen.)` });
        return false;
      }
      if (fails.length) {
        const out: Transition[] = [];
        this.supplierHop(sc, "CALLING", out);
        this.supplierHop(sc, "DISQUALIFIED", out);
        const s = this.snap.suppliers.find((x) => x.supplier.id === sc.party_id); if (s) s.reason = fails[0][0];
        const expected = Array.isArray(step.set.sup?.[sc.party_id]) ? (step.set.sup![sc.party_id] as string[]).includes("QUALIFIED") : false;
        const k = fails[0][1];
        this.pushEvent({ ...base, title: `${sc.party_name} disqualified (${fails[0][0]})`, transitions: out,
          detail: `Hard fail on ${k} with the quote "${f[k].quote}". One quoted hard fail is enough: DISQUALIFIED (${fails[0][0]}).${expected ? " (Mock mode replays a fixed script from here, so later steps still use this supplier. The live engine would move to the next candidate.)" : ""}` });
        return false;
      }
    }

    // Required facts without a quote → a person reviews the call.
    const missing = sc.required.filter((k) => val(k) === null);
    if (missing.length && step.key !== "waver") {
      return this.ambiguous(step, sc, rec, t, `Required fact${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "have" : "has"} no verified quote after a clarifying question, so ${missing.length > 1 ? "they stay" : "it stays"} unknown. The rules never guess: AMBIGUOUS_CALL_OUTCOME.`);
    }
    if (step.key === "waver") {
      return this.ambiguous(step, sc, rec, t, "Her consent to Prairie State has no clear quote. The rules don't treat a vague answer as a yes: AMBIGUOUS_CALL_OUTCOME.");
    }

    // On script.
    const diffs = Object.entries(sc.facts).filter(([k, [v]]) => typeof v === "boolean" && val(k) !== null && val(k) !== v).map(([k]) => `${k} = ${String(val(k))}`);
    const note = diffs.length ? ` (Mock mode: you said ${diffs.join(", ")}, which differs from the scripted run. The live engine branches on that; the mock keeps to its script.)` : "";
    this.pushEvent({ ...base, title: step.title, detail: step.detail + note, transitions: this.apply(step.set) });
    return false;
  }

  private async ambiguous(step: Step, sc: ScriptCall, rec: CallRecord, t: number, why: string): Promise<boolean> {
    this.pushEvent({ thread: step.th, kind: "rule", title: "Call outcome unclear", detail: why, transitions: [], call_id: rec.id });
    const packet: PacketSpec = {
      code: "AMBIGUOUS_CALL_OUTCOME", thread: step.th, blocking: true,
      question: `What did ${sc.party_name} actually say? Review the transcript and set the outcome.`,
      options: ["Treat as the expected outcome", "Have someone call back"],
      numbers: Object.values(rec.facts).map((x) => [x.key, x.value === null || x.value === undefined ? "unknown" : String(x.value)] as [string, string]),
      tried: [`${this.fmt()}: ${step.title}`, "One clarifying question inside the call"],
      context: [why],
      scripted: { option: "Treat as the expected outcome", note: "Listened to the recording; the intent was clear.", fields: {} },
    };
    return this.execEscalation(step, packet, t, step.set, [rec.id]);
  }

  // ---------------------------------------------------------------- escalations
  private raise(p: PacketSpec, callIds: string[] = []): Escalation {
    const esc: Escalation = {
      id: `esc-${String(++this.ids.esc).padStart(2, "0")}`, code: p.code, thread: p.thread, blocking: p.blocking,
      raised_at: this.snap.now, question: p.question, options: p.options, numbers: p.numbers, tried: p.tried, context: p.context,
      call_ids: callIds, decision: null, decision_note: null, decision_fields: {}, resolved_at: null,
    };
    this.snap.escalations.push(esc);
    this.emit({ type: "escalation", escalation: esc });
    return esc;
  }

  private async awaitDecision(esc: Escalation, t: number, scripted: { option: string; note?: string; fields?: Record<string, string> }) {
    const d = await new Promise<{ option: string; note?: string; fields?: Record<string, string> }>((resolve) => {
      let done = false;
      const fin = (v: { option: string; note?: string; fields?: Record<string, string> }) => { if (!done) { done = true; resolve(v); } };
      this.decideW.set(esc.id, { resolve: fin });
      const poll = () => {
        if (done) return;
        if (!this.alive(t)) return fin(scripted);
        if (this.seats.advocate === "auto") setTimeout(() => fin(scripted), 2600 * this.factor());
        else setTimeout(poll, 500);
      };
      poll();
    });
    this.decideW.delete(esc.id);
    // the live advocate clock: a decision lands the next working morning at the earliest
    esc.decision = d.option; esc.decision_note = d.note ?? null; esc.decision_fields = d.fields ?? {}; esc.resolved_at = this.snap.now;
    this.emit({ type: "escalation", escalation: esc });
    return d;
  }

  private async execEscalation(step: Step, p: PacketSpec, t: number, resumeSet: SetSpec, callIds: string[] = []): Promise<boolean> {
    const raisedDuringStep = step.packet !== p;
    const esc = this.raise(p, callIds.length ? callIds : this.lastCallIds(2));
    this.pushEvent({ thread: p.thread, kind: "escalation", title: raisedDuringStep ? `Packet to the care advocate: ${p.code}` : step.title, detail: raisedDuringStep ? "Escalation raised by rule from quoted facts. The packet is the advocate's whole briefing." : step.detail, transitions: [], escalation_id: esc.id });
    const d = await this.awaitDecision(esc, t, p.scripted);
    if (!this.alive(t)) return true;
    if (p.code === "PATIENT_COST_CONCERN" && (step.key === "waver" || step.key === "esc")) this.snap.now = maxIso(this.snap.now, "2026-11-11T10:30:00");
    else this.snap.now = addMin(this.snap.now, 45);

    if (step.key === "waver") this.flags.consentedEarly = true;
    const opt = d.option.toLowerCase();
    if (opt.startsWith("close")) {
      const out: Transition[] = [];
      this.hop("case", "case", "ABANDONED", out);
      this.pushEvent({ thread: p.thread, kind: "human", title: `Advocate: ${d.option}`, detail: `${d.note ? d.note + " " : ""}A typed decision: the case is ABANDONED. Every thread stops and the reason is on file.`, transitions: out, escalation_id: esc.id });
      this.finish();
      return true;
    }
    if (opt.startsWith("pause")) {
      const out: Transition[] = [];
      this.hop("case", "case", "PAUSED", out);
      Object.assign(this.snap.next_check, { case: "re-check in 30 days", patient: "paused", supplier: "paused", order: "valid, held" });
      this.pushEvent({ thread: p.thread, kind: "human", title: `Advocate: ${d.option}`, detail: `${d.note ? d.note + " " : ""}The case is PAUSED for 30 days. The validated order is kept; the engine will re-check on Thu Dec 10.`, transitions: out, escalation_id: esc.id });
      this.finish();
      return true;
    }

    const out: Transition[] = [];
    if (p.code === "PATIENT_COST_CONCERN" || p.code === "PATIENT_DECLINES") {
      this.hop("patient", "patient", "INFORMED", out);
      if (step.key === "waver" || step.key === "esc") this.hop("patient", "patient", "WINDOW_CONFIRMED", out);
      if (this.snap.case_state === "BLOCKED_ON_HUMAN") this.hop("case", "case", "OPEN", out);
      if (step.key === "waver" || step.key === "esc") Object.assign(this.snap.next_check, { patient: "post-delivery check Thu 11:00" });
    }
    const scriptedNote = d.option === p.scripted.option && !d.note ? p.scripted.note : d.note;
    const tail = p.code === "PATIENT_COST_CONCERN"
      ? " A typed decision came back. The engine resumes the patient thread with her consent and window recorded."
      : p.code === "SAFETY_CONCERN" ? "" : " A typed decision came back, so the engine knows exactly where to resume.";
    if (step.key !== "esc" && step.key !== "waver" && p.code !== "SAFETY_CONCERN") out.push(...this.apply(resumeSet));
    this.pushEvent({ thread: p.thread, kind: "human", title: `Advocate: ${d.option}`, detail: `${scriptedNote ? scriptedNote : ""}${tail}`.trim(), transitions: out, escalation_id: esc.id });
    return false;
  }

  private lastCallIds(n: number) { return Object.keys(this.snap.calls).slice(-n); }

  private finish() {
    this.snap.running = false;
    this.snap.done = true;
    this.emitSnapshot();
  }

  // ---------------------------------------------------------------- the order
  private async execOrderFax(step: Step, t: number): Promise<boolean> {
    const loop = step.officeOrder!;
    let text = step.fax!.text;
    const human = this.seats.office === "human";
    if (human) {
      this.flags.orderDynamic = true;
      const request_id = `req-${String(++this.ids.req).padStart(2, "0")}`;
      const prefill = loop === 1 ? CLEAN_ORDER : CLEAN_ORDER.replace("STANDARD WRITTEN ORDER", "STANDARD WRITTEN ORDER (corrected)").replace("11/04/2026", "11/06/2026");
      const request_text = loop === 1 ? (this.snap.faxes["fax-01"]?.text ?? "") : `CORRECTION REQUEST\n${this.lastIssues.map((i) => "• " + i).join("\n")}\nPlease re-sign and return. The engine writes no clinical text.`;
      Object.assign(this.snap.next_check, { order: "waiting for you (office) to fax the signed order" });
      this.emitSnapshot();
      this.emit({ type: "fax_requested", request_id, prefill, request_text });
      text = await new Promise<string>((resolve) => this.faxW.set(request_id, { resolve }));
      this.faxW.delete(request_id);
      if (!this.alive(t)) return true;
    }
    const reading = readOrder(text, this.snap.patient.visit_date, this.criteria);
    reading.criteriaMet.forEach((c) => this.criteria.add(c));
    const fax = this.addFax("inbound", "engine", text, reading.facts);
    this.emit({ type: "fax", fax });
    const out: Transition[] = [];
    this.hop("order", "order", "RECEIVED", out);

    if (!human) {
      // autopilot: the scripted documents, read by the same validator
      const set = { ...step.set, order: (Array.isArray(step.set.order) ? step.set.order : [step.set.order!]).filter((s) => s !== "RECEIVED") };
      out.push(...this.apply(set));
      if (reading.valid) this.flags.orderValid = true;
      this.lastIssues = reading.issues.map((i) => i.text);
      this.pushEvent({ thread: "order", kind: "fax", title: step.title, detail: step.detail, transitions: out, fax_id: fax.id });
      return false;
    }

    const lp = this.snap.suppliers.find((s) => s.state === "COMMITTED" || s.state === "CONFIRMED");
    if (reading.valid) {
      this.flags.orderValid = true;
      this.hop("order", "order", "VALIDATED", out);
      if (lp) this.hop("order", "order", "SENT_TO_SUPPLIER", out);
      Object.assign(this.snap.next_check, { order: lp ? "waiting for the supplier's review" : "waiting for a committed supplier" });
      this.pushEvent({ thread: "order", kind: "fax", title: "Your order passes the validator", transitions: out, fax_id: fax.id,
        detail: `6 of 6 order elements, each with a quote from the fax. HCPCS ${reading.hcpcs}. Quantity 1. Dated after the visit. The note pre-screen finds a sentence for every criterion A–G. VALIDATED.${lp ? ` ${lp.supplier.name} is committed, so the order, her name and her MBI go to it only (D3).` : ""}` });
      return false;
    }

    this.lastIssues = reading.issues.map((i) => i.text);
    const list = reading.issues.map((i) => `• [${i.kind}] ${i.text}`).join("\n");
    if (reading.clinical || this.flags.orderLoops >= 2) {
      const code = reading.clinical ? "ORDER_NEEDS_CLINICAL_FIX" : reading.issues.every((i) => i.kind === "gap") ? "DOCS_INSUFFICIENT" : "ORDER_NEEDS_CLINICAL_FIX";
      this.hop("order", "order", reading.clinical ? "ESC_CLINICAL" : code === "DOCS_INSUFFICIENT" ? "ESC_DOCS" : "ESC_CLINICAL", out);
      this.pushEvent({ thread: "order", kind: "fax", title: reading.clinical ? "Code and note disagree on the chair" : "Still not right after two correction loops", transitions: out, fax_id: fax.id,
        detail: `Validator findings:\n${list}\n${reading.clinical ? "This is a clinical choice, not a clerical slip, so the engine stops and asks a person." : "The correction loop is capped at 2 (spec §6), so a person takes it from here."}` });
      return this.execEscalation(step, {
        code: code as PacketSpec["code"], thread: "order", blocking: true,
        question: reading.clinical ? "Dr. Chen's order and note point to a different chair. Which one does she intend?" : "The office can't produce a usable order. How should we proceed?",
        options: reading.clinical ? ["Doctor confirms K0001", "New code: re-run qualification"] : ["Re-visit booked", "Close the case"],
        numbers: [["HCPCS on order", reading.hcpcs ?? "missing"], ["Correction loops", String(this.flags.orderLoops)]],
        tried: [`${this.fmt()}: order received and validated`, ...reading.issues.map((i) => i.text)],
        context: ["The engine never writes clinical text or picks equipment (D8)."],
        scripted: { option: reading.clinical ? "Doctor confirms K0001" : "Re-visit booked", note: "", fields: {} },
      }, t, { order: ["RECEIVED", "VALIDATED", ...(lp ? ["SENT_TO_SUPPLIER"] : [])] });
    }

    this.flags.orderLoops++;
    this.hop("order", "order", "CORRECTION_REQUESTED", out);
    Object.assign(this.snap.next_check, { order: "calling the office about the correction" });
    this.pushEvent({ thread: "order", kind: "fax", title: `Validator caught ${reading.issues.length} problem${reading.issues.length > 1 ? "s" : ""} in your fax`, transitions: out, fax_id: fax.id,
      detail: `${list}\nClerical errors and note gaps go back to the office as a neutral request. CORRECTION_REQUESTED, loop ${this.flags.orderLoops} of 2. The engine names what's missing and writes no clinical text (D8).` });

    // dynamic: a correction call to the office, then wait for the re-signed order
    const callAt = addMin(this.snap.now, 5);
    const resignAt = maxIso(addMin(this.snap.now, 60 * 22), this.snap.now);
    const ask = this.correctionAsk(reading.issues.map((i) => i.text));
    this.queue.unshift(
      { key: `corr-call-${this.flags.orderLoops}`, at: callAt, th: "order", kind: "call", title: "Ask the office for a correction",
        call: { purpose: "office_correction", party_kind: "office", party_id: "sunrise", party_name: "Maria, Sunrise", required: ["correction_accepted"], brief: "Ask for a corrected, re-signed order; route documentation gaps to the doctor.",
          lines: [{ s: "engine", text: ask, asks: ["correction_accepted", "clinical_disagreement"] }, { s: "party", text: "Okay, I'll fix that and get Dr. Chen to re-sign it tomorrow." }],
          facts: { correction_accepted: [true, "I'll fix that"] } },
        detail: "The office accepts the correction. Documentation questions go to the clinician; the engine wrote no clinical text (D8).",
        set: { next: { order: "corrected order due next business day" } } },
      { key: `resign-${this.flags.orderLoops}`, at: resignAt, th: "order", kind: "fax", officeOrder: 2, title: "Corrected order arrives", fax: { direction: "inbound", to: "engine", text: CLEAN_ORDER }, detail: "The corrected order passes the validator: VALIDATED and sent to the committed supplier.", set: { order: ["RECEIVED", "VALIDATED", "SENT_TO_SUPPLIER"] } },
    );
    return false;
  }

  private lastIssues: string[] = [];

  private correctionAsk(issues: string[]) {
    const parts = issues.map((i) => i.replace(/\.$/, "")).slice(0, 4);
    return `Hi Maria, this is the automated assistant for Eleanor Martinez's care team. The order you faxed came back with ${parts.length === 1 ? "one problem" : `${parts.length} problems`}: ${parts.join("; ")}. Could Dr. Chen correct and re-sign it? For anything about the note, we've sent the checklist, and only Dr. Chen can add to it.`;
  }

  private fmt() {
    const d = new Date(this.snap.now + "Z");
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
}

const CLARIFY: Record<string, string> = {
  accepting_new_medicare: "are you taking new Medicare patients right now",
  accepts_assignment_all_months: "do you accept assignment for every rental month",
  k0001_in_stock: "do you have a K0001 in stock",
  serves_address: "do you deliver to 60614",
  delivery_eta_days: "how many business days from getting the order to delivery",
  still_available: "can you still take the referral",
  earliest_delivery: "what's the earliest day you could deliver",
  order_received: "do you have the order and the note",
  eligibility_clean: "did her eligibility check come back clean",
  docs_sufficient: "does the note support coverage",
  delivery_date: "what day and window will you deliver",
  delivered: "was the chair delivered",
  proof_of_delivery: "was a delivery ticket signed",
  billed_hcpcs: "what code are you billing",
  request_received: "do you have the order request",
  correction_accepted: "can that be corrected and re-signed",
  address: "what's your home address",
  mbi: "could you read me the Medicare number on your card",
  prior_wheelchair: "did you have a wheelchair after the surgery",
  consents_to_supplier: "is it all right if they provide the chair",
  window_ok: "does that delivery time work for you",
};

const maxIso = (a: string, b: string) => (a > b ? a : b);

const COST_PACKET = (quote: string, when: string): PacketSpec => ({
  code: "PATIENT_COST_CONCERN", thread: "patient", blocking: true,
  question: "Does Eleanor want to go ahead, and does she need help paying?",
  options: ["Proceed", "Proceed and start a QMB application", "Pause 30 days", "Close the case"],
  numbers: COST.map(([a, b]) => [a, b] as [string, string]),
  tried: [`${when}: she said "${quote}"`],
  context: ["The engine explained the cost range with rules-computed numbers and did not try to persuade her."],
  scripted: { option: "Proceed and start a QMB application", note: "Walked her through the ≈$72 total and started a QMB screen. She wants to go ahead.", fields: {} },
});
const DECLINE_PACKET = (quote: string, when: string): PacketSpec => ({
  code: "PATIENT_DECLINES", thread: "patient", blocking: true,
  question: "Eleanor declined the chair. Should we proceed after talking with her, or close?",
  options: ["Proceed", "Close the case"],
  numbers: [],
  tried: [`${when}: she said "${quote}"`],
  context: ["Willingness to use the chair is coverage criterion E. A person should hear why."],
  scripted: { option: "Proceed", note: "Talked it through; she wants to try the chair.", fields: {} },
});
