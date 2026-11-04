import { useEffect, useRef } from "react";
import { Phone as PhoneIcon, PhoneIncoming, PhoneOff, Stethoscope, Truck, UserRound } from "lucide-react";
import type { LiveCall, FaxRequest } from "../../lib/useEngine";
import { purposeLabel } from "../../lib/format";
import { CallView } from "../CenterPane";
import { FaxComposer } from "../FaxComposer";

const ICON = { supplier: Truck, office: Stethoscope, patient: UserRound };
const ROLE: Record<string, (n: string) => string> = {
  patient: () => "You're Eleanor, 72. Knee surgery in March, uses a walker, fixed income. Answer however she might.",
  supplier: (n) => `You answer the phone at ${n}. The assistant only knows your name and number; everything else comes from you.`,
  office: () => "You're the front desk at Sunrise Family Medicine, Dr. Chen's practice.",
};

/** A softphone that slides up when a call or fax reaches a seat you're playing. */
export function PhoneSheet({ call, fax, onPickup, onLetRing, onSay, onHangup, onSendFax }: {
  call?: LiveCall; fax: FaxRequest | null; onPickup: () => void; onLetRing: () => void; onSay: (t: string) => void; onHangup: () => void; onSendFax: (t: string) => void;
}) {
  const pickRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (call?.status === "ringing") pickRef.current?.focus(); }, [call?.call_id, call?.status]);
  if (!call && !fax) return null;
  // The threads run in parallel, so a call can ring while you owe the office's fax. The
  // fax never times out and a ring does (90s), so the ring shows beside the fax instead of
  // over it. If you answer, the call takes the sheet and the fax comes back afterwards
  // exactly as you left it (FaxComposer keeps the draft).
  const ringing = call?.status === "ringing" ? call : undefined;
  const onCall = call && !ringing ? call : undefined;
  const sheet = onCall || fax;

  let ringCard = null;
  if (ringing) {
    const Icon = ICON[ringing.party_kind];
    ringCard = (
      <div className="fixed bottom-5 z-50 w-[380px] anim-slide rounded-2xl border border-human/50 bg-surface p-4 shadow-2xl"
        style={{ right: sheet ? "calc(min(520px, 92vw) + 36px)" : 20 }} role="alertdialog" aria-label={`Incoming call for ${ringing.party_name}`}>
        <div className="flex items-center gap-3">
          <span className="ring-pulse grid h-11 w-11 shrink-0 place-items-center rounded-full bg-human text-surface"><PhoneIncoming size={20} className="ring-shake" /></span>
          <div className="min-w-0">
            <div className="text-[12px] text-human">Incoming call · you're playing</div>
            <div className="flex items-center gap-1.5 text-[16px] font-semibold"><Icon size={15} className="text-muted" />{ringing.party_name}</div>
          </div>
        </div>
        <p className="mt-2.5 text-[13px] text-muted">{ROLE[ringing.party_kind]?.(ringing.party_name)}{ringing.purpose && <> The assistant is calling for a <b className="text-ink">{purposeLabel(ringing.purpose).toLowerCase()}</b>.</>}</p>
        {fax && <p className="mt-2 rounded-lg bg-human/10 px-2.5 py-1.5 text-[12px] text-human">Your fax stays open. Answer and it'll be waiting, as you left it, when the call ends.</p>}
        <div className="mt-3 flex gap-2">
          <button ref={pickRef} className="btn btn-human flex-1 py-1.5 text-[14px]" onClick={onPickup}><PhoneIcon size={15} />Answer</button>
          <button className="btn flex-1 py-1.5 text-[14px]" onClick={onLetRing}><PhoneOff size={15} />Let it ring</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {sheet && (
        <div className="fixed bottom-5 right-5 z-40 flex h-[min(640px,82vh)] w-[min(520px,92vw)] anim-slide flex-col rounded-2xl border border-human/50 bg-[var(--bg)] shadow-2xl">
          <div className="flex items-center gap-2 rounded-t-2xl border-b border-line bg-surface px-4 py-2 text-[12.5px] text-human">
            <span className="live-dot h-2 w-2 rounded-full bg-human" />{onCall ? <>On a call · you're playing <b>{onCall.party_name}</b></> : <>The assistant is waiting for your fax · you're playing <b>Dr. Chen's office</b></>}
            {onCall && fax && <span className="ml-auto rounded-full bg-human/10 px-2 py-0.5 text-[11.5px]">Fax saved · back after this call</span>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {onCall ? <CallView key={onCall.call_id} call={onCall} live onSay={onSay} onHangup={onHangup} /> : fax && <div className="scroll-thin min-h-0 flex-1 overflow-y-auto"><FaxComposer key={fax.request_id} req={fax} onSend={onSendFax} /></div>}
          </div>
        </div>
      )}
      {ringCard}
    </>
  );
}
