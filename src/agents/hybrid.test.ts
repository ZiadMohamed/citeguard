import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocStore } from "../tools/store.js";
import { checkHybrid, escalationReason, type Escalate, type HybridConfig } from "./hybrid.js";
import type { CheckResult } from "../types.js";

const esc = (...e: Escalate[]) => new Set(e);
const fast = (v: CheckResult["verdict"], extra: { confidence?: "high" | "low"; cues?: string } = {}) => ({
  result: { verdict: v, quote: "", location: "", reason: "", confidence: extra.confidence },
  cues: extra.cues,
});

describe("escalationReason", () => {
  it("escalates flags when asked", () => {
    assert.equal(escalationReason(fast("not_supported"), esc("flags")), "flag");
    assert.equal(escalationReason(fast("not_supported"), esc("cues")), null);
  });
  it("escalates a pass only when code raised a cue", () => {
    assert.equal(escalationReason(fast("supported", { cues: "no difference" }), esc("cues")), "pass despite cues");
    assert.equal(escalationReason(fast("supported"), esc("cues")), null);
  });
  it("escalates only low-confidence passes", () => {
    assert.equal(escalationReason(fast("supported", { confidence: "low" }), esc("lowconf")), "low-confidence pass");
    assert.equal(escalationReason(fast("supported", { confidence: "high" }), esc("lowconf")), null);
  });
  it("escalates every pass as a second opinion", () => {
    assert.equal(escalationReason(fast("supported"), esc("passes")), "pass");
  });
  it("escalates passes on claims with judgment language only", () => {
    assert.equal(escalationReason(fast("supported"), esc("judgment"), "Scores were significantly higher (p = 0.01)"), "judgment claim");
    assert.equal(escalationReason(fast("supported"), esc("judgment"), "Mean age was 63.4 (SD 10.4) years"), null);
  });
});

describe("checkHybrid", () => {
  it("decides a missing table in code, with no model call", async () => {
    const store = new DocStore([
      { id: "PMC1", title: "t", sections: [{ label: "Table 1", heading: "h", kind: "table", text: "a | 1" }] },
    ]);
    const cfg: HybridConfig = { fast: "fast", strong: "strong", escalate: esc("flags"), retries: 0 };
    const out = await checkHybrid({ claim: "x was 12.3", citation: "PMC1, Table 4" }, store, () => {
      throw new Error("no tools expected");
    }, cfg);
    assert.equal(out.decidedBy, "code");
    assert.equal(out.result.verdict, "wrong_target");
    assert.equal(out.usage.costUsd, 0);
  });
});
