/**
 * Internal-consistency audit of every table in a store, no model calls.
 *
 *   pnpm audit:tables                                   # the 30 PMC papers (XML tables)
 *   pnpm audit:tables --docs fixtures/demo/docs.jsonl   # any document store
 *   pnpm audit:tables --planted                         # recall on planted errors (see plantedRecall)
 */
import "../cli/errors.js";
import { parseArgs } from "node:util";
import { readJsonl } from "../jsonl.js";
import { auditDocument } from "../source-audit.js";
import { DocStore, loadStore, type Document } from "../tools/store.js";

const { values: args } = parseArgs({
  options: { docs: { type: "string" }, all: { type: "boolean", default: false }, planted: { type: "boolean", default: false } },
});
const store = args.docs ? new DocStore(readJsonl<Document>(args.docs)) : loadStore("pmc", "tables");
const findings = store.docs.flatMap(auditDocument).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1));
const tables = store.docs.reduce((n, d) => n + d.sections.filter((s) => s.kind === "table").length, 0);
const by: Record<string, number> = {};
for (const f of findings) by[`${f.severity} ${f.code}`] = (by[`${f.severity} ${f.code}`] ?? 0) + 1;

console.log(`${store.docs.length} documents, ${tables} tables: ${findings.length} findings ${JSON.stringify(by)}`);
for (const f of args.all ? findings : findings.slice(0, 40)) {
  console.log(`\n${f.severity.toUpperCase()}  ${f.code}  ${f.doc}, ${f.section}\n  ${f.message}\n  row: ${f.row.slice(0, 160)}`);
}

/**
 * Recall on planted errors, since nobody labelled the real ones. For each table, corrupt one cell
 * and see whether the audit finds something new there:
 *   - percent: the first "k (x%)" cell with k >= 10 gets k * 1.4 + 1, leaving x;
 *   - interval: the first "est (lo, hi)" moves the estimate past the upper bound.
 */
function plantedRecall(docs: Document[]) {
  const count = (d: Document) => auditDocument(d).length;
  const withRow = (d: Document, si: number, rows: string[], ri: number, row: string): Document => ({
    ...d,
    sections: d.sections.map((x, j) => (j === si ? { ...x, text: [...rows.slice(0, ri), row, ...rows.slice(ri + 1)].join("\n") } : x)),
  });
  const tally: Record<"percent" | "interval", [number, number]> = { percent: [0, 0], interval: [0, 0] };
  for (const d of docs) {
    const before = count(d);
    d.sections.forEach((s, si) => {
      const rows = s.text.split("\n");
      const pi = rows.findIndex((r, i) => i >= 2 && /\| (\d{2,}) \((\d+(?:\.\d+)?)%?\)/.test(r));
      if (pi >= 0) {
        const m = rows[pi]!.match(/\| (\d{2,}) \((\d+(?:\.\d+)?)%?\)/)!;
        const row = rows[pi]!.replace(m[0], `| ${Math.round(Number(m[1]) * 1.4) + 1} (${m[2]})`);
        tally.percent[1]++;
        if (count(withRow(d, si, rows, pi, row)) > before) tally.percent[0]++;
      }
      const ci = /(-?\d+\.\d+) ?\((-?\d+\.\d+), ?(-?\d+\.\d+)\)/;
      const ii = rows.findIndex((r) => { const m = r.match(ci); return !!m && !/±\s*$/.test(r.slice(0, m.index)); });
      if (ii >= 0) {
        const m = rows[ii]!.match(ci)!;
        const [lo, hi] = [Number(m[2]), Number(m[3])].sort((a, b) => a - b) as [number, number];
        const row = rows[ii]!.replace(m[0], `${(hi + (hi - lo) + 0.5).toFixed(2)} (${m[2]}, ${m[3]})`);
        tally.interval[1]++;
        if (count(withRow(d, si, rows, ii, row)) > before) tally.interval[0]++;
      }
    });
  }
  return tally;
}

if (args.planted) {
  const t = plantedRecall(store.docs);
  console.log(`\nplanted errors found: percent ${t.percent[0]}/${t.percent[1]}, interval ${t.interval[0]}/${t.interval[1]}`);
}
