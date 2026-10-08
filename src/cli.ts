#!/usr/bin/env node
// serp-receipts            start the MCP server on stdio (for Claude Desktop, Cursor, any MCP client)
// serp-receipts credits    print the local ledger and cap
// serp-receipts demo [--offline]   two-agent demo: recorded search + keyless live verification (no key needed)
// serp-receipts search <engine> "<q>" [param=value ...]   one search, printed with receipts
// serp-receipts verify <receipt.json|-> [field=value ...]
//                          verify a receipt from a file or stdin (works without an API key when the receipt has a json_endpoint)
// Logs go to stderr only (stdout carries the MCP protocol). The API key is never logged.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvLocal, optionsFromEnv, SerpClient } from "./client.js";
import { createServer, VERSION } from "./server.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./client.js";
import { runDemo } from "./demo.js";
import { createContext, creditsTool, searchTool, verifyReceiptTool } from "./tools.js";

/** A path relative to the current folder, or else to the package (so `verify examples/receipt.json` works after npx). */
const resolveInput = (p: string) => (existsSync(p) || !existsSync(join(PACKAGE_ROOT, p)) ? p : join(PACKAGE_ROOT, p));
const parseValue = (raw: string) => (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);

loadEnvLocal();
const client = new SerpClient(optionsFromEnv());
const cmd = process.argv[2];

if (cmd === "credits") {
  console.log(JSON.stringify(await creditsTool(createContext(client)), null, 2));
} else if (cmd === "verify" && process.argv[3]) {
  let text: string;
  try { text = readFileSync(process.argv[3] === "-" ? 0 : resolveInput(process.argv[3]), "utf8"); } catch (e) { console.error(`cannot read ${process.argv[3]}: ${(e as Error).message}`); process.exit(2); }
  const claims = process.argv.slice(4).map((a) => {
    const i = a.indexOf("=");
    const raw = i < 0 ? a : a.slice(i + 1);
    const value = parseValue(raw);
    return i < 0 ? { value } : { field: a.slice(0, i), value };
  });
  const r = await verifyReceiptTool(createContext(client), { receipt: text, claims });
  console.log(client.redact(JSON.stringify(r, null, 2)));
  process.exit(r.verdict === "VERIFIED" ? 0 : 1);
} else if (cmd === "demo") {
  const r = await runDemo({ offline: process.argv.includes("--offline") || client.offline });
  process.exit(r.verified === "VERIFIED" && r.tampered === "MISMATCH" ? 0 : 1);
} else if (cmd === "search" && process.argv[3] && process.argv[4]) {
  const extra = Object.fromEntries(process.argv.slice(5).map((a) => { const i = a.indexOf("="); return [a.slice(0, i), parseValue(a.slice(i + 1))]; }));
  console.log(client.redact(JSON.stringify(await searchTool(createContext(client), { engine: process.argv[3], q: process.argv[4], ...extra }), null, 2)));
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === undefined || cmd === "serve") {
  await createServer(client).connect(new StdioServerTransport());
  console.error(`serp-receipts ${VERSION} on stdio: mode=${client.mode}, cap=${client.creditCap}, data=${client.dataDir}`);
} else {
  console.error("usage: serp-receipts [serve | demo [--offline] | search <engine> <q> [param=value ...] | credits | verify <receipt.json|-> [field=value ...] | --version]");
  process.exit(2);
}
