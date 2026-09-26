import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BenchItem } from "../types.js";
import { parseLocation, sameLocation, trueLocation } from "./locations.js";

const item = (citation: string, mutation: string | null, sourcePaper = "PMC1"): BenchItem => ({
  id: "x", dataset: "pmc", claim: "", citation, targetId: null, label: "wrong_target",
  errorType: "", sourcePaper, mutation,
});

describe("trueLocation", () => {
  it("recovers the original table for moved, nonexistent and wrong-study citations", () => {
    assert.deepEqual(trueLocation(item("PMC1, Table 2", "Table 1 -> Table 2")), { doc: "PMC1", table: "1" });
    assert.deepEqual(trueLocation(item("PMC1, Table 7", "Table 3 -> Table 7 (does not exist)")), { doc: "PMC1", table: "3" });
    assert.deepEqual(trueLocation(item("PMC2, Table 2", "PMC1 -> PMC2")), { doc: "PMC1", table: "2" });
  });

  it("is document-level for report-cites-report citations", () => {
    assert.deepEqual(trueLocation(item("Smith et al. 2020 (PMC2)", "PMC1 -> PMC2")), { doc: "PMC1", table: null });
  });
});

describe("parseLocation / sameLocation", () => {
  it("normalizes free text and falls back to the cited document", () => {
    assert.deepEqual(parseLocation("Table 3 of pmc55", "PMC1"), { doc: "PMC55", table: "3" });
    assert.deepEqual(parseLocation("Table 3", "PMC1"), { doc: "PMC1", table: "3" });
    assert.equal(parseLocation("", "PMC1"), null);
    assert.equal(parseLocation(null, "PMC1"), null);
  });

  it("only compares tables when the target names one", () => {
    assert.equal(sameLocation({ doc: "PMC1", table: "3" }, { doc: "PMC1", table: null }), true);
    assert.equal(sameLocation({ doc: "PMC1", table: null }, { doc: "PMC1", table: "3" }), false);
    assert.equal(sameLocation({ doc: "PMC2", table: "3" }, { doc: "PMC1", table: "3" }), false);
  });
});
