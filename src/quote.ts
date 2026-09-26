/**
 * Checks that a quote the model returned really appears in the source.
 * Tolerates whitespace, case, punctuation and quote-style differences. "..." and
 * line breaks split the quote into fragments (e.g. non-adjacent table rows); every
 * fragment must appear somewhere in the source.
 */
export function isQuoteGrounded(quote: string, source: string): boolean {
  const fragments = splitQuote(quote);
  return fragments.length > 0 && ungroundedFragments(quote, source).length === 0;
}

/** The fragments of a quote (as the model wrote them) that don't appear in the source. */
export function ungroundedFragments(quote: string, source: string): string[] {
  const haystack = normalize(source);
  return splitQuote(quote).filter((f) => !haystack.includes(normalize(f)));
}

function splitQuote(quote: string): string[] {
  return quote
    .replace(/^\s*Title:\s*/i, "")
    .split(/\.\.\.|…|\n/)
    .filter((f) => normalize(f).length > 0)
    .map((f) => f.trim());
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`]/g, "")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/[^\p{L}\p{N}%.<>=±-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
