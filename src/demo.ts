// `serp-receipts demo`: the two-agent story in one command, over the real MCP protocol (in-process transport).
//   Agent A    recorded mode: replays a real SerpApi search recorded 9 Oct 2026 IST (0 credits, no key).
//   Verifier B no API key: verifies Agent A's receipt against SerpApi's LIVE archive via the keyless json_endpoint
//              (falls back to the bundled archive copy only if offline or SERP_RECEIPTS_OFFLINE=1, and says so).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SerpClient } from "./client.js";
import { createServer } from "./server.js";

async function connect(name: string, client: SerpClient): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(client).connect(a);
  const c = new Client({ name, version: "0" });
  await c.connect(b);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

export async function runDemo(opts: { offline?: boolean; log?: (s: string) => void } = {}): Promise<{ verified: string; tampered: string }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const dir = () => mkdtempSync(join(tmpdir(), "serp-receipts-demo-"));
  const a = await connect("agent-a", new SerpClient({ mode: "recorded", dataDir: dir(), offline: true }));
  const b = await connect("verifier-b", new SerpClient({ mode: "recorded", dataDir: dir(), offline: opts.offline }));

  log("Agent A  (RECORDED replay of a real SerpApi search, 0 credits)");
  const s = await call(a, "search", { engine: "google_scholar", q: "Indian summer monsoon rainfall prediction", limit: 3 });
  for (const x of s.results) log(`  ${x.receipt_id}  cited by ${String(x["inline_links.cited_by.total"]).padStart(4)}  ${x.title}`);
  const top = s.results[0];
  const n = top["inline_links.cited_by.total"];
  log(`  says: "The top paper is cited by ${n} [${top.receipt_id}]."`);
  const receipt = await call(a, "get_receipt", { receipt_id: top.receipt_id });

  log(`\nVerifier B  (no SerpApi key)  verify_receipt + claim cited_by = ${n}`);
  const v1 = await call(b, "verify_receipt", { receipt, claims: [{ field: "inline_links.cited_by.total", value: n }] });
  log(`  ${v1.verdict}  (archive: ${v1.archive_source} via ${v1.archive_via})${v1.archive_note ? `\n  note: ${v1.archive_note}` : ""}`);
  for (const c of v1.checks) log(`    ${c.ok ? "ok " : "BAD"} ${c.name}`);

  log(`\nSomeone edits the receipt: cited_by ${n} -> ${n * 10}`);
  const v2 = await call(b, "verify_receipt", { receipt: { ...receipt, cited: { ...receipt.cited, "inline_links.cited_by.total": n * 10 } } });
  log(`  ${v2.verdict}  (archive: ${v2.archive_source} via ${v2.archive_via})`);
  for (const c of v2.checks.filter((c: { ok: boolean }) => !c.ok)) log(`    BAD ${c.name}: ${c.detail}`);
  await a.close(); await b.close();
  return { verified: v1.verdict, tampered: v2.verdict };
}
