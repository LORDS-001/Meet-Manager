"""SQLite persistence layer.

Holds the OAuth token, cached events, user preferences and the reminder
notification queue.  A single connection guarded by a re-entrant lock is used
because the FastAPI worker threads and the APScheduler background thread both
touch the database.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .models import Event
from .tasks import Task

_SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    source      TEXT NOT NULL DEFAULT 'google',
    start_utc   TEXT NOT NULL,
    end_utc     TEXT NOT NULL,
    all_day     INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_utc);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);

CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL DEFAULT 'local',
    status      TEXT NOT NULL DEFAULT 'todo',
    due_utc     TEXT,
    updated_utc TEXT NOT NULL,
    data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_utc);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    payload     TEXT NOT NULL DEFAULT '{}',
    created_utc TEXT NOT NULL,
    seen        INTEGER NOT NULL DEFAULT 0,
    dismissed   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_unique ON notifications(event_id, kind);
CREATE INDEX IF NOT EXISTS idx_notif_seen ON notifications(seen);
"""


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass

    # --------------------------------------------------------------- key/val
    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            return default

    def set(self, key: str, value: Any) -> None:
        payload = json.dumps(value, default=str)
        with self._lock:
            self._conn.execute(
                "INSERT INTO kv(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, payload),
            )
            self._conn.commit()

    def delete(self, key: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM kv WHERE key = ?", (key,))
            self._conn.commit()

    # ---------------------------------------------------------------- events
    def replace_events(self, events: Iterable[Event], source: str) -> int:
        """Atomically swap out every event belonging to `source`."""
        rows = [
            (
                event.id,
                event.calendar_id,
                source,
                event.start.astimezone(timezone.utc).isoformat(),
                event.end.astimezone(timezone.utc).isoformat(),
                1 if event.all_day else 0,
                json.dumps(event.to_dict()),
            )
            for event in events
        ]
        with self._lock:
            self._conn.execute("DELETE FROM events WHERE source = ?", (source,))
            if rows:
                self._conn.executemany(
                    "INSERT OR REPLACE INTO events"
                    "(id, calendar_id, source, start_utc, end_utc, all_day, data)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
            self._conn.commit()
        return len(rows)

    def clear_events(self, source: str | None = None) -> None:
        with self._lock:
            if source is None:
                self._conn.execute("DELETE FROM events")
            else:
                self._conn.execute("DELETE FROM events WHERE source = ?", (source,))
            self._conn.commit()

    def all_events(self) -> list[Event]:
        with self._lock:
            rows = self._conn.execute("SELECT data FROM events ORDER BY start_utc ASC").fetchall()
        events: list[Event] = []
        for row in rows:
            try:
                events.append(Event.from_dict(json.loads(row["data"])))
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        events.sort(key=lambda e: (e.start, e.end))
        return events

    def event_sources(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute("SELECT DISTINCT source FROM events").fetchall()
        return [row["source"] for row in rows]

    def event_count(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()
        return int(row["n"]) if row else 0

    # ----------------------------------------------------------------- tasks
    def upsert_task(self, task: Task) -> None:
        """Insert or replace a single task, keyed on its id."""
        row = (
            task.id,
            task.source,
            task.status,
            task.due.astimezone(timezone.utc).isoformat() if task.due else None,
            task.updated_utc.astimezone(timezone.utc).isoformat(),
            json.dumps(task.to_dict()),
        )
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO tasks"
                "(id, source, status, due_utc, updated_utc, data) VALUES (?, ?, ?, ?, ?, ?)",
                row,
            )
            self._conn.commit()

    def replace_tasks(self, tasks: Iterable[Task], source: str) -> int:
        """Atomically swap out every task belonging to `source`.

        Used by provider syncs: the remote list is the truth, so anything we
        hold for that source and no longer see upstream is dropped.
        """
        rows = [
            (
                task.id,
                source,
                task.status,
                task.due.astimezone(timezone.utc).isoformat() if task.due else None,
                task.updated_utc.astimezone(timezone.utc).isoformat(),
                json.dumps(task.to_dict()),
            )
            for task in tasks
        ]
        with self._lock:
            self._conn.execute("DELETE FROM tasks WHERE source = ?", (source,))
            if rows:
                self._conn.executemany(
                    "INSERT OR REPLACE INTO tasks"
                    "(id, source, status, due_utc, updated_utc, data) VALUES (?, ?, ?, ?, ?, ?)",
                    rows,
                )
            self._conn.commit()
        return len(rows)

    def get_task(self, task_id: str) -> Task | None:
        with self._lock:
            row = self._conn.execute("SELECT data FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            return None
        try:
            return Task.from_dict(json.loads(row["data"]))
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def all_tasks(self) -> list[Task]:
        with self._lock:
            rows = self._conn.execute("SELECT data FROM tasks").fetchall()
        tasks: list[Task] = []
        for row in rows:
            try:
                tasks.append(Task.from_dict(json.loads(row["data"])))
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        return tasks

    def delete_task(self, task_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            self._conn.commit()
            return cursor.rowcount > 0

    def clear_tasks(self, source: str | None = None) -> None:
        with self._lock:
            if source is None:
                self._conn.execute("DELETE FROM tasks")
            else:
                self._conn.execute("DELETE FROM tasks WHERE source = ?", (source,))
            self._conn.commit()

    def task_sources(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute("SELECT DISTINCT source FROM tasks").fetchall()
        return [row["source"] for row in rows]

    def task_count(self, *, open_only: bool = False) -> int:
        sql = "SELECT COUNT(*) AS n FROM tasks"
        if open_only:
            sql += " WHERE status != 'done'"
        with self._lock:
            row = self._conn.execute(sql).fetchone()
        return int(row["n"]) if row else 0

    # --------------------------------------------------------- notifications
    def add_notification(
        self,
        *,
        event_id: str,
        kind: str,
        title: str,
        body: str = "",
        payload: dict[str, Any] | None = None,
    ) -> bool:
        """Insert a notification.  Returns False when one already existed."""
        with self._lock:
            cursor = self._conn.execute(
                "INSERT OR IGNORE INTO notifications"
                "(event_id, kind, title, body, payload, created_utc)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (event_id, kind, title, body, json.dumps(payload or {}), _utcnow_iso()),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def notifications(self, *, include_dismissed: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM notifications"
        if not include_dismissed:
            sql += " WHERE dismissed = 0"
        sql += " ORDER BY created_utc DESC, id DESC LIMIT ?"
        with self._lock:
            rows = self._conn.execute(sql, (limit,)).fetchall()
        results = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except (json.JSONDecodeError, TypeError):
                payload = {}
            results.append(
                {
                    "id": row["id"],
                    "event_id": row["event_id"],
                    "kind": row["kind"],
                    "title": row["title"],
                    "body": row["body"],
                    "payload": payload,
                    "created_utc": row["created_utc"],
                    "seen": bool(row["seen"]),
                    "dismissed": bool(row["dismissed"]),
                }
            )
        return results

    def mark_seen(self, notification_ids: Iterable[int]) -> None:
        ids = [int(i) for i in notification_ids]
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        with self._lock:
            self._conn.execute(
                f"UPDATE notifications SET seen = 1 WHERE id IN ({placeholders})", ids
            )
            self._conn.commit()

    def dismiss_notification(self, notification_id: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE notifications SET dismissed = 1, seen = 1 WHERE id = ?",
                (int(notification_id),),
            )
            self._conn.commit()

    def dismiss_all(self) -> None:
        with self._lock:
            self._conn.execute("UPDATE notifications SET dismissed = 1, seen = 1")
            self._conn.commit()

    def delete_notifications_for(self, event_id: str) -> int:
        """Drop every notification tied to one event or task.

        Used when a deadline moves or a task is completed: the reminder that
        was already raised for the old state must not survive, and the unique
        (event_id, kind) index would otherwise block a fresh one.
        """
        with self._lock:
            cursor = self._conn.execute("DELETE FROM notifications WHERE event_id = ?", (str(event_id),))
            self._conn.commit()
            return cursor.rowcount

    def clear_notifications(self) -> None:
        """Delete every notification row.

        Different from `dismiss_all`: dismissed rows still block a reminder
        from ever being raised again for that event, which is what we want
        during normal operation but not when the calendar is reloaded.
        """
        with self._lock:
            self._conn.execute("DELETE FROM notifications")
            self._conn.commit()

    def prune_notifications(self, valid_event_ids: set[str]) -> None:
        """Drop reminders whose event no longer exists (deleted / moved)."""
        with self._lock:
            rows = self._conn.execute("SELECT id, event_id FROM notifications").fetchall()
            stale = [row["id"] for row in rows if row["event_id"] not in valid_event_ids]
            if stale:
                placeholders = ",".join("?" for _ in stale)
                self._conn.execute(
                    f"DELETE FROM notifications WHERE id IN ({placeholders})", stale
                )
                self._conn.commit()
