import type { BenchItem } from "../types.js";

/** A cited or suggested location: a document, and a table when the citation names one. */
export interface Loc {
  doc: string;
  table: string | null;
}

/**
 * Where a claim's data really lives. For wrong_location and nonexistent_target the mutation
 * records the original table; for wrong_study the paper is sourcePaper. Report-cites-report
 * citations name only a document, so the table is null.
 */
export function trueLocation(item: BenchItem): Loc | null {
  if (!item.sourcePaper) return null;
  const moved = item.mutation?.match(/^Table (\d+) ->/)?.[1];
  return { doc: item.sourcePaper, table: moved ?? tableIn(item.citation) };
}

/** Parses free text like "Table 3 of PMC123" or "Smith 2020 (PMC123)". */
export function parseLocation(text: string | null | undefined, defaultDoc: string | null): Loc | null {
  if (!text?.trim()) return null;
  const doc = text.match(/PMC\d+/i)?.[0].toUpperCase() ?? defaultDoc;
  return doc ? { doc, table: tableIn(text) } : null;
}

/** True if `loc` points at `target`; a document-level target only needs the same document. */
export function sameLocation(loc: Loc | null, target: Loc): boolean {
  return !!loc && loc.doc === target.doc && (target.table === null || loc.table === target.table);
}

export const citedDoc = (item: BenchItem) => item.citation.match(/PMC\d+/i)?.[0].toUpperCase() ?? null;

const tableIn = (text: string) => text.match(/Table\s*(\d+)/i)?.[1] ?? null;
