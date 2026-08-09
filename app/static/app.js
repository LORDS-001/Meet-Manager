/* ==========================================================================
   MeetManager - front-end
   Vanilla ES2020, no build step. Talks to the FastAPI JSON API in main.py.
   Every render is defensive: a missing or malformed field degrades to a dash
   rather than throwing, so a bad payload can never blank the page.
   ========================================================================== */
(function () {
  "use strict";

  // ----------------------------------------------------------------- utils
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : (f || 0));
  const delay = (i, step) => `--d:${Math.min(i * (step || 35), 300)}ms`;
  const pad2 = (n) => String(n).padStart(2, "0");

  function humanMinutes(mins) {
    const m = Math.max(0, Math.round(num(mins, 0)));
    if (!m) return "0m";
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h && r) return `${h}h ${r}m`;
    if (h) return `${h}h`;
    return `${r}m`;
  }

  function initials(v) {
    const raw = String(v || "").trim();
    if (!raw) return "?";
    const local = raw.includes("@") ? raw.split("@")[0] : raw;
    const parts = local.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
    return local.slice(0, 2);
  }

  function toKey(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const todayKey = () => toKey(new Date());
  const parseLocal = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  /** Segmented meter: `on` of `total` bars lit. */
  function meter(pct, tone) {
    const total = 10;
    const on = clamp(Math.round((num(pct, 0) / 100) * total), 0, total);
    let out = '<div class="meter">';
    for (let i = 0; i < total; i += 1) {
      out += `<i class="${i < on ? (tone === "warn" ? "is-warn" : "is-on") : ""}"></i>`;
    }
    return out + "</div>";
  }

  // ------------------------------------------------------------- app state
  const body = document.body;
  const OWNER = body.dataset.owner || "";
  const TZ_HINT = body.dataset.timezone || "UTC";

  const store = {
    state: null,
    view: "dashboard",
    monthAnchor: new Date(),
    selectedDay: todayKey(),
    timelineDate: todayKey(),
    timeline: null,
    recommendations: [],
    query: "",
    filter: "upcoming",
    taskFilter: "open",
    seenNotifIds: new Set(),
    lastError: null,
  };

  const VIEWS = [
    { id: "dashboard", label: "Overview", icon: "grid", eyebrow: "MM / OVERVIEW", title: "Meeting control" },
    { id: "meetings", label: "Register", icon: "list", eyebrow: "MM / REGISTER", title: "Every meeting" },
    { id: "tasks", label: "Tasks", icon: "task", eyebrow: "MM / TASKS", title: "Task manager", badge: true },
    { id: "timeline", label: "Timeline", icon: "clock", eyebrow: "MM / TIMELINE", title: "Day timeline" },
    { id: "conflicts", label: "Conflicts", icon: "alert", eyebrow: "MM / CONFLICTS", title: "Double bookings", badge: true },
    { id: "slots", label: "Slot finder", icon: "sparkle", eyebrow: "MM / SCHEDULER", title: "Find a slot" },
  ];
  const SETTINGS_META = { eyebrow: "MM / CONFIG", title: "Settings" };

  // ------------------------------------------------------------------- api
  async function api(path, options) {
    const opts = Object.assign({ headers: { "Content-Type": "application/json" } }, options || {});
    try {
      const res = await fetch(path, opts);
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") {
        return { ok: false, message: "The server sent a response we could not read." };
      }
      return data;
    } catch (err) {
      return { ok: false, offline: true, message: "Cannot reach MeetManager. Is the server still running?" };
    }
  }
  const post = (path, payload, method) =>
    api(path, { method: method || "POST", body: JSON.stringify(payload == null ? {} : payload) });

  // ---------------------------------------------------------------- toasts
  function toast(message, kind) {
    const host = $("#toasts");
    if (!host) return;
    const node = document.createElement("div");
    node.className = "toast" + (kind ? ` is-${kind}` : "");
    const glyph = kind === "danger" ? "alert" : kind === "good" ? "check" : "bell";
    node.innerHTML = `${icon(glyph)}<span>${esc(message)}</span>`;
    host.appendChild(node);
    const kill = () => {
      node.classList.add("is-out");
      setTimeout(() => node.remove(), 220);
    };
    setTimeout(kill, 4200);
    node.addEventListener("click", kill);
  }

  // --------------------------------------------------------------- banners
  const dismissedBanners = new Set();

  function renderBanners() {
    const host = $("#banners");
    if (!host) return;
    const items = [];
    const s = store.state;

    if (store.lastError) {
      items.push({ id: "app-error", kind: "danger", icon: "alert", title: "Something went wrong", body: store.lastError });
    }
    if (s) {
      if (s.sync && s.sync.last_error) {
        items.push({ id: "sync-error", kind: "warn", icon: "refresh", title: "Last calendar sync failed", body: s.sync.last_error });
      }
      const g = s.google || {};
      if (!g.connected && s.data_mode === "empty") {
        items.push({
          id: "connect", kind: "info", icon: "google",
          title: "No calendar connected",
          body: g.hint || "Connect Google Calendar, or load the sample calendar to explore the app.",
          action: { label: "Load sample", id: "banner-demo" },
        });
      } else if (s.data_mode === "demo") {
        items.push({
          id: "demo", kind: "info", icon: "sparkle",
          title: "Sample data",
          body: "These meetings are generated locally. Connect Google Calendar to see your real schedule.",
        });
      }
    }

    const visible = items.filter((i) => !dismissedBanners.has(i.id));
    host.innerHTML = visible
      .map(
        (item) => `<div class="banner is-${item.kind}">
          ${icon(item.icon)}
          <div>
            <span class="micro micro-bright">${esc(item.title)}</span>
            <p>${esc(item.body)}</p>
          </div>
          ${item.action ? `<button class="pill sm" id="${esc(item.action.id)}" type="button">${esc(item.action.label)}</button>` : ""}
          <button class="notif-x" data-dismiss-banner="${esc(item.id)}" type="button" aria-label="Dismiss">${icon("close")}</button>
        </div>`
      )
      .join("");

    const demoBtn = $("#banner-demo");
    if (demoBtn) demoBtn.addEventListener("click", loadDemo);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dismiss-banner]");
    if (!btn) return;
    dismissedBanners.add(btn.dataset.dismissBanner);
    renderBanners();
  });

  // ----------------------------------------------------------------- theme
  function applyTheme(theme, persist) {
    const value = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = value;
    if (persist) {
      try { localStorage.setItem("mm-theme", value); } catch (e) { /* private mode */ }
    }
    const use = $("#btn-theme use");
    if (use) use.setAttribute("href", value === "dark" ? "#i-sun" : "#i-moon");
    const btn = $("#btn-theme");
    if (btn) btn.dataset.tip = value === "dark" ? "Light mode" : "Dark mode";
  }

  // ------------------------------------------------------------------ nav
  function renderNav() {
    const taskStats = (store.state && store.state.task_stats) || {};
    const counts = {
      meetings: store.state ? (store.state.upcoming || []).length : 0,
      conflicts: store.state ? (store.state.conflicts || []).length : 0,
      // Overdue is the only task number worth interrupting someone for.
      tasks: num(taskStats.overdue, 0),
    };
    const rail = $("#rail-nav");
    if (rail) {
      rail.innerHTML = VIEWS.map((v) => {
        const count = counts[v.id];
        const badge = v.badge && count > 0 ? `<span class="rail-count">${count}</span>` : "";
        return `<button class="rail-btn${store.view === v.id ? " is-active" : ""}" data-view="${v.id}"
                  type="button" data-tip="${esc(v.label)}" aria-label="${esc(v.label)}">${icon(v.icon)}${badge}</button>`;
      }).join("");
    }
    const settings = $("#rail-settings");
    if (settings) settings.classList.toggle("is-active", store.view === "settings");
  }

  function renderHead() {
    const meta = store.view === "settings" ? SETTINGS_META : VIEWS.find((v) => v.id === store.view) || VIEWS[0];
    const eyebrow = $("#head-eyebrow");
    const title = $("#head-title");
    const sub = $("#head-sub");
    if (eyebrow) eyebrow.textContent = meta.eyebrow;
    if (title) title.textContent = meta.title;
    if (!sub) return;

    const s = store.state;
    if (!s) { sub.textContent = "Reading your calendar…"; return; }
    const stats = s.stats || {};

    switch (store.view) {
      case "meetings":
        sub.textContent = `Every meeting MeetManager is tracking on ${OWNER}, newest first.`;
        break;
      case "tasks": {
        const t = s.task_stats || {};
        const overdue = num(t.overdue, 0);
        if (overdue) sub.textContent = `${overdue} task${overdue === 1 ? "" : "s"} past their deadline, ${num(t.open, 0)} open in total.`;
        else if (num(t.open, 0)) sub.textContent = `${num(t.open, 0)} open task${num(t.open, 0) === 1 ? "" : "s"}, ${num(t.due_today, 0)} due today. Nothing overdue.`;
        else sub.textContent = "Nothing open. Add a task, or connect a platform to mirror one.";
        break;
      }
      case "timeline":
        sub.textContent = "Lane-packed day view. Overlapping meetings sit side by side.";
        break;
      case "conflicts":
        sub.textContent = num(stats.conflict_groups, 0)
          ? `${num(stats.conflict_groups, 0)} clash${num(stats.conflict_groups, 0) === 1 ? "" : "es"} affecting ${num(stats.conflict_events, 0)} meetings.`
          : "Nothing overlaps. Every meeting has the room to itself.";
        break;
      case "slots":
        sub.textContent = "Free slots scored against your working hours, buffer and meeting load.";
        break;
      case "settings":
        sub.textContent = "These drive the reminder engine and every slot suggestion.";
        break;
      default: {
        const today = num(stats.today_count, 0);
        const clashes = num(stats.conflict_groups, 0);
        if (clashes) sub.textContent = `${clashes} double booking${clashes === 1 ? "" : "s"} need attention. ${today} meeting${today === 1 ? "" : "s"} on today's schedule.`;
        else if (!today) sub.textContent = `Nothing booked today. ${num(stats.week_count, 0)} meeting${num(stats.week_count, 0) === 1 ? "" : "s"} across the week ahead.`;
        else sub.textContent = `${today} meeting${today === 1 ? "" : "s"} today, ${stats.today_label || "0m"} booked. No clashes detected.`;
      }
    }
  }

  function renderMetaStrip() {
    const host = $("#meta-strip");
    if (!host) return;
    const s = store.state;
    if (!s) { host.innerHTML = ""; return; }
    const stats = s.stats || {};
    const sync = s.sync || {};
    const mode = s.data_mode === "google" ? "GOOGLE LIVE" : s.data_mode === "demo" ? "SAMPLE DATA" : "NO SOURCE";

    const tstats = s.task_stats || {};
    const cells = [
      ["Tracked", num(sync.count, 0), false],
      ["Today", `${num(stats.today_count, 0)} / ${stats.today_label || "0m"}`, false],
      ["This week", `${num(stats.week_count, 0)} / ${stats.week_label || "0m"}`, false],
      ["Clashes", num(stats.conflict_groups, 0), num(stats.conflict_groups, 0) > 0],
      ["Tasks open", num(tstats.open, 0), false],
      ["Overdue", num(tstats.overdue, 0), num(tstats.overdue, 0) > 0],
      ["Timezone", s.timezone || TZ_HINT, false],
      ["Synced", sync.last_sync_label || "never", false],
    ];

    host.innerHTML =
      cells
        .map(([k, v, red]) => `<span class="meta"><span class="micro micro-sm">${esc(k)}</span><b class="${red ? "is-red" : ""}">${esc(v)}</b></span>`)
        .join("") +
      `<span class="meta-right"><span class="rail-dot"></span><span class="micro micro-sm micro-red">${esc(mode)}</span></span>`;
  }

  function setView(id) {
    if (!id) return;
    const known = VIEWS.some((v) => v.id === id) || id === "settings";
    store.view = known ? id : "dashboard";
    $$(".view").forEach((sec) => sec.classList.toggle("is-active", sec.id === `view-${store.view}`));
    renderNav();
    renderHead();
    const page = $("#page");
    if (page) page.scrollTop = 0;
    if (store.view === "timeline") loadTimeline(store.timelineDate);
    if (store.view === "slots" && !store.recommendations.length) loadRecommendations();
  }

  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-view]");
    if (nav) setView(nav.dataset.view);
  });

  // ============================================================ components
  function emptyState(glyph, title, text, action) {
    return `<div class="empty">
      ${icon(glyph)}
      <strong>${esc(title)}</strong>
      ${text ? `<p>${esc(text)}</p>` : ""}
      ${action ? `<button class="pill sm" data-view="${esc(action.view)}" type="button">${esc(action.label)}</button>` : ""}
    </div>`;
  }

  const skeleton = () => `<div class="skel"><div class="skel-line"></div><div class="skel-line"></div><div class="skel-line"></div></div>`;

  /** A meeting row in the six-column register table. */
  function eventRow(ev, i, opts) {
    const o = opts || {};
    const start = parseLocal(ev.local_start);
    const end = parseLocal(ev.local_end);
    const now = new Date();
    const live = start && end && start <= now && now < end;
    const done = end && end < now;

    let state = "Scheduled";
    let tone = "";
    if (ev.in_conflict) { state = "Clash"; tone = "is-red"; }
    else if (live) { state = "In progress"; tone = "is-red"; }
    else if (done) { state = "Done"; }
    else if (ev.response_status === "declined") { state = "Declined"; }
    else if (ev.all_day) { state = "All day"; }
    else { tone = "is-good"; }

    const subBits = [];
    if (ev.calendar_name) subBits.push(ev.calendar_name);
    if (num(ev.attendee_count, 0)) subBits.push(`${num(ev.attendee_count, 0)} people`);
    if (ev.has_meet) subBits.push("video");
    if (ev.location) subBits.push(ev.location);

    return `<button class="row rise${live ? " is-live" : ""}" style="${delay(i)}" data-event="${esc(ev.id)}" type="button">
      <span class="row-index">${pad2(i + 1)}</span>
      <span>
        <span class="row-name">${esc(ev.summary || "(no title)")}</span>
        <span class="row-sub">${esc(subBits.join(" / ") || "no details")}</span>
      </span>
      <span class="row-cell is-dim">${esc(o.showDay === false ? "" : ev.day_label || "")}</span>
      <span><span class="state ${tone}">${esc(state)}</span></span>
      <span class="row-cell is-mono">${esc(ev.time_label || "")}</span>
      <span class="row-end"><span class="go-btn">${icon("arrow")}</span></span>
    </button>`;
  }

  // ============================================================= DASHBOARD
  function renderStatCards() {
    const host = $("#stat-cards");
    if (!host) return;
    const s = store.state;
    if (!s) {
      host.innerHTML = Array.from({ length: 4 })
        .map(() => `<div class="stat-card"><div class="skel-line"></div></div>`)
        .join("");
      return;
    }

    const stats = s.stats || {};
    const resolved = (s.preferences && s.preferences.resolved) || {};
    const toMins = (hhmm) => {
      const p = String(hhmm || "09:00").split(":");
      return num(p[0], 9) * 60 + num(p[1], 0);
    };
    const dayCap = Math.max(60, toMins(resolved.work_end || "17:30") - toMins(resolved.work_start || "09:00"));
    const workDays = Array.isArray(resolved.work_days) && resolved.work_days.length ? resolved.work_days.length : 5;

    const conflicts = num(stats.conflict_groups, 0);
    const slots = (s.recommendations || []).length;

    const cards = [
      {
        view: "timeline", label: "Today",
        value: num(stats.today_count, 0),
        note: stats.today_label ? `${stats.today_label} booked` : "nothing booked",
        pct: (num(stats.today_minutes, 0) / dayCap) * 100,
        load: true,
      },
      {
        view: "meetings", label: "This week",
        value: num(stats.week_count, 0),
        note: stats.week_label ? `${stats.week_label} in meetings` : "a clear week",
        pct: (num(stats.week_minutes, 0) / (dayCap * workDays)) * 100,
        load: true,
      },
      {
        view: "conflicts", label: "Clashes",
        value: conflicts,
        note: conflicts ? `${num(stats.conflict_events, 0)} meetings affected` : "nothing overlaps",
        pct: conflicts ? 100 : 0,
        alert: conflicts > 0,
      },
      {
        view: "slots", label: "Free slots",
        value: slots,
        note: (s.recommendations || [])[0] ? `best ${(s.recommendations[0].score || 0)}/100` : "widen your hours",
        pct: (s.recommendations || [])[0] ? num(s.recommendations[0].score, 0) : 0,
      },
      {
        view: "tasks", label: "Tasks open",
        value: num((s.task_stats || {}).open, 0),
        note: num((s.task_stats || {}).overdue, 0)
          ? `${num((s.task_stats || {}).overdue, 0)} overdue`
          : `${num((s.task_stats || {}).due_today, 0)} due today`,
        pct: num((s.task_stats || {}).completion_pct, 0),
        alert: num((s.task_stats || {}).overdue, 0) > 0,
      },
    ];

    host.innerHTML = cards
      .map(
        (c, i) => `<button class="stat-card${c.alert ? " is-alert" : ""}" style="${delay(i, 55)}" data-view="${c.view}" type="button">
          <span class="micro">${esc(c.label)}</span>
          <div class="stat-value">${esc(c.value)}</div>
          <div class="stat-note">${esc(c.note)}</div>
          ${meter(clamp(c.pct, 0, 100), c.load && c.pct > 85 ? "warn" : null)}
        </button>`
      )
      .join("");
  }

  function renderUpNext() {
    const host = $("#dash-upnext");
    const count = $("#upnext-count");
    if (!host) return;
    const items = (store.state && store.state.upcoming) || [];
    if (count) count.textContent = items.length ? `${items.length} queued` : "empty";
    if (!items.length) {
      host.innerHTML = emptyState("calendar", "Nothing scheduled", "No upcoming meetings on this calendar.", { view: "slots", label: "Find a slot" });
      return;
    }
    host.innerHTML = items.slice(0, 8).map((ev, i) => eventRow(ev, i)).join("");
  }

  function renderTodayList() {
    const host = $("#today-list");
    const chip = $("#today-chip");
    if (!host) return;
    const key = todayKey();
    const items = ((store.state && store.state.events) || [])
      .filter((ev) => ev.date_key === key && !ev.all_day)
      .sort((a, b) => String(a.local_start).localeCompare(String(b.local_start)));

    if (chip) {
      const stats = (store.state && store.state.stats) || {};
      chip.textContent = items.length ? `${items.length} / ${stats.today_label || "0m"}` : "clear";
    }
    if (!items.length) {
      host.innerHTML = emptyState("check", "No meetings today", "A completely clear day.");
      return;
    }
    host.innerHTML = items.map((ev, i) => eventRow(ev, i, { showDay: false })).join("");
  }

  function renderDashNotifications() {
    const host = $("#dash-notifs");
    if (!host) return;
    const items = (store.state && store.state.notifications) || [];
    if (!items.length) {
      host.innerHTML = emptyState("bell", "All clear", "Reminders appear here before a meeting starts.");
      return;
    }
    host.innerHTML = items.slice(0, 5).map((n, i) => notifRow(n, i)).join("");
  }

  function notifRow(n, i) {
    return `<div class="notif${n.seen ? "" : " is-unseen"}" style="${delay(i, 45)}">
      <span class="notif-icon${n.is_conflict ? " is-clash" : ""}">${icon(n.is_conflict ? "alert" : "bell")}</span>
      <span class="notif-main">
        <strong>${esc(n.title)}</strong>
        <p>${esc(n.body)}</p>
        <span class="notif-time">${esc(n.created_label || "")}</span>
      </span>
      <button class="notif-x" data-dismiss-notif="${esc(n.id)}" type="button" aria-label="Dismiss">${icon("close")}</button>
    </div>`;
  }

  function renderNextMeeting() {
    const host = $("#next-meeting-card");
    if (!host) return;
    const next = store.state && store.state.stats && store.state.stats.next_event;
    if (!next) {
      host.innerHTML = `<span class="micro">Next meeting</span>${emptyState("check", "Nothing coming up", "Your calendar is clear from here.")}`;
      return;
    }
    const facts = [];
    if (next.day_label) facts.push(`<span>${icon("calendar")}${esc(next.day_label)}</span>`);
    facts.push(`<span>${icon("clock")}${esc(next.time_label || "")}</span>`);
    if (num(next.attendee_count, 0)) facts.push(`<span>${icon("users")}${num(next.attendee_count, 0)}</span>`);
    if (next.location) facts.push(`<span>${icon("pin")}${esc(next.location)}</span>`);

    host.innerHTML = `
      <span class="micro">Next meeting</span>
      <div class="next-name">${esc(next.summary || "(no title)")}</div>
      <div class="next-facts">${facts.join("")}</div>
      <div class="next-count" id="next-countdown" data-start="${esc(next.local_start)}" data-end="${esc(next.local_end)}">${esc(next.starts_in_label || "")}</div>
      <div class="next-actions">
        ${next.meet_link ? `<a class="pill pill-red sm" href="${esc(next.meet_link)}" target="_blank" rel="noreferrer">${icon("video")}<span>Join</span></a>` : ""}
        <button class="pill sm" data-event="${esc(next.id)}" type="button">Details</button>
      </div>`;
  }

  // ================================================================= TASKS
  const URGENCY_TONE = { overdue: "is-red", today: "is-warn", week: "", later: "", someday: "", done: "is-good" };
  const URGENCY_LABEL = { overdue: "Overdue", today: "Due today", week: "This week", later: "Scheduled", someday: "No deadline", done: "Done" };

  function taskRow(task, i) {
    const urgency = task.urgency || "someday";
    const tone = URGENCY_TONE[urgency] || "";
    const label = task.is_done ? "Done" : URGENCY_LABEL[urgency] || "Open";

    const sub = [];
    if (task.notes) sub.push(String(task.notes).replace(/\s+/g, " ").slice(0, 90));
    if (task.list_name) sub.push(task.list_name);
    if ((task.tags || []).length) sub.push((task.tags || []).join(" · "));

    return `<button class="row rise${task.is_done ? " is-task-done" : ""}${urgency === "overdue" ? " is-overdue" : ""}"
              style="${delay(i)}" data-task="${esc(task.id)}" type="button">
      <span>
        <span class="task-check${task.is_done ? " is-done" : ""}" role="checkbox"
              aria-checked="${task.is_done}" data-toggle-task="${esc(task.id)}"
              title="${task.is_done ? "Reopen" : "Complete"}">${icon("check")}</span>
      </span>
      <span>
        <span class="row-name"><i class="prio p-${esc(task.priority || "normal")}"></i>${esc(task.title || "(untitled)")}</span>
        <span class="row-sub">${esc(sub.join(" / ") || "no details")}</span>
      </span>
      <span class="row-cell is-dim">${esc(task.due_short || "—")}</span>
      <span><span class="state ${tone}">${esc(label)}</span></span>
      <span class="row-cell is-dim">${esc(task.source_name || "Local")}</span>
      <span class="row-end"><span class="go-btn">${icon("arrow")}</span></span>
    </button>`;
  }

  function filterTasks() {
    const all = ((store.state && store.state.tasks) || []).slice();
    switch (store.taskFilter) {
      case "all": return all;
      case "overdue": return all.filter((t) => t.urgency === "overdue");
      case "today": return all.filter((t) => !t.is_done && t.urgency === "today");
      case "week": return all.filter((t) => !t.is_done && ["overdue", "today", "week"].includes(t.urgency));
      case "nodeadline": return all.filter((t) => !t.is_done && !t.due);
      case "done": return all.filter((t) => t.is_done);
      default: return all.filter((t) => !t.is_done);
    }
  }

  function renderTasks() {
    const host = $("#task-list");
    const summary = $("#task-summary");
    if (!host) return;
    if (!store.state) { host.innerHTML = skeleton(); return; }

    const items = filterTasks();
    const total = (store.state.tasks || []).length;
    if (summary) summary.textContent = `${items.length} / ${total}`;

    if (!items.length) {
      host.innerHTML = emptyState(
        "task",
        total ? "Nothing in this filter" : "No tasks yet",
        total ? "Switch the filter to see the rest." : "Add one here, or sync a connected platform to mirror its tasks."
      );
      return;
    }
    host.innerHTML = items.map((t, i) => taskRow(t, i)).join("");
  }

  function renderTaskStats() {
    const host = $("#task-stats");
    if (!host) return;
    const s = store.state;
    if (!s) { host.innerHTML = ""; return; }
    const t = s.task_stats || {};
    const open = num(t.open, 0);

    const cards = [
      { label: "Open", value: open, note: `${num(t.total, 0)} tracked in total`, pct: num(t.total, 0) ? (open / num(t.total, 1)) * 100 : 0 },
      { label: "Overdue", value: num(t.overdue, 0), note: num(t.overdue, 0) ? "past their deadline" : "nothing late", pct: open ? (num(t.overdue, 0) / open) * 100 : 0, alert: num(t.overdue, 0) > 0 },
      { label: "Due today", value: num(t.due_today, 0), note: `${num(t.due_week, 0)} within 7 days`, pct: open ? (num(t.due_today, 0) / open) * 100 : 0 },
      { label: "Completed", value: `${num(t.completion_pct, 0)}%`, note: `${num(t.done, 0)} finished`, pct: num(t.completion_pct, 0) },
    ];

    host.innerHTML = cards.map((c, i) => `
      <div class="stat-card${c.alert ? " is-alert" : ""}" style="${delay(i, 55)}">
        <span class="micro">${esc(c.label)}</span>
        <div class="stat-value">${esc(c.value)}</div>
        <div class="stat-note">${esc(c.note)}</div>
        ${meter(clamp(c.pct, 0, 100))}
      </div>`).join("");
  }

  function renderTaskSources() {
    const host = $("#task-sources");
    if (!host) return;
    const sources = (store.state && store.state.task_sources) || [];
    if (!sources.length) { host.innerHTML = ""; return; }

    host.innerHTML = `<div class="source-list">${sources.map((src) => `
      <div class="source-card">
        <span class="source-icon">${icon(src.key === "local" ? "task" : src.key.startsWith("google") ? "google" : "box")}</span>
        <div>
          <strong>${esc(src.name)}</strong>
          <p>${esc(src.last_error || src.hint || "")}</p>
        </div>
        <span class="state ${src.connected ? "is-good" : ""}">${
          src.key === "local"
            ? `${num(src.count, 0)} task${num(src.count, 0) === 1 ? "" : "s"}`
            : src.connected ? `${num(src.count, 0)} synced` : "Not connected"
        }</span>
      </div>`).join("")}</div>`;
  }

  // ---------------------------------------------------------- task modal
  function openTaskDetail(id) {
    const task = ((store.state && store.state.tasks) || []).find((t) => String(t.id) === String(id));
    if (!task) { toast("That task no longer exists.", "danger"); return; }

    const chips = [];
    const urgency = task.urgency || "someday";
    chips.push(`<span class="state ${URGENCY_TONE[urgency] || ""}">${esc(task.is_done ? "Done" : URGENCY_LABEL[urgency] || "Open")}</span>`);
    chips.push(`<span class="state">${esc(task.priority || "normal")} priority</span>`);
    if (!task.is_editable) chips.push(`<span class="state">Read-only mirror</span>`);

    const facts = [
      ["Deadline", esc(task.due_label || "No deadline")],
      ["Countdown", esc(task.countdown_label || "—")],
      ["Status", esc(task.status || "todo")],
      ["Source", esc(task.source_name || "Local") + (task.list_name ? ` / ${esc(task.list_name)}` : "")],
    ];
    if ((task.tags || []).length) facts.push(["Tags", esc((task.tags || []).join(", "))]);
    if (task.notes) facts.push(["Details", esc(task.notes)]);

    $("#modal-body").innerHTML = `
      <span class="micro">Task / ${esc(task.source_name || "Local")}</span>
      <h2 class="modal-title" id="modal-title">${esc(task.title || "(untitled)")}</h2>
      <div class="modal-chips">${chips.join("")}</div>
      <dl class="modal-facts">
        ${facts.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}
      </dl>
      <div class="modal-actions">
        <button class="pill pill-red sm" data-toggle-task="${esc(task.id)}" type="button">
          ${icon("check")}<span>${task.is_done ? "Reopen" : "Complete"}</span>
        </button>
        ${task.is_editable ? `<button class="pill sm" data-edit-task="${esc(task.id)}" type="button">${icon("edit")}<span>Edit</span></button>` : ""}
        ${task.is_editable ? `<button class="pill sm" data-delete-task="${esc(task.id)}" type="button">${icon("trash")}<span>Delete</span></button>` : ""}
        ${task.url ? `<a class="pill sm" href="${esc(task.url)}" target="_blank" rel="noreferrer">${icon("arrow")}<span>Open at source</span></a>` : ""}
      </div>`;
    $("#modal-scrim").classList.remove("is-hidden");
  }

  /** Turn a UTC ISO stamp into the value a datetime-local input expects. */
  function toLocalInput(iso) {
    const d = parseLocal(iso);
    if (!d) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function openTaskForm(id) {
    const task = id ? ((store.state && store.state.tasks) || []).find((t) => String(t.id) === String(id)) : null;
    const editing = !!task;

    $("#modal-body").innerHTML = `
      <span class="micro">${editing ? "Edit task" : "New task"}</span>
      <h2 class="modal-title" id="modal-title">${editing ? "Update this task" : "Add a task"}</h2>
      <form class="modal-form" id="task-form" novalidate>
        <label class="field">
          <span class="micro">Title</span>
          <input class="input" id="task-title" type="text" maxlength="300" required
                 placeholder="What needs doing?" value="${esc(task ? task.title : "")}" />
        </label>
        <label class="field">
          <span class="micro">Details</span>
          <textarea class="input" id="task-notes" maxlength="2000"
                    placeholder="A sentence or two of context">${esc(task ? task.notes : "")}</textarea>
        </label>
        <div class="form-pair">
          <label class="field">
            <span class="micro">Deadline</span>
            <input class="input" id="task-due" type="datetime-local" value="${esc(task ? toLocalInput(task.local_due || task.due) : "")}" />
          </label>
          <label class="field">
            <span class="micro">Priority</span>
            <select class="input" id="task-priority">
              ${["low", "normal", "high", "urgent"].map((p) =>
                `<option value="${p}"${task && task.priority === p ? " selected" : ""}>${p}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span class="micro">Status</span>
            <select class="input" id="task-status">
              ${["todo", "doing", "done"].map((st) =>
                `<option value="${st}"${task && task.status === st ? " selected" : ""}>${st}</option>`).join("")}
            </select>
          </label>
        </div>
        <label class="field">
          <span class="micro">Tags</span>
          <input class="input" id="task-tags" type="text" placeholder="comma, separated"
                 value="${esc(task ? (task.tags || []).join(", ") : "")}" />
        </label>
        <p class="form-error is-hidden" id="task-form-error"></p>
        <div class="modal-actions">
          <button class="pill pill-red sm" type="submit" id="task-save">
            ${icon("check")}<span>${editing ? "Save changes" : "Add task"}</span>
          </button>
          <button class="pill sm" type="button" id="task-cancel">Cancel</button>
        </div>
      </form>`;
    $("#modal-scrim").classList.remove("is-hidden");

    const form = $("#task-form");
    const cancel = $("#task-cancel");
    if (cancel) cancel.addEventListener("click", closeModal);
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); submitTaskForm(id); });
    const title = $("#task-title");
    if (title) title.focus();
  }

  async function submitTaskForm(id) {
    const error = $("#task-form-error");
    const save = $("#task-save");
    const title = ($("#task-title") && $("#task-title").value || "").trim();

    const showError = (msg) => {
      if (!error) { toast(msg, "danger"); return; }
      error.textContent = msg;
      error.classList.remove("is-hidden");
    };
    if (!title) { showError("A task needs a title."); return; }

    const payload = {
      title,
      notes: ($("#task-notes") && $("#task-notes").value) || "",
      due: ($("#task-due") && $("#task-due").value) || null,
      priority: ($("#task-priority") && $("#task-priority").value) || "normal",
      status: ($("#task-status") && $("#task-status").value) || "todo",
      tags: ($("#task-tags") && $("#task-tags").value) || "",
    };

    if (save) save.disabled = true;
    const result = id ? await post(`/api/tasks/${encodeURIComponent(id)}`, payload) : await post("/api/tasks", payload);
    if (save) save.disabled = false;

    if (!result.ok) { showError(result.message || "Could not save that task."); return; }
    closeModal();
    toast(result.message || "Saved.", "good");
    await refresh();
  }

  async function toggleTask(id) {
    const result = await post(`/api/tasks/${encodeURIComponent(id)}/toggle`);
    if (!result.ok) { toast(result.message || "Could not update that task.", "danger"); return; }
    await refresh();
    // Keep an open detail modal in step with what just changed.
    const modal = $("#modal-scrim");
    if (modal && !modal.classList.contains("is-hidden") && $("#modal-body [data-toggle-task]")) {
      openTaskDetail(id);
    }
  }

  async function deleteTask(id) {
    if (!window.confirm("Delete this task? This cannot be undone.")) return;
    const result = await post(`/api/tasks/${encodeURIComponent(id)}`, null, "DELETE");
    if (!result.ok) { toast(result.message || "Could not delete that task.", "danger"); return; }
    closeModal();
    toast(result.message || "Task deleted.", "good");
    await refresh();
  }

  async function syncTasks() {
    const btn = $("#btn-task-sync");
    if (btn) btn.disabled = true;
    const result = await post("/api/tasks/sync");
    if (btn) btn.disabled = false;
    toast(result.message || (result.ok ? "Tasks synced." : "Task sync failed."), result.ok ? "good" : "danger");
    await refresh();
  }

  // ------------------------------------------------------- month calendar
  const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function renderMonth() {
    const grid = $("#month-grid");
    const label = $("#month-label");
    if (!grid) return;
    const anchor = store.monthAnchor;
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    if (label) {
      label.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    const byDay = new Map();
    const clashDays = new Set();
    ((store.state && store.state.events) || []).forEach((ev) => {
      if (!ev.date_key) return;
      if (!byDay.has(ev.date_key)) byDay.set(ev.date_key, []);
      byDay.get(ev.date_key).push(ev);
    });
    ((store.state && store.state.conflicts) || []).forEach((g) => { if (g.date_key) clashDays.add(g.date_key); });

    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const cursor = new Date(year, month, 1 - lead);
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const key = toKey(cursor);
      const outside = cursor.getMonth() !== month;
      const dayEvents = byDay.get(key) || [];
      const dots = dayEvents.slice(0, 3).map(() => "<i></i>");
      if (clashDays.has(key) && dots.length) dots[0] = '<i class="is-clash"></i>';
      cells.push(`<button class="month-cell${outside ? " is-out" : ""}${key === todayKey() ? " is-today" : ""}${key === store.selectedDay ? " is-selected" : ""}"
        data-day="${key}" type="button" aria-label="${esc(key)}, ${dayEvents.length} meetings">
        <span>${cursor.getDate()}</span><span class="month-dots">${dots.join("")}</span>
      </button>`);
      cursor.setDate(cursor.getDate() + 1);
    }
    grid.innerHTML = DOW.map((d) => `<div class="month-dow">${d}</div>`).join("") + cells.join("");
    renderMonthAgenda(byDay);
  }

  function renderMonthAgenda(byDay) {
    const host = $("#month-agenda");
    if (!host) return;
    const items = (byDay.get(store.selectedDay) || []).slice()
      .sort((a, b) => String(a.local_start).localeCompare(String(b.local_start)));
    const parsed = parseLocal(`${store.selectedDay}T12:00:00`);
    const label = parsed ? parsed.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : store.selectedDay;

    const head = `<div class="mini-row" style="padding-bottom:8px">
      <span class="micro micro-bright">${esc(label)}</span>
      <button class="link-btn" data-open-timeline="${esc(store.selectedDay)}" type="button">Open</button>
    </div>`;

    if (!items.length) { host.innerHTML = `${head}<p class="micro" style="color:var(--ink-5)">Nothing scheduled</p>`; return; }
    host.innerHTML = head + items.slice(0, 5).map((ev) => `<div class="mini-row">
        <span>${esc(ev.summary || "(no title)")}</span>
        <time>${esc(ev.all_day ? "ALL DAY" : (ev.time_label || "").split(" - ")[0])}</time>
      </div>`).join("") +
      (items.length > 5 ? `<p class="micro" style="color:var(--ink-5);margin-top:6px">+${items.length - 5} more</p>` : "");
  }

  // ============================================================== MEETINGS
  function filterEvents() {
    const all = ((store.state && store.state.events) || []).slice();
    const now = new Date();
    const query = store.query.trim().toLowerCase();
    const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);

    return all
      .filter((ev) => {
        const end = parseLocal(ev.local_end);
        switch (store.filter) {
          case "all": return true;
          case "today": return ev.date_key === todayKey();
          case "week": { const s = parseLocal(ev.local_start); return s && s >= now && s < weekEnd; }
          case "conflict": return !!ev.in_conflict;
          case "meet": return !!ev.has_meet;
          case "past": return end && end < now;
          default: return end && end > now;
        }
      })
      .filter((ev) => {
        if (!query) return true;
        return [ev.summary, ev.location, ev.organizer_name, ev.organizer_email, ev.calendar_name, ev.description,
          (ev.attendees || []).map((a) => `${a.email || ""} ${a.name || a.displayName || ""}`).join(" ")]
          .join(" ").toLowerCase().includes(query);
      })
      .sort((a, b) => (store.filter === "past" ? -1 : 1) * String(a.local_start).localeCompare(String(b.local_start)));
  }

  function renderAgenda() {
    const host = $("#agenda-list");
    const summary = $("#agenda-summary");
    if (!host) return;
    if (!store.state) { host.innerHTML = skeleton(); return; }

    const items = filterEvents();
    if (summary) {
      const total = (store.state.events || []).length;
      summary.textContent = `${items.length} / ${total}`;
    }
    if (!items.length) {
      host.innerHTML = emptyState("search", store.query ? "No matches" : "Nothing to show",
        store.query ? "Try a different word, or widen the filter." : "Change the filter to see more.");
      return;
    }
    host.innerHTML = items.map((ev, i) => eventRow(ev, i)).join("");
  }

  // ============================================================== TIMELINE
  async function loadTimeline(dayKey) {
    const canvas = $("#timeline-canvas");
    if (!canvas) return;
    const data = await api(`/api/timeline?day=${encodeURIComponent(dayKey)}`);
    if (!data.ok) {
      store.timeline = null;
      canvas.innerHTML = "";
      toast(data.message || "Could not load that day.", "danger");
      return;
    }
    store.timeline = data.timeline;
    renderTimeline();
  }

  function renderTimeline() {
    const canvas = $("#timeline-canvas");
    const hours = $("#timeline-hours");
    const allday = $("#timeline-allday");
    const meta = $("#timeline-meta");
    const input = $("#tl-date");
    if (!canvas || !hours) return;
    if (input && input.value !== store.timelineDate) input.value = store.timelineDate;

    const tl = store.timeline;
    if (!tl) { canvas.innerHTML = ""; hours.innerHTML = ""; return; }

    if (meta) meta.textContent = `${tl.day_label || ""} — ${num(tl.event_count, 0)} meetings / ${tl.busy_label || "0m"}`;

    hours.innerHTML = (tl.hours || [])
      .map((h) => `<div class="tl-hour" style="top:${num(h.top_pct, 0)}%">${esc(h.label)}</div>`).join("");

    const gridlines = (tl.hours || [])
      .map((h) => `<div class="tl-gridline" style="top:${num(h.top_pct, 0)}%"></div>`).join("");

    const blocks = (tl.blocks || []).map((b, i) => {
      const compact = num(b.height_pct, 0) < 5;
      return `<button class="tl-block${b.counts_as_busy === false ? " is-muted" : ""}"
        style="top:${num(b.top_pct, 0)}%; height:${Math.max(num(b.height_pct, 0), 2.6)}%;
               left:calc(${num(b.left_pct, 0)}% + 5px); width:calc(${num(b.width_pct, 100)}% - 10px); ${delay(i)}"
        data-event="${esc(b.id)}" type="button" title="${esc(b.summary || "")}">
        <strong>${esc(b.summary || "(no title)")}</strong>
        ${compact ? "" : `<span>${esc(b.time_label || "")}</span>`}
      </button>`;
    }).join("");

    const nowLine = tl.now_pct != null ? `<div class="tl-now" style="top:${num(tl.now_pct, 0)}%"></div>` : "";
    const blank = (tl.blocks || []).length === 0
      ? `<div class="tl-empty">${emptyState("check", "Nothing scheduled", "This day is completely free.")}</div>` : "";

    canvas.innerHTML = gridlines + blocks + nowLine + blank;

    const clashIds = new Set();
    ((store.state && store.state.conflicts) || []).forEach((g) => (g.events || []).forEach((ev) => clashIds.add(ev.id)));
    $$(".tl-block", canvas).forEach((n) => { if (clashIds.has(n.dataset.event)) n.classList.add("is-clash"); });

    if (allday) {
      allday.innerHTML = (tl.all_day || [])
        .map((ev) => `<span class="allday-pill"><i></i>${esc(ev.summary || "(no title)")}</span>`).join("");
    }
  }

  function shiftTimeline(days) {
    const base = parseLocal(`${store.timelineDate}T12:00:00`) || new Date();
    base.setDate(base.getDate() + days);
    store.timelineDate = toKey(base);
    loadTimeline(store.timelineDate);
  }

  // ============================================================= CONFLICTS
  function renderConflicts() {
    const host = $("#conflict-list");
    const summary = $("#conflict-summary");
    const tightHost = $("#tight-list");
    const tightSummary = $("#tight-summary");
    if (!host || !tightHost) return;

    const groups = (store.state && store.state.conflicts) || [];
    const tight = (store.state && store.state.tight_transitions) || [];
    if (summary) summary.textContent = groups.length ? `${groups.length} active` : "none";
    if (tightSummary) tightSummary.textContent = tight.length ? `${tight.length} tight` : "none";

    host.innerHTML = groups.length
      ? groups.map((g, i) => {
          const evs = g.events || [];
          const first = evs[0] || {};
          const others = evs.slice(1).map((e) => e.summary).filter(Boolean);
          const sev = ["critical", "major", "minor"].includes(g.severity) ? g.severity : "minor";
          const tone = sev === "critical" ? "is-red" : sev === "major" ? "is-warn" : "";
          return `<button class="row rise" style="${delay(i, 50)}" data-event="${esc(first.id || "")}" type="button">
            <span class="row-index">${pad2(i + 1)}</span>
            <span>
              <span class="row-name">${esc(first.summary || "(no title)")}</span>
              <span class="row-sub">${esc(g.day_label || "")} / ${esc(g.window_label || "")}</span>
            </span>
            <span class="row-cell">${esc(others.join(", ") || "—")}</span>
            <span><span class="state ${tone}">${esc(sev)} ${esc(g.max_overlap_label || "")}</span></span>
            <span class="row-end"><span class="go-btn">${icon("arrow")}</span></span>
          </button>`;
        }).join("")
      : emptyState("check", "No double bookings", "Every meeting has the room to itself.");

    tightHost.innerHTML = tight.length
      ? tight.map((t, i) => {
          const prev = t.previous || {};
          const next = t.next || {};
          return `<button class="row rise" style="${delay(i, 45)}" data-event="${esc(next.id || "")}" type="button">
            <span class="row-index">${pad2(i + 1)}</span>
            <span>
              <span class="row-name">${esc(next.summary || "")}</span>
              <span class="row-sub">after ${esc(prev.summary || "")}</span>
            </span>
            <span class="row-cell is-dim">${esc(prev.time_label || "")} &rarr; ${esc(next.time_label || "")}</span>
            <span><span class="state is-warn">${esc(humanMinutes(t.gap_minutes))} gap</span></span>
            <span class="row-end"><span class="go-btn">${icon("arrow")}</span></span>
          </button>`;
        }).join("")
      : emptyState("check", "No crunches", "Every back-to-back pair clears your buffer.");
  }

  // ================================================================= SLOTS
  async function loadRecommendations() {
    const host = $("#reco-list");
    const btn = $("#btn-reco");
    if (!host) return;
    const duration = num($("#reco-duration") && $("#reco-duration").value, 30);
    const days = num($("#reco-days") && $("#reco-days").value, 10);
    const limit = num($("#reco-limit") && $("#reco-limit").value, 8);

    if (btn) btn.disabled = true;
    host.innerHTML = skeleton();
    const data = await api(`/api/recommendations?duration=${duration}&days=${days}&limit=${limit}`);
    if (btn) btn.disabled = false;

    if (!data.ok) { host.innerHTML = emptyState("alert", "Could not score any slots", data.message || ""); return; }
    store.recommendations = data.recommendations || [];
    renderSlots();
  }

  function renderSlots() {
    const host = $("#reco-list");
    if (!host) return;
    const slots = store.recommendations;
    if (!slots.length) {
      host.innerHTML = emptyState("sparkle", "No slot fits", "Try a shorter meeting, a longer horizon, or widen your working hours.",
        { view: "settings", label: "Open settings" });
      return;
    }
    host.innerHTML = slots.map((slot, i) => {
      const reasons = (slot.reasons || []).slice(0, 2)
        .map((r) => `<li>${icon("check")}<span>${esc(r)}</span></li>`).join("");
      const warnings = (slot.warnings || []).slice(0, 1)
        .map((w) => `<li class="is-warn">${icon("alert")}<span>${esc(w)}</span></li>`).join("");
      const grade = ["excellent", "good", "fair", "poor"].includes(slot.grade) ? slot.grade : "poor";
      return `<div class="row rise" style="${delay(i, 45)}">
        <span class="row-index">${pad2(i + 1)}</span>
        <span>
          <span class="slot-time-big">${esc(slot.time_label || "")}</span>
          <span class="row-sub">${esc(slot.grade_label || "")}</span>
        </span>
        <span class="row-cell is-dim">${esc(slot.day_label || "")}</span>
        <ul class="slot-reasons">${reasons}${warnings}</ul>
        <span>
          <span class="slot-score g-${grade}">${num(slot.score, 0)}</span>
          ${meter(num(slot.score, 0))}
        </span>
      </div>`;
    }).join("");
  }

  // ============================================================== SETTINGS
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function timezoneOptions(current) {
    let zones = [];
    try { if (typeof Intl.supportedValuesOf === "function") zones = Intl.supportedValuesOf("timeZone"); }
    catch (e) { zones = []; }
    if (!zones.length) {
      zones = ["UTC", "Africa/Lagos", "Africa/Cairo", "Africa/Johannesburg", "Africa/Nairobi",
        "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
        "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
        "America/Sao_Paulo", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Shanghai",
        "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney", "Pacific/Auckland"];
    }
    if (current && !zones.includes(current)) zones = [current].concat(zones);
    return zones;
  }

  function renderSettings() {
    const s = store.state;
    if (!s) return;
    const prefs = s.preferences || {};
    const resolved = prefs.resolved || {};

    const reminder = $("#set-reminder");
    if (reminder) {
      const v = String(num(resolved.reminder_minutes, 30));
      if (!Array.from(reminder.options).some((o) => o.value === v)) reminder.add(new Option(`${v} minutes`, v));
      reminder.value = v;
    }
    const tz = $("#set-timezone");
    if (tz) {
      const current = resolved.timezone || TZ_HINT;
      if (tz.dataset.filled !== "1") {
        tz.innerHTML = timezoneOptions(current).map((z) => `<option value="${esc(z)}">${esc(z)}</option>`).join("");
        tz.dataset.filled = "1";
      }
      tz.value = current;
    }
    const start = $("#set-work-start");
    const end = $("#set-work-end");
    if (start) start.value = resolved.work_start || "09:00";
    if (end) end.value = resolved.work_end || "17:30";

    const buffer = $("#set-buffer");
    if (buffer) {
      const v = String(num(resolved.buffer_minutes, 10));
      if (!Array.from(buffer.options).some((o) => o.value === v)) buffer.add(new Option(`${v} minutes`, v));
      buffer.value = v;
    }
    const picker = $("#set-workdays");
    if (picker) {
      const active = new Set(Array.isArray(resolved.work_days) ? resolved.work_days : [0, 1, 2, 3, 4]);
      picker.innerHTML = DAY_NAMES.map((n, i) =>
        `<button class="day-toggle${active.has(i) ? " is-on" : ""}" data-day-index="${i}" type="button" aria-pressed="${active.has(i)}">${n}</button>`).join("");
    }
    const browserNotif = $("#set-browser-notif");
    if (browserNotif) browserNotif.checked = prefs.browser_notifications !== false;

    const emailNotif = $("#set-email-notif");
    const emailHint = $("#email-hint");
    if (emailNotif) { emailNotif.checked = !!prefs.email_reminders; emailNotif.disabled = !resolved.email_available; }
    if (emailHint) {
      emailHint.textContent = resolved.email_available ? "SMTP configured" : "add SMTP_USER + SMTP_PASSWORD to .env";
    }
    const perm = $("#notif-perm");
    if (perm) {
      if (!("Notification" in window)) perm.textContent = "not supported here";
      else if (Notification.permission === "granted") perm.textContent = "permission granted";
      else if (Notification.permission === "denied") perm.textContent = "blocked in browser";
      else perm.textContent = "we'll ask when enabled";
    }
    const redirect = $("#redirect-uri");
    if (redirect) redirect.textContent = `${window.location.origin}/auth/callback`;

    renderSourcePanel();
  }

  function renderSourcePanel() {
    const host = $("#source-panel");
    if (!host || !store.state) return;
    const s = store.state;
    const g = s.google || {};
    const sync = s.sync || {};

    let glyph = "calendar";
    let title = "No calendar connected";
    let text = g.hint || "Connect Google Calendar or load the sample calendar.";
    if (g.connected) {
      glyph = "google";
      title = "Connected to Google Calendar";
      text = `${(g.profile || {}).email || OWNER} / ${num(sync.count, 0)} events / synced ${sync.last_sync_label || "never"}`;
    } else if (s.data_mode === "demo") {
      glyph = "sparkle";
      title = "Sample calendar loaded";
      text = `${num(sync.count, 0)} generated meetings / nothing here touches a real account`;
    }

    host.innerHTML = `<span class="source-icon">${icon(glyph)}</span>
      <div class="source-text"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>
      ${g.connected ? "" : `<button class="pill pill-red sm" id="source-connect" type="button">${icon("google")}<span>Connect</span></button>`}`;

    const connect = $("#source-connect");
    if (connect) connect.addEventListener("click", startAuth);
  }

  async function saveSettings() {
    const btn = $("#btn-save-settings");
    if (btn) btn.disabled = true;
    const workDays = $$("#set-workdays .day-toggle.is-on").map((b) => num(b.dataset.dayIndex, 0));
    const payload = {
      reminder_minutes: num($("#set-reminder") && $("#set-reminder").value, 30),
      timezone: ($("#set-timezone") && $("#set-timezone").value) || null,
      work_start: ($("#set-work-start") && $("#set-work-start").value) || null,
      work_end: ($("#set-work-end") && $("#set-work-end").value) || null,
      buffer_minutes: num($("#set-buffer") && $("#set-buffer").value, 10),
      work_days: workDays.length ? workDays : null,
      browser_notifications: !!($("#set-browser-notif") && $("#set-browser-notif").checked),
      email_reminders: !!($("#set-email-notif") && $("#set-email-notif").checked),
    };
    const result = await post("/api/preferences", payload);
    if (btn) btn.disabled = false;
    if (!result.ok) { toast(result.message || "Could not save your settings.", "danger"); return; }
    if (!workDays.length) toast("Keeping your previous working days - at least one is required.", "danger");
    else toast("Settings saved.", "good");
    await refresh();
  }

  // ========================================================= NOTIFICATIONS
  function renderDrawer() {
    const host = $("#drawer-list");
    if (!host) return;
    const items = (store.state && store.state.notifications) || [];
    host.innerHTML = items.length
      ? items.map((n, i) => notifRow(n, i)).join("")
      : emptyState("bell", "No alerts", "Reminders show up here before each meeting starts.");
  }

  function updateBell() {
    const badge = $("#bell-badge");
    if (!badge) return;
    const unseen = ((store.state && store.state.notifications) || []).filter((n) => !n.seen).length;
    badge.textContent = unseen > 99 ? "99+" : String(unseen);
    badge.classList.toggle("is-hidden", unseen === 0);
  }

  function openDrawer() {
    const drawer = $("#drawer");
    const scrim = $("#drawer-scrim");
    if (!drawer || !scrim) return;
    drawer.classList.remove("is-hidden");
    scrim.classList.remove("is-hidden");
    drawer.setAttribute("aria-hidden", "false");
    renderDrawer();

    const unseen = ((store.state && store.state.notifications) || []).filter((n) => !n.seen).map((n) => n.id);
    if (unseen.length) {
      post("/api/notifications/seen", { ids: unseen }).then(() => {
        if (store.state && store.state.notifications) store.state.notifications.forEach((n) => { n.seen = true; });
        updateBell();
      });
    }
  }

  function closeDrawer() {
    const drawer = $("#drawer");
    const scrim = $("#drawer-scrim");
    if (drawer) { drawer.classList.add("is-hidden"); drawer.setAttribute("aria-hidden", "true"); }
    if (scrim) scrim.classList.add("is-hidden");
  }

  function pushDesktopNotifications() {
    const prefs = (store.state && store.state.preferences) || {};
    if (prefs.browser_notifications === false) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    ((store.state && store.state.notifications) || []).forEach((n) => {
      if (n.seen || store.seenNotifIds.has(n.id)) return;
      store.seenNotifIds.add(n.id);
      try { new Notification(n.title, { body: n.body, tag: `mm-${n.id}` }); } catch (e) { /* blocked */ }
    });
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-dismiss-notif]");
    if (!btn) return;
    e.stopPropagation();
    const node = btn.closest(".notif");
    if (node) node.style.opacity = "0.4";
    const result = await post(`/api/notifications/${encodeURIComponent(btn.dataset.dismissNotif)}/dismiss`);
    if (!result.ok) {
      if (node) node.style.opacity = "";
      toast(result.message || "Could not dismiss that alert.", "danger");
      return;
    }
    await refresh();
    const drawer = $("#drawer");
    if (drawer && !drawer.classList.contains("is-hidden")) renderDrawer();
  });

  // ================================================================ MODAL
  function openEvent(id) {
    const ev = ((store.state && store.state.events) || []).find((e) => String(e.id) === String(id));
    if (!ev) { toast("That meeting is no longer on the calendar.", "danger"); return; }

    const chips = [];
    if (ev.in_conflict) chips.push('<span class="state is-red">Double booked</span>');
    if (ev.all_day) chips.push('<span class="state">All day</span>');
    if (ev.recurring) chips.push('<span class="state">Recurring</span>');
    if (ev.response_status === "declined") chips.push('<span class="state is-red">You declined</span>');
    if (ev.status === "cancelled") chips.push('<span class="state is-red">Cancelled</span>');
    if (ev.has_meet) chips.push('<span class="state is-good">Video call</span>');

    const facts = [["Duration", esc(ev.duration_label || humanMinutes(ev.duration_minutes))]];
    if (ev.calendar_name) facts.push(["Calendar", esc(ev.calendar_name)]);
    if (ev.location) facts.push(["Location", esc(ev.location)]);
    if (ev.organizer_name || ev.organizer_email) facts.push(["Organiser", esc(ev.organizer_name || ev.organizer_email)]);
    if (ev.description) {
      const text = String(ev.description).replace(/<[^>]*>/g, " ").trim().slice(0, 400);
      if (text) facts.push(["Notes", esc(text)]);
    }
    const attendees = (ev.attendees || []).slice(0, 12);
    if (attendees.length) {
      const list = attendees.map((a) => {
        const who = a.name || a.displayName || a.email || "Unknown";
        const status = String(a.response_status || a.responseStatus || "").toLowerCase();
        const label = status === "accepted" ? "Going" : status === "declined" ? "Declined" : status === "tentative" ? "Maybe" : "No reply";
        const tone = status === "accepted" ? "is-yes" : status === "declined" ? "is-no" : "";
        return `<div class="attendee"><span class="avatar">${esc(initials(who))}</span><span>${esc(who)}</span>
          <span class="attendee-state ${tone}">${esc(label)}</span></div>`;
      }).join("");
      facts.push(["Attendees", `<div class="attendees">${list}${(ev.attendees || []).length > 12 ? `<span class="micro">+${(ev.attendees || []).length - 12} more</span>` : ""}</div>`]);
    }

    $("#modal-body").innerHTML = `
      <span class="micro">${esc(ev.day_label || "")} / ${esc(ev.time_label || "")}</span>
      <h2 class="modal-title" id="modal-title">${esc(ev.summary || "(no title)")}</h2>
      ${chips.length ? `<div class="modal-chips">${chips.join("")}</div>` : ""}
      <dl class="modal-facts">
        ${facts.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}
      </dl>
      <div class="modal-actions">
        ${ev.meet_link ? `<a class="pill pill-red sm" href="${esc(ev.meet_link)}" target="_blank" rel="noreferrer">${icon("video")}<span>Join call</span></a>` : ""}
        ${ev.html_link ? `<a class="pill sm" href="${esc(ev.html_link)}" target="_blank" rel="noreferrer">${icon("arrow")}<span>Open in Google</span></a>` : ""}
        <button class="pill sm" data-open-timeline="${esc(ev.date_key)}" type="button">${icon("clock")}<span>See the day</span></button>
      </div>`;
    $("#modal-scrim").classList.remove("is-hidden");
  }

  const closeModal = () => $("#modal-scrim").classList.add("is-hidden");

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle-task]");
    if (toggle) { toggleTask(toggle.dataset.toggleTask); return; }

    const edit = e.target.closest("[data-edit-task]");
    if (edit) { openTaskForm(edit.dataset.editTask); return; }

    const del = e.target.closest("[data-delete-task]");
    if (del) { deleteTask(del.dataset.deleteTask); return; }

    const task = e.target.closest("[data-task]");
    if (task) { openTaskDetail(task.dataset.task); return; }

    const day = e.target.closest("[data-open-timeline]");
    if (day) {
      store.timelineDate = day.dataset.openTimeline;
      store.selectedDay = day.dataset.openTimeline;
      closeModal();
      setView("timeline");
      return;
    }
    const trigger = e.target.closest("[data-event]");
    if (trigger && trigger.dataset.event) openEvent(trigger.dataset.event);
  });

  // ================================================================ ACTIONS
  const startAuth = () => { window.location.href = "/auth/login"; };

  async function doSync() {
    const btn = $("#btn-sync");
    if (btn) {
      btn.disabled = true;
      const svg = btn.querySelector("svg");
      if (svg) svg.style.animation = "spin 900ms linear infinite";
    }
    const result = await post("/api/sync");
    if (btn) {
      btn.disabled = false;
      const svg = btn.querySelector("svg");
      if (svg) svg.style.animation = "";
    }
    toast(result.message || (result.ok ? "Calendar synced." : "Sync failed."), result.ok ? "good" : "danger");
    await refresh();
  }

  async function loadDemo() {
    const result = await post("/api/demo/load");
    toast(result.message || "Sample calendar loaded.", result.ok ? "good" : "danger");
    dismissedBanners.delete("demo");
    await refresh();
  }

  async function clearData() {
    if (!window.confirm("Remove every tracked meeting and notification from the local database?")) return;
    const result = await post("/api/data/clear");
    toast(result.message || "Cleared.", result.ok ? "good" : "danger");
    await refresh();
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Google Calendar? Cached meetings stay until you clear them.")) return;
    const result = await post("/auth/logout");
    toast(result.message || "Disconnected.", result.ok ? "good" : "danger");
    await refresh();
  }

  /** Export the tracked calendar as a standards-compliant .ics file. */
  function exportIcs() {
    const events = (store.state && store.state.events) || [];
    if (!events.length) { toast("There is nothing to export yet.", "danger"); return; }

    const stamp = (iso) => {
      const d = parseLocal(iso);
      return d ? d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "") : "";
    };
    const clean = (v) => String(v == null ? "" : v)
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const fold = (line) => {
      const out = [];
      let rest = line;
      while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ` ${rest.slice(74)}`; }
      out.push(rest);
      return out.join("\r\n");
    };

    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MeetManager//EN", "CALSCALE:GREGORIAN"];
    events.forEach((ev) => {
      lines.push("BEGIN:VEVENT");
      lines.push(fold(`UID:${clean(ev.id)}@meetmanager`));
      lines.push(`DTSTAMP:${stamp(new Date().toISOString())}`);
      lines.push(`DTSTART:${stamp(ev.start)}`);
      lines.push(`DTEND:${stamp(ev.end)}`);
      lines.push(fold(`SUMMARY:${clean(ev.summary || "(no title)")}`));
      if (ev.location) lines.push(fold(`LOCATION:${clean(ev.location)}`));
      if (ev.description) lines.push(fold(`DESCRIPTION:${clean(ev.description)}`));
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");

    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `meetmanager-${todayKey()}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${events.length} meetings.`, "good");
  }

  async function testNotification() {
    if (!("Notification" in window)) { toast("This browser does not support desktop notifications.", "danger"); return; }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    renderSettings();
    if (permission !== "granted") { toast("Desktop notifications are blocked in your browser settings.", "danger"); return; }
    try {
      new Notification("MeetManager test reminder", { body: "This is what a meeting reminder will look like.", tag: "mm-test" });
      toast("Test reminder sent.", "good");
    } catch (e) { toast("Your browser refused to show the notification.", "danger"); }
  }

  async function dismissAllNotifications() {
    const result = await post("/api/notifications/dismiss-all");
    if (!result.ok) { toast(result.message || "Could not clear alerts.", "danger"); return; }
    toast("Alerts cleared.", "good");
    await refresh();
    renderDrawer();
  }

  function updateConnectButton() {
    const btn = $("#btn-connect");
    const label = $("#btn-connect-label");
    if (!btn || !label || !store.state) return;
    if ((store.state.google || {}).connected) {
      label.textContent = "Connected";
      btn.disabled = true;
      btn.classList.remove("pill-red");
    } else {
      label.textContent = "Connect";
      btn.disabled = false;
      btn.classList.add("pill-red");
    }
  }

  // ================================================================ RENDER
  function render() {
    try {
      store.lastError = null;
      renderNav();
      renderHead();
      renderMetaStrip();
      renderStatCards();
      renderUpNext();
      renderTodayList();
      renderDashNotifications();
      renderNextMeeting();
      renderMonth();
      renderAgenda();
      renderTasks();
      renderTaskStats();
      renderTaskSources();
      renderConflicts();
      renderSettings();
      updateBell();
      updateConnectButton();
      pushDesktopNotifications();
      if (store.view === "timeline") renderTimeline();
    } catch (err) {
      store.lastError = err && err.message ? err.message : String(err);
      /* eslint-disable-next-line no-console */
      console.error("MeetManager render failed:", err);
    }
    renderBanners();
  }

  async function refresh() {
    const data = await api(`/api/state?day=${encodeURIComponent(store.timelineDate)}`);
    if (!data.ok) {
      store.lastError = data.message || "Could not load the dashboard.";
      renderBanners();
      return;
    }
    store.state = data.state;
    if (!store.timeline && store.state.timeline) store.timeline = store.state.timeline;
    render();
  }

  // ------------------------------------------------------------- countdown
  function tick() {
    const node = $("#next-countdown");
    if (!node) return;
    const start = parseLocal(node.dataset.start);
    const end = parseLocal(node.dataset.end);
    if (!start || !end) return;
    const now = new Date();
    if (now >= end) node.textContent = "Finished";
    else if (now >= start) node.textContent = `LIVE · ${humanMinutes(Math.round((end - now) / 60000))} left`;
    else {
      const secs = Math.floor((start - now) / 1000);
      node.textContent = secs < 60 ? `T-${secs}s` : `T-${humanMinutes(Math.floor(secs / 60))}`;
    }
  }

  // ================================================================== INIT
  function bind() {
    const theme = $("#btn-theme");
    if (theme) {
      theme.addEventListener("click", () => {
        applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
      });
    }

    const bell = $("#btn-bell");
    if (bell) bell.addEventListener("click", openDrawer);
    const sync = $("#btn-sync");
    if (sync) sync.addEventListener("click", doSync);
    const exportBtn = $("#btn-export");
    if (exportBtn) exportBtn.addEventListener("click", exportIcs);
    const connect = $("#btn-connect");
    if (connect) connect.addEventListener("click", startAuth);

    const search = $("#global-search");
    if (search) {
      search.addEventListener("input", () => {
        store.query = search.value;
        if (search.value && store.view !== "meetings") setView("meetings");
        renderAgenda();
      });
    }

    const clearNotifs = $("#btn-clear-notifs");
    if (clearNotifs) clearNotifs.addEventListener("click", dismissAllNotifications);

    const prev = $("#month-prev");
    if (prev) prev.addEventListener("click", () => {
      store.monthAnchor = new Date(store.monthAnchor.getFullYear(), store.monthAnchor.getMonth() - 1, 1);
      renderMonth();
    });
    const next = $("#month-next");
    if (next) next.addEventListener("click", () => {
      store.monthAnchor = new Date(store.monthAnchor.getFullYear(), store.monthAnchor.getMonth() + 1, 1);
      renderMonth();
    });
    const grid = $("#month-grid");
    if (grid) grid.addEventListener("click", (e) => {
      const cell = e.target.closest("[data-day]");
      if (!cell) return;
      store.selectedDay = cell.dataset.day;
      renderMonth();
    });

    const filter = $("#agenda-filter");
    if (filter) filter.addEventListener("change", () => { store.filter = filter.value; renderAgenda(); });

    const taskFilter = $("#task-filter");
    if (taskFilter) taskFilter.addEventListener("change", () => { store.taskFilter = taskFilter.value; renderTasks(); });
    const taskNew = $("#btn-task-new");
    if (taskNew) taskNew.addEventListener("click", () => openTaskForm(null));
    const taskSync = $("#btn-task-sync");
    if (taskSync) taskSync.addEventListener("click", syncTasks);

    const tlPrev = $("#tl-prev");
    if (tlPrev) tlPrev.addEventListener("click", () => shiftTimeline(-1));
    const tlNext = $("#tl-next");
    if (tlNext) tlNext.addEventListener("click", () => shiftTimeline(1));
    const tlToday = $("#tl-today");
    if (tlToday) tlToday.addEventListener("click", () => { store.timelineDate = todayKey(); loadTimeline(store.timelineDate); });
    const tlDate = $("#tl-date");
    if (tlDate) tlDate.addEventListener("change", () => {
      if (!tlDate.value) return;
      store.timelineDate = tlDate.value;
      loadTimeline(store.timelineDate);
    });

    const reco = $("#btn-reco");
    if (reco) reco.addEventListener("click", loadRecommendations);
    ["#reco-duration", "#reco-days", "#reco-limit"].forEach((sel) => {
      const node = $(sel);
      if (node) node.addEventListener("change", loadRecommendations);
    });

    const save = $("#btn-save-settings");
    if (save) save.addEventListener("click", saveSettings);
    const test = $("#btn-test-notif");
    if (test) test.addEventListener("click", testNotification);
    const demo = $("#btn-demo");
    if (demo) demo.addEventListener("click", loadDemo);
    const clear = $("#btn-clear");
    if (clear) clear.addEventListener("click", clearData);
    const disc = $("#btn-disconnect");
    if (disc) disc.addEventListener("click", disconnect);

    const workdays = $("#set-workdays");
    if (workdays) workdays.addEventListener("click", (e) => {
      const t = e.target.closest(".day-toggle");
      if (!t) return;
      const on = t.classList.toggle("is-on");
      t.setAttribute("aria-pressed", String(on));
    });

    const browserNotif = $("#set-browser-notif");
    if (browserNotif) browserNotif.addEventListener("change", async () => {
      if (browserNotif.checked && "Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
        renderSettings();
      }
    });

    const closeDrawerBtn = $("#btn-close-drawer");
    if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeDrawer);
    const drawerScrim = $("#drawer-scrim");
    if (drawerScrim) drawerScrim.addEventListener("click", closeDrawer);
    const dismissAll = $("#btn-dismiss-all");
    if (dismissAll) dismissAll.addEventListener("click", dismissAllNotifications);

    const modalClose = $("#modal-close");
    if (modalClose) modalClose.addEventListener("click", closeModal);
    const modalScrim = $("#modal-scrim");
    if (modalScrim) modalScrim.addEventListener("click", (e) => { if (e.target === modalScrim) closeModal(); });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeModal(); closeDrawer(); return; }
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        const box = $("#global-search");
        if (box) box.focus();
      }
    });
  }

  function consumeAuthFlags() {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    const auth = params.get("auth");
    if (authError) toast(`Google sign-in failed: ${authError}`, "danger");
    else if (auth === "connected") toast("Google Calendar connected.", "good");
    else if (auth === "connected_sync_failed") toast("Connected, but the first sync failed. Try Sync.", "danger");
    if (auth || authError) window.history.replaceState({}, "", window.location.pathname);
  }

  async function boot() {
    let stored = null;
    try { stored = localStorage.getItem("mm-theme"); } catch (e) { stored = null; }
    applyTheme(stored === "light" ? "light" : "dark", false);

    bind();
    renderNav();
    renderHead();
    renderStatCards();
    consumeAuthFlags();

    const input = $("#tl-date");
    if (input) input.value = store.timelineDate;

    await refresh();
    setInterval(tick, 1000);
    setInterval(refresh, 30000);
    tick();
  }

  const spinStyle = document.createElement("style");
  spinStyle.textContent = "@keyframes spin{to{transform:rotate(360deg)}}";
  document.head.appendChild(spinStyle);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
