/**
 * How good are the suggested fixes? Uses the bad items of a benchmark, where the answer key has
 * the author's original sentence.
 *
 *   pnpm fix:eval [--dataset pmc|pmchard] [--model openai/gpt-6-sol] [--limit 40]
 *
 * For each bad item the checker flagged in a saved run (--run, default: latest Sol + cues run):
 *   - offered:  a fix passed the gates (numbers from the source, re-checked "supported");
 *   - restored: the fix has the original sentence's informative numbers (value errors), or the
 *               original citation (wrong_target), i.e. it undid the injected error;
 *   - a fix whose re-check passed but that didn't restore the original is printed, to read by hand.
 *     On author_error items (the "good" original was itself wrong) there is nothing to restore; a
 *     fix there corrects the author's error, and needs reading too.
 */
import "../cli/errors.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { suggestFix, wordDiff } from "../agents/fixer.js";
import { readJsonl } from "../jsonl.js";
import { informativeNumbers } from "../numbers.js";
import { loadStore } from "../tools/store.js";
import type { RunRecord } from "../types.js";
import { applyOverrides, loadOverrides } from "./datasets.js";

try {
  process.loadEnvFile(join(import.meta.dirname, "..", "..", ".env"));
} catch {}

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string", default: "pmc" },
    model: { type: "string", default: "openai/gpt-6-sol" },
    run: { type: "string" },
    limit: { type: "string", default: "40" },
  },
});

const runsDir = join(import.meta.dirname, "..", "..", "runs");
const runFile =
  args.run ??
  readdirSync(runsDir)
    .filter((f) => f.endsWith("_openai_gpt-6-sol.jsonl") && f.includes(`_${args.dataset}-sample_resolve-tables-v2-cues`))
    .sort()
    .at(-1);
if (!runFile) throw new Error("no saved Sol + cues run; pass --run");
const records = applyOverrides(readJsonl<RunRecord>(join(runsDir, runFile)), loadOverrides(args.dataset!));
const store = loadStore(args.dataset!, "tables");
const caught = records
  .filter((r) => r.item.label !== "supported" && r.result && r.result.verdict !== "supported" && r.item.originalClaim)
  .slice(0, Number(args.limit));

const nums = (s: string) => informativeNumbers(s).map((n) => n.norm.replace(/^-/, "")).sort().join(",");
const tally = { items: 0, offered: 0, restored: 0, citationFix: 0, citationRight: 0, pointers: 0, cost: 0 };
const detail: string[] = [];
const byType: Record<string, { n: number; offered: number; restored: number }> = {};
const unrestored: string[] = [];

await Promise.all(
  caught.map(async (r) => {
    const fix = await suggestFix({ claim: r.item.claim, citation: r.item.citation }, r.result!, store, args.model!);
    tally.items++;
    tally.cost += fix.usage.costUsd;
    const t = (byType[r.item.errorType] ??= { n: 0, offered: 0, restored: 0 });
    t.n++;
    detail.push(`${r.item.id} ${r.item.errorType.padEnd(18)} ${fix.citation ? `cite ${fix.citation}` : fix.text ? "reword" : `none: ${fix.note}`}`);
    if (!fix.citation && !fix.text && fix.candidates?.length) tally.pointers++;
    if (fix.citation) {
      tally.citationFix++;
      t.offered++;
      const want = r.item.mutation?.match(/^Table (\S+) ->/)?.[1];
      const right = want ? fix.citation.endsWith(`Table ${want}`) : fix.citation.startsWith(r.item.sourcePaper ?? "?");
      if (right) (tally.citationRight++, t.restored++);
    } else if (fix.text) {
      tally.offered++;
      t.offered++;
      if (nums(fix.text) === nums(r.item.originalClaim!)) (tally.restored++, t.restored++);
      if (process.env.FIX_ALL || nums(fix.text) !== nums(r.item.originalClaim!)) unrestored.push(`${r.item.id} ${r.item.errorType}\n  was:  ${r.item.originalClaim}\n  diff: ${wordDiff(r.item.claim, fix.text)}`);
    }
  }),
);

console.log(`${tally.items} caught bad items (${runFile.slice(0, 19)}), fixes by ${args.model}, $${tally.cost.toFixed(3)} total`);
console.log(`  wording fixes offered: ${tally.offered}, restored the original numbers: ${tally.restored}`);
console.log(`  citation fixes offered: ${tally.citationFix}, pointed at the true table/paper: ${tally.citationRight}`);
console.log(`  no fix, but pointed at where the numbers are (for a person): ${tally.pointers}`);
console.log(`  by type (offered / restored of n):`);
for (const [k, v] of Object.entries(byType).sort()) console.log(`    ${k.padEnd(20)} ${v.offered}/${v.restored} of ${v.n}`);
if (process.env.FIX_DETAIL) for (const d of detail.sort()) console.log(`  ${d}`);
console.log(`\nwording fixes that changed numbers differently from the original (read these):`);
for (const u of unrestored) console.log(u);
