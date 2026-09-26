import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractClaims, splitSentences } from "./extract.js";

describe("splitSentences", () => {
  it("does not split inside decimals, et al., or Fig.", () => {
    const s = splitSentences("Mean age was 63.4 years (p = 0.05). Smith et al. 2021 found a drop. See Fig. 2 for details.");
    assert.equal(s.length, 3);
  });
});

describe("extractClaims", () => {
  it("pulls a table citation and inherits the paper's own id", () => {
    const out = extractClaims(
      "Hemoglobin rose to 12.3 g/dL in the iron arm (Table 2). The trial enrolled 240 participants.",
      "PMC1",
    );
    assert.equal(out.claims.length, 1);
    assert.equal(out.claims[0]!.citation, "PMC1, Table 2");
    assert.equal(out.claims[0]!.claim, "Hemoglobin rose to 12.3 g/dL in the iron arm.");
    assert.equal(out.uncited.length, 1);
  });

  it("reads a report-to-report citation with an explicit id", () => {
    const out = extractClaims("A prior trial reported 71% remission (Smith et al. 2021 (PMC12345)).");
    assert.equal(out.claims[0]!.citation, "PMC12345");
  });

  it("reads a submission-style citation with a dotted table number", () => {
    const out = extractClaims("The ORR was 34.2% [CSR-ABC101, Table 14.2.1].");
    assert.equal(out.claims[0]!.citation, "CSR-ABC101, Table 14.2.1");
  });

  it("skips a marker with no document when none is known", () => {
    const out = extractClaims("Scores improved by 4.5 points (Table 3).");
    assert.equal(out.claims.length, 0);
  });
});
