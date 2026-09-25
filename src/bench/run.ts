import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkBaseline } from "../agents/baseline.js";
import { ZERO_USAGE } from "../llm.js";
import { isQuoteGrounded } from "../quote.js";
import type { BenchItem, RunRecord } from "../types.js";
import { loadDataset, type Dataset } from "./datasets.js";
import { buildReport, formatReport } from "./report.js";

try {
  process.loadEnvFile(join(import.meta.dirname, "..", "..", ".env"));
} catch {}

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string", default: "scifact" },
    split: { type: "string", default: "sample" },
    agent: { type: "string", default: "baseline" },
    model: { type: "string", default: "openai/gpt-6-luna" },
    concurrency: { type: "string", default: "8" },
    limit: { type: "string" },
  },
});

const AGENTS = {
  baseline: async (item: BenchItem, ds: Dataset, model: string) => {
    const source = item.targetId ? (ds.docs.get(item.targetId) ?? null) : null;
    const { result, usage } = await checkBaseline(
      { claim: item.claim, citation: item.citation, source },
      model,
    );
    return { result, usage, sourceText: source ? `${source.title}\n${source.text}` : "" };
  },
};

async function main() {
  const agentName = args.agent as keyof typeof AGENTS;
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent "${args.agent}". Options: ${Object.keys(AGENTS).join(", ")}`);

  const ds = loadDataset(args.dataset!, args.split as "sample" | "full");
  const items = args.limit ? ds.items.slice(0, Number(args.limit)) : ds.items;
  const model = args.model!;

  const runsDir = join(import.meta.dirname, "..", "..", "runs");
  mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runName = `${stamp}_${args.dataset}-${args.split}_${agentName}_${model.replace(/\//g, "_")}`;
  const recordsPath = join(runsDir, `${runName}.jsonl`);

  console.log(`running ${items.length} checks | agent=${agentName} model=${model}`);
  const records: RunRecord[] = [];
  let done = 0;

  await pool(items, Number(args.concurrency), async (item) => {
    const started = Date.now();
    let record: RunRecord;
    try {
      const { result, usage, sourceText } = await agent(item, ds, model);
      record = {
        item, model, agent: agentName, result, usage,
        quoteGrounded: result.quote.trim() ? isQuoteGrounded(result.quote, sourceText) : null,
        latencyMs: Date.now() - started,
      };
    } catch (err: any) {
      record = {
        item, model, agent: agentName, result: null, error: String(err?.message ?? err),
        usage: err?.usage ?? ZERO_USAGE, quoteGrounded: null, latencyMs: Date.now() - started,
      };
    }
    records.push(record);
    appendFileSync(recordsPath, JSON.stringify(record) + "\n");
    done++;
    if (done % 10 === 0 || done === items.length) process.stdout.write(`  ${done}/${items.length}\n`);
  });

  const report = buildReport(records, args.dataset!);
  writeFileSync(
    join(runsDir, `${runName}.summary.json`),
    JSON.stringify({ model, agent: agentName, dataset: args.dataset, split: args.split, ...report }, null, 2),
  );
  console.log(`\n${formatReport(report)}\n\nrecords: ${recordsPath}`);
  const errors = records.filter((r) => r.error).slice(0, 3);
  for (const e of errors) console.log(`  error sample: ${e.error}`);
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
