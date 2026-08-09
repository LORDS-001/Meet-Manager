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

    @check("Task CRUD round-trips")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "tasks.db"
            service = MeetManagerService(settings)

            assert not service.create_task({"title": "   "})["ok"], "a blank title must be rejected"

            created = service.create_task(
                {"title": "Write the quarterly report", "notes": "Draft first", "priority": "high"}
            )
            assert created["ok"], created
            task_id = created["task"]["id"]

            updated = service.update_task(task_id, {"title": "Write the annual report", "status": "doing"})
            assert updated["ok"] and updated["task"]["title"] == "Write the annual report"
            assert updated["task"]["status"] == "doing"

            done = service.toggle_task(task_id)
            assert done["ok"] and done["task"]["is_done"], "toggle must complete the task"
            assert done["task"]["completed_utc"], "a completed task needs a completion stamp"
            reopened = service.toggle_task(task_id)
            assert not reopened["task"]["is_done"], "toggle must reopen the task"

            assert service.delete_task(task_id)["ok"]
            assert service.store.get_task(task_id) is None, "delete must remove the row"
            assert not service.delete_task(task_id)["ok"], "deleting twice must fail cleanly"
            service.shutdown()
        return "create / update / toggle / delete verified"

    @check("Naive deadlines are read in the user's timezone")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "tz.db"
            service = MeetManagerService(settings)
            # This is exactly what a browser's datetime-local input sends.
            result = service.create_task({"title": "Timezone probe", "due": "2030-06-01T14:30"})
            assert result["ok"], result
            stored = service.store.get_task(result["task"]["id"])
            local = stored.due.astimezone(service.tz)
            assert (local.hour, local.minute) == (14, 30), (
                f"expected 14:30 local, got {local:%H:%M} - naive input was not read as local time"
            )
            service.shutdown()
        return f"14:30 naive -> 14:30 in {settings.timezone}"

    @check("Task deadlines raise reminders exactly once")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "taskrem.db"
            service = MeetManagerService(settings)
            now = datetime.now(service.tz)

            soon = service.create_task(
                {"title": "Submit timesheet", "due": (now + timedelta(minutes=5)).isoformat()}
            )
            late = service.create_task(
                {"title": "Renew the domain", "due": (now - timedelta(hours=3)).isoformat()}
            )
            assert soon["ok"] and late["ok"]

            service.scan_reminders()
            kinds = [n["kind"] for n in service.notifications()]
            assert "task_due" in kinds, "a task due inside the lead window must raise a reminder"
            assert "task_overdue" in kinds, "an overdue task must raise an alert"

            before = len(service.notifications())
            service.scan_reminders()
            service.scan_reminders()
            assert len(service.notifications()) == before, "re-scanning duplicated task reminders"

            # Completing a task must silence it.
            service.toggle_task(soon["task"]["id"])
            remaining = [n for n in service.notifications() if n["event_id"] == soon["task"]["id"]]
            assert not remaining, "completing a task must clear its reminders"
            service.shutdown()
        return "due + overdue raised once each, cleared on completion"

    @check("A calendar sync never prunes task reminders")
    def _():
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "prune.db"
            service = MeetManagerService(settings)
            service.load_demo()
            now = datetime.now(service.tz)
            created = service.create_task(
                {"title": "Keep me", "due": (now + timedelta(minutes=5)).isoformat()}
            )
            service.scan_reminders()
            task_id = created["task"]["id"]
            assert any(n["event_id"] == task_id for n in service.notifications())

            # prune_notifications is what sync() runs; tasks must be in the keep-set.
            service.store.prune_notifications(
                {e.id for e in service.store.all_events()} | {t.id for t in service.store.all_tasks()}
            )
            assert any(n["event_id"] == task_id for n in service.notifications()), (
                "pruning dropped a task reminder"
            )
            service.shutdown()
        return "task reminders survive a prune"

    @check("Mirrored tasks are read-only")
    def _():
        from app.tasks import Task, normalise_google_task

        payload = {
            "id": "abc123",
            "title": "Mirrored from Google",
            "status": "needsAction",
            "due": "2030-01-01T00:00:00.000Z",
            "notes": "from the provider",
        }
        mirrored = normalise_google_task(payload, "My list")
        assert mirrored is not None and mirrored.source == "google_tasks"
        assert not mirrored.is_editable, "provider tasks must not be editable"
        assert normalise_google_task({"id": "x", "title": "  "}, "L") is None, "untitled rows are noise"

        # Two syncs of the same remote task must not create two rows.
        again = normalise_google_task(payload, "My list")
        assert again.id == mirrored.id, "provider ids must be stable across syncs"

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "mirror.db"
            service = MeetManagerService(settings)
            service.store.upsert_task(mirrored)
            blocked = service.update_task(mirrored.id, {"title": "nope"})
            assert not blocked["ok"], "editing a mirrored task must be refused"
            assert not service.delete_task(mirrored.id)["ok"], "deleting a mirrored task must be refused"
            # Completing one locally is allowed - it is overwritten on next sync.
            assert service.toggle_task(mirrored.id)["ok"]
            service.shutdown()
        return "read-only enforced, ids stable, local completion allowed"

    @check("Task statistics add up")
    def _():
        from app.tasks import Task, build_task_stats

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "stats.db"
            service = MeetManagerService(settings)
            now = datetime.now(service.tz)
            service.create_task({"title": "Overdue one", "due": (now - timedelta(days=1)).isoformat()})
            service.create_task({"title": "Due later today", "due": (now + timedelta(hours=4)).isoformat()})
            service.create_task({"title": "No deadline"})
            finished = service.create_task({"title": "Finished"})
            service.toggle_task(finished["task"]["id"])

            stats = service.task_stats()
            assert stats["total"] == 4, stats
            assert stats["open"] == 3 and stats["done"] == 1, stats
            assert stats["overdue"] == 1, stats
            assert stats["no_deadline"] == 1, stats
            assert stats["completion_pct"] == 25, stats
            assert stats["open"] + stats["done"] == stats["total"], "open + done must equal total"
            assert stats["next_task"], "expected a next task with a deadline"

            # Ordering: overdue first, undated last.
            views = service.task_views()
            assert views[0]["urgency"] == "overdue", [v["urgency"] for v in views]
            assert views[-1]["is_done"], "completed tasks sort last"
            service.shutdown()
        return "4 tasks: 3 open, 1 done, 1 overdue, 25% complete"

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

                # Tasks
                assert client.get("/api/tasks").json()["ok"]
                made = client.post("/api/tasks", json={"title": "API task", "priority": "urgent"}).json()
                assert made["ok"], made
                tid = made["task"]["id"]
                # /api/tasks/sync must not be swallowed by /api/tasks/{task_id}
                assert "ok" in client.post("/api/tasks/sync").json()
                assert client.post(f"/api/tasks/{tid}", json={"notes": "via API"}).json()["ok"]
                assert client.post(f"/api/tasks/{tid}/toggle").json()["task"]["is_done"]
                listed = client.get("/api/tasks").json()
                assert any(t["id"] == tid for t in listed["tasks"]), "created task missing from the list"
                assert client.request("DELETE", f"/api/tasks/{tid}").json()["ok"]
                state = client.get("/api/state").json()["state"]
                for key in ("tasks", "task_stats", "task_sources", "task_sync"):
                    assert key in state, f"state is missing {key}"
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

