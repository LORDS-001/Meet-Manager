"""Task domain: the model, deadline urgency, and the connected-source layer.

A `Task` is deliberately close to `Event` in spirit - one normalised shape that
local tasks and every external provider collapse into, so everything
downstream (reminders, stats, the UI) is source-agnostic.

Adding a platform means writing one `TaskProvider` and registering it. Nothing
else in the app needs to know the provider exists.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Protocol

from .models import humanise_minutes, parse_dt

STATUSES = ("todo", "doing", "done")
PRIORITIES = ("low", "normal", "high", "urgent")

_PRIORITY_RANK = {"low": 0, "normal": 1, "high": 2, "urgent": 3}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_task_id() -> str:
    return f"local::{uuid.uuid4().hex[:16]}"


def stable_id(source: str, native_id: str) -> str:
    """A deterministic id so re-syncing a provider does not duplicate rows."""
    digest = hashlib.sha1(f"{source}:{native_id}".encode("utf-8", "ignore")).hexdigest()[:16]
    return f"{source}::{digest}"


@dataclass
class Task:
    id: str
    title: str
    notes: str = ""
    due: datetime | None = None
    status: str = "todo"
    priority: str = "normal"
    source: str = "local"
    source_name: str = "Local"
    list_name: str = ""
    url: str = ""
    tags: list[str] = field(default_factory=list)
    created_utc: datetime = field(default_factory=_utcnow)
    updated_utc: datetime = field(default_factory=_utcnow)
    completed_utc: datetime | None = None

    # ------------------------------------------------------------------ props
    @property
    def is_done(self) -> bool:
        return self.status == "done"

    @property
    def is_editable(self) -> bool:
        """External tasks are mirrored read-only; they are edited at the source."""
        return self.source == "local"

    @property
    def priority_rank(self) -> int:
        return _PRIORITY_RANK.get(self.priority, 1)

    def minutes_until_due(self, now: datetime | None = None) -> int | None:
        if self.due is None:
            return None
        now = now or _utcnow()
        return int((self.due - now).total_seconds() // 60)

    def is_overdue(self, now: datetime | None = None) -> bool:
        if self.due is None or self.is_done:
            return False
        return self.due < (now or _utcnow())

    def is_due_within(self, minutes: int, now: datetime | None = None) -> bool:
        left = self.minutes_until_due(now)
        return left is not None and not self.is_done and 0 <= left <= minutes

    def urgency(self, now: datetime | None = None) -> str:
        """Bucket used for sorting and for the colour of the state pill."""
        if self.is_done:
            return "done"
        if self.due is None:
            return "someday"
        left = self.minutes_until_due(now)
        if left is None:
            return "someday"
        if left < 0:
            return "overdue"
        if left <= 24 * 60:
            return "today"
        if left <= 7 * 24 * 60:
            return "week"
        return "later"

    def sort_key(self, now: datetime | None = None) -> tuple:
        """Open first, then soonest deadline, then priority, then title."""
        order = {"overdue": 0, "today": 1, "week": 2, "later": 3, "someday": 4, "done": 5}
        far = datetime.max.replace(tzinfo=timezone.utc)
        return (
            order.get(self.urgency(now), 4),
            self.due or far,
            -self.priority_rank,
            self.title.lower(),
        )

    # --------------------------------------------------------------- (de)ser
    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "notes": self.notes,
            "due": self.due.isoformat() if self.due else None,
            "status": self.status,
            "priority": self.priority,
            "source": self.source,
            "source_name": self.source_name,
            "list_name": self.list_name,
            "url": self.url,
            "tags": self.tags,
            "created_utc": self.created_utc.isoformat(),
            "updated_utc": self.updated_utc.isoformat(),
            "completed_utc": self.completed_utc.isoformat() if self.completed_utc else None,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Task":
        def _dt(value):
            if not value:
                return None
            try:
                return parse_dt(value)
            except (ValueError, TypeError):
                return None

        status = raw.get("status") or "todo"
        priority = raw.get("priority") or "normal"
        return cls(
            id=str(raw.get("id") or new_task_id()),
            title=raw.get("title") or "(untitled task)",
            notes=raw.get("notes") or "",
            due=_dt(raw.get("due")),
            status=status if status in STATUSES else "todo",
            priority=priority if priority in PRIORITIES else "normal",
            source=raw.get("source") or "local",
            source_name=raw.get("source_name") or "Local",
            list_name=raw.get("list_name") or "",
            url=raw.get("url") or "",
            tags=[str(t) for t in (raw.get("tags") or [])],
            created_utc=_dt(raw.get("created_utc")) or _utcnow(),
            updated_utc=_dt(raw.get("updated_utc")) or _utcnow(),
            completed_utc=_dt(raw.get("completed_utc")),
        )

    # ------------------------------------------------------------------ view
    def as_view(self, tz, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(tz)
        data = self.to_dict()
        left = self.minutes_until_due(now)
        urgency = self.urgency(now)

        if self.due is None:
            due_label = "No deadline"
            due_short = "—"
            local_due = None
        else:
            local = self.due.astimezone(tz)
            local_due = local.isoformat()
            due_label = local.strftime("%a %d %b, %H:%M")
            due_short = local.strftime("%d %b %H:%M")

        if self.is_done:
            countdown = "Completed"
        elif left is None:
            countdown = "No deadline"
        elif left < 0:
            countdown = f"{humanise_minutes(abs(left))} overdue"
        else:
            countdown = f"due in {humanise_minutes(left)}"

        data.update(
            {
                "local_due": local_due,
                "due_label": due_label,
                "due_short": due_short,
                "due_date_key": self.due.astimezone(tz).strftime("%Y-%m-%d") if self.due else "",
                "minutes_until_due": left,
                "countdown_label": countdown,
                "urgency": urgency,
                "is_overdue": urgency == "overdue",
                "is_done": self.is_done,
                "is_editable": self.is_editable,
                "priority_rank": self.priority_rank,
            }
        )
        return data


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------
def build_task_stats(tasks: Iterable[Task], tz, now: datetime | None = None) -> dict[str, Any]:
    tasks = list(tasks)
    now = (now or datetime.now(tz)).astimezone(tz)
    today = now.date()
    week_end = today + timedelta(days=7)

    open_tasks = [t for t in tasks if not t.is_done]
    done = [t for t in tasks if t.is_done]
    overdue = [t for t in open_tasks if t.is_overdue(now)]
    due_today = [
        t for t in open_tasks
        if t.due is not None and t.due.astimezone(tz).date() == today and not t.is_overdue(now)
    ]
    due_week = [
        t for t in open_tasks
        if t.due is not None and today <= t.due.astimezone(tz).date() < week_end
    ]
    no_deadline = [t for t in open_tasks if t.due is None]

    upcoming = sorted(
        (t for t in open_tasks if t.due is not None),
        key=lambda t: t.due,
    )
    next_view = upcoming[0].as_view(tz, now) if upcoming else None

    by_source: dict[str, int] = {}
    for task in tasks:
        by_source[task.source_name or task.source] = by_source.get(task.source_name or task.source, 0) + 1

    total = len(tasks)
    return {
        "total": total,
        "open": len(open_tasks),
        "done": len(done),
        "overdue": len(overdue),
        "due_today": len(due_today),
        "due_week": len(due_week),
        "no_deadline": len(no_deadline),
        "completion_pct": int(round(100 * len(done) / total)) if total else 0,
        "by_source": [{"source": k, "count": v} for k, v in sorted(by_source.items())],
        "next_task": next_view,
        "generated_at": now.isoformat(),
    }


# ---------------------------------------------------------------------------
# Connected sources
# ---------------------------------------------------------------------------
class TaskProvider(Protocol):
    """One external platform. Implement this and register it in the service."""

    key: str
    name: str

    def is_connected(self) -> bool:
        """True when this provider has everything it needs to fetch."""

    def status_hint(self) -> str:
        """One line explaining how to connect, or that it is connected."""

    def fetch(self) -> list[Task]:
        """Return the provider's tasks, already normalised. May raise."""


class GoogleTasksProvider:
    """Google Tasks, riding on the OAuth credentials the calendar already holds.

    Read-only: tasks are edited in Google Tasks and mirrored here. Google's
    payload carries no priority, so everything arrives as `normal`.
    """

    key = "google_tasks"
    name = "Google Tasks"

    def __init__(self, google_client) -> None:
        self.google = google_client

    def is_connected(self) -> bool:
        try:
            return bool(self.google.is_connected())
        except Exception:  # noqa: BLE001 - never let a provider break the app
            return False

    def status_hint(self) -> str:
        if not self.is_connected():
            return "Connect your Google account to mirror Google Tasks here."
        return "Connected - tasks are mirrored read-only."

    def fetch(self) -> list[Task]:
        return self.google.fetch_tasks()


def normalise_google_task(item: dict[str, Any], list_name: str) -> Task | None:
    """Google Tasks payload -> Task. Returns None for rows we cannot use."""
    native_id = item.get("id")
    title = (item.get("title") or "").strip()
    if not native_id or not title:
        # Google returns untitled placeholder rows; they are noise.
        return None

    due = None
    if item.get("due"):
        try:
            due = parse_dt(item["due"])
        except (ValueError, TypeError):
            due = None

    completed = None
    if item.get("completed"):
        try:
            completed = parse_dt(item["completed"])
        except (ValueError, TypeError):
            completed = None

    updated = None
    if item.get("updated"):
        try:
            updated = parse_dt(item["updated"])
        except (ValueError, TypeError):
            updated = None

    status = "done" if item.get("status") == "completed" else "todo"

    return Task(
        id=stable_id("google_tasks", str(native_id)),
        title=title[:300],
        notes=(item.get("notes") or "")[:2000],
        due=due,
        status=status,
        priority="normal",
        source="google_tasks",
        source_name="Google Tasks",
        list_name=list_name,
        url=item.get("webViewLink") or "",
        created_utc=updated or _utcnow(),
        updated_utc=updated or _utcnow(),
        completed_utc=completed,
    )
