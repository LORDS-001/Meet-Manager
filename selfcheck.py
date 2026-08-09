"""Self-check: exercises every subsystem without starting a web server.

    python selfcheck.py

Prints a PASS/FAIL line per check and exits non-zero if anything failed.
"""

from __future__ import annotations

import tempfile
import traceback
import warnings
from datetime import datetime, timedelta
from pathlib import Path

warnings.filterwarnings("ignore")

RESULTS: list[tuple[bool, str, str]] = []


def check(name: str):
    def decorator(fn):
        try:
            detail = fn() or ""
            RESULTS.append((True, name, str(detail)))
        except Exception as exc:  # noqa: BLE001
            RESULTS.append((False, name, f"{type(exc).__name__}: {exc}"))
            traceback.print_exc()
        return fn

    return decorator


def main() -> int:
    from app import analytics, demo_data
    from app.config import settings
    from app.service import MeetManagerService
    from app.store import Store

    tz = settings.tz
    owner = settings.owner_email

    @check("Config loads")
    def _():
        return f"mailbox={owner} tz={settings.timezone} reminder={settings.reminder_minutes}m"

    @check("Demo calendar generates")
    def _():
        events = demo_data.generate(owner, tz)
        assert len(events) > 15, "expected a populated demo calendar"
        assert all(e.end > e.start for e in events), "found an event ending before it starts"
        return f"{len(events)} events"

    events = demo_data.generate(owner, tz)

    @check("Conflict detection finds double bookings")
    def _():
        groups = analytics.find_conflicts(events)
        assert groups, "demo data must contain at least one conflict"
        for group in groups:
            assert len(group.events) >= 2
            for pair in group.pairs:
                assert pair.overlap_minutes > 0
        return f"{len(groups)} conflict group(s)"

    @check("All-day and declined events never count as busy")
    def _():
        busy_ids = {e.id for e in events if e.counts_as_busy}
        for event in events:
            if event.all_day or event.response_status == "declined":
                assert event.id not in busy_ids, f"{event.summary} should not be busy"
        conflicting = {e.id for g in analytics.find_conflicts(events) for e in g.events}
        for event in events:
            if event.all_day or event.response_status == "declined":
                assert event.id not in conflicting, f"{event.summary} must not raise a conflict"
        return "excluded correctly"

    @check("Timeline layout produces non-overlapping lanes")
    def _():
        today = datetime.now(tz).date()
        checked = 0
        for offset in range(10):
            timeline = analytics.build_timeline(events, tz, today + timedelta(days=offset))
            for block in timeline["blocks"]:
                assert 0 <= block["top_pct"] <= 100, "block starts outside the canvas"
                assert block["top_pct"] + block["height_pct"] <= 100.5, "block overflows the canvas"
                assert block["lane"] < block["lane_count"], "lane index out of range"
            # No two blocks may share a lane and overlap in time.
            for i, a in enumerate(timeline["blocks"]):
                for b in timeline["blocks"][i + 1:]:
                    if a["lane"] != b["lane"]:
                        continue
                    if a["left_pct"] != b["left_pct"]:
                        continue
                    a_start, a_end = a["local_start"], a["local_end"]
                    b_start, b_end = b["local_start"], b["local_end"]
                    assert not (a_start < b_end and b_start < a_end), (
                        f"lane collision: {a['summary']} vs {b['summary']}"
                    )
            checked += len(timeline["blocks"])
        return f"{checked} blocks laid out across 10 days"

    @check("Recommendations never collide with a booked meeting")
    def _():
        busy = [(e.start, e.end) for e in events if e.counts_as_busy]
        total = 0
        for duration in (15, 30, 45, 60, 90):
            slots = analytics.recommend_slots(events, tz, duration_minutes=duration, horizon_days=14, limit=10)
            assert slots, f"no slot found for a {duration}-minute meeting"
            for slot in slots:
                assert (slot.end - slot.start).total_seconds() == duration * 60
                assert slot.start > datetime.now(tz), "suggested a slot in the past"
                for start, end in busy:
                    assert not (slot.start < end and start < slot.end), (
                        f"suggested {slot.start} which overlaps a booked meeting"
                    )
            total += len(slots)
        return f"{total} slots validated, zero overlaps"

    @check("Recommendation scores are ordered and bounded")
    def _():
        slots = analytics.recommend_slots(events, tz, duration_minutes=30, horizon_days=14, limit=8)
        scores = [s.score for s in slots]
        assert scores == sorted(scores, reverse=True), "slots are not best-first"
        assert all(0 <= s <= 100 for s in scores), "score outside 0-100"
        return f"top score {scores[0]:.0f}, lowest {scores[-1]:.0f}"

    @check("Store round-trips events losslessly")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            store = Store(Path(tmp) / "t.db")
            store.replace_events(events, "demo")
            loaded = store.all_events()
            assert len(loaded) == len(events)
            original = {e.id: e for e in events}
            for event in loaded:
                source = original[event.id]
                assert event.summary == source.summary
                assert event.start == source.start
                assert event.end == source.end
                assert event.all_day == source.all_day
            store.close()
        return f"{len(events)} events"

    @check("Reminder engine raises alerts for imminent meetings")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "svc.db"
            service = MeetManagerService(settings)
            service.load_demo()
            reminders = [n for n in service.notifications() if n["kind"] == "reminder"]
            conflicts = [n for n in service.notifications() if n["is_conflict"]]
            assert reminders, "expected at least one 30-minute reminder from the demo data"
            # Re-scanning must not duplicate anything.
            before = len(service.notifications())
            service.scan_reminders()
            after = len(service.notifications())
            assert before == after, "reminder scan created duplicates"
            service.shutdown()
        return f"{len(reminders)} reminder(s), {len(conflicts)} conflict alert(s), no duplicates"

    @check("Full dashboard state builds")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "state.db"
            service = MeetManagerService(settings)
            service.load_demo()
            state = service.state()
            for key in ("stats", "events", "upcoming", "agenda", "conflicts", "timeline",
                        "recommendations", "notifications", "google", "sync", "preferences"):
                assert key in state, f"missing key: {key}"
            assert state["stats"]["total_tracked"] > 0
            assert state["recommendations"], "no recommendations produced"
            import json
            json.dumps(state)  # must be JSON-serialisable for the API
            service.shutdown()
        return f"{state['stats']['total_tracked']} events, {len(state['conflicts'])} conflicts, {len(state['recommendations'])} slots"

    @check("HTTP API responds")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "api.db"
            from fastapi.testclient import TestClient
            from app.main import app

            with TestClient(app) as client:
                assert client.get("/healthz").json()["ok"]
                assert client.post("/api/demo/load").json()["ok"]
                state = client.get("/api/state").json()
                assert state["ok"], state
                assert client.get("/api/timeline").json()["ok"]
                reco = client.get("/api/recommendations?duration=45&days=7").json()
                assert reco["ok"] and reco["recommendations"]
                assert client.get("/api/notifications").json()["ok"]
                page = client.get("/")
                assert page.status_code == 200 and "MeetManager" in page.text
                assert client.get("/static/app.js").status_code == 200
                assert client.get("/static/styles.css").status_code == 200
        return "all endpoints healthy"

    print()
    failures = 0
    for passed, name, detail in RESULTS:
        mark = "PASS" if passed else "FAIL"
        if not passed:
            failures += 1
        print(f"  [{mark}]  {name}" + (f"\n           {detail}" if detail else ""))
    print()
    if failures:
        print(f"  {failures} check(s) FAILED")
    else:
        print(f"  All {len(RESULTS)} checks passed.")
    print()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

