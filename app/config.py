"""Configuration loading.

Everything has a working default so the application can boot with no .env file
at all.  Values read from the environment always win.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(BASE_DIR / ".env")


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _parse_time(raw: str, default: time) -> time:
    try:
        hours, _, minutes = raw.partition(":")
        return time(int(hours), int(minutes or 0))
    except (ValueError, TypeError):
        return default


def _parse_days(raw: str, default: tuple[int, ...]) -> tuple[int, ...]:
    days: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            day = int(chunk)
        except ValueError:
            continue
        if 0 <= day <= 6:
            days.append(day)
    return tuple(sorted(set(days))) or default


def _safe_timezone(name: str) -> str:
    """Return `name` if it is a real IANA zone, otherwise a sensible fallback."""
    if name and name in available_timezones():
        return name
    return "UTC"


@dataclass
class Settings:
    owner_email: str = field(default_factory=lambda: _env("OWNER_EMAIL", "adedokundaniel16@gmail.com"))
    host: str = field(default_factory=lambda: _env("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("PORT", 8000))
    timezone: str = field(default_factory=lambda: _safe_timezone(_env("TIMEZONE", "Africa/Lagos")))

    google_client_id: str = field(default_factory=lambda: _env("GOOGLE_CLIENT_ID"))
    google_client_secret: str = field(default_factory=lambda: _env("GOOGLE_CLIENT_SECRET"))
    google_credentials_file: str = field(default_factory=lambda: _env("GOOGLE_CREDENTIALS_FILE", "credentials.json"))

    reminder_minutes: int = field(default_factory=lambda: _env_int("REMINDER_MINUTES", 30))
    sync_days_ahead: int = field(default_factory=lambda: _env_int("SYNC_DAYS_AHEAD", 30))
    sync_interval_seconds: int = field(default_factory=lambda: _env_int("SYNC_INTERVAL_SECONDS", 300))

    smtp_host: str = field(default_factory=lambda: _env("SMTP_HOST", "smtp.gmail.com"))
    smtp_port: int = field(default_factory=lambda: _env_int("SMTP_PORT", 587))
    smtp_user: str = field(default_factory=lambda: _env("SMTP_USER"))
    smtp_password: str = field(default_factory=lambda: _env("SMTP_PASSWORD"))
    smtp_to: str = field(default_factory=lambda: _env("SMTP_TO"))

    work_start: time = field(default_factory=lambda: _parse_time(_env("WORK_START", "09:00"), time(9, 0)))
    work_end: time = field(default_factory=lambda: _parse_time(_env("WORK_END", "17:30"), time(17, 30)))
    work_days: tuple[int, ...] = field(default_factory=lambda: _parse_days(_env("WORK_DAYS", "0,1,2,3,4"), (0, 1, 2, 3, 4)))
    buffer_minutes: int = field(default_factory=lambda: _env_int("BUFFER_MINUTES", 10))

    db_path: Path = field(default_factory=lambda: DATA_DIR / "meetmanager.db")

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def redirect_uri(self) -> str:
        return f"http://{self.host}:{self.port}/auth/callback"

    @property
    def credentials_path(self) -> Path:
        raw = Path(self.google_credentials_file)
        return raw if raw.is_absolute() else BASE_DIR / raw

    @property
    def email_reminders_enabled(self) -> bool:
        return bool(self.smtp_user and self.smtp_password and (self.smtp_to or self.owner_email))

    @property
    def email_recipient(self) -> str:
        return self.smtp_to or self.owner_email


settings = Settings()
