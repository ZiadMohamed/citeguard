import { parseLocation, sameLocation, type Loc } from "../bench/locations.js";
import { missingNumbers } from "../numbers.js";
import { isQuoteGrounded, ungroundedFragments } from "../quote.js";
import type { DocStore } from "../tools/store.js";
import type { AgentTrace, Attempt, CheckResult } from "../types.js";

/**
 * Failures we can detect in code without knowing the answer. Anything returned here
 * triggers a fresh-context retry.
 *
 * number_missing is a heuristic, not proof: derived numbers (differences, percentages computed
 * from counts) trigger it on good claims. Callers run it at most once per check and let a retry
 * that was told about the missing numbers overrule it.
 */
export function objectiveFailures(
  out: { result: CheckResult; sourceText: string; trace: AgentTrace },
  input: { claim: string; citation: string },
  store: DocStore,
  opts: { checkNumbers: boolean } = { checkNumbers: true },
): Attempt["failures"] {
  const { result, sourceText, trace } = out;
  if (trace.budgetExhausted) {
    return [{ code: "budget_exhausted", message: "it ran out of tool calls before submitting a verdict" }];
  }

  const failures: Attempt["failures"] = [];
  const quote = result.quote.trim();
  if (quote && !isQuoteGrounded(quote, sourceText)) {
    const missing = ungroundedFragments(quote, sourceText)[0]?.slice(0, 200) ?? quote.slice(0, 200);
    failures.push({
      code: "ungrounded_quote",
      message: `the quote is not verbatim: "${missing}" does not appear in anything that was read with the tools (copy text exactly, including empty cells; don't merge rows)`,
    });
  }
  if (!quote && result.verdict === "supported") {
    failures.push({ code: "missing_quote", message: "a supported verdict needs a verbatim quote as evidence" });
  }

  const cited = parseLocation(input.citation, null);
  const loc = parseLocation(result.location, cited?.doc ?? null);
  const isCited = !!cited && !!loc && loc.doc === cited.doc && loc.table === cited.table;
  if (loc && !isCited && !locationExists(loc, store)) {
    failures.push({ code: "bad_location", message: `the location "${result.location}" does not exist` });
  }
  if (result.verdict === "supported" && cited && loc && !sameLocation(loc, cited)) {
    failures.push({
      code: "off_target",
      message: `the verdict was "supported" but the evidence came from ${result.location}, not the cited location`,
    });
  }

  if (opts.checkNumbers && result.verdict === "supported" && cited) {
    const source = citedSource(cited, store);
    const missing = source ? missingNumbers(input.claim, source.text) : [];
    if (source && missing.length) {
      const list = missing
        .map((m) => `${m.number}${m.nearest.length ? ` (closest there: ${m.nearest.join(", ")})` : ""}`)
        .join(", ");
      failures.push({
        code: "number_missing",
        message: `the verdict was "supported" but the claim's ${list} ${missing.length > 1 ? "do" : "does"} not appear in ${source.label}. Compare every number in the claim with the source; if a number is legitimately derived from it (e.g. a difference, or a percentage computed from counts), say so in the reason`,
      });
    }
  }
  return failures;
}

function locationExists(loc: Loc, store: DocStore): boolean {
  const doc = store.get(loc.doc);
  return !!doc && (loc.table === null || !!store.findSection(doc, `Table ${loc.table}`));
}

/** The cited table, or the whole document when the citation names no table. */
function citedSource(cited: Loc, store: DocStore): { label: string; text: string } | null {
  const doc = store.get(cited.doc);
  if (!doc) return null;
  if (cited.table === null) {
    return { label: doc.id, text: [doc.title, ...doc.sections.map((s) => `${s.heading}\n${s.text}`)].join("\n") };
  }
  const section = store.findSection(doc, `Table ${cited.table}`);
  return section ? { label: `${doc.id}, ${section.label}`, text: `${section.heading}\n${section.text}` } : null;
}
