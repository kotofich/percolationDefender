from __future__ import annotations

import os
from datetime import UTC, datetime
from threading import Lock

from fastapi import FastAPI
from pydantic import BaseModel


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class NodeState(BaseModel):
    node_id: str
    status: str
    updated_at: str


NODE_ID = os.getenv("NODE_ID", "node-unknown")

app = FastAPI(title=f"MTD Node Service {NODE_ID}")
_state_lock = Lock()
_state = NodeState(node_id=NODE_ID, status="healthy", updated_at=utc_now_iso())


def set_status(status: str) -> NodeState:
    global _state
    with _state_lock:
        _state = NodeState(node_id=NODE_ID, status=status, updated_at=utc_now_iso())
        return _state


@app.get("/health", response_model=NodeState)
def health() -> NodeState:
    with _state_lock:
        return _state


@app.get("/state", response_model=NodeState)
def state() -> NodeState:
    with _state_lock:
        return _state


@app.post("/compromise", response_model=NodeState)
def compromise() -> NodeState:
    return set_status("compromised")


@app.post("/recover", response_model=NodeState)
def recover() -> NodeState:
    return set_status("healthy")
