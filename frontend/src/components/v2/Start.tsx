import { useState } from "react";
import { Headphones, HeartHandshake, PlayCircle, Radio, Stethoscope, Truck, UserRound } from "lucide-react";
import type { SeatKey } from "../../types";

export type Plan = { source: "replay"; listen: boolean } | { source: "live"; play: SeatKey[]; listen: boolean };

const ROLES: { key: SeatKey; label: string; hint: string; Icon: typeof Truck }[] = [
  { key: "advocate", label: "Care advocate", hint: "Decide when the engine escalates", Icon: HeartHandshake },
  { key: "patient", label: "Eleanor", hint: "Answer her phone calls", Icon: UserRound },
  { key: "office", label: "Doctor's office", hint: "Send (or botch) the signed order", Icon: Stethoscope },
  { key: "supplier", label: "Suppliers", hint: "Pick up when a supplier is called", Icon: Truck },
];

export function StartScreen({ onGo, liveAvailable, onCancel, canListen }: { onGo: (p: Plan) => void; liveAvailable: boolean; onCancel?: () => void; canListen: boolean }) {
  const [play, setPlay] = useState<SeatKey[]>(["advocate"]);
  const [listen, setListen] = useState(canListen);
  const listenBox = canListen && (
    <label className="mt-4 flex cursor-pointer items-center gap-2 text-[13px]">
      <input type="checkbox" className="accent-[var(--accent)]" checked={listen} onChange={(e) => setListen(e.target.checked)} />
      <Headphones size={14} className="text-muted" />Read the calls aloud
    </label>
  );
  const toggle = (k: SeatKey) => setPlay((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-10">
      <div className="text-[12.5px] font-medium text-accent">Medicare equipment coordination</div>
      <h1 className="mt-1 text-[32px] font-semibold leading-tight tracking-tight">Get Eleanor her wheelchair, without anyone chasing faxes.</h1>
      <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-muted">
        Eleanor Martinez, 72, needs a standard wheelchair after a visit with Dr. Chen. The assistant calls suppliers, gets the signed order from the office, keeps Eleanor in the loop, and only brings in a care advocate when a person is genuinely needed.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="card flex flex-col p-5">
          <div className="flex items-center gap-2 text-[16px] font-semibold"><PlayCircle size={18} className="text-accent" />Watch a real run</div>
          <p className="mt-1.5 flex-1 text-[13.5px] text-muted">A recorded run with live model calls: 22 calls over two simulated weeks, one hand-off to a person, chair delivered. About three minutes to read, longer to listen. No setup.</p>
          {listenBox}
          <button className="btn btn-primary mt-3 self-start px-4 py-1.5 text-[14px]" onClick={() => onGo({ source: "replay", listen })}>Watch the replay</button>
        </div>
        <div className="card flex flex-col p-5">
          <div className="flex items-center gap-2 text-[16px] font-semibold"><Radio size={18} className="text-human" />Run it live and play a part</div>
          <p className="mt-1.5 text-[13.5px] text-muted">The assistant runs for real. Everyone you don't pick is played by a model.</p>
          <div className="mt-3 grid gap-1.5">
            {ROLES.map(({ key, label, hint, Icon }) => {
              const on = play.includes(key);
              return (
                <label key={key} className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-1.5 transition ${on ? "border-human/60 bg-human-soft" : "border-line hover:border-line-strong"}`}>
                  <input type="checkbox" className="accent-[var(--human)]" checked={on} onChange={() => toggle(key)} />
                  <Icon size={15} className={on ? "text-human" : "text-muted"} />
                  <span className="text-[13.5px] font-medium">{label}</span>
                  <span className="ml-auto text-[12px] text-muted">{hint}</span>
                </label>
              );
            })}
          </div>
          <button className="btn btn-human mt-4 self-start px-4 py-1.5 text-[14px]" disabled={!liveAvailable} onClick={() => onGo({ source: "live", play, listen })}>Start live run</button>
          {!liveAvailable && <p className="mt-2 text-[12px] text-muted">The engine server isn't running, so live runs are off. Start it with ./run.sh.</p>}
        </div>
      </div>
      {onCancel && <button className="mt-6 text-[13px] text-muted hover:text-ink" onClick={onCancel}>← Back to the current run</button>}
    </div>
  );
}
