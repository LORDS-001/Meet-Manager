"""Deterministic sample calendar.

Lets the whole application be exercised - tracking, conflict detection,
reminders and recommendations - before any Google credentials exist.

The generated set deliberately contains:
  * a meeting starting ~28 minutes from now, so the 30-minute reminder fires
    within a minute of loading the demo;
  * several genuine double-bookings;
  * back-to-back crunches;
  * all-day entries and a declined invite (which must NOT count as busy).
"""

from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta
from typing import Any

from .models import Event

SEED = 20260807

_TEMPLATES: list[tuple[str, int, str, list[str]]] = [
    ("Daily standup", 15, "Engineering", ["tobi", "amara", "chen"]),
    ("Sprint planning", 60, "Engineering", ["tobi", "amara", "chen", "priya"]),
    ("1:1 with Amara", 30, "Management", ["amara"]),
    ("Design review - onboarding flow", 45, "Product", ["priya", "sam"]),
    ("Client call - Northwind", 45, "Sales", ["j.harper", "l.stone"]),
    ("Backend architecture sync", 60, "Engineering", ["chen", "tobi"]),
    ("Quarterly roadmap review", 90, "Product", ["priya", "sam", "amara", "chen"]),
    ("Interview - Senior Python Engineer", 60, "Hiring", ["r.okafor", "amara"]),
    ("Marketing handoff", 30, "Marketing", ["l.stone", "sam"]),
    ("Budget check-in", 30, "Finance", ["m.dubois"]),
    ("Retrospective", 45, "Engineering", ["tobi", "amara", "chen", "priya"]),
    ("Partner sync - Halcyon Labs", 45, "Sales", ["j.harper"]),
    ("Support escalation review", 30, "Support", ["k.mensah"]),
    ("Product demo rehearsal", 45, "Product", ["priya", "sam"]),
    ("Security posture review", 60, "Engineering", ["chen", "r.okafor"]),
    ("Coffee chat with Sam", 30, "Social", ["sam"]),
]

_CALENDARS = [
    ("primary", "Personal"),
    ("work@company.example", "Work"),
    ("team-eng@company.example", "Engineering Team"),
]

_LOCATIONS = ["Google Meet", "Room: Kilimanjaro", "Zoom", "Room: Zanzibar", "Phone"]


def _meet_link(rng: random.Random) -> str:
    letters = "abcdefghijkmnopqrstuvwxyz"
    part = lambda n: "".join(rng.choice(letters) for _ in range(n))  # noqa: E731
    return f"https://meet.google.com/{part(3)}-{part(4)}-{part(3)}"


def _attendees(owner_email: str, handles: list[str]) -> list[dict[str, Any]]:
    people = [
        {
            "email": owner_email,
            "name": owner_email.split("@")[0],
            "response": "accepted",
            "organizer": False,
            "self": True,
        }
    ]
    for handle in handles:
        people.append(
            {
                "email": f"{handle}@company.example",
                "name": handle.replace(".", " ").replace("-", " ").title(),
                "response": "accepted",
                "organizer": False,
                "self": False,
            }
        )
    return people


def _make(
    rng: random.Random,
    *,
    index: int,
    title: str,
    start: datetime,
    duration: int,
    calendar: tuple[str, str],
    handles: list[str],
    owner_email: str,
    response: str = "accepted",
    with_meet: bool = True,
) -> Event:
    cal_id, cal_name = calendar
    return Event(
        id=f"demo-{index:03d}",
        summary=title,
        start=start,
        end=start + timedelta(minutes=duration),
        calendar_id=cal_id,
        calendar_name=cal_name,
        description=f"Auto-generated sample meeting for {title}.",
        location=rng.choice(_LOCATIONS),
        all_day=False,
        html_link="https://calendar.google.com/calendar/",
        meet_link=_meet_link(rng) if with_meet else "",
        organizer_email=owner_email if rng.random() < 0.4 else f"{handles[0]}@company.example",
        organizer_name="You" if rng.random() < 0.4 else handles[0].title(),
        attendees=_attendees(owner_email, handles),
        status="confirmed",
        response_status=response,
        source="demo",
        recurring=title == "Daily standup",
    )


def generate(owner_email: str, tz, days: int = 14) -> list[Event]:
    rng = random.Random(SEED)
    now = datetime.now(tz)
    today = now.date()
    events: list[Event] = []
    index = 0

    def add(**kwargs) -> None:
        nonlocal index
        index += 1
        events.append(_make(rng, index=index, owner_email=owner_email, **kwargs))

    # ---------------------------------------------------------------- today
    # A meeting that triggers the 30-minute reminder almost immediately.
    imminent_start = (now + timedelta(minutes=28)).replace(second=0, microsecond=0)
    add(
        title="Client call - Northwind renewal",
        start=imminent_start,
        duration=45,
        calendar=_CALENDARS[1],
        handles=["j.harper", "l.stone"],
    )

    # A second meeting that clashes head-on with the one above.
    add(
        title="Backend architecture sync",
        start=imminent_start + timedelta(minutes=20),
        duration=60,
        calendar=_CALENDARS[2],
        handles=["chen", "tobi"],
    )

    # Something later today, comfortably spaced.
    later = datetime.combine(today, time(16, 0), tzinfo=tz)
    if later > now + timedelta(minutes=90):
        add(
            title="Support escalation review",
            start=later,
            duration=30,
            calendar=_CALENDARS[1],
            handles=["k.mensah"],
        )

    # An all-day marker for today - must never block time or raise a conflict.
    index += 1
    events.append(
        Event(
            id=f"demo-{index:03d}",
            summary="Company offsite planning week",
            start=datetime.combine(today, time(0, 0), tzinfo=tz),
            end=datetime.combine(today + timedelta(days=1), time(0, 0), tzinfo=tz),
            calendar_id=_CALENDARS[1][0],
            calendar_name=_CALENDARS[1][1],
            description="All-day marker.",
            location="",
            all_day=True,
            html_link="https://calendar.google.com/calendar/",
            meet_link="",
            organizer_email=owner_email,
            organizer_name="You",
            attendees=[],
            status="confirmed",
            response_status="accepted",
            source="demo",
        )
    )

    # ------------------------------------------------------- following days
    for offset in range(1, days):
        day = today + timedelta(days=offset)
        weekday = day.weekday()
        if weekday >= 5:
            # Occasional weekend commitment keeps the recommender honest.
            if rng.random() < 0.25:
                add(
                    title="Weekend hackathon check-in",
                    start=datetime.combine(day, time(11, 0), tzinfo=tz),
                    duration=60,
                    calendar=_CALENDARS[0],
                    handles=["tobi"],
                )
            continue

        # Recurring standup every weekday.
        add(
            title="Daily standup",
            start=datetime.combine(day, time(9, 30), tzinfo=tz),
            duration=15,
            calendar=_CALENDARS[2],
            handles=["tobi", "amara", "chen"],
        )

        meetings_today = rng.choice([1, 2, 2, 3, 3, 4])
        slots = rng.sample(
            [10, 11, 12, 13, 14, 15, 16], k=min(meetings_today, 7)
        )
        for hour in sorted(slots):
            title, duration, _team, handles = rng.choice(_TEMPLATES[1:])
            minute = rng.choice([0, 0, 15, 30])
            add(
                title=title,
                start=datetime.combine(day, time(hour, minute), tzinfo=tz),
                duration=duration,
                calendar=rng.choice(_CALENDARS),
                handles=handles,
                with_meet=rng.random() < 0.8,
            )

    # ------------------------------------------- guaranteed conflict samples
    def next_weekday(base: date, target_weekday: int, min_offset: int = 1) -> date:
        for extra in range(min_offset, min_offset + 14):
            candidate = base + timedelta(days=extra)
            if candidate.weekday() == target_weekday:
                return candidate
        return base + timedelta(days=min_offset)

    clash_day = next_weekday(today, 2)  # Wednesday
    add(
        title="Quarterly roadmap review",
        start=datetime.combine(clash_day, time(11, 0), tzinfo=tz),
        duration=90,
        calendar=_CALENDARS[1],
        handles=["priya", "sam", "amara"],
    )
    add(
        title="Interview - Senior Python Engineer",
        start=datetime.combine(clash_day, time(11, 30), tzinfo=tz),
        duration=60,
        calendar=_CALENDARS[1],
        handles=["r.okafor", "amara"],
    )
    add(
        title="Partner sync - Halcyon Labs",
        start=datetime.combine(clash_day, time(12, 0), tzinfo=tz),
        duration=45,
        calendar=_CALENDARS[0],
        handles=["j.harper"],
    )

    # A perfectly identical double-booking on another day.
    clash_day_2 = next_weekday(today, 4)  # Friday
    add(
        title="Design review - onboarding flow",
        start=datetime.combine(clash_day_2, time(14, 0), tzinfo=tz),
        duration=45,
        calendar=_CALENDARS[1],
        handles=["priya", "sam"],
    )
    add(
        title="Budget check-in",
        start=datetime.combine(clash_day_2, time(14, 0), tzinfo=tz),
        duration=30,
        calendar=_CALENDARS[0],
        handles=["m.dubois"],
    )

    # A declined invite that overlaps something else - proves declined events
    # are excluded from conflicts and from busy time.
    add(
        title="Optional: All-hands rebroadcast",
        start=datetime.combine(clash_day_2, time(14, 15), tzinfo=tz),
        duration=60,
        calendar=_CALENDARS[1],
        handles=["l.stone"],
        response="declined",
    )

    # Back-to-back crunch with no gap at all.
    crunch_day = next_weekday(today, 1)  # Tuesday
    add(
        title="Marketing handoff",
        start=datetime.combine(crunch_day, time(15, 0), tzinfo=tz),
        duration=30,
        calendar=_CALENDARS[1],
        handles=["l.stone", "sam"],
    )
    add(
        title="Product demo rehearsal",
        start=datetime.combine(crunch_day, time(15, 30), tzinfo=tz),
        duration=45,
        calendar=_CALENDARS[1],
        handles=["priya", "sam"],
    )

    # De-duplicate identical (title, start) pairs produced by random overlap.
    seen: set[tuple[str, str]] = set()
    unique: list[Event] = []
    for event in sorted(events, key=lambda e: (e.start, e.summary)):
        key = (event.summary, event.start.isoformat())
        if key in seen:
            continue
        seen.add(key)
        unique.append(event)

    return unique
