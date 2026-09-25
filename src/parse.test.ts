import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCheckResult } from "./parse.js";

describe("parseCheckResult", () => {
  it("extracts JSON wrapped in prose and fences", () => {
    const reply = 'Here you go:\n```json\n{"verdict":"supported","quote":"x","location":"s1","reason":"r"}\n```';
    assert.equal(parseCheckResult(reply).verdict, "supported");
  });

  it("rejects unknown verdicts", () => {
    assert.throws(() => parseCheckResult('{"verdict":"maybe","quote":"","location":"","reason":""}'));
  });
});
