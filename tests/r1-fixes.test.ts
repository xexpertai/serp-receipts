// Judge round 1 fixes: recorded matching, verifier gaps (all params, URLs, whole-number claims), live-first verify.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotRecordedError, SerpClient } from "../src/client.js";
import { buildReceipts, receiptId, type Receipt } from "../src/receipt.js";
import { createContext, searchTool, verifyReceiptTool } from "../src/tools.js";
import { verifyReceipt } from "../src/verify.js";
import { fakeFetch } from "./synthetic.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serp-receipts-r1-"));
const rec = (o: Partial<ConstructorParameters<typeof SerpClient>[0]> = {}) => new SerpClient({ mode: "recorded", dataDir: tmp(), offline: true, ...o });

/** Re-issue a receipt with edits AND a recomputed receipt_id (the strongest forger). */
function forge(r: Receipt, edit: Partial<Receipt>): Receipt {
  const { receipt_id, retrieved_at, source, ...core } = { ...r, ...edit };
  return { ...core, receipt_id: receiptId(core), retrieved_at, source };
}

async function first(c: SerpClient, engine: string, q: string) {
  const f = await c.search({ engine, q });
  const [r] = buildReceipts(f.raw, f.params, { source: f.source });
  const a = await c.archive(r.search_id);
  return { r, archive: a.raw };
}

describe("recorded mode: README examples work with engine + q only", () => {
  const ex: [string, string][] = [
    ["google_scholar", "Indian summer monsoon rainfall prediction"],
    ["google", "India UPI transactions September 2026"],
    ["google_news", "ISRO launch"],
    ["google_shopping", "stainless steel pressure cooker 5 litre"],
  ];
  for (const [engine, q] of ex) it(`${engine} "${q}"`, async () => {
    const ctx = createContext(rec());
    const s = await searchTool(ctx, { engine, q });
    expect(s.source).toBe("RECORDED");
    expect(s.results.length).toBeGreaterThan(0);
    // receipts carry the params SerpApi actually ran with, not the shortened request
    expect(s.search.params.engine).toBe(engine);
  });
  it("is case- and space-insensitive on q, and accepts matching optional params", async () => {
    const c = rec();
    expect((await c.search({ engine: "google_news", q: "  isro   LAUNCH " })).source).toBe("RECORDED");
    expect((await c.search({ engine: "google_shopping", q: "stainless steel pressure cooker 5 litre", gl: "in" })).params.location).toBe("Mumbai, Maharashtra, India");
  });
  it("refuses a conflicting param (that would be a different search) with a clear message", async () => {
    const err = await rec().search({ engine: "google_shopping", q: "stainless steel pressure cooker 5 litre", location: "Delhi, India" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotRecordedError);
    expect(err.message).toMatch(/not one of the bundled recordings/);
    expect(err.message).toMatch(/SERPAPI_API_KEY/);
  });
});

describe("verifier gaps (receipt ids unchanged)", () => {
  it("the scholar receipt id shown in the README and video is unchanged", async () => {
    const { r } = await first(rec(), "google_scholar", "Indian summer monsoon rainfall prediction");
    expect(r.receipt_id).toBe("sr_7492ef5039cc4907e74c");
  });
  it("forged location with a recomputed id fails same_search", async () => {
    const { r, archive } = await first(rec(), "google_shopping", "stainless steel pressure cooker 5 litre");
    expect(verifyReceipt(r, archive).verdict).toBe("VERIFIED");
    const v = verifyReceipt(forge(r, { params: { ...r.params, location: "Delhi, India" } }), archive);
    expect(v.verdict).toBe("MISMATCH");
    expect(v.checks.find((c) => c.name === "same_search")?.detail).toMatch(/location: receipt says "Delhi, India", archive says "Mumbai, Maharashtra, India"/);
    expect(v.checks.find((c) => c.name === "receipt_integrity")?.ok).toBe(true);
  });
  it("forged gl / hl fail same_search", async () => {
    const { r, archive } = await first(rec(), "google_news", "ISRO launch");
    expect(verifyReceipt(forge(r, { params: { ...r.params, gl: "us" } }), archive).verdict).toBe("MISMATCH");
    expect(verifyReceipt(forge(r, { params: { ...r.params, hl: "hi" } }), archive).verdict).toBe("MISMATCH");
  });
  for (const k of ["result_url", "search_url", "archive_url"] as const) {
    it(`edited ${k} (not in receipt_id) fails the urls check`, async () => {
      const { r, archive } = await first(rec(), "google_scholar", "Indian summer monsoon rainfall prediction");
      const t = { ...r, [k]: "https://example.org/somewhere-else" };
      const v = verifyReceipt(t, archive);
      expect(v.verdict).toBe("MISMATCH");
      expect(v.checks.find((c) => c.name === "urls")?.detail).toContain(`${k}: receipt says "https://example.org/somewhere-else"`);
    });
  }
  it("free-text numeric claims match whole numbers only (200 is not 2000)", async () => {
    const { r, archive } = await first(rec(), "google_scholar", "Indian summer monsoon rainfall prediction");
    expect(JSON.stringify(archive.organic_results[0])).toContain("2000");
    expect(verifyReceipt(r, archive, [{ value: "200" }]).verdict).toBe("MISMATCH");
    expect(verifyReceipt(r, archive, [{ value: "100" }]).verdict).toBe("MISMATCH");
    expect(verifyReceipt(r, archive, [{ value: "25" }]).verdict).toBe("MISMATCH");
    expect(verifyReceipt(r, archive, [{ value: "251" }]).verdict).toBe("VERIFIED");
    expect(verifyReceipt(r, archive, [{ value: 2000 }]).verdict).toBe("VERIFIED");
  });
  it("numbers with thousands separators match ('1,199' and 1199 on the shopping result)", async () => {
    const { r, archive } = await first(rec(), "google_shopping", "stainless steel pressure cooker 5 litre");
    expect(verifyReceipt(r, archive, [{ value: "1,199" }]).verdict).toBe("VERIFIED");
    expect(verifyReceipt(r, archive, [{ value: "1199" }]).verdict).toBe("VERIFIED");
    expect(verifyReceipt(r, archive, [{ value: "119" }]).verdict).toBe("MISMATCH");
  });
});

describe("verify defaults to SerpApi's live archive, even without a key", () => {
  const scholar = async () => (await first(rec(), "google_scholar", "Indian summer monsoon rainfall prediction")).r;

  it("recorded mode, online: fetches the keyless json_endpoint live (no key sent)", async () => {
    const r = await scholar();
    const archive = (await rec().archive(r.search_id)).raw;
    const f = fakeFetch({ [new URL(r.json_endpoint!).pathname]: archive });
    const ctx = createContext(new SerpClient({ mode: "recorded", dataDir: tmp(), fetch: f.fn }));
    const v = await verifyReceiptTool(ctx, { receipt: r });
    expect(v).toMatchObject({ verdict: "VERIFIED", archive_source: "ARCHIVE_LIVE", archive_via: "json_endpoint" });
    expect(f.calls).toEqual([r.json_endpoint]);
  });
  it("recorded mode, network down: falls back to the recorded copy and says so", async () => {
    const r = await scholar();
    const ctx = createContext(new SerpClient({ mode: "recorded", dataDir: tmp() })); // tests' fetch always throws
    const v = await verifyReceiptTool(ctx, { receipt: r });
    expect(v).toMatchObject({ verdict: "VERIFIED", archive_source: "ARCHIVE_RECORDED", archive_via: "recorded" });
    expect(v.archive_note).toMatch(/live archive unreachable/);
  });
  it("SERP_RECEIPTS_OFFLINE: never calls the network", async () => {
    const r = await scholar();
    const f = fakeFetch({});
    const ctx = createContext(new SerpClient({ mode: "recorded", dataDir: tmp(), offline: true, fetch: f.fn }));
    expect((await verifyReceiptTool(ctx, { receipt: r })).archive_source).toBe("ARCHIVE_RECORDED");
    expect(f.calls).toHaveLength(0);
  });
  it("NOT_IN_ARCHIVE in recorded/offline mode says that, not 'SerpApi has no search'", async () => {
    const r = await scholar();
    const t = forge(r, { search_id: "0000aaaa1111bbbb2222cccc", json_endpoint: null });
    const v = await verifyReceiptTool(createContext(rec()), { receipt: t });
    expect(v.verdict).toBe("NOT_IN_ARCHIVE");
    expect(v.summary).toMatch(/no recorded archive copy/);
  });
});
