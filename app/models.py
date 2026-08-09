"""Domain models.

A single normalised `Event` type is used everywhere so that Google-sourced
events and demo events are completely interchangeable downstream.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from dateutil import parser as date_parser

# Palette used to give each calendar / meeting a stable colour.
PALETTE = [
    "#6366f1",  # indigo
    "#0ea5e9",  # sky
    "#10b981",  # emerald
    "#f59e0b",  # amber
    "#ec4899",  # pink
    "#8b5cf6",  # violet
    "#14b8a6",  # teal
    "#f97316",  # orange
]


def colour_for(key: str) -> str:
    digest = hashlib.sha1(key.encode("utf-8", "ignore")).digest()
    return PALETTE[digest[0] % len(PALETTE)]


def parse_dt(value: Any) -> datetime:
    """Parse anything Google (or our own store) hands us into an aware datetime."""
    if isinstance(value, datetime):
        dt = value
    else:
        dt = date_parser.isoparse(str(value))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


@dataclass
class Event:
    id: str
    summary: str
    start: datetime
    end: datetime
    calendar_id: str = "primary"
    calendar_name: str = "Primary"
    description: str = ""
    location: str = ""
    all_day: bool = False
    html_link: str = ""
    meet_link: str = ""
    organizer_email: str = ""
    organizer_name: str = ""
    attendees: list[dict[str, Any]] = field(default_factory=list)
    status: str = "confirmed"
    response_status: str = "accepted"
    source: str = "google"
    recurring: bool = False

    # ------------------------------------------------------------------ props
    @property
    def duration_minutes(self) -> int:
        return max(0, int((self.end - self.start).total_seconds() // 60))

    @property
    def colour(self) -> str:
        return colour_for(self.calendar_id or self.summary or self.id)

    @property
    def is_cancelled(self) -> bool:
        return self.status == "cancelled"

    @property
    def is_declined(self) -> bool:
        return self.response_status == "declined"

    @property
    def counts_as_busy(self) -> bool:
        """Whether this event should block time / participate in conflicts."""
        return not (self.all_day or self.is_cancelled or self.is_declined)

    @property
    def attendee_count(self) -> int:
        return len(self.attendees)

    def overlaps(self, other: "Event") -> bool:
        return self.start < other.end and other.start < self.end

    def overlap_minutes(self, other: "Event") -> int:
        latest_start = max(self.start, other.start)
        earliest_end = min(self.end, other.end)
        delta = (earliest_end - latest_start).total_seconds() / 60
        return int(max(0.0, delta))

    # --------------------------------------------------------------- (de)ser
    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "summary": self.summary,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "calendar_id": self.calendar_id,
            "calendar_name": self.calendar_name,
            "description": self.description,
            "location": self.location,
            "all_day": self.all_day,
            "html_link": self.html_link,
            "meet_link": self.meet_link,
            "organizer_email": self.organizer_email,
            "organizer_name": self.organizer_name,
            "attendees": self.attendees,
            "status": self.status,
            "response_status": self.response_status,
            "source": self.source,
            "recurring": self.recurring,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Event":
        return cls(
            id=str(raw.get("id", "")),
            summary=raw.get("summary") or "(no title)",
            start=parse_dt(raw["start"]),
            end=parse_dt(raw["end"]),
            calendar_id=raw.get("calendar_id") or "primary",
            calendar_name=raw.get("calendar_name") or "Primary",
            description=raw.get("description") or "",
            location=raw.get("location") or "",
            all_day=bool(raw.get("all_day")),
            html_link=raw.get("html_link") or "",
            meet_link=raw.get("meet_link") or "",
            organizer_email=raw.get("organizer_email") or "",
            organizer_name=raw.get("organizer_name") or "",
            attendees=list(raw.get("attendees") or []),
            status=raw.get("status") or "confirmed",
            response_status=raw.get("response_status") or "accepted",
            source=raw.get("source") or "google",
            recurring=bool(raw.get("recurring")),
        )

    # ------------------------------------------------------------------ view
    def as_view(self, tz) -> dict[str, Any]:
        """Serialisation enriched with pre-formatted, timezone-aware fields."""
        local_start = self.start.astimezone(tz)
        local_end = self.end.astimezone(tz)
        data = self.to_dict()
        data.update(
            {
                "local_start": local_start.isoformat(),
                "local_end": local_end.isoformat(),
                "date_key": local_start.strftime("%Y-%m-%d"),
                "day_label": local_start.strftime("%a %d %b"),
                "time_label": (
                    "All day"
                    if self.all_day
                    else f"{local_start.strftime('%H:%M')} - {local_end.strftime('%H:%M')}"
                ),
                "duration_minutes": self.duration_minutes,
                "duration_label": _humanise_minutes(self.duration_minutes),
                "colour": self.colour,
                "attendee_count": self.attendee_count,
                "has_meet": bool(self.meet_link),
                "counts_as_busy": self.counts_as_busy,
            }
        )
        return data


def _humanise_minutes(minutes: int) -> str:
    if minutes <= 0:
        return "0m"
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f"{hours}h {mins}m"
    if hours:
        return f"{hours}h"
    return f"{mins}m"


humanise_minutes = _humanise_minutes


@dataclass
class Interval:
    start: datetime
    end: datetime

    def overlaps(self, other: "Interval") -> bool:
        return self.start < other.end and other.start < self.end


def merge_intervals(intervals: list[Interval]) -> list[Interval]:
    """Merge overlapping / touching intervals into a minimal sorted list."""
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda i: (i.start, i.end))
    merged = [Interval(ordered[0].start, ordered[0].end)]
    for current in ordered[1:]:
        last = merged[-1]
        if current.start <= last.end:
            if current.end > last.end:
                last.end = current.end
        else:
            merged.append(Interval(current.start, current.end))
    return merged


def pad(interval: Interval, minutes: int) -> Interval:
    delta = timedelta(minutes=minutes)
    return Interval(interval.start - delta, interval.end + delta)
