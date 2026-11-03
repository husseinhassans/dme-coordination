import { useCallback, useEffect, useMemo, useState } from "react";
import type { CaseSnapshot, SeatKey } from "./types";
import { useEngine, type LiveCall } from "./lib/useEngine";
import { fmtDay } from "./lib/format";
import { startRing, stopRing, unlockAudio } from "./lib/sound";
import { CallView, FaxView } from "./components/CenterPane";
import { HeardPanel } from "./components/RightColumn";
import { Toasts } from "./components/Overlays";
import { Header, Queue, SPEEDS } from "./components/v2/Chrome";
import { StartScreen, type Plan } from "./components/v2/Start";
import { Activity, CaseHeader, CostCard, Details, NeedsYou, OnThePhone, Suppliers, Tracks } from "./components/v2/CasePage";
import { PhoneSheet } from "./components/v2/Phone";
import { HowDrawer } from "./components/v2/HowDrawer";
import { heardForCall, heardForFax, Modal, recToLive, Section } from "./components/v2/shared";

const THREAD_OF: Record<string, string> = { supplier: "supplier", office: "order", patient: "patient" };
const SEATS: SeatKey[] = ["supplier", "office", "patient", "advocate"];
type View = { kind: "call" | "fax"; id: string } | null;

export function App() {
  const { state, actions } = useEngine();
  const snap = state.snapshot;
  const [showStart, setShowStart] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [liveOk, setLiveOk] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [muted, setMuted] = useState(false);
  const [how, setHow] = useState(false);
  const [view, setView] = useState<View>(null);

  const source = state.status === "replay" ? "replay" : state.status === "mock" ? "mock" : "live";
  useEffect(() => { if (state.status === "open") setLiveOk(true); }, [state.status]);
  useEffect(() => { fetch("/api/health").then((r) => { if (r.ok) setLiveOk(true); }).catch(() => {}); }, []);

  // Start a run once the chosen source is connected and has sent its first snapshot.
  useEffect(() => {
    if (!plan || !snap) return;
    const ready = plan.source === "replay" ? state.status === "replay" : state.status === "open" || state.status === "mock";
    if (!ready) return;
    if (plan.source === "live") for (const k of SEATS) actions.setSeat(k, plan.play.includes(k) ? "human" : "auto");
    actions.start();
    actions.speed(SPEEDS[speedIdx].pace);
    setPlan(null);
  }, [plan, snap, state.status, actions, speedIdx]);

  const onGo = (p: Plan) => {
    unlockAudio();
    setShowStart(false);
    setView(null);
    if (p.source === "replay" && state.status !== "replay") actions.useSource("replay");
    if (p.source === "live" && (state.status === "replay" || state.status === "mock")) actions.useSource("live");
    setPlan(p);
  };

  const calls = useMemo(() => Object.values(state.calls).sort((a, b) => a.seq - b.seq), [state.calls]);
  const active = useMemo(() => calls.filter((c) => c.status !== "ended"), [calls]);
  const humanCall = active.find((c) => c.seat === "human" && c.status !== "dialing");
  const autoActive = active.filter((c) => c !== humanCall);
  const getCall = useCallback((id: string): LiveCall | undefined => state.calls[id] ?? (snap?.calls[id] ? recToLive(snap.calls[id]) : undefined), [state.calls, snap]);
  const escalations = state.escalations;
  const pending = useMemo(() => Object.values(escalations).filter((e) => !e.decision && e.code !== "SAFETY_CONCERN"), [escalations]);
  const advocateSeat = snap?.seats.advocate ?? "human";
  const started = !!snap && (snap.events.length > 0 || snap.running);
  const liveThreads = useMemo(() => new Set(active.map((c) => THREAD_OF[c.party_kind])), [active]);

  useEffect(() => {
    if (humanCall?.status === "ringing" && !muted) startRing(); else stopRing();
    return stopRing;
  }, [humanCall?.status, humanCall?.call_id, muted]);

  const lastCall = active[active.length - 1] ?? calls[calls.length - 1];
  const lastEvent = snap?.events[snap.events.length - 1] ?? null;
  const viewed = view?.kind === "call" ? getCall(view.id) : undefined;

  const sourceLabel = source === "replay" ? "Replay of a recorded run" : source === "mock" ? "Practice mode · scripted" : state.status === "open" ? "Live" : "Connecting…";
  const errors = state.toasts.filter((t) => t.tone === "bad");
  const onStartScreen = showStart || !snap || (!started && !plan);

  return (
    <div className="flex h-full min-w-[1080px] flex-col">
      <Header snap={snap} sourceLabel={sourceLabel} started={started && !onStartScreen} speedIdx={speedIdx}
        onSpeed={(i) => { setSpeedIdx(i); actions.speed(SPEEDS[i].pace); }} onPause={actions.pause} onResume={actions.resume}
        onNewRun={() => { actions.pause(); setShowStart(true); }} how={how} onHow={() => setHow((h) => !h)}
        muted={muted} onMute={() => { unlockAudio(); setMuted((m) => !m); }} showHow={!onStartScreen} />

      {onStartScreen ? (
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <StartScreen onGo={onGo} liveAvailable={liveOk} onCancel={started ? () => { setShowStart(false); actions.resume(); } : undefined} />
        </main>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[248px_minmax(0,1fr)]">
          <Queue snap={snap} pending={pending} />
          <main className="scroll-thin min-h-0 overflow-y-auto">
            <div className="mx-auto grid max-w-[1180px] grid-cols-[minmax(0,1fr)_300px] gap-8 px-8 py-7">
              <div className="min-w-0 space-y-5">
                <CaseHeader snap={snap} pending={pending} />
                {snap.done && <RunSummary snap={snap} spend={state.replayMeta?.api_spend_usd} />}
                {pending.map((e) => (
                  <NeedsYou key={e.id} esc={e} snap={snap} advocateSeat={advocateSeat}
                    onDecide={(id, o, n) => actions.decide(id, o, n)} onOpenCall={(id) => setView({ kind: "call", id })}
                    replay={source === "replay" ? { onContinue: actions.resume } : undefined} />
                ))}
                <OnThePhone calls={autoActive} onOpen={(id) => setView({ kind: "call", id })} />
                <Section title="Progress"><Tracks snap={snap} liveThreads={liveThreads} /></Section>
                <Activity snap={snap} escalations={escalations} onOpenCall={(id) => setView({ kind: "call", id })} onOpenFax={(id) => setView({ kind: "fax", id })} />
              </div>
              <aside className="space-y-5">
                <Suppliers snap={snap} />
                <CostCard snap={snap} />
                <Details snap={snap} />
              </aside>
            </div>
          </main>
        </div>
      )}

      <HowDrawer open={how} onClose={() => setHow(false)} snap={snap} ev={lastEvent}
        heard={lastCall ? heardForCall(lastCall) : null} waiting={active.length > 0} />

      <PhoneSheet call={humanCall} fax={state.faxRequest}
        onPickup={() => humanCall && actions.pickup(humanCall.call_id)} onLetRing={() => humanCall && actions.letRing(humanCall.call_id)}
        onSay={(t) => humanCall && actions.say(humanCall.call_id, t)} onHangup={() => humanCall && actions.hangup(humanCall.call_id)}
        onSendFax={(t) => state.faxRequest && actions.sendFax(state.faxRequest.request_id, t)} />

      <Modal open={!!view && (view.kind === "fax" ? !!snap?.faxes[view.id] : !!viewed)} onClose={() => setView(null)} wide
        title={view?.kind === "fax" ? (snap?.faxes[view.id]?.direction === "inbound" ? "Fax from Dr. Chen's office" : "Fax to Dr. Chen's office") : viewed ? `Call with ${viewed.party_name}` : ""}
        sub="Left: what was said. Right: the facts the model pulled out, each backed by the exact words. Rules decide from those facts only.">
        {view && snap && (
          <div className="grid h-[min(640px,70vh)] grid-cols-[minmax(0,1fr)_360px] gap-3">
            <div className="flex min-h-0 flex-col">
              {view.kind === "call" && viewed
                ? <CallView call={viewed} live={viewed.status !== "ended"} onSay={() => {}} onHangup={() => {}} />
                : snap.faxes[view.id] ? <FaxView fax={snap.faxes[view.id]} /> : null}
            </div>
            <div className="scroll-thin min-h-0 overflow-y-auto">
              <HeardPanel src={view.kind === "call" ? (viewed ? heardForCall(viewed) : null) : heardForFax(snap, view.id)} />
            </div>
          </div>
        )}
      </Modal>

      <Toasts toasts={errors} onDismiss={actions.dismissToast} onAction={() => {}} />
    </div>
  );
}

function RunSummary({ snap, spend }: { snap: CaseSnapshot; spend?: number | null }) {
  const calls = Object.keys(snap.calls).length || snap.events.filter((e) => e.kind === "call").length;
  const faxes = Object.keys(snap.faxes).length;
  const people = snap.escalations.filter((e) => e.code !== "SAFETY_CONCERN").length;
  const first = snap.events[0]?.at;
  const stats: [string, string][] = [
    ["Calls placed", String(calls)],
    ["Faxes", String(faxes)],
    ["Times a person was needed", String(people)],
    ["Simulated span", first ? `${fmtDay(first)} → ${fmtDay(snap.now)}` : "—"],
  ];
  if (spend != null) stats.push(["Model cost for the run", `$${spend.toFixed(2)}`]);
  return (
    <div className="card anim-fade grid grid-cols-5 gap-x-6 gap-y-2 px-5 py-4">
      {stats.map(([k, v]) => <div key={k}><div className="text-[18px] font-semibold tabular-nums">{v}</div><div className="text-[11.5px] text-muted">{k}</div></div>)}
    </div>
  );
}
