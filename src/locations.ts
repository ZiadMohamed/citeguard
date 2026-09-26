import type { BenchItem } from "./types.js";

/**
 * A cited or suggested location: a document, plus the table or other section it names.
 * `table` is the table id as written ("2", "14.2.1", "S1", "1a"). `section` is any other named
 * part ("Figure 2", "Listing 16.2.7", "Section 5.3", "Appendix B"). Both are null for a
 * document-level citation.
 */
export interface Loc {
  doc: string;
  table: string | null;
  section?: string;
}

/** Report ids a regex can recognise without a store: PMC ids and submission-style ids (CSR-ABC101, ABC-101). */
const PMC_DOC = /\bPMC\d+\b/i;
const SUBMISSION_DOC = /\b(?:CSR|RPT)[-\s]?[A-Z]*-?\d[\w-]*|\b[A-Z]{2,}-\d[\w-]*/;
const TABLE = /\b(?:Supplementa(?:ry|l)\s+)?Tables?\s*(S?\d+(?:\.\d+)*[a-z]?)\b/i;
const OTHER = /\b(Figure|Fig\.|Listing|Section|Appendix|Module|Annex)\s*([A-Z]?\d+(?:\.\d+)*[a-z]?|[A-Z]\b)/i;

/**
 * Parses free text like "Table 3 of PMC123", "Smith 2020 (PMC123)" or "CSR-ABC101, Table 14.2.1".
 * `knownDocs` (ids and aliases in the store) is tried first, so any id the submission uses is recognised.
 */
export function parseLocation(
  text: string | null | undefined,
  defaultDoc: string | null,
  knownDocs?: (text: string) => string | null,
): Loc | null {
  if (!text?.trim()) return null;
  const doc = knownDocs?.(text) ?? genericDoc(text) ?? defaultDoc;
  if (!doc) return null;
  const loc: Loc = { doc, table: tableIn(text) };
  if (loc.table === null) {
    const other = sectionIn(text);
    if (other) loc.section = other;
  }
  return loc;
}

/** All tables a citation names: "Tables 14.2.1 and 14.2.2", "Tables 2-4", "Table 2, 3". */
export function tablesIn(text: string): string[] {
  const m = text.match(/\bTables?\s*((?:S?\d+(?:\.\d+)*[a-z]?)(?:\s*(?:,|and|&|-|–|to)\s*S?\d+(?:\.\d+)*[a-z]?)*)/i);
  if (!m) return [];
  const out: string[] = [];
  const parts = m[1]!.split(/\s*(?:,|and|&)\s*/i);
  for (const p of parts) {
    const range = p.match(/^(\d+)\s*(?:-|–|to)\s*(\d+)$/);
    if (range && Number(range[2]) - Number(range[1]) < 20) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(String(i));
    } else out.push(...p.split(/\s*(?:-|–|to)\s*/).filter(Boolean));
  }
  return [...new Set(out)];
}

/** True if `loc` points at `target`; a document-level target only needs the same document. */
export function sameLocation(loc: Loc | null, target: Loc): boolean {
  if (!loc || loc.doc !== target.doc) return false;
  if (target.table !== null) return sameId(loc.table, target.table);
  if (target.section) return !!loc.section && norm(loc.section) === norm(target.section);
  return true;
}

/**
 * Where a claim's data really lives. For wrong_location and nonexistent_target the mutation
 * records the original table; for wrong_study the paper is sourcePaper. Report-cites-report
 * citations name only a document, so the table is null.
 */
export function trueLocation(item: BenchItem): Loc | null {
  if (!item.sourcePaper) return null;
  const moved = item.mutation?.match(/^Table (\S+) ->/)?.[1];
  return { doc: item.sourcePaper, table: moved ?? tableIn(item.citation) };
}

export const citedDoc = (item: BenchItem) => genericDoc(item.citation);

function genericDoc(text: string): string | null {
  const m = text.match(PMC_DOC) ?? text.match(SUBMISSION_DOC);
  return m?.[0].replace(/\s+/g, "-").toUpperCase() ?? null;
}

const tableIn = (text: string) => text.match(TABLE)?.[1] ?? null;

function sectionIn(text: string): string | null {
  const m = text.match(OTHER);
  if (!m) return null;
  const kind = m[1]!.toLowerCase().startsWith("fig") ? "Figure" : m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
  return `${kind} ${m[2]}`;
}

const sameId = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "");
