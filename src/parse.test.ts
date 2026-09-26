import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCheckResult } from "./parse.js";

describe("parseCheckResult", () => {
  it("extracts JSON wrapped in prose and fences", () => {
    const reply = 'Here you go:\n```json\n{"verdict":"supported","quote":"x","location":"s1","reason":"r"}\n```';
    assert.equal(parseCheckResult(reply).verdict, "supported");
  });

  it("accepts a quote with a raw tab or newline copied from PDF text", () => {
    const reply = '{"verdict":"supported","quote":"Age\t65.6\nSex","location":"Table 1","reason":"r"}';
    assert.equal(parseCheckResult(reply).quote, "Age\t65.6\nSex");
  });

  it("repairs trailing commas and a reply cut off mid-object", () => {
    assert.equal(parseCheckResult('{"verdict":"not_supported","quote":"","location":"T2","reason":"r",}').verdict, "not_supported");
    assert.equal(parseCheckResult('{"verdict":"supported","quote":"x","location":"T2","reason":"cut').reason, "cut");
  });

  it("repairs trailing commas and a reply cut off mid-object", () => {
    assert.equal(parseCheckResult('{"verdict":"not_supported","quote":"","location":"T2","reason":"r",}').verdict, "not_supported");
    assert.equal(parseCheckResult('{"verdict":"supported","quote":"x","location":"T2","reason":"cut').reason, "cut");
  });

  it("rejects unknown verdicts", () => {
    assert.throws(() => parseCheckResult('{"verdict":"maybe","quote":"","location":"","reason":""}'));
  });
});
