import { parseLocation, sameLocation, type Loc } from "../bench/locations.js";
import { isQuoteGrounded, ungroundedFragments } from "../quote.js";
import type { DocStore } from "../tools/store.js";
import type { AgentTrace, Attempt, CheckResult } from "../types.js";

/**
 * Failures we can detect in code without knowing the answer. Anything returned here
 * triggers a fresh-context retry.
 */
export function objectiveFailures(
  out: { result: CheckResult; sourceText: string; trace: AgentTrace },
  citation: string,
  store: DocStore,
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

  const cited = parseLocation(citation, null);
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
  return failures;
}

function locationExists(loc: Loc, store: DocStore): boolean {
  const doc = store.get(loc.doc);
  return !!doc && (loc.table === null || !!store.findSection(doc, `Table ${loc.table}`));
}
