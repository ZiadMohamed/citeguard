import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkBaseline } from "../agents/baseline.js";
import { checkWithRetries } from "../agents/tool-agent.js";
import { ZERO_USAGE } from "../llm.js";
import { isQuoteGrounded } from "../quote.js";
import { buildChunks, SearchIndex } from "../tools/search.js";
import { loadStore, type CorpusVariant } from "../tools/store.js";
import { ToolBox } from "../tools/tools.js";
import type { AgentTrace, BenchItem, CheckResult, RunRecord, Usage } from "../types.js";
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
    /** Tool agent only: which document store to search. */
    corpus: { type: "string", default: "tables" },
    /** Tool agent only: fresh-context retries after an objective failure. */
    retries: { type: "string", default: "2" },
  },
});

interface AgentOutput {
  result: CheckResult;
  usage: Usage;
  /** Text the quote must be found in. */
  sourceText: string;
  trace?: AgentTrace;
}
type Agent = (item: BenchItem, model: string) => Promise<AgentOutput>;

const AGENTS: Record<string, (ds: Dataset) => Agent> = {
  baseline: (ds) => async (item, model) => {
    const source = item.targetId ? (ds.docs.get(item.targetId) ?? null) : null;
    const { result, usage } = await checkBaseline(
      { claim: item.claim, citation: item.citation, source },
      model,
    );
    return { result, usage, sourceText: source ? `${source.title}\n${source.text}` : "" };
  },
  tool: () => {
    const store = loadStore(args.dataset!, args.corpus as CorpusVariant);
    const index = new SearchIndex(buildChunks(store));
    const retries = Number(args.retries);
    return (item, model) =>
      checkWithRetries(
        { claim: item.claim, citation: item.citation },
        () => new ToolBox(store, index),
        store,
        model,
        retries,
      );
  },
};

async function main() {
  const agentName = args.agent!;
  const makeAgent = AGENTS[agentName];
  if (!makeAgent) throw new Error(`Unknown agent "${args.agent}". Options: ${Object.keys(AGENTS).join(", ")}`);

  const ds = loadDataset(args.dataset!, args.split as "sample" | "full");
  const agent = makeAgent(ds);
  const items = args.limit ? ds.items.slice(0, Number(args.limit)) : ds.items;
  const model = args.model!;
  const variant = agentName === "tool" ? `tool-${args.corpus}-r${args.retries}` : agentName;

  const runsDir = join(import.meta.dirname, "..", "..", "runs");
  mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runName = `${stamp}_${args.dataset}-${args.split}_${variant}_${model.replace(/\//g, "_")}`;
  const recordsPath = join(runsDir, `${runName}.jsonl`);

  console.log(`running ${items.length} checks | agent=${variant} model=${model}`);
  const records: RunRecord[] = [];
  let done = 0;

  await pool(items, Number(args.concurrency), async (item) => {
    const started = Date.now();
    let record: RunRecord;
    try {
      const { result, usage, sourceText, trace } = await agent(item, model);
      record = {
        item, model, agent: variant, result, usage,
        quoteGrounded: result.quote.trim() ? isQuoteGrounded(result.quote, sourceText) : null,
        latencyMs: Date.now() - started,
        ...(trace && { trace }),
      };
    } catch (err: any) {
      record = {
        item, model, agent: variant, result: null, error: String(err?.message ?? err),
        usage: err?.usage ?? ZERO_USAGE, quoteGrounded: null, latencyMs: Date.now() - started,
        ...(err?.trace && { trace: err.trace }),
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
    JSON.stringify({ model, agent: variant, dataset: args.dataset, split: args.split, ...report }, null, 2),
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
