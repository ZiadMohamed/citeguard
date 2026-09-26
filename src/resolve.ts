import { parseLocation, tablesIn, type Loc } from "./locations.js";
import { type Document, type DocStore, type Section } from "./tools/store.js";

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
  /**
   * Set when the citation named something more specific than what was resolved (a figure or
   * listing the store doesn't have), so the check fell back to the whole document. A reviewer
   * should see this: the fallback is a weaker check than the citation asked for.
   */
  warning: string;
}

export function resolveCitation(store: DocStore, citation: string): Resolution {
  const loc = parseLocation(citation, null, (t) => store.matchDocument(t));
  const tables = tablesIn(citation);
  if (loc && tables.length > 1) return resolveTables(store, loc.doc, tables, citation);
  return resolveLocation(store, loc, citation);
}

export function resolveLocation(store: DocStore, loc: Loc | null, fallbackLabel = ""): Resolution {
  if (!loc) return missing(fallbackLabel, "The citation does not name a document.");
  const doc = store.get(loc.doc);
  if (!doc) return missing(fallbackLabel || loc.doc, `${loc.doc} is not in the submission.`);
  if (loc.table !== null) {
    const section = findTable(store, doc, loc.table);
    if (!section) return missing(fallbackLabel || `${doc.id}, Table ${loc.table}`, `${doc.id} has no Table ${loc.table}.`);
    return sectionResolution(doc, section);
  }
  if (loc.section) {
    const section = store.findSection(doc, loc.section);
    if (section) return sectionResolution(doc, section);
    return {
      ...documentResolution(doc),
      warning: `${loc.section} is not in the parsed ${doc.id}; checked against the whole document instead.`,
    };
  }
  return documentResolution(doc);
}

/** "Tables 14.2.1 and 14.2.2": every table must exist; the model sees them together. */
function resolveTables(store: DocStore, docId: string, tables: string[], citation: string): Resolution {
  const doc = store.get(docId);
  if (!doc) return missing(citation, `${docId} is not in the submission.`);
  const found: Section[] = [];
  for (const t of tables) {
    const s = findTable(store, doc, t);
    if (!s) return missing(citation, `${doc.id} has no Table ${t}.`);
    found.push(s);
  }
  return sectionResolution(doc, found);
}

/** "S1" also matches a section labelled "Supplementary Table S1". */
function findTable(store: DocStore, doc: Document, id: string): Section | undefined {
  return (
    store.findSection(doc, `Table ${id}`) ??
    (/^S/i.test(id) ? store.findSection(doc, `Supplementary Table ${id}`) : undefined)
  );
}

/** One or more sections of a document, pasted together. */
function sectionResolution(doc: Document, sections: Section | Section[]): Resolution {
  const found = Array.isArray(sections) ? sections : [sections];
  return {
    kind: "section",
    label: `${doc.id}, ${found.map((s) => s.label).join(" + ")}`,
    text: found.map((s) => sectionPage(doc.id, s)).join("\n\n"),
    numberText: found.map((s) => `${s.heading}\n${s.text}`).join("\n"),
    title: found.map((s) => s.heading || s.label).join("; "),
    bodyChars: found.reduce((n, s) => n + s.text.length, 0),
    reason: "",
    warning: "",
  };
}

function documentResolution(doc: Document): Resolution {
  return {
    kind: "document",
    label: doc.id,
    text: documentText(doc),
    numberText: documentText(doc),
    title: doc.title,
    bodyChars: doc.sections.reduce((n, s) => n + s.text.length, 0),
    reason: "",
    warning: "",
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
  warning: "",
});

/** Same shape as a one-page read_section result, so quotes line up with the tool agent. */
function sectionPage(docId: string, section: Section): string {
  return `${docId}, ${section.label}: ${section.heading}\n\n${section.text}`;
}

function documentText(doc: { title: string; sections: { heading: string; text: string }[] }): string {
  return [doc.title, ...doc.sections.map((s) => `${s.heading}\n${s.text}`)].join("\n");
}
