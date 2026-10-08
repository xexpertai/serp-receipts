import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { paramsKey, SerpClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { scholarRaw } from "./synthetic.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serp-receipts-mcp-"));
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(r.isError), text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
};

beforeAll(async () => {
  const rec = tmp();
  const q = { engine: "google_scholar", q: "synthetic monsoon paper" };
  mkdirSync(join(rec, "search")); mkdirSync(join(rec, "archive"));
  writeFileSync(join(rec, "search", `${paramsKey(q)}.json`), JSON.stringify({ fetchedAt: "2026-10-09T10:00:01Z", params: q, raw: scholarRaw() }));
  writeFileSync(join(rec, "archive", "synthetic0000000000000001.json"), JSON.stringify({ raw: scholarRaw() }));
  const server = createServer(new SerpClient({ mode: "recorded", dataDir: tmp(), recordedDir: rec }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

describe("MCP server", () => {
  it("lists exactly the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["credits", "get_receipt", "search", "verify_receipt"]);
  });
  it("search -> get_receipt -> verify_receipt (true claim VERIFIED, tampered receipt MISMATCH)", async () => {
    const s = (await call("search", { engine: "google_scholar", q: "synthetic monsoon paper", limit: 2 })).json();
    expect(s.source).toBe("RECORDED");
    expect(s.results).toHaveLength(2);
    const id = s.results[0].receipt_id;
    const receipt = (await call("get_receipt", { receipt_id: id })).json();
    expect(receipt.search_id).toBe("synthetic0000000000000001");

    const ok = (await call("verify_receipt", { receipt_id: id, claims: [{ field: "inline_links.cited_by.total", value: 412 }] })).json();
    expect(ok.verdict).toBe("VERIFIED");
    expect(ok.archive_source).toBe("ARCHIVE_RECORDED");

    const tampered = { ...receipt, cited: { ...receipt.cited, "inline_links.cited_by.total": 4120 } };
    const bad = (await call("verify_receipt", { receipt: JSON.stringify(tampered) })).json();
    expect(bad.verdict).toBe("MISMATCH");
    expect(bad.summary).toMatch(/archive says 412/);
  });
  it("returns tool errors instead of crashing", async () => {
    expect((await call("search", { engine: "google_scholar", q: "never recorded" })).isError).toBe(true);
    expect((await call("get_receipt", { receipt_id: "sr_00000000000000000000" })).isError).toBe(true);
    expect((await call("verify_receipt", { receipt: "{\"receipt_id\":\"x\"}" })).text).toMatch(/missing/);
  });
  it("credits reports recorded mode and zero spend", async () => {
    const c = (await call("credits")).json();
    expect(c).toMatchObject({ mode: "recorded", local_credits_used: 0 });
  });
});
