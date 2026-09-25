export const VERDICT_RULES = `Verdicts:
- "supported": the cited source directly backs the claim. Every number, direction of effect, population and qualifier in the claim matches the source (rounding to the precision the source reports is fine).
- "not_supported": the cited source is on the right topic, but it contradicts the claim, reports different numbers, is weaker than the claim (e.g. claim says "no adverse effects" but the source reports some), or does not actually establish it.
- "wrong_target": the citation does not resolve to anything, or the cited source is about something else entirely, so the claim was probably meant to cite a different source or location.

Be strict. A regulator will read this. If the claim goes beyond what the source says, it is not supported.`;

export const OUTPUT_FORMAT = `Reply with only a JSON object:
{
  "verdict": "supported" | "not_supported" | "wrong_target",
  "quote": "<exact text copied verbatim from the source that your verdict rests on; empty string if nothing relevant>",
  "location": "<where the quote is, e.g. 'sentence 3' or 'Table 14.2.1'>",
  "reason": "<one sentence>"
}`;
