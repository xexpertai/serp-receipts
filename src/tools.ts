// The four tools, as plain async functions (the MCP server in server.ts is a thin wrapper around these).
import { buildReceipts, ENGINES, type Receipt } from "./receipt.js";
import { SerpClient } from "./client.js";
import { ReceiptStore } from "./store.js";
import { verifyReceipt, type Claim, type VerifyResult } from "./verify.js";

export interface SearchInput { engine: string; q: string; limit?: number; [extra: string]: unknown }

export interface ToolContext { client: SerpClient; store: ReceiptStore }

export function createContext(client: SerpClient): ToolContext {
  return { client, store: new ReceiptStore(client.dataDir) };
}

export async function searchTool(ctx: ToolContext, input: SearchInput) {
  const spec = ENGINES[input.engine];
  if (!spec) throw new Error(`Unsupported engine "${input.engine}". Supported: ${Object.keys(ENGINES).join(", ")}`);
  if (!input.q?.trim()) throw new Error("q (the search query) is required");
  const params: Record<string, unknown> = { engine: input.engine, q: input.q.trim() };
  for (const p of spec.params) if (input[p] !== undefined) params[p] = input[p];
  const f = await ctx.client.search(params);
  const receipts = buildReceipts(f.raw, f.params, { source: f.source, retrievedAt: f.fetchedAt, limit: Math.min(Math.max(input.limit ?? 5, 1), 20) });
  ctx.store.put(receipts);
  const meta = f.raw.search_metadata;
  return {
    source: f.source,
    search: { engine: f.params.engine, params: f.params, search_id: meta.id, processed_at: meta.processed_at ?? null, archive_url: receipts[0]?.archive_url ?? `https://serpapi.com/searches/${meta.id}.json` },
    results: receipts.map((r) => ({ receipt_id: r.receipt_id, pointer: r.pointer, ...r.cited })),
    note: receipts.length
      ? "Cite a result by its receipt_id. get_receipt returns the full receipt; verify_receipt re-checks it against SerpApi's archive."
      : "SerpApi returned no citable results for this search.",
  };
}

export function getReceiptTool(ctx: ToolContext, input: { receipt_id: string }): Receipt {
  const r = ctx.store.get(input.receipt_id);
  if (!r) throw new Error(`Unknown receipt_id ${input.receipt_id} (receipts are stored locally in ${ctx.client.dataDir}).`);
  return r;
}

function parseReceipt(v: unknown): Receipt {
  const r = (typeof v === "string" ? JSON.parse(v) : v) as Receipt;
  for (const k of ["receipt_id", "engine", "search_id", "pointer", "item_sha256"] as const)
    if (typeof r?.[k] !== "string") throw new Error(`receipt is missing "${k}"`);
  if (!r.cited || typeof r.cited !== "object") throw new Error('receipt is missing "cited"');
  if (!r.params || typeof r.params !== "object") throw new Error('receipt is missing "params"');
  return r;
}

export async function verifyReceiptTool(ctx: ToolContext, input: { receipt_id?: string; receipt?: unknown; claims?: Claim[] }): Promise<VerifyResult & { archive_source: string; archive_via: string; archive_note?: string; summary: string }> {
  const r = input.receipt !== undefined ? parseReceipt(input.receipt) : input.receipt_id ? getReceiptTool(ctx, { receipt_id: input.receipt_id }) : null;
  if (!r) throw new Error("Pass receipt_id (issued on this machine) or receipt (the full receipt JSON).");
  const a = await ctx.client.archive(r.search_id, r.json_endpoint);
  const res = verifyReceipt(r, a.raw, input.claims ?? [], { archiveSource: a.source });
  const failed = res.checks.filter((c) => !c.ok);
  const summary = res.verdict === "VERIFIED"
    ? `VERIFIED: ${r.pointer} of SerpApi search ${r.search_id} matches the receipt${input.claims?.length ? " and every claim" : ""}.`
    : `${res.verdict}: ${failed.map((c) => c.detail).join("; ")}`;
  return { ...res, archive_source: a.source, archive_via: a.via, ...(a.note ? { archive_note: a.note } : {}), summary };
}

export async function creditsTool(ctx: ToolContext) {
  const l = ctx.client.readLedger();
  const account = await ctx.client.account();
  return {
    mode: ctx.client.mode,
    local_cap: ctx.client.creditCap,
    local_credits_used: l.credits,
    local_credits_left: Math.max(0, ctx.client.creditCap - l.credits),
    archive_fetches: l.archive_fetches,
    receipts_stored: ctx.store.size(),
    offline: ctx.client.offline,
    serpapi_account: account ?? (ctx.client.mode === "recorded" ? "recorded mode: searches replay bundled recordings; verify_receipt still checks SerpApi's live archive via keyless json_endpoint links unless offline" : "unavailable"),
    last_calls: l.calls.slice(-5),
  };
}

