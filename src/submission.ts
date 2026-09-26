/**
 * Submission-level pass: one scan over every summary paragraph, instead of one claim at a time.
 *
 *   - Extracts cited claims (src/extract.ts) and resolves each citation in code.
 *   - Lists sentences with numbers but no citation, and for each one suggests the sections that
 *     contain all of its informative numbers, from a number index over the whole store.
 *   - Reports citations that don't resolve, and citations whose lookup fell back to a whole document.
 *
 * No model calls. The output is the reviewer's queue before any claim is checked by a model:
 * "34.2% has no citation; it appears in CSR-ABC101, Table 14.2.1".
 */
import { extractClaims, type ExtractedClaim } from "./extract.js";
import { informativeNumbers, numbersIn } from "./numbers.js";
import { resolveCitation } from "./resolve.js";
import type { DocStore } from "./tools/store.js";

export interface Paragraph {
  /** The document the paragraph belongs to, so "(Table 2)" resolves against it. */
  doc?: string;
  text: string;
}

export interface SubmissionScan {
  claims: (ExtractedClaim & { paragraph: number; resolution: "section" | "document" | "missing"; problem?: string })[];
  uncited: { paragraph: number; text: string; numbers: string[]; suggestions: string[] }[];
}

/** number (normalised) -> sections containing it, as "DOC, Label". */
export function buildNumberIndex(store: DocStore): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of store.docs) {
    for (const s of doc.sections) {
      const where = `${doc.id}, ${s.label}`;
      for (const n of numbersIn(`${s.heading}\n${s.text}`)) {
        const key = n.norm.replace(/^-/, "");
        let set = index.get(key);
        if (!set) index.set(key, (set = new Set()));
        set.add(where);
      }
    }
  }
  return index;
}

/**
 * Sections holding every informative number of the sentence (exact match after normalising).
 * Prefers the paragraph's own document. Empty when no section has them all, or more than
 * `maxSuggestions` do (the numbers are too common to point anywhere).
 */
export function suggestSources(sentence: string, index: Map<string, Set<string>>, ownDoc?: string, maxSuggestions = 3): string[] {
  const nums = informativeNumbers(sentence).map((n) => n.norm.replace(/^-/, ""));
  if (!nums.length) return [];
  let common: string[] | undefined;
  for (const n of nums) {
    const where = index.get(n) ?? new Set<string>();
    common = common ? common.filter((w) => where.has(w)) : [...where];
    if (!common.length) return [];
  }
  const all = common ?? [];
  const own = ownDoc ? all.filter((w) => w.startsWith(`${ownDoc},`)) : [];
  // One number matching another document's table is usually coincidence; ask for two.
  const pick = own.length ? own : nums.length >= 2 ? all : [];
  return pick.length <= maxSuggestions ? pick.sort() : [];
}

export function scanSubmission(paragraphs: Paragraph[], store: DocStore): SubmissionScan {
  const index = buildNumberIndex(store);
  const scan: SubmissionScan = { claims: [], uncited: [] };
  paragraphs.forEach((p, i) => {
    const out = extractClaims(p.text, p.doc);
    for (const extracted of out.claims) {
      // The extractor's id regex sees "ABC-101" in "Study ABC-101"; the store knows the real id.
      const known = extracted.marker ? store.matchDocument(extracted.marker) : null;
      const c = known ? { ...extracted, citation: extracted.citation.replace(/^[^,]+/, known) } : extracted;
      const r = resolveCitation(store, c.citation);
      scan.claims.push({ ...c, paragraph: i, resolution: r.kind, ...((r.reason || r.warning) && { problem: r.reason || r.warning }) });
    }
    for (const u of out.uncited) {
      scan.uncited.push({
        paragraph: i,
        text: u.text,
        numbers: informativeNumbers(u.text).map((n) => n.raw),
        suggestions: suggestSources(u.text, index, p.doc),
      });
    }
  });
  return scan;
}
