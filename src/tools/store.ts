import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "../bench/datasets.js";

const DATA_DIR = join(import.meta.dirname, "..", "..", "data");

export interface Section {
  /** How a citation refers to it, e.g. "Table 2" or "Methods > Participants". */
  label: string;
  /** Table caption or section heading. */
  heading: string;
  kind: "table" | "text";
  /** Tables: one row per line. Text: paragraphs separated by blank lines. */
  text: string;
}

export interface Document {
  id: string;
  title: string;
  /** "full" corpus only: a study report, or a cited literature reference. */
  kind?: "study" | "reference";
  sections: Section[];
}

/**
 * "tables": each paper's tables only (what the baseline sees).
 * "full": every cached paper, with methods sections plus tables (built by python/build_docs.py).
 */
export type CorpusVariant = "tables" | "full";

export class DocStore {
  readonly docs: Document[];
  private byId: Map<string, Document>;

  constructor(docs: Document[]) {
    this.docs = docs;
    this.byId = new Map(docs.map((d) => [d.id.toUpperCase(), d]));
  }

  get(id: string): Document | undefined {
    return this.byId.get(id.trim().toUpperCase());
  }

  findSection(doc: Document, label: string): Section | undefined {
    const want = normalizeLabel(label);
    const exact =
      doc.sections.find((s) => normalizeLabel(s.label) === want) ??
      doc.sections.find((s) => normalizeLabel(s.heading) === want);
    if (exact) return exact;
    // Models often paste a whole outline line ("Table 1: caption"). Accept a label followed by a
    // separator, but never "Table 1" for "Table 12".
    const raw = simplify(label);
    return doc.sections
      .filter((s) => {
        const l = simplify(s.label);
        return raw.startsWith(l) && /^[^a-z0-9]/.test(raw.slice(l.length));
      })
      .sort((a, b) => b.label.length - a.label.length)[0];
  }
}

const normalizeLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9>]+/g, "");
const simplify = (s: string) => s.toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim();

interface PaperRow {
  id: string;
  title: string;
  tables: { label: string; caption: string; rows: string[]; foot: string }[];
}

export function loadStore(dataset: string, variant: CorpusVariant): DocStore {
  const fixtureDocs = join(DATA_DIR, "..", "fixtures", dataset, "docs.jsonl");
  if (existsSync(fixtureDocs)) return new DocStore(readJsonl<Document>(fixtureDocs));
  if (dataset !== "pmc" && dataset !== "pmcrefs") {
    throw new Error(`The tool agent supports the pmc and pmcrefs datasets (got "${dataset}")`);
  }
  if (variant === "full") {
    const path = join(DATA_DIR, "pmc", "docs_full.jsonl");
    if (!existsSync(path)) throw new Error(`${path} is missing; run pnpm prep:docs`);
    return new DocStore(readJsonl<Document>(path));
  }
  if (dataset === "pmcrefs") throw new Error("pmcrefs cites whole papers; run it with --corpus full");
  const papers = readJsonl<PaperRow>(join(DATA_DIR, "pmc", "papers.jsonl"));
  return new DocStore(
    papers.map((p) => ({
      id: p.id,
      title: p.title,
      sections: p.tables.map((t) => ({
        label: t.label,
        heading: t.caption,
        kind: "table" as const,
        text: t.rows.join("\n") + (t.foot ? `\n\nNotes: ${t.foot}` : ""),
      })),
    })),
  );
}

/** Splits text into pages of at most `pageChars`, breaking at line boundaries where possible. */
export function paginate(text: string, pageChars: number): string[] {
  const pages: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    for (let i = 0; i < Math.max(line.length, 1); i += pageChars) {
      const piece = line.slice(i, i + pageChars);
      if (current && current.length + 1 + piece.length > pageChars) {
        pages.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current || pages.length === 0) pages.push(current);
  return pages;
}
