import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchItem, RunRecord, SourceDoc, Verdict } from "../types.js";

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

/**
 * Replaces benchmark labels with reviewed ones. Items whose label changed get the
 * review category as their errorType so the per-type breakdown shows what happened.
 */
export function applyOverrides(records: RunRecord[], overrides: Map<string, LabelOverride>): RunRecord[] {
  return records.map((r) => {
    const o = overrides.get(r.item.id);
    if (!o || o.label === r.item.label) return r;
    return { ...r, item: { ...r.item, label: o.label, errorType: o.category } };
  });
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
