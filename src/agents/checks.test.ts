import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DocStore } from "../tools/store.js";
import type { AgentTrace, CheckResult, Verdict } from "../types.js";
import { objectiveFailures } from "./checks.js";

const store = new DocStore([
  {
    id: "PMC1",
    title: "t",
    sections: [
      { label: "Table 1", heading: "", kind: "table", text: "Age | 34.2" },
      { label: "Table 2", heading: "", kind: "table", text: "Hemoglobin | 12.3" },
    ],
  },
]);
const trace = (budgetExhausted = false): AgentTrace => ({
  steps: [], toolCalls: 1, llmTurns: 2, budgetExhausted, peakPromptTokens: 0,
});
const result = (verdict: Verdict, quote: string, location: string): CheckResult => ({
  verdict, quote, location, reason: "",
});
const codes = (
  r: CheckResult,
  citation = "PMC1, Table 2",
  { budgetExhausted = false, claim = "Hemoglobin was 12.3", checkNumbers = true } = {},
) =>
  objectiveFailures(
    { result: r, sourceText: "Hemoglobin | 12.3", trace: trace(budgetExhausted) },
    { claim, citation },
    store,
    { checkNumbers },
  ).map((f) => f.code);

describe("objectiveFailures", () => {
  it("accepts a grounded verdict on the cited location", () => {
    assert.deepEqual(codes(result("supported", "Hemoglobin | 12.3", "PMC1, Table 2")), []);
  });

  it("rejects invented quotes and supported verdicts without evidence", () => {
    assert.deepEqual(codes(result("not_supported", "Hemoglobin | 13.2", "Table 2")), ["ungrounded_quote"]);
    assert.deepEqual(codes(result("supported", "", "Table 2")), ["missing_quote"]);
  });

  it("rejects support drawn from somewhere other than the cited location", () => {
    assert.deepEqual(codes(result("supported", "Hemoglobin | 12.3", "PMC1, Table 1")), ["off_target"]);
    assert.deepEqual(codes(result("not_supported", "Hemoglobin | 12.3", "Table 9")), ["bad_location"]);
  });

  it("lets a wrong_target flag name the nonexistent cited table", () => {
    assert.deepEqual(codes(result("wrong_target", "", "PMC1, Table 7"), "PMC1, Table 7"), []);
  });

  it("handles citations that name only a document", () => {
    assert.deepEqual(codes(result("supported", "Hemoglobin | 12.3", "Table 2"), "Smith 2020 (PMC1)"), []);
    assert.deepEqual(codes(result("supported", "Hemoglobin | 12.3", "PMC9, Table 2"), "Smith 2020 (PMC1)"), [
      "bad_location",
      "off_target",
    ]);
  });

  it("treats budget exhaustion as a failure", () => {
    assert.deepEqual(codes(result("not_supported", "", ""), "PMC1, Table 2", { budgetExhausted: true }), [
      "budget_exhausted",
    ]);
  });

  it("rejects a supported verdict when a claim number isn't at the cited location", () => {
    const supported = result("supported", "Hemoglobin | 12.3", "PMC1, Table 2");
    assert.deepEqual(codes(supported, "PMC1, Table 2", { claim: "Hemoglobin was 13.2" }), ["number_missing"]);
    assert.deepEqual(codes(supported, "PMC1, Table 2", { claim: "Hemoglobin was 13.2", checkNumbers: false }), []);
    const flag = result("not_supported", "Hemoglobin | 12.3", "PMC1, Table 2");
    assert.deepEqual(codes(flag, "PMC1, Table 2", { claim: "Hemoglobin was 13.2" }), []);
  });

  it("checks document-level citations against the whole document", () => {
    const supported = result("supported", "Hemoglobin | 12.3", "PMC1, Table 2");
    assert.deepEqual(codes(supported, "Smith 2020 (PMC1)", { claim: "Age 34.2, hemoglobin 12.3" }), []);
    assert.deepEqual(codes(supported, "Smith 2020 (PMC1)", { claim: "Age 43.2, hemoglobin 12.3" }), ["number_missing"]);
  });
});
