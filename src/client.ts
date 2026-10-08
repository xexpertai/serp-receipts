// SerpApi access with a hard local credit cap, a ledger, a cache, and a recorded (offline) mode.
//   LIVE      fetched from serpapi.com just now (1 search credit)
//   CACHED    a LIVE response saved earlier on this machine, reused within cacheTtlHours (0 credits)
//   RECORDED  a real response saved in a fixtures folder and replayed (0 credits, no network; tests and demos)
// The API key is read from the environment only. It is sent to serpapi.com and nowhere else, never written to
// disk, never put in a receipt, and scrubbed from any text this package returns or logs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "./hash.js";
import { cleanParams, publicEndpoint, type Source } from "./receipt.js";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Mode = "live" | "recorded";
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface ClientOptions {
  apiKey?: string;
  mode?: Mode;
  /** Ledger, cache and receipt store. Default: $SERP_RECEIPTS_DATA_DIR or ~/.serp-receipts */
  dataDir?: string;
  /** Recorded responses: <dir>/search/*.json and <dir>/archive/*.json. Default: the package's fixtures/ */
  recordedDir?: string;
  /** Hard cap on live search credits counted by this machine's ledger. */
  creditCap?: number;
  cacheTtlHours?: number;
  /** Count Search Archive fetches against the cap too (off by default; see README "Costs"). */
  archiveCountsAsCredit?: boolean;
  /** Never touch the network. In recorded mode this also makes verify_receipt use the recorded archive copies. */
  offline?: boolean;
  fetch?: FetchLike;
}

export interface Fetched { raw: any; source: Source; key: string; fetchedAt: string; params: Record<string, string> }

export interface LedgerEntry { at: string; kind: "search" | "archive"; engine?: string; search_id: string; credit: number }
export interface Ledger { credits: number; archive_fetches: number; calls: LedgerEntry[] }

export class CreditCapError extends Error {}
export class NotRecordedError extends Error {}

/** Loads KEY=VALUE lines from a .env.local next to the package (development checkouts only; never overrides real env). */
export function loadEnvLocal(dir = PACKAGE_ROOT): void {
  const p = join(dir, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function optionsFromEnv(env = process.env): ClientOptions {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    apiKey: env.SERPAPI_API_KEY || undefined,
    mode: env.SERP_RECEIPTS_MODE === "recorded" ? "recorded" : env.SERP_RECEIPTS_MODE === "live" ? "live" : undefined,
    dataDir: env.SERP_RECEIPTS_DATA_DIR || undefined,
    recordedDir: env.SERP_RECEIPTS_RECORDED_DIR || undefined,
    creditCap: num(env.SERP_RECEIPTS_CREDIT_CAP, 50),
    cacheTtlHours: num(env.SERP_RECEIPTS_CACHE_TTL_HOURS, 24),
    archiveCountsAsCredit: env.SERP_RECEIPTS_ARCHIVE_COUNTS === "1",
    offline: env.SERP_RECEIPTS_OFFLINE === "1",
  };
}

/** Same params, same key (order-free, api_key never included). */
export const paramsKey = (params: Record<string, unknown>) => sha256(canonicalJson(cleanParams(params))).slice(0, 20);

export class SerpClient {
  readonly mode: Mode;
  readonly creditCap: number;
  readonly dataDir: string;
  readonly recordedDir: string;
  private readonly apiKey?: string;
  private readonly ttlMs: number;
  private readonly archiveCredit: boolean;
  readonly offline: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(o: ClientOptions = {}) {
    this.apiKey = o.apiKey;
    this.mode = o.mode ?? (o.apiKey ? "live" : "recorded");
    this.creditCap = o.creditCap ?? 50;
    this.dataDir = o.dataDir ?? join(homedir(), ".serp-receipts");
    this.recordedDir = o.recordedDir ?? join(PACKAGE_ROOT, "fixtures");
    this.ttlMs = (o.cacheTtlHours ?? 24) * 3600e3;
    this.archiveCredit = o.archiveCountsAsCredit ?? false;
    this.offline = o.offline ?? false;
    this.fetchImpl = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** Removes the API key from any text or JSON before it leaves this module. */
  redact<T>(v: T): T {
    if (!this.apiKey) return v;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (!s.includes(this.apiKey)) return v;
    const clean = s.split(this.apiKey).join("[redacted]");
    return (typeof v === "string" ? clean : JSON.parse(clean)) as T;
  }

  private get ledgerPath() { return join(this.dataDir, "ledger.json"); }
  readLedger(): Ledger {
    try { return { credits: 0, archive_fetches: 0, calls: [], ...JSON.parse(readFileSync(this.ledgerPath, "utf8")) }; } catch { return { credits: 0, archive_fetches: 0, calls: [] }; }
  }
  private writeJson(p: string, v: unknown) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 1), { mode: 0o600 }); }

  private readRecordedFile(sub: "search" | "archive", name: string): any | null {
    const p = join(this.recordedDir, sub, `${name}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }
  /** Recorded searches, for listing in demos. */
  recordedSearches(): { params: Record<string, string>; search_id: string }[] {
    const dir = join(this.recordedDir, "search");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return { params: j.params, search_id: j.raw?.search_metadata?.id };
    });
  }

  /** Recorded search with the same engine and query (case/space-insensitive). Optional params may be omitted,
   * but any param that IS given must equal the recorded one. The returned params are the recorded ones. */
  private findRecorded(want: Record<string, string>): { raw: any; fetchedAt: string; params: Record<string, string> } | null {
    const nq = (q: string | undefined) => (q ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const dir = join(this.recordedDir, "search");
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const p: Record<string, string> = j.params ?? {};
      if (p.engine !== want.engine || nq(p.q) !== nq(want.q)) continue;
      if (Object.entries(want).every(([k, v]) => k === "q" || p[k] === v)) return { raw: j.raw, fetchedAt: j.fetchedAt, params: p };
    }
    return null;
  }

  private spend(kind: "search" | "archive"): Ledger {
    const ledger = this.readLedger();
    const cost = kind === "search" || this.archiveCredit ? 1 : 0;
    if (ledger.credits + cost > this.creditCap)
      throw new CreditCapError(`Local credit cap reached: ${ledger.credits} of ${this.creditCap} SerpApi credits used on this machine. Raise SERP_RECEIPTS_CREDIT_CAP to continue.`);
    return ledger;
  }
  private record(ledger: Ledger, e: Omit<LedgerEntry, "at" | "credit">) {
    const credit = e.kind === "search" || this.archiveCredit ? 1 : 0;
    ledger.credits += credit;
    if (e.kind === "archive") ledger.archive_fetches += 1;
    ledger.calls.push({ at: new Date().toISOString(), credit, ...e });
    this.writeJson(this.ledgerPath, ledger);
  }

  private async getJson(url: URL): Promise<{ ok: boolean; status: number; body: any }> {
    try {
      const res = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(30000) });
      const body = this.redact(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      throw new Error(this.redact(`SerpApi request failed: ${(e as Error).message}`));
    }
  }

  async search(params: Record<string, unknown>): Promise<Fetched> {
    const clean = cleanParams(params);
    const key = paramsKey(clean);
    if (this.mode === "recorded") {
      const r = this.readRecordedFile("search", key) ?? this.findRecorded(clean);
      if (!r) throw new NotRecordedError(`Recorded mode (no SERPAPI_API_KEY): this search is not one of the bundled recordings. Recorded searches (engine + q; other params optional): ${this.recordedSearches().map((s) => `${s.params.engine} "${s.params.q}"`).join("; ") || "none"}. Set SERPAPI_API_KEY to search live.`);
      return { raw: r.raw, source: "RECORDED", key: paramsKey(r.params), fetchedAt: r.fetchedAt, params: r.params };
    }
    const cp = join(this.dataDir, "cache", `${key}.json`);
    if (existsSync(cp)) {
      const c = JSON.parse(readFileSync(cp, "utf8"));
      if (Date.now() - Date.parse(c.fetchedAt) < this.ttlMs) return { raw: c.raw, source: "CACHED", key, fetchedAt: c.fetchedAt, params: clean };
    }
    if (!this.apiKey) throw new Error("Searching needs SERPAPI_API_KEY in the environment. Without a key this server can only verify receipts (or set SERP_RECEIPTS_MODE=recorded for the offline demo).");
    const ledger = this.spend("search");
    const url = new URL("https://serpapi.com/search.json");
    for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", this.apiKey!);
    const { ok, status, body } = await this.getJson(url);
    // Count the attempt even if it failed: a failed search may still be billed.
    this.record(ledger, { kind: "search", engine: clean.engine, search_id: body?.search_metadata?.id ?? "-" });
    if (!ok || body?.error) throw new Error(`SerpApi ${clean.engine}: ${body?.error ?? `HTTP ${status}`}`);
    const fetchedAt = new Date().toISOString();
    this.writeJson(cp, { fetchedAt, params: clean, raw: body });
    return { raw: body, source: "LIVE", key, fetchedAt, params: clean };
  }

  /** Re-fetches a past search from SerpApi's archive.
   * - With a keyless json_endpoint (in any mode, unless offline): GET that URL, no api_key sent.
   * - Otherwise in live mode: GET /searches/{id}.json with this machine's key (Search Archive API; kept 31 days).
   * - Recorded mode falls back to the bundled archive copy when offline or when the live fetch fails; the result
   *   says so (source ARCHIVE_RECORDED, note). */
  async archive(searchId: string, jsonEndpoint?: string | null): Promise<{ raw: any | null; source: "ARCHIVE_LIVE" | "ARCHIVE_RECORDED"; via: "json_endpoint" | "api_key" | "recorded"; status: number; note?: string }> {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(searchId)) throw new Error("search_id has an unexpected format");
    const recorded = (note: string) => {
      const r = this.readRecordedFile("archive", searchId);
      return { raw: r?.raw ?? null, source: "ARCHIVE_RECORDED" as const, via: "recorded" as const, status: r ? 200 : 404, note };
    };
    const pub = publicEndpoint(jsonEndpoint, searchId);
    if (this.offline) return recorded("offline: used the bundled recorded archive copy, not SerpApi");
    if (this.mode === "recorded" && !pub) return recorded("recorded mode and no keyless json_endpoint: used the bundled recorded archive copy");
    if (!pub && !this.apiKey) throw new Error("This receipt has no keyless json_endpoint, so verifying it needs SERPAPI_API_KEY from the account that ran the search.");
    const ledger = this.spend("archive");
    const url = new URL(pub ?? `https://serpapi.com/searches/${encodeURIComponent(searchId)}.json`);
    if (!pub) url.searchParams.set("api_key", this.apiKey!);
    const via = pub ? "json_endpoint" : "api_key";
    let res: { ok: boolean; status: number; body: any };
    try { res = await this.getJson(url); } catch (e) {
      if (this.mode === "recorded") return recorded(`live archive unreachable (${(e as Error).message}); used the bundled recorded archive copy`);
      throw e;
    }
    this.record(ledger, { kind: "archive", search_id: searchId });
    if (!res.ok || res.body?.error) {
      if (this.mode === "recorded" && this.readRecordedFile("archive", searchId)) return recorded(`live archive returned HTTP ${res.status}; used the bundled recorded archive copy`);
      return { raw: null, source: "ARCHIVE_LIVE", via, status: res.status };
    }
    return { raw: res.body, source: "ARCHIVE_LIVE", via, status: res.status };
  }

  /** SerpApi Account API (free, not counted toward the monthly quota per SerpApi docs). */
  async account(): Promise<{ plan_searches_left?: number; this_month_usage?: number; searches_per_month?: number } | null> {
    if (this.mode !== "live" || !this.apiKey) return null;
    const url = new URL("https://serpapi.com/account.json");
    url.searchParams.set("api_key", this.apiKey!);
    try {
      const { ok, body } = await this.getJson(url);
      if (!ok) return null;
      return { plan_searches_left: body.plan_searches_left ?? body.total_searches_left, this_month_usage: body.this_month_usage, searches_per_month: body.searches_per_month };
    } catch { return null; }
  }
}
