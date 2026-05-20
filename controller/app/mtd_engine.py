from __future__ import annotations

import asyncio
import random
from collections import deque
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any


def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_iso() -> str:
    return utc_now().isoformat()


@dataclass
class NodeRecord:
    node_id: str
    url: str
    status: str = "healthy"
    last_seen: str = ""
    last_change: str = ""


@dataclass
class UserRecord:
    user_id: str
    entry_node: str | None = None
    relay_node: str | None = None
    last_entry_rotation: str | None = None
    last_connection: str | None = None


class MTDEngine:
    def __init__(
        self,
        node_urls: dict[str, str],
        default_users: list[str],
        rotation_interval_seconds: int,
        event_buffer_size: int,
    ) -> None:
        now = utc_now_iso()
        self.nodes: dict[str, NodeRecord] = {
            node_id: NodeRecord(
                node_id=node_id,
                url=url,
                status="healthy",
                last_seen=now,
                last_change=now,
            )
            for node_id, url in sorted(node_urls.items())
        }
        self.users: dict[str, UserRecord] = {}

        self.default_users = [user.strip() for user in default_users if user.strip()]
        self.rotation_interval_seconds = rotation_interval_seconds

        self.events: deque[dict[str, Any]] = deque(maxlen=event_buffer_size)
        self.event_id = 0

        self.total_rotations = 0
        self.total_connections = 0
        self.total_reroutes = 0

        self.started_at = utc_now()
        self.last_rotation_at = utc_now()

        self._node_usage: dict[str, dict[str, int]] = {
            node_id: {"entry": 0, "relay": 0}
            for node_id in self.nodes
        }

        self._rng = random.Random()
        self._lock = asyncio.Lock()

    async def bootstrap(self) -> None:
        async with self._lock:
            for user_id in self.default_users:
                self._add_user_locked(user_id, trigger="bootstrap", silent=True)
            self._emit_event_locked(
                event_type="bootstrap_complete",
                message="MTD controller initialized",
                payload={
                    "node_count": len(self.nodes),
                    "user_count": len(self.users),
                    "rotation_interval_seconds": self.rotation_interval_seconds,
                },
            )

    def _emit_event_locked(
        self,
        event_type: str,
        message: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.event_id += 1
        self.events.append(
            {
                "id": self.event_id,
                "ts": utc_now_iso(),
                "type": event_type,
                "message": message,
                "payload": payload or {},
            }
        )

    def _healthy_node_ids_locked(self) -> list[str]:
        return [
            node_id
            for node_id, node in self.nodes.items()
            if node.status == "healthy"
        ]

    def _node_total_usage_locked(self, node_id: str) -> int:
        usage = self._node_usage.get(node_id, {"entry": 0, "relay": 0})
        return usage["entry"] + usage["relay"]

    def _mark_node_used_locked(self, node_id: str, usage_type: str) -> None:
        if node_id not in self._node_usage:
            self._node_usage[node_id] = {"entry": 0, "relay": 0}
        if usage_type not in {"entry", "relay"}:
            return
        self._node_usage[node_id][usage_type] += 1

    def _pick_node_locked(self, exclude: set[str] | None = None) -> str | None:
        exclude = exclude or set()
        candidates = [
            node_id for node_id in self._healthy_node_ids_locked() if node_id not in exclude
        ]
        if not candidates:
            return None

        min_usage = min(self._node_total_usage_locked(node_id) for node_id in candidates)
        least_used = [
            node_id
            for node_id in candidates
            if self._node_total_usage_locked(node_id) == min_usage
        ]
        return self._rng.choice(least_used)

    def _assign_entry_locked(self, user: UserRecord, trigger: str) -> bool:
        old_entry = user.entry_node
        exclude = {old_entry} if old_entry else set()
        candidate = self._pick_node_locked(exclude=exclude)

        if candidate is None and old_entry in self._healthy_node_ids_locked():
            candidate = old_entry

        if candidate == old_entry:
            return False

        user.entry_node = candidate
        self._mark_node_used_locked(candidate, usage_type="entry")
        user.last_entry_rotation = utc_now_iso()
        user.relay_node = None
        self.total_rotations += 1
        self._emit_event_locked(
            event_type="entry_rotated",
            message=f"Entry node rotated for {user.user_id}",
            payload={
                "user_id": user.user_id,
                "old_entry": old_entry,
                "new_entry": candidate,
                "trigger": trigger,
            },
        )
        return True

    def _assign_relay_locked(self, user: UserRecord, trigger: str) -> bool:
        if user.entry_node is None:
            return False

        relay = self._pick_node_locked(exclude={user.entry_node})
        if relay is None:
            return False

        user.relay_node = relay
        self._mark_node_used_locked(relay, usage_type="relay")
        user.last_connection = utc_now_iso()
        self.total_connections += 1
        self._emit_event_locked(
            event_type="user_connected",
            message=f"{user.user_id} route refreshed",
            payload={
                "user_id": user.user_id,
                "entry_node": user.entry_node,
                "relay_node": relay,
                "trigger": trigger,
            },
        )
        return True

    def _add_user_locked(self, user_id: str, trigger: str, silent: bool = False) -> UserRecord:
        if user_id in self.users:
            return self.users[user_id]

        user = UserRecord(user_id=user_id)
        self.users[user_id] = user

        self._assign_entry_locked(user, trigger=trigger)
        self._assign_relay_locked(user, trigger=trigger)

        if not silent:
            self._emit_event_locked(
                event_type="user_added",
                message=f"User {user_id} added",
                payload={"user_id": user_id, "trigger": trigger},
            )
        return user

    async def add_user(self, user_id: str, trigger: str = "manual") -> bool:
        async with self._lock:
            if user_id in self.users:
                return False
            self._add_user_locked(user_id, trigger=trigger)
            return True

    async def connect_user(self, user_id: str, trigger: str = "manual") -> bool:
        async with self._lock:
            user = self.users.get(user_id)
            if user is None:
                return False
            return self._assign_relay_locked(user, trigger=trigger)

    async def has_user(self, user_id: str) -> bool:
        async with self._lock:
            return user_id in self.users

    async def auto_connect_random_user(self) -> bool:
        async with self._lock:
            if not self.users:
                return False
            user = self._rng.choice(list(self.users.values()))
            return self._assign_relay_locked(user, trigger="auto_demo")

    async def rotate_entries(self, trigger: str = "manual") -> bool:
        changed = False
        async with self._lock:
            for user in self.users.values():
                changed = self._assign_entry_locked(user, trigger=trigger) or changed
                if user.entry_node:
                    changed = self._assign_relay_locked(user, trigger=trigger) or changed
            if changed:
                self.last_rotation_at = utc_now()
        return changed

    async def rotate_if_due(self) -> bool:
        async with self._lock:
            if utc_now() - self.last_rotation_at < timedelta(
                seconds=self.rotation_interval_seconds
            ):
                return False

        return await self.rotate_entries(trigger="scheduled")

    async def set_node_status(
        self,
        node_id: str,
        status: str,
        trigger: str,
    ) -> bool:
        changed = False
        async with self._lock:
            node = self.nodes.get(node_id)
            if node is None:
                return False

            if node.status != status:
                node.status = status
                node.last_change = utc_now_iso()
                changed = True
                self._emit_event_locked(
                    event_type="node_status_changed",
                    message=f"{node_id} marked as {status}",
                    payload={
                        "node_id": node_id,
                        "status": status,
                        "trigger": trigger,
                    },
                )

            node.last_seen = utc_now_iso()

            if status != "healthy":
                changed = self._reroute_affected_users_locked(node_id, trigger=trigger) or changed

        return changed

    async def probe_node_status(self, node_id: str, status: str) -> bool:
        return await self.set_node_status(node_id=node_id, status=status, trigger="health_probe")

    def _reroute_affected_users_locked(self, bad_node_id: str, trigger: str) -> bool:
        changed = False
        for user in self.users.values():
            affected = user.entry_node == bad_node_id or user.relay_node == bad_node_id
            if not affected:
                continue

            old_entry = user.entry_node
            old_relay = user.relay_node

            if user.entry_node == bad_node_id:
                self._assign_entry_locked(user, trigger=f"reroute:{trigger}")

            if user.entry_node:
                self._assign_relay_locked(user, trigger=f"reroute:{trigger}")
            else:
                user.relay_node = None

            self.total_reroutes += 1
            changed = True
            self._emit_event_locked(
                event_type="route_rerouted",
                message=f"{user.user_id} route rerouted after node issue",
                payload={
                    "user_id": user.user_id,
                    "bad_node": bad_node_id,
                    "old_entry": old_entry,
                    "old_relay": old_relay,
                    "new_entry": user.entry_node,
                    "new_relay": user.relay_node,
                    "trigger": trigger,
                },
            )
        return changed

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            nodes: list[dict[str, Any]] = []
            for node in self.nodes.values():
                row = asdict(node)
                usage = self._node_usage.get(node.node_id, {"entry": 0, "relay": 0})
                row["entry_assignments"] = usage["entry"]
                row["relay_assignments"] = usage["relay"]
                row["total_assignments"] = usage["entry"] + usage["relay"]
                nodes.append(row)
            users = [asdict(user) for user in self.users.values()]

            edges: list[dict[str, Any]] = []
            for user in self.users.values():
                if user.entry_node:
                    edges.append(
                        {
                            "source": user.user_id,
                            "target": user.entry_node,
                            "kind": "user_to_entry",
                            "user_id": user.user_id,
                        }
                    )
                if user.entry_node and user.relay_node:
                    edges.append(
                        {
                            "source": user.entry_node,
                            "target": user.relay_node,
                            "kind": "entry_to_relay",
                            "user_id": user.user_id,
                        }
                    )
                if user.relay_node:
                    edges.append(
                        {
                            "source": user.relay_node,
                            "target": "internet",
                            "kind": "relay_to_internet",
                            "user_id": user.user_id,
                        }
                    )

            healthy_nodes = sum(1 for node in self.nodes.values() if node.status == "healthy")
            compromised_nodes = sum(
                1 for node in self.nodes.values() if node.status == "compromised"
            )
            unreachable_nodes = sum(
                1 for node in self.nodes.values() if node.status == "unreachable"
            )

            metrics = {
                "total_nodes": len(self.nodes),
                "healthy_nodes": healthy_nodes,
                "compromised_nodes": compromised_nodes,
                "unreachable_nodes": unreachable_nodes,
                "total_users": len(self.users),
                "active_routes": sum(1 for user in self.users.values() if user.relay_node),
                "total_rotations": self.total_rotations,
                "total_connections": self.total_connections,
                "total_reroutes": self.total_reroutes,
                "uptime_seconds": int((utc_now() - self.started_at).total_seconds()),
            }

            return {
                "timestamp": utc_now_iso(),
                "rotation_interval_seconds": self.rotation_interval_seconds,
                "last_rotation_at": self.last_rotation_at.isoformat(),
                "nodes": nodes,
                "users": users,
                "edges": edges,
                "metrics": metrics,
                "events": list(self.events),
            }
