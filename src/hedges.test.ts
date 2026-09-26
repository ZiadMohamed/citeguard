import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overstatementCues } from "./hedges.js";

const codes = (claim: string, source = "") => overstatementCues(claim, source).map((c) => c.code);

describe("overstatementCues", () => {
  it("flags the four edits every model missed", () => {
    assert.deepEqual(codes("No differences were observed in age (P = 0.535)."), ["absolute_no_difference"]);
    assert.deepEqual(codes("The interaction was nonsignificant (p = 0.230), showing parallel improvement."), ["certainty_on_nonsignificant"]);
    // A table with no p-values can't show the trend was significant, so the cue fires; one showing p = 0.01 can.
    assert.deepEqual(codes("Scores remained higher, suggesting a favorable trend.", "Score | 35.10 | 31.96"), ["unqualified_trend"]);
    assert.deepEqual(codes("Scores remained higher, suggesting a favorable trend.", "Score | 35.10 | 31.96 | p = 0.01"), []);
    assert.deepEqual(codes("Scores remained higher, suggesting a favorable trend.", "Score | 35.10 | 31.96 | p = 0.12"), ["unqualified_trend"]);
    assert.deepEqual(codes("Overall, this gap increased (p = 0.001).", "Baseline | 12.1\n3 months | 18.54\n6 months | 16.2"), ["scope_dropped"]);
  });

  it("stays quiet on the hedged originals", () => {
    assert.deepEqual(codes("No significant differences were observed in age (P = 0.535)."), []);
    assert.deepEqual(codes("The interaction was nonsignificant (p = 0.230), suggesting parallel improvement."), []);
    assert.deepEqual(codes("Scores were higher, a nonsignificant trend.", "p = 0.12"), []);
    assert.deepEqual(codes("By 3 months, this gap increased (p = 0.001).", "Baseline | 12.1\n3 months | 18.54\n6 months | 16.2"), []);
  });
});

describe("comparison cues", () => {
  const TABLE = [
    "Time point | Drug X (N=210) | Placebo (N=205) | Difference (95% CI) | p-value",
    "Week 12, LS mean change (SE) | -11.8 (0.9) | -4.1 (0.9) | -7.7 (-10.2, -5.2) | <0.001",
    "Week 24, LS mean change (SE) | -12.6 (1.0) | -10.9 (1.0) | -1.7 (-4.5, 1.1) | 0.231",
  ].join("\n");

  it("asks about a comparison stated as fact on a non-significant row", () => {
    assert.deepEqual(codes("Drug X lowered systolic blood pressure more than placebo at week 24.", TABLE), ["comparison_nonsignificant"]);
  });

  it("stays quiet on significant rows and hedged wording", () => {
    assert.deepEqual(codes("Drug X lowered systolic blood pressure more than placebo at week 12.", TABLE), []);
    assert.deepEqual(codes("Drug X lowered blood pressure numerically more than placebo at week 24.", TABLE), []);
    assert.deepEqual(codes("At week 24 the reduction was similar, lower than placebo but not significant.", TABLE), []);
  });

  it("asks when the comparative word contradicts the claim's own values", () => {
    assert.deepEqual(codes("The mean age was slightly higher in the intervention group (18.07 years) compared to the control group (18.90 years)."), ["comparison_direction"]);
    assert.deepEqual(codes("The mean age was slightly lower in the intervention group (18.07 years) compared to the control group (18.90 years)."), []);
  });
});

describe("change-direction cue", () => {
  it("asks when 'decreased to' goes up", () => {
    assert.deepEqual(codes("The control group had a pre-intervention score of 55.89 ± 10.13, which decreased to 98.12 ± 7.96 post-intervention."), ["comparison_direction"]);
    assert.deepEqual(codes("The control group had a pre-intervention score of 55.89 ± 10.13, which increased to 98.12 ± 7.96 post-intervention."), []);
  });
  it("does not read a time point as the starting value", () => {
    assert.deepEqual(codes("At 24 months, cumulative costs decreased slightly to US $17,428."), []);
  });
});
