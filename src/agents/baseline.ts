import { chat, addUsage, ZERO_USAGE } from "../llm.js";
import { parseCheckResult } from "../parse.js";
import type { CheckResult, SourceDoc, Usage } from "../types.js";
import { OUTPUT_FORMAT, OUTPUT_FORMAT_V2, READING_RULES, VERDICT_RULES } from "./prompts.js";

const system = (readingRules: boolean) => `You are a meticulous regulatory reviewer checking citations in a drug application submitted to the FDA.
You are given one claim, the citation attached to it, and the text of the cited source.
Decide whether the cited source supports the claim.

${VERDICT_RULES}
${readingRules ? `\n${READING_RULES}\n` : ""}
${readingRules ? OUTPUT_FORMAT_V2 : OUTPUT_FORMAT}`;

export interface CheckInput {
  claim: string;
  citation: string;
  /** null when the citation doesn't resolve to any document. */
  source: SourceDoc | null;
  /** Set when a previous attempt failed an objective check, such as a missing number. */
  note?: string;
  /** Prompt v2: add READING_RULES (p = 0.00, evaluative words). Off reproduces the v1 runs. */
  readingRules?: boolean;
  /** OpenRouter reasoning effort, for models that support it. */
  reasoning?: "low" | "medium" | "high";
}

/** No tools, one call: the runner hands the model the already-resolved cited text. */
export async function checkBaseline(
  input: CheckInput,
  model: string,
): Promise<{ result: CheckResult; usage: Usage }> {
  const sourceBlock = input.source
    ? `Title: ${input.source.title}\n\n${input.source.text}`
    : "(The citation does not resolve to any document in the submission.)";

  const messages = [
    { role: "system" as const, content: system(input.readingRules ?? false) },
    {
      role: "user" as const,
      content: `Claim: ${input.claim}\nCitation: ${input.citation}\n\n<source>\n${sourceBlock}\n</source>${
        input.note ? `\n\nA previous attempt at this check was rejected because ${input.note}.` : ""
      }`,
    },
  ];

  let usage = ZERO_USAGE;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat({ model, messages, reasoning: input.reasoning });
    usage = addUsage(usage, res.usage);
    try {
      return { result: parseCheckResult(res.message.content ?? ""), usage };
    } catch (err) {
      lastError = err;
    }
  }
  throw Object.assign(new Error(`Unparseable reply: ${String(lastError)}`), { usage });
}
