import { chat, addUsage, ZERO_USAGE, type Message } from "../llm.js";
import { parseCheckResult } from "../parse.js";
import type { DocStore } from "../tools/store.js";
import { TOOL_SPECS, type ToolBox } from "../tools/tools.js";
import { CheckResultSchema, type AgentTrace, type Attempt, type CheckResult, type Usage } from "../types.js";
import { objectiveFailures } from "./checks.js";
import { VERDICT_RULES } from "./prompts.js";

export const DEFAULT_BUDGET = 12;
export const MAX_RETRIES = 2;

const systemPrompt = (budget: number) => `You are a meticulous regulatory reviewer checking citations in a drug application submitted to the FDA.
You are given one claim and the citation attached to it. The cited documents are in a document store that you explore with tools. Find the cited location yourself, read it, and decide whether it supports the claim.

How to work:
- A citation names a document and sometimes a section: "PMC12345, Table 2" or "Smith et al. 2021 (PMC12345)". If it names a section, read that section directly with read_section. If it names only a document, find the evidence inside it: search with doc_id set (the claim's distinctive numbers work best), or use get_outline and read the relevant section.
- Judge the claim against the cited location only: the named section, or the named document when no section is given. If the claim's data exists somewhere else but not at the cited location, the citation is still wrong.
- If your verdict is wrong_target, search without doc_id to find where the claim's data actually is, and put it in suggestedLocation, e.g. "PMC12345, Table 3" or "PMC67890". Leave it empty if you can't find it.
- You have a budget of ${budget} tool calls. Most checks need 1 to 4.
- Finish by calling submit_verdict. The quote must be copied verbatim from text you read with the tools.

${VERDICT_RULES}`;

const COULD_NOT_VERIFY: CheckResult = {
  verdict: "not_supported",
  quote: "",
  location: "",
  reason: "Could not verify within the tool budget.",
};

export interface ToolAgentOutput {
  result: CheckResult;
  usage: Usage;
  /** Everything the agent read, for quote grounding. */
  sourceText: string;
  trace: AgentTrace;
}

/**
 * The model gets only the claim and citation text and must find the source itself.
 * Fresh context per check; running out of budget is a flag ("could not verify"), never a pass.
 */
export async function checkWithTools(
  input: { claim: string; citation: string },
  toolbox: ToolBox,
  model: string,
  budget = DEFAULT_BUDGET,
  /** Why a previous attempt was rejected, so a fresh attempt doesn't repeat the mistake. */
  retryNote?: string,
): Promise<ToolAgentOutput> {
  const note = retryNote ? `\n\nA previous attempt at this check was rejected because ${retryNote}.` : "";
  const messages: Message[] = [
    { role: "system", content: systemPrompt(budget) },
    { role: "user", content: `Claim: ${input.claim}\nCitation: ${input.citation}${note}` },
  ];
  const trace: AgentTrace = { steps: [], toolCalls: 0, llmTurns: 0, budgetExhausted: false, peakPromptTokens: 0 };
  let usage = ZERO_USAGE;
  const finish = (result: CheckResult) => ({ result, usage, sourceText: toolbox.evidence.join("\n"), trace });

  try {
    while (true) {
      if (trace.toolCalls >= budget) {
        trace.budgetExhausted = true;
        return finish(COULD_NOT_VERIFY);
      }
      const res = await chat({ model, messages, tools: TOOL_SPECS, toolChoice: "required" });
      usage = addUsage(usage, res.usage);
      trace.llmTurns++;
      trace.peakPromptTokens = Math.max(trace.peakPromptTokens, res.usage.promptTokens);
      messages.push(res.message);

      const calls = res.message.tool_calls ?? [];
      if (calls.length === 0) {
        try {
          return finish(parseCheckResult(res.message.content ?? ""));
        } catch {
          trace.toolCalls++;
          messages.push({ role: "user", content: "Use the tools to check the citation, then call submit_verdict." });
          continue;
        }
      }

      let verdict: CheckResult | null = null;
      for (const call of calls) {
        const name = call.function.name;
        const args = parseArgs(call.function.arguments);
        if (name === "submit_verdict") {
          const parsed = CheckResultSchema.safeParse(args);
          if (parsed.success) {
            verdict = parsed.data;
            messages.push({ role: "tool", tool_call_id: call.id, content: "Verdict recorded." });
          } else {
            trace.toolCalls++;
            trace.steps.push({ tool: name, args: args ?? {}, outputChars: 0, error: true });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Invalid verdict: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
          }
          continue;
        }
        if (trace.toolCalls >= budget) {
          messages.push({ role: "tool", tool_call_id: call.id, content: "Tool budget exhausted." });
          continue;
        }
        trace.toolCalls++;
        const out = args
          ? toolbox.run(name, args)
          : { text: `Could not parse arguments as JSON: ${call.function.arguments.slice(0, 200)}`, error: true };
        trace.steps.push({ tool: name, args: args ?? {}, outputChars: out.text.length, ...(out.error && { error: true }) });
        messages.push({ role: "tool", tool_call_id: call.id, content: out.text });
      }
      if (verdict) return finish(verdict);
    }
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { usage, trace });
  }
}

/**
 * Runs the tool agent; on an objective failure (see checks.ts) starts over with a fresh
 * context, up to MAX_RETRIES times. The first attempt that passes every check wins. If none
 * does, the last attempt stands, except that an unverifiable "supported" becomes a flag.
 */
export async function checkWithRetries(
  input: { claim: string; citation: string },
  newToolbox: () => ToolBox,
  store: DocStore,
  model: string,
  maxRetries = MAX_RETRIES,
): Promise<ToolAgentOutput> {
  const attempts: Attempt[] = [];
  const total: AgentTrace = { steps: [], toolCalls: 0, llmTurns: 0, budgetExhausted: false, peakPromptTokens: 0 };
  let usage = ZERO_USAGE;
  let retryNote: string | undefined;

  for (let i = 0; ; i++) {
    let out: ToolAgentOutput;
    try {
      out = await checkWithTools(input, newToolbox(), model, DEFAULT_BUDGET, retryNote);
    } catch (err: any) {
      if (err?.usage) err.usage = addUsage(usage, err.usage);
      throw err;
    }
    usage = addUsage(usage, out.usage);
    total.steps.push(...out.trace.steps.map((s) => ({ ...s, attempt: i })));
    total.toolCalls += out.trace.toolCalls;
    total.llmTurns += out.trace.llmTurns;
    total.peakPromptTokens = Math.max(total.peakPromptTokens, out.trace.peakPromptTokens);
    total.budgetExhausted = out.trace.budgetExhausted;

    const failures = objectiveFailures(out, input.citation, store);
    attempts.push({ result: out.result, failures });
    const trace = { ...total, attempts };
    if (failures.length === 0) return { ...out, usage, trace };
    const why = failures.map((f) => f.message).join("; ");
    if (i >= maxRetries) {
      const result =
        out.result.verdict === "supported" ? { ...COULD_NOT_VERIFY, reason: `Could not verify: ${why}.` } : out.result;
      return { ...out, result, usage, trace };
    }
    retryNote = why;
  }
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
