"""FastAPI server: one demo session, broadcast over a WebSocket to every open tab.

    uv run uvicorn dme.server.app:app --port 8000

The browser speaks the protocol documented at the bottom of dme/contract.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from dme.server.session import Session

log = logging.getLogger("dme.server")
app = FastAPI(title="DME coordination engine")

FRONTEND_DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"


class Hub:
    """Fan-out of server messages to all connected browsers."""

    def __init__(self) -> None:
        self.sockets: set[WebSocket] = set()

    async def emit(self, msg: dict[str, Any]) -> None:
        data = json.dumps(msg, default=str)
        dead = []
        for ws in list(self.sockets):
            try:
                await ws.send_text(data)
            except Exception:  # noqa: BLE001 - a closed tab shouldn't stop the engine
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)


hub = Hub()
session = Session(emit=hub.emit)


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "running": session.running})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hub.sockets.add(ws)
    try:
        await ws.send_text(json.dumps(session.hello(), default=str))
        while True:
            msg = json.loads(await ws.receive_text())
            try:
                await session.handle(msg)
            except Exception as exc:  # noqa: BLE001 - report to the UI, keep the socket
                log.exception("bad message %s", msg)
                await ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
    except WebSocketDisconnect:
        pass
    finally:
        hub.sockets.discard(ws)


if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str) -> FileResponse:
        target = FRONTEND_DIST / path
        return FileResponse(target if target.is_file() else FRONTEND_DIST / "index.html")
