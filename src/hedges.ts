/**
 * Overstatement cues: claim wording that asserts more than a statistical source can show.
 *
 * Every model in the benchmark misses the same edits: a hedge or qualifier dropped
 * ("no significant difference" -> "no difference", "suggesting" -> "showing",
 * "nonsignificant trend" -> "trend", "by 3 months" -> "overall"). Code cannot decide these,
 * but it can point at them. A cue is not a verdict: it is a question for the model (and the
 * reviewer) to answer explicitly.
 */
import { comparisonCues } from "./comparisons.js";

export interface Cue {
  code:
    | "absolute_no_difference"
    | "certainty_on_nonsignificant"
    | "unqualified_trend"
    | "scope_dropped"
    | "comparison_nonsignificant"
    | "comparison_direction";
  message: string;
}

const P_VALUE = /\bp\s*(?:[=<>≤≥]|value\s*(?:of|=)?)\s*(0?\.\d+|1(?:\.0+)?)/gi;
const SIGNIFICANT = /\b(?:statistically\s+)?significan\w*/i;
const CERTAIN = /\b(?:show(?:s|ed|ing|n)?|demonstrat\w*|prov\w*|confirm\w*|establish\w*)\b/i;
const HEDGED = /\b(?:suggest\w*|may|might|could|appear\w*|possibl\w*|indicat\w*|trend\w* toward)\b/i;
const TIME_IN_SOURCE = /\b(?:\d+\s*(?:weeks?|months?|days?|years?|hours?|wk|mo)|week\s*\d+|month\s*\d+|day\s*\d+|baseline|follow[- ]?up|post[- ]?(?:test|intervention|op\w*)|pre[- ]?(?:test|intervention|op\w*))\b/gi;
const SCOPE_WORDS = /\b(?:overall|at all time ?points|throughout|across all|in all (?:patients|groups|subgroups)|consistently|always|every)\b/i;

/** p-values written in the text, as numbers. */
function pValues(text: string): number[] {
  return [...text.matchAll(P_VALUE)].map((m) => Number(m[1]!.startsWith(".") ? `0${m[1]}` : m[1]));
}

export function overstatementCues(claim: string, sourceText: string): Cue[] {
  const cues: Cue[] = [];
  const ps = pValues(claim);
  const nonsig = ps.some((p) => p > 0.05);

  // "No differences were observed (P = 0.794)": a non-significant test does not show absence.
  if (/\bno\s+(?:\w+\s+)?differen\w*/i.test(claim) && !/\bno\s+(?:\w+\s+)?significant\s+(?:\w+\s+)?differen/i.test(claim)) {
    cues.push({
      code: "absolute_no_difference",
      message:
        'the claim says there was no difference, not "no significant difference". A non-significant test does not show that groups are the same; decide whether the source supports the absolute wording',
    });
  }

  // "... nonsignificant (p = 0.230), showing parallel improvement": certainty on a non-significant result.
  if (nonsig && CERTAIN.test(claim) && !HEDGED.test(claim)) {
    cues.push({
      code: "certainty_on_nonsignificant",
      message:
        "the claim uses certain wording (shows/demonstrates/confirms) next to a non-significant p-value; decide whether that result can be stated as shown, or only as suggested",
    });
  }

  // "suggesting a favorable trend": a trend claim that no longer says it was not significant.
  if (/\btrend\w*\b/i.test(claim) && !/non-?\s?significant|not\s+(?:statistically\s+)?significant|did not reach/i.test(claim)) {
    const srcP = pValues(sourceText);
    if (!SIGNIFICANT.test(claim) && (srcP.some((p) => p > 0.05) || /\bNS\b|n\.s\./.test(sourceText) || !srcP.length)) {
      cues.push({
        code: "unqualified_trend",
        message:
          'the claim describes a trend without saying it was non-significant; check whether the source shows significance, and whether dropping that qualifier overstates the result',
      });
    }
  }

  // "Overall, this gap increased" when the source reports several time points: the scope may have been widened.
  const times = new Set([...sourceText.matchAll(TIME_IN_SOURCE)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ")));
  const claimTimes = claim.match(TIME_IN_SOURCE);
  if (SCOPE_WORDS.test(claim) && times.size >= 2 && !claimTimes) {
    cues.push({
      code: "scope_dropped",
      message: `the claim generalises ("${claim.match(SCOPE_WORDS)![0]}") but the source reports separate time points (${[...times].slice(0, 4).join(", ")}); check that the claim holds at each one, not just one`,
    });
  }

  cues.push(...comparisonCues(claim, sourceText));
  return cues;
}

/** Retry note for a "supported" verdict on a claim with cues. Null when there are none. */
export function overstatementNote(claim: string, sourceText: string): string | null {
  const cues = overstatementCues(claim, sourceText);
  if (!cues.length) return null;
  return `before accepting "supported", answer these explicitly: ${cues.map((c) => c.message).join("; ")}. Keep "supported" only if the source backs the claim's exact wording`;
}