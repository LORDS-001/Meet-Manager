"""Entry point.

    python run.py

Starts the MeetManager web server and opens your browser.
"""

from __future__ import annotations

import sys
import threading
import webbrowser


def main() -> int:
    try:
        import uvicorn
    except ImportError:
        print("Dependencies are missing. Install them first:\n")
        print("    python -m pip install -r requirements.txt\n")
        return 1

    from app.config import settings

    url = f"http://{settings.host}:{settings.port}"

    print()
    print("  MeetManager")
    print("  " + "-" * 46)
    print(f"  Mailbox   : {settings.owner_email}")
    print(f"  Timezone  : {settings.timezone}")
    print(f"  Reminders : {settings.reminder_minutes} minutes before each meeting")
    print(f"  URL       : {url}")
    print("  " + "-" * 46)
    print("  Press CTRL+C to stop.")
    print()

    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload="--reload" in sys.argv,
        log_level="info",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
