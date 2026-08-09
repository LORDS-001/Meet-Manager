"""SQLite persistence layer.

Holds users, their OAuth tokens, cached events, tasks, preferences and the
reminder notification queue.  A single connection guarded by a re-entrant lock
is used because the FastAPI worker threads and the APScheduler background
thread both touch the database.

MULTI-TENANCY
-------------
Every data row carries an `owner_id`.  Rather than threading that through
every call site, a Store instance is *bound* to one owner: `store.for_owner(id)`
returns a cheap view sharing the same connection whose queries are all scoped
to that owner.  The unbound store (owner_id "") holds system-wide rows such as
the pending OAuth state and the session secret.

That means isolation is enforced in one place - the SQL in this module - and a
caller cannot accidentally read another user's data by forgetting a filter.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .models import Event
from .tasks import Task

SYSTEM_OWNER = ""

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    picture       TEXT NOT NULL DEFAULT '',
    created_utc   TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
    owner_id TEXT NOT NULL DEFAULT '',
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS events (
    id          TEXT NOT NULL,
    owner_id    TEXT NOT NULL DEFAULT '',
    calendar_id TEXT NOT NULL DEFAULT 'primary',
    source      TEXT NOT NULL DEFAULT 'google',
    start_utc   TEXT NOT NULL,
    end_utc     TEXT NOT NULL,
    all_day     INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(owner_id, start_utc);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(owner_id, source);

CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT NOT NULL,
    owner_id    TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'local',
    status      TEXT NOT NULL DEFAULT 'todo',
    due_utc     TEXT,
    updated_utc TEXT NOT NULL,
    data        TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(owner_id, due_utc);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(owner_id, source);

CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    TEXT NOT NULL DEFAULT '',
    event_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    payload     TEXT NOT NULL DEFAULT '{}',
    created_utc TEXT NOT NULL,
    seen        INTEGER NOT NULL DEFAULT 0,
    dismissed   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_unique ON notifications(owner_id, event_id, kind);
CREATE INDEX IF NOT EXISTS idx_notif_seen ON notifications(owner_id, seen);
"""


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_user_id() -> str:
    return uuid.uuid4().hex


class Store:
    def __init__(self, path: Path, *, owner_id: str = SYSTEM_OWNER, _shared: "Store | None" = None) -> None:
        self.owner_id = owner_id
        if _shared is not None:
            # A scoped view: same connection and lock, different owner.
            self.path = _shared.path
            self._lock = _shared._lock
            self._conn = _shared._conn
            self._root = _shared
            return

        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._root = self
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
            self._migrate()

    # ------------------------------------------------------------- migration
    def _migrate(self) -> None:
        """Bring a pre-multi-user database up to the current schema.

        Older databases have no owner_id anywhere and a kv table keyed on
        `key` alone.  Their rows are adopted by the account matching the
        Google profile already stored, so an existing install keeps its data
        instead of silently losing it.
        """
        conn = self._conn

        def columns(table: str) -> set[str]:
            return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}

        for table in ("events", "tasks", "notifications"):
            if "owner_id" not in columns(table):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")

        # kv needs a composite primary key, which ALTER TABLE cannot add.
        if "owner_id" not in columns("kv"):
            conn.executescript(
                """
                ALTER TABLE kv RENAME TO kv_legacy;
                CREATE TABLE kv (
                    owner_id TEXT NOT NULL DEFAULT '',
                    key      TEXT NOT NULL,
                    value    TEXT NOT NULL,
                    PRIMARY KEY (owner_id, key)
                );
                INSERT INTO kv(owner_id, key, value) SELECT '', key, value FROM kv_legacy;
                DROP TABLE kv_legacy;
                """
            )
        conn.commit()

        # Adopt any orphaned rows into a real account.
        orphans = conn.execute(
            "SELECT (SELECT COUNT(*) FROM events WHERE owner_id = '')"
            " + (SELECT COUNT(*) FROM tasks WHERE owner_id = '') AS n"
        ).fetchone()["n"]
        legacy_token = conn.execute(
            "SELECT value FROM kv WHERE owner_id = '' AND key = 'google_token'"
        ).fetchone()
        if not orphans and not legacy_token:
            return

        email = ""
        profile_row = conn.execute(
            "SELECT value FROM kv WHERE owner_id = '' AND key = 'google_profile'"
        ).fetchone()
        if profile_row:
            try:
                email = (json.loads(profile_row["value"]) or {}).get("email", "")
            except (json.JSONDecodeError, TypeError):
                email = ""
        if not email:
            email = "legacy@meetmanager.local"

        user = self.get_user_by_email(email) or self.create_user(email=email, name=email.split("@")[0])
        owner = user["id"]
        with self._lock:
            for table in ("events", "tasks", "notifications"):
                conn.execute(f"UPDATE {table} SET owner_id = ? WHERE owner_id = ''", (owner,))
            # Per-user kv rows move across; system rows stay put.
            for key in ("google_token", "google_profile", "preferences", "sync_state", "task_sync_state"):
                conn.execute(
                    "UPDATE OR REPLACE kv SET owner_id = ? WHERE owner_id = '' AND key = ?",
                    (owner, key),
                )
            conn.commit()

    # ---------------------------------------------------------------- scoping
    def for_owner(self, owner_id: str) -> "Store":
        """A view of this store bound to one user. Shares the connection."""
        return Store(self.path, owner_id=str(owner_id or SYSTEM_OWNER), _shared=self._root)

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass

    # ------------------------------------------------------------------ users
    def create_user(self, *, email: str, name: str = "", picture: str = "") -> dict[str, Any]:
        now = _utcnow_iso()
        user_id = new_user_id()
        with self._lock:
            self._conn.execute(
                "INSERT INTO users(id, email, name, picture, created_utc, last_seen_utc)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, email.lower().strip(), name, picture, now, now),
            )
            self._conn.commit()
        return {"id": user_id, "email": email.lower().strip(), "name": name,
                "picture": picture, "created_utc": now, "last_seen_utc": now}

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM users WHERE id = ?", (str(user_id),)).fetchone()
        return dict(row) if row else None

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM users WHERE email = ?", (email.lower().strip(),)
            ).fetchone()
        return dict(row) if row else None

    def upsert_user(self, *, email: str, name: str = "", picture: str = "") -> dict[str, Any]:
        existing = self.get_user_by_email(email)
        if existing is None:
            return self.create_user(email=email, name=name, picture=picture)
        with self._lock:
            self._conn.execute(
                "UPDATE users SET name = COALESCE(NULLIF(?, ''), name),"
                " picture = COALESCE(NULLIF(?, ''), picture), last_seen_utc = ? WHERE id = ?",
                (name, picture, _utcnow_iso(), existing["id"]),
            )
            self._conn.commit()
        return self.get_user(existing["id"]) or existing

    def touch_user(self, user_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET last_seen_utc = ? WHERE id = ?", (_utcnow_iso(), str(user_id))
            )
            self._conn.commit()

    def all_users(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM users ORDER BY created_utc").fetchall()
        return [dict(r) for r in rows]

    def delete_user(self, user_id: str) -> None:
        """Remove an account and everything it owns."""
        uid = str(user_id)
        with self._lock:
            for table in ("events", "tasks", "notifications", "kv"):
                self._conn.execute(f"DELETE FROM {table} WHERE owner_id = ?", (uid,))
            self._conn.execute("DELETE FROM users WHERE id = ?", (uid,))
            self._conn.commit()

    # --------------------------------------------------------------- key/val
    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM kv WHERE owner_id = ? AND key = ?", (self.owner_id, key)
            ).fetchone()
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
                "INSERT INTO kv(owner_id, key, value) VALUES(?, ?, ?) "
                "ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
                (self.owner_id, key, payload),
            )
            self._conn.commit()

    def delete(self, key: str) -> None:
        with self._lock:
            self._conn.execute(
                "DELETE FROM kv WHERE owner_id = ? AND key = ?", (self.owner_id, key)
            )
            self._conn.commit()

    # ---------------------------------------------------------------- events
    def replace_events(self, events: Iterable[Event], source: str) -> int:
        """Atomically swap out every event belonging to `source`."""
        rows = [
            (
                event.id,
                self.owner_id,
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
            self._conn.execute(
                "DELETE FROM events WHERE owner_id = ? AND source = ?", (self.owner_id, source)
            )
            if rows:
                self._conn.executemany(
                    "INSERT OR REPLACE INTO events"
                    "(id, owner_id, calendar_id, source, start_utc, end_utc, all_day, data)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
            self._conn.commit()
        return len(rows)

    def clear_events(self, source: str | None = None) -> None:
        with self._lock:
            if source is None:
                self._conn.execute("DELETE FROM events WHERE owner_id = ?", (self.owner_id,))
            else:
                self._conn.execute(
                    "DELETE FROM events WHERE owner_id = ? AND source = ?", (self.owner_id, source)
                )
            self._conn.commit()

    def all_events(self) -> list[Event]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM events WHERE owner_id = ? ORDER BY start_utc ASC", (self.owner_id,)
            ).fetchall()
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
            rows = self._conn.execute(
                "SELECT DISTINCT source FROM events WHERE owner_id = ?", (self.owner_id,)
            ).fetchall()
        return [row["source"] for row in rows]

    def event_count(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM events WHERE owner_id = ?", (self.owner_id,)
            ).fetchone()
        return int(row["n"]) if row else 0

    # ----------------------------------------------------------------- tasks
    def _task_row(self, task: Task, source: str | None = None) -> tuple:
        return (
            task.id,
            self.owner_id,
            source or task.source,
            task.status,
            task.due.astimezone(timezone.utc).isoformat() if task.due else None,
            task.updated_utc.astimezone(timezone.utc).isoformat(),
            json.dumps(task.to_dict()),
        )

    def upsert_task(self, task: Task) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO tasks"
                "(id, owner_id, source, status, due_utc, updated_utc, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
                self._task_row(task),
            )
            self._conn.commit()

    def replace_tasks(self, tasks: Iterable[Task], source: str) -> int:
        """Atomically swap out every task belonging to `source`."""
        rows = [self._task_row(task, source) for task in tasks]
        with self._lock:
            self._conn.execute(
                "DELETE FROM tasks WHERE owner_id = ? AND source = ?", (self.owner_id, source)
            )
            if rows:
                self._conn.executemany(
                    "INSERT OR REPLACE INTO tasks"
                    "(id, owner_id, source, status, due_utc, updated_utc, data)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
            self._conn.commit()
        return len(rows)

    def get_task(self, task_id: str) -> Task | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM tasks WHERE owner_id = ? AND id = ?", (self.owner_id, task_id)
            ).fetchone()
        if row is None:
            return None
        try:
            return Task.from_dict(json.loads(row["data"]))
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def all_tasks(self) -> list[Task]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM tasks WHERE owner_id = ?", (self.owner_id,)
            ).fetchall()
        tasks: list[Task] = []
        for row in rows:
            try:
                tasks.append(Task.from_dict(json.loads(row["data"])))
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        return tasks

    def delete_task(self, task_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM tasks WHERE owner_id = ? AND id = ?", (self.owner_id, task_id)
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def clear_tasks(self, source: str | None = None) -> None:
        with self._lock:
            if source is None:
                self._conn.execute("DELETE FROM tasks WHERE owner_id = ?", (self.owner_id,))
            else:
                self._conn.execute(
                    "DELETE FROM tasks WHERE owner_id = ? AND source = ?", (self.owner_id, source)
                )
            self._conn.commit()

    def task_sources(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT source FROM tasks WHERE owner_id = ?", (self.owner_id,)
            ).fetchall()
        return [row["source"] for row in rows]

    def task_count(self, *, open_only: bool = False) -> int:
        sql = "SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?"
        if open_only:
            sql += " AND status != 'done'"
        with self._lock:
            row = self._conn.execute(sql, (self.owner_id,)).fetchone()
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
                "(owner_id, event_id, kind, title, body, payload, created_utc)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self.owner_id, event_id, kind, title, body, json.dumps(payload or {}), _utcnow_iso()),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def notifications(self, *, include_dismissed: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM notifications WHERE owner_id = ?"
        if not include_dismissed:
            sql += " AND dismissed = 0"
        sql += " ORDER BY created_utc DESC, id DESC LIMIT ?"
        with self._lock:
            rows = self._conn.execute(sql, (self.owner_id, limit)).fetchall()
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
                f"UPDATE notifications SET seen = 1 WHERE owner_id = ? AND id IN ({placeholders})",
                [self.owner_id, *ids],
            )
            self._conn.commit()

    def dismiss_notification(self, notification_id: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE notifications SET dismissed = 1, seen = 1 WHERE owner_id = ? AND id = ?",
                (self.owner_id, int(notification_id)),
            )
            self._conn.commit()

    def dismiss_all(self) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE notifications SET dismissed = 1, seen = 1 WHERE owner_id = ?", (self.owner_id,)
            )
            self._conn.commit()

    def delete_notifications_for(self, event_id: str) -> int:
        """Drop every notification tied to one event or task.

        Used when a deadline moves or a task is completed: the reminder that
        was already raised for the old state must not survive, and the unique
        (owner_id, event_id, kind) index would otherwise block a fresh one.
        """
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM notifications WHERE owner_id = ? AND event_id = ?",
                (self.owner_id, str(event_id)),
            )
            self._conn.commit()
            return cursor.rowcount

    def clear_notifications(self) -> None:
        """Delete every notification row for this owner.

        Different from `dismiss_all`: dismissed rows still block a reminder
        from ever being raised again for that event, which is what we want
        during normal operation but not when the calendar is reloaded.
        """
        with self._lock:
            self._conn.execute("DELETE FROM notifications WHERE owner_id = ?", (self.owner_id,))
            self._conn.commit()

    def prune_notifications(self, valid_event_ids: set[str]) -> None:
        """Drop reminders whose event no longer exists (deleted / moved)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, event_id FROM notifications WHERE owner_id = ?", (self.owner_id,)
            ).fetchall()
            stale = [row["id"] for row in rows if row["event_id"] not in valid_event_ids]
            if stale:
                placeholders = ",".join("?" for _ in stale)
                self._conn.execute(
                    f"DELETE FROM notifications WHERE owner_id = ? AND id IN ({placeholders})",
                    [self.owner_id, *stale],
                )
                self._conn.commit()
