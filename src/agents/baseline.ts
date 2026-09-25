import { chat, addUsage, ZERO_USAGE } from "../llm.js";
import { parseCheckResult } from "../parse.js";
import type { CheckResult, SourceDoc, Usage } from "../types.js";
import { OUTPUT_FORMAT, VERDICT_RULES } from "./prompts.js";

const SYSTEM = `You are a meticulous regulatory reviewer checking citations in a drug application submitted to the FDA.
You are given one claim, the citation attached to it, and the text of the cited source.
Decide whether the cited source supports the claim.

${VERDICT_RULES}

${OUTPUT_FORMAT}`;

export interface CheckInput {
  claim: string;
  citation: string;
  /** null when the citation doesn't resolve to any document. */
  source: SourceDoc | null;
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
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content: `Claim: ${input.claim}\nCitation: ${input.citation}\n\n<source>\n${sourceBlock}\n</source>`,
    },
  ];

  let usage = ZERO_USAGE;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat({ model, messages });
    usage = addUsage(usage, res.usage);
    try {
      return { result: parseCheckResult(res.message.content ?? ""), usage };
    } catch (err) {
      lastError = err;
    }
  }
  throw Object.assign(new Error(`Unparseable reply: ${String(lastError)}`), { usage });
}
