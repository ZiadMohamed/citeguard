import MiniSearch from "minisearch";
import type { DocStore } from "./store.js";

/** A searchable unit: one table row, or one paragraph of a text section. */
export interface Chunk {
  id: string;
  docId: string;
  section: string;
  text: string;
  /** Document title, section label and heading (and the header row for tables). */
  context: string;
}

export interface SearchHit extends Chunk {
  score: number;
}

/** Keeps decimals and thousands separators inside one token ("0.455", "1,234"). */
const TOKEN_RE = /[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu;

export function tokenize(text: string): string[] {
  return (text.match(TOKEN_RE) ?? []).map(normalizeTerm);
}

/** Lowercases, and makes "1,234" match "1234" and "12.30" match "12.3". */
function normalizeTerm(term: string): string {
  const t = term.toLowerCase();
  if (!/^\d[\d,]*(\.\d+)?$/.test(t)) return t;
  const n = t.replace(/,/g, "");
  return n.includes(".") ? n.replace(/\.?0+$/, "") : n;
}

export function buildChunks(store: DocStore): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of store.docs) {
    for (const s of doc.sections) {
      const parts = (s.kind === "table" ? s.text.split("\n") : s.text.split(/\n\s*\n/))
        .map((p) => p.trim())
        .filter(Boolean);
      const header = s.kind === "table" ? (parts[0] ?? "") : "";
      parts.forEach((text, i) => {
        chunks.push({
          id: `${doc.id}|${s.label}|${i}`,
          docId: doc.id,
          section: s.label,
          text,
          context: `${doc.id} ${doc.title} ${s.label} ${s.heading} ${header}`,
        });
      });
    }
  }
  return chunks;
}

/** BM25 keyword search (via MiniSearch) over table rows and paragraphs. */
export class SearchIndex {
  private ms: MiniSearch<Chunk>;

  constructor(chunks: Chunk[]) {
    this.ms = new MiniSearch<Chunk>({
      fields: ["text", "context"],
      storeFields: ["docId", "section", "text", "context"],
      tokenize,
      processTerm: (t) => t,
      searchOptions: { boost: { text: 2 }, combineWith: "OR", prefix: false, fuzzy: false },
    });
    this.ms.addAll(chunks);
  }

  search(query: string, opts: { docId?: string; limit?: number } = {}): SearchHit[] {
    const docId = opts.docId?.trim().toUpperCase();
    const results = this.ms.search(query, docId ? { filter: (r) => r.docId.toUpperCase() === docId } : {});
    return results.slice(0, opts.limit ?? 8).map((r) => ({
      id: r.id,
      docId: r.docId,
      section: r.section,
      text: r.text,
      context: r.context,
      score: r.score,
    }));
  }
}
