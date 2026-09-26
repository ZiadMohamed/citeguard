/**
 * Submission-level scan over the PMC results paragraphs, no model calls.
 *
 *   pnpm scan
 *
 * Reports how many citations resolve, and for sentences with numbers but no citation, how many
 * the number index can point at a table (all the sentence's numbers in one section).
 */
import "../cli/errors.js";
import { join } from "node:path";
import { informativeNumbers } from "../numbers.js";
import { resolveCitation } from "../resolve.js";
import { buildNumberIndex, scanSubmission, suggestSources } from "../submission.js";
import { loadStore } from "../tools/store.js";
import { readJsonl } from "./datasets.js";

const paras = readJsonl<{ paper: string; text: string }>(
  join(import.meta.dirname, "..", "..", "data", "pmc", "extract", "results_paragraphs.jsonl"),
);
const store = loadStore("pmc", "tables");
const scan = scanSubmission(paras.map((p) => ({ doc: p.paper, text: p.text })), store);

const by = { section: 0, document: 0, missing: 0 };
for (const c of scan.claims) by[c.resolution]++;
const suggested = scan.uncited.filter((u) => u.suggestions.length);
const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}% (${a}/${b})`;

console.log(`${paras.length} paragraphs: ${scan.claims.length} cited claims, ${scan.uncited.length} uncited numeric sentences`);
console.log(`citations: ${by.section} resolve to a section, ${by.document} to a whole document, ${by.missing} do not resolve`);
console.log(`uncited sentences with a suggested source (all numbers in one section): ${pct(suggested.length, scan.uncited.length)}`);
// Accuracy of the suggestions, measured where the answer is known: hide each cited claim's
// citation and ask the index where its numbers are.
const index = buildNumberIndex(store);
let asked = 0, answered = 0, right = 0;
for (const c of scan.claims.filter((c) => c.resolution === "section" && /Table/.test(c.citation))) {
  if (!informativeNumbers(c.claim).length) continue;
  asked++;
  const s = suggestSources(c.claim, index, paras[c.paragraph]!.paper);
  if (!s.length) continue;
  answered++;
  if (s.includes(resolveCitation(store, c.citation).label)) right++;
}
console.log(`suggestion check on cited claims (citation hidden): answered ${pct(answered, asked)}, cited table among suggestions ${pct(right, answered)}`);

console.log(`\nunresolved or fallback citations:`);
for (const c of scan.claims.filter((c) => c.problem).slice(0, 8)) console.log(`  ${c.citation} | ${c.problem}`);
console.log(`\nsample suggestions:`);
for (const u of suggested.slice(0, 6)) console.log(`  ${u.suggestions.join("; ")} <- ${u.text.slice(0, 110)}`);
