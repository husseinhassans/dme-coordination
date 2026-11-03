import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { CallOutcome, CaseSnapshot, ClientMsg, Escalation, Fact, PartyKind, SeatKey, SeatMode, ServerMsg, Utterance } from "../types";
import { MockEngine } from "../mock/MockEngine";
import { openWs, wantsMock, wsUrl, type ConnStatus, type Transport } from "./transport";

export interface LiveCall {
  call_id: string;
  party_kind: PartyKind;
  party_id: string;
  party_name: string;
  seat: SeatMode;
  purpose: string;
  status: "dialing" | "ringing" | "connected" | "ended";
  outcome?: CallOutcome;
  transcript: Utterance[];
  facts: Record<string, Fact>;
  /** keys in the order they arrived, for animation */
  factOrder: string[];
  yourTurn: boolean;
  startedAt: string | null;
  seq: number;
}

export interface FaxRequest { request_id: string; prefill: string; request_text: string }

export interface Toast {
  id: number;
  tone: "human" | "info" | "bad" | "ok";
  title: string;
  body?: string;
  action?: { label: string; kind: "escalation" | "fax" | "call"; ref: string };
}

export interface EngineState {
  status: ConnStatus;
  snapshot: CaseSnapshot | null;
  calls: Record<string, LiveCall>;
  seq: number;
  faxRequest: FaxRequest | null;
  escalations: Record<string, Escalation>;
  toasts: Toast[];
  toastSeq: number;
}

type Action =
  | { kind: "msg"; msg: ServerMsg }
  | { kind: "status"; status: ConnStatus }
  | { kind: "dismiss"; id: number }
  | { kind: "faxSent" }
  | { kind: "seatLocal"; seat: SeatKey; mode: SeatMode }
  | { kind: "turnTaken"; call_id: string };

const init: EngineState = { status: "connecting", snapshot: null, calls: {}, seq: 0, faxRequest: null, escalations: {}, toasts: [], toastSeq: 0 };

function toast(s: EngineState, t: Omit<Toast, "id">): EngineState {
  const id = s.toastSeq + 1;
  return { ...s, toastSeq: id, toasts: [...s.toasts.slice(-3), { ...t, id }] };
}

function patchCall(s: EngineState, id: string, f: (c: LiveCall) => LiveCall): EngineState {
  const c = s.calls[id];
  if (!c) return s;
  return { ...s, calls: { ...s.calls, [id]: f(c) } };
}

function reducer(s: EngineState, a: Action): EngineState {
  switch (a.kind) {
    case "status": return { ...s, status: a.status };
    case "dismiss": return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case "faxSent": return { ...s, faxRequest: null };
    case "turnTaken": return patchCall(s, a.call_id, (c) => ({ ...c, yourTurn: false }));
    case "seatLocal":
      if (!s.snapshot) return s;
      return { ...s, snapshot: { ...s.snapshot, seats: { ...s.snapshot.seats, [a.seat]: a.mode } } };
    case "msg": break;
  }
  const m = a.msg;
  switch (m.type) {
    case "snapshot": {
      const restarted = !s.snapshot || s.snapshot.case_id !== m.case.case_id || (m.case.events.length === 0 && s.snapshot.events.length > 0);
      const base = restarted ? { ...s, calls: {}, faxRequest: null, escalations: {} } : s;
      const esc = { ...base.escalations };
      for (const e of m.case.escalations) esc[e.id] = e;
      return { ...base, snapshot: m.case, escalations: esc };
    }
    case "event": {
      if (!s.snapshot || s.snapshot.events.some((e) => e.id === m.event.id)) return s;
      return { ...s, snapshot: { ...s.snapshot, events: [...s.snapshot.events, m.event] } };
    }
    case "call_started": {
      const seq = s.seq + 1;
      const c: LiveCall = {
        call_id: m.call_id, party_kind: m.party_kind, party_id: m.party_id, party_name: m.party_name, seat: m.seat, purpose: m.purpose,
        status: "dialing", transcript: [], facts: {}, factOrder: [], yourTurn: false, startedAt: s.snapshot?.now ?? null, seq,
      };
      return { ...s, seq, calls: { ...s.calls, [m.call_id]: c } };
    }
    case "ringing": {
      const next = s.calls[m.call_id] ? s : reducer(s, { kind: "msg", msg: { type: "call_started", call_id: m.call_id, party_kind: m.party_kind, party_id: "", party_name: m.party_name, seat: "human", purpose: "" } });
      return patchCall(next, m.call_id, (c) => ({ ...c, status: "ringing", seat: "human" }));
    }
    case "utterance":
      return patchCall(s, m.call_id, (c) => ({ ...c, status: c.status === "ended" ? "ended" : "connected", transcript: [...c.transcript, { speaker: m.speaker, text: m.text }], yourTurn: false }));
    case "your_turn":
      return patchCall(s, m.call_id, (c) => ({ ...c, status: "connected", yourTurn: true }));
    case "facts":
      return patchCall(s, m.call_id, (c) => {
        const order = [...c.factOrder];
        for (const k of Object.keys(m.facts)) if (!order.includes(k)) order.push(k);
        return { ...c, facts: { ...c.facts, ...m.facts }, factOrder: order };
      });
    case "call_ended":
      return patchCall(s, m.call_id, (c) => ({ ...c, status: "ended", outcome: m.outcome, yourTurn: false }));
    case "fax_requested":
      return toast({ ...s, faxRequest: { request_id: m.request_id, prefill: m.prefill, request_text: m.request_text } },
        { tone: "human", title: "The engine is waiting for your fax", body: "You hold the doctor's office seat. Review the order, plant a mistake if you like, and send it.", action: { label: "Open fax", kind: "fax", ref: m.request_id } });
    case "fax":
      if (!s.snapshot) return s;
      return { ...s, snapshot: { ...s.snapshot, faxes: { ...s.snapshot.faxes, [m.fax.id]: m.fax } } };
    case "escalation": {
      const prev = s.escalations[m.escalation.id];
      const next = { ...s, escalations: { ...s.escalations, [m.escalation.id]: m.escalation } };
      if (!prev && !m.escalation.decision) {
        return toast(next, { tone: "human", title: `Escalation · ${m.escalation.code}`, body: m.escalation.question, action: { label: "Open packet", kind: "escalation", ref: m.escalation.id } });
      }
      return next;
    }
    case "error":
      return toast(s, { tone: "bad", title: "Engine error", body: m.message });
  }
  return s;
}

export function useEngine() {
  const [state, dispatch] = useReducer(reducer, init);
  const tRef = useRef<Transport | null>(null);
  const mockRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const onMsg = (m: ServerMsg) => { if (!cancelled) dispatch({ kind: "msg", msg: m }); };
    const startMock = () => {
      if (cancelled) return;
      tRef.current?.close();
      mockRef.current = true;
      tRef.current = new MockEngine(onMsg);
      dispatch({ kind: "status", status: "mock" });
    };
    if (wantsMock()) startMock();
    else tRef.current = openWs(wsUrl(), onMsg, (st) => dispatch({ kind: "status", status: st }), startMock);
    return () => { cancelled = true; tRef.current?.close(); };
  }, []);

  const send = useCallback((m: ClientMsg) => tRef.current?.send(m), []);

  const actions = useMemo(() => ({
    start: () => send({ type: "start" }),
    setSeat: (seat: SeatKey, mode: SeatMode) => { dispatch({ kind: "seatLocal", seat, mode }); send({ type: "seat", party_kind: seat, mode }); },
    pause: () => send({ type: "control", action: "pause" }),
    resume: () => send({ type: "control", action: "resume" }),
    step: () => send({ type: "control", action: "step" }),
    speed: (secondsBetweenEvents: number) => send({ type: "control", action: "speed", value: secondsBetweenEvents }),
    pickup: (call_id: string) => send({ type: "pickup", call_id }),
    letRing: (call_id: string) => send({ type: "let_ring", call_id }),
    say: (call_id: string, text: string) => { dispatch({ kind: "turnTaken", call_id }); send({ type: "say", call_id, text }); },
    hangup: (call_id: string) => { dispatch({ kind: "turnTaken", call_id }); send({ type: "hangup", call_id }); },
    sendFax: (request_id: string, text: string) => { dispatch({ kind: "faxSent" }); send({ type: "send_fax", request_id, text }); },
    decide: (escalation_id: string, option: string, note?: string, fields?: Record<string, string>) =>
      send({ type: "decide", escalation_id, option, ...(note ? { note } : {}), ...(fields && Object.keys(fields).length ? { fields } : {}) }),
    dismissToast: (id: number) => dispatch({ kind: "dismiss", id }),
  }), [send]);

  return { state, actions };
}

export type EngineActions = ReturnType<typeof useEngine>["actions"];
