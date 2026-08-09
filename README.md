# MeetManager

[![CI](https://github.com/LORDS-001/Meet-Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/LORDS-001/Meet-Manager/actions/workflows/ci.yml)

A meeting manager for **adedokundaniel16@gmail.com**, written entirely in Python.

- **Backend** — FastAPI + SQLite + APScheduler. All the real work (timeline lane
  packing, conflict clustering, slot scoring) happens here and is sent to the
  browser as JSON.
- **Frontend** — a single-page app in vanilla JavaScript and CSS, served from the
  Jinja2 shell. No build step, no npm, no framework: `python run.py` is the whole
  toolchain.

## Interface

A monochrome dashboard where black is the primary colour and inverts to white in
dark mode, so buttons and active states keep the same weight in both themes.
Colour is reserved for meaning — red for a clash, amber for a warning, green for a
good slot.

Six views, reachable from the icon rail or the top tabs:

| View | What it shows |
|---|---|
| **Dashboard** | Live stat cards, notifications, what's up next, a month calendar, today's schedule with progress bars, load rings and a next-meeting countdown |
| **Meetings** | Every tracked meeting, grouped by day, with search and filters |
| **Tasks** | Task register with deadline, urgency, priority and source; create/edit/complete/delete, filters, and per-source status |
| **Timeline** | A day view with events laid out into lanes, a now-line and clash outlines |
| **Conflicts** | Double bookings grouped by cluster, plus back-to-back crunches |
| **Find a slot** | Scored free slots with the reasoning behind each score |
| **Settings** | Reminders, working hours, buffer, timezone and calendar source |

Motion is deliberately restrained — staggered fade-ups, a ring draw, bar growth,
a small hover lift — and is switched off entirely under `prefers-reduced-motion`.
The layout is responsive down to phone width, where the rail becomes a bottom bar.
Press `/` to jump to search, `Esc` to close anything.

## What it does

| Feature | How it works |
|---|---|
| **Tracks every meeting on your mail** | Pulls every event from every calendar on your Google account (30 days ahead, 1 day back) and caches it locally. Re-syncs automatically every 5 minutes. |
| **Detects meetings at the same time** | Sweep-line overlap detection groups clashing meetings into clusters, scores each clash `critical` / `major` / `minor`, and reports the exact overlap in minutes. Also flags back-to-back crunches with less breathing room than your buffer. |
| **Reminds you 30 minutes before** | A background job scans every 20 seconds. When a meeting enters the lead window you get an in-app toast, a desktop notification, an entry in the notification drawer, and optionally an e-mail. Each reminder fires exactly once. |
| **Recommends when to schedule** | Finds every free slot inside your working hours, then scores it 0–100 on time of day, that day's meeting load, calendar fragmentation, how soon it is, and weekday effects. Returns the best times with plain-English reasons. |
| **Tracks your tasks** | Add tasks here with a deadline, priority, details and tags — or mirror them from a connected platform. Deadlines feed the same reminder engine as meetings: each task raises "due soon" once and "overdue" once, and completing it silences both. |

All-day entries and invitations you have **declined** are correctly excluded from
busy time and never raise a false conflict.

## Quick start

```powershell
cd C:\Users\adedo\meetmanager
.\start.bat
```

Or manually:

```powershell
cd C:\Users\adedo\meetmanager
.\.venv\Scripts\python.exe run.py
```

Your browser opens at <http://127.0.0.1:8000>.

On first run nothing is connected yet, so the app offers a **sample calendar**.
Click *Load sample calendar* to exercise every feature immediately — it contains
real double-bookings, back-to-back crunches, and a meeting starting ~28 minutes
out so you see a live 30-minute reminder within a minute.

## Connecting your real Google Calendar

Google requires you to create your own OAuth client — this takes about five minutes
and is the only part I cannot do for you.

1. Open <https://console.cloud.google.com/apis/credentials> and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen** → *External* → add `adedokundaniel16@gmail.com` under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under *Authorised redirect URIs* add exactly:

   ```
   http://127.0.0.1:8000/auth/callback
   ```

6. Copy `.env.example` to `.env` and paste in your client ID and secret:

   ```ini
   GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxx
   ```

   (Alternatively, download the JSON and save it as `credentials.json` in this folder.)

7. Restart the app and click **Connect Google Calendar**.

Your token is stored locally in `data/meetmanager.db` and never leaves your machine.
Calendar access is **read-only** — the app never modifies or deletes your events.

## Configuration

Everything is optional and lives in `.env` (see `.env.example`). The most useful knobs:

```ini
TIMEZONE=Africa/Lagos          # drives the UI, working hours and reminders
REMINDER_MINUTES=30            # how far ahead to remind you
WORK_START=09:00
WORK_END=17:30
WORK_DAYS=0,1,2,3,4            # 0=Monday
BUFFER_MINUTES=10              # minimum gap between meetings
SYNC_DAYS_AHEAD=30
```

Most of these can also be changed live in the **Settings** tab, which overrides `.env`.

### Optional e-mail reminders

Off by default. To enable, add a Gmail [App Password](https://myaccount.google.com/apppasswords)
to `.env`, then tick *E-mail reminders* in Settings:

```ini
SMTP_USER=adedokundaniel16@gmail.com
SMTP_PASSWORD=your-16-char-app-password
```

## Verifying everything works

```powershell
.\.venv\Scripts\python.exe selfcheck.py
```

Runs 11 checks covering conflict detection, timeline layout (asserts no two
meetings ever share a lane), recommendation correctness (asserts no suggested
slot ever overlaps a booked meeting), reminder de-duplication, database
round-tripping, and every HTTP endpoint. Exits non-zero on any failure.

## Project layout

```
meetmanager/
├── run.py                 entry point
├── selfcheck.py           end-to-end verification suite
├── start.bat              double-click launcher
├── requirements.txt
├── .env.example
├── data/                  SQLite database (created at runtime)
└── app/
    ├── config.py          settings from environment, all with defaults
    ├── models.py          normalised Event model + interval helpers
    ├── store.py           SQLite: token, event cache, notification queue
    ├── google_client.py   OAuth flow + Calendar API → Event
    ├── analytics.py       conflicts, timeline layout, slot scoring, stats
    ├── demo_data.py       deterministic sample calendar
    ├── service.py         orchestration, preferences, reminder scheduler
    ├── main.py            FastAPI routes
    ├── templates/
    │   └── index.html
    └── static/
        ├── styles.css
        └── app.js
```

## Accounts

MeetManager is multi-tenant. Signing in **is** connecting Google: the OAuth
callback creates the account, and from then on every row the app stores carries
an `owner_id`.

Isolation is enforced in one place. A `Store` is *bound* to an owner —
`store.for_owner(id)` returns a view sharing the connection whose every query
is scoped — and `MeetManagerService.for_user(id)` wraps one. In the API layer
there is no path to data that does not go through `_service_for(request)`, so a
route cannot read another account's rows by forgetting a filter. A self-check
asserts that one account cannot read, edit or delete another's events, tasks,
tokens, preferences or alerts.

Unauthenticated visitors get the sign-in page and a `401` from every data
route — CI asserts both before it authenticates, so a broken auth gate fails
the build.

Deleting an account removes everything it owns and nothing else.

**Upgrading an existing install**: the store migrates itself on first boot. It
adds `owner_id` columns, rebuilds `kv` with a composite key, and adopts any
pre-existing rows into an account matching the Google profile already stored,
so nothing is lost. The migration is idempotent.

## Task sources

Tasks come from two kinds of place:

- **Added here** — created in the app. Fully editable: title, details, deadline,
  priority, status and tags.
- **Connected platforms** — mirrored **read-only**, because they are edited at
  the source. You can still tick one off locally; the next sync from the source
  wins.

**Google Tasks** is wired up and rides on the Google account you already
connect for your calendar. It needs one extra scope
(`.../auth/tasks.readonly`), so **anyone already connected has to reconnect
once** to grant it — existing consent does not cover a newly added scope.

Adding another platform means writing one `TaskProvider` in
[`app/tasks.py`](app/tasks.py) — `is_connected()`, `status_hint()`, `fetch()` —
and appending it to `self.task_providers` in `MeetManagerService`. Nothing else
in the app needs to change: reminders, stats, filters and the UI are all
source-agnostic.

## CI/CD

Two GitHub Actions workflows.

**`ci.yml`** runs on every push to `main`, every pull request, and on demand:

| Job | What it does |
|---|---|
| **Backend** | Installs on Python 3.11, 3.12 and 3.13, byte-compiles every module, then runs the 11-check `selfcheck.py` suite (conflict detection, timeline lane packing, slot scoring, store round-trip, reminder de-duplication, the HTTP API). |
| **Front-end** | `node --check` on `app.js`, plus `check-assets.mjs` — a static pass for dangling icon references, `$("#id")` calls with no matching element, unbalanced CSS braces and undefined `var(--token)`s. These break the page silently, without ever raising a console error. |
| **Browser** | Boots the app, seeds the sample calendar, then drives Chromium through all six views in both themes at 1440/820/390px. Fails on any console error, failed request, element outside the viewport, empty view or modal that will not open — then runs 11 front-end-to-back-end round trips. Screenshots upload as an artifact. |
| **Docker** | Builds the image and proves it actually boots: waits for `/healthz`, then checks the page and static assets are served. |

**`release.yml`** runs when you push a `v*` tag. It re-verifies, builds the
image, boots it as a gate, pushes `ghcr.io/<owner>/<repo>:<tag>` and `:latest`,
and opens a GitHub release with generated notes.

```bash
git tag v1.0.1 && git push origin v1.0.1
```

There is deliberately **no "deploy to production" step**. MeetManager is
local-first and single-mailbox: SQLite on local disk, an in-process scheduler,
and an OAuth redirect derived from `HOST`/`PORT`. Shipping means publishing a
runnable image, not pushing to a shared server. If you later want a real
deployment target, that is a separate job to add.

### Running it in Docker

```bash
docker build -t meetmanager .
docker run -p 8000:8000 -v meetmanager-data:/app/data meetmanager
```

Runs as an unprivileged user with the database on a named volume. Sample-data
mode needs no configuration. Connecting a **real** Google Calendar in a
container needs care: the redirect URI comes from `HOST`/`PORT`, and `HOST` is
`0.0.0.0` inside the container, so set both to the address the app will
actually be reached at and register that exact callback in Google Cloud
Console.

### Deploying to Render

`render.yaml` is a Blueprint: **New → Blueprint → pick this repo**, then fill
in the variables Render prompts for.

| Variable | Why |
|---|---|
| `PUBLIC_URL` | e.g. `https://meetmanager.onrender.com`. Without it the OAuth redirect is built from `HOST`/`PORT` and comes out as `http://0.0.0.0:10000/auth/callback`, which Google rejects. |
| `SECRET_KEY` | Signs session cookies. Unset means one is generated per boot, so every restart signs everyone out. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Your OAuth client. |

After the first deploy, add `<PUBLIC_URL>/auth/callback` to the authorised
redirect URIs on the Google OAuth client, then redeploy.

**Letting other people sign in.** While the OAuth consent screen is in
*Testing*, only accounts you list as test users can get in, and their refresh
tokens expire after 7 days. Switch **Publishing status → In production** to
lift both. It stays unverified, so users see a "Google hasn't verified this
app" interstitial and there is a **100-user cap** for sensitive scopes;
removing the warning and the cap needs Google's verification review, which
wants a privacy policy, a homepage and a demo video.

**What the free plan costs you.** Free instances have no persistent disk and
reset their filesystem whenever the service restarts — including waking from
the 15-minute idle sleep. Everything here lives in SQLite, so on that plan
expect users to be signed out and to have to reconnect Google after a restart,
locally-created tasks to be lost, and reminders not to fire while asleep. Fine
for a demo. For real use, switch to `plan: starter`, uncomment the `disk:`
block in `render.yaml`, and set `SECRET_KEY`.

### Running the checks locally

```bash
pip install -r requirements.txt -r requirements-dev.txt
python selfcheck.py                        # backend
node .github/scripts/check-assets.mjs      # static front-end checks

npm --prefix tests/ui ci
npx --prefix tests/ui playwright install chromium
python run.py --no-browser &               # then, against the running app:
node tests/ui/audit.mjs
node tests/ui/functional.mjs
```

`requirements-dev.txt` exists because `selfcheck.py` drives the API through
`fastapi.testclient`, whose HTTP client is **not** installed by `fastapi`
alone — so `pip install -r requirements.txt && python selfcheck.py` fails in a
clean environment. It asks for the `starlette[full]` extra rather than pinning
a client, because Starlette < 1.6 wants `httpx` and >= 1.6 wants `httpx2`.

`tests/ui/functional.mjs` writes to the running instance's database (it saves
preferences and dismisses one notification), so point it at a throwaway
instance rather than a real calendar.

## Notes

- Uses its own virtualenv at `.venv` so it never disturbs your global Python packages.
- Every API route traps its own exceptions and returns a friendly message, so a
  network blip shows as a banner rather than a stack trace.
- The scheduler, sync and e-mail sender all fail soft — if any of them cannot start,
  the rest of the app keeps working.
- Desktop notifications need permission from the browser; the app asks once and
  the current permission state is shown in Settings.
