// Simulated time arrives as naive ISO strings ("2026-11-10T17:10:00"). Read the wall
// clock straight from the string so the browser's time zone never shifts it.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface Wall { y: number; mo: number; d: number; h: number; mi: number }
export function wall(iso: string | null | undefined): Wall | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0) };
}
export const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
export const msWall = (ms: number): Wall => { const d = new Date(ms); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDayW = (w: Wall) => `${DOW[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]} ${MON[w.mo - 1]} ${w.d}`;
export const fmtTimeW = (w: Wall) => `${pad(w.h)}:${pad(w.mi)}`;
export const fmtDay = (iso?: string | null) => { const w = wall(iso); return w ? fmtDayW(w) : "—"; };
export const fmtTime = (iso?: string | null) => { const w = wall(iso); return w ? fmtTimeW(w) : "—"; };
export const fmtWhen = (iso?: string | null) => { const w = wall(iso); return w ? `${fmtDayW(w)} · ${fmtTimeW(w)}` : "—"; };
export const fmtDate = (iso?: string | null) => { const w = wall(iso); return w ? `${fmtDayW(w)}, ${w.y}` : "—"; };

export function fmtGap(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  return `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
}

export type Tone = "ok" | "warn" | "bad" | "human" | "live" | "";
export function tone(st?: string | null): Tone {
  if (!st) return "";
  if (/^ESC|BLOCKED/.test(st)) return "human";
  if (/DISQUALIFIED|UNREACHABLE|GHOSTED|ABANDONED/.test(st)) return "bad";
  if (/NO_ANSWER|NUDGE|CORRECTION|PAUSED/.test(st)) return "warn";
  if (/QUALIFIED|COMMITTED|CONFIRMED|VALIDATED|DOCS_OK|DELIVERED|VERIFIED|CLOSED/.test(st)) return "ok";
  return "live";
}

export const PURPOSE_LABEL: Record<string, string> = {
  supplier_screen: "Supplier screen",
  supplier_reconfirm: "Re-check backup",
  supplier_confirm: "Supplier confirmation",
  supplier_delivery_check: "Delivery check",
  office_followup: "Office follow-up",
  office_correction: "Order correction",
  patient_intro: "Intro call",
  patient_consent: "Consent + window",
  patient_delivery_check: "Post-delivery check",
};
export const purposeLabel = (p: string) => PURPOSE_LABEL[p] ?? p.replace(/_/g, " ");

export const SEAT_LABEL: Record<string, string> = { supplier: "Suppliers", office: "Doctor's office", patient: "Eleanor", advocate: "Care advocate" };

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "unknown";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
