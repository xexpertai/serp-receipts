// Records real SerpApi responses into fixtures/ for recorded mode (tests, demo, video), and measures whether a
// Search Archive fetch uses a search credit by reading the free Account API before and after.
// Spends 1 credit per new search (hard-capped by SERP_RECEIPTS_CREDIT_CAP via the ledger). Never prints the key.
// Usage: npx tsx scripts/record.ts            (records the list below; skips searches already recorded)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal, optionsFromEnv, paramsKey, PACKAGE_ROOT, SerpClient } from "../src/client.js";
import { cleanParams } from "../src/receipt.js";

loadEnvLocal();
const c = new SerpClient({ ...optionsFromEnv(), mode: "live" });
const FIX = join(PACKAGE_ROOT, "fixtures");
mkdirSync(join(FIX, "search"), { recursive: true }); mkdirSync(join(FIX, "archive"), { recursive: true });

export const SEARCHES: Record<string, string | number>[] = [
  { engine: "google_scholar", q: "Indian summer monsoon rainfall prediction" },
  { engine: "google", q: "India UPI transactions September 2026", gl: "in", hl: "en" },
  { engine: "google_news", q: "ISRO launch", gl: "in", hl: "en" },
  { engine: "google_shopping", q: "stainless steel pressure cooker 5 litre", location: "Mumbai, Maharashtra, India", gl: "in", hl: "en" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = async () => (await c.account())?.this_month_usage;

for (const p of SEARCHES) {
  const clean = cleanParams(p);
  const sp = join(FIX, "search", `${paramsKey(clean)}.json`);
  if (existsSync(sp)) { console.log("already recorded:", clean.engine, clean.q); continue; }
  const u0 = await usage();
  const f = await c.search(clean);
  const id = f.raw.search_metadata.id;
  writeFileSync(sp, JSON.stringify({ fetchedAt: f.fetchedAt, params: clean, raw: f.raw }, null, 1));
  await sleep(4000);
  const u1 = await usage();
  const a = await c.archive(id);
  if (!a.raw) throw new Error(`archive fetch failed for ${id} (HTTP ${a.status})`);
  writeFileSync(join(FIX, "archive", `${id}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), raw: a.raw }, null, 1));
  await sleep(4000);
  const u2 = await usage();
  console.log(`${clean.engine} "${clean.q}" -> ${id} (${f.source}); account usage: before search ${u0}, after search ${u1}, after archive fetch ${u2}`);
}
const l = c.readLedger();
console.log(`ledger: ${l.credits}/${c.creditCap} credits, ${l.archive_fetches} archive fetches`);
