/**
 * Internal-consistency checks on a report's own tables, with no model and no claim.
 *
 * A citation checker compares the summary to the report. These rules check the report against
 * itself, because a wrong source makes a "supported" verdict worthless. Every rule is arithmetic
 * that must hold whatever the study found:
 *
 *   estimate_outside_ci    the point estimate lies outside its own confidence interval: 1.42 (1.02-1.21)
 *   ci_p_disagree          the 95% CI and the p-value on the same row disagree about significance:
 *                          a CI that excludes the null with p > 0.05, or includes it with p < 0.05
 *   percent_mismatch       "k (x%)" where x is not k/D, and D is the denominator the rest of that column
 *                          uses; or a header N ("n = 25") that the column's percentages don't use.
 *                          A run of cells on another denominator is a subgroup, not a finding.
 *
 * Findings are warnings for a reviewer, not errors: a CI on a transformed scale, a one-sided test,
 * or an adjusted analysis can legitimately break a rule. Each finding names the row so a person
 * can decide in seconds.
 */
import type { Document } from "./tools/store.js";

export interface AuditFinding {
  doc: string;
  section: string;
  code: "estimate_outside_ci" | "ci_p_disagree" | "percent_mismatch";
  /**
   * major: the numbers cannot all be right (off by more than 5 points, an estimate outside its CI,
   * a header N the column never uses). minor: off by a point or so, which is also what a percent of
   * those who answered looks like; worth a glance, not an alarm.
   */
  severity: "major" | "minor";
  message: string;
  row: string;
}

const NUM = String.raw`[-−–]?\s?\d+(?:\.\d+)?`;
/** "1.42 (1.02, 1.81)", "−9.4 (−16.2, − 2.7)", "+ 14.47 (8.56–20.38)", "0.78 (0.33–1.87)". */
const EST_CI = new RegExp(
  String.raw`(?<![\w.])(?:[A-Za-z]{1,4}\s*=\s*)?(\+\s?)?(${NUM})\s*[(\[]\s*(${NUM})\s*(?:,|;|to|–|—|-(?=\s?\d))\s*(${NUM})\s*[)\]]`,
  "g",
);
const P_CELL = /^\s*(?:p\s*[=<>]\s*)?([<>≤≥]?)\s*(0?\.\d+|1(?:\.0+)?)\s*[*†‡a-z]*\s*$/i;

const toNum = (s: string) => Number(s.replace(/[−–]/g, "-").replace(/\s+/g, ""));

/** Case-sensitive for abbreviations, so "Tea or coffee" is not an odds ratio. */
const RATIO = /\b(?:a?OR|RR|HR|IRR|aHR|aRR|[Oo]dds|[Hh]azard|[Rr]isk ratio|[Rr]ate ratio|[Rr]atio)\b/;
const DIFFERENCE = /\b(?:difference|diff\.?|change|MD|SMD|β|beta|B|coefficient|effect|estimate|LS ?mean)\b/i;
/** Descriptive statistics: a median with its IQR or range sits inside the bracket too, but has no null value. */
const DESCRIPTIVE = /\b(?:median|IQR|range|min|max|quartile)\b/i;
const P_HEADER = /(?:^|\W)(?:p|p[-\s]?value|sig\.?)(?:\W|$)/i;

interface EstimateCi {
  cell: number;
  est: number;
  lo: number;
  hi: number;
  text: string;
}

function estimatesIn(cells: string[]): EstimateCi[] {
  const out: EstimateCi[] = [];
  cells.forEach((cell, i) => {
    for (const m of cell.matchAll(EST_CI)) {
      // "1.52 ± 3.76 (−0.10 to 3.15)": the number before the bracket is an SD, not the estimate.
      if (/±\s*$/.test(cell.slice(0, m.index))) continue;
      out.push({ cell: i, est: toNum(m[2]!), lo: toNum(m[3]!), hi: toNum(m[4]!), text: m[0].trim() });
    }
  });
  return out;
}

/** The null value for an interval, from the row label, the cell, or the column header; null when unknown. */
function nullValue(context: string, e: EstimateCi): 0 | 1 | null {
  // A ratio and its interval are positive; a negative bound means a difference, whatever the header says.
  if (RATIO.test(context) && e.lo > 0 && e.hi > 0 && e.est > 0) return 1;
  if (DIFFERENCE.test(context)) return 0;
  return null;
}

/** Column index -> header text, from the first row that has more than one cell. */
function headerOf(rows: string[]): string[] {
  return (rows.find((r) => r.split(" | ").length > 1) ?? "").split(" | ");
}

/** Group sizes by column, from headers like "Drug X (N=212)" or "Control (n = 40)". */
function groupSizes(header: string[]): (number | null)[] {
  return header.map((h) => {
    const m = h.match(/\b[nN]\s*=\s*(\d[\d,]*)/);
    return m ? Number(m[1]!.replace(/,/g, "")) : null;
  });
}

export function auditDocument(doc: Document): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const s of doc.sections) {
    if (s.kind !== "table") continue;
    const rows = s.text.split("\n\nNotes:")[0]!.split("\n");
    const header = headerOf(rows);
    const sizes = groupSizes(header);
    const pColumn = header.findIndex((h) => P_HEADER.test(h));
    const add = (code: AuditFinding["code"], message: string, row: string) =>
      findings.push({ doc: doc.id, section: s.label, code, severity: "major", message, row });

    for (const row of rows) {
      const cells = row.split(" | ");
      const label = cells[0] ?? "";
      if (DESCRIPTIVE.test(label) || DESCRIPTIVE.test(s.heading) && !RATIO.test(row) && !DIFFERENCE.test(row)) continue;

      for (const e of estimatesIn(cells)) {
        const [lo, hi] = e.lo <= e.hi ? [e.lo, e.hi] : [e.hi, e.lo];
        // "57.00[49.00,72.00]" with no effect-size wording is a median [IQR]; a median can sit at an edge.
        const effect = `${label} ${header[e.cell] ?? ""} ${s.heading}`;
        if (e.text.includes("[") && !/\bCI\b|confidence/i.test(effect) && !RATIO.test(effect)) continue;
        const tol = 0.011 * Math.max(1, Math.abs(e.est));
        if (e.est < lo - tol || e.est > hi + tol) {
          add("estimate_outside_ci", `${e.text}: the estimate is outside its own interval`, row);
          continue;
        }
        // Significance: needs a known null value and a p-value on the same row.
        const context = `${label} ${header[e.cell] ?? ""} ${cells[e.cell]}`;
        const nul = nullValue(context, e);
        const pCell = pColumn > 0 ? cells[pColumn] : cells.find((c, i) => i > e.cell && P_CELL.test(c));
        const p = pCell?.match(P_CELL);
        if (nul === null || !p) continue;
        const pv = Number(p[2]!.startsWith(".") ? `0${p[2]}` : p[2]);
        const bound = p[1] ?? "";
        const excludesNull = lo > nul || hi < nul;
        // Leave a margin: a bound that touches the null, or p within rounding of 0.05, is not a finding.
        const clear = Math.min(Math.abs(lo - nul), Math.abs(hi - nul)) > 0.01 * Math.max(1, Math.abs(nul));
        if (!clear) continue;
        if (excludesNull && !bound.startsWith("<") && pv > 0.06) {
          add("ci_p_disagree", `${e.text} excludes ${nul} but p = ${p[2]}`, row);
        } else if (!excludesNull && (bound.startsWith("<") ? pv <= 0.05 : pv < 0.04)) {
          add("ci_p_disagree", `${e.text} includes ${nul} but p ${bound || "="} ${p[2]}`, row);
        }
      }

    }
    findings.push(...percentFindings(doc.id, s.label, rows, header, sizes));
  }
  const rank = { major: 0, minor: 1 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

interface PercentCell {
  row: string;
  text: string;
  k: number;
  pct: number;
  decimals: number;
}

const fits = (c: PercentCell, d: number) => Math.abs((100 * c.k) / d - c.pct) <= 0.5 * 10 ** -c.decimals + 0.051;

/**
 * Per column: find the denominator most "k (x%)" cells agree with (the header's N wins ties), and
 * flag the cells that don't fit it. Needs at least 3 agreeing cells, and most of the column.
 */
function percentFindings(doc: string, section: string, rows: string[], header: string[], sizes: (number | null)[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (let col = 1; col < header.length; col++) {
    if (/\b(?:mean|SD|median|IQR)\b/i.test(header[col]!)) continue;
    const all: PercentCell[] = [];
    for (const row of rows) {
      const cells = row.split(" | ");
      if (cells.length !== header.length) continue;
      const m = cells[col]!.match(/^\s*(\d+)\s*\(\s*(\d+(?:\.\d+)?)\s*%?\s*\)\s*$/);
      if (!m) continue;
      const k = Number(m[1]), pct = Number(m[2]);
      // Zero cells fit anything; 100% rows ("Total | 841 (100.0)") restate N.
      if (k === 0 || pct === 0 || pct >= 100) continue;
      all.push({ row, text: cells[col]!.trim(), k, pct, decimals: m[2]!.split(".")[1]?.length ?? 0 });
    }
    if (all.length < 4) continue;
    // The column's usual denominator: the one most cells agree with (the header's N wins ties).
    const candidates = new Set<number>(all.map((c) => Math.round((100 * c.k) / c.pct)));
    if (sizes[col]) candidates.add(sizes[col]!);
    let usual = 0, support = 0;
    for (const d of candidates) {
      const n = all.filter((c) => c.k <= d && fits(c, d)).length;
      if (n > support || (n === support && d === sizes[col])) [usual, support] = [d, n];
    }
    if (support < 3 || support < 0.6 * all.length) continue;
    // A header N the column doesn't use is a mislabel ("n = 25" over percentages of 50): one finding.
    if (sizes[col] && sizes[col] !== usual) {
      const onHeader = all.filter((c) => fits(c, sizes[col]!)).length;
      out.push({
        doc,
        section,
        code: "percent_mismatch",
        severity: "major",
        message: `"${header[col]!.trim()}" says N = ${sizes[col]}, but ${support} of ${all.length} percentages in the column are of ${usual} (${onHeader} are of ${sizes[col]})`,
        row: header.join(" | "),
      });
      continue;
    }
    // Only an isolated cell is a finding. A run of neighbouring cells on one other denominator is a
    // subgroup (those tested, those who answered, a different unit), and a row labelled "among ..."
    // says so itself.
    const seq = all;
    seq.forEach((c, i) => {
      if (fits(c, usual)) return;
      // More events than N: impossible if the header declares that N; otherwise usually a different
      // unit in the same column (children, not centres), so leave it.
      if (c.k > usual && sizes[col] !== usual) return;
      if (/\b(?:among|only|of those|subgroup|users|tested)\b/i.test(c.row.split(" | ")[0]!)) return;
      const d = Math.round((100 * c.k) / c.pct);
      const neighbours = [seq[i - 1], seq[i + 1]].filter(Boolean) as PercentCell[];
      if (neighbours.some((n) => !fits(n, usual) && fits(n, d))) return;
      out.push({
        doc,
        section,
        code: "percent_mismatch",
        severity: Math.abs((100 * c.k) / usual - c.pct) > 5 ? "major" : "minor",
        message: `${c.text}: ${c.k}/${usual} is ${((100 * c.k) / usual).toFixed(c.decimals || 1)}%, not ${c.pct}% (${support} of ${all.length} cells in "${header[col]!.trim()}" use N = ${usual})`,
        row: c.row,
      });
    });
  }
  return out;
}
