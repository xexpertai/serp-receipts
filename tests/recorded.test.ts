// Runs on REAL SerpApi responses recorded on 9 Oct 2026 IST (fixtures/search) and the same searches re-fetched
// from SerpApi's archive (fixtures/archive). No network: the client is in recorded mode.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SerpClient } from "../src/client.js";
import { buildReceipts, receiptId, type Receipt } from "../src/receipt.js";
import { verifyReceipt } from "../src/verify.js";

const c = new SerpClient({ mode: "recorded", dataDir: mkdtempSync(join(tmpdir(), "serp-receipts-rec-")) });
const searches = c.recordedSearches();

describe("recorded SerpApi data", () => {
  it("has the four engines recorded", () => {
    expect(searches.map((s) => s.params.engine).sort()).toEqual(["google", "google_news", "google_scholar", "google_shopping"]);
  });
  for (const s of searches) {
    it(`${s.params.engine} "${s.params.q}": every receipt verifies against the archived copy; a tampered one does not`, async () => {
      const f = await c.search(s.params);
      const rs = buildReceipts(f.raw, f.params, { source: f.source, limit: 20 });
      expect(rs.length).toBeGreaterThan(0);
      expect(rs[0].json_endpoint).toMatch(new RegExp(`^https://serpapi\\.com/searches/[^/]+/${s.search_id}\\.json$`));
      const a = await c.archive(s.search_id);
      for (const r of rs) expect(verifyReceipt(r, a.raw).verdict, r.pointer).toBe("VERIFIED");
      const r = rs[0];
      const field = Object.keys(r.cited).find((k) => typeof r.cited[k] === "string" && k !== "link")!;
      const { receipt_id, retrieved_at, source, ...core } = r;
      const forged = { ...core, cited: { ...core.cited, [field]: String(core.cited[field]) + " (edited)" } };
      const t: Receipt = { ...forged, receipt_id: receiptId(forged), retrieved_at, source };
      expect(verifyReceipt(t, a.raw).verdict).toBe("MISMATCH");
    });
  }
  it("scholar citation-count claims: true value verifies, inflated value fails", async () => {
    const s = searches.find((x) => x.params.engine === "google_scholar")!;
    const f = await c.search(s.params);
    const [r] = buildReceipts(f.raw, f.params, { source: f.source });
    const n = r.cited["inline_links.cited_by.total"] as number;
    expect(typeof n).toBe("number");
    const a = await c.archive(s.search_id);
    expect(verifyReceipt(r, a.raw, [{ field: "inline_links.cited_by.total", value: n }]).verdict).toBe("VERIFIED");
    expect(verifyReceipt(r, a.raw, [{ field: "inline_links.cited_by.total", value: n * 10 }]).verdict).toBe("MISMATCH");
  });
});

describe("README examples hold on the recorded data", () => {
  it("shopping: top result's extracted_price is 1199", async () => {
    const s = searches.find((x) => x.params.engine === "google_shopping")!;
    const f = await c.search(s.params);
    const [r] = buildReceipts(f.raw, f.params, { source: f.source });
    expect(verifyReceipt(r, (await c.archive(s.search_id)).raw, [{ field: "extracted_price", value: 1199 }]).verdict).toBe("VERIFIED");
  });
  it("google: '29.9 lakh crore' appears in the top organic result", async () => {
    const s = searches.find((x) => x.params.engine === "google")!;
    const f = await c.search(s.params);
    const [r] = buildReceipts(f.raw, f.params, { source: f.source });
    expect(r.pointer).toBe("/organic_results/0");
    expect(verifyReceipt(r, (await c.archive(s.search_id)).raw, [{ value: "29.9 lakh crore" }]).verdict).toBe("VERIFIED");
  });
});
