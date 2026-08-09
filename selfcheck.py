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

    @check("All-day meetings raise a reminder")
    def _():
        # Regression guard: all-day events are excluded from counts_as_busy so
        # they cannot create false clashes, which previously meant they raised
        # no reminder at all.
        from app.models import Event

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "allday.db"
            service = MeetManagerService(settings)
            tz = service.tz
            now = datetime.now(tz)
            midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)

            today = Event(id="ad-today", summary="All-day workshop", all_day=True,
                          start=midnight, end=midnight + timedelta(days=1))
            multi = Event(id="ad-multi", summary="Conference week", all_day=True,
                          start=midnight, end=midnight + timedelta(days=3))
            future = Event(id="ad-future", summary="Next week offsite", all_day=True,
                           start=midnight + timedelta(days=7), end=midnight + timedelta(days=8))
            declined = Event(id="ad-declined", summary="Declined all-day", all_day=True,
                             start=midnight, end=midnight + timedelta(days=1),
                             response_status="declined")
            service.store.replace_events([today, multi, future, declined], "google")

            # Working hours gate the reminder, so evaluate as if mid-morning.
            service.update_prefs({"work_start": "00:00"})
            service.scan_reminders()
            digests = [n for n in service.notifications() if n["kind"].startswith("allday")]

            assert len(digests) == 1, f"expected exactly one all-day digest, got {len(digests)}"
            digest = digests[0]
            # Two qualify today (single + multi-day); the future and declined must not.
            assert digest["payload"]["count"] == 2, digest["payload"]
            assert "All-day workshop" in digest["body"], digest["body"]
            assert "Conference week" in digest["body"], digest["body"]
            assert "Next week offsite" not in digest["body"], "a future all-day event leaked in"
            assert "Declined" not in digest["body"], "a declined all-day event leaked in"

            before = len(service.notifications())
            service.scan_reminders()
            service.scan_reminders()
            assert len(service.notifications()) == before, "re-scanning duplicated the all-day digest"

            # It must survive the prune a calendar sync performs, which means
            # being anchored on a real event id rather than a synthetic one.
            service.store.prune_notifications({e.id for e in service.store.all_events()})
            assert [n for n in service.notifications() if n["kind"].startswith("allday")], (
                "the all-day digest was pruned - it is not anchored on a real event"
            )

            # An all-day event still must not be treated as busy time.
            assert not today.counts_as_busy, "all-day events must stay out of busy time"
            service.shutdown()
        return "one digest covering 2 events; future and declined excluded; survives prune"

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

    @check("OAuth PKCE verifier survives the redirect")
    def _():
        # Regression guard: authorization_url() and finish_auth() build two
        # different Flow objects. google-auth-oauthlib >= 1.1 auto-generates a
        # PKCE code_verifier on the first one, so it must be persisted or the
        # token exchange dies with "Missing code verifier".
        from urllib.parse import parse_qs, urlparse

        from app.google_client import OAUTH_STATE_KEY

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "oauth.db"
            original = (settings.google_client_id, settings.google_client_secret)
            settings.google_client_id = "test-client-id.apps.googleusercontent.com"
            settings.google_client_secret = "test-secret"
            try:
                service = MeetManagerService(settings)
                url, pending = service.google.authorization_url()

                query = parse_qs(urlparse(url).query)
                assert "code_challenge" in query, "no PKCE challenge was sent"

                assert isinstance(pending, dict), f"expected a dict, got {type(pending).__name__}"
                assert pending.get("state"), "the OAuth state was not returned for the session"
                verifier = pending.get("code_verifier")
                assert verifier, "the PKCE code_verifier was not returned for the session"

                # The callback must rebuild a flow carrying that same verifier.
                flow = service.google._flow(state=pending["state"])
                flow.code_verifier = verifier
                assert flow.code_verifier == verifier

                # It must NOT be written to the store: sign-in happens before
                # we know the account, and a shared row would let two people
                # signing in at once clobber each other.
                assert service.store.get(OAUTH_STATE_KEY) is None, (
                    "the OAuth state leaked into the store instead of the session"
                )

                # A missing/garbled session must fail cleanly, not explode.
                try:
                    service.google.finish_auth("http://x/?code=abc&state=zzz", "zzz", None)
                except Exception as exc:  # noqa: BLE001
                    assert "GoogleAuthError" in type(exc).__name__ or "Could not" in str(exc), exc
                service.shutdown()
            finally:
                settings.google_client_id, settings.google_client_secret = original
        return "challenge sent, verifier persisted and restored"

    @check("Accounts are isolated from each other")
    def _():
        # The whole point of multi-tenancy: one account must never be able to
        # see, edit or delete another's rows.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "tenants.db"
            root = MeetManagerService(settings)

            alice = root.store.upsert_user(email="alice@example.com")
            bob = root.store.upsert_user(email="bob@example.com")
            assert alice["id"] != bob["id"]
            assert root.store.upsert_user(email="ALICE@example.com")["id"] == alice["id"], (
                "e-mail matching must be case-insensitive, or a user gets a second account"
            )

            a = root.for_user(alice["id"])
            b = root.for_user(bob["id"])

            a.load_demo()
            a_task = a.create_task({"title": "Alice's private task"})["task"]
            b_task = b.create_task({"title": "Bob's private task"})["task"]

            # Data
            assert a.store.event_count() > 0 and b.store.event_count() == 0, "events leaked between accounts"
            assert [t.title for t in b.tasks()] == ["Bob's private task"], [t.title for t in b.tasks()]
            assert b.store.get_task(a_task["id"]) is None, "Bob can read Alice's task"

            # Writes
            assert not b.update_task(a_task["id"], {"title": "hijacked"})["ok"], "Bob edited Alice's task"
            assert not b.delete_task(a_task["id"])["ok"], "Bob deleted Alice's task"
            assert a.store.get_task(a_task["id"]).title == "Alice's private task"

            # Credentials and preferences
            a.store.set("google_token", {"token": "alice-secret"})
            assert b.store.get("google_token") is None, "Bob can read Alice's Google token"
            a.update_prefs({"buffer_minutes": 45})
            assert b.prefs()["buffer_minutes"] != 45, "preferences leaked between accounts"

            # Notifications
            a.scan_reminders()
            assert len(a.notifications()) > 0
            assert len(b.notifications()) == 0, "notifications leaked between accounts"

            # Deleting an account takes its data with it and leaves Bob alone.
            root.store.delete_user(alice["id"])
            assert root.store.get_user(alice["id"]) is None
            assert root.for_user(alice["id"]).store.event_count() == 0
            assert b.store.get_task(b_task["id"]) is not None, "deleting Alice removed Bob's data"
            root.shutdown()
        return "events, tasks, tokens, preferences and alerts all isolated"

    @check("Mailbox switching cannot be forged")
    def _():
        # The switcher must only ever offer accounts that completed a sign-in
        # in *this* browser session; otherwise knowing an id would be enough
        # to read someone else's calendar.
        import base64
        import json as _json

        from itsdangerous import TimestampSigner

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "switch.db"
            # app.main holds a module-level service bound to whatever db_path
            # was current at import. Reload it so each check gets its own,
            # instead of inheriting one a previous check already shut down.
            import importlib

            import app.main as app_main
            from fastapi.testclient import TestClient

            app_main = importlib.reload(app_main)
            app = app_main.app
            app_service = app_main.service
            _session_secret = app_main._session_secret

            def cookie(session: dict) -> str:
                blob = base64.b64encode(_json.dumps(session).encode())
                return TimestampSigner(_session_secret()).sign(blob).decode()

            def sign_in(client, session: dict) -> None:
                # Clear first: httpx appends rather than replaces, and the
                # server would then read whichever cookie came first.
                client.cookies.clear()
                client.cookies.set("mm_session", cookie(session))

            with TestClient(app) as client:
                mine = app_service.store.upsert_user(email="mine@example.com")
                other = app_service.store.upsert_user(email="victim@example.com")
                app_service.for_user(other["id"]).create_task({"title": "Victim's task"})

                # Signed in only as `mine`.
                sign_in(client, {"uid": mine["id"], "accounts": [mine["id"]]})

                listed = client.get("/api/accounts").json()["accounts"]
                assert [a["email"] for a in listed] == ["mine@example.com"], listed
                assert listed[0]["active"] is True

                # Switching to an account never authenticated here must fail...
                res = client.post("/api/accounts/switch", json={"id": other["id"]})
                assert res.status_code == 403, f"forged switch returned {res.status_code}"
                # ...and must not have changed who we are.
                assert client.get("/api/me").json()["user"]["email"] == "mine@example.com"
                assert not any(t["title"] == "Victim's task" for t in client.get("/api/tasks").json()["tasks"])

                # A genuine multi-account session can switch freely.
                sign_in(client, {"uid": mine["id"], "accounts": [mine["id"], other["id"]]})
                assert client.post("/api/accounts/switch", json={"id": other["id"]}).json()["ok"]
                assert client.get("/api/me").json()["user"]["email"] == "victim@example.com"

                # Forgetting the only remaining account signs the browser out.
                sign_in(client, {"uid": mine["id"], "accounts": [mine["id"]]})
                gone = client.post("/api/accounts/forget", json={"id": mine["id"]})
                assert gone.json()["signed_out"], gone.json()
                # The browser must be told to drop the cookie. (Asserted on the
                # header rather than a follow-up request: a cookie set by hand
                # on the test client carries no domain, so httpx's jar ignores
                # the server's scoped deletion.)
                assert "01 Jan 1970" in (gone.headers.get("set-cookie") or ""), (
                    "sign-out did not clear the session cookie"
                )
                client.cookies.clear()
                assert client.get("/api/state").status_code == 401
                # ...but the data is kept for next time.
                assert app_service.store.get_user(mine["id"]) is not None
        return "forged switch refused, genuine switch allowed, forget signs out"

    @check("HTTP API responds")
    def _():
        import base64
        import json as _json

        from itsdangerous import TimestampSigner

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            settings.db_path = Path(tmp) / "api.db"
            # app.main holds a module-level service bound to whatever db_path
            # was current at import. Reload it so each check gets its own,
            # instead of inheriting one a previous check already shut down.
            import importlib

            import app.main as app_main
            from fastapi.testclient import TestClient

            app_main = importlib.reload(app_main)
            app = app_main.app
            app_service = app_main.service
            _session_secret = app_main._session_secret

            def sign_in_as(client, email):
                user = app_service.store.upsert_user(email=email)
                payload = base64.b64encode(_json.dumps({"uid": user["id"]}).encode())
                client.cookies.set("mm_session", TimestampSigner(_session_secret()).sign(payload).decode())
                return user

            with TestClient(app) as client:
                assert client.get("/healthz").json()["ok"]

                # Unauthenticated: the app must not hand over any data.
                for path in ("/api/state", "/api/tasks", "/api/notifications", "/api/preferences"):
                    assert client.get(path).status_code == 401, f"{path} served data without a session"
                assert client.post("/api/sync").status_code == 401
                page = client.get("/")
                assert page.status_code == 200 and "Continue with Google" in page.text, (
                    "an anonymous visitor must get the sign-in page, not the dashboard"
                )

                sign_in_as(client, "api@example.com")
                assert client.get("/api/me").json()["user"]["email"] == "api@example.com"
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

