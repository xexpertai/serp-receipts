// Tests must never reach the network (or spend SerpApi credits): any real fetch fails loudly.
globalThis.fetch = (async (url: unknown) => { throw new Error(`network disabled in tests: ${String(url).split("?")[0]}`); }) as typeof fetch;
delete process.env.SERPAPI_API_KEY;
