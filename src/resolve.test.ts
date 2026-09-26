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

  it("treats a citation with no table as the whole document", () => {
    const r = resolveCitation(store, "Smith et al. 2020 (PMC1)");
    assert.equal(r.kind, "document");
    assert.match(r.numberText, /34\.2/);
    assert.match(r.numberText, /12\.3/);
  });
});
