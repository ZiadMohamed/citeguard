/**
 * Numbers in claims and sources. Mirrors informative_numbers() in python/prep_pmc.py, plus
 * leading-dot decimals (".026"), and skips numbers that are part of names ("IL-27", "SF-36").
 */
const NUM_RE = /(?<![\w.])(?<![A-Za-z][-‐−])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|(?<![\w.])\.\d+/g;
const IGNORED = new Set(["0.05", "0.01", "0.001", "0.0001", "95", "100"]);

export interface Num {
  raw: string;
  value: number;
  decimals: number;
  /** "12.30" -> "12.3", "1,234" -> "1234", ".5" -> "0.5". */
  norm: string;
}

export function numbersIn(text: string): Num[] {
  return [...text.matchAll(NUM_RE)].map((m) => parseNum(m[0]));
}

/** Distinct numbers that carry data: decimals, and integers >= 13 that aren't years. */
export function informativeNumbers(text: string): Num[] {
  const seen = new Map<string, Num>();
  for (const n of numbersIn(text.replace(/95\s?%\s?(?:CI|confidence)/gi, " "))) {
    if (IGNORED.has(n.norm) || seen.has(n.norm)) continue;
    const v = Math.abs(n.value);
    if (n.decimals > 0 || (v >= 13 && !(v >= 1900 && v <= 2100))) seen.set(n.norm, n);
  }
  return [...seen.values()];
}

/**
 * True if the source has the claim's number, ignoring sign ("a decrease of 2.7" vs "-2.7"), or a
 * more precise number that rounds to it (claim 75 vs 74.7 matches; 0.66 vs 0.630 doesn't).
 */
export function hasNumber(claim: Num, source: Num[]): boolean {
  const c = Math.abs(claim.value);
  const tolerance = 0.5 * 10 ** -claim.decimals + 1e-9;
  return source.some((s) => {
    const v = Math.abs(s.value);
    return v === c || (s.decimals > claim.decimals && Math.abs(v - c) <= tolerance);
  });
}

export interface MissingNumber {
  number: string;
  /** The source's closest values, as written there. */
  nearest: string[];
}

/**
 * Note for a "supported" verdict whose claim contains numbers the cited source does not.
 * Null when every informative number is present (exact, or a more precise source value that rounds to it).
 */
export function missingNumberNote(claim: string, sourceText: string, label: string): string | null {
  const missing = missingNumbers(claim, sourceText);
  if (!missing.length) return null;
  const list = missing
    .map((m) => `${m.number}${m.nearest.length ? ` (closest there: ${m.nearest.join(", ")})` : ""}`)
    .join(", ");
  return `the verdict was "supported" but the claim's ${list} ${missing.length > 1 ? "do" : "does"} not appear in ${label}. Compare every number in the claim with the source; if a number is legitimately derived from it (e.g. a difference, or a percentage computed from counts), say so in the reason`;
}

/**
 * True if a percentage in the claim is k/n of two counts on one source line ("49/200", "49 (200)",
 * "49 | 200"), rounded to the claim's precision. Only whole-number pairs on the same row count,
 * so a coincidence across the table doesn't.
 */
export function derivedPercent(claim: Num, sourceText: string): boolean {
  const tolerance = 0.5 * 10 ** -claim.decimals + 1e-9;
  for (const line of sourceText.split("\n")) {
    const ints = numbersIn(line).filter((n) => n.decimals === 0 && n.value > 0).map((n) => n.value);
    if (ints.length > 12) continue;
    for (const k of ints) for (const n of ints) {
      if (k < n && Math.abs((100 * k) / n - Math.abs(claim.value)) <= tolerance) return true;
    }
  }
  return false;
}

const PERCENT_AFTER = /^\s?%/;

/** The claim's informative numbers that don't appear in the source text. */
export function missingNumbers(claim: string, sourceText: string, nearestCount = 2): MissingNumber[] {
  const source = numbersIn(sourceText);
  const distinct = [...new Map(source.map((s) => [s.norm, s])).values()];
  const percents = new Set(
    [...claim.matchAll(NUM_RE)].filter((m) => PERCENT_AFTER.test(claim.slice(m.index! + m[0].length))).map((m) => parseNum(m[0]).norm),
  );
  return informativeNumbers(claim)
    .filter((n) => !hasNumber(n, source))
    .filter((n) => !(percents.has(n.norm) && derivedPercent(n, sourceText)))
    .map((n) => ({
      number: n.raw,
      nearest: distinct
        .map((s) => ({ s, d: Math.abs(Math.abs(s.value) - Math.abs(n.value)) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, nearestCount)
        .map(({ s }) => s.raw),
    }));
}

export interface SignConflict {
  number: string;
  /** "decrease" or "increase", from the claim's own words or its explicit sign. */
  claimDirection: "decrease" | "increase";
  /** The source's value, as written, with the opposite explicit sign. */
  source: string;
}

const DOWN = /\b(?:decreas\w*|reduc\w*|fell|fall\w*|drop\w*|declin\w*|lower\w*|loss|lost)\b[^.;]{0,40}$/i;
const UP = /\b(?:increas\w*|rose|rise|rising|gain\w*|grew|elevat\w*|rais\w*)\b[^.;]{0,40}$/i;

/**
 * Numbers whose direction in the claim contradicts an explicit sign in the source: "decreased by
 * 2.7" against "+2.7", or "-1.3" against "+1.3". Only explicit signs in the source count, since
 * tables often print a change without one; and only when the source has no same-signed copy.
 */
export function signConflicts(claim: string, sourceText: string): SignConflict[] {
  const signed = [...sourceText.matchAll(/(?<![\w.])([+\-−])\s?(\d+(?:\.\d+)?)/g)].map((m) => ({
    raw: m[0],
    sign: m[1] === "+" ? 1 : -1,
    norm: parseNum(m[2]!).norm,
  }));
  const out: SignConflict[] = [];
  for (const m of claim.matchAll(NUM_RE)) {
    const n = parseNum(m[0]);
    if (!informativeNumbers(m[0]).length) continue;
    const before = claim.slice(0, m.index!);
    const explicit = /^[-−]/.test(m[0]) ? -1 : /\+\s?$/.test(before) ? 1 : 0;
    const dir = explicit || (DOWN.test(before) ? -1 : UP.test(before) ? 1 : 0);
    if (!dir) continue;
    const abs = n.norm.replace(/^-/, "");
    const matches = signed.filter((s) => s.norm === abs);
    if (!matches.length || matches.some((s) => s.sign === dir)) continue;
    out.push({ number: m[0], claimDirection: dir < 0 ? "decrease" : "increase", source: matches[0]!.raw });
  }
  return out;
}

function parseNum(raw: string): Num {
  const s = raw.replace(/−/g, "-").replace(/,/g, "").replace(/^(-?)\./, "$10.");
  const decimals = s.includes(".") ? s.split(".")[1]!.length : 0;
  const norm = decimals ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return { raw, value: Number(s), decimals, norm: norm === "-0" ? "0" : norm };
}
