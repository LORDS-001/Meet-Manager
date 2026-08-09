"""The brain of the app.

Three responsibilities, all pure functions over a list of `Event`:

1. `find_conflicts`  - double-bookings and back-to-back crunches.
2. `build_timeline`  - server-side lane layout for the day view.
3. `recommend_slots` - scored suggestions for when to book the next meeting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable

from .models import Event, Interval, humanise_minutes, merge_intervals

SLOT_GRANULARITY_MINUTES = 15
MIN_LEAD_MINUTES = 30  # never suggest something starting in the next half hour


# ---------------------------------------------------------------------------
# Conflicts
# ---------------------------------------------------------------------------
@dataclass
class ConflictPair:
    a: Event
    b: Event
    overlap_minutes: int
    severity: str

    def as_view(self, tz) -> dict[str, Any]:
        return {
            "a": self.a.as_view(tz),
            "b": self.b.as_view(tz),
            "overlap_minutes": self.overlap_minutes,
            "overlap_label": humanise_minutes(self.overlap_minutes),
            "severity": self.severity,
        }


@dataclass
class ConflictGroup:
    events: list[Event]
    pairs: list[ConflictPair]
    start: datetime
    end: datetime
    severity: str

    def as_view(self, tz) -> dict[str, Any]:
        local_start = self.start.astimezone(tz)
        local_end = self.end.astimezone(tz)
        worst = max((p.overlap_minutes for p in self.pairs), default=0)
        return {
            "id": f"conflict-{int(self.start.timestamp())}-{len(self.events)}",
            "events": [e.as_view(tz) for e in self.events],
            "pairs": [p.as_view(tz) for p in self.pairs],
            "severity": self.severity,
            "date_key": local_start.strftime("%Y-%m-%d"),
            "day_label": local_start.strftime("%A %d %B"),
            "window_label": f"{local_start.strftime('%H:%M')} - {local_end.strftime('%H:%M')}",
            "event_count": len(self.events),
            "max_overlap_minutes": worst,
            "max_overlap_label": humanise_minutes(worst),
        }


def _pair_severity(a: Event, b: Event, overlap: int) -> str:
    shortest = min(a.duration_minutes, b.duration_minutes) or 1
    ratio = overlap / shortest
    if a.start == b.start or ratio >= 0.9:
        return "critical"
    if ratio >= 0.35:
        return "major"
    return "minor"


_SEVERITY_RANK = {"minor": 0, "major": 1, "critical": 2}


def find_conflicts(events: Iterable[Event]) -> list[ConflictGroup]:
    """Sweep-line overlap detection, grouped into clusters of clashing events."""
    busy = sorted(
        (e for e in events if e.counts_as_busy and e.end > e.start),
        key=lambda e: (e.start, e.end),
    )

    pairs: list[ConflictPair] = []
    active: list[Event] = []
    for event in busy:
        active = [a for a in active if a.end > event.start]
        for other in active:
            overlap = other.overlap_minutes(event)
            if overlap > 0:
                pairs.append(ConflictPair(other, event, overlap, _pair_severity(other, event, overlap)))
        active.append(event)

    if not pairs:
        return []

    # Union-find to cluster transitively-overlapping events.
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(x: str, y: str) -> None:
        root_x, root_y = find(x), find(y)
        if root_x != root_y:
            parent[root_y] = root_x

    by_id = {e.id: e for e in busy}
    for pair in pairs:
        union(pair.a.id, pair.b.id)

    clusters: dict[str, list[str]] = {}
    for event_id in {p.a.id for p in pairs} | {p.b.id for p in pairs}:
        clusters.setdefault(find(event_id), []).append(event_id)

    groups: list[ConflictGroup] = []
    for root, member_ids in clusters.items():
        members = sorted((by_id[i] for i in member_ids), key=lambda e: (e.start, e.end))
        member_set = set(member_ids)
        group_pairs = [p for p in pairs if p.a.id in member_set and p.b.id in member_set]
        severity = max(
            (p.severity for p in group_pairs),
            key=lambda s: _SEVERITY_RANK[s],
            default="minor",
        )
        groups.append(
            ConflictGroup(
                events=members,
                pairs=sorted(group_pairs, key=lambda p: -p.overlap_minutes),
                start=min(e.start for e in members),
                end=max(e.end for e in members),
                severity=severity,
            )
        )

    groups.sort(key=lambda g: g.start)
    return groups


def find_tight_transitions(events: Iterable[Event], buffer_minutes: int) -> list[dict[str, Any]]:
    """Consecutive meetings with less than `buffer_minutes` of breathing room."""
    busy = sorted(
        (e for e in events if e.counts_as_busy), key=lambda e: (e.start, e.end)
    )
    results = []
    for previous, following in zip(busy, busy[1:]):
        gap = int((following.start - previous.end).total_seconds() // 60)
        if 0 <= gap < buffer_minutes:
            results.append({"previous": previous, "next": following, "gap_minutes": gap})
    return results


# ---------------------------------------------------------------------------
# Timeline layout
# ---------------------------------------------------------------------------
def build_timeline(
    events: Iterable[Event],
    tz,
    day: date,
    *,
    day_start_hour: int = 7,
    day_end_hour: int = 21,
) -> dict[str, Any]:
    """Lay events out into non-overlapping lanes for a single local day."""
    timed: list[Event] = []
    all_day: list[Event] = []
    for event in events:
        local_start = event.start.astimezone(tz)
        local_end = event.end.astimezone(tz)
        # Include anything that touches this local day.
        if local_end.date() < day or local_start.date() > day:
            continue
        (all_day if event.all_day else timed).append(event)

    timed.sort(key=lambda e: (e.start, e.end))

    # Widen the window so nothing is ever clipped out of view.
    start_hour, end_hour = day_start_hour, day_end_hour
    for event in timed:
        local_start = event.start.astimezone(tz)
        local_end = event.end.astimezone(tz)
        if local_start.date() == day:
            start_hour = min(start_hour, local_start.hour)
        else:
            start_hour = 0
        if local_end.date() == day:
            end_hour = max(end_hour, local_end.hour + (1 if local_end.minute else 0))
        else:
            end_hour = 24
    start_hour = max(0, min(start_hour, 23))
    end_hour = max(start_hour + 1, min(end_hour, 24))
    total_minutes = (end_hour - start_hour) * 60

    window_start = datetime.combine(day, time(start_hour, 0), tzinfo=tz)
    window_end = window_start + timedelta(minutes=total_minutes)

    # Greedy lane packing over clusters of overlapping events.
    lanes: list[datetime] = []          # lane index -> end time of last event
    assignments: list[tuple[Event, int]] = []
    cluster_start_index = 0
    cluster_max_end: datetime | None = None
    clusters: list[tuple[int, int]] = []  # (start_idx, end_idx) into assignments

    for event in timed:
        if cluster_max_end is not None and event.start >= cluster_max_end:
            clusters.append((cluster_start_index, len(assignments)))
            cluster_start_index = len(assignments)
            lanes = []
            cluster_max_end = None

        lane_index = next(
            (i for i, lane_end in enumerate(lanes) if lane_end <= event.start), None
        )
        if lane_index is None:
            lanes.append(event.end)
            lane_index = len(lanes) - 1
        else:
            lanes[lane_index] = event.end

        assignments.append((event, lane_index))
        cluster_max_end = event.end if cluster_max_end is None else max(cluster_max_end, event.end)

    if assignments:
        clusters.append((cluster_start_index, len(assignments)))

    blocks: list[dict[str, Any]] = []
    for start_idx, end_idx in clusters:
        chunk = assignments[start_idx:end_idx]
        lane_count = max((lane for _, lane in chunk), default=0) + 1
        for event, lane in chunk:
            visible_start = max(event.start.astimezone(tz), window_start)
            visible_end = min(event.end.astimezone(tz), window_end)
            top = (visible_start - window_start).total_seconds() / 60
            height = max(18.0, (visible_end - visible_start).total_seconds() / 60)
            view = event.as_view(tz)
            view.update(
                {
                    "lane": lane,
                    "lane_count": lane_count,
                    "top_pct": round(100 * top / total_minutes, 4),
                    "height_pct": round(100 * min(height, total_minutes - top) / total_minutes, 4),
                    "left_pct": round(100 * lane / lane_count, 4),
                    "width_pct": round(100 / lane_count, 4),
                    "overlapping": lane_count > 1,
                }
            )
            blocks.append(view)

    hours = [
        {"hour": h, "label": f"{h:02d}:00", "top_pct": round(100 * (h - start_hour) * 60 / total_minutes, 4)}
        for h in range(start_hour, end_hour + 1)
    ]

    now = datetime.now(tz)
    now_pct = None
    if now.date() == day:
        offset = (now - window_start).total_seconds() / 60
        if 0 <= offset <= total_minutes:
            now_pct = round(100 * offset / total_minutes, 4)

    busy_minutes = sum(e.duration_minutes for e in timed if e.counts_as_busy)

    return {
        "date": day.isoformat(),
        "day_label": day.strftime("%A, %d %B %Y"),
        "start_hour": start_hour,
        "end_hour": end_hour,
        "total_minutes": total_minutes,
        "hours": hours,
        "blocks": blocks,
        "all_day": [e.as_view(tz) for e in all_day],
        "now_pct": now_pct,
        "event_count": len(timed),
        "busy_minutes": busy_minutes,
        "busy_label": humanise_minutes(busy_minutes),
    }


# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------
@dataclass
class SlotSuggestion:
    start: datetime
    end: datetime
    score: float
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_view(self, tz) -> dict[str, Any]:
        local_start = self.start.astimezone(tz)
        local_end = self.end.astimezone(tz)
        score = int(round(self.score))
        if score >= 80:
            grade, grade_label = "excellent", "Excellent"
        elif score >= 65:
            grade, grade_label = "good", "Good"
        elif score >= 50:
            grade, grade_label = "fair", "Workable"
        else:
            grade, grade_label = "poor", "Last resort"
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "local_start": local_start.isoformat(),
            "local_end": local_end.isoformat(),
            "date_key": local_start.strftime("%Y-%m-%d"),
            "day_label": local_start.strftime("%A %d %b"),
            "short_day": local_start.strftime("%a %d %b"),
            "time_label": f"{local_start.strftime('%H:%M')} - {local_end.strftime('%H:%M')}",
            "duration_minutes": int((self.end - self.start).total_seconds() // 60),
            "score": score,
            "grade": grade,
            "grade_label": grade_label,
            "reasons": self.reasons,
            "warnings": self.warnings,
        }


def _round_up(dt: datetime, minutes: int) -> datetime:
    dt = dt.replace(second=0, microsecond=0)
    remainder = dt.minute % minutes
    if remainder:
        dt += timedelta(minutes=minutes - remainder)
    return dt


def _score_slot(
    local_start: datetime,
    local_end: datetime,
    *,
    day_meeting_count: int,
    day_busy_minutes: int,
    gap_before: float,
    gap_after: float,
    days_out: int,
    buffer_minutes: int,
) -> tuple[float, list[str], list[str]]:
    score = 60.0
    reasons: list[str] = []
    warnings: list[str] = []

    # --- Time of day -------------------------------------------------------
    minutes_of_day = local_start.hour * 60 + local_start.minute
    if 10 * 60 <= minutes_of_day < 11 * 60 + 30:
        score += 18
        reasons.append("Mid-morning peak-focus window")
    elif 14 * 60 <= minutes_of_day < 16 * 60:
        score += 15
        reasons.append("Early-afternoon slot, good energy for both sides")
    elif 9 * 60 <= minutes_of_day < 10 * 60:
        score += 8
        reasons.append("Starts the day without eating into deep-work time")
    elif 16 * 60 <= minutes_of_day < 17 * 60:
        score += 5
        reasons.append("End-of-day wrap-up slot")
    elif 11 * 60 + 30 <= minutes_of_day < 13 * 60:
        score += 2
        warnings.append("Close to the usual lunch break")
    elif 13 * 60 <= minutes_of_day < 14 * 60:
        score -= 8
        warnings.append("Overlaps the typical lunch hour")
    else:
        score -= 18
        warnings.append("Outside the most productive hours")

    # --- Meeting load on that day -----------------------------------------
    if day_meeting_count == 0:
        score += 12
        reasons.append("Completely clear day")
    elif day_meeting_count <= 2:
        score += 6
        reasons.append(f"Light day - only {day_meeting_count} meeting(s) booked")
    elif day_meeting_count == 3:
        score += 0
    elif day_meeting_count == 4:
        score -= 8
        warnings.append("Already a busy day (4 meetings)")
    else:
        score -= 18
        warnings.append(f"Heavy day - {day_meeting_count} meetings already booked")

    if day_busy_minutes >= 300:
        score -= 6
        warnings.append(f"{humanise_minutes(day_busy_minutes)} already in meetings that day")

    # --- Calendar fragmentation -------------------------------------------
    tight_before = 0 < gap_before < buffer_minutes
    tight_after = 0 < gap_after < buffer_minutes
    if tight_before or tight_after:
        score -= 10
        warnings.append("Leaves almost no gap between meetings")
    elif gap_before == 0 or gap_after == 0:
        score += 6
        reasons.append("Sits flush against existing meetings - keeps focus time intact")
    elif gap_before >= 45 and gap_after >= 45:
        score += 8
        reasons.append("Plenty of breathing room on both sides")
    elif 0 < min(gap_before, gap_after) < 30:
        score -= 4
        warnings.append("Creates a short, hard-to-use gap")

    # --- How soon ----------------------------------------------------------
    score -= 1.6 * days_out
    if days_out == 0:
        score += 4
        reasons.append("Available today")
    elif days_out == 1:
        reasons.append("Tomorrow - still soon")

    # --- Weekday nuances ---------------------------------------------------
    weekday = local_start.weekday()
    if weekday == 0 and minutes_of_day < 10 * 60:
        score -= 6
        warnings.append("Monday morning - people are still ramping up")
    if weekday == 4 and minutes_of_day >= 15 * 60:
        score -= 6
        warnings.append("Late Friday - attendance tends to drop")
    if weekday in (1, 2, 3):
        score += 4
        reasons.append("Mid-week days get the best attendance")

    # --- Tidiness ----------------------------------------------------------
    if local_start.minute in (0, 30):
        score += 4
        reasons.append("Clean start time - easy for everyone to remember")

    if local_end.hour * 60 + local_end.minute > 18 * 60:
        score -= 10
        warnings.append("Runs past 18:00")

    return max(0.0, min(100.0, score)), reasons, warnings


def recommend_slots(
    events: Iterable[Event],
    tz,
    *,
    duration_minutes: int = 30,
    horizon_days: int = 10,
    work_start: time = time(9, 0),
    work_end: time = time(17, 30),
    work_days: tuple[int, ...] = (0, 1, 2, 3, 4),
    buffer_minutes: int = 10,
    limit: int = 8,
    max_per_day: int = 2,
    now: datetime | None = None,
) -> list[SlotSuggestion]:
    """Find and score free slots, best first."""
    duration_minutes = max(5, min(int(duration_minutes), 8 * 60))
    horizon_days = max(1, min(int(horizon_days), 60))
    duration = timedelta(minutes=duration_minutes)

    now = (now or datetime.now(tz)).astimezone(tz)
    earliest = _round_up(now + timedelta(minutes=MIN_LEAD_MINUTES), SLOT_GRANULARITY_MINUTES)

    busy_events = [e for e in events if e.counts_as_busy]

    # Per-day statistics, keyed by local date.
    day_counts: dict[date, int] = {}
    day_minutes: dict[date, int] = {}
    for event in busy_events:
        key = event.start.astimezone(tz).date()
        day_counts[key] = day_counts.get(key, 0) + 1
        day_minutes[key] = day_minutes.get(key, 0) + event.duration_minutes

    padded = merge_intervals(
        [
            Interval(
                event.start.astimezone(tz) - timedelta(minutes=buffer_minutes),
                event.end.astimezone(tz) + timedelta(minutes=buffer_minutes),
            )
            for event in busy_events
        ]
    )
    raw_busy = merge_intervals(
        [Interval(e.start.astimezone(tz), e.end.astimezone(tz)) for e in busy_events]
    )

    suggestions: list[SlotSuggestion] = []
    today = now.date()

    for offset in range(horizon_days):
        day = today + timedelta(days=offset)
        if day.weekday() not in work_days:
            continue

        window_start = datetime.combine(day, work_start, tzinfo=tz)
        window_end = datetime.combine(day, work_end, tzinfo=tz)
        if window_end <= window_start:
            continue
        window_start = max(window_start, earliest)
        if window_start + duration > window_end:
            continue

        # Free gaps = the working window minus padded busy time.
        free: list[Interval] = []
        cursor = window_start
        for block in padded:
            if block.end <= cursor:
                continue
            if block.start >= window_end:
                break
            if block.start > cursor:
                free.append(Interval(cursor, min(block.start, window_end)))
            cursor = max(cursor, block.end)
            if cursor >= window_end:
                break
        if cursor < window_end:
            free.append(Interval(cursor, window_end))

        day_candidates: list[SlotSuggestion] = []
        for gap in free:
            candidate = _round_up(gap.start, SLOT_GRANULARITY_MINUTES)
            while candidate + duration <= gap.end:
                candidate_end = candidate + duration

                gap_before = _gap_to_previous(candidate, raw_busy)
                gap_after = _gap_to_next(candidate_end, raw_busy)

                score, reasons, warnings = _score_slot(
                    candidate,
                    candidate_end,
                    day_meeting_count=day_counts.get(day, 0),
                    day_busy_minutes=day_minutes.get(day, 0),
                    gap_before=gap_before,
                    gap_after=gap_after,
                    days_out=offset,
                    buffer_minutes=buffer_minutes,
                )
                day_candidates.append(
                    SlotSuggestion(candidate, candidate_end, score, reasons, warnings)
                )
                candidate += timedelta(minutes=SLOT_GRANULARITY_MINUTES)

        day_candidates.sort(key=lambda s: (-s.score, s.start))
        # Keep a spread within the day rather than three adjacent 15-min shifts.
        picked: list[SlotSuggestion] = []
        for candidate in day_candidates:
            if len(picked) >= max_per_day:
                break
            if all(abs((candidate.start - p.start).total_seconds()) >= 3600 for p in picked):
                picked.append(candidate)
        suggestions.extend(picked)

    suggestions.sort(key=lambda s: (-s.score, s.start))
    return suggestions[:limit]


def _gap_to_previous(moment: datetime, busy: list[Interval]) -> float:
    """Minutes between the end of the closest earlier meeting and `moment`."""
    best = float("inf")
    for block in busy:
        if block.end <= moment:
            best = min(best, (moment - block.end).total_seconds() / 60)
    return best if best != float("inf") else 999.0


def _gap_to_next(moment: datetime, busy: list[Interval]) -> float:
    best = float("inf")
    for block in busy:
        if block.start >= moment:
            best = min(best, (block.start - moment).total_seconds() / 60)
    return best if best != float("inf") else 999.0


# ---------------------------------------------------------------------------
# Summary statistics
# ---------------------------------------------------------------------------
def build_stats(events: list[Event], tz, conflicts: list[ConflictGroup], now: datetime | None = None) -> dict[str, Any]:
    now = (now or datetime.now(tz)).astimezone(tz)
    today = now.date()
    week_end = today + timedelta(days=7)

    busy = [e for e in events if e.counts_as_busy]
    upcoming = sorted((e for e in busy if e.end > now), key=lambda e: e.start)

    today_events = [e for e in busy if e.start.astimezone(tz).date() == today]
    week_events = [e for e in busy if today <= e.start.astimezone(tz).date() < week_end]

    week_minutes = sum(e.duration_minutes for e in week_events)
    today_minutes = sum(e.duration_minutes for e in today_events)

    load_by_day: dict[str, dict[str, Any]] = {}
    for offset in range(7):
        day = today + timedelta(days=offset)
        day_events = [e for e in busy if e.start.astimezone(tz).date() == day]
        minutes = sum(e.duration_minutes for e in day_events)
        load_by_day[day.isoformat()] = {
            "date": day.isoformat(),
            "label": day.strftime("%a"),
            "day_number": day.strftime("%d"),
            "count": len(day_events),
            "minutes": minutes,
            "hours": round(minutes / 60, 1),
            "is_today": day == today,
        }

    busiest = max(load_by_day.values(), key=lambda d: d["minutes"], default=None)

    next_event = upcoming[0] if upcoming else None
    next_view = None
    if next_event is not None:
        next_view = next_event.as_view(tz)
        seconds = (next_event.start - now).total_seconds()
        next_view["starts_in_seconds"] = int(seconds)
        next_view["in_progress"] = seconds <= 0
        next_view["starts_in_label"] = (
            "In progress now" if seconds <= 0 else f"in {humanise_minutes(int(seconds // 60))}"
        )

    conflict_events = {e.id for group in conflicts for e in group.events}

    return {
        "total_tracked": len(events),
        "busy_count": len(busy),
        "upcoming_count": len(upcoming),
        "today_count": len(today_events),
        "today_minutes": today_minutes,
        "today_label": humanise_minutes(today_minutes),
        "week_count": len(week_events),
        "week_minutes": week_minutes,
        "week_label": humanise_minutes(week_minutes),
        "week_hours": round(week_minutes / 60, 1),
        "conflict_groups": len(conflicts),
        "conflict_events": len(conflict_events),
        "with_meet_links": sum(1 for e in busy if e.meet_link),
        "load_by_day": list(load_by_day.values()),
        "busiest_day": busiest,
        "next_event": next_view,
        "generated_at": now.isoformat(),
    }
