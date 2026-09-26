import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditDocument } from "./source-audit.js";
import type { Document } from "./tools/store.js";

const doc = (text: string, heading = "Results"): Document => ({
  id: "CSR-1",
  title: "t",
  sections: [{ label: "Table 1", heading, kind: "table", text }],
});
const codes = (text: string, heading?: string) => auditDocument(doc(text, heading)).map((f) => `${f.severity} ${f.code}`);

describe("auditDocument", () => {
  it("flags an estimate outside its own confidence interval", () => {
    assert.deepEqual(codes("Outcome | Difference (95% CI) | p\nSBP | -7.7 (-5.2, -2.1) | <0.001"), ["major estimate_outside_ci"]);
  });

  it("flags a ratio CI that excludes 1 with a non-significant p, and the reverse", () => {
    assert.deepEqual(codes("Outcome | HR (95% CI) | p\nDeath | 0.62 (0.45, 0.85) | 0.41"), ["major ci_p_disagree"]);
    assert.deepEqual(codes("Outcome | HR (95% CI) | p\nDeath | 0.90 (0.70, 1.15) | 0.003"), ["major ci_p_disagree"]);
  });

  it("accepts consistent rows, and a difference CI read against 0", () => {
    assert.deepEqual(codes("Outcome | HR (95% CI) | p\nDeath | 0.62 (0.45, 0.85) | 0.003"), []);
    assert.deepEqual(codes("Outcome | Difference (95% CI) | p\nSBP | -1.7 (-4.5, 1.1) | 0.231"), []);
  });

  it("does not read mean ± SD (CI) as an estimate, nor a median [IQR]", () => {
    assert.deepEqual(codes("Outcome | Change (95% CI) | p\nPSS | 0.35 ± 4.90 (−1.77 to 2.47) | 0.7"), []);
    assert.deepEqual(codes("Outcome | A | B | p\nAge | 57.00[49.00,72.00] | 0.00[2.00,8.00] | 0.9"), []);
  });

  it("flags an isolated percentage that is not k/N for the column", () => {
    const text = ["Characteristic | Drug (N=50) | Placebo (N=50)", "Female | 18 (36.0) | 20 (40.0)",
      "Hypertension | 19 (38.0) | 20 (40.0)", "Diabetes | 17 (7.3) | 21 (42.0)", "Smoker | 10 (20.0) | 9 (18.0)"].join("\n");
    const f = auditDocument(doc(text));
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, "major");
    assert.match(f[0]!.message, /17\/50 is 34.0%, not 7.3%/);
  });

  it("reports a header N the column never uses, once", () => {
    const text = ["Variable | Total (n = 50) | Group A (n = 25)", "Female | 41 (82) | 20 (40)", "White | 48 (96) | 25 (50)",
      "Employed | 44 (88) | 22 (44)", "Degree | 40 (80) | 19 (38)"].join("\n");
    const f = auditDocument(doc(text));
    assert.equal(f.length, 1);
    assert.match(f[0]!.message, /says N = 25, but 4 of 4 percentages in the column are of 50/);
  });

  it("leaves a run of cells on a subgroup denominator alone", () => {
    const text = ["Factor | All (N=841)", "Smoking | 310 (36.9)", "Alcohol | 535 (63.6)", "Inactive | 413 (49.1)",
      "Exposure | 51 (6.1)", "Diesel | 20 (39.2)", "Asbestos | 4 (7.8)", "Other | 30 (58.8)"].join("\n");
    assert.deepEqual(codes(text), []);
  });
});
