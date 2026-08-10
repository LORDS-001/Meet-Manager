"""Google Calendar integration.

Handles the OAuth 2.0 web flow, persists the refresh token in the store, and
normalises Google's event payloads into our `Event` model.

Everything in this module degrades gracefully: if the Google libraries are not
installed, or no client credentials are configured, `is_configured()` returns
False and the rest of the application carries on in demo mode.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import Settings
from .models import Event, parse_dt
from .store import Store

log = logging.getLogger("meetmanager.google")

# Allow http://127.0.0.1 redirect URIs and tolerate Google adding the
# openid/userinfo scopes to the ones we requested.
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    # Read-only: tasks are mirrored here and edited in Google Tasks.
    # NOTE: adding this scope invalidates existing consent - anyone already
    # connected has to reconnect once to grant it.
    "https://www.googleapis.com/auth/tasks.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
]

TOKEN_KEY = "google_token"
PROFILE_KEY = "google_profile"
OAUTH_STATE_KEY = "google_oauth_state"

# Calendars that are pure noise for meeting management.
_IGNORED_CALENDAR_SUFFIXES = (
    "#holiday@group.v.calendar.google.com",
    "#contacts@group.v.calendar.google.com",
    "#weeknum@group.v.calendar.google.com",
)

try:  # pragma: no cover - import guard
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2 import id_token as google_id_token
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    GOOGLE_LIBS_AVAILABLE = True
    GOOGLE_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - only hit when deps missing
    GOOGLE_LIBS_AVAILABLE = False
    GOOGLE_IMPORT_ERROR = str(exc)
    GoogleRequest = Credentials = Flow = build = None  # type: ignore[assignment]
    google_id_token = None  # type: ignore[assignment]

    class HttpError(Exception):  # type: ignore[no-redef]
        pass


class GoogleAuthError(RuntimeError):
    """Raised for any recoverable problem in the OAuth / API path."""


class GoogleCalendarClient:
    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store

    # ------------------------------------------------------------- discovery
    def client_config(self) -> dict[str, Any] | None:
        """Build an OAuth client config from env vars or credentials.json."""
        client_id = self.settings.google_client_id
        client_secret = self.settings.google_client_secret

        if not (client_id and client_secret):
            path = self.settings.credentials_path
            if path.exists():
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError) as exc:
                    log.warning("Could not read %s: %s", path, exc)
                    return None
                block = raw.get("web") or raw.get("installed") or {}
                client_id = block.get("client_id", "")
                client_secret = block.get("client_secret", "")

        if not (client_id and client_secret):
            return None

        return {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [self.settings.redirect_uri],
            }
        }

    def is_configured(self) -> bool:
        return GOOGLE_LIBS_AVAILABLE and self.client_config() is not None

    def is_connected(self) -> bool:
        return bool(self.is_configured() and self.store.get(TOKEN_KEY))

    def profile(self) -> dict[str, Any]:
        return self.store.get(PROFILE_KEY, {}) or {}

    def setup_hint(self) -> str:
        if not GOOGLE_LIBS_AVAILABLE:
            return (
                "Google API libraries are not installed. Run: "
                "pip install -r requirements.txt"
            )
        if self.client_config() is None:
            return (
                "No Google OAuth client found. Add GOOGLE_CLIENT_ID and "
                "GOOGLE_CLIENT_SECRET to your .env file, or drop credentials.json "
                "into the project folder. See README.md for the 5-minute setup."
            )
        if not self.is_connected():
            return "Ready to connect - click 'Connect Google Calendar'."
        return "Connected."

    # ------------------------------------------------------------- oauth flow
    def _flow(self, state: str | None = None):
        config = self.client_config()
        if config is None:
            raise GoogleAuthError(self.setup_hint())
        return Flow.from_client_config(
            config,
            scopes=SCOPES,
            redirect_uri=self.settings.redirect_uri,
            state=state,
        )

    def authorization_url(
        self, login_hint: str | None = None, force_select: bool = False
    ) -> tuple[str, dict[str, Any]]:
        """Return (url, pending) where `pending` must be stashed by the caller.

        It goes in the browser session rather than the store: sign-in happens
        before we know which account is arriving, so there is no owner to scope
        it to, and two people signing in at once would otherwise collide on a
        single shared row.

        `pending` carries the PKCE code_verifier. google-auth-oauthlib >= 1.1
        generates one here and sends its challenge to Google; the callback
        builds a *new* Flow, so without carrying it across the token exchange
        fails with "Missing code verifier".
        """
        flow = self._flow()
        params: dict[str, Any] = {
            "access_type": "offline",
            "include_granted_scopes": "true",
            # select_account makes Google show its chooser instead of silently
            # reusing the session's current account - required for adding a
            # second mailbox.
            "prompt": "select_account consent" if force_select else "consent",
        }
        if not force_select and login_hint:
            # Only ever hint an address this session is already signed in as.
            # Falling back to a configured address would greet every stranger
            # on the sign-in page with somebody else's e-mail filled in.
            params["login_hint"] = login_hint

        url, state = flow.authorization_url(**params)
        return url, {"state": state, "code_verifier": getattr(flow, "code_verifier", None)}

    def finish_auth(
        self,
        authorization_response: str,
        state: str | None,
        pending: dict[str, Any] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Exchange the code, returning (verified address, token blob).

        Deliberately persists nothing. Sign-in happens before we know whose
        account this is, so the only place to park a token would be the shared
        ownerless row - and two people finishing sign-in at the same moment
        would overwrite it for each other, handing one of them the other's
        calendar. Returning it means it goes straight to its owner instead.
        """
        pending = pending if isinstance(pending, dict) else {}
        expected = pending.get("state")
        verifier = pending.get("code_verifier")

        if expected and state and expected != state:
            raise GoogleAuthError("OAuth state mismatch - please start the sign-in again.")

        flow = self._flow(state=expected or state)
        if verifier:
            flow.code_verifier = verifier

        try:
            flow.fetch_token(authorization_response=authorization_response)
        except Exception as exc:  # oauthlib raises many different types
            message = str(exc)
            if "code verifier" in message.lower():
                message = (
                    "The sign-in could not be completed because the security "
                    "code from the first step was lost. Please click Connect "
                    "and try again."
                )
            raise GoogleAuthError(f"Could not complete Google sign-in: {message}") from exc

        creds = flow.credentials
        return self._verify_identity(creds), self._credentials_blob(creds)

    def _verify_identity(self, creds) -> str:
        """The address that just signed in, from the signed OpenID token.

        This is the one value sign-in must never guess. It decides which
        account the new token is filed under, so a wrong answer files one
        person's calendar under another person's account. The ID token is
        signed by Google and verified against our own client id, so it either
        yields the true address or raises - there is deliberately no fallback
        to a configured address, which would silently hand the session to
        whoever that address belongs to.
        """
        raw = getattr(creds, "id_token", None)
        if not raw or google_id_token is None:
            raise GoogleAuthError(
                "Google did not return a verifiable identity for this account. "
                "Please try signing in again."
            )
        config = self.client_config() or {}
        audience = (config.get("web") or {}).get("client_id") or None
        try:
            claims = google_id_token.verify_oauth2_token(
                raw,
                GoogleRequest(),
                audience,
                # Small tolerance: a container whose clock is a few seconds
                # behind Google's would otherwise reject a valid token.
                clock_skew_in_seconds=10,
            )
        except Exception as exc:  # noqa: BLE001 - any failure means "not proven"
            raise GoogleAuthError(
                f"Could not verify who signed in: {exc}"
            ) from exc

        email = (claims.get("email") or "").strip().lower()
        if not email:
            raise GoogleAuthError("Google did not return an e-mail address for this account.")
        if claims.get("email_verified") is False:
            raise GoogleAuthError(
                "That Google account's e-mail address is not verified, so it "
                "cannot be used to sign in."
            )
        return email

    def adopt_token(self, blob: dict[str, Any], email: str) -> None:
        """Install a freshly exchanged token onto this (user-scoped) client.

        The token goes from the sign-in exchange straight to its owner, so it
        is never readable through a row that belongs to nobody.
        """
        self.store.set(TOKEN_KEY, blob)
        self._refresh_profile(email=email)

    def disconnect(self) -> None:
        self.store.delete(TOKEN_KEY)
        self.store.delete(PROFILE_KEY)
        self.store.clear_events("google")
        self.store.clear_tasks("google_tasks")

    # ----------------------------------------------------------- credentials
    @staticmethod
    def _credentials_blob(creds) -> dict[str, Any]:
        return {
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": list(creds.scopes or SCOPES),
            "expiry": creds.expiry.isoformat() if creds.expiry else None,
        }

    def _save_credentials(self, creds) -> None:
        self.store.set(TOKEN_KEY, self._credentials_blob(creds))

    def _load_credentials(self):
        blob = self.store.get(TOKEN_KEY)
        if not blob:
            return None
        expiry = None
        if blob.get("expiry"):
            try:
                expiry = parse_dt(blob["expiry"]).replace(tzinfo=None)
            except (ValueError, TypeError):
                expiry = None
        creds = Credentials(
            token=blob.get("token"),
            refresh_token=blob.get("refresh_token"),
            token_uri=blob.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=blob.get("client_id"),
            client_secret=blob.get("client_secret"),
            scopes=blob.get("scopes") or SCOPES,
        )
        creds.expiry = expiry

        if not creds.valid and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
                self._save_credentials(creds)
            except Exception as exc:
                raise GoogleAuthError(
                    "Your Google session expired and could not be refreshed. "
                    "Please reconnect your calendar."
                ) from exc
        return creds

    def _service(self):
        creds = self._load_credentials()
        if creds is None:
            raise GoogleAuthError("Google Calendar is not connected yet.")
        return build("calendar", "v3", credentials=creds, cache_discovery=False)

    def _tasks_service(self):
        creds = self._load_credentials()
        if creds is None:
            raise GoogleAuthError("Google is not connected yet.")
        return build("tasks", "v1", credentials=creds, cache_discovery=False)

    def _refresh_profile(self, creds=None, email: str | None = None) -> dict[str, Any]:
        """Cache display details for the connected account.

        `email` comes from the verified ID token and is authoritative; the
        calendar lookup only enriches it with the account's timezone. If that
        lookup fails the profile is still correct, merely less specific -
        which is why nothing here falls back to a configured address.
        """
        profile: dict[str, Any] = {
            "email": (email or "").strip().lower(),
            "timezone": self.settings.timezone,
        }
        try:
            service = self._service()
            info = service.calendars().get(calendarId="primary").execute()
            profile["timezone"] = info.get("timeZone") or self.settings.timezone
            if not profile["email"]:
                profile["email"] = (info.get("id") or "").strip().lower()
        except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
            log.debug("Profile lookup failed: %s", exc)
        self.store.set(PROFILE_KEY, profile)
        return profile

    # ---------------------------------------------------------------- events
    def list_calendars(self) -> list[dict[str, Any]]:
        service = self._service()
        calendars: list[dict[str, Any]] = []
        page_token = None
        while True:
            response = service.calendarList().list(pageToken=page_token, maxResults=250).execute()
            for item in response.get("items", []):
                cal_id = item.get("id", "")
                if any(cal_id.endswith(suffix) for suffix in _IGNORED_CALENDAR_SUFFIXES):
                    continue
                if item.get("accessRole") == "freeBusyReader":
                    continue
                calendars.append(
                    {
                        "id": cal_id,
                        "name": item.get("summaryOverride") or item.get("summary") or cal_id,
                        "primary": bool(item.get("primary")),
                        "access_role": item.get("accessRole", "reader"),
                    }
                )
            page_token = response.get("nextPageToken")
            if not page_token:
                break
        if not calendars:
            calendars = [{"id": "primary", "name": "Primary", "primary": True, "access_role": "owner"}]
        return calendars

    def fetch_events(self, days_back: int = 1, days_ahead: int | None = None) -> list[Event]:
        days_ahead = days_ahead if days_ahead is not None else self.settings.sync_days_ahead
        service = self._service()
        now = datetime.now(timezone.utc)
        time_min = (now - timedelta(days=days_back)).isoformat()
        time_max = (now + timedelta(days=days_ahead)).isoformat()

        events: list[Event] = []
        for calendar in self.list_calendars():
            page_token = None
            while True:
                try:
                    response = (
                        service.events()
                        .list(
                            calendarId=calendar["id"],
                            timeMin=time_min,
                            timeMax=time_max,
                            singleEvents=True,
                            orderBy="startTime",
                            maxResults=250,
                            showDeleted=False,
                            pageToken=page_token,
                        )
                        .execute()
                    )
                except HttpError as exc:
                    log.warning("Skipping calendar %s: %s", calendar["id"], exc)
                    break

                for item in response.get("items", []):
                    event = self._normalise(item, calendar)
                    if event is not None:
                        events.append(event)

                page_token = response.get("nextPageToken")
                if not page_token:
                    break

        events.sort(key=lambda e: (e.start, e.end))
        return events

    # ----------------------------------------------------------------- tasks
    def fetch_tasks(self, include_completed: bool = True) -> list[Any]:
        """Every task across every Google Tasks list, normalised.

        A single failing list is skipped rather than losing the whole sync -
        shared or stale lists 404 fairly often.
        """
        from .tasks import normalise_google_task  # local import avoids a cycle

        service = self._tasks_service()
        tasks: list[Any] = []

        list_page = None
        while True:
            try:
                lists = service.tasklists().list(maxResults=100, pageToken=list_page).execute()
            except HttpError as exc:
                raise GoogleAuthError(f"Could not read your Google Tasks lists: {exc}") from exc

            for tasklist in lists.get("items", []):
                list_id = tasklist.get("id")
                list_name = tasklist.get("title") or "Tasks"
                if not list_id:
                    continue

                page_token = None
                while True:
                    try:
                        response = (
                            service.tasks()
                            .list(
                                tasklist=list_id,
                                maxResults=100,
                                showCompleted=include_completed,
                                showHidden=include_completed,
                                showDeleted=False,
                                pageToken=page_token,
                            )
                            .execute()
                        )
                    except HttpError as exc:
                        log.warning("Skipping task list %s: %s", list_name, exc)
                        break

                    for item in response.get("items", []):
                        task = normalise_google_task(item, list_name)
                        if task is not None:
                            tasks.append(task)

                    page_token = response.get("nextPageToken")
                    if not page_token:
                        break

            list_page = lists.get("nextPageToken")
            if not list_page:
                break

        return tasks

    def _normalise(self, item: dict[str, Any], calendar: dict[str, Any]) -> Event | None:
        start_block = item.get("start") or {}
        end_block = item.get("end") or {}
        all_day = "date" in start_block and "dateTime" not in start_block

        try:
            if all_day:
                start = parse_dt(start_block["date"])
                end = parse_dt(end_block.get("date", start_block["date"]))
                if end <= start:
                    end = start + timedelta(days=1)
            else:
                start = parse_dt(start_block["dateTime"])
                end = parse_dt(end_block.get("dateTime", start_block["dateTime"]))
                if end <= start:
                    end = start + timedelta(minutes=30)
        except (KeyError, ValueError, TypeError):
            return None

        organizer = item.get("organizer") or {}
        attendees = [
            {
                "email": att.get("email", ""),
                "name": att.get("displayName") or (att.get("email") or "").split("@")[0],
                "response": att.get("responseStatus", "needsAction"),
                "organizer": bool(att.get("organizer")),
                "self": bool(att.get("self")),
            }
            for att in item.get("attendees", [])
            if not att.get("resource")
        ]

        response_status = "accepted"
        for att in item.get("attendees", []):
            if att.get("self"):
                response_status = att.get("responseStatus", "accepted")
                break

        return Event(
            id=f"{calendar['id']}::{item.get('id', '')}::{start.isoformat()}",
            summary=item.get("summary") or "(no title)",
            start=start,
            end=end,
            calendar_id=calendar["id"],
            calendar_name=calendar["name"],
            description=(item.get("description") or "")[:2000],
            location=item.get("location") or "",
            all_day=all_day,
            html_link=item.get("htmlLink") or "",
            meet_link=self._extract_meet_link(item),
            organizer_email=organizer.get("email", ""),
            organizer_name=organizer.get("displayName") or organizer.get("email", ""),
            attendees=attendees,
            status=item.get("status", "confirmed"),
            response_status=response_status,
            source="google",
            recurring=bool(item.get("recurringEventId")),
        )

    @staticmethod
    def _extract_meet_link(item: dict[str, Any]) -> str:
        hangout = item.get("hangoutLink")
        if hangout:
            return hangout
        conference = item.get("conferenceData") or {}
        for entry in conference.get("entryPoints", []) or []:
            if entry.get("entryPointType") == "video" and entry.get("uri"):
                return entry["uri"]
        location = item.get("location") or ""
        if "meet.google.com" in location or "zoom.us" in location or "teams.microsoft" in location:
            return location.strip()
        return ""
