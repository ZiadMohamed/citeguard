import { addUsage } from "../llm.js";
import type { DocStore } from "../tools/store.js";
import type { ToolBox } from "../tools/tools.js";
import type { CheckResult } from "../types.js";
import { checkCitation, type CitationCheck, type FastPathOptions } from "./resolver.js";

/**
 * Hybrid checker: code first, a fast model next, a strong model only when it is worth it.
 *
 *   1. Code resolves the citation. A missing document or table is wrong_target, no model call.
 *   2. A fast model makes one call on the resolved section (or runs the tool agent when the
 *      citation names only a document).
 *   3. The strong model re-checks the fast verdicts named in `escalate`, and its verdict is final.
 *      The recommended set is flags + cues: fast models over-flag (the strong model clears
 *      them), and a pass kept after code raised an overstatement cue is where misses hide.
 *
 * A live editor shows the fast verdict immediately and updates it if the strong one differs.
 */
export type Escalate =
  /** Every flag. */
  | "flags"
  /** A pass the fast model kept after code raised an overstatement or sign cue. */
  | "cues"
  /** A pass on a claim with judgment words (measured; superseded by cues). */
  | "judgment"
  /** A pass the fast model itself marked low-confidence (measured; it rarely does). */
  | "lowconf"
  /** Every pass: a second opinion (measured; adds false alarms). */
  | "passes";

export const ESCALATE_OPTIONS: Escalate[] = ["flags", "cues", "judgment", "lowconf", "passes"];

export interface HybridConfig {
  fast: string;
  strong: string;
  escalate: Set<Escalate>;
  opts?: FastPathOptions;
  retries: number;
  /** Called with the fast verdict when it will be re-checked, so a live UI can show it first. */
  onProvisional?: (fast: CitationCheck, reason: string) => void;
}

export type Tier = "code" | "fast" | "strong";

export interface HybridOutput extends CitationCheck {
  /** Which tier produced the final verdict. */
  decidedBy: Tier;
  /** The fast tier's verdict, kept so a run can be scored as fast-only too. */
  fastResult?: CheckResult;
  /** Time until the fast verdict was available (what a live editor shows first). */
  fastLatencyMs: number;
  escalationReason?: string;
}

export async function checkHybrid(
  input: { claim: string; citation: string },
  store: DocStore,
  newToolbox: () => ToolBox,
  cfg: HybridConfig,
): Promise<HybridOutput> {
  const started = Date.now();
  const fast = await checkCitation(input, store, newToolbox, cfg.fast, cfg.opts, cfg.retries);
  const fastLatencyMs = Date.now() - started;
  if (fast.resolution === "missing") return { ...fast, decidedBy: "code", fastLatencyMs };

  // Re-asking the same model only doubles the cost.
  const why = cfg.fast === cfg.strong ? null : escalationReason(fast, cfg.escalate, input.claim);
  if (!why) return { ...fast, decidedBy: "fast", fastResult: fast.result, fastLatencyMs };
  cfg.onProvisional?.(fast, why);

  const strong = await checkCitation(input, store, newToolbox, cfg.strong, cfg.opts, cfg.retries);
  return {
    ...strong,
    usage: addUsage(fast.usage, strong.usage),
    decidedBy: "strong",
    fastResult: fast.result,
    fastLatencyMs,
    escalationReason: why,
  };
}

/**
 * Claim language that asks for judgment rather than a number lookup: significance, direction,
 * comparison, causation, hedging. 77 of 100 benchmark claims contain one, so as a router it
 * barely separates anything; kept for the measured comparison.
 */
export const JUDGMENT_WORDS =
  /\b(significan\w*|no (?:\w+ )?differen\w*|similar\w*|comparable|trend\w*|overall|consistent\w*|superior\w*|inferior\w*|improv\w*|reduc\w*|increas\w*|decreas\w*|higher|lower|greater|better|worse|effective\w*|caus\w*|led to|resulted|demonstrat\w*|show\w*|reveal\w*|indicat\w*|suggest\w*|associated|predict\w*|equivalen\w*|well tolerated|safe\w*)\b/i;

export const needsJudgment = (claim: string) => JUDGMENT_WORDS.test(claim);

/** Why a fast verdict goes to the strong model, or null when the fast verdict stands. */
export function escalationReason(
  fast: { result: CheckResult; cues?: string },
  escalate: Set<Escalate>,
  claim = "",
): string | null {
  if (fast.result.verdict !== "supported") return escalate.has("flags") ? "flag" : null;
  if (escalate.has("passes")) return "pass";
  if (escalate.has("cues") && fast.cues) return "pass despite cues";
  if (escalate.has("judgment") && needsJudgment(claim)) return "judgment claim";
  if (escalate.has("lowconf") && fast.result.confidence === "low") return "low-confidence pass";
  return null;
}
