/**
 * Layout + console audit.
 *
 * Walks every view in both themes at three viewport widths and fails on:
 *   - any console error or warning, or an uncaught page error
 *   - any failed request or 4xx/5xx response
 *   - any visible element whose box falls outside the viewport
 *   - a view that renders empty, or a modal that will not open
 *
 * Screenshots land in ./shots for eyeballing after a CI run.
 *
 *   MM_BASE_URL=http://127.0.0.1:8000/ node audit.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.MM_BASE_URL || "http://127.0.0.1:8000/";
const OUT = "shots";
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const browser = await chromium.launch();

async function audit(label, viewport, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      problems.push(`[${label}] console.${m.type()}: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    problems.push(`[${label}] requestfailed: ${r.url()} :: ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  if (theme === "light") {
    await page.click("#btn-theme"); // dark is the default
    await page.waitForTimeout(400);
  }

  // Wait until the dashboard has actually painted real data.
  await page
    .waitForFunction(
      () => {
        const v = document.querySelector(".stat-value");
        return v && v.textContent.trim() !== "";
      },
      { timeout: 20000 }
    )
    .catch(() => problems.push(`[${label}] stat cards never rendered`));
  await page.waitForTimeout(900);

  const views = ["dashboard", "meetings", "timeline", "conflicts", "slots", "settings"];
  for (const view of views) {
    await page.click(`.rail-btn[data-view="${view}"], #rail-settings[data-view="${view}"]`);
    await page.waitForTimeout(view === "timeline" || view === "slots" ? 1400 : 700);

    // body sets overflow:hidden, so documentElement.scrollWidth can never grow
    // to report a break. Measure every visible box against the viewport instead
    // - that is what catches an action cluster running off the right edge.
    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.closest(".sprite") || el.closest(".is-hidden")) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1)) {
          bad.push(
            `${el.tagName}.${(el.className || "").toString().split(" ")[0]} left=${Math.round(r.left)} right=${Math.round(r.right)} vw=${vw}`
          );
        }
      });
      return bad.slice(0, 5);
    });
    if (overflow.length) {
      problems.push(`[${label}/${view}] element(s) outside the viewport: ${overflow.join(" | ")}`);
    }

    const empty = await page.evaluate(() => {
      const v = document.querySelector(".view.is-active");
      return !v || v.getBoundingClientRect().height < 60;
    });
    if (empty) problems.push(`[${label}/${view}] active view rendered empty`);

    await page.screenshot({ path: `${OUT}/${label}-${view}.png` });
  }

  // Interactive surfaces.
  await page.click('.rail-btn[data-view="dashboard"]');
  await page.waitForTimeout(500);
  await page.click("#btn-bell");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${label}-drawer.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const row = page.locator("#today-list .row, #dash-upnext .row").first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(600);
    if (!(await page.locator("#modal-scrim:not(.is-hidden)").count())) {
      problems.push(`[${label}] event modal did not open`);
    }
    await page.screenshot({ path: `${OUT}/${label}-modal.png` });
    await page.keyboard.press("Escape");
  } else {
    problems.push(`[${label}] no meeting rows to click on the dashboard`);
  }

  await ctx.close();
}

await audit("dark", { width: 1440, height: 900 }, "dark");
await audit("light", { width: 1440, height: 900 }, "light");
await audit("narrow", { width: 820, height: 900 }, "dark");
await audit("mobile", { width: 390, height: 844 }, "dark");

await browser.close();

console.log("\n================ UI AUDIT ================");
if (!problems.length) {
  console.log("  CLEAN - no console errors, no failed requests, no overflow.\n");
  process.exit(0);
}
const seen = new Set();
problems.filter((p) => !seen.has(p) && seen.add(p)).forEach((p) => console.log("  * " + p));
console.log(`\n  ${seen.size} distinct problem(s).\n`);
process.exit(1);
