"""Print a signed session cookie for a throwaway test account.

The browser suites cannot complete a real Google OAuth round trip, so they
sign in the same way the app does - by presenting a session cookie - minted
here with the server's own secret.

    python tests/ui/mint_session.py            # prints the cookie value

Reads SECRET_KEY if set; otherwise the secret the server generated and
persisted in the store, so it works either way.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from itsdangerous import TimestampSigner  # noqa: E402

from app.config import settings  # noqa: E402
from app.store import Store  # noqa: E402

email = os.environ.get("MM_TEST_EMAIL", "ui-test@example.com")

store = Store(settings.db_path)
try:
    user = store.upsert_user(email=email, name="UI Test")
    secret = os.environ.get("SECRET_KEY") or store.get("session_secret")
    if not secret:
        raise SystemExit(
            "No session secret available. Start the server once so it can "
            "generate one, or set SECRET_KEY."
        )
    payload = base64.b64encode(json.dumps({"uid": user["id"]}).encode())
    print(TimestampSigner(secret).sign(payload).decode())
finally:
    store.close()
