"""Application service layer.

Owns the store, the Google client, the user preferences and the background
scheduler that raises 30-minute reminders.  The FastAPI layer is a thin shell
over this class.
"""

from __future__ import annotations

import logging
import smtplib
import threading
from datetime import date, datetime, time, timedelta, timezone
from email.message import EmailMessage
from typing import Any
from zoneinfo import ZoneInfo, available_timezones

from . import analytics, demo_data
from .config import Settings
from .google_client import GOOGLE_LIBS_AVAILABLE, GoogleAuthError, GoogleCalendarClient
from .models import Event, humanise_minutes
from .store import Store

log = logging.getLogger("meetmanager.service")

PREFS_KEY = "preferences"
SYNC_STATE_KEY = "sync_state"

DEFAULT_PREFS: dict[str, Any] = {
    "timezone": None,               # None -> fall back to Settings.timezone
    "reminder_minutes": None,
    "work_start": None,             # "HH:MM"
    "work_end": None,
    "work_days": None,              # list[int]
    "buffer_minutes": None,
    "default_duration": 30,
    "horizon_days": 10,
    "email_reminders": False,
    "browser_notifications": True,
    "theme": "dark",
}


def _parse_hhmm(raw: str | None, fallback: time) -> time:
    if not raw:
        return fallback
    try:
        hours, _, minutes = str(raw).partition(":")
        return time(int(hours), int(minutes or 0))
    except (ValueError, TypeError):
        return fallback


class MeetManagerService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = Store(settings.db_path)
        self.google = GoogleCalendarClient(settings, self.store)
        self._sync_lock = threading.Lock()
        self._scheduler = None

        prefs = self.store.get(PREFS_KEY)
        if not isinstance(prefs, dict):
            self.store.set(PREFS_KEY, dict(DEFAULT_PREFS))

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        """Start background sync + reminder jobs.  Never raises."""
        try:
            from apscheduler.schedulers.background import BackgroundScheduler

            scheduler = BackgroundScheduler(
                timezone="UTC",
                job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 120},
            )
            scheduler.add_job(
                self._safe_reminder_scan, "interval", seconds=20, id="reminders", next_run_time=datetime.now(timezone.utc)
            )
            scheduler.add_job(
                self._safe_background_sync,
                "interval",
                seconds=max(60, self.settings.sync_interval_seconds),
                id="sync",
            )
            scheduler.start()
            self._scheduler = scheduler
            log.info("Background scheduler started")
        except Exception as exc:  # noqa: BLE001 - scheduling is best-effort
            log.warning("Background scheduler unavailable (%s); reminders will be "
                        "evaluated on each page refresh instead.", exc)

    def shutdown(self) -> None:
        if self._scheduler is not None:
            try:
                self._scheduler.shutdown(wait=False)
            except Exception:  # noqa: BLE001
                pass
            self._scheduler = None
        self.store.close()

    # ---------------------------------------------------------- preferences
    def prefs(self) -> dict[str, Any]:
        stored = self.store.get(PREFS_KEY) or {}
        merged = dict(DEFAULT_PREFS)
        if isinstance(stored, dict):
            merged.update({k: v for k, v in stored.items() if k in DEFAULT_PREFS})
        return merged

    def update_prefs(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.prefs()
        for key, value in updates.items():
            if key not in DEFAULT_PREFS:
                continue
            if key == "timezone" and value:
                if str(value) not in available_timezones():
                    continue
            if key == "work_days" and value is not None:
                try:
                    value = sorted({int(d) for d in value if 0 <= int(d) <= 6})
                except (TypeError, ValueError):
                    continue
                if not value:
                    continue
            if key in {"reminder_minutes", "buffer_minutes", "default_duration", "horizon_days"} and value is not None:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    continue
            current[key] = value
        self.store.set(PREFS_KEY, current)
        return current

    # -------------------------------------------------------- resolved prefs
    @property
    def tz(self) -> ZoneInfo:
        name = self.prefs().get("timezone") or self.settings.timezone
        try:
            return ZoneInfo(name)
        except Exception:  # noqa: BLE001
            return ZoneInfo("UTC")

    @property
    def reminder_minutes(self) -> int:
        value = self.prefs().get("reminder_minutes")
        try:
            value = int(value) if value is not None else self.settings.reminder_minutes
        except (TypeError, ValueError):
            value = self.settings.reminder_minutes
        return max(1, min(value, 24 * 60))

    @property
    def buffer_minutes(self) -> int:
        value = self.prefs().get("buffer_minutes")
        try:
            value = int(value) if value is not None else self.settings.buffer_minutes
        except (TypeError, ValueError):
            value = self.settings.buffer_minutes
        return max(0, min(value, 120))

    @property
    def work_start(self) -> time:
        return _parse_hhmm(self.prefs().get("work_start"), self.settings.work_start)

    @property
    def work_end(self) -> time:
        return _parse_hhmm(self.prefs().get("work_end"), self.settings.work_end)

    @property
    def work_days(self) -> tuple[int, ...]:
        raw = self.prefs().get("work_days")
        if isinstance(raw, list) and raw:
            try:
                return tuple(sorted({int(d) for d in raw if 0 <= int(d) <= 6}))
            except (TypeError, ValueError):
                pass
        return self.settings.work_days

    # ---------------------------------------------------------------- events
    def events(self) -> list[Event]:
        return self.store.all_events()

    def data_mode(self) -> str:
        sources = set(self.store.event_sources())
        if "google" in sources:
            return "google"
        if "demo" in sources:
            return "demo"
        return "empty"

    # ------------------------------------------------------------------ sync
    def sync(self) -> dict[str, Any]:
        """Pull fresh events from Google.  Returns a result envelope."""
        if not self.google.is_connected():
            return {
                "ok": False,
                "reason": "not_connected",
                "message": self.google.setup_hint(),
                "count": self.store.event_count(),
            }

        if not self._sync_lock.acquire(blocking=False):
            return {"ok": True, "message": "A sync is already running.", "count": self.store.event_count()}

        try:
            events = self.google.fetch_events(days_back=1, days_ahead=self.settings.sync_days_ahead)
            self.store.replace_events(events, "google")
            self.store.clear_events("demo")
            state = {
                "last_sync": datetime.now(timezone.utc).isoformat(),
                "last_error": None,
                "count": len(events),
            }
            self.store.set(SYNC_STATE_KEY, state)
            self.store.prune_notifications({e.id for e in self.store.all_events()})
            self.scan_reminders()
            return {"ok": True, "message": f"Synced {len(events)} events.", "count": len(events)}
        except GoogleAuthError as exc:
            self._record_sync_error(str(exc))
            return {"ok": False, "reason": "auth", "message": str(exc), "count": self.store.event_count()}
        except Exception as exc:  # noqa: BLE001 - surface, never crash
            log.exception("Calendar sync failed")
            message = f"Calendar sync failed: {exc}"
            self._record_sync_error(message)
            return {"ok": False, "reason": "error", "message": message, "count": self.store.event_count()}
        finally:
            self._sync_lock.release()

    def _record_sync_error(self, message: str) -> None:
        state = self.store.get(SYNC_STATE_KEY) or {}
        state["last_error"] = message
        state["last_error_at"] = datetime.now(timezone.utc).isoformat()
        self.store.set(SYNC_STATE_KEY, state)

    def _safe_background_sync(self) -> None:
        try:
            if self.google.is_connected():
                self.sync()
        except Exception:  # noqa: BLE001
            log.exception("Background sync raised")

    # ------------------------------------------------------------ demo mode
    def load_demo(self) -> dict[str, Any]:
        events = demo_data.generate(self.settings.owner_email, self.tz)
        self.store.clear_events("google")
        self.store.replace_events(events, "demo")
        self.store.clear_notifications()
        self.store.set(
            SYNC_STATE_KEY,
            {"last_sync": datetime.now(timezone.utc).isoformat(), "last_error": None, "count": len(events)},
        )
        self.scan_reminders()
        return {"ok": True, "message": f"Loaded {len(events)} sample meetings.", "count": len(events)}

    def clear_all(self) -> dict[str, Any]:
        self.store.clear_events()
        self.store.clear_notifications()
        self.store.set(SYNC_STATE_KEY, {"last_sync": None, "last_error": None, "count": 0})
        return {"ok": True, "message": "Cleared all tracked events.", "count": 0}

    # ------------------------------------------------------------ reminders
    def _safe_reminder_scan(self) -> None:
        try:
            self.scan_reminders()
        except Exception:  # noqa: BLE001
            log.exception("Reminder scan raised")

    def scan_reminders(self) -> int:
        """Create reminder notifications for meetings inside the lead window."""
        tz = self.tz
        now = datetime.now(tz)
        lead = timedelta(minutes=self.reminder_minutes)
        created = 0

        events = [e for e in self.events() if e.counts_as_busy]

        for event in events:
            local_start = event.start.astimezone(tz)
            delta = local_start - now
            if timedelta(0) <= delta <= lead:
                minutes_away = max(0, int(delta.total_seconds() // 60))
                body_bits = [f"Starts at {local_start.strftime('%H:%M')} ({minutes_away} min away)."]
                if event.location:
                    body_bits.append(f"Where: {event.location}")
                if event.attendee_count:
                    body_bits.append(f"{event.attendee_count} attendee(s)")
                added = self.store.add_notification(
                    event_id=event.id,
                    kind="reminder",
                    title=f"Starting soon: {event.summary}",
                    body=" ".join(body_bits),
                    payload={
                        "event_id": event.id,
                        "summary": event.summary,
                        "start": event.start.isoformat(),
                        "local_start": local_start.isoformat(),
                        "minutes_away": minutes_away,
                        "meet_link": event.meet_link,
                        "location": event.location,
                        "colour": event.colour,
                    },
                )
                if added:
                    created += 1
                    self._maybe_email(event, minutes_away)

        # Conflict alerts, raised once per clashing group.
        for group in analytics.find_conflicts(events):
            if group.start < now - timedelta(hours=1):
                continue
            local_start = group.start.astimezone(tz)
            titles = ", ".join(e.summary for e in group.events[:3])
            anchor = min(e.id for e in group.events)
            added = self.store.add_notification(
                event_id=anchor,
                kind=f"conflict:{group.start.isoformat()}",
                title=f"Double booking on {local_start.strftime('%a %d %b')}",
                body=f"{len(group.events)} meetings overlap at {local_start.strftime('%H:%M')}: {titles}",
                payload={
                    "severity": group.severity,
                    "date_key": local_start.strftime("%Y-%m-%d"),
                    "count": len(group.events),
                },
            )
            if added:
                created += 1

        return created

    def _maybe_email(self, event: Event, minutes_away: int) -> None:
        if not self.prefs().get("email_reminders"):
            return
        if not self.settings.email_reminders_enabled:
            return
        try:
            local_start = event.start.astimezone(self.tz)
            message = EmailMessage()
            message["Subject"] = f"[Reminder] {event.summary} in {minutes_away} min"
            message["From"] = self.settings.smtp_user
            message["To"] = self.settings.email_recipient
            lines = [
                f"{event.summary}",
                f"{local_start.strftime('%A %d %B %Y, %H:%M')} ({self.tz.key})",
                f"Duration: {humanise_minutes(event.duration_minutes)}",
            ]
            if event.location:
                lines.append(f"Location: {event.location}")
            if event.meet_link:
                lines.append(f"Join: {event.meet_link}")
            message.set_content("\n".join(lines))

            with smtplib.SMTP(self.settings.smtp_host, self.settings.smtp_port, timeout=15) as smtp:
                smtp.starttls()
                smtp.login(self.settings.smtp_user, self.settings.smtp_password)
                smtp.send_message(message)
            log.info("Reminder e-mail sent for %s", event.summary)
        except Exception as exc:  # noqa: BLE001 - email must never break reminders
            log.warning("Could not send reminder e-mail: %s", exc)

    # --------------------------------------------------------------- reading
    def notifications(self) -> list[dict[str, Any]]:
        tz = self.tz
        items = self.store.notifications()
        for item in items:
            try:
                created = datetime.fromisoformat(item["created_utc"]).astimezone(tz)
                item["created_label"] = created.strftime("%H:%M")
                item["created_local"] = created.isoformat()
            except (ValueError, TypeError):
                item["created_label"] = ""
                item["created_local"] = ""
            item["is_conflict"] = item["kind"].startswith("conflict")
        return items

    def timeline(self, day: date | None = None) -> dict[str, Any]:
        tz = self.tz
        day = day or datetime.now(tz).date()
        return analytics.build_timeline(self.events(), tz, day)

    def recommendations(
        self,
        *,
        duration_minutes: int | None = None,
        horizon_days: int | None = None,
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        prefs = self.prefs()
        tz = self.tz
        duration = duration_minutes or int(prefs.get("default_duration") or 30)
        horizon = horizon_days or int(prefs.get("horizon_days") or 10)
        slots = analytics.recommend_slots(
            self.events(),
            tz,
            duration_minutes=duration,
            horizon_days=horizon,
            work_start=self.work_start,
            work_end=self.work_end,
            work_days=self.work_days,
            buffer_minutes=self.buffer_minutes,
            limit=limit,
        )
        return [slot.as_view(tz) for slot in slots]

    def state(self, *, timeline_date: date | None = None) -> dict[str, Any]:
        tz = self.tz
        now = datetime.now(tz)
        events = self.events()
        conflicts = analytics.find_conflicts(events)
        tight = analytics.find_tight_transitions(events, self.buffer_minutes)
        sync_state = self.store.get(SYNC_STATE_KEY) or {}

        last_sync_label = "Never"
        if sync_state.get("last_sync"):
            try:
                last_sync_label = (
                    datetime.fromisoformat(sync_state["last_sync"]).astimezone(tz).strftime("%d %b %H:%M")
                )
            except (ValueError, TypeError):
                last_sync_label = "Unknown"

        upcoming = [
            e.as_view(tz)
            for e in sorted((e for e in events if e.end > now), key=lambda e: e.start)
        ]
        conflict_ids = {e.id for group in conflicts for e in group.events}
        for item in upcoming:
            item["in_conflict"] = item["id"] in conflict_ids

        agenda: dict[str, dict[str, Any]] = {}
        for item in upcoming:
            bucket = agenda.setdefault(
                item["date_key"],
                {
                    "date": item["date_key"],
                    "label": item["day_label"],
                    "events": [],
                    "conflict_count": 0,
                    "busy_minutes": 0,
                },
            )
            bucket["events"].append(item)
            if item["in_conflict"]:
                bucket["conflict_count"] += 1
            if item["counts_as_busy"]:
                bucket["busy_minutes"] += item["duration_minutes"]

        for bucket in agenda.values():
            bucket["busy_label"] = humanise_minutes(bucket["busy_minutes"])
            try:
                bucket_date = date.fromisoformat(bucket["date"])
                if bucket_date == now.date():
                    bucket["label"] = "Today"
                elif bucket_date == now.date() + timedelta(days=1):
                    bucket["label"] = "Tomorrow"
                bucket["full_label"] = bucket_date.strftime("%A, %d %B")
            except ValueError:
                bucket["full_label"] = bucket["label"]

        return {
            "now": now.isoformat(),
            "timezone": tz.key,
            "owner_email": self.settings.owner_email,
            "data_mode": self.data_mode(),
            "stats": analytics.build_stats(events, tz, conflicts, now=now),
            "events": [e.as_view(tz) for e in events],
            "upcoming": upcoming,
            "agenda": sorted(agenda.values(), key=lambda b: b["date"]),
            "conflicts": [group.as_view(tz) for group in conflicts],
            "tight_transitions": [
                {
                    "previous": item["previous"].as_view(tz),
                    "next": item["next"].as_view(tz),
                    "gap_minutes": item["gap_minutes"],
                }
                for item in tight
            ],
            "timeline": self.timeline(timeline_date),
            "recommendations": self.recommendations(),
            "notifications": self.notifications(),
            "google": {
                "libs_available": GOOGLE_LIBS_AVAILABLE,
                "configured": self.google.is_configured(),
                "connected": self.google.is_connected(),
                "hint": self.google.setup_hint(),
                "profile": self.google.profile(),
            },
            "sync": {
                "last_sync": sync_state.get("last_sync"),
                "last_sync_label": last_sync_label,
                "last_error": sync_state.get("last_error"),
                "count": self.store.event_count(),
            },
            "preferences": {
                **self.prefs(),
                "resolved": {
                    "timezone": tz.key,
                    "reminder_minutes": self.reminder_minutes,
                    "buffer_minutes": self.buffer_minutes,
                    "work_start": self.work_start.strftime("%H:%M"),
                    "work_end": self.work_end.strftime("%H:%M"),
                    "work_days": list(self.work_days),
                    "email_available": self.settings.email_reminders_enabled,
                },
            },
        }
