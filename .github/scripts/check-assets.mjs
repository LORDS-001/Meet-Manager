/**
 * Static consistency checks across the three front-end files.
 *
 * These are the failure modes that do not throw at runtime and so never show
 * up as a console error - the page just renders slightly wrong:
 *
 *   1. an <use href="#i-foo"> pointing at an icon that is not in the sprite
 *   2. a $("#foo") in app.js whose element exists in neither the template nor
 *      any markup app.js itself generates
 *   3. an unbalanced brace in the stylesheet
 *   4. a var(--foo) that is never defined
 *
 * Run from the repo root:  node .github/scripts/check-assets.mjs
 */
import fs from "node:fs";

const HTML = fs.readFileSync("app/templates/index.html", "utf8");
const JS = fs.readFileSync("app/static/app.js", "utf8");
const CSS = fs.readFileSync("app/static/styles.css", "utf8");

const failures = [];
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

// --- 1. Icon sprite ------------------------------------------------------
const defined = new Set(all(/<g id="(i-[a-z0-9-]+)"/g, HTML));
const used = new Set([...all(/href="#(i-[a-z0-9-]+)"/g, HTML), ...all(/#i-\$\{name\}|#(i-[a-z0-9-]+)/g, JS).filter(Boolean)]);
// app.js builds icon refs as `#i-${name}` from a literal argument.
all(/icon\("([a-z0-9-]+)"/g, JS).forEach((n) => used.add(`i-${n}`));

for (const ref of used) {
  if (!defined.has(ref)) failures.push(`icon "${ref}" is referenced but not defined in the sprite`);
}
if (!defined.size) failures.push("no icon symbols found in the sprite at all");

// --- 2. Element ids ------------------------------------------------------
// Anything with an id in the template, plus anything app.js writes into the
// DOM itself (banners, the source panel, the countdown, ...).
// `id:` object properties count too - banners carry their button id as data
// and interpolate it into the markup, so it never appears as a literal id="".
const known = new Set([
  ...all(/\bid="([A-Za-z0-9_-]+)"/g, HTML),
  ...all(/\bid="([A-Za-z0-9_-]+)"/g, JS),
  ...all(/\bid:\s*["']([A-Za-z0-9_-]+)["']/g, JS),
]);
const queried = new Set(all(/\$\("#([A-Za-z0-9_-]+)"/g, JS));
for (const id of queried) {
  if (!known.has(id)) failures.push(`app.js queries #${id}, which nothing ever creates`);
}

// --- 3. Stylesheet braces ------------------------------------------------
const opens = (CSS.match(/\{/g) || []).length;
const closes = (CSS.match(/\}/g) || []).length;
if (opens !== closes) failures.push(`styles.css has ${opens} "{" and ${closes} "}" - unbalanced`);

// --- 4. Custom properties ------------------------------------------------
// Tokens can also be set inline from JS (the stagger delay, --d), so scan both.
const tokens = new Set([...all(/(--[A-Za-z0-9_-]+)\s*:/g, CSS), ...all(/(--[A-Za-z0-9_-]+)\s*:/g, JS)]);
// var(--x, fallback) is safe whether or not --x is ever set; only bare uses
// are a genuine missing-token bug.
const bareUses = (src) => [...src.matchAll(/var\((--[A-Za-z0-9_-]+)\s*([,)])/g)].filter((m) => m[2] === ")").map((m) => m[1]);
for (const t of new Set(bareUses(CSS))) {
  if (!tokens.has(t)) failures.push(`styles.css uses var(${t}), which is never defined`);
}
for (const t of new Set(bareUses(JS))) {
  if (!tokens.has(t)) failures.push(`app.js uses var(${t}), which is never defined`);
}

// --- report --------------------------------------------------------------
console.log("\n============ ASSET CONSISTENCY ============");
console.log(`  ${defined.size} icons, ${known.size} ids, ${tokens.size} css tokens`);
if (!failures.length) {
  console.log("  CLEAN - every reference resolves.\n");
  process.exit(0);
}
failures.forEach((f) => console.log("  * " + f));
console.log(`\n  ${failures.length} problem(s).\n`);
process.exit(1);
