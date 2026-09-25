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
}
