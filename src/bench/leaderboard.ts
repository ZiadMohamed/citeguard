/**
 * Scores saved runs against the current reviewed labels, with no API calls.
 *
 *   pnpm leaderboard [--dataset pmc] [--split sample] [--ref <run-name-substring>] [--min-n 90]
 *
 * One row per run: catch, false alarms, subtle overstatement, first attempt (before retries),
 * cost, latency. With --ref, each row also shows a paired comparison against that run on the
 * items both scored: how many items this run flags that the reference passes, and the reverse.
 * Two runs of one setup differ by about 6 items per 100, so gaps inside that are ties.
 */
import "../cli/errors.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { missingNumbers } from "../numbers.js";
import { resolveCitation } from "../resolve.js";
import { loadStore } from "../tools/store.js";
import type { RunRecord } from "../types.js";
import { applyOverrides, loadDataset, loadOverrides, readJsonl } from "./datasets.js";
import { firstAttemptOnly, summarize } from "./metrics.js";

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string", default: "pmc" },
    split: { type: "string", default: "sample" },
    ref: { type: "string" },
    "min-n": { type: "string", default: "90" },
    filter: { type: "string" },
  },
});

const runsDir = join(import.meta.dirname, "..", "..", "runs");
const prefix = `_${args.dataset}-${args.split}_`;
const overrides = loadOverrides(args.dataset!);

export interface Scored {
  name: string;
  records: RunRecord[];
}

/** Only runs on the current item set count: an older sample with different ids is not comparable. */
const currentIds = new Set(loadDataset(args.dataset!, args.split as "sample" | "full").items.map((i) => i.id));

const runs: Scored[] = readdirSync(runsDir)
  .filter((f) => f.endsWith(".jsonl") && f.includes(prefix))
  .filter((f) => !args.filter || f.includes(args.filter))
  .map((f) => ({ name: f.replace(/\.jsonl$/, ""), records: applyOverrides(readJsonl<RunRecord>(join(runsDir, f)), overrides) }))
  .filter((r) => r.records.length >= Number(args["min-n"]))
  .filter((r) => r.records.every((rec) => currentIds.has(rec.item.id)));

const isFlag = (r: RunRecord) => r.result !== null && r.result.verdict !== "supported";
const pct = (v: number) => (Number.isNaN(v) ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}%`);

/** On items both runs scored: [flags in a but passes in b on bad items, ... on good items, reverse on bad, reverse on good]. */
export function paired(a: RunRecord[], b: RunRecord[]) {
  const byId = new Map(b.filter((r) => r.result).map((r) => [r.item.id, r]));
  const out = { aOnlyBad: 0, aOnlyGood: 0, bOnlyBad: 0, bOnlyGood: 0, shared: 0 };
  for (const ra of a) {
    const rb = byId.get(ra.item.id);
    if (!ra.result || !rb) continue;
    out.shared++;
    const bad = ra.item.label !== "supported";
    if (isFlag(ra) && !isFlag(rb)) bad ? out.aOnlyBad++ : out.aOnlyGood++;
    if (!isFlag(ra) && isFlag(rb)) bad ? out.bOnlyBad++ : out.bOnlyGood++;
  }
  return out;
}

const ref = args.ref ? (runs.find((r) => r.name.endsWith(args.ref!)) ?? runs.find((r) => r.name.includes(args.ref!))) : undefined;
if (args.ref && !ref) throw new Error(`No run matches --ref ${args.ref}`);

/**
 * Items code decides alone (citation missing, or a claim number absent from the cited table).
 * Every run catches those, so model differences only show on the rest: the "model-decided" column.
 */
const codeDecided = (() => {
  try {
    const store = loadStore(args.dataset!, "tables");
    const ids = new Set<string>();
    for (const item of loadDataset(args.dataset!, args.split as "sample" | "full").items) {
      const r = resolveCitation(store, item.citation);
      if (r.kind === "missing" || missingNumbers(item.claim, r.numberText).length) ids.add(item.id);
    }
    return ids;
  } catch {
    return new Set<string>();
  }
})();

function modelDecided(records: RunRecord[]): string {
  const rest = records.filter((r) => r.result && !codeDecided.has(r.item.id));
  const bad = rest.filter((r) => r.item.label !== "supported");
  const good = rest.filter((r) => r.item.label === "supported");
  return `${bad.filter(isFlag).length}/${bad.length} ${good.filter(isFlag).length}/${good.length}`.padStart(11);
}

/** False alarms on good items whose label a person reviewed (pmchard marks them); blank elsewhere. */
function reviewedFalseAlarms(records: RunRecord[]): string {
  const good = records.filter((r) => r.result && r.item.label === "supported" && r.item.reviewed);
  return good.length ? `${good.filter(isFlag).length}/${good.length}`.padStart(6) : "     -";
}

const rows = runs.map((run) => {
  const s = summarize(run.records);
  const hasRetries = run.records.some((r) => (r.trace?.attempts?.length ?? 1) > 1);
  const first = hasRetries ? summarize(firstAttemptOnly(run.records)) : s;
  const subtle = s.flaggedByType["overstated_subtle"];
  const agent = run.name.split("_")[2]!;
  const modelName = run.name.split("_").slice(3).join("/");
  return {
    run,
    s,
    line: [
      modelName.padEnd(34),
      agent.padEnd(18),
      `${String(s.n - s.failed).padStart(3)}/${s.n}`,
      pct(s.catchRate.value),
      pct(s.falseAlarmRate.value),
      reviewedFalseAlarms(run.records),
      subtle ? `${subtle.value * subtle.n}/${subtle.n}`.padStart(5) : "    -",
      modelDecided(run.records),
      `${pct(first.catchRate.value)} /${pct(first.falseAlarmRate.value)}`,
      `$${s.costPerCheckUsd.toFixed(5)}`.padStart(9),
      `${(s.latencyMs.p50 / 1000).toFixed(1)}s / ${(s.latencyMs.p95 / 1000).toFixed(1)}s`.padStart(14),
      ...(ref && ref !== run
        ? [
            (() => {
              const p = paired(run.records, ref.records);
              return `bad +${p.aOnlyBad}/-${p.bOnlyBad}  good +${p.aOnlyGood}/-${p.bOnlyGood}  (n=${p.shared})`;
            })(),
          ]
        : ref === run
          ? ["(reference)"]
          : []),
      run.name.slice(0, 19),
    ].join("  "),
  };
});

rows.sort((a, b) => b.s.catchRate.value - a.s.catchRate.value || a.s.falseAlarmRate.value - b.s.falseAlarmRate.value);
console.log(
  [
    "model".padEnd(34),
    "agent".padEnd(18),
    "  ok",
    "catch ",
    "false a",
    "FA rev",
    "subtl",
    "model: bad good",
    "1st try catch/FA",
    "   $/check",
    "   p50 / p95  ",
    ...(ref ? ["vs ref: flags gained/lost on bad, on good"] : []),
    "run",
  ].join("  "),
);
for (const r of rows) console.log(r.line);
console.log(`FA rev = false alarms on good items a person reviewed (pmchard only; unreviewed originals include real author errors).`);
console.log(`\nlabels: ${overrides.size} reviewed rows applied. Bad items: catch counts them; good items: false alarms.`);
console.log(
  `model: bad good = flags on the ${currentIds.size - codeDecided.size} items code can't decide alone (bad caught, good false-alarmed). Code alone decides ${codeDecided.size}; compare models on this column.`,
);
