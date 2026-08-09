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
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const icon = (name, cls) =>
    `<svg viewBox="0 0 24 24" class="${cls || ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : (fallback || 0));

  /** Stagger helper: capped so a long list never animates for seconds. */
  const delay = (i, step) => `--d:${Math.min(i * (step || 40), 320)}ms`;

  function humanMinutes(mins) {
    const m = Math.max(0, Math.round(num(mins, 0)));
    if (!m) return "0m";
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h && r) return `${h}h ${r}m`;
    if (h) return `${h}h`;
    return `${r}m`;
  }

  function initials(nameOrEmail) {
    const raw = String(nameOrEmail || "").trim();
    if (!raw) return "?";
    const local = raw.includes("@") ? raw.split("@")[0] : raw;
    const parts = local.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
    return local.slice(0, 2);
  }

  const todayKey = () => toKey(new Date());

  function toKey(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function parseLocal(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
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
    agendaQuery: "",
    agendaFilter: "upcoming",
    seenNotifIds: new Set(),
    loading: true,
    lastError: null,
  };

  const VIEWS = [
    { id: "dashboard", label: "Dashboard", icon: "grid" },
    { id: "meetings", label: "Meetings", icon: "list" },
    { id: "timeline", label: "Timeline", icon: "clock" },
    { id: "conflicts", label: "Conflicts", icon: "alert", danger: true },
    { id: "slots", label: "Find a slot", icon: "sparkle" },
  ];

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

  const post = (path, payload) =>
    api(path, { method: "POST", body: JSON.stringify(payload == null ? {} : payload) });

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
      items.push({
        id: "app-error",
        kind: "danger",
        icon: "alert",
        title: "Something went wrong",
        body: store.lastError,
      });
    }

    if (s) {
      if (s.sync && s.sync.last_error) {
        items.push({
          id: "sync-error",
          kind: "warn",
          icon: "refresh",
          title: "Last calendar sync failed",
          body: s.sync.last_error,
        });
      }
      const g = s.google || {};
      if (!g.connected && s.data_mode === "empty") {
        items.push({
          id: "connect",
          kind: "info",
          icon: "google",
          title: "No calendar connected yet",
          body: g.hint || "Connect Google Calendar, or load the sample calendar to explore the app.",
          action: { label: "Load sample calendar", id: "banner-demo" },
        });
      } else if (s.data_mode === "demo") {
        items.push({
          id: "demo",
          kind: "info",
          icon: "sparkle",
          title: "You're looking at sample data",
          body: "These meetings are generated locally. Connect Google Calendar to see your real schedule.",
        });
      }
    }

    const visible = items.filter((i) => !dismissedBanners.has(i.id));
    host.innerHTML = visible
      .map(
        (item) => `
      <div class="banner is-${item.kind}" data-banner="${esc(item.id)}">
        ${icon(item.icon)}
        <div>
          <strong>${esc(item.title)}</strong>
          <p>${esc(item.body)}</p>
        </div>
        ${item.action ? `<button class="btn btn-quiet sm" id="${esc(item.action.id)}" type="button">${esc(item.action.label)}</button>` : ""}
        <button class="notif-x banner-x" data-dismiss-banner="${esc(item.id)}" type="button" aria-label="Dismiss">${icon("close")}</button>
      </div>`
      )
      .join("");

    const demoBtn = $("#banner-demo");
    if (demoBtn) demoBtn.addEventListener("click", loadDemo);
  }

  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-dismiss-banner]");
    if (!btn) return;
    dismissedBanners.add(btn.dataset.dismissBanner);
    renderBanners();
  });

  // ----------------------------------------------------------------- theme
  function applyTheme(theme, persist) {
    const value = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = value;
    if (persist) {
      try {
        localStorage.setItem("mm-theme", value);
      } catch (e) {
        /* private mode - the choice just won't survive a reload */
      }
    }
    $$(".tt-btn").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.themeSet === value));
    positionThemeThumb();
  }

  function positionThemeThumb() {
    const active = $(".tt-btn.is-active");
    const thumb = $(".tt-thumb");
    if (!active || !thumb) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
  }

  // ------------------------------------------------------------------ nav
  function renderNav() {
    const counts = {
      meetings: store.state ? (store.state.upcoming || []).length : 0,
      conflicts: store.state ? (store.state.conflicts || []).length : 0,
    };

    const tabs = $("#tabs");
    if (tabs) {
      tabs.innerHTML = VIEWS.map((v) => {
        const count = counts[v.id];
        const badge =
          count > 0
            ? `<span class="tab-count${v.danger ? " is-danger" : ""}">${count}</span>`
            : "";
        return `<button class="tab${store.view === v.id ? " is-active" : ""}" data-view="${v.id}" type="button">
          ${icon(v.icon)}<span>${esc(v.label)}</span>${badge}
        </button>`;
      }).join("");
    }

    const rail = $("#rail-nav");
    if (rail) {
      rail.innerHTML = VIEWS.map((v) => {
        const count = counts[v.id];
        const badge = v.danger && count > 0 ? `<span class="rail-count">${count}</span>` : "";
        return `<button class="rail-btn${store.view === v.id ? " is-active" : ""}" data-view="${v.id}"
                  type="button" data-tip="${esc(v.label)}" aria-label="${esc(v.label)}">
          ${icon(v.icon)}${badge}
        </button>`;
      }).join("");
    }

    const railSettings = $("#rail-settings");
    if (railSettings) railSettings.classList.toggle("is-active", store.view === "settings");
  }

  function setView(id, opts) {
    if (!id) return;
    const known = VIEWS.some((v) => v.id === id) || id === "settings";
    store.view = known ? id : "dashboard";

    $$(".view").forEach((section) => {
      const active = section.id === `view-${store.view}`;
      section.classList.toggle("is-active", active);
    });
    renderNav();

    const page = $("#page");
    if (page && !(opts && opts.keepScroll)) page.scrollTop = 0;

    if (store.view === "timeline") loadTimeline(store.timelineDate);
    if (store.view === "slots" && !store.recommendations.length) loadRecommendations();
  }

  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-view]");
    if (nav) {
      setView(nav.dataset.view);
      return;
    }
    const goto = event.target.closest("[data-goto]");
    if (goto) setView(goto.dataset.goto);
  });

  // ============================================================ DASHBOARD
  const ART = {
    calendar: `<svg viewBox="0 0 120 58" aria-hidden="true">
        <rect x="6" y="8" width="42" height="42" rx="7"/>
        <path d="M6 20h42M18 4v8M36 4v8"/>
        <rect x="58" y="14" width="56" height="9" rx="4.5"/>
        <rect x="58" y="30" width="40" height="9" rx="4.5"/>
      </svg>`,
    bars: `<svg viewBox="0 0 120 58" aria-hidden="true">
        <path d="M8 50h104"/>
        <rect x="14" y="30" width="14" height="20" rx="4"/>
        <rect x="36" y="18" width="14" height="32" rx="4"/>
        <rect x="58" y="36" width="14" height="14" rx="4"/>
        <rect x="80" y="10" width="14" height="40" rx="4"/>
      </svg>`,
    overlap: `<svg viewBox="0 0 120 58" aria-hidden="true">
        <rect x="12" y="10" width="52" height="26" rx="7"/>
        <rect x="40" y="24" width="52" height="26" rx="7"/>
        <path d="M96 14l8 8M104 14l-8 8"/>
      </svg>`,
    spark: `<svg viewBox="0 0 120 58" aria-hidden="true">
        <path d="M30 8l4.5 13.5L48 26l-13.5 4.5L30 44l-4.5-13.5L12 26l13.5-4.5L30 8Z"/>
        <rect x="62" y="16" width="48" height="8" rx="4"/>
        <rect x="62" y="32" width="32" height="8" rx="4"/>
      </svg>`,
  };

  function renderStatCards() {
    const host = $("#stat-cards");
    if (!host) return;
    const s = store.state;
    if (!s) {
      host.innerHTML = Array.from({ length: 4 })
        .map(() => `<div class="stat-card"><div class="skel"><div class="skel-line"></div><div class="skel-line"></div></div></div>`)
        .join("");
      return;
    }

    const stats = s.stats || {};
    const conflicts = num(stats.conflict_groups, 0);
    const slots = (s.recommendations || []).length;
    const bestSlot = (s.recommendations || [])[0];

    const cards = [
      {
        view: "timeline",
        art: ART.calendar,
        value: num(stats.today_count, 0),
        label: num(stats.today_count, 0) === 1 ? "Meeting today" : "Meetings today",
        note: stats.today_label ? `${stats.today_label} booked` : "Nothing booked yet",
      },
      {
        view: "meetings",
        art: ART.bars,
        value: num(stats.week_count, 0),
        label: "This week",
        note: stats.week_label ? `${stats.week_label} in meetings` : "A clear week ahead",
      },
      {
        view: "conflicts",
        art: ART.overlap,
        value: conflicts,
        label: conflicts === 1 ? "Double booking" : "Double bookings",
        note: conflicts ? `${num(stats.conflict_events, 0)} meetings affected` : "Nothing clashes",
        alert: conflicts > 0,
      },
      {
        view: "slots",
        art: ART.spark,
        value: slots,
        label: "Free slots found",
        note: bestSlot ? `Best: ${bestSlot.short_day || bestSlot.day_label || ""} ${bestSlot.time_label || ""}`.trim() : "Adjust your working hours",
      },
    ];

    host.innerHTML = cards
      .map(
        (card, i) => `
      <button class="stat-card rise${card.alert ? " is-alert" : ""}" style="${delay(i, 60)}"
              data-view="${card.view}" type="button">
        <div class="stat-art">${card.art}</div>
        <div class="stat-value">${esc(card.value)}</div>
        <div class="stat-label">${esc(card.label)}</div>
        <div class="stat-note">${esc(card.note)}</div>
      </button>`
      )
      .join("");
  }

  function renderHero() {
    const s = store.state;
    const eyebrow = $("#hero-eyebrow");
    const title = $("#hero-title");
    const sub = $("#hero-sub");
    if (!eyebrow || !title || !sub) return;

    const hour = new Date().getHours();
    const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

    // Only greet by name when the mailbox yields something that reads like one.
    const local = OWNER.split("@")[0] || "";
    const first = local.split(/[._\-0-9]+/).filter(Boolean)[0] || "";
    const name = /^[a-zA-Z]{2,12}$/.test(first)
      ? first[0].toUpperCase() + first.slice(1).toLowerCase()
      : "";

    eyebrow.textContent = name ? `${part}, ${name}` : part;

    if (!s) {
      title.textContent = "Loading your calendar…";
      sub.textContent = "Reading meetings, checking for clashes and scoring free slots.";
      return;
    }

    const stats = s.stats || {};
    const today = num(stats.today_count, 0);
    const conflicts = num(stats.conflict_groups, 0);

    if (conflicts > 0) {
      title.textContent = conflicts === 1 ? "You have a clash today." : "You have clashes to fix.";
      sub.textContent = `${conflicts} double booking${conflicts === 1 ? "" : "s"} across ${num(stats.conflict_events, 0)} meetings. Everything else looks clear.`;
    } else if (today === 0) {
      title.textContent = "Your day is wide open.";
      sub.textContent = `Nothing booked today. ${num(stats.week_count, 0)} meeting${num(stats.week_count, 0) === 1 ? "" : "s"} coming up this week.`;
    } else {
      title.textContent = "What's on your plate today?";
      sub.textContent = `${today} meeting${today === 1 ? "" : "s"} today, ${stats.today_label || "0m"} of your day booked. No clashes detected.`;
    }
  }

  function emptyState(glyph, title, text, action) {
    return `<div class="empty">
      ${icon(glyph)}
      <strong>${esc(title)}</strong>
      ${text ? `<p>${esc(text)}</p>` : ""}
      ${action ? `<button class="btn btn-quiet sm" data-goto="${esc(action.view)}" type="button">${esc(action.label)}</button>` : ""}
    </div>`;
  }

  /** Compact meeting row used on the dashboard and in the agenda. */
  function eventRow(ev, i, opts) {
    const options = opts || {};
    const start = parseLocal(ev.local_start);
    const end = parseLocal(ev.local_end);
    const now = new Date();
    const live = start && end && start <= now && now < end;
    const done = end && end < now;

    const bits = [];
    if (options.showDay && ev.day_label) bits.push(`<span>${icon("calendar")}${esc(ev.day_label)}</span>`);
    bits.push(`<span>${esc(ev.duration_label || humanMinutes(ev.duration_minutes))}</span>`);
    if (num(ev.attendee_count, 0) > 0) bits.push(`<span>${icon("users")}${num(ev.attendee_count, 0)}</span>`);
    if (ev.has_meet) bits.push(`<span>${icon("video")}Video</span>`);
    if (ev.location) bits.push(`<span>${icon("pin")}${esc(ev.location)}</span>`);

    const chips = [];
    if (ev.in_conflict) chips.push(`<span class="chip is-danger">${icon("alert")}Clash</span>`);
    if (live) chips.push(`<span class="chip is-good">Now</span>`);

    let progress = "";
    if (options.progress && start && end && end > start) {
      const pct = clamp(((now - start) / (end - start)) * 100, 0, 100);
      progress = `<div class="row-progress"><i data-grow="${pct.toFixed(1)}"></i></div>`;
    }

    return `<button class="row rise${live ? " is-live" : ""}${done ? " is-done" : ""}"
              style="${delay(i, 45)}" data-event="${esc(ev.id)}" type="button">
      <i class="row-bar" style="background:${esc(ev.colour || "var(--ink-4)")}"></i>
      <span class="row-main">
        <span class="row-title">${esc(ev.summary || "(no title)")}</span>
        <span class="row-meta">${bits.join("")}</span>
        ${progress}
      </span>
      <span class="row-right">
        ${chips.join("")}
        <span class="row-time">${esc(ev.time_label || "")}</span>
      </span>
    </button>`;
  }

  /** Kick off any width transitions once the nodes are in the document. */
  function growBars(root) {
    requestAnimationFrame(() => {
      $$("[data-grow]", root || document).forEach((node) => {
        node.style.width = `${node.dataset.grow}%`;
      });
    });
  }

  function renderDashNotifications() {
    const host = $("#dash-notifs");
    if (!host) return;
    const items = (store.state && store.state.notifications) || [];
    if (!items.length) {
      host.innerHTML = emptyState("bell", "You're all caught up", "Reminders appear here before a meeting starts.");
      return;
    }
    host.innerHTML = items
      .slice(0, 4)
      .map(
        (n, i) => `
      <div class="notif rise" style="${delay(i, 50)}">
        <span class="notif-icon${n.is_conflict ? " is-clash" : ""}">${icon(n.is_conflict ? "alert" : "bell")}</span>
        <span class="notif-main">
          <strong>${esc(n.title)}</strong>
          <p>${esc(n.body)}</p>
          <span class="notif-time">${esc(n.created_label || "")}</span>
        </span>
        <button class="notif-x" data-dismiss-notif="${esc(n.id)}" type="button" aria-label="Dismiss">${icon("close")}</button>
      </div>`
      )
      .join("");
  }

  function renderUpNext() {
    const host = $("#dash-upnext");
    if (!host) return;
    const items = (store.state && store.state.upcoming) || [];
    if (!items.length) {
      host.innerHTML = emptyState("calendar", "Nothing scheduled", "No upcoming meetings on this calendar.", {
        view: "slots",
        label: "Find a slot",
      });
      return;
    }
    host.innerHTML = `<div class="rows">${items.slice(0, 5).map((ev, i) => eventRow(ev, i, { showDay: true })).join("")}</div>`;
  }

  function renderTodayList() {
    const host = $("#today-list");
    const chip = $("#today-chip");
    if (!host) return;

    const key = todayKey();
    const all = (store.state && store.state.events) || [];
    const items = all
      .filter((ev) => ev.date_key === key && !ev.all_day)
      .sort((a, b) => String(a.local_start).localeCompare(String(b.local_start)));

    if (chip) {
      const stats = (store.state && store.state.stats) || {};
      chip.textContent = items.length ? `${items.length} · ${stats.today_label || "0m"}` : "Clear";
      chip.classList.toggle("is-good", items.length === 0);
    }

    if (!items.length) {
      host.innerHTML = emptyState("check", "No meetings today", "A completely clear day - use it well.");
      return;
    }
    host.innerHTML = `<div class="rows">${items.map((ev, i) => eventRow(ev, i, { progress: true })).join("")}</div>`;
    growBars(host);
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
      label.textContent = new Date(year, month, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    }

    // Index events + clashes by local date key.
    const byDay = new Map();
    const clashDays = new Set();
    ((store.state && store.state.events) || []).forEach((ev) => {
      if (!ev.date_key) return;
      if (!byDay.has(ev.date_key)) byDay.set(ev.date_key, []);
      byDay.get(ev.date_key).push(ev);
    });
    ((store.state && store.state.conflicts) || []).forEach((group) => {
      if (group.date_key) clashDays.add(group.date_key);
    });

    const first = new Date(year, month, 1);
    // Monday-first offset.
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    const cursor = new Date(year, month, 1 - lead);

    for (let i = 0; i < 42; i += 1) {
      const key = toKey(cursor);
      const outside = cursor.getMonth() !== month;
      const dayEvents = byDay.get(key) || [];
      const dots = dayEvents.slice(0, 3).map(() => `<i></i>`);
      if (clashDays.has(key) && dots.length) dots[0] = `<i class="is-clash"></i>`;

      cells.push(`<button class="month-cell${outside ? " is-out" : ""}${key === todayKey() ? " is-today" : ""}${key === store.selectedDay ? " is-selected" : ""}"
          data-day="${key}" type="button" aria-label="${esc(key)}, ${dayEvents.length} meetings">
        <span>${cursor.getDate()}</span>
        <span class="month-dots">${dots.join("")}</span>
      </button>`);
      cursor.setDate(cursor.getDate() + 1);
    }

    grid.innerHTML = DOW.map((d) => `<div class="month-dow">${d}</div>`).join("") + cells.join("");
    renderMonthAgenda(byDay);
  }

  function renderMonthAgenda(byDay) {
    const host = $("#month-agenda");
    if (!host) return;
    const items = (byDay.get(store.selectedDay) || []).slice().sort((a, b) =>
      String(a.local_start).localeCompare(String(b.local_start))
    );

    const parsed = parseLocal(`${store.selectedDay}T12:00:00`);
    const label = parsed
      ? parsed.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      : store.selectedDay;

    const head = `<div class="month-agenda-head">
      <strong>${esc(label)}</strong>
      <button class="link-btn" data-open-timeline="${esc(store.selectedDay)}" type="button">Open day</button>
    </div>`;

    if (!items.length) {
      host.innerHTML = `${head}<p class="card-sub">Nothing scheduled.</p>`;
      return;
    }

    host.innerHTML =
      head +
      items
        .slice(0, 4)
        .map(
          (ev) => `<div class="mini-row">
            <i class="row-bar" style="background:${esc(ev.colour || "var(--ink-4)")}"></i>
            <span>${esc(ev.summary || "(no title)")}</span>
            <time>${esc(ev.all_day ? "All day" : (ev.time_label || "").split(" - ")[0])}</time>
          </div>`
        )
        .join("") +
      (items.length > 4 ? `<p class="card-sub">+${items.length - 4} more</p>` : "");
  }

  // ---------------------------------------------------------------- rings
  function ringCard(pct, label, note, tone) {
    const value = clamp(Math.round(num(pct, 0)), 0, 100);
    const R = 32;
    const circumference = 2 * Math.PI * R;
    const offset = circumference * (1 - value / 100);
    return `<div class="ring-card rise">
      <div class="ring">
        <svg viewBox="0 0 76 76">
          <circle class="ring-track" cx="38" cy="38" r="${R}"/>
          <circle class="ring-value${tone ? ` is-${tone}` : ""}" cx="38" cy="38" r="${R}"
                  stroke-dasharray="${circumference.toFixed(2)}"
                  stroke-dashoffset="${circumference.toFixed(2)}"
                  data-offset="${offset.toFixed(2)}"/>
        </svg>
        <span class="ring-num">${value}%</span>
      </div>
      <span class="ring-label">${esc(label)}</span>
      <span class="ring-note">${esc(note)}</span>
    </div>`;
  }

  function renderRings() {
    const host = $("#ring-row");
    if (!host) return;
    const s = store.state;
    if (!s) {
      host.innerHTML = "";
      return;
    }

    const stats = s.stats || {};
    const resolved = (s.preferences && s.preferences.resolved) || {};
    const [ws, we] = [resolved.work_start || "09:00", resolved.work_end || "17:30"];
    const toMins = (hhmm) => {
      const parts = String(hhmm).split(":");
      return num(parts[0], 9) * 60 + num(parts[1], 0);
    };
    const dayCapacity = Math.max(60, toMins(we) - toMins(ws));
    const workDays = Array.isArray(resolved.work_days) && resolved.work_days.length ? resolved.work_days.length : 5;

    const weekPct = (num(stats.week_minutes, 0) / (dayCapacity * workDays)) * 100;
    const todayFreePct = 100 - (num(stats.today_minutes, 0) / dayCapacity) * 100;

    const weekTone = weekPct >= 85 ? "danger" : weekPct >= 65 ? "warn" : "";
    const freeTone = todayFreePct <= 15 ? "danger" : todayFreePct <= 35 ? "warn" : "";

    host.innerHTML =
      ringCard(weekPct, "Week booked", `${stats.week_label || "0m"} of ${humanMinutes(dayCapacity * workDays)}`, weekTone) +
      ringCard(clamp(todayFreePct, 0, 100), "Today free", `${stats.today_label || "0m"} booked today`, freeTone);

    // Draw the arcs on the next frame so the dashoffset transition runs.
    requestAnimationFrame(() => {
      $$(".ring-value", host).forEach((circle) => {
        circle.style.strokeDashoffset = circle.dataset.offset;
      });
    });
  }

  function renderNextMeeting() {
    const host = $("#next-meeting-card");
    if (!host) return;
    const next = store.state && store.state.stats && store.state.stats.next_event;

    if (!next) {
      host.className = "card";
      host.innerHTML = `<div class="next-card">
        <span class="next-eyebrow">Next meeting</span>
        ${emptyState("check", "Nothing coming up", "Your calendar is clear from here.")}
      </div>`;
      return;
    }

    const meta = [];
    if (next.day_label) meta.push(`<span>${icon("calendar")}${esc(next.day_label)}</span>`);
    meta.push(`<span>${icon("clock")}${esc(next.time_label || "")}</span>`);
    if (num(next.attendee_count, 0)) meta.push(`<span>${icon("users")}${num(next.attendee_count, 0)}</span>`);
    if (next.location) meta.push(`<span>${icon("pin")}${esc(next.location)}</span>`);

    host.className = "card";
    host.innerHTML = `<div class="next-card">
      <span class="next-eyebrow">Next meeting</span>
      <span class="next-title">${esc(next.summary || "(no title)")}</span>
      <div class="next-meta">${meta.join("")}</div>
      <div class="next-count" id="next-countdown" data-start="${esc(next.local_start)}" data-end="${esc(next.local_end)}">
        ${esc(next.starts_in_label || "")}
      </div>
      <div class="next-actions">
        ${next.meet_link ? `<a class="btn btn-primary sm" href="${esc(next.meet_link)}" target="_blank" rel="noreferrer">${icon("video")}<span>Join</span></a>` : ""}
        <button class="btn btn-quiet sm" data-event="${esc(next.id)}" type="button">Details</button>
        <button class="btn btn-quiet sm" data-goto="slots" type="button">Reschedule</button>
      </div>
    </div>`;
  }

  // ============================================================== MEETINGS
  function filterEvents() {
    const all = ((store.state && store.state.events) || []).slice();
    const now = new Date();
    const query = store.agendaQuery.trim().toLowerCase();
    const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);

    return all
      .filter((ev) => {
        const end = parseLocal(ev.local_end);
        switch (store.agendaFilter) {
          case "all":
            return true;
          case "today":
            return ev.date_key === todayKey();
          case "week": {
            const start = parseLocal(ev.local_start);
            return start && start >= now && start < weekEnd;
          }
          case "conflict":
            return !!ev.in_conflict;
          case "meet":
            return !!ev.has_meet;
          case "past":
            return end && end < now;
          case "upcoming":
          default:
            return end && end > now;
        }
      })
      .filter((ev) => {
        if (!query) return true;
        const haystack = [
          ev.summary,
          ev.location,
          ev.organizer_name,
          ev.organizer_email,
          ev.calendar_name,
          ev.description,
          (ev.attendees || []).map((a) => `${a.email || ""} ${a.name || a.displayName || ""}`).join(" "),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => {
        const dir = store.agendaFilter === "past" ? -1 : 1;
        return dir * String(a.local_start).localeCompare(String(b.local_start));
      });
  }

  function renderAgenda() {
    const host = $("#agenda-list");
    const summary = $("#agenda-summary");
    if (!host) return;

    if (!store.state) {
      host.innerHTML = `<div class="skel"><div class="skel-line"></div><div class="skel-line"></div><div class="skel-line"></div></div>`;
      return;
    }

    const items = filterEvents();
    if (summary) {
      const total = (store.state.events || []).length;
      summary.textContent = `${items.length} of ${total} tracked meeting${total === 1 ? "" : "s"}`;
    }

    if (!items.length) {
      host.innerHTML = emptyState(
        "search",
        store.agendaQuery ? "No meetings match that search" : "Nothing to show here",
        store.agendaQuery ? "Try a different word, or widen the filter." : "Change the filter above to see more."
      );
      return;
    }

    // Group into day buckets, preserving the sorted order.
    const groups = [];
    const index = new Map();
    items.forEach((ev) => {
      const key = ev.date_key || "";
      if (!index.has(key)) {
        const bucket = { key, label: ev.day_label || key, events: [], minutes: 0 };
        index.set(key, bucket);
        groups.push(bucket);
      }
      const bucket = index.get(key);
      bucket.events.push(ev);
      if (ev.counts_as_busy) bucket.minutes += num(ev.duration_minutes, 0);
    });

    let cursor = 0;
    host.innerHTML = groups
      .map((group) => {
        const rows = group.events.map((ev) => eventRow(ev, cursor++)).join("");
        const label =
          group.key === todayKey()
            ? "Today"
            : group.key === toKey(new Date(Date.now() + 86400000))
            ? "Tomorrow"
            : group.label;
        return `<section class="day-group">
          <header class="day-head">
            <strong>${esc(label)}</strong>
            <em>${group.events.length} meeting${group.events.length === 1 ? "" : "s"} · ${humanMinutes(group.minutes)}</em>
          </header>
          <div class="rows">${rows}</div>
        </section>`;
      })
      .join("");
  }

  // ============================================================== TIMELINE
  async function loadTimeline(dayKey) {
    const host = $("#timeline-canvas");
    if (!host) return;
    const data = await api(`/api/timeline?day=${encodeURIComponent(dayKey)}`);
    if (!data.ok) {
      store.timeline = null;
      host.innerHTML = "";
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
    const title = $("#timeline-title");
    const meta = $("#timeline-meta");
    const input = $("#tl-date");
    if (!canvas || !hours) return;

    if (input && input.value !== store.timelineDate) input.value = store.timelineDate;

    const tl = store.timeline;
    if (!tl) {
      canvas.innerHTML = "";
      hours.innerHTML = "";
      return;
    }

    if (title) title.textContent = tl.day_label || "Day timeline";
    if (meta) {
      meta.textContent = `${num(tl.event_count, 0)} meeting${num(tl.event_count, 0) === 1 ? "" : "s"} · ${tl.busy_label || "0m"} booked`;
    }

    hours.innerHTML = (tl.hours || [])
      .map((h) => `<div class="tl-hour" style="top:${num(h.top_pct, 0)}%">${esc(h.label)}</div>`)
      .join("");

    const gridlines = (tl.hours || [])
      .map((h) => `<div class="tl-gridline" style="top:${num(h.top_pct, 0)}%"></div>`)
      .join("");

    const blocks = (tl.blocks || [])
      .map((b, i) => {
        // Inset each lane slightly so neighbouring blocks never touch.
        const width = num(b.width_pct, 100);
        const left = num(b.left_pct, 0);
        const compact = num(b.height_pct, 0) < 5;
        return `<button class="tl-block${b.counts_as_busy === false ? " is-muted" : ""}"
          style="top:${num(b.top_pct, 0)}%; height:${Math.max(num(b.height_pct, 0), 2.4)}%;
                 left:calc(${left}% + 4px); width:calc(${width}% - 8px);
                 border-left-color:${esc(b.colour || "var(--ink-4)")}; ${delay(i, 35)}"
          data-event="${esc(b.id)}" type="button" title="${esc(b.summary || "")}">
          <strong>${esc(b.summary || "(no title)")}</strong>
          ${compact ? "" : `<span>${esc(b.time_label || "")}</span>`}
        </button>`;
      })
      .join("");

    const nowLine =
      tl.now_pct != null ? `<div class="tl-now" style="top:${num(tl.now_pct, 0)}%"></div>` : "";

    // An empty grid on its own reads as "still loading" - say so explicitly.
    const blank =
      (tl.blocks || []).length === 0
        ? `<div class="tl-empty">${emptyState("check", "Nothing scheduled", "This day is completely free.")}</div>`
        : "";

    canvas.innerHTML = gridlines + blocks + nowLine + blank;

    // Flag genuine clashes using the conflict groups from the main state.
    const clashIds = new Set();
    ((store.state && store.state.conflicts) || []).forEach((group) => {
      (group.events || []).forEach((ev) => clashIds.add(ev.id));
    });
    $$(".tl-block", canvas).forEach((node) => {
      if (clashIds.has(node.dataset.event)) node.classList.add("is-clash");
    });

    if (allday) {
      allday.innerHTML = (tl.all_day || [])
        .map(
          (ev) =>
            `<span class="allday-pill"><i style="background:${esc(ev.colour || "var(--ink-4)")}"></i>${esc(ev.summary || "(no title)")}</span>`
        )
        .join("");
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
    if (!host || !tightHost) return;

    const groups = (store.state && store.state.conflicts) || [];
    const tight = (store.state && store.state.tight_transitions) || [];

    if (summary) {
      summary.textContent = groups.length
        ? `${groups.length} clash${groups.length === 1 ? "" : "es"} across your calendar`
        : "Nothing overlaps - your calendar is clean.";
    }

    host.innerHTML = groups.length
      ? groups
          .map((group, i) => {
            const rows = (group.events || []).map((ev, j) => eventRow(ev, j)).join("");
            const sev = ["critical", "major", "minor"].includes(group.severity) ? group.severity : "minor";
            const chipTone = sev === "critical" ? "is-danger" : sev === "major" ? "is-warn" : "";
            return `<article class="conflict sev-${sev}" style="${delay(i, 60)}">
              <header class="conflict-head">
                ${icon("alert")}
                <strong>${esc(group.day_label || "")} · ${esc(group.window_label || "")}</strong>
                <span class="chip ${chipTone}">${esc(sev)} · ${esc(group.max_overlap_label || "")} overlap</span>
              </header>
              <div class="conflict-body"><div class="rows">${rows}</div></div>
            </article>`;
          })
          .join("")
      : emptyState("check", "No double bookings", "Every meeting on this calendar has the room to itself.");

    tightHost.innerHTML = tight.length
      ? tight
          .map(
            (item, i) => `<div class="tight" style="${delay(i, 50)}">
              <span class="tight-gap">${esc(humanMinutes(item.gap_minutes))}<br>gap</span>
              <div class="tight-side">
                <em>Ends</em>
                <strong>${esc((item.previous && item.previous.summary) || "")}</strong>
                <em>${esc((item.previous && item.previous.time_label) || "")}</em>
              </div>
              ${icon("right")}
              <div class="tight-side">
                <em>Starts</em>
                <strong>${esc((item.next && item.next.summary) || "")}</strong>
                <em>${esc((item.next && item.next.time_label) || "")}</em>
              </div>
            </div>`
          )
          .join("")
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
    host.innerHTML = `<div class="skel"><div class="skel-line"></div><div class="skel-line"></div></div>`;

    const data = await api(`/api/recommendations?duration=${duration}&days=${days}&limit=${limit}`);
    if (btn) btn.disabled = false;

    if (!data.ok) {
      host.innerHTML = emptyState("alert", "Could not score any slots", data.message || "");
      return;
    }
    store.recommendations = data.recommendations || [];
    renderSlots();
  }

  function renderSlots() {
    const host = $("#reco-list");
    if (!host) return;
    const slots = store.recommendations;

    if (!slots.length) {
      host.innerHTML = emptyState(
        "sparkle",
        "No slot fits those constraints",
        "Try a shorter meeting, a longer horizon, or widen your working hours in Settings.",
        { view: "settings", label: "Open settings" }
      );
      return;
    }

    host.innerHTML = slots
      .map((slot, i) => {
        const reasons = (slot.reasons || [])
          .slice(0, 2)
          .map((r) => `<li class="is-good">${icon("check")}<span>${esc(r)}</span></li>`)
          .join("");
        const warnings = (slot.warnings || [])
          .slice(0, 2)
          .map((w) => `<li class="is-warn">${icon("alert")}<span>${esc(w)}</span></li>`)
          .join("");
        const grade = ["excellent", "good", "fair", "poor"].includes(slot.grade) ? slot.grade : "poor";
        return `<article class="slot" style="${delay(i, 55)}">
          <div class="slot-head">
            <div>
              <div class="slot-day">${esc(slot.day_label || "")}</div>
              <div class="slot-time">${esc(slot.time_label || "")}</div>
            </div>
            <div class="slot-score g-${grade}" title="${esc(slot.grade_label || "")}">${num(slot.score, 0)}</div>
          </div>
          <div class="slot-bar"><i data-grow="${clamp(num(slot.score, 0), 0, 100)}"></i></div>
          <ul class="slot-reasons">${reasons}${warnings}</ul>
        </article>`;
      })
      .join("");

    growBars(host);
  }

  // ============================================================== SETTINGS
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function timezoneOptions(current) {
    let zones = [];
    try {
      if (typeof Intl.supportedValuesOf === "function") zones = Intl.supportedValuesOf("timeZone");
    } catch (e) {
      zones = [];
    }
    if (!zones.length) {
      zones = [
        "UTC", "Africa/Lagos", "Africa/Cairo", "Africa/Johannesburg", "Africa/Nairobi",
        "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
        "Europe/Moscow", "America/New_York", "America/Chicago", "America/Denver",
        "America/Los_Angeles", "America/Sao_Paulo", "Asia/Dubai", "Asia/Karachi",
        "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore",
        "Australia/Sydney", "Pacific/Auckland",
      ];
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
      const value = String(num(resolved.reminder_minutes, 30));
      if (!Array.from(reminder.options).some((o) => o.value === value)) {
        reminder.add(new Option(`${value} minutes`, value));
      }
      reminder.value = value;
    }

    const tzSelect = $("#set-timezone");
    if (tzSelect) {
      const current = resolved.timezone || TZ_HINT;
      if (tzSelect.dataset.filled !== "1") {
        tzSelect.innerHTML = timezoneOptions(current)
          .map((z) => `<option value="${esc(z)}">${esc(z)}</option>`)
          .join("");
        tzSelect.dataset.filled = "1";
      }
      tzSelect.value = current;
    }

    const start = $("#set-work-start");
    const end = $("#set-work-end");
    if (start) start.value = resolved.work_start || "09:00";
    if (end) end.value = resolved.work_end || "17:30";

    const buffer = $("#set-buffer");
    if (buffer) {
      const value = String(num(resolved.buffer_minutes, 10));
      if (!Array.from(buffer.options).some((o) => o.value === value)) {
        buffer.add(new Option(`${value} minutes`, value));
      }
      buffer.value = value;
    }

    const picker = $("#set-workdays");
    if (picker) {
      const active = new Set(Array.isArray(resolved.work_days) ? resolved.work_days : [0, 1, 2, 3, 4]);
      picker.innerHTML = DAY_NAMES.map(
        (name, i) =>
          `<button class="day-toggle${active.has(i) ? " is-on" : ""}" data-day-index="${i}"
             type="button" aria-pressed="${active.has(i)}">${name}</button>`
      ).join("");
    }

    const browserNotif = $("#set-browser-notif");
    if (browserNotif) browserNotif.checked = prefs.browser_notifications !== false;

    const emailNotif = $("#set-email-notif");
    const emailHint = $("#email-hint");
    if (emailNotif) {
      emailNotif.checked = !!prefs.email_reminders;
      emailNotif.disabled = !resolved.email_available;
    }
    if (emailHint) {
      emailHint.textContent = resolved.email_available
        ? "SMTP is configured and ready."
        : "Add SMTP_USER and SMTP_PASSWORD to .env to enable this.";
    }

    const perm = $("#notif-perm");
    if (perm) {
      if (!("Notification" in window)) perm.textContent = "Not supported by this browser.";
      else if (Notification.permission === "granted") perm.textContent = "Permission granted.";
      else if (Notification.permission === "denied") perm.textContent = "Blocked in your browser settings.";
      else perm.textContent = "We'll ask for permission when you enable this.";
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
      const profile = g.profile || {};
      title = `Connected to Google Calendar`;
      const who = profile.email || OWNER;
      text = `${who} · ${num(sync.count, 0)} events cached · last synced ${sync.last_sync_label || "never"}`;
    } else if (s.data_mode === "demo") {
      glyph = "sparkle";
      title = "Sample calendar loaded";
      text = `${num(sync.count, 0)} generated meetings. Nothing here touches a real account.`;
    }

    host.innerHTML = `
      <span class="source-icon">${icon(glyph)}</span>
      <div class="source-text">
        <strong>${esc(title)}</strong>
        <p>${esc(text)}</p>
      </div>
      ${g.connected ? "" : `<button class="btn btn-primary sm" id="source-connect" type="button">${icon("google")}<span>Connect Google</span></button>`}
    `;

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

    if (!result.ok) {
      toast(result.message || "Could not save your settings.", "danger");
      return;
    }
    if (!workDays.length) toast("Keeping your previous working days - at least one is required.", "danger");
    else toast("Settings saved.", "good");
    await refresh();
  }

  // ========================================================= NOTIFICATIONS
  function renderDrawer() {
    const host = $("#drawer-list");
    if (!host) return;
    const items = (store.state && store.state.notifications) || [];

    if (!items.length) {
      host.innerHTML = emptyState("bell", "No notifications", "Reminders show up here before each meeting starts.");
      return;
    }

    host.innerHTML = items
      .map(
        (n, i) => `<div class="notif${n.seen ? "" : " is-unseen"}" style="${delay(i, 40)}">
          <span class="notif-icon${n.is_conflict ? " is-clash" : ""}">${icon(n.is_conflict ? "alert" : "bell")}</span>
          <span class="notif-main">
            <strong>${esc(n.title)}</strong>
            <p>${esc(n.body)}</p>
            <span class="notif-time">${esc(n.created_label || "")}</span>
          </span>
          <button class="notif-x" data-dismiss-notif="${esc(n.id)}" type="button" aria-label="Dismiss">${icon("close")}</button>
        </div>`
      )
      .join("");
  }

  function updateBell() {
    const badge = $("#bell-badge");
    if (!badge) return;
    const items = (store.state && store.state.notifications) || [];
    const unseen = items.filter((n) => !n.seen).length;
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
        if (store.state && store.state.notifications) {
          store.state.notifications.forEach((n) => {
            n.seen = true;
          });
        }
        updateBell();
      });
    }
  }

  function closeDrawer() {
    const drawer = $("#drawer");
    const scrim = $("#drawer-scrim");
    if (drawer) {
      drawer.classList.add("is-hidden");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (scrim) scrim.classList.add("is-hidden");
  }

  /** Raise a desktop notification for reminders we have not shown yet. */
  function pushDesktopNotifications() {
    const prefs = (store.state && store.state.preferences) || {};
    if (prefs.browser_notifications === false) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    ((store.state && store.state.notifications) || []).forEach((n) => {
      if (n.seen || store.seenNotifIds.has(n.id)) return;
      store.seenNotifIds.add(n.id);
      try {
        new Notification(n.title, { body: n.body, tag: `mm-${n.id}` });
      } catch (e) {
        /* some browsers block constructor-based notifications - ignore */
      }
    });
  }

  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-dismiss-notif]");
    if (!btn) return;
    const id = btn.dataset.dismissNotif;
    const node = btn.closest(".notif");
    if (node) node.style.opacity = "0.4";
    const result = await post(`/api/notifications/${encodeURIComponent(id)}/dismiss`);
    if (!result.ok) {
      if (node) node.style.opacity = "";
      toast(result.message || "Could not dismiss that notification.", "danger");
      return;
    }
    await refresh();
    const drawer = $("#drawer");
    if (drawer && !drawer.classList.contains("is-hidden")) renderDrawer();
  });

  // ================================================================ MODAL
  function openEvent(id) {
    const events = (store.state && store.state.events) || [];
    const ev = events.find((e) => String(e.id) === String(id));
    if (!ev) {
      toast("That meeting is no longer on the calendar.", "danger");
      return;
    }

    const chips = [];
    if (ev.in_conflict) chips.push(`<span class="chip is-danger">${icon("alert")}Double booked</span>`);
    if (ev.all_day) chips.push(`<span class="chip">All day</span>`);
    if (ev.recurring) chips.push(`<span class="chip">Recurring</span>`);
    if (ev.response_status === "declined") chips.push(`<span class="chip is-danger">You declined</span>`);
    if (ev.status === "cancelled") chips.push(`<span class="chip is-danger">Cancelled</span>`);
    if (ev.has_meet) chips.push(`<span class="chip is-info">${icon("video")}Video call</span>`);

    const facts = [];
    facts.push(["Duration", esc(ev.duration_label || humanMinutes(ev.duration_minutes))]);
    if (ev.calendar_name) facts.push(["Calendar", esc(ev.calendar_name)]);
    if (ev.location) facts.push(["Location", esc(ev.location)]);
    if (ev.organizer_name || ev.organizer_email) {
      facts.push(["Organiser", esc(ev.organizer_name || ev.organizer_email)]);
    }
    if (ev.description) {
      const text = String(ev.description).replace(/<[^>]*>/g, " ").trim().slice(0, 400);
      if (text) facts.push(["Notes", esc(text)]);
    }

    const attendees = (ev.attendees || []).slice(0, 12);
    if (attendees.length) {
      const list = attendees
        .map((a) => {
          const who = a.name || a.displayName || a.email || "Unknown";
          const status = String(a.response_status || a.responseStatus || "").toLowerCase();
          const label =
            status === "accepted" ? "Going" : status === "declined" ? "Declined" : status === "tentative" ? "Maybe" : "No reply";
          const tone = status === "accepted" ? "is-yes" : status === "declined" ? "is-no" : "";
          return `<div class="attendee">
            <span class="avatar">${esc(initials(who))}</span>
            <span>${esc(who)}</span>
            <span class="attendee-state ${tone}">${esc(label)}</span>
          </div>`;
        })
        .join("");
      facts.push([
        `Attendees`,
        `<div class="attendees">${list}${(ev.attendees || []).length > 12 ? `<span class="card-sub">+${(ev.attendees || []).length - 12} more</span>` : ""}</div>`,
      ]);
    }

    const when = `${ev.day_label || ""} · ${ev.time_label || ""}`.replace(/^ · /, "");

    $("#modal-body").innerHTML = `
      <h2 class="modal-title" id="modal-title">${esc(ev.summary || "(no title)")}</h2>
      <p class="modal-when">${esc(when)}</p>
      ${chips.length ? `<div class="modal-chips">${chips.join("")}</div>` : ""}
      <dl class="modal-facts">
        ${facts.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}
      </dl>
      <div class="modal-actions">
        ${ev.meet_link ? `<a class="btn btn-primary sm" href="${esc(ev.meet_link)}" target="_blank" rel="noreferrer">${icon("video")}<span>Join call</span></a>` : ""}
        ${ev.html_link ? `<a class="btn btn-quiet sm" href="${esc(ev.html_link)}" target="_blank" rel="noreferrer">${icon("link")}<span>Open in Google</span></a>` : ""}
        <button class="btn btn-quiet sm" data-open-timeline="${esc(ev.date_key)}" type="button">${icon("clock")}<span>See the day</span></button>
      </div>`;

    $("#modal-scrim").classList.remove("is-hidden");
  }

  const closeModal = () => $("#modal-scrim").classList.add("is-hidden");

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-event]");
    if (trigger) {
      openEvent(trigger.dataset.event);
      return;
    }
    const day = event.target.closest("[data-open-timeline]");
    if (day) {
      store.timelineDate = day.dataset.openTimeline;
      store.selectedDay = day.dataset.openTimeline;
      closeModal();
      setView("timeline");
    }
  });

  // ================================================================ ACTIONS
  function startAuth() {
    window.location.href = "/auth/login";
  }

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
    if (!events.length) {
      toast("There is nothing to export yet.", "danger");
      return;
    }

    const stamp = (iso) => {
      const d = parseLocal(iso);
      if (!d) return "";
      return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    };
    // RFC 5545: escape separators, then fold lines at 75 octets.
    const clean = (v) =>
      String(v == null ? "" : v)
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
    const fold = (line) => {
      const out = [];
      let rest = line;
      while (rest.length > 74) {
        out.push(rest.slice(0, 74));
        rest = ` ${rest.slice(74)}`;
      }
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
    if (!("Notification" in window)) {
      toast("This browser does not support desktop notifications.", "danger");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    renderSettings();
    if (permission !== "granted") {
      toast("Desktop notifications are blocked in your browser settings.", "danger");
      return;
    }
    try {
      new Notification("MeetManager test reminder", {
        body: "This is what a meeting reminder will look like.",
        tag: "mm-test",
      });
      toast("Test reminder sent.", "good");
    } catch (e) {
      toast("Your browser refused to show the notification.", "danger");
    }
  }

  // ================================================================ RENDER
  function render() {
    try {
      store.lastError = null;
      renderNav();
      renderHero();
      renderStatCards();
      renderDashNotifications();
      renderUpNext();
      renderMonth();
      renderTodayList();
      renderRings();
      renderNextMeeting();
      renderAgenda();
      renderConflicts();
      renderSettings();
      updateBell();
      updateConnectButton();
      pushDesktopNotifications();
      if (store.view === "timeline") renderTimeline();
    } catch (err) {
      // A render bug must never leave the user staring at a blank page.
      store.lastError = err && err.message ? err.message : String(err);
      /* eslint-disable-next-line no-console */
      console.error("MeetManager render failed:", err);
    }
    renderBanners();
  }

  async function refresh() {
    const data = await api(`/api/state?day=${encodeURIComponent(store.timelineDate)}`);
    if (!data.ok) {
      store.loading = false;
      store.lastError = data.message || "Could not load the dashboard.";
      renderBanners();
      return;
    }
    store.state = data.state;
    store.loading = false;
    if (!store.timeline && store.state.timeline) store.timeline = store.state.timeline;
    render();
  }

  // ------------------------------------------------------------- countdown
  function tick() {
    const node = $("#next-countdown");
    if (node) {
      const start = parseLocal(node.dataset.start);
      const end = parseLocal(node.dataset.end);
      const now = new Date();
      if (start && end) {
        if (now >= end) node.textContent = "Finished";
        else if (now >= start) {
          const left = Math.round((end - now) / 60000);
          node.textContent = `In progress · ${humanMinutes(left)} left`;
        } else {
          const secs = Math.floor((start - now) / 1000);
          if (secs < 60) node.textContent = `Starts in ${secs}s`;
          else node.textContent = `Starts in ${humanMinutes(Math.floor(secs / 60))}`;
        }
      }
    }

    // Keep today's progress bars honest without a full re-render.
    $$("#today-list .row").forEach((row) => {
      const bar = row.querySelector("[data-grow]");
      if (!bar) return;
      const id = row.dataset.event;
      const ev = ((store.state && store.state.events) || []).find((e) => String(e.id) === String(id));
      if (!ev) return;
      const start = parseLocal(ev.local_start);
      const end = parseLocal(ev.local_end);
      if (!start || !end || end <= start) return;
      const pct = clamp(((new Date() - start) / (end - start)) * 100, 0, 100);
      bar.style.width = `${pct.toFixed(1)}%`;
    });
  }

  // ================================================================== INIT
  function bind() {
    // Theme -----------------------------------------------------------
    $$(".tt-btn").forEach((btn) =>
      btn.addEventListener("click", () => applyTheme(btn.dataset.themeSet, true))
    );

    // Top bar ---------------------------------------------------------
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
        store.agendaQuery = search.value;
        const agendaSearch = $("#agenda-search");
        if (agendaSearch) agendaSearch.value = search.value;
        if (search.value && store.view !== "meetings") setView("meetings");
        renderAgenda();
      });
    }

    // Hero ------------------------------------------------------------
    const heroFind = $("#hero-find");
    if (heroFind) heroFind.addEventListener("click", () => setView("slots"));
    const heroToday = $("#hero-today");
    if (heroToday) {
      heroToday.addEventListener("click", () => {
        store.timelineDate = todayKey();
        setView("timeline");
      });
    }
    const ctaFind = $("#cta-find");
    if (ctaFind) ctaFind.addEventListener("click", () => setView("slots"));

    const clearNotifs = $("#btn-clear-notifs");
    if (clearNotifs) clearNotifs.addEventListener("click", dismissAllNotifications);

    // Month -----------------------------------------------------------
    const prev = $("#month-prev");
    if (prev) {
      prev.addEventListener("click", () => {
        store.monthAnchor = new Date(store.monthAnchor.getFullYear(), store.monthAnchor.getMonth() - 1, 1);
        renderMonth();
      });
    }
    const next = $("#month-next");
    if (next) {
      next.addEventListener("click", () => {
        store.monthAnchor = new Date(store.monthAnchor.getFullYear(), store.monthAnchor.getMonth() + 1, 1);
        renderMonth();
      });
    }
    const grid = $("#month-grid");
    if (grid) {
      grid.addEventListener("click", (event) => {
        const cell = event.target.closest("[data-day]");
        if (!cell) return;
        store.selectedDay = cell.dataset.day;
        renderMonth();
      });
    }

    // Agenda ----------------------------------------------------------
    const agendaSearch = $("#agenda-search");
    if (agendaSearch) {
      agendaSearch.addEventListener("input", () => {
        store.agendaQuery = agendaSearch.value;
        const globalSearch = $("#global-search");
        if (globalSearch) globalSearch.value = agendaSearch.value;
        renderAgenda();
      });
    }
    const agendaFilter = $("#agenda-filter");
    if (agendaFilter) {
      agendaFilter.addEventListener("change", () => {
        store.agendaFilter = agendaFilter.value;
        renderAgenda();
      });
    }

    // Timeline --------------------------------------------------------
    const tlPrev = $("#tl-prev");
    if (tlPrev) tlPrev.addEventListener("click", () => shiftTimeline(-1));
    const tlNext = $("#tl-next");
    if (tlNext) tlNext.addEventListener("click", () => shiftTimeline(1));
    const tlToday = $("#tl-today");
    if (tlToday) {
      tlToday.addEventListener("click", () => {
        store.timelineDate = todayKey();
        loadTimeline(store.timelineDate);
      });
    }
    const tlDate = $("#tl-date");
    if (tlDate) {
      tlDate.addEventListener("change", () => {
        if (!tlDate.value) return;
        store.timelineDate = tlDate.value;
        loadTimeline(store.timelineDate);
      });
    }

    // Slots -----------------------------------------------------------
    const reco = $("#btn-reco");
    if (reco) reco.addEventListener("click", loadRecommendations);
    ["#reco-duration", "#reco-days", "#reco-limit"].forEach((sel) => {
      const node = $(sel);
      if (node) node.addEventListener("change", loadRecommendations);
    });

    // Settings --------------------------------------------------------
    const save = $("#btn-save-settings");
    if (save) save.addEventListener("click", saveSettings);
    const test = $("#btn-test-notif");
    if (test) test.addEventListener("click", testNotification);
    const demo = $("#btn-demo");
    if (demo) demo.addEventListener("click", loadDemo);
    const clear = $("#btn-clear");
    if (clear) clear.addEventListener("click", clearData);
    const disconnectBtn = $("#btn-disconnect");
    if (disconnectBtn) disconnectBtn.addEventListener("click", disconnect);

    const workdays = $("#set-workdays");
    if (workdays) {
      workdays.addEventListener("click", (event) => {
        const toggle = event.target.closest(".day-toggle");
        if (!toggle) return;
        const on = toggle.classList.toggle("is-on");
        toggle.setAttribute("aria-pressed", String(on));
      });
    }

    const browserNotif = $("#set-browser-notif");
    if (browserNotif) {
      browserNotif.addEventListener("change", async () => {
        if (browserNotif.checked && "Notification" in window && Notification.permission === "default") {
          await Notification.requestPermission();
          renderSettings();
        }
      });
    }

    // Drawer / modal --------------------------------------------------
    const closeDrawerBtn = $("#btn-close-drawer");
    if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeDrawer);
    const drawerScrim = $("#drawer-scrim");
    if (drawerScrim) drawerScrim.addEventListener("click", closeDrawer);
    const dismissAll = $("#btn-dismiss-all");
    if (dismissAll) dismissAll.addEventListener("click", dismissAllNotifications);

    const modalClose = $("#modal-close");
    if (modalClose) modalClose.addEventListener("click", closeModal);
    const modalScrim = $("#modal-scrim");
    if (modalScrim) {
      modalScrim.addEventListener("click", (event) => {
        if (event.target === modalScrim) closeModal();
      });
    }

    // Keyboard --------------------------------------------------------
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModal();
        closeDrawer();
        return;
      }
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        const box = $("#global-search");
        if (box) box.focus();
      }
    });

    window.addEventListener("resize", positionThemeThumb);
  }

  async function dismissAllNotifications() {
    const result = await post("/api/notifications/dismiss-all");
    if (!result.ok) {
      toast(result.message || "Could not clear notifications.", "danger");
      return;
    }
    toast("Notifications cleared.", "good");
    await refresh();
    renderDrawer();
  }

  /** Surface the ?auth= / ?auth_error= flags the OAuth callback redirects with. */
  function consumeAuthFlags() {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    const auth = params.get("auth");
    if (authError) toast(`Google sign-in failed: ${authError}`, "danger");
    else if (auth === "connected") toast("Google Calendar connected.", "good");
    else if (auth === "connected_sync_failed") toast("Connected, but the first sync failed. Try Sync.", "danger");
    if (auth || authError) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  function updateConnectButton() {
    const btn = $("#btn-connect");
    const label = $("#btn-connect-label");
    if (!btn || !label || !store.state) return;
    const g = store.state.google || {};
    if (g.connected) {
      label.textContent = "Calendar connected";
      btn.disabled = true;
      btn.classList.remove("btn-primary");
      btn.classList.add("btn-quiet");
    } else {
      label.textContent = "Connect calendar";
      btn.disabled = false;
      btn.classList.add("btn-primary");
      btn.classList.remove("btn-quiet");
    }
  }

  async function boot() {
    // Honour the OS preference on a first visit, before anything renders.
    let stored = null;
    try {
      stored = localStorage.getItem("mm-theme");
    } catch (e) {
      stored = null;
    }
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(stored || (prefersDark ? "dark" : "light"), false);

    bind();
    renderNav();
    renderStatCards();
    consumeAuthFlags();

    const input = $("#tl-date");
    if (input) input.value = store.timelineDate;

    await refresh();
    updateConnectButton();

    setInterval(tick, 1000);
    setInterval(async () => {
      await refresh();
      updateConnectButton();
    }, 30000);
    tick();
  }

  // A spin keyframe is only needed by the sync button, so it lives here.
  const spinStyle = document.createElement("style");
  spinStyle.textContent = "@keyframes spin{to{transform:rotate(360deg)}}";
  document.head.appendChild(spinStyle);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
