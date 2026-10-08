// A receipt ties one search result to the exact SerpApi search that produced it:
// engine + params (never the api_key) + search_metadata.id + processed_at + where the item sits in the JSON
// (a JSON Pointer) + a SHA-256 of the item itself + the handful of fields an agent is likely to quote.
// Anyone holding the same SerpApi account can later re-fetch that search from SerpApi's Search Archive API
// and check the receipt (see verify.ts). Receipts are tamper-evident, not signed: they prove a value matches
// SerpApi's archived JSON, which is the point; they do not prove who created the receipt.
import { canonicalJson, getPath, sha256 } from "./hash.js";

export type Source = "LIVE" | "CACHED" | "RECORDED";

export interface EngineSpec {
  /** Where the result list lives in the SerpApi JSON. */
  lists: string[];
  /** Fields copied into the receipt's `cited` block (dot paths inside the item). */
  cite: string[];
  /** Extra params this tool lets the agent pass, besides q. */
  params: string[];
}

export const ENGINES: Record<string, EngineSpec> = {
  google: {
    lists: ["answer_box", "organic_results"],
    cite: ["title", "link", "snippet", "answer", "date"],
    params: ["location", "gl", "hl", "num"],
  },
  google_news: {
    lists: ["news_results"],
    cite: ["title", "link", "source.name", "date", "snippet"],
    params: ["gl", "hl"],
  },
  google_scholar: {
    lists: ["organic_results"],
    cite: ["title", "link", "publication_info.summary", "inline_links.cited_by.total", "snippet"],
    params: ["as_ylo", "as_yhi", "hl", "num"],
  },
  google_shopping: {
    lists: ["shopping_results"],
    cite: ["title", "price", "extracted_price", "source", "product_link", "link"],
    params: ["location", "gl", "hl"],
  },
};
export const ENGINE_NAMES = Object.keys(ENGINES) as [string, ...string[]];

export interface Receipt {
  v: 1;
  receipt_id: string;
  engine: string;
  params: Record<string, string>;
  search_id: string;
  processed_at: string | null;
  retrieved_at: string;
  source: Source;
  /** The page SerpApi fetched (search_metadata.google_url or similar). */
  search_url: string | null;
  /** Search Archive API location of the full JSON (needs an api_key from the same account to open). */
  archive_url: string;
  /** search_metadata.json_endpoint: a per-search link to the same archived JSON that opens without an api_key
   * (observed 9 Oct 2026), so anyone holding the receipt can verify it. null if SerpApi did not return one. */
  json_endpoint: string | null;
  /** RFC 6901 pointer to the item inside the search JSON. */
  pointer: string;
  item_sha256: string;
  result_url: string | null;
  cited: Record<string, string | number | boolean | null>;
}

const SECRET_PARAMS = new Set(["api_key", "apikey", "key", "token"]);

export function cleanParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) {
    if (SECRET_PARAMS.has(k.toLowerCase()) || params[k] === undefined || params[k] === null || params[k] === "") continue;
    out[k] = String(params[k]);
  }
  return out;
}

export const itemHash = (item: unknown) => sha256(canonicalJson(item));

/** The id commits to everything that matters in the receipt, so editing any of it changes the id. */
export function receiptId(r: Omit<Receipt, "receipt_id" | "retrieved_at" | "source">): string {
  const core = { v: r.v, engine: r.engine, params: r.params, search_id: r.search_id, processed_at: r.processed_at, json_endpoint: r.json_endpoint, pointer: r.pointer, item_sha256: r.item_sha256, cited: r.cited };
  return "sr_" + sha256(canonicalJson(core)).slice(0, 20);
}

function citedFields(item: unknown, paths: string[]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const p of paths) {
    const v = getPath(item, p);
    if (v === undefined) continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[p] = v as string | number | boolean | null;
  }
  return out;
}

/** Accepts only https://serpapi.com/searches/<token>/<search_id>.json for this exact search id. */
export function publicEndpoint(url: unknown, searchId: string): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const ok = u.protocol === "https:" && u.host === "serpapi.com" && !u.search && !u.hash && /^\/searches\/[A-Za-z0-9_-]{16,128}\/[A-Za-z0-9_-]{6,64}\.json$/.test(u.pathname) && u.pathname.endsWith(`/${searchId}.json`);
    return ok ? u.toString() : null;
  } catch { return null; }
}

export interface Located { pointer: string; item: any }

/** Every citable item in a SerpApi response for this engine, with its JSON Pointer. */
export function locateItems(raw: any, engine: string): Located[] {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`Unsupported engine "${engine}". Supported: ${ENGINE_NAMES.join(", ")}`);
  const out: Located[] = [];
  for (const list of spec.lists) {
    const v = raw?.[list];
    if (Array.isArray(v)) v.forEach((item, i) => out.push({ pointer: `/${list}/${i}`, item }));
    else if (v && typeof v === "object") out.push({ pointer: `/${list}`, item: v });
  }
  return out;
}

export function buildReceipts(raw: any, params: Record<string, unknown>, opts: { source: Source; retrievedAt?: string; limit?: number }): Receipt[] {
  const meta = raw?.search_metadata ?? {};
  if (!meta.id) throw new Error("SerpApi response has no search_metadata.id; cannot issue receipts.");
  const clean = cleanParams(params);
  const engine = clean.engine;
  const items = locateItems(raw, engine).slice(0, opts.limit ?? 10);
  return items.map(({ pointer, item }) => {
    const base = {
      v: 1 as const,
      engine,
      params: clean,
      search_id: String(meta.id),
      processed_at: meta.processed_at ?? null,
      search_url: meta.google_url ?? meta.google_scholar_url ?? meta.google_news_url ?? meta.google_shopping_url ?? null,
      archive_url: `https://serpapi.com/searches/${meta.id}.json`,
      json_endpoint: publicEndpoint(meta.json_endpoint, String(meta.id)),
      pointer,
      item_sha256: itemHash(item),
      result_url: item?.link ?? item?.product_link ?? null,
      cited: citedFields(item, ENGINES[engine].cite),
    };
    return { ...base, receipt_id: receiptId(base), retrieved_at: opts.retrievedAt ?? new Date().toISOString(), source: opts.source };
  });
}
