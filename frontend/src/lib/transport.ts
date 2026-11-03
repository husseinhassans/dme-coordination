import type { ClientMsg, ServerMsg } from "../types";

export interface Transport {
  send(m: ClientMsg): void;
  close(): void;
}

/** "connecting" / "open" / "closed" = live socket; "mock" = scripted MockEngine; "replay" = recorded run. */
export type ConnStatus = "connecting" | "open" | "closed" | "mock" | "replay";

export function wsUrl(): string {
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env;
  return "ws://localhost:8000/ws";
}

export function wantsMock(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

export function wantsReplay(): boolean {
  return new URLSearchParams(window.location.search).get("replay") === "1";
}

/**
 * Opens the socket. Calls onFail if it never reaches OPEN within `timeoutMs`
 * (the caller then falls back to the mock engine).
 */
export function openWs(
  url: string,
  onMessage: (m: ServerMsg) => void,
  onStatus: (s: ConnStatus) => void,
  onFail: () => void,
  timeoutMs = 1800,
): Transport {
  let ws: WebSocket | null = null;
  let opened = false;
  let dead = false;
  const queue: ClientMsg[] = [];
  const fail = () => { if (!opened && !dead) { dead = true; try { ws?.close(); } catch { /* ignore */ } onFail(); } };
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(fail, 0);
    return { send() {}, close() {} };
  }
  const timer = setTimeout(fail, timeoutMs);
  ws.onopen = () => {
    opened = true;
    clearTimeout(timer);
    onStatus("open");
    for (const m of queue.splice(0)) ws!.send(JSON.stringify(m));
  };
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data as string) as ServerMsg); } catch { /* ignore malformed */ }
  };
  ws.onerror = () => { if (!opened) fail(); };
  ws.onclose = () => { clearTimeout(timer); if (!opened) fail(); else if (!dead) onStatus("closed"); };
  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      else queue.push(m);
    },
    close() { dead = true; clearTimeout(timer); try { ws?.close(); } catch { /* ignore */ } },
  };
}
