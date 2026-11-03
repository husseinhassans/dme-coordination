import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallRecord, MachineName, ThreadName } from "./types";
import { useEngine, type LiveCall, type Toast } from "./lib/useEngine";
import { deriveMachines } from "./lib/machines";
import { fmtWhen } from "./lib/format";
import { ORDER_FACTS, PURPOSE_FACTS } from "./lib/purposes";
import { startRing, stopRing, unlockAudio } from "./lib/sound";
import { SPEEDS, TopBar } from "./components/TopBar";
import { SeatBar } from "./components/SeatBar";
import { CaseSummary, SupplierBoard, ThreadCards } from "./components/LeftColumn";
import { CallView, DoneBanner, EventView, FaxView, IdlePanel, InspectBar, RingingCard, Welcome } from "./components/CenterPane";
import { FaxComposer } from "./components/FaxComposer";
import { HeardPanel, HintsCard, RulesCard, ThesisStrip, type HeardSource } from "./components/RightColumn";
import { Timeline } from "./components/Timeline";
import { EscalationDrawer } from "./components/EscalationDrawer";
import { MachinesModal, Toasts } from "./components/Overlays";

const recToLive = (r: CallRecord): LiveCall => ({
  call_id: r.id, party_kind: r.goal.party_kind, party_id: r.goal.party_id, party_name: r.goal.party_name, seat: r.seat, purpose: r.goal.purpose,
  status: "ended", outcome: r.outcome, transcript: r.transcript, facts: { ...r.facts, ...(r.safety_flag ? { safety_concern: r.safety_flag } : {}) },
  factOrder: Object.keys(r.facts), yourTurn: false, startedAt: r.started_at, seq: 0,
});

const THREAD_OF: Record<string, ThreadName> = { supplier: "supplier", office: "order", patient: "patient" };

type Center =
  | { kind: "loading" } | { kind: "welcome" }
  | { kind: "ringing"; call: LiveCall } | { kind: "call"; call: LiveCall; live: boolean; inspect?: string }
  | { kind: "fax-request" } | { kind: "fax"; id: string; inspect?: string }
  | { kind: "event"; id: string } | { kind: "idle"; last?: LiveCall };

export function App() {
  const { state, actions } = useEngine();
  const snap = state.snapshot;
  const [speedIdx, setSpeedIdx] = useState(1);
  const [muted, setMuted] = useState(false);
  const [selEv, setSelEv] = useState<string | null>(null);
  const [selCall, setSelCall] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [drawerSel, setDrawerSel] = useState<string | null>(null);
  const [machines, setMachines] = useState<{ open: boolean; focus: MachineName | null }>({ open: false, focus: null });

  const started = !!snap && (snap.events.length > 0 || snap.running);
  const calls = useMemo(() => Object.values(state.calls).sort((a, b) => a.seq - b.seq), [state.calls]);
  const humanCall = calls.find((c) => c.seat === "human" && c.status !== "ended" && c.status !== "dialing");
  const activeCalls = calls.filter((c) => c.status !== "ended");
  const getCall = useCallback((id: string): LiveCall | undefined => state.calls[id] ?? (snap?.calls[id] ? recToLive(snap.calls[id]) : undefined), [state.calls, snap]);

  // A ringing phone always wins over inspection.
  useEffect(() => { if (humanCall?.status === "ringing") { setSelEv(null); setSelCall(null); } }, [humanCall?.call_id, humanCall?.status]);
  useEffect(() => { if (humanCall?.status === "ringing" && !muted) startRing(); else stopRing(); return stopRing; }, [humanCall?.status, humanCall?.call_id, muted]);
  // Restart clears inspection.
  useEffect(() => { setSelEv(null); setSelCall(null); }, [snap?.case_id]);

  const selectedEvent = selEv ? snap?.events.find((e) => e.id === selEv) ?? null : null;

  const center: Center = useMemo(() => {
    if (!snap) return { kind: "loading" };
    if (!started) return { kind: "welcome" };
    if (humanCall) return humanCall.status === "ringing" ? { kind: "ringing", call: humanCall } : { kind: "call", call: humanCall, live: true };
    if (selCall) { const c = getCall(selCall); if (c) return { kind: "call", call: c, live: false, inspect: `Call with ${c.party_name}` }; }
    if (selectedEvent) {
      const label = `${fmtWhen(selectedEvent.at)} · ${selectedEvent.title}`;
      if (selectedEvent.call_id) { const c = getCall(selectedEvent.call_id); if (c) return { kind: "call", call: c, live: false, inspect: label }; }
      if (selectedEvent.fax_id && snap.faxes[selectedEvent.fax_id]) return { kind: "fax", id: selectedEvent.fax_id, inspect: label };
      return { kind: "event", id: selectedEvent.id };
    }
    if (state.faxRequest) return { kind: "fax-request" };
    if (activeCalls.length) return { kind: "call", call: activeCalls[activeCalls.length - 1], live: true };
    const lastLive = calls[calls.length - 1];
    const lastRecId = Object.keys(snap.calls).pop();
    return { kind: "idle", last: lastLive ?? (lastRecId ? recToLive(snap.calls[lastRecId]) : undefined) };
  }, [snap, started, humanCall, selCall, selectedEvent, state.faxRequest, activeCalls, calls, getCall]);

  const inspecting = !!(selEv || selCall) && center.kind !== "ringing" && !(center.kind === "call" && center.live);
  const views = useMemo(() => deriveMachines(snap, inspecting ? selEv : null), [snap, selEv, inspecting]);

  // What the right column shows mirrors the center.
  const shownCall = center.kind === "call" ? center.call : center.kind === "ringing" ? center.call : center.kind === "idle" ? center.last : undefined;
  const shownFax = center.kind === "fax" ? snap?.faxes[center.id] : undefined;
  const heard: HeardSource | null = shownCall
    ? { label: shownCall.party_name, facts: shownCall.facts, order: shownCall.factOrder, expected: PURPOSE_FACTS[shownCall.purpose] ?? [], live: shownCall.status !== "ended" && shownCall.status !== "ringing", kind: "call" }
    : shownFax && shownFax.direction === "inbound"
      ? { label: `signed order ${shownFax.id}`, facts: shownFax.facts, order: ORDER_FACTS.map(([k]) => k).filter((k) => shownFax.facts[k]), expected: ORDER_FACTS, live: false, kind: "fax" }
      : null;
  const ruleEvent = (() => {
    if (!snap) return null;
    if (selectedEvent && inspecting) return selectedEvent;
    if (shownCall) { const e = [...snap.events].reverse().find((x) => x.call_id === shownCall.call_id); if (e) return e; }
    if (shownFax) { const e = snap.events.find((x) => x.fax_id === shownFax.id); if (e) return e; }
    return snap.events[snap.events.length - 1] ?? null;
  })();
  const ruleWaiting = !!shownCall && shownCall.status !== "ended" && !(selectedEvent && inspecting);
  const ruleLabel = selectedEvent && inspecting ? "inspecting" : shownCall && ruleEvent?.call_id === shownCall.call_id ? "for this call" : "latest decision";

  const escalations = useMemo(() => Object.values(state.escalations), [state.escalations]);
  const pending = escalations.filter((e) => !e.decision).length;
  const seats = snap?.seats ?? {};
  const advocateSeat = seats.advocate ?? "human";
  const bellHot = pending > 0 && advocateSeat === "human";
  const supplierCalling = activeCalls.find((c) => c.party_kind === "supplier")?.party_id ?? null;
  const activeThread = shownCall && shownCall.status !== "ended" ? THREAD_OF[shownCall.party_kind] : null;

  const onStart = () => { unlockAudio(); actions.start(); actions.speed(SPEEDS[speedIdx].pace); setSelEv(null); setSelCall(null); };
  const onSpeed = (i: number) => { setSpeedIdx(i); actions.speed(SPEEDS[i].pace); };
  const onToastAction = (t: Toast) => {
    if (t.action?.kind === "escalation") { setDrawerSel(t.action.ref); setDrawer(true); }
    if (t.action?.kind === "fax") { setSelEv(null); setSelCall(null); }
  };
  const onSelectEvent = (id: string | null) => { setSelCall(null); setSelEv(id); };
  const openEsc = (id: string) => { setDrawerSel(id); setDrawer(true); };

  const right = (
    <>
      <ThesisStrip />
      <HeardPanel src={heard} />
      <RulesCard ev={ruleEvent} snap={snap} waiting={ruleWaiting} label={ruleLabel} />
      <HintsCard seats={seats} mock={state.status === "mock"} />
    </>
  );

  const centerBody = (() => {
    switch (center.kind) {
      case "loading": return <div className="card grid flex-1 place-items-center text-muted">Connecting to the engine…</div>;
      case "welcome": return <Welcome onStart={onStart} mock={state.status === "mock"} />;
      case "ringing": return <RingingCard call={center.call} onPickup={() => actions.pickup(center.call.call_id)} onLetRing={() => actions.letRing(center.call.call_id)} />;
      case "call": return (
        <>
          {center.inspect && <InspectBar label={center.inspect} onBack={() => { setSelEv(null); setSelCall(null); }} />}
          {center.live && activeCalls.length > 1 && (
            <div className="flex flex-wrap gap-1.5 text-[12px]">
              <span className="text-muted">On the line now:</span>
              {activeCalls.map((c) => <span key={c.call_id} className="chip" data-tone={c.call_id === center.call.call_id ? "live" : ""}>{c.party_name}</span>)}
            </div>
          )}
          <CallView key={center.call.call_id} call={center.call} live={center.live} onSay={(t) => actions.say(center.call.call_id, t)} onHangup={() => actions.hangup(center.call.call_id)} />
        </>
      );
      case "fax-request": return <FaxComposer key={state.faxRequest!.request_id} req={state.faxRequest!} onSend={(t) => actions.sendFax(state.faxRequest!.request_id, t)} />;
      case "fax": return (
        <>
          {center.inspect && <InspectBar label={center.inspect} onBack={() => setSelEv(null)} />}
          <FaxView fax={snap!.faxes[center.id]} />
        </>
      );
      case "event": {
        const ev = snap!.events.find((e) => e.id === center.id)!;
        return (
          <>
            <InspectBar label={`${fmtWhen(ev.at)} · ${ev.title}`} onBack={() => setSelEv(null)} />
            <EventView ev={ev} esc={ev.escalation_id ? state.escalations[ev.escalation_id] : undefined} onOpenEsc={openEsc} />
          </>
        );
      }
      case "idle": return (
        <IdlePanel snap={snap!}>
          {snap!.done && <DoneBanner snap={snap!} />}
          {state.faxRequest === null && pending > 0 && advocateSeat === "human" && (
            <button className="card flex items-center gap-2 border-human px-4 py-2.5 text-left text-[13.5px] text-human hover:bg-human-soft" onClick={() => setDrawer(true)}>
              <span className="live-dot h-2 w-2 rounded-full bg-human" /><b>{pending} escalation{pending > 1 ? "s" : ""} waiting for you</b><span className="text-muted">· open the advocate inbox</span>
            </button>
          )}
          {center.last && (
            <>
              <div className="eyebrow -mb-1.5">Last call</div>
              <CallView key={center.last.call_id} call={center.last} live={false} onSay={() => {}} onHangup={() => {}} />
            </>
          )}
        </IdlePanel>
      );
    }
  })();

  return (
    <div className="flex h-full min-w-[1000px] flex-col">
      <TopBar snap={snap} status={state.status} started={started} speedIdx={speedIdx} onSpeed={onSpeed}
        onStart={onStart} onPause={actions.pause} onResume={actions.resume} onStep={actions.step}
        muted={muted} onMute={() => { unlockAudio(); setMuted((m) => !m); }} pendingEsc={pending} bellHot={bellHot} onBell={() => setDrawer(true)}
        onMachines={() => setMachines({ open: true, focus: null })} />
      <SeatBar seats={seats} onSeat={(k, m) => { unlockAudio(); actions.setSeat(k, m); }} />

      <main className="grid min-h-0 flex-1 grid-cols-[292px_minmax(0,1fr)] gap-3 p-3 xl:grid-cols-[316px_minmax(0,1fr)_372px]">
        <aside className="scroll-thin min-h-0 space-y-3 overflow-y-auto pr-0.5" aria-label="Case and threads">
          {snap && (
            <>
              <CaseSummary snap={snap} views={views} onExpand={(m) => setMachines({ open: true, focus: m })} />
              <ThreadCards snap={snap} views={views} onExpand={(m) => setMachines({ open: true, focus: m })} activeThread={activeThread} />
              <SupplierBoard snap={snap} callingId={supplierCalling} />
            </>
          )}
        </aside>
        <section className="scroll-thin flex min-h-0 flex-col gap-3 overflow-y-auto xl:overflow-hidden" aria-label="Live call">
          <div className="flex min-h-[460px] flex-1 flex-col gap-3 xl:min-h-0">{centerBody}</div>
          <div className="grid gap-3 xl:hidden">{right}</div>
        </section>
        <aside className="scroll-thin hidden min-h-0 flex-col gap-3 overflow-y-auto xl:flex" aria-label="What the engine heard and decided">{right}</aside>
      </main>

      <Timeline events={snap?.events ?? []} selected={selEv} onSelect={onSelectEvent} />

      <EscalationDrawer open={drawer} onClose={() => setDrawer(false)} escalations={escalations} snap={snap} selectedId={drawerSel} onSelect={setDrawerSel}
        onDecide={(id, o, n) => actions.decide(id, o, n)} advocateSeat={advocateSeat}
        onInspectCall={(id) => { setDrawer(false); setSelEv(null); setSelCall(id); }} />
      <MachinesModal open={machines.open} focus={machines.focus} views={views} onClose={() => setMachines({ open: false, focus: null })}
        label={inspecting && selectedEvent ? `Showing the state as of ${fmtWhen(selectedEvent.at)}.` : ""} />
      <Toasts toasts={state.toasts} onDismiss={actions.dismissToast} onAction={onToastAction} />
    </div>
  );
}
