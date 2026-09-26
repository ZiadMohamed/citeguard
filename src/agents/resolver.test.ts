import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckInput } from "./baseline.js";
import { checkFastPath, type Ask } from "./resolver.js";
import { DocStore, type Document } from "../tools/store.js";
import { PAGE_CHARS } from "../tools/tools.js";
import type { CheckResult } from "../types.js";

const docs: Document[] = [
  {
    id: "PMC1",
    title: "Iron supplements",
    sections: [
      { label: "Table 1", heading: "Baseline", kind: "table", text: "Age | 34.2" },
      { label: "Table 2", heading: "Outcomes", kind: "table", text: "Hemoglobin | 12.3" },
    ],
  },
];

const store = new DocStore(docs);

function scripted(verdicts: CheckResult["verdict"][]): { ask: Ask; calls: CheckInput[] } {
  const calls: CheckInput[] = [];
  const ask: Ask = async (input) => {
    calls.push(input);
    const verdict = verdicts[calls.length - 1] ?? "supported";
    return {
      result: { verdict, quote: "Hemoglobin | 12.3", location: "PMC1, Table 2", reason: "scripted" },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
    };
  };
  return { ask, calls };
}

describe("checkFastPath", () => {
  it("flags a missing table without calling the model", async () => {
    const { ask, calls } = scripted(["supported"]);
    const out = await checkFastPath({ claim: "Hemoglobin was 12.3", citation: "PMC1, Table 9" }, store, "m", ask);
    assert.equal(calls.length, 0);
    assert.equal(out?.resolution, "missing");
    assert.equal(out?.result.verdict, "wrong_target");
    assert.equal(out?.usage.costUsd, 0);
    assert.match(out?.result.reason ?? "", /no Table 9/);
  });

  it("sends the resolved table, not an answer-key document", async () => {
    const { ask, calls } = scripted(["supported"]);
    const out = await checkFastPath({ claim: "Hemoglobin was 12.3", citation: "PMC1, Table 2" }, store, "m", ask);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.source?.text ?? "", /Hemoglobin \| 12\.3/);
    assert.equal(out?.resolution, "section");
    assert.equal(out?.usage.costUsd, 0.01);
  });

  it("retries once when a supported verdict is missing a claim number, then accepts the retry", async () => {
    const { ask, calls } = scripted(["supported", "not_supported"]);
    const out = await checkFastPath({ claim: "Hemoglobin was 13.2", citation: "PMC1, Table 2" }, store, "m", ask);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.note ?? "", /13\.2/);
    assert.equal(out?.result.verdict, "not_supported");
    assert.equal(out?.usage.costUsd, 0.02);
  });

  it("accepts a second supported verdict after the number note, so derived numbers can pass", async () => {
    const { ask, calls } = scripted(["supported", "supported"]);
    const out = await checkFastPath({ claim: "Hemoglobin was 13.2", citation: "PMC1, Table 2" }, store, "m", ask);
    assert.equal(calls.length, 2);
    assert.equal(out?.result.verdict, "supported");
  });

  it("leaves document-level and over-long sections to the tool agent", async () => {
    const { ask, calls } = scripted(["supported"]);
    const docLevel = await checkFastPath(
      { claim: "Hemoglobin was 12.3", citation: "Smith et al. 2020 (PMC1)" },
      store,
      "m",
      ask,
    );
    assert.equal(docLevel, null);

    const longStore = new DocStore([
      {
        id: "PMC1",
        title: "t",
        sections: [{ label: "Table 1", heading: "Big", kind: "table", text: "x".repeat(PAGE_CHARS + 1) }],
      },
    ]);
    const long = await checkFastPath({ claim: "x", citation: "PMC1, Table 1" }, longStore, "m", ask);
    assert.equal(long, null);
    assert.equal(calls.length, 0);
  });
});
