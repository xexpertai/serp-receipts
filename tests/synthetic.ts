// SYNTHETIC test data shaped like SerpApi responses. Not real search results; used only by unit tests.
export const FAKE_KEY = "test_key_0123456789abcdef_not_real";

export function scholarRaw(id = "synthetic0000000000000001") {
  return {
    search_metadata: { id, status: "Success", processed_at: "2026-10-09 10:00:00 UTC", google_scholar_url: "https://scholar.google.com/scholar?q=synthetic" },
    search_parameters: { engine: "google_scholar", q: "synthetic monsoon paper" },
    organic_results: [
      { position: 0, title: "Synthetic paper A", link: "https://example.org/a", publication_info: { summary: "A Author - Example Journal, 2020" }, inline_links: { cited_by: { total: 412 } }, snippet: "Rainfall rose 7.5 percent in the synthetic set." },
      { position: 1, title: "Synthetic paper B", link: "https://example.org/b", publication_info: { summary: "B Author - 2019" }, inline_links: { cited_by: { total: 18 } } },
    ],
  };
}

export function shoppingRaw(id = "synthetic0000000000000002") {
  return {
    search_metadata: { id, status: "Success", processed_at: "2026-10-09 10:05:00 UTC", google_shopping_url: "https://www.google.com/search?tbm=shop&q=synthetic" },
    search_parameters: { engine: "google_shopping", q: "synthetic kettle" },
    shopping_results: [
      { position: 1, title: "Synthetic kettle 1.5 L", price: "₹1,299.00", extracted_price: 1299, source: "Example Store", product_link: "https://example.org/p/1" },
    ],
  };
}

/** A fake fetch that serves canned JSON by URL path and records every URL it was asked for. */
export function fakeFetch(routes: Record<string, any>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const body = routes[u.pathname] ?? routes[u.pathname + "?" + u.searchParams.get("engine")];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body ?? { error: "not found" } };
  };
  return { fn, calls };
}
