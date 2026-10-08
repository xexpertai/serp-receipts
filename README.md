# serp-receipts

**SerpApi search for AI agents, where every result comes with a receipt that anyone can check.**

`serp-receipts` is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server and a small TypeScript library.
It gives any MCP client (Claude Desktop, Cursor, or your own agent) SerpApi search tools. Each result carries a receipt that
pins it to the exact SerpApi search that produced it. A `verify_receipt` tool then re-fetches that search from SerpApi's
archive and checks that the value the agent quoted is really in SerpApi's JSON.

> Agent: "The top paper on Indian monsoon rainfall prediction is cited by 251 [sr_7492ef5039cc4907e74c]."
> Verifier (a second agent with **no SerpApi key**): `verify_receipt` → **VERIFIED**: the citation count is 251 in SerpApi's archived search 6ac7fa48b463f3dd8d9a3626.
> Someone edits the receipt to say 2510 → **MISMATCH**: "receipt says 2510, archive says 251".

Try that exact story in one command, with no key and no credits. Agent A replays a recorded search; Verifier B checks SerpApi's **live** archive:

```bash
npx -y github:xexpertai/serp-receipts demo
```

## Why

Agents quote search results all the time: prices, citation counts, dates, headlines. Today a reader has to trust that the
number wasn't misread, mixed up between results, or made up. A receipt turns "the agent said so" into "here is the exact
search, the exact spot in the JSON, and a hash; check it yourself". This helps:

- **people reviewing agent output** (research notes, price comparisons, news summaries), who can verify any cited fact;
- **multi-agent systems**, where one agent researches and another one audits, without sharing an API key;
- **evaluation and logging**: receipts are small JSON objects you can store next to an answer and re-check later.

## How this differs from SerpApi's official MCP server

SerpApi already has an official MCP server ([github.com/serpapi/serpapi-mcp](https://github.com/serpapi/serpapi-mcp), hosted at `mcp.serpapi.com`). It is the right choice if you want broad search access from an agent:
- many engines (Google, Bing, YouTube, Amazon, Maps, Flights, Hotels and more);
- compact JSON or Markdown output;
- table and dashboard views.

It passes SerpApi's results through to the agent.

serp-receipts is a narrower layer for a different job: **making an agent's search citations checkable**. It does not try to cover every engine. It adds what the official server (as documented today) does not focus on:

| | serp-receipts |
|---|---|
| **Receipts** | Every result carries SerpApi's search id, processed_at, the exact params, a JSON Pointer and a SHA-256 of the result. |
| **Verification** | `verify_receipt` re-fetches the search from SerpApi's archive and checks the cited value and any claim. |
| **Keyless third-party checks** | Receipts with a `json_endpoint` can be verified by someone with no SerpApi account (observed behaviour; see below). |
| **Tamper-evidence** | Edited values, moved pointers, forged params and swapped URLs all fail verification (see tests). |
| **Spend control** | Hard local credit cap, ledger and cache; recorded mode for offline demos and tests. |

The two can be used side by side: search with whichever server you like, and use serp-receipts (MCP tool, CLI or library) when an answer needs a receipt.

## Tools

| Tool | What it does | SerpApi cost |
|---|---|---|
| `search` | `engine` = `google`, `google_news`, `google_scholar` or `google_shopping`, plus `q` and a few optional params (`location`, `gl`, `hl`, `as_ylo`/`as_yhi`, `limit`). Returns compact results, each with a `receipt_id`. | 1 search credit (0 if cached or in recorded mode) |
| `get_receipt` | The full receipt for a `receipt_id`. | none (local) |
| `verify_receipt` | Takes a `receipt_id` or a full receipt JSON, plus optional `claims` (`{field, value}` or just `{value}`). Re-fetches the search from SerpApi's archive and returns `VERIFIED`, `MISMATCH` or `NOT_IN_ARCHIVE`, with every check spelled out. | 0 credits in our measurements (see [Costs](#costs)) |
| `credits` | The local hard cap, credits used on this machine, archive fetches, and (live mode) the account's remaining searches from SerpApi's free Account API. | none |

### What a receipt contains

```json
{
  "v": 1,
  "receipt_id": "sr_7492ef5039cc4907e74c",
  "engine": "google_scholar",
  "params": { "engine": "google_scholar", "q": "Indian summer monsoon rainfall prediction" },
  "search_id": "6ac7fa48b463f3dd8d9a3626",
  "processed_at": "2026-10-08 20:17:12 UTC",
  "retrieved_at": "2026-10-08T20:17:13.139Z",
  "source": "LIVE",
  "search_url": "https://scholar.google.com/scholar?q=Indian+summer+monsoon+rainfall+prediction&hl=en",
  "archive_url": "https://serpapi.com/searches/6ac7fa48b463f3dd8d9a3626.json",
  "json_endpoint": "https://serpapi.com/searches/<per-search token>/6ac7fa48b463f3dd8d9a3626.json",
  "pointer": "/organic_results/0",
  "item_sha256": "781db4c63f713c5ba074aa051a5bdaf1b3ac398d7b00e7373b0e0f752ab73c5f",
  "result_url": "https://…",
  "cited": { "title": "All India summer monsoon rainfall prediction using an artificial neural network", "inline_links.cited_by.total": 251, "…": "…" }
}
```

- `params` never contains the `api_key`.
- `search_id` and `processed_at` come from SerpApi's `search_metadata`.
- `pointer` is an RFC 6901 JSON Pointer to the result inside the search JSON.
- `item_sha256` is the SHA-256 of that result (canonical JSON, keys sorted).
- `cited` holds the fields an agent is likely to quote for that engine (title, link, price, source, date, citation count…).
- `receipt_id` is `sr_` + the first 20 hex characters of a SHA-256 over: `v`, `engine`, `params`, `search_id`, `processed_at`, `json_endpoint`, `pointer`, `item_sha256` and `cited`. Editing any of those changes the id.
- `search_url`, `archive_url`, `result_url`, `retrieved_at` and `source` are **not** in the id. The verifier checks the three URLs against the archive instead (check 5 below). `retrieved_at` and `source` are informational only.
- `json_endpoint` is the per-search link SerpApi returns in `search_metadata.json_endpoint` (see below).

### How verification works

`verify_receipt` fetches the archived search and runs these checks:

1. **receipt_integrity**: the `receipt_id` still matches the receipt's contents.
2. **archive_found**: SerpApi's archive has this `search_id` (searches are kept for 31 days).
3. **same_search**: every param in the receipt (engine, q, location, gl, hl…) equals what SerpApi's archive says was searched. SerpApi reports `location` back as `location_requested`.
4. **item_hash**: the result at `pointer` hashes to `item_sha256`.
5. **urls**: `search_url`, `archive_url` and `result_url` equal the archived values.
6. **cited.\***: every cited field equals the archived value.
7. **claim.\***: each claim you pass holds.
   - `{ "field": "extracted_price", "value": 1199 }` checks one field.
   - `{ "value": "artificial neural network" }` checks that the text appears anywhere in the result.
   - A number-like value (`251`, `"1,199"`) only matches a whole number, so `200` does not match `2000`.

**Where the archived JSON comes from.** The answer always says, in `archive_source` / `archive_via` (and `archive_note` when it fell back).
- If the receipt has a `json_endpoint`, the verifier fetches that URL **live**, sends no API key, and labels it `ARCHIVE_LIVE` via `json_endpoint`. This is the default in every mode, including the no-key setup.
- Otherwise, in live mode, it uses the Search Archive API with your key.
- It uses the bundled recorded archive copies (`ARCHIVE_RECORDED`) only in recorded mode, and only when it is offline, when the live fetch fails, or when `SERP_RECEIPTS_OFFLINE=1` is set.

In our tests (9 Oct 2026) SerpApi served these per-search links without a key, while `GET /searches/{id}.json`
([Search Archive API](https://serpapi.com/search-archive-api)) needs the key of the account that ran the search.
So a second agent, a reviewer or a CI job can verify receipts **without a SerpApi account**.
This keyless behaviour is what we observed, not something SerpApi documents. If it changes, the verifier falls back to the Search Archive API with your key.
Only `https://serpapi.com/searches/<token>/<same search_id>.json` links are accepted; anything else is ignored.

**What a receipt proves, and what it doesn't.** A VERIFIED receipt proves the cited value is what SerpApi returned for that
search at `processed_at`. It does not prove the underlying web page is true, and it is not a signature: anyone can make a
receipt. What a forger can't do is make SerpApi's archive agree with edited values, params, pointers or URLs. The tests cover a
forger who edits a value, a param (`location`, `gl`, `hl`) or a URL and then recomputes `receipt_id`. Verification still
fails because the archive disagrees.

## Install (from GitHub)

This package is **not published to npm or PyPI**. Install it from GitHub; `npm` builds it on install. Requires Node.js 20 or newer.

**Try it first with no key and no credits.** Without `SERPAPI_API_KEY`, `search` runs in *recorded mode* and replays real
SerpApi responses recorded on 9 Oct 2026 IST (in `fixtures/`). `verify_receipt` still checks SerpApi's live archive
through keyless links. You only need `engine` and `q`; the other params are optional, but if you give one it must match the
recording:

| engine | q | params SerpApi actually ran with (filled in for you) |
|---|---|---|
| `google_scholar` | Indian summer monsoon rainfall prediction | none |
| `google` | India UPI transactions September 2026 | `gl=in`, `hl=en` |
| `google_news` | ISRO launch | `gl=in`, `hl=en` |
| `google_shopping` | stainless steel pressure cooker 5 litre | `location=Mumbai, Maharashtra, India`, `gl=in`, `hl=en` |

```bash
npx -y github:xexpertai/serp-receipts demo                                   # the two-agent story (exit 0 = VERIFIED + MISMATCH)
npx -y github:xexpertai/serp-receipts search google_news "ISRO launch"       # recorded search, with receipts
npx -y github:xexpertai/serp-receipts verify examples/receipt.json inline_links.cited_by.total=251   # VERIFIED
npx -y github:xexpertai/serp-receipts verify examples/tampered.json          # MISMATCH: receipt says 2510, archive says 251
```

`examples/receipt.json` is the real receipt from the demo. `examples/tampered.json` is the same receipt with the citation count edited to 2510.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "serp-receipts": {
      "command": "npx",
      "args": ["-y", "github:xexpertai/serp-receipts"],
      "env": {
        "SERPAPI_API_KEY": "your SerpApi key",
        "SERP_RECEIPTS_CREDIT_CAP": "50"
      }
    }
  }
}
```

**No key at all (try it, or verify-only).** Searches replay the bundled recordings, and `verify_receipt` checks any receipt with a `json_endpoint` against SerpApi's live archive:

```json
{
  "mcpServers": {
    "serp-receipts": {
      "command": "npx",
      "args": ["-y", "github:xexpertai/serp-receipts"]
    }
  }
}
```

### Cursor

Put the same `mcpServers` block in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

### Any other MCP client

The command is `npx -y github:xexpertai/serp-receipts` over stdio. From a clone, it is `node dist/cli.js`:

```bash
git clone https://github.com/xexpertai/serp-receipts && cd serp-receipts
npm install            # also builds dist/
npm test               # 54 tests, no network
node dist/cli.js       # MCP server on stdio
```

### Configuration (environment variables only)

| Variable | Default | Meaning |
|---|---|---|
| `SERPAPI_API_KEY` | none | Your key. Without it, `search` only works in recorded mode; `verify_receipt` still works through keyless `json_endpoint` links. |
| `SERP_RECEIPTS_MODE` | `live` if a key is set, else `recorded` | `recorded`: `search` replays bundled recordings and never spends credits; `verify_receipt` still fetches keyless `json_endpoint` links live. `live` without a key: `search` is refused, verify works. |
| `SERP_RECEIPTS_OFFLINE` | off | Set to `1` to never touch the network. Verification then uses the recorded archive copies (labelled `ARCHIVE_RECORDED`). |
| `SERP_RECEIPTS_CREDIT_CAP` | `50` | Hard cap on live search credits counted by this machine's ledger. Searches past it are refused. (Our own development used a cap of 40 and spent 4.) |
| `SERP_RECEIPTS_CACHE_TTL_HOURS` | `24` | Identical searches within this window are served from the local cache for 0 credits. |
| `SERP_RECEIPTS_DATA_DIR` | `~/.serp-receipts` | Ledger, cache and receipt store (files are created with mode 600). |
| `SERP_RECEIPTS_ARCHIVE_COUNTS` | off | Set to `1` to count archive fetches against the cap too. |

## Command line

```bash
serp-receipts                    # MCP server on stdio (default)
serp-receipts demo [--offline]   # Agent A (recorded search) + Verifier B (no key, live archive) over MCP
serp-receipts search google_scholar "Indian summer monsoon rainfall prediction"   # receipts as JSON
serp-receipts credits            # ledger, cap, remaining account searches
serp-receipts verify receipt.json inline_links.cited_by.total=251   # exit code 0 only if VERIFIED
cat receipt.json | serp-receipts verify - "artificial neural network"
```

## Library

```ts
import { SerpClient, createContext, searchTool, verifyReceiptTool, buildReceipts, verifyReceipt } from "serp-receipts";

const ctx = createContext(new SerpClient({ apiKey: process.env.SERPAPI_API_KEY, creditCap: 20 }));
const res = await searchTool(ctx, { engine: "google_shopping", q: "stainless steel pressure cooker 5 litre", gl: "in" });
const check = await verifyReceiptTool(ctx, { receipt_id: res.results[0].receipt_id, claims: [{ field: "extracted_price", value: 1199 }] });
console.log(check.verdict, check.summary);

// Or the pure functions, with JSON you already have:
const receipts = buildReceipts(serpapiJson, { engine: "google", q: "…" }, { source: "LIVE" });
const result = verifyReceipt(receipts[0], archivedJson, [{ value: "29.9 lakh crore" }]);
```

## Costs

- **`search`**: 1 SerpApi search credit per new search. Repeats within the cache window are free (`source: "CACHED"`). Recorded mode is free and offline.
- **Archive fetches (`verify_receipt`)**: SerpApi's docs don't say whether these cost credits, so we measured. On 9 Oct 2026 we read `this_month_usage` from the free Account API before and after. Three archive fetches left it unchanged at 29 after 30 seconds. Across 4 searches plus 4 archive fetches, usage rose by exactly 4. This is a small sample from one free-plan account, and the usage counter can lag a few seconds; the raw readings with timestamps are in [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md). Archive fetches are still logged in the ledger, and `SERP_RECEIPTS_ARCHIVE_COUNTS=1` counts them against the cap if you prefer to be conservative.
- **`credits`**: uses SerpApi's [Account API](https://serpapi.com/account-api), which SerpApi documents as free.
- **The hard cap is enforced before every live request**, and a failed request still counts, because it may still be billed.

## Security notes

- The API key is read **only from the environment**. It is sent only to `serpapi.com`, never written to disk, never put in a receipt, and never logged.
- Every tool output and error message passes through a redactor that replaces the key with `[redacted]`. Tests check that no file in the data directory contains the key, and that the files are mode 600.
- Logs go to stderr only (stdout carries the MCP protocol).
- `verify_receipt` fetches only `https://serpapi.com/searches/…` URLs: the keyless `json_endpoint` (strictly validated, and it must name the same `search_id`) or the Search Archive API. A receipt cannot make the server fetch any other host.
- A `json_endpoint` link opens that one archived search for anyone who has it. Share receipts only for searches you are happy to share. Receipts never include the key itself.
- The tests can't reach the network or spend credits: a setup file replaces `fetch` with one that throws.

## Development

```bash
npm install
npm test              # vitest: 54 tests on synthetic data and real recorded SerpApi responses, no network
npm run typecheck
npx tsx scripts/demo.ts             # scripted two-agent MCP session: Agent A (recorded) + Verifier B (no key, live archive)
npx tsx scripts/demo.ts --offline   # same, fully offline
npx tsx scripts/record.ts           # re-record fixtures (spends 1 credit per new search; capped)
```

`scripts/video/make.sh` rebuilds the demo video from a real two-agent MCP session. It needs Playwright, plus a Python environment with Kokoro TTS and faster-whisper. The video page is `video/session.html`; the script is `video/story.json`.

The recorded fixtures are real SerpApi responses from 9 Oct 2026 (IST). Each file in `fixtures/search/` has a copy of the same search, as returned by SerpApi's archive, in `fixtures/archive/`.

## Limitations

- SerpApi keeps searches for **31 days**. After that, `verify_receipt` returns `NOT_IN_ARCHIVE`. Keep the archived JSON yourself if you need longer, and use the pure `verifyReceipt()` function against it.
- Four engines are supported. Adding one means adding an entry to `ENGINES` in `src/receipt.ts` (where the result list lives and which fields to cite).
- Keyless verification relies on SerpApi's `json_endpoint` behaviour as observed, not as documented.

## AI-assistance disclosure

This project was built by Harsha Shinde with AI assistance: Claude Code (Anthropic's Claude) helped write the code, tests and docs, and the demo video's narration voice is synthetic (Kokoro TTS). All SerpApi data shown is real, recorded from SerpApi on 9 Oct 2026, and labelled as recorded wherever it is replayed.

## License

MIT © 2026 Harsha Shinde
