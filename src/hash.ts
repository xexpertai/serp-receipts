import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** RFC 6901 JSON Pointer lookup ("/organic_results/0"). Returns undefined when the path does not exist. */
export function getPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let cur: any = doc;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Path like "price" or "inline_links.cited_by.total" inside an item. */
export function getPath(item: unknown, path: string): unknown {
  return getPointer(item, "/" + path.split(".").join("/"));
}
