import type { CaseSnapshot, ClientMsg, FaxDocument, ServerMsg } from "../types";
import type { Transport } from "./transport";
import { speech } from "./speech";

/** Header of a replay file (written by scripts/slim_replay.py). */
export interface ReplayMeta {
  title: string;
  /** ISO local datetime the run was recorded. */
  recorded_at: string;
  calls: number;
  escalations: number;
  final_state: CaseSnapshot["case_state"];
  /** Sim clock at the first / last snapshot (ISO). */
  sim_start: string;
  sim_end: string;
  api_spend_usd: number;
  note: string;
}

/**
 * Intermediate snapshots in the file reference the final snapshot's events/faxes
 * instead of carrying copies (see scripts/slim_replay.py). Inflated on load.
 */
type StoredCase = Omit<CaseSnapshot, "events" | "faxes"> & {
  events?: CaseSnapshot["events"];
  faxes?: CaseSnapshot["faxes"];
  events_upto?: number;
  fax_ids?: string[];
};
type StoredMsg = Exclude<ServerMsg, { type: "snapshot" }> | { type: "snapshot"; case: StoredCase };
interface ReplayFile { meta: ReplayMeta; messages: StoredMsg[] }

/** Seconds between engine events that counts as 1x (matches the speed control's default). */
const BASE_PACE = 1.6;

/** Delay after emitting a message, in seconds at 1x. */
function baseDelay(m: ServerMsg): number {
  switch (m.type) {
    case "utterance": return Math.min(1.8, Math.max(0.6, 0.45 + m.text.length * 0.011));
    case "facts": return 0.25;
    case "event": return 0.9;
    case "call_started": return 0.5;
    case "call_ended": return 0.4;
    default: return 0.1;
  }
}

function inflate(file: ReplayFile): ServerMsg[] {
  const snaps = file.messages.filter((m): m is { type: "snapshot"; case: StoredCase } => m.type === "snapshot");
  const final = snaps[snaps.length - 1]?.case;
  const allEvents = final?.events ?? [];
  const allFaxes = final?.faxes ?? {};
  return file.messages.map((m): ServerMsg => {
    if (m.type !== "snapshot") return m;
    const { events_upto, fax_ids, events, faxes, ...rest } = m.case;
    const ev = events ?? allEvents.slice(0, events_upto ?? 0);
    const fx: Record<string, FaxDocument> = faxes ?? {};
    if (!faxes) for (const id of fax_ids ?? []) if (allFaxes[id]) fx[id] = allFaxes[id];
    return { type: "snapshot", case: { ...rest, events: ev, faxes: fx } };
  });
}

/**
 * Plays a recorded run back through the same message stream the live engine emits.
 * Read-only: seat / pickup / say / fax / decide messages are ignored.
 */
export class ReplayEngine implements Transport {
  private onMsg: (m: ServerMsg) => void;
  private onLoad?: (meta: ReplayMeta) => void;
  private msgs: ServerMsg[] = [];
  /** index of last message in each step group (an engine event plus trailing snapshots) */
  private groupEnd = new Set<number>();
  private _meta: ReplayMeta | null = null;
  private loaded = false;
  private pendingStart = false;
  private idx = 0;
  private started = false;
  private finished = false;
  private paused = false;
  private pace = BASE_PACE;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** What the reducer's snapshot currently looks like, so pause/resume can re-emit it. */
  private cur: CaseSnapshot | null = null;
  private welcome: CaseSnapshot | null = null;

  constructor(onMsg: (m: ServerMsg) => void, url = "/replays/eleanor.json", onLoad?: (meta: ReplayMeta) => void) {
    this.onMsg = onMsg;
    this.onLoad = onLoad;
    void this.load(url);
  }

  get meta(): ReplayMeta | null { return this._meta; }

  private async load(url: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = (await res.json()) as ReplayFile;
      if (this.closed) return;
      this.msgs = inflate(file);
      this.computeGroups();
      const first = this.msgs.find((m): m is { type: "snapshot"; case: CaseSnapshot } => m.type === "snapshot");
      if (!first) throw new Error("replay has no snapshot");
      this.welcome = { ...first.case, events: [], running: false, done: false, calls: {}, faxes: {}, escalations: [] };
      this._meta = file.meta;
      this.loaded = true;
      this.onLoad?.(file.meta);
      this.emit(this.welcome);
      if (this.pendingStart) { this.pendingStart = false; this.start(); }
    } catch (e) {
      if (!this.closed) this.onMsg({ type: "error", message: `Couldn't load replay ${url}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private computeGroups() {
    const n = this.msgs.length;
    for (let i = 0; i < n; i++) {
      if (this.msgs[i].type !== "event") continue;
      let j = i;
      while (j + 1 < n && this.msgs[j + 1].type === "snapshot") j++;
      this.groupEnd.add(j);
      i = j;
    }
    if (n) this.groupEnd.add(n - 1);
  }

  // ---------------------------------------------------------------- transport
  send(m: ClientMsg) {
    if (this.closed) return;
    if (m.type === "start") { this.start(); return; }
    if (m.type !== "control") return; // replay is read-only
    switch (m.action) {
      case "pause": this.pause(); break;
      case "resume": this.resume(); break;
      case "step": this.step(); break;
      case "speed": if (typeof m.value === "number" && Number.isFinite(m.value)) this.pace = Math.max(0, m.value); break;
    }
  }

  close() { this.closed = true; this.clearTimer(); }

  // ---------------------------------------------------------------- playback
  private reset(paused: boolean) {
    this.clearTimer();
    this.idx = 0;
    this.started = true;
    this.finished = false;
    this.paused = paused;
    // events: [] tells the reducer this is a restart, so it drops old calls/escalations
    this.emit({ ...this.welcome!, running: !paused });
  }

  private start() {
    if (!this.loaded) { this.pendingStart = true; return; }
    this.reset(false);
    this.schedule(0.4);
  }

  private pause() {
    if (!this.started || this.finished || this.paused) return;
    this.paused = true;
    this.clearTimer();
    this.emit({ ...this.cur!, running: false });
  }

  private resume() {
    if (!this.loaded) return;
    if (!this.started) { this.start(); return; }
    if (this.finished || !this.paused) return;
    this.paused = false;
    this.emit({ ...this.cur!, running: true });
    this.schedule(0);
  }

  private step() {
    if (!this.loaded) return;
    if (!this.started || this.finished) this.reset(true);
    else if (!this.paused) this.pause();
    while (this.idx < this.msgs.length) {
      const i = this.idx;
      this.emitNext();
      if (this.groupEnd.has(i)) break;
    }
  }

  private schedule(baseSeconds: number) {
    this.clearTimer();
    const ms = baseSeconds * 1000 * (this.pace / BASE_PACE);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  private clearTimer() { if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; } }

  private tick() {
    this.timer = null;
    if (this.closed || this.paused || this.finished) return;
    const m = this.emitNext();
    // Hold at a hand-off to a person so the viewer actually sees it; Resume continues.
    if (m?.type === "escalation" && !m.escalation.decision && m.escalation.code !== "SAFETY_CONCERN") { this.pause(); return; }
    if (!m || this.finished) return;
    if (speech.enabled && (m.type === "utterance" || (m.type === "call_ended" && m.outcome !== "answered" && m.outcome !== "hung_up"))) {
      // Read aloud: wait for the voice to finish, then a short beat, whatever the speed.
      const gen = this.idx;
      speech.idle().then(() => { if (!this.closed && !this.paused && !this.finished && this.idx === gen && this.timer === null) this.timer = setTimeout(() => this.tick(), 350); });
      return;
    }
    this.schedule(baseDelay(m));
  }

  private emitNext(): ServerMsg | null {
    if (this.idx >= this.msgs.length) { this.finished = true; return null; }
    const m = this.msgs[this.idx++];
    const last = this.idx >= this.msgs.length;
    if (m.type === "snapshot") {
      const done = m.case.done || last;
      this.emit({ ...m.case, running: done ? false : !this.paused, done: m.case.done || last });
    } else {
      if (this.cur) {
        if (m.type === "event" && !this.cur.events.some((e) => e.id === m.event.id)) this.cur = { ...this.cur, events: [...this.cur.events, m.event] };
        else if (m.type === "fax") this.cur = { ...this.cur, faxes: { ...this.cur.faxes, [m.fax.id]: m.fax } };
        else if (m.type === "escalation") {
          const esc = this.cur.escalations;
          const next = esc.some((e) => e.id === m.escalation.id) ? esc.map((e) => (e.id === m.escalation.id ? m.escalation : e)) : [...esc, m.escalation];
          this.cur = { ...this.cur, escalations: next };
        }
      }
      this.onMsg(m);
    }
    if (last) this.finished = true;
    return m;
  }

  private emit(c: CaseSnapshot) {
    this.cur = c;
    if (!this.closed) this.onMsg({ type: "snapshot", case: c });
  }
}
