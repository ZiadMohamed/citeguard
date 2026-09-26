import { addUsage, ZERO_USAGE } from "../llm.js";
import { missingNumberNote } from "../numbers.js";
import { resolveCitation, type Resolution } from "../resolve.js";
import type { DocStore } from "../tools/store.js";
import { PAGE_CHARS } from "../tools/tools.js";
import type { CheckResult, Usage } from "../types.js";
import { checkBaseline, type CheckInput } from "./baseline.js";

export type Ask = (input: CheckInput, model: string) => Promise<{ result: CheckResult; usage: Usage }>;

export interface FastPathHit {
  result: CheckResult;
  usage: Usage;
  sourceText: string;
  resolution: "section" | "missing";
}

/**
 * Fast path for a citation that names a section.
 *
 * Code resolves the citation. A hit is one model call on that section, plus at most one
 * retry when a "supported" verdict is missing a number from the section. A miss (unknown
 * document, unknown table) is a wrong_target flag with no model call.
 *
 * Returns null when the citation names a whole document, or a section too long to paste.
 * The caller then uses the tool agent, which can search and read page by page.
 */
export async function checkFastPath(
  input: { claim: string; citation: string },
  store: DocStore,
  model: string,
  ask: Ask = checkBaseline,
): Promise<FastPathHit | null> {
  const resolved = resolveCitation(store, input.citation);
  if (resolved.kind === "document") return null;
  if (resolved.kind === "section" && resolved.bodyChars > PAGE_CHARS) return null;
  if (resolved.kind === "missing") {
    return {
      result: {
        verdict: "wrong_target",
        quote: "",
        location: resolved.label,
        reason: resolved.reason,
        suggestedLocation: null,
      },
      usage: ZERO_USAGE,
      sourceText: "",
      resolution: "missing",
    };
  }
  return checkSection(input, resolved, model, ask);
}

async function checkSection(
  input: { claim: string; citation: string },
  resolved: Resolution,
  model: string,
  ask: Ask,
): Promise<FastPathHit> {
  const source = { id: resolved.label, title: resolved.title, text: resolved.text };
  let note: string | undefined;
  let usage = ZERO_USAGE;
  let result: CheckResult | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ask({ claim: input.claim, citation: input.citation, source, note }, model);
    usage = addUsage(usage, out.usage);
    result = out.result;
    if (result.verdict !== "supported") break;
    const gap = missingNumberNote(input.claim, resolved.numberText, resolved.label);
    if (!gap || note) break;
    note = gap;
  }

  return { result: result!, usage, sourceText: resolved.text, resolution: "section" };
}
