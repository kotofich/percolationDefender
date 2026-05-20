from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .mtd_engine import MTDEngine

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def parse_node_urls(raw_urls: str) -> dict[str, str]:
    urls = [part.strip() for part in raw_urls.split(",") if part.strip()]
    parsed: dict[str, str] = {}
    for url in urls:
        host = urlparse(url).hostname
        if host is None:
            continue
        parsed[host] = url
    return parsed


class ConnectionManager:
    def __init__(self) -> None:
        self._active: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._active.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._active.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._active)

        to_remove: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                to_remove.append(ws)

        if to_remove:
            async with self._lock:
                for ws in to_remove:
                    self._active.discard(ws)


class AddUserRequest(BaseModel):
    user_id: str


class AppConfig(BaseModel):
    node_urls_raw: str
    rotation_interval_seconds: int = 60
    traffic_interval_seconds: int = 6
    healthcheck_interval_seconds: int = 5
    default_users_raw: str = "user-01,user-02,user-03,user-04"
    event_buffer_size: int = 300

    @property
    def node_urls(self) -> dict[str, str]:
        return parse_node_urls(self.node_urls_raw)

    @property
    def default_users(self) -> list[str]:
        return [item.strip() for item in self.default_users_raw.split(",") if item.strip()]


def load_config() -> AppConfig:
    node_urls_raw = os.getenv("NODE_URLS", "")
    if not node_urls_raw:
        raise RuntimeError("NODE_URLS is required")

    return AppConfig(
        node_urls_raw=node_urls_raw,
        rotation_interval_seconds=int(os.getenv("ROTATION_INTERVAL_SECONDS", "60")),
        traffic_interval_seconds=int(os.getenv("TRAFFIC_INTERVAL_SECONDS", "6")),
        healthcheck_interval_seconds=int(os.getenv("HEALTHCHECK_INTERVAL_SECONDS", "5")),
        default_users_raw=os.getenv("DEFAULT_USERS", "user-01,user-02,user-03,user-04"),
        event_buffer_size=int(os.getenv("EVENT_BUFFER_SIZE", "300")),
    )


config = load_config()
engine = MTDEngine(
    node_urls=config.node_urls,
    default_users=config.default_users,
    rotation_interval_seconds=config.rotation_interval_seconds,
    event_buffer_size=config.event_buffer_size,
)
manager = ConnectionManager()

app = FastAPI(title="Local MTD Demo Controller")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


async def publish_state(reason: str) -> None:
    snapshot = await engine.snapshot()
    await manager.broadcast({"type": "state", "reason": reason, "state": snapshot})


async def run_node_probe_once() -> bool:
    client: httpx.AsyncClient = app.state.http
    changed = False

    async def probe(node_id: str, url: str) -> bool:
        status = "unreachable"
        try:
            response = await client.get(f"{url}/health", timeout=2.0)
            response.raise_for_status()
            payload = response.json()
            candidate_status = payload.get("status", "healthy")
            if candidate_status in {"healthy", "compromised"}:
                status = candidate_status
        except Exception:
            status = "unreachable"
        return await engine.probe_node_status(node_id=node_id, status=status)

    results = await asyncio.gather(
        *[probe(node_id, url) for node_id, url in config.node_urls.items()],
        return_exceptions=True,
    )

    for result in results:
        if isinstance(result, bool) and result:
            changed = True
    return changed


async def rotation_loop() -> None:
    while True:
        await asyncio.sleep(1)
        if await engine.rotate_if_due():
            await publish_state("scheduled_rotation")


async def traffic_loop() -> None:
    while True:
        await asyncio.sleep(max(1, config.traffic_interval_seconds))
        if await engine.auto_connect_random_user():
            await publish_state("auto_traffic")


async def health_loop() -> None:
    while True:
        await asyncio.sleep(max(1, config.healthcheck_interval_seconds))
        if await run_node_probe_once():
            await publish_state("health_probe")


@app.on_event("startup")
async def startup_event() -> None:
    await engine.bootstrap()
    app.state.http = httpx.AsyncClient()
    app.state.tasks = [
        asyncio.create_task(rotation_loop()),
        asyncio.create_task(traffic_loop()),
        asyncio.create_task(health_loop()),
    ]
    await run_node_probe_once()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    tasks: list[asyncio.Task[Any]] = getattr(app.state, "tasks", [])
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    client: httpx.AsyncClient | None = getattr(app.state, "http", None)
    if client is not None:
        await client.aclose()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    return await engine.snapshot()


@app.post("/api/rotate")
async def rotate_now() -> dict[str, Any]:
    changed = await engine.rotate_entries(trigger="manual")
    if changed:
        await publish_state("manual_rotate")
    return {"ok": True, "changed": changed}


@app.post("/api/probe")
async def probe_now() -> dict[str, Any]:
    changed = await run_node_probe_once()
    await publish_state("manual_probe" if changed else "manual_probe_no_change")
    return {"ok": True, "changed": changed}


@app.post("/api/users")
async def add_user(payload: AddUserRequest) -> dict[str, Any]:
    user_id = payload.user_id.strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    created = await engine.add_user(user_id=user_id, trigger="manual")
    if not created:
        raise HTTPException(status_code=409, detail="user already exists")

    await publish_state("user_added")
    return {"ok": True, "user_id": user_id}


@app.post("/api/users/{user_id}/connect")
async def connect_user(user_id: str) -> dict[str, Any]:
    if not await engine.has_user(user_id):
        raise HTTPException(status_code=404, detail="user not found")

    changed = await engine.connect_user(user_id=user_id, trigger="manual")
    if not changed:
        raise HTTPException(status_code=409, detail="no relay available")

    await publish_state("manual_connect")
    return {"ok": True, "user_id": user_id}


async def call_node_action(node_id: str, action: str) -> bool:
    url = config.node_urls.get(node_id)
    if url is None:
        raise HTTPException(status_code=404, detail="node not found")

    client: httpx.AsyncClient = app.state.http
    try:
        response = await client.post(f"{url}/{action}", timeout=2.0)
        response.raise_for_status()
        return True
    except Exception:
        return False


@app.post("/api/nodes/{node_id}/compromise")
async def compromise_node(node_id: str) -> dict[str, Any]:
    remote_ok = await call_node_action(node_id=node_id, action="compromise")
    changed = await engine.set_node_status(
        node_id=node_id,
        status="compromised",
        trigger="manual_compromise" if remote_ok else "manual_compromise_local",
    )
    if changed:
        await publish_state("node_compromised")
    return {"ok": True, "node_id": node_id, "remote_ok": remote_ok, "changed": changed}


@app.post("/api/nodes/{node_id}/recover")
async def recover_node(node_id: str) -> dict[str, Any]:
    remote_ok = await call_node_action(node_id=node_id, action="recover")
    changed = await engine.set_node_status(
        node_id=node_id,
        status="healthy",
        trigger="manual_recover" if remote_ok else "manual_recover_local",
    )
    if changed:
        await publish_state("node_recovered")
    return {"ok": True, "node_id": node_id, "remote_ok": remote_ok, "changed": changed}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        await websocket.send_json(
            {"type": "state", "reason": "initial", "state": await engine.snapshot()}
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception:
        await manager.disconnect(websocket)
