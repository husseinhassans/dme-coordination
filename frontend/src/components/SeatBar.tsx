import { Bot, HeartHandshake, Stethoscope, Truck, UserRound, type LucideIcon } from "lucide-react";
import type { SeatKey, SeatMode } from "../types";

const SEATS: { key: SeatKey; label: string; sub: string; icon: LucideIcon }[] = [
  { key: "supplier", label: "Suppliers", sub: "12 enrolled DMEs", icon: Truck },
  { key: "office", label: "Doctor's office", sub: "Sunrise Family Medicine", icon: Stethoscope },
  { key: "patient", label: "Eleanor", sub: "the patient, 72", icon: UserRound },
  { key: "advocate", label: "Care advocate", sub: "escalation inbox", icon: HeartHandshake },
];

export function SeatBar({ seats, onSeat }: { seats: Partial<Record<SeatKey, SeatMode>>; onSeat: (k: SeatKey, m: SeatMode) => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-[var(--surface-2)] px-4 py-1.5">
      <div className="hidden shrink-0 leading-tight 2xl:block">
        <div className="eyebrow">Seats</div>
        <div className="text-[11.5px] text-muted">who plays each party</div>
      </div>
      <div className="grid flex-1 grid-cols-4 gap-2">
        {SEATS.map(({ key, label, sub, icon: Icon }) => {
          const mode = seats[key] ?? (key === "advocate" ? "human" : "auto");
          const you = mode === "human";
          return (
            <div key={key} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 transition-colors ${you ? "border-human bg-human-soft" : "border-line bg-surface"}`}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${you ? "bg-human text-surface" : "bg-[var(--bg)] text-muted"}`}><Icon size={15} /></span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13px] font-semibold">{label}</div>
                <div className="truncate text-[11px] text-muted">{you ? "you take the calls" : sub}</div>
              </div>
              <div className="seg shrink-0" role="group" aria-label={`${label} seat`}>
                <button aria-pressed={!you} onClick={() => onSeat(key, "auto")} title="An LLM plays this party">
                  <Bot size={12} className="mr-0.5 inline" />Auto
                </button>
                <button aria-pressed={you} onClick={() => onSeat(key, "human")} title="You play this party in the browser" className={you ? "!bg-human" : ""}>
                  You
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
