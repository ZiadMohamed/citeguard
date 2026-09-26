import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestFix, wordDiff } from "./fixer.js";
import { DocStore } from "../tools/store.js";

const store = new DocStore([
  { id: "CSR-1", title: "t", sections: [
    { label: "Table 2", heading: "Efficacy", kind: "table", text: "Week | Drug | Placebo\nWeek 12 | -11.8 | -4.1" },
    { label: "Table 3", heading: "Safety", kind: "table", text: "Event | Drug\nDizziness | 19 (9.0)" },
  ] },
]);

describe("wordDiff", () => {
  it("marks removed and added words", () => {
    assert.equal(wordDiff("difference was 7.9 mmHg", "difference was -7.7 mmHg"), "difference was [-7.9-] {+-7.7+} mmHg");
    assert.equal(wordDiff("a b c", "a b c"), "a b c");
  });
});

describe("suggestFix", () => {
  it("offers nothing for a supported verdict, with no model call", async () => {
    const f = await suggestFix({ claim: "x", citation: "CSR-1, Table 2" }, { verdict: "supported", quote: "", location: "", reason: "" }, store, "m");
    assert.equal(f.text, null);
    assert.equal(f.usage.costUsd, 0);
  });
  it("says so when no section holds the claim's numbers (wrong target, no model call)", async () => {
    const f = await suggestFix(
      { claim: "Headache was 33.3% on drug", citation: "CSR-1, Table 2" },
      { verdict: "wrong_target", quote: "", location: "", reason: "" }, store, "m",
    );
    assert.equal(f.citation, undefined);
    assert.match(f.note, /no section holds/);
  });
});
