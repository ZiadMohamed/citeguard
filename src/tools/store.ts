import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "../jsonl.js";

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
  /** Other ways the submission refers to it: "Study ABC-101", "ABC-101 CSR", a report number. */
  aliases?: string[];
  sections: Section[];
}

/** "CSR-ABC101" and "CSR ABC-101" both become "csrabc101". */
const idKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * tables: each paper's tables, from the XML (what the baseline sees).
 * pdf: the same tables parsed from the PDFs (python/prep_pdf.py).
 * full: every cached paper, methods sections plus tables, and the cited references (python/build_docs.py).
 */
export type CorpusVariant = "tables" | "pdf" | "full";

export class DocStore {
  readonly docs: Document[];
  private byId: Map<string, Document>;
  private byKey = new Map<string, Document>();
  /** Non-PMC ids and aliases, longest first, as patterns tolerant of spaces and hyphens. */
  private namePatterns: { re: RegExp; doc: Document }[] = [];

  constructor(docs: Document[]) {
    this.docs = docs;
    this.byId = new Map(docs.map((d) => [d.id.toUpperCase(), d]));
    const names: { name: string; doc: Document }[] = [];
    for (const d of docs) {
      for (const name of [d.id, ...(d.aliases ?? [])]) {
        if (!this.byKey.has(idKey(name))) this.byKey.set(idKey(name), d);
        if (!/^PMC\d+$/i.test(name) && idKey(name).length >= 3) names.push({ name, doc: d });
      }
    }
    this.namePatterns = names
      .sort((a, b) => idKey(b.name).length - idKey(a.name).length)
      .map(({ name, doc }) => ({
        re: new RegExp(`(?<![a-z0-9])${[...idKey(name)].join("[-\\s_./]?")}(?![a-z0-9])`, "i"),
        doc,
      }));
  }

  /** By id, ignoring case, spaces and hyphens ("CSR ABC-101" finds "CSR-ABC101"), or by alias. */
  get(id: string): Document | undefined {
    return this.byId.get(id.trim().toUpperCase()) ?? this.byKey.get(idKey(id));
  }

  /** The id of a document the text names, by id or alias. Null when it names none the store knows. */
  matchDocument(text: string): string | null {
    const pmc = text.match(/\bPMC\d+\b/i)?.[0];
    if (pmc && this.get(pmc)) return this.get(pmc)!.id;
    return this.namePatterns.find((p) => p.re.test(text))?.doc.id ?? null;
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
        // "Table 14.2.1" must not fall back to "Table 14", nor "Table 1a" to "Table 1".
        return raw.startsWith(l) && /^[^a-z0-9]/.test(raw.slice(l.length)) && !/^\.\d/.test(raw.slice(l.length));
      })
      .sort((a, b) => b.label.length - a.label.length)[0];
  }
}

/** Keeps dots between digits so "Table 1.4" and "Table 14" stay different. */
const normalizeLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/(\d)\.(?=\d)/g, "$1\u0000")
    .replace(/[^a-z0-9>\u0000]+/g, "")
    .replace(/\u0000/g, ".");
const simplify = (s: string) => s.toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim();

interface PaperRow {
  id: string;
  title: string;
  tables: { label: string; caption: string; rows: string[]; foot: string }[];
}

export function loadStore(dataset: string, variant: CorpusVariant): DocStore {
  const fixtureDocs = join(DATA_DIR, "..", "fixtures", dataset, "docs.jsonl");
  if (existsSync(fixtureDocs)) return new DocStore(readJsonl<Document>(fixtureDocs));
  // pmchard (python/prep_hard.py) cites the same PMC tables.
  if (dataset === "pmchard") dataset = "pmc";
  if (dataset !== "pmc" && dataset !== "pmcrefs") {
    throw new Error(`The document store supports the pmc, pmchard and pmcrefs datasets (got "${dataset}")`);
  }
  if (variant === "full") {
    const path = join(DATA_DIR, "pmc", "docs_full.jsonl");
    if (!existsSync(path)) throw new Error(`${path} is missing; run pnpm prep:docs`);
    return new DocStore(readJsonl<Document>(path));
  }
  if (dataset === "pmcrefs") throw new Error("pmcrefs cites whole papers; run it with --corpus full");
  const papersFile = variant === "pdf" ? "papers_pdf.jsonl" : "papers.jsonl";
  const papers = readJsonl<PaperRow>(join(DATA_DIR, "pmc", papersFile));
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
