import "../cli/errors.js";
import { writeFileSync } from "node:fs";
import { readJsonl } from "./datasets.js";
import { buildReport, formatReport } from "./report.js";
import type { RunRecord } from "../types.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: pnpm rescore runs/<run>.jsonl");
  process.exit(1);
}

const records = readJsonl<RunRecord>(path);
const dataset = records[0]?.item.dataset ?? "";
const report = buildReport(records, dataset);
writeFileSync(path.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(report, null, 2));
console.log(formatReport(report));
