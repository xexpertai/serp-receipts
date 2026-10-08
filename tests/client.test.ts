import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CreditCapError, NotRecordedError, paramsKey, SerpClient } from "../src/client.js";
import { FAKE_KEY, fakeFetch, scholarRaw } from "./synthetic.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serp-receipts-test-"));
const q = { engine: "google_scholar", q: "synthetic monsoon paper" };

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("SerpClient live mode (fake fetch)", () => {
  it("counts every live search and refuses past the hard cap", async () => {
    const f = fakeFetch({ "/search.json": scholarRaw() });
    const c = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), creditCap: 2, cacheTtlHours: 0, fetch: f.fn });
    await c.search(q);
    await c.search({ ...q, q: "second" });
    await expect(c.search({ ...q, q: "third" })).rejects.toBeInstanceOf(CreditCapError);
    expect(f.calls).toHaveLength(2);
    expect(c.readLedger().credits).toBe(2);
  });
  it("serves repeats from the cache for 0 credits", async () => {
    const f = fakeFetch({ "/search.json": scholarRaw() });
    const c = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), creditCap: 5, fetch: f.fn });
    expect((await c.search(q)).source).toBe("LIVE");
    expect((await c.search({ q: q.q, engine: q.engine })).source).toBe("CACHED");
    expect(f.calls).toHaveLength(1);
    expect(c.readLedger().credits).toBe(1);
  });
  it("sends the key only to serpapi.com and never writes it to disk", async () => {
    const f = fakeFetch({ "/search.json": scholarRaw(), "/searches/synthetic0000000000000001.json": scholarRaw() });
    const dir = tmp();
    const c = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: dir, fetch: f.fn });
    await c.search(q);
    await c.archive("synthetic0000000000000001");
    expect(f.calls.every((u) => new URL(u).origin === "https://serpapi.com")).toBe(true);
    for (const p of allFiles(dir)) {
      expect(readFileSync(p, "utf8")).not.toContain(FAKE_KEY);
      expect(statSync(p).mode & 0o077).toBe(0);
    }
  });
  it("scrubs the key from error messages", async () => {
    const c = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), fetch: async (u) => { throw new Error(`connect failed for ${u}`); } });
    const err = (await c.search(q).then(() => new Error("no error"), (e) => e)) as Error;
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain(FAKE_KEY);
  });
  it("logs archive fetches; they count against the cap only when configured", async () => {
    const f = fakeFetch({ "/searches/synthetic0000000000000001.json": scholarRaw() });
    const free = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), creditCap: 0, fetch: f.fn });
    expect((await free.archive("synthetic0000000000000001")).raw.search_metadata.id).toBe("synthetic0000000000000001");
    expect(free.readLedger()).toMatchObject({ credits: 0, archive_fetches: 1 });
    const counted = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), creditCap: 0, archiveCountsAsCredit: true, fetch: f.fn });
    await expect(counted.archive("synthetic0000000000000001")).rejects.toBeInstanceOf(CreditCapError);
  });
  it("rejects malformed search ids before any request", async () => {
    const f = fakeFetch({});
    const c = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), fetch: f.fn });
    await expect(c.archive("../account")).rejects.toThrow(/format/);
    expect(f.calls).toHaveLength(0);
  });
  it("without a key: searching is refused, verifying via a keyless json_endpoint works and sends no key", async () => {
    const ep = "https://serpapi.com/searches/AbCdEfGhIjKlMnOpQrStUv/synthetic0000000000000001.json";
    const f = fakeFetch({ "/searches/AbCdEfGhIjKlMnOpQrStUv/synthetic0000000000000001.json": scholarRaw() });
    const c = new SerpClient({ mode: "live", dataDir: tmp(), fetch: f.fn });
    await expect(c.search(q)).rejects.toThrow(/SERPAPI_API_KEY/);
    const a = await c.archive("synthetic0000000000000001", ep);
    expect(a.via).toBe("json_endpoint");
    expect(a.raw.search_metadata.id).toBe("synthetic0000000000000001");
    expect(f.calls).toEqual([ep]);
    await expect(c.archive("synthetic0000000000000001")).rejects.toThrow(/SERPAPI_API_KEY/);
  });
  it("ignores json_endpoints that are not serpapi.com links for this exact search", async () => {
    const f = fakeFetch({ "/searches/synthetic0000000000000001.json": scholarRaw() });
    const c = new SerpClient({ apiKey: FAKE_KEY, mode: "live", dataDir: tmp(), fetch: f.fn });
    for (const bad of ["https://evil.example/searches/AbCdEfGhIjKlMnOpQrStUv/synthetic0000000000000001.json",
      "https://serpapi.com/searches/AbCdEfGhIjKlMnOpQrStUv/othersearch000000000001.json",
      "http://serpapi.com/searches/AbCdEfGhIjKlMnOpQrStUv/synthetic0000000000000001.json"]) {
      expect((await c.archive("synthetic0000000000000001", bad)).via).toBe("api_key");
    }
    expect(f.calls.every((u) => u.startsWith("https://serpapi.com/searches/synthetic0000000000000001.json?"))).toBe(true);
  });
});

describe("SerpClient recorded mode", () => {
  it("replays recorded searches and archives with no network", async () => {
    const rec = tmp();
    mkdirSync(join(rec, "search")); mkdirSync(join(rec, "archive"));
    writeFileSync(join(rec, "search", `${paramsKey(q)}.json`), JSON.stringify({ fetchedAt: "2026-10-09T10:00:01Z", params: q, raw: scholarRaw() }));
    writeFileSync(join(rec, "archive", "synthetic0000000000000001.json"), JSON.stringify({ raw: scholarRaw() }));
    const c = new SerpClient({ mode: "recorded", dataDir: tmp(), recordedDir: rec });
    const s = await c.search({ q: q.q, engine: q.engine });
    expect(s.source).toBe("RECORDED");
    expect((await c.archive("synthetic0000000000000001")).source).toBe("ARCHIVE_RECORDED");
    expect((await c.archive("synthetic0000000000000099")).raw).toBeNull();
    await expect(c.search({ ...q, q: "not recorded" })).rejects.toBeInstanceOf(NotRecordedError);
    expect(c.readLedger().credits).toBe(0);
  });
  it("defaults to recorded mode when no key is set", () => {
    expect(new SerpClient({ dataDir: tmp() }).mode).toBe("recorded");
  });
});
