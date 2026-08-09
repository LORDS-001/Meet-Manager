"""FastAPI application: HTML shell + JSON API.

Every endpoint returns a structured payload and traps its own exceptions, so a
transient Google/API hiccup surfaces as a friendly banner in the UI rather than
a stack trace or a 500 page.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    service.start()
    log.info("MeetManager v%s ready at http://%s:%s", __version__, settings.host, settings.port)
    log.info("Managing mailbox: %s", settings.owner_email)
    if not service.google.is_connected():
        log.info("Google Calendar not connected yet - the UI will offer demo data.")
    try:
        yield
    finally:
        service.shutdown()


app = FastAPI(title="MeetManager", version=__version__, lifespan=lifespan)
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
# Pages
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "version": __version__,
            "owner_email": settings.owner_email,
            "reminder_minutes": service.reminder_minutes,
            "timezone": service.tz.key,
        },
    )


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return ok(version=__version__, events=service.store.event_count())


# ---------------------------------------------------------------------------
# State + data
# ---------------------------------------------------------------------------
@app.get("/api/state")
async def api_state(day: str | None = Query(default=None)) -> JSONResponse:
    try:
        return ok(state=service.state(timeline_date=_parse_date(day)))
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to build state")
        return fail(f"Could not build the dashboard: {exc}")


@app.get("/api/timeline")
async def api_timeline(day: str | None = Query(default=None)) -> JSONResponse:
    try:
        return ok(timeline=service.timeline(_parse_date(day)))
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to build timeline")
        return fail(f"Could not build the timeline: {exc}")


@app.get("/api/recommendations")
async def api_recommendations(
    duration: int = Query(default=30, ge=5, le=480),
    days: int = Query(default=10, ge=1, le=60),
    limit: int = Query(default=8, ge=1, le=30),
) -> JSONResponse:
    try:
        slots = service.recommendations(duration_minutes=duration, horizon_days=days, limit=limit)
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
async def api_sync() -> JSONResponse:
    result = service.sync()
    return JSONResponse(result)


@app.post("/api/demo/load")
async def api_demo_load() -> JSONResponse:
    try:
        return JSONResponse(service.load_demo())
    except Exception as exc:  # noqa: BLE001
        log.exception("Demo load failed")
        return fail(f"Could not load demo data: {exc}")


@app.post("/api/data/clear")
async def api_clear() -> JSONResponse:
    try:
        return JSONResponse(service.clear_all())
    except Exception as exc:  # noqa: BLE001
        log.exception("Clear failed")
        return fail(f"Could not clear data: {exc}")


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------
@app.get("/api/notifications")
async def api_notifications() -> JSONResponse:
    try:
        service.scan_reminders()
        return ok(notifications=service.notifications())
    except Exception as exc:  # noqa: BLE001
        log.exception("Notification fetch failed")
        return fail(f"Could not load notifications: {exc}", notifications=[])


@app.post("/api/notifications/seen")
async def api_notifications_seen(payload: dict[str, Any]) -> JSONResponse:
    try:
        service.store.mark_seen(payload.get("ids") or [])
        return ok()
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


@app.post("/api/notifications/{notification_id}/dismiss")
async def api_notification_dismiss(notification_id: int) -> JSONResponse:
    try:
        service.store.dismiss_notification(notification_id)
        return ok()
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


@app.post("/api/notifications/dismiss-all")
async def api_notifications_dismiss_all() -> JSONResponse:
    try:
        service.store.dismiss_all()
        return ok()
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------
@app.get("/api/preferences")
async def api_get_preferences() -> JSONResponse:
    return ok(preferences=service.prefs())


@app.post("/api/preferences")
async def api_set_preferences(payload: dict[str, Any]) -> JSONResponse:
    try:
        prefs = service.update_prefs(payload or {})
        return ok(preferences=prefs, message="Preferences saved.")
    except Exception as exc:  # noqa: BLE001
        log.exception("Preference update failed")
        return fail(f"Could not save preferences: {exc}")


# ---------------------------------------------------------------------------
# Google OAuth
# ---------------------------------------------------------------------------
@app.get("/auth/login", response_model=None)
async def auth_login() -> RedirectResponse:
    try:
        return RedirectResponse(service.google.authorization_url(), status_code=307)
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
    try:
        service.google.finish_auth(
            authorization_response=str(request.url),
            state=request.query_params.get("state"),
        )
    except GoogleAuthError as exc:
        return RedirectResponse(f"/?auth_error={_quote(str(exc))}", status_code=307)
    except Exception as exc:  # noqa: BLE001
        log.exception("Auth callback failed")
        return RedirectResponse(f"/?auth_error={_quote(str(exc))}", status_code=307)

    result = service.sync()
    flag = "connected" if result.get("ok") else "connected_sync_failed"
    return RedirectResponse(f"/?auth={flag}", status_code=307)


@app.post("/auth/logout")
async def auth_logout() -> JSONResponse:
    try:
        service.google.disconnect()
        return ok(message="Disconnected from Google Calendar.")
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


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
