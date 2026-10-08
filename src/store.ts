// Local store of issued receipts so an agent can pass around a short receipt_id and look it up later.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "./receipt.js";

const MAX = 5000;

export class ReceiptStore {
  private mem = new Map<string, Receipt>();
  private loaded = false;
  constructor(private readonly dir: string) {}
  private get path() { return join(this.dir, "receipts.json"); }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try { for (const r of JSON.parse(readFileSync(this.path, "utf8")) as Receipt[]) this.mem.set(r.receipt_id, r); } catch { /* corrupt store: start fresh */ }
  }
  put(rs: Receipt[]) {
    this.load();
    for (const r of rs) { this.mem.delete(r.receipt_id); this.mem.set(r.receipt_id, r); }
    const all = [...this.mem.values()].slice(-MAX);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 });
  }
  get(id: string): Receipt | undefined { this.load(); return this.mem.get(id); }
  size() { this.load(); return this.mem.size; }
}
