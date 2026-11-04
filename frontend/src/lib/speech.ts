// Read calls aloud with the browser's built-in speech synthesis (no key, no cost).
//
// The speech queue is fed straight from the message stream (useEngine calls observe()),
// not from React renders, so the replay can wait on idle() and stay in step with the
// voice. One call is spoken at a time; lines from other calls that overlap are skipped.
import type { PartyKind, ServerMsg } from "../types";

type Role = "engine" | PartyKind;

// Preferred voices, best first. macOS "Premium"/"Enhanced" voices sound far better
// when installed (System Settings → Accessibility → Spoken Content → Manage Voices).
const PREFS: Record<Role, RegExp[]> = {
  engine: [/^Ava \((Premium|Enhanced)\)/, /^Zoe \((Premium|Enhanced)\)/, /^Samantha/, /Google US English/],
  patient: [/^Grandma \(English \(United States\)\)/, /^Moira/, /^Karen/, /Google UK English Female/],
  supplier: [/^Evan \((Premium|Enhanced)\)/, /^Reed \(English \(United States\)\)/, /^Eddy \(English \(United States\)\)/, /^Daniel/, /Google UK English Male/],
  office: [/^Shelley \(English \(United States\)\)/, /^Sandy \(English \(United States\)\)/, /^Tessa/, /Google UK English Female/],
};
// macOS ships joke voices tagged en-US; never fall back to one of them.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Jester|Junior|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Ralph|Kathy|Rocko|Grandpa)\b/;
const TUNE: Record<Role, { rate: number; pitch: number }> = {
  engine: { rate: 1.04, pitch: 1 }, patient: { rate: 0.92, pitch: 0.95 }, supplier: { rate: 1.08, pitch: 0.9 }, office: { rate: 1.05, pitch: 1.05 },
};

class Speech {
  enabled = false;
  private queue: { text: string; role: Role }[] = [];
  private speaking = false;
  private waiters: (() => void)[] = [];
  private calls = new Map<string, { kind: PartyKind; human: boolean; name: string }>();
  private current: string | null = null;
  private voices: Partial<Record<Role, SpeechSynthesisVoice>> = {};
  private listeners = new Set<(on: boolean) => void>();

  get supported() { return typeof window !== "undefined" && "speechSynthesis" in window; }

  constructor() {
    if (!this.supported) return;
    const pick = () => this.pickVoices();
    pick();
    window.speechSynthesis.addEventListener?.("voiceschanged", pick);
  }

  private pickVoices() {
    const all = window.speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang) && !NOVELTY.test(v.name));
    const used = new Set<string>();
    for (const role of ["engine", "patient", "supplier", "office"] as Role[]) {
      let v: SpeechSynthesisVoice | undefined;
      for (const re of PREFS[role]) { v = all.find((x) => re.test(x.name) && !used.has(x.name)); if (v) break; }
      v = v ?? all.find((x) => !used.has(x.name)) ?? all[0];
      if (v) { this.voices[role] = v; used.add(v.name); }
    }
  }

  /** Must be called from a click (browsers only allow speech after a user gesture). */
  setEnabled(on: boolean) {
    if (!this.supported) return;
    this.enabled = on;
    if (on) { this.pickVoices(); window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance("")); }
    else this.reset();
    this.listeners.forEach((f) => f(on));
  }
  subscribe(f: (on: boolean) => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  reset() {
    this.queue = []; this.current = null; this.calls.clear();
    if (this.supported) window.speechSynthesis.cancel();
    this.speaking = false;
    this.flush();
  }

  /** Stop the current line and drop what's queued (the person has already read it). */
  interrupt() {
    this.queue = [];
    if (this.speaking && this.supported) window.speechSynthesis.cancel();
  }

  observe(m: ServerMsg) {
    if (m.type === "call_started") this.calls.set(m.call_id, { kind: m.party_kind, human: m.seat === "human", name: m.party_name });
    else if (m.type === "ringing") this.calls.set(m.call_id, { kind: m.party_kind, human: true, name: m.party_name });
    else if (m.type === "call_ended") {
      if (m.call_id === this.current) this.current = null;
      // A call nobody picked up has no lines; say so, or it passes by in silence.
      const c = this.calls.get(m.call_id);
      if (this.enabled && c && !this.current && (m.outcome === "no_answer" || m.outcome === "voicemail")) {
        this.queue.push({ text: `Called ${c.name}. ${m.outcome === "voicemail" ? "Left a voicemail." : "No answer."}`, role: "engine" });
        this.next();
      }
    }
    else if (m.type === "utterance" && this.enabled) {
      const c = this.calls.get(m.call_id);
      if (!c) return;
      if (this.current && this.current !== m.call_id) return; // one call at a time
      this.current = m.call_id;
      if (m.speaker === "party" && c.human) {
        // You typed a reply, so you've already read what came before it: skip the rest.
        this.queue = []; if (this.speaking) window.speechSynthesis.cancel();
        return;
      }
      this.queue.push({ text: m.text, role: m.speaker === "engine" ? "engine" : c.kind });
      this.next();
    }
  }

  /** Resolves when everything queued so far has been spoken. */
  idle(): Promise<void> {
    if (!this.enabled || (!this.speaking && !this.queue.length)) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private flush() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  private next() {
    if (this.speaking) return;
    const item = this.queue.shift();
    if (!item) { this.flush(); return; }
    this.speaking = true;
    const u = new SpeechSynthesisUtterance(item.text);
    const v = this.voices[item.role];
    if (v) { u.voice = v; u.lang = v.lang; }
    // Live runs don't wait for the voice, so speed up when lines pile up instead of falling behind.
    const catchUp = 1 + Math.min(0.5, this.queue.length * 0.15);
    u.rate = TUNE[item.role].rate * catchUp; u.pitch = TUNE[item.role].pitch;
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(guard); this.speaking = false; this.next(); };
    // Safety net: some browsers occasionally never fire onend.
    const guard = setTimeout(finish, 2500 + item.text.length * 120);
    u.onend = finish; u.onerror = finish;
    window.speechSynthesis.speak(u);
  }
}

export const speech = new Speech();
