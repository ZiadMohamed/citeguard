/**
 * Checks that a quote the model returned really appears in the source.
 * Tolerates whitespace, case, punctuation and quote-style differences, and
 * treats "..." as a gap (each fragment must appear, in order).
 */
export function isQuoteGrounded(quote: string, source: string): boolean {
  const fragments = quote
    .split(/\.\.\.|…/)
    .map(normalize)
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return false;

  const haystack = normalize(source);
  let from = 0;
  for (const fragment of fragments) {
    const idx = haystack.indexOf(fragment, from);
    if (idx === -1) return false;
    from = idx + fragment.length;
  }
  return true;
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
