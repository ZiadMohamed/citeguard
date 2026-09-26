import { chat, addUsage, ZERO_USAGE } from "../llm.js";
import { missingNumbers } from "../numbers.js";
import { resolveCitation } from "../resolve.js";
import { buildNumberIndex, suggestSources } from "../submission.js";
import type { DocStore } from "../tools/store.js";
import type { CheckResult, Usage } from "../types.js";
import { checkFastPath, type FastPathOptions } from "./resolver.js";

/**
 * Suggested fix for a flagged claim: the smallest rewrite the cited section supports.
 *
 * A fix must not become a new error, so it is only offered after three gates:
 *   1. The model rewrites the claim, told to change as little as possible and to copy numbers
 *      from the source.
 *   2. Code: every informative number in the rewrite must appear in the cited section (the same
 *      check a "supported" verdict gets). A number the model made up is a rejected fix.
 *   3. The checker re-checks the rewrite with the same citation; it must come back "supported".
 *
 * A wrong_target flag gets no rewrite: the fix there is a different citation. Code looks up which
 * sections hold every number in the claim (the number index behind `pnpm scan`), and the checker
 * must accept the claim against the proposed citation before it's offered.
 */
export interface Fix {
  /** The rewritten claim, or null when no fix passed the gates. */
  text: string | null;
  /** For a wrong citation: one the claim checks out against. */
  citation?: string;
  /** Sections holding every number in the claim, when none passed the re-check: for a person to look at. */
  candidates?: string[];
  /** Why no fix is offered, or which gate a candidate failed. */
  note: string;
  usage: Usage;
}

const PROMPT = `You fix one sentence in a regulatory summary so that the cited source supports it.

Rules:
- Change as little as possible. Keep the author's wording, order and style everywhere the source allows it.
- Fix only what the flag reason names. Do not change a number, p-value, label or group that the reason does not mention, even if you would describe it differently.
- Keep the order in which the sentence lists groups, time points and measures. If a value belongs to a different group, correct the value, not the order.
- Every number in your sentence must be copied from the source exactly as written there (you may drop a minus sign when the sentence says "reduced by" or "decreased by").
- Do not add claims, numbers or qualifiers the source does not state. Removing an unsupported part is allowed.
- If the source reports no significant difference, say so; do not describe a numerical difference as a real one.

Reply with only the corrected sentence.`;

export async function suggestFix(
  input: { claim: string; citation: string },
  verdict: CheckResult,
  store: DocStore,
  model: string,
  opts: FastPathOptions = { readingRules: true, cues: true },
): Promise<Fix> {
  if (verdict.verdict === "supported") return { text: null, note: "nothing to fix", usage: ZERO_USAGE };
  const resolved = resolveCitation(store, input.citation);
  if (verdict.verdict === "wrong_target" || resolved.kind !== "section") {
    return fixCitation(input, verdict, store, model, opts);
  }
  // Numbers missing here but all present in another section: the citation is what's wrong.
  // Rewriting the claim to fit the wrong table would make a true sentence false.
  if (missingNumbers(input.claim, resolved.numberText).length) {
    const moved = await fixCitation(input, verdict, store, model, opts);
    if (moved.citation || moved.candidates?.length) return moved;
  }

  // Numbers the source holds. A rewrite may reuse these and the claim's own verified numbers; any
  // other number is invented. (A difference "7.7" for a source "-7.7" is allowed: sign is words.)
  let usage = ZERO_USAGE;
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat({
      model,
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: `Sentence: ${input.claim}\nCitation: ${input.citation}\nWhy it was flagged: ${verdict.reason}\n\n<source>\n${resolved.text}\n</source>${feedback}`,
        },
      ],
      maxTokens: 600,
    });
    usage = addUsage(usage, res.usage);
    const text = (res.message.content ?? "").trim().replace(/^["“]|["”]$/g, "");
    if (!text || text === input.claim) return { text: null, note: "no rewrite offered", usage };

    // Gate 2: numbers come from the source, not the model.
    const invented = missingNumbers(text, resolved.numberText).map((m) => m.number);
    if (invented.length) {
      feedback = `\n\nYour previous rewrite used ${invented.join(", ")}, which the source does not contain. Use only numbers from the source.`;
      continue;
    }
    // Gate 3: the checker must accept the rewrite against the same citation.
    const recheck = await checkFastPath({ claim: text, citation: input.citation }, store, model, undefined, opts);
    if (recheck) usage = addUsage(usage, recheck.usage);
    if (recheck?.result.verdict === "supported") return { text, note: "re-checked: supported", usage };
    feedback = `\n\nYour previous rewrite was checked and rejected: ${recheck?.result.reason ?? "it could not be checked"}. Fix that too.`;
  }
  return { text: null, note: "no rewrite passed the number check and the re-check", usage };
}

/** Word-level diff for display: removed words in [-...-], added words in {+...+}. */
export function wordDiff(before: string, after: string): string {
  const a = before.split(/\s+/).filter(Boolean), b = after.split(/\s+/).filter(Boolean);
  // Longest common subsequence of words; everything else is a change.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let del: string[] = [], add: string[] = [];
  const flush = () => {
    if (del.length) out.push(`[-${del.join(" ")}-]`);
    if (add.length) out.push(`{+${add.join(" ")}+}`);
    del = []; add = [];
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); out.push(a[i]!); i++; j++; }
    else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) add.push(b[j++]!);
    else del.push(a[i++]!);
  }
  flush();
  return out.join(" ");
}

const indexes = new WeakMap<DocStore, ReturnType<typeof buildNumberIndex>>();

/** A wrong citation's fix: a section that holds the claim's numbers and that the checker accepts. */
async function fixCitation(
  input: { claim: string; citation: string },
  verdict: CheckResult,
  store: DocStore,
  model: string,
  opts: FastPathOptions,
): Promise<Fix> {
  let index = indexes.get(store);
  // Only sections with every number in the claim are candidates; the verdict's own suggestion too.
  if (!index) indexes.set(store, (index = buildNumberIndex(store)));
  const own = store.matchDocument(input.citation) ?? undefined;
  const candidates = [
    ...(verdict.suggestedLocation ? [verdict.suggestedLocation] : []),
    ...suggestSources(input.claim, index, own),
  ].filter((c, i, all) => all.indexOf(c) === i && c !== input.citation);
  let usage = ZERO_USAGE;
  for (const citation of candidates.slice(0, 3)) {
    if (resolveCitation(store, citation).kind !== "section") continue;
    const recheck = await checkFastPath({ claim: input.claim, citation }, store, model, undefined, opts);
    if (!recheck) continue;
    usage = addUsage(usage, recheck.usage);
    if (recheck.result.verdict === "supported") return { text: null, citation, note: "re-checked: supported", usage };
  }
  return {
    text: null,
    candidates,
    note: candidates.length
      ? `the claim's numbers are in ${candidates.slice(0, 3).join("; ")}, but the re-check didn't accept it there; check by hand`
      : "no section holds all of the claim's numbers",
    usage,
  };
}
