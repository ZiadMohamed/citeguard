import type { RunRecord } from "../types.js";
import { applyOverrides, loadOverrides } from "./datasets.js";
import { formatSummary, summarize, type Rate, type Summary } from "./metrics.js";

export interface Report {
  raw: Summary;
  /** Present when human-reviewed label corrections exist for this dataset. */
  adjusted?: Summary & { overridesApplied: number };
}

export function buildReport(records: RunRecord[], dataset: string): Report {
  const raw = summarize(records);
  const overrides = loadOverrides(dataset);
  if (overrides.size === 0) return { raw };
  const adjustedRecords = applyOverrides(records, overrides);
  const changed = adjustedRecords.filter((r, i) => r !== records[i]).length;
  return { raw, adjusted: { ...summarize(adjustedRecords), overridesApplied: changed } };
}

const short = (r: Rate) => (Number.isNaN(r.value) ? "n/a" : `${(r.value * 100).toFixed(1)}%`);

export function formatReport(report: Report): string {
  if (!report.adjusted) return formatSummary(report.raw);
  const { raw, adjusted } = report;
  return [
    `RAW LABELS: catch ${short(raw.catchRate)}, false alarms ${short(raw.falseAlarmRate)}`,
    `ADJUSTED (${adjusted.overridesApplied} labels corrected after human review):`,
    ``,
    formatSummary(adjusted),
  ].join("\n");
}
