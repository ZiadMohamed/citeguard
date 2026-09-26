import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCitation } from "./resolve.js";
import { DocStore, type Document } from "./tools/store.js";

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

describe("resolveCitation", () => {
  it("resolves a named table without using an answer-key id", () => {
    const r = resolveCitation(store, "PMC1, Table 2");
    assert.equal(r.kind, "section");
    assert.equal(r.label, "PMC1, Table 2");
    assert.match(r.text, /Hemoglobin \| 12\.3/);
    assert.match(r.numberText, /Outcomes/);
  });

  it("does not resolve Table 12 to Table 1", () => {
    const r = resolveCitation(store, "PMC1, Table 12");
    assert.equal(r.kind, "missing");
    assert.match(r.reason, /no Table 12/);
  });

  it("names a missing document and an unparseable citation", () => {
    assert.match(resolveCitation(store, "PMC9, Table 2").reason, /PMC9 is not in the submission/);
    assert.match(resolveCitation(store, "see appendix").reason, /does not name a document/);
  });

  describe("submission-style citations", () => {
    const csr = new DocStore([
      ...docs,
      {
        id: "CSR-ABC101",
        title: "Clinical study report",
        aliases: ["Study ABC-101"],
        sections: [
          { label: "Table 14", heading: "Not this one", kind: "table", text: "x | 1.1" },
          { label: "Table 14.2.1", heading: "Primary endpoint", kind: "table", text: "HbA1c | -0.8" },
          { label: "Table 14.2.2", heading: "Secondary", kind: "table", text: "FPG | -1.1" },
          { label: "Listing 16.2.7", heading: "Adverse events", kind: "text", text: "..." },
        ],
      },
    ]);

    it("recognises report ids written with or without hyphens, and aliases", () => {
      for (const c of ["CSR-ABC101, Table 14.2.1", "CSR ABC-101 Table 14.2.1", "Study ABC-101, Table 14.2.1"]) {
        assert.equal(resolveCitation(csr, c).label, "CSR-ABC101, Table 14.2.1", c);
      }
    });

    it("never reads Table 14.2.1 as Table 14, or Table 1.4 as Table 14", () => {
      assert.match(resolveCitation(csr, "CSR-ABC101, Table 14.2.1").text, /HbA1c/);
      assert.equal(resolveCitation(csr, "CSR-ABC101, Table 1.4").kind, "missing");
      assert.equal(resolveCitation(csr, "CSR-ABC101, Table 14.2.9").kind, "missing");
    });

    it("resolves listings, and a list of tables as one source", () => {
      assert.equal(resolveCitation(csr, "Study ABC-101 CSR, Listing 16.2.7").label, "CSR-ABC101, Listing 16.2.7");
      const both = resolveCitation(csr, "CSR-ABC101, Tables 14.2.1 and 14.2.2");
      assert.equal(both.kind, "section");
      assert.match(both.numberText, /-0\.8[\s\S]*-1\.1/);
      assert.equal(resolveCitation(csr, "CSR-ABC101, Tables 14.2.1 and 14.2.9").kind, "missing");
    });

    it("warns when a named figure is missing and the whole document is checked instead", () => {
      const r = resolveCitation(csr, "CSR-ABC101, Figure 3");
      assert.equal(r.kind, "document");
      assert.match(r.warning, /Figure 3 is not in the parsed CSR-ABC101/);
    });
  });

  it("treats a citation with no table as the whole document", () => {
    const r = resolveCitation(store, "Smith et al. 2020 (PMC1)");
    assert.equal(r.kind, "document");
    assert.match(r.numberText, /34\.2/);
    assert.match(r.numberText, /12\.3/);
  });
});
