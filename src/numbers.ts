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

/** The claim's informative numbers that don't appear in the source text. */
export function missingNumbers(claim: string, sourceText: string, nearestCount = 2): MissingNumber[] {
  const source = numbersIn(sourceText);
  const distinct = [...new Map(source.map((s) => [s.norm, s])).values()];
  return informativeNumbers(claim)
    .filter((n) => !hasNumber(n, source))
    .map((n) => ({
      number: n.raw,
      nearest: distinct
        .map((s) => ({ s, d: Math.abs(Math.abs(s.value) - Math.abs(n.value)) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, nearestCount)
        .map(({ s }) => s.raw),
    }));
}

function parseNum(raw: string): Num {
  const s = raw.replace(/−/g, "-").replace(/,/g, "").replace(/^(-?)\./, "$10.");
  const decimals = s.includes(".") ? s.split(".")[1]!.length : 0;
  const norm = decimals ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return { raw, value: Number(s), decimals, norm: norm === "-0" ? "0" : norm };
}
