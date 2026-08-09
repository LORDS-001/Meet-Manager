# MeetManager

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

## Notes

- Uses its own virtualenv at `.venv` so it never disturbs your global Python packages.
- Every API route traps its own exceptions and returns a friendly message, so a
  network blip shows as a banner rather than a stack trace.
- The scheduler, sync and e-mail sender all fail soft — if any of them cannot start,
  the rest of the app keeps working.
- Desktop notifications need permission from the browser; the app asks once and
  the current permission state is shown in Settings.
