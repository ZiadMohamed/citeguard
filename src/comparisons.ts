/**
 * Comparison cues: a claim that one group was higher or lower than another, checked against the
 * table in code. Two patterns every cheap model passes:
 *
 *   - "Drug X lowered SBP more than placebo at week 24", where the week 24 row has p = 0.231:
 *     a between-group comparison stated as fact on a non-significant row.
 *   - "higher in A (18.07) compared to B (18.90)": the comparative word contradicts the two
 *     values the claim itself gives.
 *
 * Like the other cues, these are questions for the model, not verdicts.
 */
import { informativeNumbers, numbersIn, type Num } from "./numbers.js";
import type { Cue } from "./hedges.js";

const UP = /\b(?:higher|greater|larger|more|bigger|superior|better|longer)\b/i;
const DOWN = /\b(?:lower|smaller|less|fewer|shorter|inferior|worse)\b/i;
/** A comparison between groups, not just "higher at week 12 than baseline". */
const BETWEEN = /\b(?:than|vs\.?|versus|compared (?:with|to)|relative to|over)\b/i;
/** Wording that already concedes the comparison may not be significant. */
const HEDGE =
  /\b(?:numerically|slightly|marginally|non-?\s?significant\w*|not\s+(?:statistically\s+)?significant\w*|did not reach|similar|comparable|trend\w*|no\s+(?:\w+\s+)?differen\w*|insignificant\w*)\b/i;

/** "week 24", "24 weeks", "month 3", "3 months", "day 7" -> "week 24" etc. */
function timePoints(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(week|month|day|year)s?\s*(\d+)\b|\b(\d+)[\s-]*(week|month|day|year)s?\b/gi)) {
    const unit = (m[1] ?? m[4])!.toLowerCase();
    const n = m[2] ?? m[3];
    out.push(`${unit} ${n}`);
  }
  return out;
}

interface Table {
  header: string[];
  rows: string[][];
}

function parseTable(text: string): Table | null {
  const lines = text.split("\n").filter((l) => l.includes("|"));
  if (lines.length < 2) return null;
  const split = (l: string) => l.split("|").map((c) => c.trim());
  return { header: split(lines[0]!), rows: lines.slice(1).map(split) };
}

/** P-values in one table row, read from columns whose header names a p-value. */
function rowPValues(table: Table, row: string[]): number[] {
  // A row whose cells don't line up with the header (merged header rows) can't be read by column.
  if (row.length !== table.header.length) return [];
  const cols = table.header.flatMap((h, i) => (/(?:^|[\s(])p(?:[\s-]*value)?\b|p\s*[<=]/i.test(h) ? [i] : []));
  const ps: number[] = [];
  for (const i of cols) {
    const cell = row[i] ?? "";
    const n = numbersIn(cell.replace(/^[<>≤≥=\s]+/, ""))[0];
    if (n && n.value >= 0 && n.value <= 1) ps.push(n.value);
  }
  return ps;
}

/** Rows that hold every informative number in the claim, or, if it has none, match its time point. */
function relevantRows(claim: string, table: Table): string[][] {
  const nums = informativeNumbers(claim);
  if (nums.length) {
    return table.rows.filter((r) => {
      const rowNums = informativeNumbers(r.join(" | ")).map((n) => n.norm);
      return nums.every((n) => rowNums.includes(n.norm) || rowNums.includes(n.norm.replace(/^-/, "")));
    });
  }
  const times = timePoints(claim);
  if (!times.length) return [];
  return table.rows.filter((r) => timePoints(r[0] ?? "").some((t) => times.includes(t)));
}

/** First informative number before the comparison word, and first after it. */
function sides(claim: string): [Num, Num] | null {
  const m = claim.match(BETWEEN);
  if (!m || m.index === undefined) return null;
  const before = informativeNumbers(stripSpread(claim.slice(0, m.index)));
  const rest = claim.slice(m.index + m[0].length);
  const after = informativeNumbers(stripSpread(rest));
  if (before.length && after.length) return [before[before.length - 1]!, after[0]!];
  // "... smaller than the control group (Δ15.00 [..] vs. Δ0.00 [..])": both values after the comparison.
  const vs = rest.match(/\bvs\.?|versus\b/i);
  if (!before.length && vs?.index !== undefined) {
    const a = informativeNumbers(stripSpread(rest.slice(0, vs.index)));
    const b = informativeNumbers(stripSpread(rest.slice(vs.index + vs[0].length)));
    if (a.length && b.length) return [a[a.length - 1]!, b[0]!];
  }
  return null;
}

/** "24 months", "week 12": time points, not values. */
function stripTimes(t: string): string {
  return t.replace(/\b(?:week|month|day|year)s?\s*\d+\b|\b\d+[\s-]*(?:week|month|day|year|hour|minute)s?\b/gi, " ");
}

/** Group values only: drop "± SD" and bracketed intervals, which would read as values. */
function stripSpread(t: string): string {
  return t.replace(/[±]\s*\d+(?:\.\d+)?/g, " ").replace(/[\[(][^\[\]()]*[,–][^\[\]()]*[\])]/g, " ");
}

/** "a score of 55.89, which decreased to 98.12": a change whose word contradicts its own values. */
function changeCue(claim: string): Cue | null {
  const m = claim.match(/\b(increas\w*|decreas\w*|rose|fell|dropped|declined|improved|reduced)\s+(?:\w+\s+){0,2}to\s+[^\d−-]{0,12}([−-]?\d[\d.,]*)/i);
  if (!m || m.index === undefined) return null;
  const earlier = informativeNumbers(stripSpread(stripTimes(claim.slice(0, m.index))));
  const to = informativeNumbers(m[2]!)[0];
  const from = earlier[earlier.length - 1];
  if (!from || !to || from.value === to.value) return null;
  const up = /increas|rose|improved/i.test(m[1]!);
  if (/improved|reduced/i.test(m[1]!)) return null; // direction of "better" depends on the scale
  if (up ? to.value > from.value : to.value < from.value) return null;
  return {
    code: "comparison_direction",
    message: `the claim says "${m[1]} to ${to.raw}" but the earlier value is ${from.raw}; check the direction of the change in the source`,
  };
}

export function comparisonCues(claim: string, sourceText: string): Cue[] {
  const cues: Cue[] = [];
  const change = changeCue(claim);
  if (change) cues.push(change);
  const up = UP.test(claim);
  const down = DOWN.test(claim);
  if (up === down) return cues; // no comparison, or both directions (too ambiguous to read in code)

  // "higher in A (18.07) compared to B (18.90)": the claim's own values say otherwise.
  const pair = sides(claim);
  if (pair) {
    const [a, b] = pair;
    if (!change && a.value >= 0 && b.value >= 0 && a.value !== b.value && (up ? a.value < b.value : a.value > b.value)) {
      cues.push({
        code: "comparison_direction",
        message: `the claim says "${claim.match(up ? UP : DOWN)![0]}", but its own values are ${a.raw} and ${b.raw}; check which group each value belongs to in the source and whether the direction is right`,
      });
    }
  }

  // "X lowered SBP more than placebo at week 24" on a row with p = 0.231.
  const table = parseTable(sourceText);
  if (table && BETWEEN.test(claim) && !HEDGE.test(claim)) {
    const claimPs = [...claim.matchAll(/\bp\s*[=<≤]\s*(0?\.\d+)/gi)].map((m) => Number(m[1]!.startsWith(".") ? `0${m[1]}` : m[1]));
    const rows = relevantRows(claim, table);
    const ps = rows.flatMap((r) => rowPValues(table, r));
    if (!claimPs.some((p) => p <= 0.05) && ps.length && ps.every((p) => p > 0.05)) {
      cues.push({
        code: "comparison_nonsignificant",
        message: `the claim states a between-group difference as fact, but the matching row's p-value is ${ps.join(", ")} (not significant); decide whether the source supports the comparison as worded, or only a numerical difference`,
      });
    }
  }
  return cues;
}
