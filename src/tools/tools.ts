import type { ToolSpec } from "../llm.js";
import type { SearchIndex } from "./search.js";
import { paginate, type DocStore } from "./store.js";

/** ~2k tokens. Anything longer is paginated so the model fetches it on demand instead of losing it. */
export const PAGE_CHARS = 8000;
const DOCS_PER_PAGE = 25;
const MAX_SEARCH_RESULTS = 15;
const SNIPPET_CHARS = 300;

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description: "List the documents in the submission (id and title), optionally filtered by a substring of the id or title.",
      parameters: {
        type: "object",
        properties: { filter: str("Optional substring to match against id or title"), page: int("Page number, default 1") },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_outline",
      description: "Show a document's title and its sections (tables and text sections) with their captions and sizes.",
      parameters: {
        type: "object",
        properties: { doc_id: str("Document id, e.g. PMC12345") },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_section",
      description: `Read one section of a document, e.g. "Table 2". Long sections are split into pages of ~${PAGE_CHARS} characters.`,
      parameters: {
        type: "object",
        properties: {
          doc_id: str("Document id, e.g. PMC12345"),
          section: str('Section label as shown in the outline, e.g. "Table 2"'),
          page: int("Page number, default 1"),
        },
        required: ["doc_id", "section"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Keyword search over table rows and paragraphs. Numbers are matched exactly, so searching for the claim's distinctive numbers is the fastest way to find where data lives. Optionally restrict to one document.",
      parameters: {
        type: "object",
        properties: {
          query: str("Keywords and/or numbers, e.g. \"0.455 hemoglobin\""),
          doc_id: str("Optional: only search this document"),
          limit: int(`Max results, default 8, max ${MAX_SEARCH_RESULTS}`),
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_verdict",
      description: "Submit your final verdict. This ends the check.",
      parameters: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["supported", "not_supported", "wrong_target"] },
          quote: str("Exact text copied verbatim from what you read that the verdict rests on; empty string if nothing relevant"),
          location: str('Where the quote is, e.g. "PMC12345, Table 2"'),
          reason: str("One sentence explaining the verdict"),
          suggestedLocation: str(
            'Only for wrong_target: where the claim\'s data actually is, e.g. "PMC12345, Table 3". Empty if unknown.',
          ),
        },
        required: ["verdict", "quote", "location", "reason"],
      },
    },
  },
];

export interface ToolOutput {
  text: string;
  error: boolean;
}

/** Executes tool calls for one check. Collects everything the agent read, for quote grounding. */
export class ToolBox {
  readonly evidence: string[] = [];

  constructor(
    private store: DocStore,
    private index: SearchIndex,
  ) {}

  run(name: string, args: Record<string, unknown>): ToolOutput {
    switch (name) {
      case "list_documents":
        return this.listDocuments(optStr(args.filter), optInt(args.page) ?? 1);
      case "get_outline":
        return this.getOutline(String(args.doc_id ?? ""));
      case "read_section":
        return this.readSection(String(args.doc_id ?? ""), String(args.section ?? ""), optInt(args.page) ?? 1);
      case "search":
        return this.search(String(args.query ?? ""), optStr(args.doc_id), optInt(args.limit) ?? 8);
      default:
        return fail(`Unknown tool "${name}".`);
    }
  }

  private listDocuments(filter: string | undefined, page: number): ToolOutput {
    const f = filter?.toLowerCase();
    const docs = f
      ? this.store.docs.filter((d) => d.id.toLowerCase().includes(f) || d.title.toLowerCase().includes(f))
      : this.store.docs;
    if (docs.length === 0) return fail(`No documents match "${filter}".`);
    const pages = Math.ceil(docs.length / DOCS_PER_PAGE);
    const p = clamp(page, 1, pages);
    const slice = docs.slice((p - 1) * DOCS_PER_PAGE, p * DOCS_PER_PAGE);
    return ok(
      [
        `${docs.length} documents (page ${p} of ${pages}):`,
        ...slice.map((d) => `- ${d.id}${d.kind ? ` [${d.kind}]` : ""}: ${d.title} (${d.sections.length} sections)`),
      ].join("\n"),
    );
  }

  private getOutline(docId: string): ToolOutput {
    const doc = this.store.get(docId);
    if (!doc) return fail(`No document with id "${docId}". Use list_documents or search to find documents.`);
    const lines = doc.sections.map((s) => {
      const pages = Math.ceil(s.text.length / PAGE_CHARS);
      const caption = s.kind === "table" && s.heading ? ` (caption: ${s.heading})` : "";
      return `- "${s.label}"${caption} [${s.text.length} chars${pages > 1 ? `, ${pages} pages` : ""}]`;
    });
    this.evidence.push(doc.title, ...doc.sections.map((s) => `${s.label}: ${s.heading}`));
    return ok(
      capped(
        [`${doc.id}: ${doc.title}`, `Sections (${doc.sections.length}; pass the quoted label to read_section):`, ...lines].join(
          "\n",
        ),
      ),
    );
  }

  private readSection(docId: string, label: string, page: number): ToolOutput {
    const doc = this.store.get(docId);
    if (!doc) return fail(`No document with id "${docId}". Use list_documents or search to find documents.`);
    const section = this.store.findSection(doc, label);
    if (!section) {
      return fail(
        `${doc.id} has no section "${label}". Available: ${doc.sections.map((s) => s.label).join(", ")}.`,
      );
    }
    const pages = paginate(section.text, PAGE_CHARS);
    const p = clamp(page, 1, pages.length);
    const header = `${doc.id}, ${section.label}: ${section.heading}`;
    const pageNote =
      pages.length === 1
        ? ""
        : `\n[page ${p} of ${pages.length}${p < pages.length ? `; call again with page=${p + 1} for more` : ""}]`;
    const text = `${header}${pageNote}\n\n${pages[p - 1]!}`;
    this.evidence.push(text);
    return ok(text);
  }

  private search(query: string, docId: string | undefined, limit: number): ToolOutput {
    if (!query.trim()) return fail("Empty query.");
    if (docId && !this.store.get(docId)) return fail(`No document with id "${docId}".`);
    const hits = this.index.search(query, { docId, limit: clamp(limit, 1, MAX_SEARCH_RESULTS) });
    if (hits.length === 0) return ok(`No results for "${query}"${docId ? ` in ${docId}` : ""}.`);
    const lines = hits.map((h, i) => {
      const shown = h.text.slice(0, SNIPPET_CHARS);
      this.evidence.push(shown);
      return `${i + 1}. ${h.docId}, ${h.section}: ${shown}${h.text.length > SNIPPET_CHARS ? "…" : ""}`;
    });
    return ok(capped([`${hits.length} results for "${query}"${docId ? ` in ${docId}` : ""}:`, ...lines].join("\n")));
  }
}

const ok = (text: string): ToolOutput => ({ text, error: false });
const fail = (text: string): ToolOutput => ({ text, error: true });
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const capped = (s: string) => (s.length > PAGE_CHARS ? `${s.slice(0, PAGE_CHARS)}\n[truncated]` : s);
const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const optInt = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};
