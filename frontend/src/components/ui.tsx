import type { ReactNode } from "react";
import { tone } from "../lib/format";

export function Chip({ state, label, className = "" }: { state?: string | null; label?: ReactNode; className?: string }) {
  return (
    <span key={state ?? "none"} className={`chip changed ${className}`} data-tone={tone(state)}>
      {label ?? state ?? "—"}
    </span>
  );
}

export function Tag({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`tag ${kind}`}>{children ?? kind}</span>;
}

export function Card({ title, right, children, className = "", bodyClass = "px-3.5 pb-3" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="card-h">
          <h3 className="text-[14px] font-semibold leading-tight">{title}</h3>
          {right}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Typing({ className = "" }: { className?: string }) {
  return <span className={`typing inline-flex items-center ${className}`} aria-label="typing"><span /><span /><span /></span>;
}
