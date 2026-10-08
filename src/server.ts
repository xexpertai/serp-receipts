// MCP server: exposes search, get_receipt, verify_receipt and credits over the Model Context Protocol.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SerpClient } from "./client.js";
import { ENGINE_NAMES } from "./receipt.js";
import { createContext, creditsTool, getReceiptTool, searchTool, verifyReceiptTool } from "./tools.js";

export const VERSION = "0.1.0";

export function createServer(client: SerpClient): McpServer {
  const ctx = createContext(client);
  const server = new McpServer({ name: "serp-receipts", version: VERSION });
  const reply = (v: unknown) => ({ content: [{ type: "text" as const, text: client.redact(JSON.stringify(v, null, 2)) }] });
  const guard = <A,>(fn: (a: A) => Promise<unknown> | unknown) => async (a: A) => {
    try { return reply(await fn(a)); } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: client.redact(`Error: ${(e as Error).message}`) }] };
    }
  };

  server.registerTool("search", {
    title: "Search with receipts",
    description:
      "Search via SerpApi. Engines: google (web), google_news, google_scholar, google_shopping. Every result comes with a receipt_id " +
      "that pins it to the exact SerpApi search (search_metadata.id, processed_at, params, JSON pointer, SHA-256). " +
      "When you state a fact from a result, cite its receipt_id. Costs 1 SerpApi credit unless cached or in recorded mode.",
    inputSchema: {
      engine: z.enum(ENGINE_NAMES).describe("SerpApi engine"),
      q: z.string().min(1).max(500).describe("Search query"),
      limit: z.number().int().min(1).max(20).optional().describe("How many results to return with receipts (default 5)"),
      location: z.string().max(200).optional().describe("google / google_shopping: e.g. 'Mumbai, Maharashtra, India'"),
      gl: z.string().max(5).optional().describe("Country code, e.g. 'in'"),
      hl: z.string().max(10).optional().describe("Language code, e.g. 'en'"),
      as_ylo: z.number().int().optional().describe("google_scholar: earliest year"),
      as_yhi: z.number().int().optional().describe("google_scholar: latest year"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard((a) => searchTool(ctx, a)));

  server.registerTool("get_receipt", {
    title: "Get a receipt",
    description: "Returns the full receipt for a receipt_id issued by `search`: engine, params (no api_key), search_id, processed_at, search and archive URLs, JSON pointer, item SHA-256 and the cited fields.",
    inputSchema: { receipt_id: z.string().regex(/^sr_[0-9a-f]{20}$/).describe("e.g. sr_1a2b3c…") },
    annotations: { readOnlyHint: true },
  }, guard((a) => getReceiptTool(ctx, a)));

  server.registerTool("verify_receipt", {
    title: "Verify a receipt",
    description:
      "Re-fetches the original search from SerpApi's Search Archive API (by search_id; searches are kept 31 days) and checks that the " +
      "receipt is intact, the item at its JSON pointer still hashes the same, every cited field matches, and each optional claim " +
      "(field + value, or just a value to find anywhere in the item) is really in SerpApi's JSON. Verdict: VERIFIED, MISMATCH or NOT_IN_ARCHIVE.",
    inputSchema: {
      receipt_id: z.string().optional().describe("A receipt_id issued on this machine"),
      receipt: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Or the full receipt JSON (e.g. one passed to you by another agent)"),
      claims: z.array(z.object({
        field: z.string().optional().describe("Dot path in the item, e.g. 'extracted_price' or 'inline_links.cited_by.total'"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("The value being asserted"),
      })).max(10).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard((a) => verifyReceiptTool(ctx, a)));

  server.registerTool("credits", {
    title: "Credits and ledger",
    description: "Local credit cap, credits used by this machine, archive fetches, and (live mode) the SerpApi account's remaining searches from the free Account API.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, guard(() => creditsTool(ctx)));

  return server;
}
