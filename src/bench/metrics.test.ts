import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunRecord, Verdict } from "../types.js";
import { summarize } from "./metrics.js";

function record(label: Verdict, predicted: Verdict | null, errorType = label): RunRecord {
  return {
    item: { id: "x", dataset: "t", claim: "", citation: "", targetId: null, label, errorType },
    model: "m",
    agent: "a",
    result: predicted ? { verdict: predicted, quote: "", location: "", reason: "" } : null,
    quoteGrounded: null,
    usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.001 },
    latencyMs: 1000,
  };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe("summarize", () => {
  it("computes catch and false-alarm rates treating any non-supported verdict as a flag", () => {
    const s = summarize([
      record("not_supported", "wrong_target"), // caught (wrong sub-verdict still counts)
      record("wrong_target", "wrong_target"), // caught
      record("not_supported", "supported"), // missed
      record("supported", "supported"), // correct pass
      record("supported", "not_supported"), // false alarm
      record("supported", null), // failed call, excluded from rates
    ]);
    assert.equal(s.failed, 1);
    close(s.catchRate.value, 2 / 3);
    close(s.falseAlarmRate.value, 1 / 2);
    close(s.flagPrecision.value, 2 / 3);
    close(s.verdictAccuracy.value, 2 / 5);
    assert.equal(s.confusion.not_supported.wrong_target, 1);
    close(s.totalCostUsd, 0.006);
  });

  it("gives a wide confidence interval for small samples", () => {
    const s = summarize([record("supported", "supported"), record("supported", "supported")]);
    assert.equal(s.falseAlarmRate.value, 0);
    assert.ok(s.falseAlarmRate.ci[1] > 0.5);
  });
});
