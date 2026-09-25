/**
 * Checks that a quote the model returned really appears in the source.
 * Tolerates whitespace, case, punctuation and quote-style differences. "..." and
 * line breaks split the quote into fragments (e.g. non-adjacent table rows); every
 * fragment must appear somewhere in the source.
 */
export function isQuoteGrounded(quote: string, source: string): boolean {
  const fragments = quote
    .replace(/^\s*Title:\s*/i, "")
    .split(/\.\.\.|…|\n/)
    .map(normalize)
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return false;

  const haystack = normalize(source);
  return fragments.every((f) => haystack.includes(f));
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
