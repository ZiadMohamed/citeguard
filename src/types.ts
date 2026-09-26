import { z } from "zod";

export const VERDICTS = ["supported", "not_supported", "wrong_target"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface BenchItem {
  id: string;
  dataset: string;
  claim: string;
  /** The citation as written in the document, e.g. "[doc 123]" or "Study ABC-101, Table 14.2.1". */
  citation: string;
  /** Corpus id the citation resolves to, if it resolves at all. */
  targetId: string | null;
  label: Verdict;
  /** Finer-grained ground-truth category, e.g. SUPPORT / CONTRADICT / value_mismatch. */
  errorType: string;
  goldSentences?: number[];
  /** PMC: the paper the claim really comes from (differs from the cited one for wrong_study). */
  sourcePaper?: string;
  /** PMC: what was changed, e.g. "Table 1 -> Table 2" or "0.455 -> 0.458". */
  mutation?: string | null;
  originalClaim?: string;
}

export interface SourceDoc {
  id: string;
  title: string;
  text: string;
}

export const CheckResultSchema = z.object({
  verdict: z.enum(VERDICTS),
  quote: z.string().describe("Exact text copied from the source that the verdict rests on, or empty"),
  location: z.string().describe("Where in the source the quote is, e.g. sentence number or table id"),
  reason: z.string().describe("One sentence explaining the verdict"),
  suggestedLocation: z
    .string()
    .nullish()
    .describe("For wrong_target: where the claim's data actually is, e.g. 'PMC123, Table 3'"),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface RunRecord {
  item: BenchItem;
  model: string;
  agent: string;
  result: CheckResult | null;
  error?: string;
  /** Whether the returned quote actually appears in the source (catches invented evidence). */
  quoteGrounded: boolean | null;
  usage: Usage;
  latencyMs: number;
  /** Tool-using agents only. */
  trace?: AgentTrace;
}

export interface ToolStep {
  tool: string;
  args: Record<string, unknown>;
  outputChars: number;
  error?: boolean;
  /** 0 for the first attempt, 1+ for fresh-context retries. */
  attempt?: number;
}

export type FailureCode =
  | "budget_exhausted"
  | "ungrounded_quote"
  | "missing_quote"
  | "bad_location"
  | "off_target"
  | "number_missing";

export interface Attempt {
  result: CheckResult;
  /** Objective failures that caused a retry; empty for the accepted attempt. */
  failures: { code: FailureCode; message: string }[];
}

export interface AgentTrace {
  steps: ToolStep[];
  /** Tool calls made, not counting submit_verdict. Summed over attempts. */
  toolCalls: number;
  llmTurns: number;
  /** True when the final attempt ran out of tool calls. */
  budgetExhausted: boolean;
  /** Prompt tokens of the largest single call: how big the context got. */
  peakPromptTokens: number;
  attempts?: Attempt[];
}
