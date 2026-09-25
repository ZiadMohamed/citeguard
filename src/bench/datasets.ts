import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchItem, SourceDoc } from "../types.js";

const DATA_DIR = join(import.meta.dirname, "..", "..", "data");

export interface Dataset {
  items: BenchItem[];
  docs: Map<string, SourceDoc>;
}

export function loadDataset(name: string, split: "sample" | "full"): Dataset {
  const dir = join(DATA_DIR, name);
  const items = readJsonl<BenchItem>(join(dir, split === "sample" ? "items_sample.jsonl" : "items.jsonl"));
  const docs = new Map(readJsonl<SourceDoc>(join(dir, "corpus.jsonl")).map((d) => [d.id, d]));
  return { items, docs };
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
