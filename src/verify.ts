// Checks a receipt against the search JSON re-fetched from SerpApi's Search Archive API.
// Pure function: the caller supplies the archived JSON, so this is easy to test and to run offline.
import { getPath, getPointer } from "./hash.js";
import { itemHash, receiptId, type Receipt } from "./receipt.js";

export type Verdict = "VERIFIED" | "MISMATCH" | "NOT_IN_ARCHIVE";

export interface Claim {
  /** Dot path inside the cited item, e.g. "extracted_price" or "inline_links.cited_by.total". Omit to search the whole item. */
  field?: string;
  /** The value the agent is asserting. */
  value: string | number | boolean;
}

export interface Check { name: string; ok: boolean; detail: string }

export interface VerifyResult {
  verdict: Verdict;
  receipt_id: string;
  search_id: string;
  pointer: string;
  checks: Check[];
  /** The archived values of the cited fields (what SerpApi actually returned). */
  archived?: Record<string, unknown>;
}

const norm = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v);

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") {
    const na = typeof a === "number" ? a : Number(String(a).replace(/[,\s]/g, ""));
    const nb = typeof b === "number" ? b : Number(String(b).replace(/[,\s]/g, ""));
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
  }
  return norm(a) === norm(b);
}

function leaves(v: unknown, out: unknown[] = []): unknown[] {
  if (v && typeof v === "object") for (const x of Object.values(v)) leaves(x, out);
  else out.push(v);
  return out;
}

const NUMERIC = /^[-+]?[\d,]*\.?\d+$/;
const toNum = (v: string) => Number(v.replace(/,/g, ""));
/** Whole numbers inside a text ("cited by 2,510 times" -> [2510]), so "200" never matches inside "2000". */
const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((t) => toNum(t.replace(/,$/, "")));

function claimHolds(item: unknown, c: Claim): { ok: boolean; detail: string } {
  if (c.field) {
    const got = getPath(item, c.field);
    if (got === undefined) return { ok: false, detail: `field "${c.field}" does not exist in the archived item` };
    return sameValue(got, c.value)
      ? { ok: true, detail: `${c.field} = ${JSON.stringify(got)} in the archive` }
      : { ok: false, detail: `claimed ${c.field} = ${JSON.stringify(c.value)}, archive says ${JSON.stringify(got)}` };
  }
  const want = norm(c.value);
  const numeric = typeof c.value === "number" || (typeof want === "string" && NUMERIC.test(want));
  const hit = leaves(item).find((l) => {
    if (numeric) {
      const n = typeof c.value === "number" ? c.value : toNum(want as string);
      return typeof l === "number" ? l === n : typeof l === "string" && numbersIn(l).includes(n);
    }
    return sameValue(l, c.value) || (typeof l === "string" && typeof want === "string" && want.length >= 3 && norm(l)!.toString().includes(want));
  });
  const how = numeric ? "as a whole number " : "";
  return hit !== undefined
    ? { ok: true, detail: `${JSON.stringify(c.value)} appears ${how}in the archived item` }
    : { ok: false, detail: `${JSON.stringify(c.value)} does not appear ${how}anywhere in the archived item` };
}

/** SerpApi echoes most params unchanged in search_parameters; `location` comes back as `location_requested`. */
function archivedParam(sp: Record<string, unknown>, k: string): unknown {
  return sp[k] ?? (k === "location" ? sp.location_requested : undefined);
}

export interface VerifyOptions {
  /** Where the archived JSON came from; only used to word the NOT_IN_ARCHIVE message. */
  archiveSource?: "ARCHIVE_LIVE" | "ARCHIVE_RECORDED";
}

export function verifyReceipt(receipt: Receipt, archived: any, claims: Claim[] = [], opts: VerifyOptions = {}): VerifyResult {
  const checks: Check[] = [];
  const res = (verdict: Verdict, archivedVals?: Record<string, unknown>): VerifyResult => ({ verdict, receipt_id: receipt.receipt_id, search_id: receipt.search_id, pointer: receipt.pointer, checks, archived: archivedVals });

  const { receipt_id, retrieved_at, source, ...core } = receipt;
  const idOk = receiptId(core) === receipt_id;
  checks.push({ name: "receipt_integrity", ok: idOk, detail: idOk ? "receipt_id matches the receipt contents" : "receipt contents were edited after it was issued (receipt_id no longer matches)" });

  const meta = archived?.search_metadata ?? {};
  if (!archived || meta.id !== receipt.search_id) {
    checks.push({ name: "archive_found", ok: false, detail: opts.archiveSource === "ARCHIVE_RECORDED"
      ? `no recorded archive copy of search ${receipt.search_id}, and the live SerpApi archive was not reachable (offline, or SERP_RECEIPTS_OFFLINE=1)`
      : `SerpApi's archive did not return search ${receipt.search_id} (searches are kept 31 days; without a json_endpoint only the account that ran it can fetch it)` });
    return res("NOT_IN_ARCHIVE");
  }
  checks.push({ name: "archive_found", ok: true, detail: `search ${meta.id}, status ${meta.status ?? "?"}, processed ${meta.processed_at ?? "?"}` });

  const sp = archived.search_parameters ?? {};
  const diff = Object.entries(receipt.params).filter(([k, v]) => String(archivedParam(sp, k) ?? "") !== String(v));
  const paramsOk = sp.engine === receipt.engine && diff.length === 0;
  checks.push({ name: "same_search", ok: paramsOk, detail: paramsOk
    ? `all ${Object.keys(receipt.params).length} params match the archive (engine ${sp.engine}, q "${sp.q}")`
    : sp.engine !== receipt.engine ? `archive engine is ${sp.engine}, receipt says ${receipt.engine}`
    : diff.map(([k, v]) => `${k}: receipt says ${JSON.stringify(v)}, archive says ${JSON.stringify(archivedParam(sp, k) ?? null)}`).join("; ") });
  // URLs are not part of receipt_id, so they are checked against the archive instead of trusted.
  const archSearchUrl = meta.google_url ?? meta.google_scholar_url ?? meta.google_news_url ?? meta.google_shopping_url ?? null;
  const urlChecks: [string, unknown, unknown][] = [
    ["search_url", receipt.search_url ?? null, archSearchUrl],
    ["archive_url", receipt.archive_url, `https://serpapi.com/searches/${receipt.search_id}.json`],
  ];
  if (receipt.processed_at && meta.processed_at && meta.processed_at !== receipt.processed_at)
    checks.push({ name: "same_time", ok: false, detail: `archive processed_at ${meta.processed_at}, receipt says ${receipt.processed_at}` });

  const item = getPointer(archived, receipt.pointer);
  if (item === undefined) {
    checks.push({ name: "item_found", ok: false, detail: `nothing at ${receipt.pointer} in the archived JSON` });
    return res("MISMATCH");
  }
  const it = item as Record<string, unknown> | null;
  urlChecks.push(["result_url", receipt.result_url ?? null, (it && typeof it === "object" ? it.link ?? it.product_link : undefined) ?? null]);
  const badUrls = urlChecks.filter(([, a, b]) => a !== b);
  checks.push({ name: "urls", ok: badUrls.length === 0, detail: badUrls.length === 0
    ? "search_url, archive_url and result_url match the archive"
    : badUrls.map(([k, a, b]) => `${k}: receipt says ${JSON.stringify(a)}, archive says ${JSON.stringify(b)}`).join("; ") });
  const h = itemHash(item);
  checks.push({ name: "item_hash", ok: h === receipt.item_sha256, detail: h === receipt.item_sha256 ? `sha256 of ${receipt.pointer} matches` : `sha256 of archived ${receipt.pointer} is ${h.slice(0, 12)}…, receipt says ${receipt.item_sha256.slice(0, 12)}…` });

  const archivedVals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt.cited)) {
    const got = getPath(item, k);
    archivedVals[k] = got;
    const ok = sameValue(got, v);
    checks.push({ name: `cited.${k}`, ok, detail: ok ? `matches archive` : `receipt says ${JSON.stringify(v)}, archive says ${JSON.stringify(got)}` });
  }
  for (const c of claims) {
    const r = claimHolds(item, c);
    checks.push({ name: `claim${c.field ? "." + c.field : ""}`, ...r });
  }
  return res(checks.every((c) => c.ok) ? "VERIFIED" : "MISMATCH", archivedVals);
}
