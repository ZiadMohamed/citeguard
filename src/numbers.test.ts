import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasNumber, informativeNumbers, missingNumbers, numbersIn, signConflicts } from "./numbers.js";

const num = (s: string) => numbersIn(s)[0]!;
const norms = (s: string) => informativeNumbers(s).map((n) => n.norm);

describe("informativeNumbers", () => {
  it("keeps data numbers and drops names, years, CIs and conventional thresholds", () => {
    assert.deepEqual(norms("IL-27 and FGF-21 were 21.5 and 34 (95% CI 20-40), p = .026, n = 1,234 in 2019, p < 0.05"), [
      "21.5",
      "34",
      "20",
      "40",
      "0.026",
      "1234",
    ]);
  });

  it("counts a repeated number once", () => {
    assert.deepEqual(norms("meeting (≥ 60 min/day) or not meeting (< 60 min/day)"), ["60"]);
  });
});

describe("hasNumber", () => {
  const has = (claim: string, source: string) => hasNumber(num(claim), numbersIn(source));

  it("accepts rounding to the claim's precision and ignores sign", () => {
    assert.equal(has("75", "74.7"), true);
    assert.equal(has("0.63", "0.630"), true);
    assert.equal(has("14.2", "14.19"), true);
    assert.equal(has("2.7", "−2.7"), true);
  });

  it("rejects different values and precision the source doesn't have", () => {
    assert.equal(has("0.66", "0.630"), false);
    assert.equal(has("0.60", "0.63"), false);
    assert.equal(has("74.73", "74.7"), false);
  });
});

describe("missingNumbers", () => {
  it("names the missing number and the source's closest values", () => {
    assert.deepEqual(missingNumbers("p = 0.66 in 134 patients", "134 | 0.630 | 0.67 | 12"), [
      { number: "0.66", nearest: ["0.67", "0.630"] },
    ]);
  });
});

describe("derived percentages", () => {
  it("accepts a percentage computed from counts on one row, and nothing else", () => {
    assert.deepEqual(missingNumbers("Adverse events occurred in 24.5% of patients.", "AE | 49/200"), []);
    assert.equal(missingNumbers("Adverse events occurred in 26.5% of patients.", "AE | 49/200").length, 1);
    assert.equal(missingNumbers("Adverse events occurred in 24.5 patients.", "AE | 49/200").length, 1);
  });
});

describe("signConflicts", () => {
  it("flags a direction that contradicts an explicit sign in the source", () => {
    assert.equal(signConflicts("Placebo decreased by 2.7 points.", "Placebo | +2.7 (14.2)")[0]?.claimDirection, "decrease");
    assert.equal(signConflicts("The difference was -1.3.", "Diff | +1.3").length, 1);
  });

  it("stays quiet when the signs agree or the source has no sign", () => {
    assert.deepEqual(signConflicts("Placebo decreased by 2.7 points.", "Placebo | -2.7"), []);
    assert.deepEqual(signConflicts("Placebo decreased by 2.7 points.", "Placebo | 2.7"), []);
  });
});
