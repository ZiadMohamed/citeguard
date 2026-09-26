import type { RunRecord } from "../types.js";
import { applyOverrides, loadOverrides } from "./datasets.js";
import { firstAttemptOnly, formatSummary, summarize, type Rate, type Summary } from "./metrics.js";

export interface Report {
  raw: Summary;
  /** Present when human-reviewed label corrections exist for this dataset. */
  adjusted?: Summary & { overridesApplied: number };
  /** Present when some checks were retried: the headline rates scored as if there were no retries. */
  firstAttempt?: { catchRate: Rate; falseAlarmRate: Rate };
}

export function buildReport(records: RunRecord[], dataset: string): Report {
  const overrides = loadOverrides(dataset);
  const relabel = (rs: RunRecord[]) => (overrides.size ? applyOverrides(rs, overrides) : rs);
  const raw = summarize(records);
  const report: Report = { raw };
  if (overrides.size) {
    const adjustedRecords = applyOverrides(records, overrides);
    const changed = adjustedRecords.filter((r, i) => r !== records[i]).length;
    report.adjusted = { ...summarize(adjustedRecords), overridesApplied: changed };
  }
  if (records.some((r) => (r.trace?.attempts?.length ?? 1) > 1)) {
    const first = summarize(relabel(firstAttemptOnly(records)));
    report.firstAttempt = { catchRate: first.catchRate, falseAlarmRate: first.falseAlarmRate };
  }
  return report;
}

const short = (r: Rate) => (Number.isNaN(r.value) ? "n/a" : `${(r.value * 100).toFixed(1)}%`);

export function formatReport(report: Report): string {
  const { raw, adjusted, firstAttempt } = report;
  const lines: string[] = [];
  if (adjusted) lines.push(`RAW LABELS: catch ${short(raw.catchRate)}, false alarms ${short(raw.falseAlarmRate)}`);
  if (firstAttempt) {
    lines.push(
      `FIRST ATTEMPT ONLY (no retries)${adjusted ? ", adjusted labels" : ""}: catch ${short(firstAttempt.catchRate)}, false alarms ${short(firstAttempt.falseAlarmRate)}`,
    );
  }
  if (adjusted) lines.push(`ADJUSTED (${adjusted.overridesApplied} labels corrected after human review):`);
  if (lines.length) lines.push("");
  lines.push(formatSummary(adjusted ?? raw));
  return lines.join("\n");
}
