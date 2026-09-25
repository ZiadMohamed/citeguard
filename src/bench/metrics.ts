import { VERDICTS, type RunRecord, type Verdict } from "../types.js";

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
  };
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
