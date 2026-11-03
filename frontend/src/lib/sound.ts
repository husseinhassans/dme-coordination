// A soft two-tone phone ring made with WebAudio. No asset files.
let ctx: AudioContext | null = null;
let timer: number | null = null;

export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
  } catch { /* no audio */ }
}

function burst() {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.connect(ctx.destination);
  for (const f of [440, 480]) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    o.connect(gain);
    o.start(t0);
    o.stop(t0 + 1.6);
  }
  // two short rings, like a desk phone
  for (const [a, b] of [[0, 0.55], [0.8, 1.35]]) {
    gain.gain.setTargetAtTime(0.06, t0 + a, 0.02);
    gain.gain.setTargetAtTime(0, t0 + b, 0.04);
  }
}

export function startRing() {
  stopRing();
  if (!ctx) return;
  burst();
  timer = window.setInterval(burst, 3000);
}

export function stopRing() {
  if (timer !== null) { clearInterval(timer); timer = null; }
}
