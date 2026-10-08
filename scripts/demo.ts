// Scripted agent session over the real MCP protocol (stdio), used for the README walkthrough and the demo video.
//   Agent A    serp-receipts in RECORDED mode: replays a real SerpApi search recorded on 9 Oct 2026 (0 credits).
//   Verifier B serp-receipts with NO API key: verifies receipts live through SerpApi's keyless json_endpoint.
// Writes the transcript to video/build/transcript.json and prints a readable log.
// Usage: npx tsx scripts/demo.ts [--offline]   (--offline: Verifier B also uses the recorded archive copy)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PACKAGE_ROOT } from "../src/client.js";

const offline = process.argv.includes("--offline");
// No key for either agent; the default credit cap (50) so the demo shows what a fresh install shows.
const base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SERPAPI_API_KEY: "", SERP_RECEIPTS_CREDIT_CAP: "50" };

async function connect(name: string, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(PACKAGE_ROOT, "src/cli.ts")],
    cwd: PACKAGE_ROOT,
    env: { ...base, SERP_RECEIPTS_DATA_DIR: mkdtempSync(join(tmpdir(), `serp-receipts-${name}-`)), ...env },
    stderr: "ignore",
  });
  const c = new Client({ name, version: "0.1.0" });
  await c.connect(transport);
  return c;
}

const steps: { who: string; tool?: string; args?: unknown; result?: unknown; note?: string }[] = [];
async function call(who: string, c: Client, tool: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) throw new Error(`${tool}: ${r.content[0].text}`);
  const result = JSON.parse(r.content[0].text);
  steps.push({ who, tool, args, result });
  console.log(`\n[${who}] ${tool} ${JSON.stringify(args)}\n${JSON.stringify(result, null, 2).slice(0, 1500)}`);
  return result;
}

const a = await connect("agent-a", { SERP_RECEIPTS_MODE: "recorded" });
// Verifier B uses the default (no-key) setup: it checks SerpApi's live archive through the keyless json_endpoint.
const b = await connect("verifier-b", offline ? { SERP_RECEIPTS_OFFLINE: "1" } : {});

const tools = (await a.listTools()).tools.map((t) => t.name);
steps.push({ who: "Agent A", tool: "tools/list", result: tools });
console.log("[Agent A] tools/list ->", tools.join(", "));

const s = await call("Agent A", a, "search", { engine: "google_scholar", q: "Indian summer monsoon rainfall prediction", limit: 3 });
const top = s.results[0];
const n = top["inline_links.cited_by.total"];
steps.push({ who: "Agent A", note: `The top result is "${top.title}", cited by ${n} [${top.receipt_id}].` });
const receipt = await call("Agent A", a, "get_receipt", { receipt_id: top.receipt_id });

await call("Verifier B", b, "verify_receipt", { receipt, claims: [{ field: "inline_links.cited_by.total", value: n }] });
const tampered = { ...receipt, cited: { ...receipt.cited, "inline_links.cited_by.total": n * 10 } };
steps.push({ who: "Someone", note: `edits the receipt: cited by ${n} -> ${n * 10}` });
await call("Verifier B", b, "verify_receipt", { receipt: tampered });
await call("Agent A", a, "credits", {});

await a.close(); await b.close();
mkdirSync(join(PACKAGE_ROOT, "video/build"), { recursive: true });
writeFileSync(join(PACKAGE_ROOT, "video/build/transcript.json"), JSON.stringify({ at: new Date().toISOString(), offline, steps }, null, 1));
console.log("\ntranscript: video/build/transcript.json");
