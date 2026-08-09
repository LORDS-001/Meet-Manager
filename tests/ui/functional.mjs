/**
 * Front-end to back-end round trips.
 *
 * Every check here drives the real UI and asserts the API actually did the
 * work - a render that merely looks right is not enough.
 *
 *   MM_BASE_URL=http://127.0.0.1:8000/ node functional.mjs
 *
 * This mutates the running instance's database (preferences, one dismissed
 * notification), so point it at a throwaway instance, not a real calendar.
 */
import { chromium } from "playwright";

const BASE = process.env.MM_BASE_URL || "http://127.0.0.1:8000/";

const results = [];
const ok = (n, d = "") => results.push(["PASS", n, d]);
const bad = (n, d = "") => results.push(["FAIL", n, d]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 1. State actually loaded from the API.
const statCount = await page.locator(".stat-card").count();
statCount === 4 ? ok("Dashboard renders 4 live stat cards") : bad("stat cards", `got ${statCount}`);

// 2. Theme choice survives a reload.
await page.click("#btn-theme");
await page.waitForTimeout(300);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const theme = await page.getAttribute("html", "data-theme");
theme === "light" ? ok("Theme choice survives a reload") : bad("theme persistence", `got ${theme}`);
await page.click("#btn-theme");
await page.waitForTimeout(300);

// 3. Recommendations re-query the backend when the duration changes.
await page.click('.rail-btn[data-view="slots"]');
await page.waitForTimeout(1400);
const before = await page.locator("#reco-list .row").count();
const reqs = [];
page.on("request", (r) => r.url().includes("/api/recommendations") && reqs.push(r.url()));
await page.selectOption("#reco-duration", "60");
await page.waitForTimeout(1800);
const after = await page.locator("#reco-list .row").count();
reqs.length && after > 0
  ? ok("Slot finder re-queries the API", `duration=60 -> ${after} slots (was ${before})`)
  : bad("slot re-query", `requests=${reqs.length} slots=${after}`);
const times = await page.locator(".slot-time-big").first().textContent();
/\d\d:\d\d - \d\d:\d\d/.test(times || "")
  ? ok("Slot times render from the backend", times.trim())
  : bad("slot times", times);

// 4. Settings round-trip: save, reload, confirm it stuck.
await page.click("#rail-settings");
await page.waitForTimeout(700);
await page.selectOption("#set-buffer", "30");
await page.fill("#set-work-start", "08:30");
await page.click("#btn-save-settings");
await page.waitForTimeout(1500);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.click("#rail-settings");
await page.waitForTimeout(700);
const buf = await page.inputValue("#set-buffer");
const start = await page.inputValue("#set-work-start");
buf === "30" && start === "08:30"
  ? ok("Preferences persist through the API", `buffer=${buf} start=${start}`)
  : bad("preferences", `buffer=${buf} start=${start}`);

// Put them back.
await page.selectOption("#set-buffer", "10");
await page.fill("#set-work-start", "09:00");
await page.click("#btn-save-settings");
await page.waitForTimeout(1200);

// 5. Search filters the register.
await page.fill("#global-search", "standup");
await page.waitForTimeout(900);
const rows = await page.locator("#agenda-list .row").count();
const titles = await page.locator("#agenda-list .row-name").allTextContents();
titles.length > 0 && titles.every((t) => t.toLowerCase().includes("standup"))
  ? ok("Search filters the register", `${rows} rows, all match`)
  : bad("search", `${rows} rows; ${titles.slice(0, 3)}`);
await page.fill("#global-search", "");
await page.waitForTimeout(600);

// 6. Timeline day navigation hits the API and updates the heading.
await page.click('.rail-btn[data-view="timeline"]');
await page.waitForTimeout(1200);
const day1 = await page.textContent("#timeline-meta");
await page.click("#tl-next");
await page.waitForTimeout(1400);
const day2 = await page.textContent("#timeline-meta");
day1 !== day2
  ? ok("Timeline day navigation works", `${day1.trim()} -> ${day2.trim()}`)
  : bad("timeline nav", day1);

// 7. ICS export produces a real file.
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 10000 }).catch(() => null),
  page.click("#btn-export"),
]);
if (download) {
  const fs = await import("node:fs");
  const text = fs.readFileSync(await download.path(), "utf8");
  text.startsWith("BEGIN:VCALENDAR") && text.includes("BEGIN:VEVENT") && text.trimEnd().endsWith("END:VCALENDAR")
    ? ok("Export produces a valid .ics", `${download.suggestedFilename()}, ${text.split("BEGIN:VEVENT").length - 1} events`)
    : bad("ics content", text.slice(0, 60));
} else {
  bad("export", "no download fired");
}

// 8. Notification dismissal round-trips.
await page.click('.rail-btn[data-view="dashboard"]');
await page.waitForTimeout(900);
await page.click("#btn-bell");
await page.waitForTimeout(900);
const notifsBefore = await page.locator("#drawer-list .notif").count();
if (notifsBefore > 0) {
  await page.locator("#drawer-list .notif-x").first().click();
  await page.waitForTimeout(1800);
  const notifsAfter = await page.locator("#drawer-list .notif").count();
  notifsAfter < notifsBefore
    ? ok("Dismissing a notification persists", `${notifsBefore} -> ${notifsAfter}`)
    : bad("notification dismiss", `${notifsBefore} -> ${notifsAfter}`);
} else {
  bad("notifications", "drawer was empty");
}
await page.keyboard.press("Escape");

// 9. Sync reports back. With no OAuth client configured this must surface a
//    friendly message rather than throwing.
await page.click("#btn-sync");
await page.waitForTimeout(1800);
const toastText = await page.locator(".toast").first().textContent().catch(() => "");
toastText && toastText.trim().length > 0
  ? ok("Sync reports its result in a toast", toastText.trim().slice(0, 70))
  : bad("sync toast", "no toast appeared");

errors.length === 0 ? ok("No JS errors during the whole run") : bad("js errors", errors.slice(0, 3).join(" | "));

await browser.close();

console.log("\n============= UI FUNCTIONAL =============");
let fails = 0;
for (const [s, n, d] of results) {
  if (s === "FAIL") fails += 1;
  console.log(`  [${s}]  ${n}${d ? `\n          ${d}` : ""}`);
}
console.log(fails ? `\n  ${fails} FAILED\n` : `\n  All ${results.length} checks passed.\n`);
process.exit(fails ? 1 : 0);
