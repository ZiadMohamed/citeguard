import { VERDICTS, type RunRecord, type Verdict } from "../types.js";
import { citedDoc, parseLocation, sameLocation, trueLocation } from "../locations.js";

export interface Rate {
  value: number;
  n: number;
  /** 95% Wilson confidence interval: the range the true rate plausibly lies in given our sample size. */
  ci: [number, number];
}

export interface Summary {
  n: number;
  failed: number;
  /** % of real problems the agent flagged. Misses here are what reach the FDA. */
  catchRate: Rate;
  /** % of good citations the agent wrongly flagged. Drives reviewer fatigue. */
  falseAlarmRate: Rate;
  /** Of everything flagged, % that were real problems. */
  flagPrecision: Rate;
  /** Exact 3-way verdict match. */
  verdictAccuracy: Rate;
  /** % of returned quotes that actually appear in the source. */
  quoteGrounded: Rate;
  /** Per ground-truth category: % of items that got a "problem" flag. */
  flaggedByType: Record<string, Rate>;
  /** confusion[label][predicted] = count */
  confusion: Record<Verdict, Record<Verdict, number>>;
  costPerCheckUsd: number;
  totalCostUsd: number;
  latencyMs: { p50: number; p95: number };
  avgPromptTokens: number;
  /** On wrong-target items: % where the agent named the location the claim really comes from. */
  locationSuggestion?: Rate;
  /** Tool-using agents only. */
  agent?: AgentStats;
}

export interface AgentStats {
  avgToolCalls: number;
  p95ToolCalls: number;
  maxToolCalls: number;
  budgetExhausted: number;
  /** Largest single prompt per check: how big the context got. */
  avgPeakPromptTokens: number;
  maxPeakPromptTokens: number;
  /** Average calls per check, by tool. */
  toolUse: Record<string, number>;
  /** Checks that ran the tool loop. The averages above are over these, not over lookup-only checks. */
  checksWithTools: number;
  checks: number;
  /** Checks that needed at least one fresh-context retry. */
  retried: number;
  /** Checks whose final attempt still failed an objective check. */
  unresolved: number;
  /** Checks where a retry turned a flag into a pass, or a pass into a flag. */
  retryFlips: { flagToPass: number; passToFlag: number };
  /** How often each objective check fired, over all attempts. */
  failures: Record<string, number>;
}

const isFlag = (v: Verdict) => v !== "supported";

export function summarize(records: RunRecord[]): Summary {
  const ok = records.filter((r) => r.result !== null);
  let tp = 0, fn = 0, fp = 0, tn = 0, exact = 0, grounded = 0, withQuote = 0;
  const confusion = Object.fromEntries(
    VERDICTS.map((l) => [l, Object.fromEntries(VERDICTS.map((p) => [p, 0]))]),
  ) as Summary["confusion"];
  const byType: Record<string, { flagged: number; n: number }> = {};

  for (const r of ok) {
    const predicted = r.result!.verdict;
    const label = r.item.label;
    confusion[label][predicted]++;
    if (predicted === label) exact++;
    if (isFlag(label)) isFlag(predicted) ? tp++ : fn++;
    else isFlag(predicted) ? fp++ : tn++;

    const t = (byType[r.item.errorType] ??= { flagged: 0, n: 0 });
    t.n++;
    if (isFlag(predicted)) t.flagged++;

    if (r.quoteGrounded !== null) {
      withQuote++;
      if (r.quoteGrounded) grounded++;
    }
  }

  const latencies = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalCost = records.reduce((s, r) => s + r.usage.costUsd, 0);

  return {
    n: records.length,
    failed: records.length - ok.length,
    catchRate: rate(tp, tp + fn),
    falseAlarmRate: rate(fp, fp + tn),
    flagPrecision: rate(tp, tp + fp),
    verdictAccuracy: rate(exact, ok.length),
    quoteGrounded: rate(grounded, withQuote),
    flaggedByType: Object.fromEntries(
      Object.entries(byType)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, rate(v.flagged, v.n)]),
    ),
    confusion,
    costPerCheckUsd: records.length ? totalCost / records.length : 0,
    totalCostUsd: totalCost,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    avgPromptTokens: records.length
      ? records.reduce((s, r) => s + r.usage.promptTokens, 0) / records.length
      : 0,
    ...locationSuggestion(ok),
    ...agentStats(records),
  };
}

function locationSuggestion(records: RunRecord[]): Pick<Summary, "locationSuggestion"> {
  const scored = records.filter((r) => r.item.label === "wrong_target" && trueLocation(r.item));
  if (!records.some((r) => r.trace) || scored.length === 0) return {};
  const right = scored.filter((r) =>
    sameLocation(parseLocation(r.result!.suggestedLocation, citedDoc(r.item)), trueLocation(r.item)!),
  ).length;
  return { locationSuggestion: rate(right, scored.length) };
}

function agentStats(records: RunRecord[]): Pick<Summary, "agent"> {
  const traced = records.flatMap((r) => (r.trace ? [r.trace] : []));
  if (traced.length === 0) return {};
  const calls = traced.map((t) => t.toolCalls).sort((a, b) => a - b);
  const peaks = traced.map((t) => t.peakPromptTokens);
  const toolUse: Record<string, number> = {};
  for (const t of traced) for (const s of t.steps) toolUse[s.tool] = (toolUse[s.tool] ?? 0) + 1 / traced.length;
  const failures: Record<string, number> = {};
  const retryFlips = { flagToPass: 0, passToFlag: 0 };
  for (const r of records) {
    const attempts = r.trace?.attempts ?? [];
    for (const a of attempts) for (const f of a.failures) failures[f.code] = (failures[f.code] ?? 0) + 1;
    if (attempts.length > 1 && r.result) {
      const first = isFlag(attempts[0]!.result.verdict);
      const final = isFlag(r.result.verdict);
      if (first && !final) retryFlips.flagToPass++;
      if (!first && final) retryFlips.passToFlag++;
    }
  }
  return {
    agent: {
      avgToolCalls: calls.reduce((a, b) => a + b, 0) / calls.length,
      p95ToolCalls: percentile(calls, 0.95),
      maxToolCalls: calls[calls.length - 1]!,
      checksWithTools: traced.length,
      checks: records.length,
      budgetExhausted: traced.filter((t) => t.budgetExhausted).length,
      avgPeakPromptTokens: peaks.reduce((a, b) => a + b, 0) / peaks.length,
      maxPeakPromptTokens: Math.max(...peaks),
      toolUse,
      retried: traced.filter((t) => (t.attempts?.length ?? 1) > 1).length,
      unresolved: traced.filter((t) => (t.attempts?.at(-1)?.failures.length ?? 0) > 0).length,
      retryFlips,
      failures,
    },
  };
}

/** The same records scored on each check's first attempt only, i.e. as if there were no retries. */
export function firstAttemptOnly(records: RunRecord[]): RunRecord[] {
  return records.map((r) => {
    const first = r.trace?.attempts?.[0];
    return first && r.trace!.attempts!.length > 1 ? { ...r, result: first.result } : r;
  });
}

export function rate(k: number, n: number): Rate {
  return { value: n ? k / n : NaN, n, ci: wilson(k, n) };
}

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [NaN, NaN];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const pct = (r: Rate) =>
  Number.isNaN(r.value)
    ? "   n/a"
    : `${(r.value * 100).toFixed(1).padStart(5)}%  [${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}%]  n=${r.n}`;

export function formatSummary(s: Summary): string {
  const lines = [
    `checks: ${s.n}  (failed: ${s.failed})`,
    `catch rate        ${pct(s.catchRate)}`,
    `false-alarm rate  ${pct(s.falseAlarmRate)}`,
    `flag precision    ${pct(s.flagPrecision)}`,
    `verdict accuracy  ${pct(s.verdictAccuracy)}`,
    `quote grounded    ${pct(s.quoteGrounded)}`,
    `cost/check  $${s.costPerCheckUsd.toFixed(5)}   total $${s.totalCostUsd.toFixed(4)}`,
    `latency p50 ${(s.latencyMs.p50 / 1000).toFixed(1)}s  p95 ${(s.latencyMs.p95 / 1000).toFixed(1)}s   avg prompt tokens ${Math.round(s.avgPromptTokens)}`,
    ...(s.locationSuggestion ? [`right location suggested (wrong-target items)  ${pct(s.locationSuggestion)}`] : []),
    ...(s.agent
      ? [
          `tool calls avg ${s.agent.avgToolCalls.toFixed(1)}  p95 ${s.agent.p95ToolCalls}  max ${s.agent.maxToolCalls}   on ${s.agent.checksWithTools} of ${s.agent.checks} checks   budget exhausted ${s.agent.budgetExhausted}`,
          `peak context tokens avg ${Math.round(s.agent.avgPeakPromptTokens)}  max ${s.agent.maxPeakPromptTokens}`,
          `tool use per tool check: ${Object.entries(s.agent.toolUse)
            .sort(([, a], [, b]) => b - a)
            .map(([k, v]) => `${k} ${v.toFixed(2)}`)
            .join(", ")}`,
          `retried ${s.agent.retried}  unresolved ${s.agent.unresolved}  flips: flag->pass ${s.agent.retryFlips.flagToPass}, pass->flag ${s.agent.retryFlips.passToFlag}   check failures: ${
            Object.entries(s.agent.failures)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ") || "none"
          }`,
        ]
      : []),
    ``,
    `flagged as problem, by ground-truth type:`,
    ...Object.entries(s.flaggedByType).map(([k, r]) => `  ${k.padEnd(18)} ${pct(r)}`),
    ``,
    `confusion (rows = truth, cols = predicted):`,
    `  ${"".padEnd(14)} ${VERDICTS.map((v) => v.padStart(14)).join("")}`,
    ...VERDICTS.map(
      (l) => `  ${l.padEnd(14)} ${VERDICTS.map((p) => String(s.confusion[l][p]).padStart(14)).join("")}`,
    ),
  ];
  return lines.join("\n");
}
