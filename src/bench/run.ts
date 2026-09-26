import { fail } from "../cli/errors.js";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkBaseline } from "../agents/baseline.js";
import { checkCitation, type CitationCheck, type FastPathOptions } from "../agents/resolver.js";
import { checkHybrid, ESCALATE_OPTIONS, type Escalate } from "../agents/hybrid.js";
import { checkWithRetries } from "../agents/tool-agent.js";
import { ZERO_USAGE } from "../llm.js";
import { isQuoteGrounded } from "../quote.js";
import { buildChunks, SearchIndex } from "../tools/search.js";
import { loadStore, type CorpusVariant } from "../tools/store.js";
import { ToolBox } from "../tools/tools.js";
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
    /** resolve / hybrid / tool: which document store (tables | pdf | full). */
    corpus: { type: "string", default: "tables" },
    /** Tool agent only: fresh-context retries after an objective failure. */
    retries: { type: "string", default: "2" },
    /** resolve / hybrid: v2 (default) = + reading conventions and confidence; v1 reproduces the first runs. */
    prompt: { type: "string", default: "v2" },
    /** OpenRouter reasoning effort for one-call checks (low | medium | high). */
    reasoning: { type: "string" },
    /** hybrid: the strong model, and which fast verdicts it re-checks (flags,cues,judgment,lowconf,passes). */
    strong: { type: "string", default: "openai/gpt-6-sol" },
    escalate: { type: "string", default: "flags,cues" },
    /** resolve / hybrid: add sign and overstatement cues to the retry after a "supported" verdict. */
    cues: { type: "boolean", default: false },
  },
});

type AgentOutput = Omit<CitationCheck, "resolution"> & {
  resolution?: RunRecord["resolution"];
  hybrid?: RunRecord["hybrid"];
};
type Agent = (item: BenchItem, model: string) => Promise<AgentOutput>;

/** The store, plus a tool box factory that builds the search index only if a check needs it. */
function storeAndTools() {
  const store = loadStore(args.dataset!, args.corpus as CorpusVariant);
  let index: SearchIndex | undefined;
  const newToolbox = () => new ToolBox(store, (index ??= new SearchIndex(buildChunks(store))));
  return { store, newToolbox };
}

const AGENTS: Record<string, (ds: Dataset) => Agent> = {
  /** Ablation: handed the answer-key text (targetId), one call, no tools. */
  baseline: (ds) => async (item, model) => {
    const source = item.targetId ? (ds.docs.get(item.targetId) ?? null) : null;
    const { result, usage } = await checkBaseline(
      { claim: item.claim, citation: item.citation, source },
      model,
    );
    return { result, usage, sourceText: source ? `${source.title}\n${source.text}` : "" };
  },
  /** Always searches with tools, even when the citation names a table. */
  tool: () => {
    const { store, newToolbox } = storeAndTools();
    return (item, model) => checkWithRetries(item, newToolbox, store, model, Number(args.retries));
  },
  /**
   * Resolve a named section in code and make one model call. Search with the tool agent
   * only when the citation names a whole document, or a section too long to paste.
   */
  resolve: () => {
    const { store, newToolbox } = storeAndTools();
    return (item, model) => checkCitation(item, store, newToolbox, model, fastOpts(), Number(args.retries));
  },
  /** Fast model first; the strong model (--strong) re-checks the verdicts named in --escalate. */
  hybrid: () => {
    const { store, newToolbox } = storeAndTools();
    const escalate = parseEscalate(args.escalate!);
    return async (item, model) => {
      const out = await checkHybrid(item, store, newToolbox, {
        fast: model,
        strong: args.strong!,
        escalate,
        opts: fastOpts(),
        retries: Number(args.retries),
      });
      const { decidedBy, fastResult, fastLatencyMs, escalationReason, ...rest } = out;
      return { ...rest, hybrid: { decidedBy, fastResult, fastLatencyMs, escalationReason } };
    };
  },
};

/** Run-name tag for the setup, e.g. "resolve-tables-v2-cues" or "hybrid-v2-cues-flags+cues-gpt-6-sol". */
function variantName(agent: string): string {
  const prompt = args.prompt === "v1" ? "" : `-${args.prompt}`;
  const tags = `${args.reasoning ? `-${args.reasoning}` : ""}${args.cues ? "-cues" : ""}`;
  switch (agent) {
    case "tool":
      return `tool-${args.corpus}-r${args.retries}`;
    case "resolve":
      return `resolve-${args.corpus}${prompt}${tags}`;
    case "hybrid":
      return `hybrid${prompt || "-v1"}${tags}-${args.escalate!.replace(/,/g, "+")}-${args.strong!.split("/").pop()}`;
    default:
      return agent;
  }
}

function parseEscalate(list: string): Set<Escalate> {
  const parts = list.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !ESCALATE_OPTIONS.includes(p as Escalate));
  if (bad.length) throw new Error(`Unknown --escalate ${bad.join(",")}. Options: ${ESCALATE_OPTIONS.join(", ")}`);
  return new Set(parts as Escalate[]);
}

function fastOpts(): FastPathOptions {
  return {
    readingRules: args.prompt === "v2",
    reasoning: args.reasoning as FastPathOptions["reasoning"],
    cues: args.cues,
  };
}

async function main() {
  const agentName = args.agent!;
  const makeAgent = AGENTS[agentName];
  if (!makeAgent) throw new Error(`Unknown agent "${args.agent}". Options: ${Object.keys(AGENTS).join(", ")}`);

  const ds = loadDataset(args.dataset!, args.split as "sample" | "full");
  const agent = makeAgent(ds);
  const items = args.limit ? ds.items.slice(0, Number(args.limit)) : ds.items;
  const model = args.model!;
  const variant = variantName(agentName);

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
      const { result, usage, sourceText, trace, resolution, hybrid, cues, warning } = await agent(item, model);
      record = {
        item, model, agent: variant, result, usage,
        quoteGrounded: result.quote.trim() ? isQuoteGrounded(result.quote, sourceText) : null,
        latencyMs: Date.now() - started,
        ...(trace && { trace }),
        ...(resolution && { resolution }),
        ...(hybrid && { hybrid }),
        ...(cues && { cues }),
        ...(warning && { warning }),
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
  if (agentName === "hybrid") {
    const by = { code: 0, fast: 0, strong: 0 };
    for (const r of records) if (r.hybrid) by[r.hybrid.decidedBy]++;
    const fastMs = records.flatMap((r) => (r.hybrid ? [r.hybrid.fastLatencyMs] : [])).sort((a, b) => a - b);
    console.log(
      `decided by: ${by.code} code, ${by.fast} fast model, ${by.strong} strong model | time to first verdict p50 ${fastMs[Math.floor(fastMs.length / 2)] ?? 0} ms`,
    );
  }
  if (agentName === "resolve" || agentName === "hybrid") {
    const counts = { section: 0, missing: 0, search: 0 };
    for (const r of records) if (r.resolution) counts[r.resolution]++;
    console.log(
      `resolution: ${counts.section} section (one model call), ${counts.missing} missing (no model call), ${counts.search} search (tool agent)`,
    );
  }
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

main().catch(fail);
