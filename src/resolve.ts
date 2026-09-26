import { parseLocation, type Loc } from "./bench/locations.js";
import { type DocStore, type Section } from "./tools/store.js";

/**
 * Where a citation string points, using only the citation text and the document store.
 * The benchmark's targetId is not consulted: that id is the answer key.
 */
export interface Resolution {
  kind: "section" | "document" | "missing";
  /** "PMC1, Table 2", a document id, or the citation we could not resolve. */
  label: string;
  /** Text shown to the model. Empty when the citation does not resolve. */
  text: string;
  /** Text the number check scans. For a table this is the caption plus the rows. */
  numberText: string;
  title: string;
  /** Section body length. A named section longer than one tool page is not pasted whole. */
  bodyChars: number;
  /** Why a citation failed to resolve. Empty when it resolved. */
  reason: string;
}

export function resolveCitation(store: DocStore, citation: string): Resolution {
  return resolveLocation(store, parseLocation(citation, null), citation);
}

export function resolveLocation(store: DocStore, loc: Loc | null, fallbackLabel = ""): Resolution {
  if (!loc) return missing(fallbackLabel, "The citation does not name a document.");
  const doc = store.get(loc.doc);
  if (!doc) return missing(fallbackLabel || loc.doc, `${loc.doc} is not in the submission.`);
  if (loc.table === null) {
    return {
      kind: "document",
      label: doc.id,
      text: documentText(doc),
      numberText: documentText(doc),
      title: doc.title,
      bodyChars: doc.sections.reduce((n, s) => n + s.text.length, 0),
      reason: "",
    };
  }
  const section = store.findSection(doc, `Table ${loc.table}`);
  if (!section) return missing(fallbackLabel || `${doc.id}, Table ${loc.table}`, `${doc.id} has no Table ${loc.table}.`);
  return {
    kind: "section",
    label: `${doc.id}, ${section.label}`,
    text: sectionPage(doc.id, section),
    numberText: `${section.heading}\n${section.text}`,
    title: section.heading || section.label,
    bodyChars: section.text.length,
    reason: "",
  };
}

const missing = (label: string, reason: string): Resolution => ({
  kind: "missing",
  label,
  text: "",
  numberText: "",
  title: "",
  bodyChars: 0,
  reason,
});

/** Same shape as a one-page read_section result, so quotes line up with the tool agent. */
function sectionPage(docId: string, section: Section): string {
  return `${docId}, ${section.label}: ${section.heading}\n\n${section.text}`;
}

function documentText(doc: { title: string; sections: { heading: string; text: string }[] }): string {
  return [doc.title, ...doc.sections.map((s) => `${s.heading}\n${s.text}`)].join("\n");
}
