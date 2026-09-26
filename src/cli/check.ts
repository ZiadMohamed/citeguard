/**
 * Check every citation in a summary document against the cited reports.
 *
 *   pnpm check fixtures/demo/summary.txt --docs fixtures/demo/docs.jsonl
 *   pnpm check my-summary.txt --docs my-reports.jsonl --model openai/gpt-6-sol
 *   pnpm check ... --json                  # machine-readable, one object per citation
 *   pnpm check --docs fixtures/demo/docs.jsonl --interactive   # type a sentence, get a verdict
 *   pnpm check ... --fix                   # also suggest a verified rewrite for each flag
 *
 * The summary is plain text. The reports are a JSONL file of documents (see fixtures/demo/docs.jsonl):
 * {id, title, aliases?, sections: [{label, heading, kind, text}]}. Citations are explicit markers
 * such as "[CSR-ABC101, Table 14.2.1]" or "(Table 2)".
 *
 * Code extracts the claims and resolves each citation; a missing report or table is flagged with
 * no model call. The rest go to the hybrid checker (fast model, then the strong model on flags and
 * on passes that code raised an overstatement cue on). Flags print first, with the evidence.
 */
import "./errors.js";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { suggestFix, wordDiff } from "../agents/fixer.js";
import { checkHybrid, type HybridConfig, type HybridOutput } from "../agents/hybrid.js";
import { readJsonl } from "../jsonl.js";
import { auditDocument, type AuditFinding } from "../source-audit.js";
import { scanSubmission } from "../submission.js";
import { buildChunks, SearchIndex } from "../tools/search.js";
import { DocStore, type Document } from "../tools/store.js";
import { ToolBox } from "../tools/tools.js";

try {
  process.loadEnvFile(join(import.meta.dirname, "..", "..", ".env"));
} catch {}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    docs: { type: "string" },
    model: { type: "string", default: "openai/gpt-6-luna" },
    strong: { type: "string", default: "openai/gpt-6-sol" },
    json: { type: "boolean", default: false },
    interactive: { type: "boolean", short: "i", default: false },
    fix: { type: "boolean", default: false },
  },
});

const summaryPath = positionals[0];
if (!args.docs || (!summaryPath && !args.interactive)) {
  console.error("usage: pnpm check <summary.txt> --docs <reports.jsonl> [--model m] [--strong m] [--json]");
  console.error("       pnpm check --docs <reports.jsonl> --interactive");
  process.exit(1);
}

const store = new DocStore(readJsonl<Document>(args.docs));
let index: SearchIndex | undefined;
const newToolbox = () => new ToolBox(store, (index ??= new SearchIndex(buildChunks(store))));
const hybridConfig = (onProvisional?: HybridConfig["onProvisional"]): HybridConfig => ({
  fast: args.model!,
  strong: args.strong!,
  escalate: new Set(["flags", "cues"]),
  opts: { readingRules: true, cues: true },
  retries: 2,
  onProvisional,
});

if (args.interactive) {
  await interactive();
  process.exit(0);
}
const paragraphs = readFileSync(summaryPath!, "utf8")
  .split(/\n\s*\n/)
  .map((text) => ({ text: text.trim() }))
  .filter((p) => p.text);
const scan = scanSubmission(paragraphs, store);

const started = Date.now();
const results = await Promise.all(
  scan.claims.map(async (c) => {
    const out: HybridOutput = await checkHybrid({ claim: c.claim, citation: c.citation }, store, newToolbox, hybridConfig());
    return { ...c, out };
  }),
);

if (args.json) {
  for (const r of results) {
    const { result, decidedBy, usage, cues, warning } = r.out;
    const sourceIssues = store.docs.flatMap(auditDocument).filter((f) => r.citation.startsWith(`${f.doc}, ${f.section}`));
    console.log(JSON.stringify({ claim: r.claim, citation: r.citation, ...result, decidedBy, costUsd: usage.costUsd, cues, warning, sourceIssues }));
  }
  process.exit(0);
}

// The reports audited against themselves: a citation that matches a wrong table is still wrong.
const audit = store.docs.flatMap(auditDocument);

const issuesAt = (citation: string) => audit.filter((f) => citation.startsWith(`${f.doc}, ${f.section}`));
const flags = results.filter((r) => r.out.result.verdict !== "supported");
const passes = results.filter((r) => r.out.result.verdict === "supported");
const cost = results.reduce((s, r) => s + r.out.usage.costUsd, 0);
const by = (t: string) => results.filter((r) => r.out.decidedBy === t).length;

console.log(`\n${results.length} citations checked in ${((Date.now() - started) / 1000).toFixed(1)}s, $${cost.toFixed(4)}`);
console.log(`${flags.length} flagged, ${passes.length} supported | decided by: ${by("code")} code, ${by("fast")} fast model, ${by("strong")} strong model\n`);

// Code decisions first: a missing table is never a judgment call.
flags.sort((a, b) => Number(b.out.decidedBy === "code") - Number(a.out.decidedBy === "code"));
for (const r of flags) {
  const { result, decidedBy } = r.out;
  console.log(`FLAG  ${result.verdict.toUpperCase()}  [${r.citation}]  (decided by ${decidedBy})`);
  console.log(`  claim:  ${r.claim}`);
  console.log(`  reason: ${result.reason}`);
  if (result.quote) console.log(`  source: "${result.quote.replace(/\s+/g, " ").slice(0, 200)}"  (${result.location})`);
  if (r.out.warning) console.log(`  note:   ${r.out.warning}`);
  for (const f of issuesAt(r.citation)) console.log(`  source issue (${f.severity}): ${f.message}`);
  if (args.fix) await printFix(r, r.out.result);
  console.log();
}
for (const r of passes) {
  const cue = r.out.cues ? "  (a cue was raised and answered; worth a look)" : "";
  const issue = issuesAt(r.citation).length ? "  (the cited table has a source issue, below)" : "";
  console.log(`ok    [${r.citation}]  ${r.claim.slice(0, 100)}${cue}${issue}`);
}
printAudit(audit);
if (scan.uncited.length) {
  console.log(`\n${scan.uncited.length} sentence(s) with numbers but no citation:`);
  for (const u of scan.uncited) {
    console.log(`  - ${u.text.slice(0, 110)}${u.suggestions.length ? `\n    numbers found in: ${u.suggestions.join("; ")}` : ""}`);
  }
}

/**
 * One sentence at a time, for demos and quick checks. Each line is checked on its own, with a
 * fresh context; nothing carries over between lines. The fast verdict prints as soon as it is in,
 * and the strong model's verdict replaces it when the hybrid re-checks.
 */
async function interactive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ids = store.docs.map((d) => `${d.id} (${d.sections.map((s) => s.label).join(", ")})`);
  console.log(`Reports loaded: ${ids.join("; ")}`);
  console.log(`Type a sentence with its citation, e.g.: <claim> [${store.docs[0]?.id ?? "DOC-ID"}, ${store.docs[0]?.sections[0]?.label ?? "Table 1"}]`);
  console.log(`A citation-less "(Table 2)" is read against the first report. Flags come with a suggested fix. Empty line or Ctrl-D quits.\n`);
  const own = store.docs[0]?.id;
  rl.setPrompt("> ");
  rl.prompt();
  // Async iteration queues lines typed (or piped) while a check is still running.
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line === "exit" || line === "quit") break;
    const scan = scanSubmission([{ doc: own, text: line }], store);
    if (!scan.claims.length) {
      console.log("  No citation found. Add one like [CSR-ABC101, Table 14.2.1].");
      for (const u of scan.uncited) if (u.suggestions.length) console.log(`  Its numbers appear in: ${u.suggestions.join("; ")}`);
      console.log();
      rl.prompt();
      continue;
    }
    for (const c of scan.claims) {
      const started = Date.now();
      const out = await checkHybrid({ claim: c.claim, citation: c.citation }, store, newToolbox, hybridConfig((fast, why) => {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  … ${label(fast.result.verdict)} from ${args.model} in ${secs}s (${why}); asking ${args.strong}`);
      }));
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const r = out.result;
      console.log(`  ${label(r.verdict)}  [${c.citation}]  decided by ${out.decidedBy} in ${secs}s, $${out.usage.costUsd.toFixed(4)}`);
      console.log(`  reason: ${r.reason}`);
      if (r.quote) console.log(`  source: "${r.quote.replace(/\s+/g, " ").slice(0, 200)}"  (${r.location})`);
      if (out.warning) console.log(`  note:   ${out.warning}`);
      if (r.verdict !== "supported") await printFix(c, r);
    }
    for (const u of scan.uncited) {
      console.log(`  uncited numbers in: "${u.text.slice(0, 80)}"${u.suggestions.length ? ` (found in ${u.suggestions.join("; ")})` : ""}`);
    }
    console.log();
    rl.prompt();
  }
  rl.close();
}

function label(v: string): string {
  return v === "supported" ? "OK  supported" : `FLAG ${v}`;
}

function printAudit(findings: AuditFinding[]) {
  if (!findings.length) return;
  const major = findings.filter((f) => f.severity === "major");
  console.log(`\n${findings.length} issue(s) inside the reports themselves (${major.length} major), found by arithmetic, no model:`);
  for (const f of findings.slice(0, 10)) {
    console.log(`  ${f.severity.toUpperCase().padEnd(5)} ${f.doc}, ${f.section}: ${f.message}\n        row: ${f.row.slice(0, 120)}`);
  }
}

/** Suggested rewrite with a word diff, using the strong model; only fixes that passed the gates print. */
async function printFix(c: { claim: string; citation: string }, verdict: import("../types.js").CheckResult) {
  const fix = await suggestFix(c, verdict, store, args.strong!);
  if (fix.citation) {
    console.log(`  fix:    cite [${fix.citation}] instead   (${fix.note}, $${fix.usage.costUsd.toFixed(4)})`);
  } else if (fix.text) {
    console.log(`  fix:    ${fix.text}`);
    console.log(`  diff:   ${wordDiff(c.claim, fix.text)}   (${fix.note}, $${fix.usage.costUsd.toFixed(4)})`);
  } else {
    console.log(`  fix:    none (${fix.note})`);
  }
}
