// Records demo footage of video/session.html, which renders the REAL MCP transcript from scripts/demo.ts.
// Each story line's actions start when its narration starts; then it holds until the line's audio ends.
// Writes <build>/footage.webm and <build>/timeline.json.
// Usage: node scripts/video/footage.mjs video/story.json video/build
// Playwright is not a dependency of this package; set PLAYWRIGHT_FROM to a folder whose node_modules has it.
import { createRequire } from "node:module";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(join(resolve(process.env.PLAYWRIGHT_FROM ?? "."), "node_modules") + "/");
const { chromium } = require("playwright");

const [storyPath, build] = process.argv.slice(2);
const story = JSON.parse(readFileSync(storyPath, "utf8"));
const durs = JSON.parse(readFileSync(join(build, "durations.json"), "utf8"));
const transcript = JSON.parse(readFileSync(join(build, "transcript.json"), "utf8"));
const GAP = story.gap ?? 0.25;
const vdir = join(build, "raw-video"); mkdirSync(vdir, { recursive: true });
const browser = await chromium.launch();
// The page area is 1920x940; assemble.py adds a 140 px caption bar below it, so captions never cover the page.
const ctx = await browser.newContext({ viewport: { width: 1920, height: 940 }, recordVideo: { dir: vdir, size: { width: 1920, height: 940 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(pathToFileURL(resolve("video/session.html")).href + "?card=title");
await page.evaluate((t) => window.load(t), transcript);
const ACTIONS = {
  card: (n) => page.evaluate((n) => window.card(n), n),
  show: (s) => page.evaluate((s) => window.show(s), s),
  hl: (sel) => page.evaluate((sel) => window.hl(sel), sel),
  wait: (ms) => sleep(ms),
};
await sleep(600);
const timeline = [];
for (const ln of story.lines) {
  const start = (Date.now() - t0) / 1000;
  timeline.push({ id: ln.id, start });
  const target = start + durs[ln.id] + (ln.gap ?? GAP);
  for (const [name, ...args] of ln.do ?? []) {
    if (!ACTIONS[name]) throw new Error("unknown action " + name);
    await ACTIONS[name](...args);
  }
  const left = target - (Date.now() - t0) / 1000;
  if (left > 0) await sleep(left * 1000);
  else console.warn(`line ${ln.id}: actions overran narration by ${(-left).toFixed(2)} s`);
}
await sleep((story.tail ?? 0.4) * 1000);
const end = (Date.now() - t0) / 1000;
const vpath = await page.video().path();
await ctx.close(); await browser.close();
renameSync(vpath, join(build, "footage.webm"));
writeFileSync(join(build, "timeline.json"), JSON.stringify({ lines: timeline, end }, null, 1));
console.log(`footage ${end.toFixed(1)} s, ${timeline.length} lines`);
