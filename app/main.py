"""FastAPI application: HTML shell + JSON API.

Every endpoint returns a structured payload and traps its own exceptions, so a
transient Google/API hiccup surfaces as a friendly banner in the UI rather than
a stack trace or a 500 page.

AUTH
----
Every data route is bound to the signed-in account. `_service_for(request)`
resolves the session cookie to a user and hands back a service scoped to them;
there is no code path that reads data without going through it.
"""

from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from . import __version__
from .config import settings
from .google_client import GoogleAuthError
from .service import MeetManagerService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
for noisy in ("apscheduler.executors.default", "apscheduler.scheduler", "googleapiclient.discovery_cache"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

log = logging.getLogger("meetmanager")

APP_DIR = Path(__file__).resolve().parent
service = MeetManagerService(settings)

SESSION_USER_KEY = "uid"
SESSION_OAUTH_KEY = "oauth_pending"
SECRET_KV_KEY = "session_secret"


def _session_secret() -> str:
    """Prefer the configured secret; otherwise persist a generated one.

    Persisting matters: a fresh secret on every boot would sign everyone out
    on each restart. On a host with an ephemeral disk that happens anyway,
    which is exactly why SECRET_KEY is worth setting in production.
    """
    if settings.secret_key:
        return settings.secret_key
    stored = service.store.get(SECRET_KV_KEY)
    if isinstance(stored, str) and len(stored) >= 32:
        return stored
    generated = secrets.token_urlsafe(48)
    service.store.set(SECRET_KV_KEY, generated)
    return generated


@asynccontextmanager
async def lifespan(app: FastAPI):
    service.start()
    log.info("MeetManager v%s ready at %s", __version__, settings.base_url)
    log.info("Accounts registered: %d", len(service.store.all_users()))
    try:
        yield
    finally:
        service.shutdown()


app = FastAPI(title="MeetManager", version=__version__, lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret(),
    session_cookie="mm_session",
    https_only=settings.base_url.startswith("https://"),
    same_site="lax",
    max_age=60 * 60 * 24 * 30,
)
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))


def ok(**payload: Any) -> JSONResponse:
    return JSONResponse({"ok": True, **payload})


def fail(message: str, *, status: int = 200, **payload: Any) -> JSONResponse:
    return JSONResponse({"ok": False, "message": message, **payload}, status_code=status)


def _parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Auth plumbing
# ---------------------------------------------------------------------------
def current_user(request: Request) -> dict[str, Any] | None:
    user_id = request.session.get(SESSION_USER_KEY)
    if not user_id:
        return None
    user = service.store.get_user(user_id)
    if user is None:
        # The account was removed underneath the cookie.
        request.session.pop(SESSION_USER_KEY, None)
        return None
    return user


class NotSignedIn(Exception):
    pass


def _service_for(request: Request) -> tuple[MeetManagerService, dict[str, Any]]:
    """The only way data routes reach a store. Raises if not signed in."""
    user = current_user(request)
    if user is None:
        raise NotSignedIn()
    return service.for_user(user["id"]), user


def _auth_required() -> JSONResponse:
    return JSONResponse(
        {"ok": False, "auth_required": True, "message": "Please sign in to continue."},
        status_code=401,
    )


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    user = current_user(request)
    if user is None:
        return templates.TemplateResponse(
            request, "signin.html", {"version": __version__, "error": request.query_params.get("auth_error", "")}
        )
    service.store.touch_user(user["id"])
    scoped = service.for_user(user["id"])
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "version": __version__,
            "owner_email": user["email"],
            "user_name": user.get("name") or user["email"].split("@")[0],
            "reminder_minutes": scoped.reminder_minutes,
            "timezone": scoped.tz.key,
        },
    )


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return ok(version=__version__, users=len(service.store.all_users()))


@app.get("/api/me")
async def api_me(request: Request) -> JSONResponse:
    user = current_user(request)
    if user is None:
        return _auth_required()
    return ok(user={"id": user["id"], "email": user["email"], "name": user.get("name", "")})


# ---------------------------------------------------------------------------
# State + data
# ---------------------------------------------------------------------------
@app.get("/api/state")
async def api_state(request: Request, day: str | None = Query(default=None)) -> JSONResponse:
    try:
        svc, user = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        state = svc.state(timeline_date=_parse_date(day))
        state["user"] = {"id": user["id"], "email": user["email"], "name": user.get("name", "")}
        return ok(state=state)
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to build state")
        return fail(f"Could not build the dashboard: {exc}")


@app.get("/api/timeline")
async def api_timeline(request: Request, day: str | None = Query(default=None)) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return ok(timeline=svc.timeline(_parse_date(day)))
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to build timeline")
        return fail(f"Could not build the timeline: {exc}")


@app.get("/api/recommendations")
async def api_recommendations(
    request: Request,
    duration: int = Query(default=30, ge=5, le=480),
    days: int = Query(default=10, ge=1, le=60),
    limit: int = Query(default=8, ge=1, le=30),
) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        slots = svc.recommendations(duration_minutes=duration, horizon_days=days, limit=limit)
        message = (
            "No free slot matches those constraints - try a shorter meeting, a "
            "longer horizon, or widen your working hours."
            if not slots
            else f"Found {len(slots)} candidate slots."
        )
        return ok(recommendations=slots, message=message)
    except Exception as exc:  # noqa: BLE001
        log.exception("Recommendation failed")
        return fail(f"Could not compute recommendations: {exc}", recommendations=[])


@app.post("/api/sync")
async def api_sync(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    return JSONResponse(svc.sync())


@app.post("/api/demo/load")
async def api_demo_load(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.load_demo())
    except Exception as exc:  # noqa: BLE001
        log.exception("Demo load failed")
        return fail(f"Could not load demo data: {exc}")


@app.post("/api/data/clear")
async def api_clear(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.clear_all())
    except Exception as exc:  # noqa: BLE001
        log.exception("Clear failed")
        return fail(f"Could not clear data: {exc}")


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------
@app.get("/api/tasks")
async def api_tasks(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return ok(tasks=svc.task_views(), stats=svc.task_stats(), sources=svc.task_sources())
    except Exception as exc:  # noqa: BLE001
        log.exception("Task list failed")
        return fail(f"Could not load your tasks: {exc}", tasks=[])


@app.post("/api/tasks")
async def api_task_create(request: Request, payload: dict[str, Any]) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.create_task(payload or {}))
    except Exception as exc:  # noqa: BLE001
        log.exception("Task create failed")
        return fail(f"Could not add that task: {exc}")


@app.post("/api/tasks/sync")
async def api_task_sync(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.sync_tasks())
    except Exception as exc:  # noqa: BLE001
        log.exception("Task sync failed")
        return fail(f"Could not sync tasks: {exc}")


@app.post("/api/tasks/{task_id}")
async def api_task_update(request: Request, task_id: str, payload: dict[str, Any]) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.update_task(task_id, payload or {}))
    except Exception as exc:  # noqa: BLE001
        log.exception("Task update failed")
        return fail(f"Could not update that task: {exc}")


@app.post("/api/tasks/{task_id}/toggle")
async def api_task_toggle(request: Request, task_id: str) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.toggle_task(task_id))
    except Exception as exc:  # noqa: BLE001
        log.exception("Task toggle failed")
        return fail(f"Could not update that task: {exc}")


@app.delete("/api/tasks/{task_id}")
async def api_task_delete(request: Request, task_id: str) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return JSONResponse(svc.delete_task(task_id))
    except Exception as exc:  # noqa: BLE001
        log.exception("Task delete failed")
        return fail(f"Could not delete that task: {exc}")


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------
@app.get("/api/notifications")
async def api_notifications(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        svc.scan_reminders()
        return ok(notifications=svc.notifications())
    except Exception as exc:  # noqa: BLE001
        log.exception("Notification fetch failed")
        return fail(f"Could not load notifications: {exc}", notifications=[])


@app.post("/api/notifications/seen")
async def api_notifications_seen(request: Request, payload: dict[str, Any]) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        svc.store.mark_seen(payload.get("ids") or [])
        return ok()
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


@app.post("/api/notifications/{notification_id}/dismiss")
async def api_notification_dismiss(request: Request, notification_id: int) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        svc.store.dismiss_notification(notification_id)
        return ok()
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


@app.post("/api/notifications/dismiss-all")
async def api_notifications_dismiss_all(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        svc.store.dismiss_all()
        return ok()
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------
@app.get("/api/preferences")
async def api_get_preferences(request: Request) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    return ok(preferences=svc.prefs())


@app.post("/api/preferences")
async def api_set_preferences(request: Request, payload: dict[str, Any]) -> JSONResponse:
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        return ok(preferences=svc.update_prefs(payload or {}), message="Preferences saved.")
    except Exception as exc:  # noqa: BLE001
        log.exception("Preference update failed")
        return fail(f"Could not save your settings: {exc}")


# ---------------------------------------------------------------------------
# Google OAuth - doubles as sign-in
# ---------------------------------------------------------------------------
@app.get("/auth/login", response_model=None)
async def auth_login(request: Request) -> RedirectResponse:
    try:
        # Unbound client: no account exists yet on a first sign-in.
        url, pending = service.google.authorization_url(
            login_hint=(current_user(request) or {}).get("email")
        )
        request.session[SESSION_OAUTH_KEY] = pending
        return RedirectResponse(url, status_code=307)
    except GoogleAuthError as exc:
        return RedirectResponse(f"/?auth_error={_quote(str(exc))}", status_code=307)
    except Exception as exc:  # noqa: BLE001
        log.exception("Auth start failed")
        return RedirectResponse(f"/?auth_error={_quote(str(exc))}", status_code=307)


@app.get("/auth/callback")
async def auth_callback(request: Request) -> RedirectResponse:
    error = request.query_params.get("error")
    if error:
        return RedirectResponse(f"/?auth_error={_quote(error)}", status_code=307)

    pending = request.session.pop(SESSION_OAUTH_KEY, None)
    try:
        # Exchange on the unbound client, then read who just signed in.
        service.google.finish_auth(
            authorization_response=str(request.url),
            state=request.query_params.get("state"),
            pending=pending,
        )
        profile = service.google.profile() or {}
        email = (profile.get("email") or "").strip().lower()
        if not email:
            raise GoogleAuthError("Google did not return an e-mail address for this account.")

        user = service.store.upsert_user(email=email, name=email.split("@")[0])

        # Move the freshly minted credentials from system scope onto the user.
        scoped = service.for_user(user["id"])
        scoped.google.adopt_credentials_from(service.google)
        service.google.forget_credentials()

        request.session[SESSION_USER_KEY] = user["id"]
    except GoogleAuthError as exc:
        return RedirectResponse(f"/?auth_error={_quote(str(exc))}", status_code=307)
    except Exception as exc:  # noqa: BLE001
        log.exception("Auth callback failed")
        return RedirectResponse(f"/?auth_error={_quote(str(exc))}", status_code=307)

    result = scoped.sync()
    flag = "connected" if result.get("ok") else "connected_sync_failed"
    return RedirectResponse(f"/?auth={flag}", status_code=307)


@app.post("/auth/logout")
async def auth_logout(request: Request) -> JSONResponse:
    """Disconnect Google for this account, but stay signed in."""
    try:
        svc, _ = _service_for(request)
    except NotSignedIn:
        return _auth_required()
    try:
        svc.google.disconnect()
        return ok(message="Disconnected from Google Calendar.")
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


@app.post("/auth/signout")
async def auth_signout(request: Request) -> JSONResponse:
    """End the browser session. Data is kept for the next sign-in."""
    request.session.clear()
    return ok(message="Signed out.")


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value[:300], safe="")


# ---------------------------------------------------------------------------
# Global safety net
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        {"ok": False, "message": "Something went wrong, but the app is still running.", "detail": str(exc)},
        status_code=200,
    )
