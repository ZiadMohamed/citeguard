/**
 * Claim and citation extraction from raw summary text, with no model.
 *
 * A citation marker is an explicit pointer: "(Table 2)", "[Study ABC-101, Table 14.2.1]",
 * "Smith et al. 2021 (PMC12345)", "(see Section 5.3)". The claim is the sentence that contains
 * the marker, with the marker removed. When a marker names only a section ("Table 2"), the
 * document is inherited from the nearest earlier marker in the same paragraph, or from the
 * document the text itself belongs to (a paper cites its own tables).
 *
 * Sentences with numbers but no marker are returned as `uncited`. In a submission those are
 * the ones a reviewer asks about ("where does 34% come from?"). Deciding which uncited
 * sentences are claims at all is the step that would need a model; this code does not do it.
 */
import { tablesIn } from "./locations.js";
import { informativeNumbers } from "./numbers.js";

export interface ExtractedClaim {
  claim: string;
  /** Normalized citation the resolver understands: "PMC1, Table 2" or "PMC1". */
  citation: string;
  /** The marker text as written. */
  marker: string;
  sentence: number;
}

export interface Extraction {
  claims: ExtractedClaim[];
  /** Sentences with informative numbers and no citation marker. */
  uncited: { sentence: number; text: string }[];
}

const DOC_ID = String.raw`(?:PMC\d+|[A-Z]{2,}[-\w]*\d[-\w]*)`;
const SECTION = String.raw`(?:Table|Tab\.|Section|Figure|Fig\.|Appendix|Listing)\s*[A-Z]?\d+(?:\.\d+)*[a-z]?`;
/** "(Smith et al. 2021 (PMC123))", "(PMC123, Table 2)", "[CSR ABC-101, Table 14.2.1]", "(Table 2)", "(see Table 2 and 3)" */
const MARKER = new RegExp(
  String.raw`[(\[]\s*(?:see\s+|cf\.\s+)?` +
    String.raw`(?:(?<author>[A-Z][\w'-]+(?:\s+et al\.)?,?\s+\d{4}[a-z]?)\s*[(,;]?\s*)?` +
    String.raw`(?<doc>${DOC_ID})?\s*[),;]?\s*` +
    String.raw`(?<section>${SECTION})?` +
    String.raw`[^)\]]{0,20}[)\]]+`,
  "g",
);

export function splitSentences(text: string): string[] {
  // Split after ., ! or ? followed by space and an uppercase letter or digit, but not after
  // common abbreviations or inside decimals ("p = 0.05", "et al. 2021", "Fig. 2").
  const parts: string[] = [];
  let start = 0;
  const re = /[.!?](?=\s+[A-Z(\[])/g;
  for (let m; (m = re.exec(text)); ) {
    const before = text.slice(Math.max(0, m.index - 6), m.index + 1);
    if (/\b(?:al|Fig|Tab|vs|approx|e\.g|i\.e|No|Ref)\.$/i.test(before)) continue;
    parts.push(text.slice(start, m.index + 1).trim());
    start = m.index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

export function extractClaims(paragraph: string, ownDoc?: string): Extraction {
  const sentences = splitSentences(paragraph);
  const claims: ExtractedClaim[] = [];
  const uncited: Extraction["uncited"] = [];
  let lastDoc = ownDoc;

  sentences.forEach((sentence, idx) => {
    const markers: { text: string; doc?: string; section?: string }[] = [];
    for (const m of sentence.matchAll(MARKER)) {
      if (m.groups?.doc || m.groups?.section) markers.push({ text: m[0], doc: m.groups?.doc, section: m.groups?.section });
    }
    // Parentheticals that list several pointers: "(Table 2, Figure 3A, baseline row)".
    for (const m of sentence.matchAll(/[(\[]([^()\[\]]{0,120})[)\]]/g)) {
      if (markers.some((k) => k.text === m[0])) continue;
      for (const t of m[1]!.matchAll(new RegExp(String.raw`(${DOC_ID})?[,\s]*\b(Tables?\s*\d+(?:\.\d+)*(?:\s*(?:,|and|&|–|-)\s*\d+(?:\.\d+)*)*)`, "g"))) {
        for (const id of tablesIn(t[2]!)) markers.push({ text: m[0], doc: t[1], section: `Table ${id}` });
      }
    }
    // Narrative references: "As shown in Table 2, ...", "Table 1 presents ...", "... summarized in Table 2."
    for (const m of sentence.matchAll(/\bTables?\s+(\d+(?:\.\d+)*)(?:\s*(?:and|&|,)\s*(\d+))?/g)) {
      const inParen = markers.some((k) => k.text.includes(m[0]));
      if (inParen) continue;
      markers.push({ text: "", section: `Table ${m[1]}` });
      if (m[2]) markers.push({ text: "", section: `Table ${m[2]}` });
    }
    if (markers.length === 0) {
      if (informativeNumbers(sentence).length) uncited.push({ sentence: idx, text: sentence });
      return;
    }
    let claim = sentence;
    for (const m of markers) if (m.text) claim = claim.replace(m.text, "");
    claim = claim.replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
    const seen = new Set<string>();
    for (const m of markers) {
      const doc = m.doc ?? lastDoc;
      if (m.doc) lastDoc = m.doc;
      if (!doc) continue;
      const section = m.section?.replace(/\s+/g, " ").replace(/^Tab\./, "Table");
      const citation = section ? `${doc}, ${section}` : doc;
      if (seen.has(citation)) continue;
      seen.add(citation);
      claims.push({ claim, citation, marker: m.text || (section ?? ""), sentence: idx });
    }
  });
  return { claims, uncited };
}
