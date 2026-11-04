import { useMemo, useState } from "react";
import { Bug, ChevronDown, FileText, RotateCcw, Send } from "lucide-react";
import type { FaxRequest } from "../lib/useEngine";

// One-click mistakes. Each is detected on the current text, so the chips stay honest
// even after manual edits, and clicking a planted chip undoes it.
type Mistake = { id: string; label: string; hint: string; planted: (t: string) => boolean; plant: (t: string, base: string) => string; undo: (t: string, base: string) => string };

const splitNote = (t: string) => { const i = t.search(/\n\s*\n/); return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i)]; };
const THIN = /\b(walker|cane|doorways?|wide enough|elevator|accommodate|ramp)\b/i;

const MISTAKES: Mistake[] = [
  { id: "code", label: "Wrong code (K0003)", hint: "The EHR default: a lightweight chair with its own criteria",
    planted: (t) => /HCPCS:\s*K0003/.test(t),
    plant: (t) => t.replace(/HCPCS:\s*K\d{4}/, "HCPCS: K0003"),
    undo: (t) => t.replace(/HCPCS:\s*K0003/, "HCPCS: K0001") },
  { id: "sig", label: "Drop the signature", hint: "An unsigned order can't be relayed",
    planted: (t) => !/\/s\//.test(splitNote(t)[0]),
    plant: (t) => { const [o, n] = splitNote(t); return o.split("\n").filter((l) => !/\/s\/|^Signature:/i.test(l)).join("\n") + n; },
    undo: (t, base) => {
      const sig = base.split("\n").find((l) => /^Signature:/i.test(l)) ?? "Signature: /s/ Sarah Chen, MD (electronically signed)";
      const [o, n] = splitNote(t);
      const lines = o.split("\n");
      const at = lines.findIndex((l) => /^Date:/i.test(l));
      lines.splice(at >= 0 ? at + 1 : lines.length, 0, sig);
      return lines.join("\n") + n;
    } },
  { id: "thin", label: "Thin the note", hint: "Remove the walker and home-access sentences (criteria B, C)",
    planted: (t) => !THIN.test(splitNote(t)[1]),
    plant: (t) => { const [o, n] = splitNote(t); return o + n.split("\n").filter((l) => !THIN.test(l)).join("\n"); },
    undo: (t, base) => {
      const missing = splitNote(base)[1].split("\n").filter((l) => THIN.test(l));
      const [o, n] = splitNote(t);
      const lines = n.split("\n");
      const at = lines.findIndex((l) => /^Plan:/i.test(l));
      lines.splice(at >= 0 ? at : lines.length, 0, ...missing);
      return o + lines.join("\n");
    } },
  { id: "qty", label: "Wrong quantity", hint: "Qty 2 instead of 1",
    planted: (t) => /Qty:\s*(?!1\b)\d+/.test(t),
    plant: (t) => t.replace(/Qty:\s*\d+/, "Qty: 2"),
    undo: (t) => t.replace(/Qty:\s*\d+/, "Qty: 1") },
];

/** Drafts by request, so a call that rings mid-edit doesn't throw your edits away. */
const drafts = new Map<string, string>();

export function FaxComposer({ req, onSend }: { req: FaxRequest; onSend: (text: string) => void }) {
  const [text, setTextRaw] = useState(() => drafts.get(req.request_id) ?? req.prefill);
  const setText = (next: string | ((t: string) => string)) =>
    setTextRaw((t) => { const v = typeof next === "function" ? next(t) : next; drafts.set(req.request_id, v); return v; });
  const [showReq, setShowReq] = useState(false);
  const state = useMemo(() => MISTAKES.map((m) => ({ m, on: m.planted(text) && !m.planted(req.prefill) })), [text, req.prefill]);
  const planted = state.filter((s) => s.on).length;

  return (
    <div className="card anim-fade flex min-h-0 flex-1 flex-col border-human">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-human-soft text-human"><FileText size={17} /></span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="eyebrow !text-human">Your seat · doctor's office</div>
          <h2 className="text-[17px] font-semibold">Fax the signed order back to the engine</h2>
        </div>
        <span className="font-mono text-[10.5px] text-muted">{req.request_id}</span>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {req.request_text && (
          <div className="mb-3 rounded-md border border-line">
            <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]" onClick={() => setShowReq((v) => !v)} aria-expanded={showReq}>
              <ChevronDown size={14} className={`transition-transform ${showReq ? "" : "-rotate-90"}`} />
              <span className="font-medium">What the engine sent you</span>
              <span className="ml-auto text-muted">{req.request_text.split("\n")[0]}</span>
            </button>
            {showReq && <pre className="whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11.5px] text-muted">{req.request_text}</pre>}
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-[12.5px] font-medium"><Bug size={13} className="text-human" />Plant a mistake:</span>
          {state.map(({ m, on }) => (
            <button key={m.id} className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${on ? "border-human bg-human text-surface" : "border-human text-human hover:bg-human-soft"}`}
              aria-pressed={on} title={m.hint}
              onClick={() => setText((t) => (on ? m.undo(t, req.prefill) : m.plant(t, req.prefill)))}>
              {m.label}
            </button>
          ))}
          <button className="btn btn-ghost ml-auto !py-0.5 text-[12px]" onClick={() => setText(req.prefill)} disabled={text === req.prefill}><RotateCcw size={12} />Reset</button>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Order text"
          className="paper h-[300px] w-full resize-y rounded-md border border-dashed border-line-strong px-4 py-3 font-mono text-[12.5px] leading-6 outline-none focus:border-human" />
        <div className="mt-2 grid gap-1 text-[12px] text-muted md:grid-cols-2">
          <div><span className="tag rules mr-1.5">rules</span>6 order elements · HCPCS = K0001 · Qty 1 · dated on/after the visit</div>
          <div><span className="tag llm mr-1.5">llm</span>pre-screens the note for criteria A–G, each with a quote</div>
        </div>
      </div>
      <footer className="flex items-center gap-3 border-t border-line px-4 py-2.5">
        <span className="text-[12.5px] text-muted">{planted ? `${planted} mistake${planted > 1 ? "s" : ""} planted. Let's see if the validator catches ${planted > 1 ? "them" : "it"}.` : "A clean order. Edit freely before sending."}</span>
        <button className="btn btn-human ml-auto px-4" onClick={() => onSend(text)}><Send size={14} />Send fax</button>
      </footer>
    </div>
  );
}
