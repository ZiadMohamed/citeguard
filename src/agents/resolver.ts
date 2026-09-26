import { addUsage, ZERO_USAGE } from "../llm.js";
import { overstatementNote } from "../hedges.js";
import { missingNumberNote, signConflicts } from "../numbers.js";
import { resolveCitation, type Resolution } from "../resolve.js";
import type { DocStore } from "../tools/store.js";
import { PAGE_CHARS, type ToolBox } from "../tools/tools.js";
import type { AgentTrace, CheckResult, Usage } from "../types.js";
import { checkBaseline, type CheckInput } from "./baseline.js";
import { checkWithRetries } from "./tool-agent.js";

export type Ask = (input: CheckInput, model: string) => Promise<{ result: CheckResult; usage: Usage }>;

export interface FastPathOptions {
  /** Prompt v2 (reading conventions + confidence). */
  readingRules?: boolean;
  reasoning?: "low" | "medium" | "high";
  /** Sign-direction and overstatement cues in the retry note (src/hedges.ts). */
  cues?: boolean;
}

export interface FastPathHit {
  result: CheckResult;
  usage: Usage;
  sourceText: string;
  resolution: "section" | "missing";
  /**
   * The retry note code sent after a first "supported" verdict: missing numbers, a sign
   * conflict, or (with `cues`) overstatement wording. Named `cues` in run records.
   */
  cues?: string;
  /** The citation named something the store lacks, so a weaker check ran (see Resolution.warning). */
  warning?: string;
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
  opts: FastPathOptions = {},
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
  return checkSection(input, resolved, model, ask, opts);
}

async function checkSection(
  input: { claim: string; citation: string },
  resolved: Resolution,
  model: string,
  ask: Ask,
  opts: FastPathOptions,
): Promise<FastPathHit> {
  const source = { id: resolved.label, title: resolved.title, text: resolved.text };
  let note: string | undefined;
  let cues: string | undefined;
  let usage = ZERO_USAGE;
  let result: CheckResult | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ask(
      { claim: input.claim, citation: input.citation, source, note, readingRules: opts.readingRules, reasoning: opts.reasoning },
      model,
    );
    usage = addUsage(usage, out.usage);
    result = out.result;
    if (result.verdict !== "supported" || note) break;
    const gap = supportedVerdictNote(input.claim, resolved, opts);
    if (!gap) break;
    note = gap;
    cues = gap;
  }

  return { result: result!, usage, sourceText: resolved.text, resolution: "section", ...(cues && { cues }), ...(resolved.warning && { warning: resolved.warning }) };
}

/**
 * Everything code can see that a "supported" verdict must answer for, as one retry note:
 * numbers missing from the source, a sign that contradicts it, and (with `cues`) wording that
 * asserts more than the statistics show. Null when there's nothing to ask.
 */
export function supportedVerdictNote(claim: string, resolved: Resolution, opts: FastPathOptions = {}): string | null {
  const notes: string[] = [];
  const gap = missingNumberNote(claim, resolved.numberText, resolved.label);
  if (gap) notes.push(gap);
  if (opts.cues) {
    const signs = signConflicts(claim, resolved.numberText);
    if (signs.length) {
      notes.push(
        `the claim's direction contradicts the source's sign for ${signs.map((s) => `${s.number} (claim: ${s.claimDirection}; source: ${s.source})`).join(", ")}. Check how the source defines the change (e.g. pre minus post) before accepting`,
      );
    }
    const cue = overstatementNote(claim, resolved.numberText);
    if (cue) notes.push(cue);
  }
  return notes.length ? notes.join(". Also, ") : null;
}

/** One citation check, whichever path it took. */
export interface CitationCheck {
  result: CheckResult;
  usage: Usage;
  /** Text the quote must be found in. */
  sourceText: string;
  resolution: "section" | "missing" | "search";
  trace?: AgentTrace;
  cues?: string;
  warning?: string;
}

/**
 * The checker's front door: the fast path when the citation names a section that fits on one
 * page, otherwise the tool agent (search and paged reading) with fresh-context retries.
 */
export async function checkCitation(
  input: { claim: string; citation: string },
  store: DocStore,
  newToolbox: () => ToolBox,
  model: string,
  opts: FastPathOptions = {},
  retries = 2,
): Promise<CitationCheck> {
  const hit = await checkFastPath(input, store, model, checkBaseline, opts);
  if (hit) return hit;
  const searched = await checkWithRetries(input, newToolbox, store, model, retries);
  return { ...searched, resolution: "search" };
}
