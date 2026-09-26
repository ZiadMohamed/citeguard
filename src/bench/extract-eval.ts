/**
 * How well does code-only extraction find claims and citations in real results text?
 *
 *   pnpm extract:eval
 *
 * Input: results paragraphs of the 30 PMC papers (data/pmc/extract/results_paragraphs.jsonl),
 * with the authors' own table references still in place ("... (Table 2)."). Answer key: the
 * explicit "Table N" references in each sentence. Measures:
 *   - marker recall: explicit table references in the text that became a claim with that table;
 *   - marker precision: extracted table citations that match a reference the text really makes;
 *   - uncited numeric sentences: sentences with numbers but no marker (a reviewer's "where is this from?").
 */
import "../cli/errors.js";
import { join } from "node:path";
import { extractClaims, splitSentences } from "../extract.js";
import { readJsonl } from "./datasets.js";

interface Para {
  paper: string;
  section: string;
  text: string;
}

const paras = readJsonl<Para>(join(import.meta.dirname, "..", "..", "data", "pmc", "extract", "results_paragraphs.jsonl"));

let refs = 0, found = 0, extracted = 0, correct = 0, sentences = 0, uncited = 0, numericSentences = 0;
const misses: string[] = [];

for (const p of paras) {
  const sents = splitSentences(p.text);
  sentences += sents.length;
  const out = extractClaims(p.text, p.paper);
  uncited += out.uncited.length;
  const bySentence = new Map<number, Set<string>>();
  for (const c of out.claims) {
    const set = bySentence.get(c.sentence) ?? new Set();
    set.add(c.citation);
    bySentence.set(c.sentence, set);
  }
  sents.forEach((s, i) => {
    if (/\d/.test(s)) numericSentences++;
    // Answer key: every "Table N" the sentence mentions, including "Tables 2 and 3".
    const truth = new Set<string>();
    for (const m of s.matchAll(/\bTables?\s+(\d+)(?:\s*(?:,|and|&|–|-)\s*(\d+))?/g)) {
      truth.add(`${p.paper}, Table ${m[1]}`);
      if (m[2]) truth.add(`${p.paper}, Table ${m[2]}`);
    }
    const got = [...(bySentence.get(i) ?? [])].filter((c) => /Table/.test(c));
    refs += truth.size;
    extracted += got.length;
    for (const t of truth) {
      if (got.includes(t)) found++;
      else if (misses.length < 12) misses.push(`${t} | ${s.slice(0, 140)}`);
    }
    for (const g of got) if (truth.has(g)) correct++;
  });
}

const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}% (${a}/${b})`;
console.log(`${paras.length} results paragraphs, ${sentences} sentences, ${numericSentences} with a digit`);
console.log(`table references in text: ${refs}`);
console.log(`  marker recall:    ${pct(found, refs)}`);
console.log(`  marker precision: ${pct(correct, extracted)}`);
console.log(`numeric sentences with no citation marker: ${uncited}`);
console.log(`\nmissed references (first ${misses.length}):`);
for (const m of misses) console.log(`  ${m}`);
