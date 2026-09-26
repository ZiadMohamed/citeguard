export const VERDICT_RULES = `Verdicts:
- "supported": the cited source directly backs the claim. Every number, direction of effect, population and qualifier in the claim matches the source (rounding to the precision the source reports is fine).
- "not_supported": the cited source is on the right topic, but it contradicts the claim, reports different numbers, is weaker than the claim (e.g. claim says "no adverse effects" but the source reports some), or does not actually establish it.
- "wrong_target": the citation does not resolve to anything, or the cited source is about something else entirely, so the claim was probably meant to cite a different source or location.

Be strict. A regulator will read this. If the claim goes beyond what the source says, it is not supported.`;

/**
 * Reading conventions that remove pedantic flags without loosening what counts as an error.
 * Added after the resolver's false alarms on the reviewed PMC sample were all of these kinds.
 */
export const READING_RULES = `Reading conventions:
- A p-value printed as 0.00 or 0.000 (or "p < 0.000") is a rounded value below 0.001, so it supports "p < 0.001".
- An evaluative word the claim attaches to a reported value ("high", "moderate level", "large reduction") is the author's reading of that value. If the source gives the scale or range, and the value is consistent with the word, do not flag it for that word alone.
- Still hold these to the letter: statistical significance or its absence, direction of effect, causal language, the time point, the population or subgroup, and every number.`;

export const OUTPUT_FORMAT = `Reply with only a JSON object:
{
  "verdict": "supported" | "not_supported" | "wrong_target",
  "quote": "<exact text copied verbatim from the source that your verdict rests on; empty string if nothing relevant>",
  "location": "<where the quote is, e.g. 'sentence 3' or 'Table 14.2.1'>",
  "reason": "<one sentence>"
}`;

/** v2 output: adds a self-reported confidence the hybrid router can escalate on. */
export const OUTPUT_FORMAT_V2 = `Reply with only a JSON object:
{
  "verdict": "supported" | "not_supported" | "wrong_target",
  "quote": "<exact text copied verbatim from the source that your verdict rests on; empty string if nothing relevant>",
  "location": "<where the quote is, e.g. 'sentence 3' or 'Table 14.2.1'>",
  "reason": "<one sentence>",
  "confidence": "high" | "low"
}
Use "low" when the verdict depends on how a word in the claim is read (a qualifier, a time point, whether a difference is significant, what "no difference" or "overall" commits to), or when you had to derive a number. Use "high" when the verdict rests on numbers and wording that can be checked directly.`;
