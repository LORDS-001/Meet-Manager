/* ==========================================================================
   MeetManager front-end controller
   ========================================================================== */
(function () {
  "use strict";

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const body = document.body;

  const App = {
    state: null,
    view: "dashboard",
    timelineDate: null,
    seenNotificationIds: new Set(),
    toastedNotificationIds: new Set(),
    agendaSearch: "",
    agendaFilter: "all",
    pollTimer: null,
    tickTimer: null,
    firstLoad: true,
  };

  /* ----------------------------------------------------------------- utils */

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function todayISO() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  }

  function shiftISO(iso, days) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + days);
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offset).toISOString().slice(0, 10);
  }

  function humanDuration(seconds) {
    const abs = Math.max(0, Math.floor(seconds));
    const d = Math.floor(abs / 86400);
    const h = Math.floor((abs % 86400) / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  async function api(path, options) {
    try {
      const response = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options));
      const text = await response.text();
      if (!text) return { ok: false, message: "Empty response from server." };
      try {
        return JSON.parse(text);
      } catch (_) {
        return { ok: false, message: "Server returned an unexpected response." };
      }
    } catch (error) {
      return { ok: false, message: "Cannot reach the MeetManager server. Is it still running?" };
    }
  }

  /* ---------------------------------------------------------------- toasts */

  function toast(title, bodyText, kind, options) {
    const opts = options || {};
    const host = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    const icon = { reminder: "&#9200;", error: "&#9888;", success: "&#10003;", info: "&#8505;" }[kind] || "&#8505;";
    el.innerHTML =
      `<div class="t-icon">${icon}</div>` +
      `<div style="flex:1;min-width:0">` +
      `<div class="t-title">${esc(title)}</div>` +
      (bodyText ? `<div class="t-body">${esc(bodyText)}</div>` : "") +
      (opts.link ? `<div class="t-body"><a href="${esc(opts.link)}" target="_blank" rel="noreferrer">Join the call &rarr;</a></div>` : "") +
      `</div>`;
    host.appendChild(el);
    const life = opts.sticky ? 20000 : 6000;
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 260);
    }, life);
  }

  /* --------------------------------------------------------------- banners */

  function renderBanners() {
    const host = $("#banners");
    host.innerHTML = "";
    const state = App.state;
    if (!state) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get("auth_error")) {
      addBanner("error", "&#9888;", "Google sign-in did not complete: " + params.get("auth_error"));
      history.replaceState({}, "", "/");
    } else if (params.get("auth") === "connected") {
      toast("Google Calendar connected", "Your meetings are now being tracked.", "success");
      history.replaceState({}, "", "/");
    } else if (params.get("auth") === "connected_sync_failed") {
      addBanner("warn", "&#9888;", "Connected, but the first sync did not return any events. Press Sync to retry.");
      history.replaceState({}, "", "/");
    }

    if (state.sync.last_error) {
      addBanner("error", "&#9888;", state.sync.last_error);
    }

    if (state.data_mode === "empty") {
      addBanner(
        "info",
        "&#128197;",
        "No meetings tracked yet. Connect your Google Calendar for live data, or load a sample calendar to explore every feature right now.",
        [
          { label: "Load sample calendar", action: loadDemo, primary: true },
          { label: "Connect Google Calendar", action: connectGoogle },
        ]
      );
    } else if (state.data_mode === "demo") {
      addBanner(
        "warn",
        "&#9881;",
        "Showing a <strong>sample calendar</strong> so you can try tracking, conflicts, reminders and recommendations. Connect Google to manage the real meetings on " +
          esc(state.owner_email) + ".",
        [{ label: "Connect Google Calendar", action: connectGoogle, primary: true }]
      );
    }

    if (state.data_mode !== "empty" && state.conflicts.length > 0) {
      addBanner(
        "error",
        "&#9888;",
        `<strong>${state.conflicts.length} scheduling conflict${state.conflicts.length === 1 ? "" : "s"}</strong> detected across ${state.stats.conflict_events} meetings.`,
        [{ label: "Review conflicts", action: () => switchView("conflicts"), primary: true }]
      );
    }

    function addBanner(kind, icon, html, actions) {
      const el = document.createElement("div");
      el.className = "banner " + kind;
      el.innerHTML = `<span style="font-size:1.15rem">${icon}</span><div style="flex:1">${html}</div>`;
      if (actions && actions.length) {
        const wrap = document.createElement("div");
        wrap.className = "banner-actions";
        actions.forEach((action) => {
          const btn = document.createElement("button");
          btn.className = "btn small " + (action.primary ? "primary" : "ghost");
          btn.textContent = action.label;
          btn.addEventListener("click", action.action);
          wrap.appendChild(btn);
        });
        el.appendChild(wrap);
      }
      host.appendChild(el);
    }
  }

  /* ------------------------------------------------------------ event card */

  function eventCard(event, options) {
    const opts = options || {};
    const tags = [];
    if (event.in_conflict) tags.push('<span class="tag clash">clash</span>');
    if (event.all_day) tags.push('<span class="tag allday">all day</span>');
    if (event.has_meet) tags.push('<span class="tag meet">video</span>');
    if (event.recurring) tags.push('<span class="tag recur">repeats</span>');
    if (event.response_status === "declined") tags.push('<span class="tag declined">declined</span>');
    if (opts.soon) tags.push('<span class="tag soon">soon</span>');

    const meta = [];
    meta.push(`&#128337; ${esc(event.time_label)}`);
    if (!event.all_day) meta.push(`&#9201; ${esc(event.duration_label)}`);
    if (event.attendee_count) meta.push(`&#128101; ${event.attendee_count}`);
    if (event.location) meta.push(`&#128205; ${esc(event.location)}`);

    const classes = ["event-card"];
    if (event.in_conflict) classes.push("conflict");
    if (event.response_status === "declined") classes.push("declined");

    return (
      `<div class="${classes.join(" ")}" data-event-id="${esc(event.id)}">` +
      `<div class="event-stripe" style="background:${esc(event.colour)}"></div>` +
      `<div class="event-body">` +
      `<div class="event-title">${esc(event.summary)} ${tags.join(" ")}</div>` +
      `<div class="event-meta">${meta.join("")}</div>` +
      `</div>` +
      `<div class="event-right"><span>${esc(opts.rightTop || event.day_label)}</span>` +
      `<span style="color:var(--text-faint)">${esc(opts.rightBottom || event.calendar_name)}</span></div>` +
      `</div>`
    );
  }

  function emptyState(emoji, title, text) {
    return `<div class="empty-state"><span class="emoji">${emoji}</span><h3>${esc(title)}</h3><p class="small">${esc(text)}</p></div>`;
  }

  /* ------------------------------------------------------------- dashboard */

  function renderDashboard() {
    const state = App.state;
    const stats = state.stats;

    $("#stat-grid").innerHTML = [
      statCard("Tracked meetings", stats.total_tracked, `${stats.upcoming_count} still upcoming`, "&#128197;", ""),
      statCard("Today", stats.today_count, stats.today_minutes ? `${stats.today_label} in meetings` : "Nothing booked today", "&#9200;", ""),
      statCard("Next 7 days", stats.week_count, `${stats.week_label} of meeting time`, "&#128200;", ""),
      statCard(
        "Conflicts",
        stats.conflict_groups,
        stats.conflict_groups ? `${stats.conflict_events} meetings clash` : "Calendar is clean",
        "&#9888;",
        stats.conflict_groups ? "danger" : "good"
      ),
    ].join("");

    // ---- week load chart
    const maxMinutes = Math.max(60, ...stats.load_by_day.map((d) => d.minutes));
    $("#load-chart").innerHTML = stats.load_by_day
      .map((day) => {
        const pct = Math.round((day.minutes / maxMinutes) * 100);
        let cls = "load-bar";
        if (day.minutes === 0) cls += " empty";
        else if (day.minutes >= 300) cls += " heavy";
        return (
          `<div class="load-col ${day.is_today ? "today" : ""}" title="${esc(day.label)} — ${day.count} meeting(s), ${day.hours}h">` +
          `<div class="load-bar-wrap"><div class="${cls}" style="height:${Math.max(3, pct)}%"></div></div>` +
          `<div class="load-meta"><div class="d">${esc(day.label)}</div><div class="n">${day.count ? day.hours + "h" : "free"}</div></div>` +
          `</div>`
        );
      })
      .join("");

    $("#week-summary").textContent = stats.busiest_day && stats.busiest_day.minutes
      ? `Busiest: ${stats.busiest_day.label} (${stats.busiest_day.hours}h)`
      : "No meetings this week";

    // ---- up next
    const upcoming = state.upcoming.filter((e) => !e.all_day).slice(0, 6);
    $("#upnext-list").innerHTML = upcoming.length
      ? upcoming.map((e) => eventCard(e, { rightTop: e.day_label })).join("")
      : emptyState("&#127881;", "Nothing on the horizon", "You have no upcoming meetings tracked.");

    // ---- attention
    const attention = [];
    state.conflicts.slice(0, 3).forEach((group) => {
      attention.push(
        `<div class="conflict-card severity-${esc(group.severity)}">` +
        `<div class="conflict-head">` +
        `<span class="severity-pill ${esc(group.severity)}">${esc(group.severity)}</span>` +
        `<strong>${esc(group.day_label)}</strong>` +
        `<span class="muted small">${esc(group.window_label)} &middot; ${group.event_count} meetings overlap</span>` +
        `</div>` +
        `<div class="event-list">${group.events.map((e) => eventCard(Object.assign({}, e, { in_conflict: true }), { rightTop: e.time_label })).join("")}</div>` +
        `</div>`
      );
    });
    state.tight_transitions.slice(0, 3).forEach((item) => {
      attention.push(
        `<div class="tight-card">` +
        `<span>&#9203;</span>` +
        `<div><strong>${esc(item.previous.summary)}</strong> &rarr; <strong>${esc(item.next.summary)}</strong>` +
        `<div class="muted small">${esc(item.next.day_label)} &middot; ends ${esc(item.previous.time_label.split(" - ")[1] || "")}, next starts ${esc(item.next.time_label.split(" - ")[0] || "")}</div></div>` +
        `<span class="tight-gap">${item.gap_minutes === 0 ? "no gap" : item.gap_minutes + " min"}</span>` +
        `</div>`
      );
    });

    $("#attention-list").innerHTML = attention.length
      ? attention.join("")
      : emptyState("&#9989;", "All clear", "No double bookings and no back-to-back crunches detected.");
    $("#attention-summary").textContent =
      `${state.conflicts.length} conflict(s) · ${state.tight_transitions.length} tight transition(s)`;

    function statCard(label, value, sub, spark, kind) {
      return (
        `<div class="stat ${kind}">` +
        `<div class="stat-spark">${spark}</div>` +
        `<div class="stat-label">${esc(label)}</div>` +
        `<div class="stat-value">${esc(value)}</div>` +
        `<div class="stat-sub">${esc(sub)}</div>` +
        `</div>`
      );
    }
  }

  /* ---------------------------------------------------------------- agenda */

  function renderAgenda() {
    const state = App.state;
    const query = App.agendaSearch.trim().toLowerCase();
    const filter = App.agendaFilter;
    // "Today" always means the real current day in the user's timezone, even
    // when the timeline view has been navigated to some other date.
    const todayKey = String(state.now).slice(0, 10);
    const weekLimit = shiftISO(todayKey, 7);

    const groups = state.agenda
      .map((group) => {
        const events = group.events.filter((event) => {
          if (filter === "conflict" && !event.in_conflict) return false;
          if (filter === "meet" && !event.has_meet) return false;
          if (filter === "today" && event.date_key !== todayKey) return false;
          if (filter === "week" && !(event.date_key >= todayKey && event.date_key < weekLimit)) return false;
          if (!query) return true;
          const haystack = [
            event.summary,
            event.location,
            event.calendar_name,
            event.organizer_name,
            event.organizer_email,
            (event.attendees || []).map((a) => a.name + " " + a.email).join(" "),
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        });
        return Object.assign({}, group, { events });
      })
      .filter((group) => group.events.length > 0);

    const total = groups.reduce((sum, g) => sum + g.events.length, 0);

    $("#agenda-list").innerHTML = groups.length
      ? groups
          .map(
            (group) =>
              `<div class="day-group">` +
              `<div class="day-header">` +
              `<span class="dh-title">${esc(group.label)}</span>` +
              `<span class="dh-sub">${esc(group.full_label)}</span>` +
              `<span class="dh-right">${group.events.length} meeting(s) &middot; ${esc(group.busy_label)}` +
              (group.conflict_count ? ` &middot; <span style="color:var(--danger)">${group.conflict_count} clashing</span>` : "") +
              `</span></div>` +
              `<div class="event-list">${group.events.map((e) => eventCard(e, { rightTop: e.time_label })).join("")}</div>` +
              `</div>`
          )
          .join("")
      : emptyState("&#128269;", "No matching meetings", query || filter !== "all" ? "Try clearing the search or the filter." : "Nothing is tracked yet.");

    $("#badge-agenda").textContent = state.upcoming.length;
    $("#view-subtitle").dataset.agendaCount = total;
  }

  /* -------------------------------------------------------------- timeline */

  function renderTimeline() {
    const timeline = App.state.timeline;
    $("#timeline-title").textContent = timeline.day_label;
    $("#tl-date").value = timeline.date;

    $("#timeline-allday").innerHTML = timeline.all_day.length
      ? timeline.all_day.map((e) => `<span class="allday-chip">&#128197; ${esc(e.summary)}</span>`).join("")
      : "";

    const conflictIds = new Set();
    App.state.conflicts.forEach((group) => group.events.forEach((e) => conflictIds.add(e.id)));

    const height = Math.max(620, timeline.total_minutes * 1.35);

    $("#timeline-hours").style.height = height + "px";
    $("#timeline-canvas").style.height = height + "px";

    $("#timeline-hours").innerHTML = timeline.hours
      .map((hour) => `<div class="hour-label" style="top:${hour.top_pct}%">${esc(hour.label)}</div>`)
      .join("");

    const lines = timeline.hours
      .map((hour) => `<div class="hour-line" style="top:${hour.top_pct}%"></div>`)
      .join("");

    const blocks = timeline.blocks
      .map((block) => {
        const classes = ["tl-block"];
        if (conflictIds.has(block.id)) classes.push("is-conflict");
        if (block.response_status === "declined") classes.push("is-declined");
        const gap = block.lane_count > 1 ? 1.4 : 0;
        return (
          `<div class="${classes.join(" ")}" data-event-id="${esc(block.id)}" ` +
          `style="top:${block.top_pct}%;height:${block.height_pct}%;` +
          `left:calc(${block.left_pct}% + 3px);width:calc(${block.width_pct}% - ${6 + gap}px);` +
          `background:${esc(block.colour)}">` +
          `<div class="b-title">${esc(block.summary)}</div>` +
          `<div class="b-time">${esc(block.time_label)}</div>` +
          `</div>`
        );
      })
      .join("");

    const nowLine =
      timeline.now_pct === null || timeline.now_pct === undefined
        ? ""
        : `<div class="now-line" style="top:${timeline.now_pct}%"></div>`;

    $("#timeline-canvas").innerHTML = lines + blocks + nowLine;

    if (!timeline.blocks.length && !timeline.all_day.length) {
      $("#timeline-canvas").innerHTML =
        lines + `<div style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none">` +
        emptyState("&#9749;", "Free day", "No meetings scheduled on this day.") + `</div>`;
    }
  }

  /* ------------------------------------------------------------- conflicts */

  function renderConflicts() {
    const state = App.state;
    $("#badge-conflicts").textContent = state.conflicts.length;
    $("#conflict-summary").textContent = state.conflicts.length
      ? `${state.conflicts.length} group(s) · ${state.stats.conflict_events} meetings affected`
      : "None detected";

    $("#conflict-list").innerHTML = state.conflicts.length
      ? state.conflicts
          .map((group) => {
            const pairs = group.pairs
              .map(
                (pair) =>
                  `<div>&#8226; <strong>${esc(pair.a.summary)}</strong> overlaps <strong>${esc(pair.b.summary)}</strong> by ` +
                  `<strong>${esc(pair.overlap_label)}</strong> <span class="muted">(${esc(pair.severity)})</span></div>`
              )
              .join("");
            return (
              `<div class="conflict-card severity-${esc(group.severity)}">` +
              `<div class="conflict-head">` +
              `<span class="severity-pill ${esc(group.severity)}">${esc(group.severity)}</span>` +
              `<strong>${esc(group.day_label)}</strong>` +
              `<span class="muted small">${esc(group.window_label)}</span>` +
              `<button class="btn ghost small" style="margin-left:auto" data-goto-day="${esc(group.date_key)}">View on timeline</button>` +
              `</div>` +
              `<div class="event-list">${group.events.map((e) => eventCard(Object.assign({}, e, { in_conflict: true }), { rightTop: e.time_label })).join("")}</div>` +
              `<div class="overlap-note">${pairs}</div>` +
              `</div>`
            );
          })
          .join("")
      : emptyState("&#9989;", "No double bookings", "Every tracked meeting has the calendar to itself.");

    $("#tight-list").innerHTML = state.tight_transitions.length
      ? state.tight_transitions
          .map(
            (item) =>
              `<div class="tight-card"><span>&#9203;</span>` +
              `<div><strong>${esc(item.previous.summary)}</strong> &rarr; <strong>${esc(item.next.summary)}</strong>` +
              `<div class="muted small">${esc(item.next.day_label)} &middot; ${esc(item.previous.time_label)} then ${esc(item.next.time_label)}</div></div>` +
              `<span class="tight-gap">${item.gap_minutes === 0 ? "no gap" : item.gap_minutes + " min"}</span></div>`
          )
          .join("")
      : emptyState("&#128076;", "Comfortable pacing", "No meetings are packed tighter than your buffer.");
  }

  /* -------------------------------------------------------- recommendations */

  function renderRecommendations(list, message) {
    const host = $("#reco-list");
    if (!list || !list.length) {
      host.innerHTML = emptyState("&#128533;", "No free slot found", message || "Try a shorter meeting or a longer horizon.");
      return;
    }
    const ringColour = { excellent: "var(--success)", good: "var(--info)", fair: "var(--warning)", poor: "var(--text-faint)" };
    host.innerHTML = list
      .map((slot, index) => {
        const reasons = slot.reasons.slice(0, 3).map((r) => `<li>${esc(r)}</li>`).join("");
        const warnings = slot.warnings.slice(0, 2).map((w) => `<li class="warn">${esc(w)}</li>`).join("");
        return (
          `<div class="reco-card ${esc(slot.grade)}" style="animation-delay:${index * 45}ms">` +
          `<div class="reco-top">` +
          `<div class="reco-when"><div class="d">${esc(slot.day_label)}</div><div class="t">${esc(slot.time_label)}</div></div>` +
          `<div><div class="score-ring" style="--pct:${slot.score};--ring-colour:${ringColour[slot.grade]}"><span>${slot.score}</span></div>` +
          `<div class="reco-grade" style="color:${ringColour[slot.grade]}">${esc(slot.grade_label)}</div></div>` +
          `</div>` +
          `<ul class="reco-reasons">${reasons}${warnings}</ul>` +
          `<div class="reco-actions">` +
          `<button class="btn primary small" data-gcal="${esc(slot.local_start)}|${esc(slot.local_end)}">Book in Google Calendar</button>` +
          `<button class="btn ghost small" data-goto-day="${esc(slot.date_key)}">See that day</button>` +
          `</div></div>`
        );
      })
      .join("");
  }

  async function fetchRecommendations() {
    const button = $("#btn-reco");
    button.disabled = true;
    button.textContent = "Calculating…";
    const duration = $("#reco-duration").value;
    const days = $("#reco-days").value;
    const limit = $("#reco-limit").value;
    const result = await api(`/api/recommendations?duration=${duration}&days=${days}&limit=${limit}`);
    button.disabled = false;
    button.textContent = "Find best times";
    if (!result.ok && !result.recommendations) {
      toast("Could not compute recommendations", result.message, "error");
      renderRecommendations([], result.message);
      return;
    }
    renderRecommendations(result.recommendations || [], result.message);
  }

  /* -------------------------------------------------------------- settings */

  const TIMEZONES = [
    "Africa/Lagos", "Africa/Accra", "Africa/Nairobi", "Africa/Johannesburg", "Africa/Cairo",
    "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
    "Europe/Lisbon", "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Moscow",
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Toronto", "America/Sao_Paulo", "America/Mexico_City",
    "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Bangkok", "Asia/Singapore",
    "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul", "Asia/Jerusalem",
    "Australia/Sydney", "Australia/Perth", "Pacific/Auckland", "UTC",
  ];

  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function renderSettings() {
    const prefs = App.state.preferences;
    const resolved = prefs.resolved;

    const tzSelect = $("#set-timezone");
    if (!tzSelect.dataset.filled) {
      const options = TIMEZONES.slice();
      if (!options.includes(resolved.timezone)) options.unshift(resolved.timezone);
      tzSelect.innerHTML = options.map((tz) => `<option value="${esc(tz)}">${esc(tz)}</option>`).join("");
      tzSelect.dataset.filled = "1";
    }
    tzSelect.value = resolved.timezone;

    setSelect("#set-reminder", resolved.reminder_minutes);
    setSelect("#set-buffer", resolved.buffer_minutes);
    $("#set-work-start").value = resolved.work_start;
    $("#set-work-end").value = resolved.work_end;

    const picker = $("#set-workdays");
    if (!picker.dataset.filled) {
      picker.innerHTML = DAY_NAMES.map((name, index) => `<button type="button" data-day="${index}">${name}</button>`).join("");
      picker.dataset.filled = "1";
      picker.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-day]");
        if (button) button.classList.toggle("on");
      });
    }
    $$("#set-workdays button").forEach((button) => {
      button.classList.toggle("on", resolved.work_days.includes(Number(button.dataset.day)));
    });

    $("#set-browser-notif").checked = !!prefs.browser_notifications;
    $("#set-email-notif").checked = !!prefs.email_reminders;
    $("#set-email-notif").disabled = !resolved.email_available;
    $("#email-hint").textContent = resolved.email_available
      ? "(SMTP configured)"
      : "(add SMTP_USER / SMTP_PASSWORD to .env to enable)";
    $("#notif-perm").textContent =
      typeof Notification === "undefined"
        ? "(not supported by this browser)"
        : `(permission: ${Notification.permission})`;

    setSelect("#reco-duration", prefs.default_duration || 30);
    setSelect("#reco-days", prefs.horizon_days || 10);

    const google = App.state.google;
    $("#source-panel").innerHTML = [
      row("Mailbox", App.state.owner_email),
      row("Data source", { google: "Google Calendar (live)", demo: "Sample calendar", empty: "Nothing tracked" }[App.state.data_mode]),
      row("Google client", google.configured ? "Configured" : "Not configured"),
      row("Connection", google.connected ? "Connected" : "Not connected"),
      row("Status", google.hint),
      row("Events stored", String(App.state.sync.count)),
      row("Last sync", App.state.sync.last_sync_label),
      row("Timezone", resolved.timezone),
    ].join("");

    $("#btn-disconnect").disabled = !google.connected;
    $("#redirect-uri").textContent = window.location.origin + "/auth/callback";

    function row(key, value) {
      return `<div class="source-row"><span class="k">${esc(key)}</span><span class="v">${esc(value)}</span></div>`;
    }
    function setSelect(selector, value) {
      const el = $(selector);
      const target = String(value);
      if ($$("option", el).some((option) => option.value === target)) el.value = target;
    }
  }

  async function saveSettings() {
    const days = $$("#set-workdays button.on").map((button) => Number(button.dataset.day));
    const payload = {
      timezone: $("#set-timezone").value,
      reminder_minutes: Number($("#set-reminder").value),
      buffer_minutes: Number($("#set-buffer").value),
      work_start: $("#set-work-start").value || "09:00",
      work_end: $("#set-work-end").value || "17:30",
      work_days: days.length ? days : [0, 1, 2, 3, 4],
      browser_notifications: $("#set-browser-notif").checked,
      email_reminders: $("#set-email-notif").checked,
      default_duration: Number($("#reco-duration").value),
      horizon_days: Number($("#reco-days").value),
    };

    if (payload.browser_notifications && typeof Notification !== "undefined" && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch (_) { /* ignore */ }
    }

    const result = await api("/api/preferences", { method: "POST", body: JSON.stringify(payload) });
    if (result.ok) {
      toast("Settings saved", "Reminders and recommendations now use your new preferences.", "success");
      await refresh();
    } else {
      toast("Could not save settings", result.message, "error");
    }
  }

  /* --------------------------------------------------------- notifications */

  function renderNotifications() {
    const items = App.state.notifications || [];
    const unseen = items.filter((n) => !n.seen);
    const badge = $("#bell-badge");
    badge.textContent = unseen.length;
    badge.classList.toggle("hidden", unseen.length === 0);

    $("#drawer-list").innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<div class="notif ${item.seen ? "" : "unseen"} ${item.is_conflict ? "conflict" : ""}">` +
              `<button class="n-close" data-dismiss="${item.id}" title="Dismiss">&times;</button>` +
              `<div class="n-title">${esc(item.title)}</div>` +
              `<div class="n-body">${esc(item.body)}</div>` +
              (item.payload && item.payload.meet_link
                ? `<a class="n-join" href="${esc(item.payload.meet_link)}" target="_blank" rel="noreferrer">Join the call &rarr;</a>`
                : "") +
              `<div class="n-time">${esc(item.created_label)}</div>` +
              `</div>`
          )
          .join("")
      : emptyState("&#128276;", "No notifications", "Reminders appear here 30 minutes before each meeting.");

    // Fire toasts + desktop notifications for anything brand new.
    items.forEach((item) => {
      if (App.toastedNotificationIds.has(item.id) || item.seen) return;
      App.toastedNotificationIds.add(item.id);
      if (App.firstLoad) return; // don't spam a wall of toasts on initial load
      toast(item.title, item.body, item.is_conflict ? "error" : "reminder", {
        sticky: true,
        link: item.payload && item.payload.meet_link,
      });
      desktopNotify(item);
    });
  }

  function desktopNotify(item) {
    if (!App.state.preferences.browser_notifications) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const notification = new Notification(item.title, { body: item.body, tag: "mm-" + item.id });
      notification.onclick = () => {
        window.focus();
        if (item.payload && item.payload.meet_link) window.open(item.payload.meet_link, "_blank");
      };
    } catch (_) { /* some browsers block constructor notifications */ }
  }

  async function markVisibleSeen() {
    const unseen = (App.state.notifications || []).filter((n) => !n.seen).map((n) => n.id);
    if (!unseen.length) return;
    await api("/api/notifications/seen", { method: "POST", body: JSON.stringify({ ids: unseen }) });
    App.state.notifications.forEach((n) => { n.seen = true; });
    renderNotifications();
  }

  /* ------------------------------------------------------------ next-up bar */

  function tick() {
    const next = App.state && App.state.stats && App.state.stats.next_event;
    const titleEl = $("#next-up-title");
    const countEl = $("#next-up-countdown");
    if (!next) {
      titleEl.textContent = "—";
      countEl.textContent = "No upcoming meetings";
      countEl.className = "countdown";
      return;
    }
    titleEl.textContent = next.summary;
    const start = new Date(next.local_start).getTime();
    const end = new Date(next.local_end).getTime();
    const now = Date.now();

    if (now >= start && now < end) {
      countEl.textContent = "Happening now · ends in " + humanDuration((end - now) / 1000);
      countEl.className = "countdown live";
    } else if (now >= end) {
      countEl.textContent = "Just finished";
      countEl.className = "countdown";
    } else {
      const seconds = (start - now) / 1000;
      countEl.textContent = "starts in " + humanDuration(seconds);
      countEl.className = "countdown" + (seconds <= App.reminderSeconds ? " urgent" : "");
    }
  }

  /* ----------------------------------------------------------------- modal */

  function openEventModal(eventId) {
    const event = (App.state.events || []).find((e) => e.id === eventId);
    if (!event) return;
    const conflictsWith = [];
    App.state.conflicts.forEach((group) => {
      if (group.events.some((e) => e.id === eventId)) {
        group.events.filter((e) => e.id !== eventId).forEach((e) => conflictsWith.push(e));
      }
    });

    const rows = [];
    rows.push(detail("When", `${event.day_label} · ${event.time_label}`));
    if (!event.all_day) rows.push(detail("Duration", event.duration_label));
    rows.push(detail("Calendar", event.calendar_name));
    if (event.location) rows.push(detail("Location", event.location));
    if (event.organizer_name || event.organizer_email) {
      rows.push(detail("Organiser", event.organizer_name || event.organizer_email));
    }
    if (event.meet_link) {
      rows.push(detail("Video call", `<a href="${esc(event.meet_link)}" target="_blank" rel="noreferrer">${esc(event.meet_link)}</a>`, true));
    }
    if (event.attendees && event.attendees.length) {
      const chips = event.attendees
        .map((a) => `<span class="attendee-chip ${a.response === "declined" ? "declined" : ""}">${esc(a.name || a.email)}</span>`)
        .join("");
      rows.push(detail("Attendees", `<div class="attendee-chips">${chips}</div>`, true));
    }
    rows.push(detail("Your response", event.response_status));
    if (conflictsWith.length) {
      rows.push(
        detail(
          "Conflicts with",
          conflictsWith.map((e) => `<div style="color:var(--danger)">&#9888; ${esc(e.summary)} (${esc(e.time_label)})</div>`).join(""),
          true
        )
      );
    }
    if (event.description) {
      rows.push(detail("Notes", esc(event.description).slice(0, 600), true));
    }
    if (event.html_link) {
      rows.push(detail("Link", `<a href="${esc(event.html_link)}" target="_blank" rel="noreferrer">Open in Google Calendar &rarr;</a>`, true));
    }

    $("#modal-body").innerHTML =
      `<h2>${esc(event.summary)}</h2>` +
      `<p class="muted small" style="margin:0 0 14px">${esc(event.calendar_name)}</p>` +
      rows.join("");
    $("#modal-backdrop").classList.remove("hidden");

    function detail(key, value, raw) {
      return `<div class="detail-row"><span class="k">${esc(key)}</span><span class="v">${raw ? value : esc(value)}</span></div>`;
    }
  }

  /* ------------------------------------------------------------- view swap */

  const VIEW_META = {
    dashboard: ["Dashboard", "Live overview of every meeting on your mailbox"],
    agenda: ["All meetings", "Every tracked meeting, grouped by day"],
    timeline: ["Day timeline", "See exactly where meetings overlap"],
    conflicts: ["Conflicts", "Double bookings and back-to-back crunches"],
    recommend: ["Find a slot", "Best times to schedule your next meeting"],
    settings: ["Settings", "Reminders, working hours and data source"],
  };

  function switchView(view) {
    App.view = view;
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    $$(".view").forEach((section) => section.classList.toggle("active", section.id === "view-" + view));
    const meta = VIEW_META[view] || ["MeetManager", ""];
    $("#view-title").textContent = meta[0];
    $("#view-subtitle").textContent = meta[1];
    if (view === "recommend" && !$("#reco-list").children.length) fetchRecommendations();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------------------------------------------------------------- actions */

  function connectGoogle() {
    if (App.state && App.state.google && !App.state.google.configured) {
      switchView("settings");
      toast("Google client not configured", App.state.google.hint, "error", { sticky: true });
      return;
    }
    window.location.href = "/auth/login";
  }

  async function loadDemo() {
    toast("Loading sample calendar…", "", "info");
    const result = await api("/api/demo/load", { method: "POST" });
    if (result.ok) {
      App.firstLoad = true; // suppress the initial toast storm
      await refresh();
      App.firstLoad = false;
      toast("Sample calendar loaded", result.message + " A reminder will fire shortly.", "success");
    } else {
      toast("Could not load sample data", result.message, "error");
    }
  }

  async function doSync() {
    const button = $("#btn-sync");
    button.disabled = true;
    button.textContent = "Syncing…";
    const result = await api("/api/sync", { method: "POST" });
    button.disabled = false;
    button.innerHTML = "&#8635; Sync";
    if (result.ok) {
      await refresh();
      toast("Calendar synced", result.message, "success");
    } else if (result.reason === "not_connected") {
      toast("Not connected yet", result.message, "info");
      switchView("settings");
    } else {
      toast("Sync failed", result.message, "error");
      await refresh();
    }
  }

  function googleCalendarLink(localStart, localEnd) {
    const fmt = (iso) => {
      const d = new Date(iso);
      return (
        d.getUTCFullYear().toString() +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        String(d.getUTCDate()).padStart(2, "0") + "T" +
        String(d.getUTCHours()).padStart(2, "0") +
        String(d.getUTCMinutes()).padStart(2, "0") + "00Z"
      );
    };
    return (
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" +
      encodeURIComponent("New meeting") +
      "&dates=" + fmt(localStart) + "/" + fmt(localEnd)
    );
  }

  /* ---------------------------------------------------------------- refresh */

  async function refresh(options) {
    const opts = options || {};
    const result = await api("/api/state" + (App.timelineDate ? "?day=" + App.timelineDate : ""));
    if (!result.ok) {
      toast("Could not refresh", result.message, "error");
      return;
    }
    App.state = result.state;
    App.reminderSeconds = (App.state.preferences.resolved.reminder_minutes || 30) * 60;

    $("#brand-email").textContent = App.state.owner_email;
    $("#btn-connect").classList.toggle("hidden", App.state.google.connected);

    const dot = $("#sync-dot");
    dot.className = "dot " + (App.state.sync.last_error ? "err" : App.state.google.connected ? "ok" : App.state.data_mode === "demo" ? "warn" : "");
    $("#sync-label").textContent = App.state.google.connected
      ? "Google · synced " + App.state.sync.last_sync_label
      : App.state.data_mode === "demo"
      ? "Sample data · not connected"
      : "Not connected";

    renderBanners();
    renderDashboard();
    renderAgenda();
    renderTimeline();
    renderConflicts();
    renderSettings();
    renderNotifications();
    tick();

    if (!opts.keepReco && App.view === "recommend") {
      renderRecommendations(App.state.recommendations, "No free slot matches your current settings.");
    } else if (!$("#reco-list").children.length) {
      renderRecommendations(App.state.recommendations, "No free slot matches your current settings.");
    }

    App.firstLoad = false;
  }

  async function pollNotifications() {
    const result = await api("/api/notifications");
    if (!result.ok || !App.state) return;
    App.state.notifications = result.notifications;
    renderNotifications();
  }

  /* ------------------------------------------------------------------ wire */

  function wire() {
    $("#nav").addEventListener("click", (event) => {
      const item = event.target.closest(".nav-item");
      if (item) switchView(item.dataset.view);
    });

    $("#btn-connect").addEventListener("click", connectGoogle);
    $("#btn-sync").addEventListener("click", doSync);
    $("#btn-demo").addEventListener("click", loadDemo);

    $("#btn-clear").addEventListener("click", async () => {
      if (!window.confirm("Remove every tracked meeting from this app? Your Google Calendar is not modified.")) return;
      const result = await api("/api/data/clear", { method: "POST" });
      await refresh();
      toast(result.ok ? "Cleared" : "Could not clear", result.message, result.ok ? "success" : "error");
    });

    $("#btn-disconnect").addEventListener("click", async () => {
      if (!window.confirm("Disconnect this app from your Google account?")) return;
      const result = await api("/auth/logout", { method: "POST" });
      await refresh();
      toast(result.ok ? "Disconnected" : "Error", result.message, result.ok ? "success" : "error");
    });

    $("#btn-theme").addEventListener("click", () => {
      const root = document.documentElement;
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      $("#btn-theme").innerHTML = next === "dark" ? "&#9789;" : "&#9788;";
      try { localStorage.setItem("mm-theme", next); } catch (_) {}
      api("/api/preferences", { method: "POST", body: JSON.stringify({ theme: next }) });
    });

    // Notification drawer
    const openDrawer = () => {
      $("#drawer").classList.remove("hidden");
      $("#drawer-backdrop").classList.remove("hidden");
      markVisibleSeen();
    };
    const closeDrawer = () => {
      $("#drawer").classList.add("hidden");
      $("#drawer-backdrop").classList.add("hidden");
    };
    $("#btn-bell").addEventListener("click", openDrawer);
    $("#btn-close-drawer").addEventListener("click", closeDrawer);
    $("#drawer-backdrop").addEventListener("click", closeDrawer);
    $("#btn-dismiss-all").addEventListener("click", async () => {
      await api("/api/notifications/dismiss-all", { method: "POST" });
      await pollNotifications();
    });
    $("#drawer-list").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-dismiss]");
      if (!button) return;
      await api(`/api/notifications/${button.dataset.dismiss}/dismiss`, { method: "POST" });
      await pollNotifications();
    });

    // Modal
    $("#modal-close").addEventListener("click", () => $("#modal-backdrop").classList.add("hidden"));
    $("#modal-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "modal-backdrop") $("#modal-backdrop").classList.add("hidden");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        $("#modal-backdrop").classList.add("hidden");
        closeDrawer();
      }
    });

    // Delegated clicks: event cards, timeline blocks, day jumps, booking links
    document.addEventListener("click", (event) => {
      const card = event.target.closest("[data-event-id]");
      if (card && !event.target.closest("a")) {
        openEventModal(card.dataset.eventId);
        return;
      }
      const goto = event.target.closest("[data-goto-day]");
      if (goto) {
        App.timelineDate = goto.dataset.gotoDay;
        switchView("timeline");
        refresh({ keepReco: true });
        return;
      }
      const book = event.target.closest("[data-gcal]");
      if (book) {
        const [start, end] = book.dataset.gcal.split("|");
        window.open(googleCalendarLink(start, end), "_blank", "noopener");
      }
    });

    // Agenda filters
    $("#agenda-search").addEventListener("input", (event) => {
      App.agendaSearch = event.target.value;
      renderAgenda();
    });
    $("#agenda-filter").addEventListener("change", (event) => {
      App.agendaFilter = event.target.value;
      renderAgenda();
    });

    // Timeline navigation
    const goToDay = (iso) => {
      App.timelineDate = iso;
      refresh({ keepReco: true });
    };
    $("#tl-prev").addEventListener("click", () => goToDay(shiftISO(App.state.timeline.date, -1)));
    $("#tl-next").addEventListener("click", () => goToDay(shiftISO(App.state.timeline.date, 1)));
    $("#tl-today").addEventListener("click", () => goToDay(todayISO()));
    $("#tl-date").addEventListener("change", (event) => { if (event.target.value) goToDay(event.target.value); });

    // Recommendations
    $("#btn-reco").addEventListener("click", fetchRecommendations);
    ["#reco-duration", "#reco-days", "#reco-limit"].forEach((selector) =>
      $(selector).addEventListener("change", fetchRecommendations)
    );

    // Settings
    $("#btn-save-settings").addEventListener("click", saveSettings);
    $("#btn-test-notif").addEventListener("click", async () => {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (_) {}
        renderSettings();
      }
      toast(
        "Test reminder",
        `This is what a ${App.state.preferences.resolved.reminder_minutes}-minute reminder looks like.`,
        "reminder",
        { sticky: false }
      );
      desktopNotify({
        id: "test",
        title: "MeetManager test reminder",
        body: "Reminders are working. Real ones fire " + App.state.preferences.resolved.reminder_minutes + " minutes before each meeting.",
        payload: {},
      });
    });
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    try {
      const savedTheme = localStorage.getItem("mm-theme");
      if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    } catch (_) {}
    $("#btn-theme").innerHTML = document.documentElement.dataset.theme === "dark" ? "&#9789;" : "&#9788;";
    $("#tl-date").value = todayISO();

    wire();
    await refresh();

    // Request notification permission once, quietly, after the UI settles.
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default" &&
      App.state && App.state.preferences.browser_notifications
    ) {
      setTimeout(() => { Notification.requestPermission().then(renderSettings).catch(() => {}); }, 2500);
    }

    App.tickTimer = setInterval(tick, 1000);
    App.pollTimer = setInterval(pollNotifications, 15000);
    setInterval(() => refresh({ keepReco: true }), 120000);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollNotifications();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
