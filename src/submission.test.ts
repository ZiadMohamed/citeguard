import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanSubmission } from "./submission.js";
import { DocStore } from "./tools/store.js";

const store = new DocStore([
  {
    id: "CSR-ABC101",
    title: "CSR",
    aliases: ["Study ABC-101"],
    sections: [
      { label: "Table 14.2.1", heading: "Primary endpoint", kind: "table", text: "HbA1c change | -0.84 | -0.12 | p = 0.003" },
      { label: "Table 14.3.1", heading: "Adverse events", kind: "table", text: "Nausea | 24 (12.1) | 9 (4.6)" },
    ],
  },
]);

describe("scanSubmission", () => {
  it("resolves cited claims and points uncited numbers at the table that has them", () => {
    const scan = scanSubmission(
      [{ doc: "CSR-ABC101", text: "HbA1c fell by 0.84% [Study ABC-101, Table 14.2.1]. Nausea occurred in 12.1% versus 4.6% of patients. See Figure 9 [CSR-ABC101, Figure 9]." }],
      store,
    );
    assert.equal(scan.claims[0]!.citation, "CSR-ABC101, Table 14.2.1");
    assert.equal(scan.claims[0]!.resolution, "section");
    assert.deepEqual(scan.uncited[0]!.suggestions, ["CSR-ABC101, Table 14.3.1"]);
    assert.match(scan.claims.find((c) => /Figure 9/.test(c.citation))!.problem!, /not in the parsed/);
  });
});
