import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "../jsonl.js";
import type { BenchItem, RunRecord, SourceDoc, Verdict } from "../types.js";

export { readJsonl };

const ROOT = join(import.meta.dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const LABELS_DIR = join(ROOT, "labels");

export interface Dataset {
  items: BenchItem[];
  docs: Map<string, SourceDoc>;
}

/** A human-reviewed correction to a benchmark label (see labels/*.jsonl). */
export interface LabelOverride {
  id: string;
  label: Verdict;
  category: string;
  status: string;
  note: string;
  /** The reviewed item's text. An override applies only when the item still says this, so a
   * regenerated dataset whose ids shifted can't silently relabel a different claim. */
  claim?: string;
  citation?: string;
}

export function loadDataset(name: string, split: "sample" | "full"): Dataset {
  const fixture = join(ROOT, "fixtures", name);
  const dir = existsSync(fixture) ? fixture : join(DATA_DIR, name);
  const items = readJsonl<BenchItem>(join(dir, split === "sample" ? "items_sample.jsonl" : "items.jsonl"));
  const docs = new Map(readJsonl<SourceDoc>(join(dir, "corpus.jsonl")).map((d) => [d.id, d]));
  return { items, docs };
}

export function loadOverrides(dataset: string): Map<string, LabelOverride> {
  const path = join(LABELS_DIR, `${dataset}_overrides.jsonl`);
  if (!existsSync(path)) return new Map();
  return new Map(readJsonl<LabelOverride>(path).map((o) => [o.id, o]));
}

/** True when the override was written for this item (same claim and citation, if recorded). */
export function overrideMatches(o: LabelOverride, item: { claim: string; citation: string }): boolean {
  return (o.claim === undefined || o.claim === item.claim) && (o.citation === undefined || o.citation === item.citation);
}

/**
 * Replaces benchmark labels with reviewed ones. Items whose label changed get the
 * review category as their errorType so the per-type breakdown shows what happened.
 */
/** Override ids skipped because their item's text changed. Reported once per process. */
const staleOverrides = new Set<string>();
process.on("exit", () => {
  if (staleOverrides.size) {
    console.error(`warning: ${staleOverrides.size} reviewed label(s) skipped because the item's text changed (dataset regenerated?): ${[...staleOverrides].slice(0, 5).join(", ")}`);
  }
});

export function applyOverrides(records: RunRecord[], overrides: Map<string, LabelOverride>): RunRecord[] {
  return records.map((r) => {
    const o = overrides.get(r.item.id);
    if (!o || o.label === r.item.label) return r;
    if (!overrideMatches(o, r.item)) {
      staleOverrides.add(o.id);
      return r;
    }
    return { ...r, item: { ...r.item, label: o.label, errorType: o.category } };
  });
}
