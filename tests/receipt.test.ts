import { describe, expect, it } from "vitest";
import { canonicalJson, getPointer } from "../src/hash.js";
import { buildReceipts, receiptId, type Receipt } from "../src/receipt.js";
import { verifyReceipt } from "../src/verify.js";
import { FAKE_KEY, scholarRaw, shoppingRaw } from "./synthetic.js";

const params = { engine: "google_scholar", q: "synthetic monsoon paper", api_key: FAKE_KEY };

describe("hashing", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
  });
  it("JSON pointer lookup", () => {
    expect(getPointer(scholarRaw(), "/organic_results/1/title")).toBe("Synthetic paper B");
    expect(getPointer(scholarRaw(), "/organic_results/9")).toBeUndefined();
  });
});

describe("buildReceipts", () => {
  const rs = buildReceipts(scholarRaw(), params, { source: "RECORDED", retrievedAt: "2026-10-09T10:00:01Z" });
  it("issues one receipt per result with search id, time, pointer and hash", () => {
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ engine: "google_scholar", search_id: "synthetic0000000000000001", processed_at: "2026-10-09 10:00:00 UTC", pointer: "/organic_results/0", result_url: "https://example.org/a" });
    expect(rs[0].cited["inline_links.cited_by.total"]).toBe(412);
    expect(rs[0].item_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rs[0].receipt_id).toMatch(/^sr_[0-9a-f]{20}$/);
    expect(rs[0].archive_url).toBe("https://serpapi.com/searches/synthetic0000000000000001.json");
  });
  it("never puts the api_key in a receipt", () => {
    expect(rs[0].params).toEqual({ engine: "google_scholar", q: "synthetic monsoon paper" });
    expect(JSON.stringify(rs)).not.toContain(FAKE_KEY);
  });
  it("receipt_id is stable and changes when any cited value changes", () => {
    const again = buildReceipts(scholarRaw(), params, { source: "LIVE" });
    expect(again[0].receipt_id).toBe(rs[0].receipt_id);
    const { receipt_id, retrieved_at, source, ...core } = rs[0];
    expect(receiptId({ ...core, cited: { ...core.cited, "inline_links.cited_by.total": 4120 } })).not.toBe(receipt_id);
  });
  it("respects limit and rejects responses without a search id", () => {
    expect(buildReceipts(scholarRaw(), params, { source: "LIVE", limit: 1 })).toHaveLength(1);
    expect(() => buildReceipts({ organic_results: [] }, params, { source: "LIVE" })).toThrow(/search_metadata.id/);
  });
});

describe("verifyReceipt", () => {
  const [r] = buildReceipts(scholarRaw(), params, { source: "LIVE" });
  const archive = scholarRaw();

  it("VERIFIED when the archive matches, including a true claim", () => {
    const v = verifyReceipt(r, archive, [{ field: "inline_links.cited_by.total", value: 412 }, { value: "7.5 percent" }]);
    expect(v.verdict).toBe("VERIFIED");
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });
  it("MISMATCH when a claim is false", () => {
    const v = verifyReceipt(r, archive, [{ field: "inline_links.cited_by.total", value: 4120 }]);
    expect(v.verdict).toBe("MISMATCH");
    expect(v.checks.find((c) => c.name === "claim.inline_links.cited_by.total")?.detail).toMatch(/archive says 412/);
  });
  it("MISMATCH when a value is not anywhere in the item", () => {
    expect(verifyReceipt(r, archive, [{ value: "9.9 percent" }]).verdict).toBe("MISMATCH");
  });
  it("MISMATCH when the receipt's cited value was edited", () => {
    const t: Receipt = { ...r, cited: { ...r.cited, "inline_links.cited_by.total": 4120 } };
    const v = verifyReceipt(t, archive);
    expect(v.verdict).toBe("MISMATCH");
    expect(v.checks.find((c) => c.name === "receipt_integrity")?.ok).toBe(false);
  });
  it("still MISMATCH when the forger also recomputes receipt_id: the archive is the source of truth", () => {
    const { receipt_id, retrieved_at, source, ...core } = r;
    const forged = { ...core, cited: { ...core.cited, "inline_links.cited_by.total": 4120 } };
    const t: Receipt = { ...forged, receipt_id: receiptId(forged), retrieved_at, source };
    const v = verifyReceipt(t, archive);
    expect(v.checks.find((c) => c.name === "receipt_integrity")?.ok).toBe(true);
    expect(v.verdict).toBe("MISMATCH");
    expect(v.archived?.["inline_links.cited_by.total"]).toBe(412);
  });
  it("MISMATCH when the pointer is moved to another result", () => {
    expect(verifyReceipt({ ...r, pointer: "/organic_results/1" }, archive).verdict).toBe("MISMATCH");
  });
  it("NOT_IN_ARCHIVE when the search is missing or is a different search", () => {
    expect(verifyReceipt(r, null).verdict).toBe("NOT_IN_ARCHIVE");
    expect(verifyReceipt(r, scholarRaw("synthetic0000000000000999")).verdict).toBe("NOT_IN_ARCHIVE");
  });
  it("numbers and formatted strings compare sensibly", () => {
    const [s] = buildReceipts(shoppingRaw(), { engine: "google_shopping", q: "synthetic kettle" }, { source: "LIVE" });
    expect(verifyReceipt(s, shoppingRaw(), [{ field: "extracted_price", value: "1,299" }, { field: "price", value: "₹1,299.00" }]).verdict).toBe("VERIFIED");
    expect(verifyReceipt(s, shoppingRaw(), [{ field: "extracted_price", value: 999 }]).verdict).toBe("MISMATCH");
  });
});
