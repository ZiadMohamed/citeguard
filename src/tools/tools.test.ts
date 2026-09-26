import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChunks, SearchIndex, tokenize } from "./search.js";
import { DocStore, paginate, type Document } from "./store.js";
import { ToolBox } from "./tools.js";

const docs: Document[] = [
  {
    id: "PMC1",
    title: "Iron supplements in anemia",
    sections: [
      { label: "Table 1", heading: "Baseline", kind: "table", text: "Variable | Iron | Placebo\nAge | 34.2 | 35.1" },
      { label: "Table 2", heading: "Outcomes", kind: "table", text: "Outcome | Iron | Placebo | p\nHemoglobin | 12.30 | 11.8 | 0.455" },
    ],
  },
  {
    id: "PMC2",
    title: "Exercise after surgery",
    sections: [{ label: "Table 2", heading: "Outcomes", kind: "table", text: "Outcome | A | B\nPain | 3.1 | 4,200" }],
  },
];

const store = new DocStore(docs);
const toolbox = () => new ToolBox(store, new SearchIndex(buildChunks(store)));

describe("tokenize", () => {
  it("keeps decimals and thousands together and normalizes them", () => {
    assert.deepEqual(tokenize("p = 0.455, n=1,234; 12.30% (95% CI)"), ["p", "0.455", "n", "1234", "12.3", "95", "ci"]);
  });
});

describe("paginate", () => {
  it("splits at line boundaries and never loses text", () => {
    const text = ["aaaa", "bbbb", "cccc", "x".repeat(12)].join("\n");
    const pages = paginate(text, 10);
    assert.ok(pages.every((p) => p.length <= 10));
    assert.equal(pages.join("").replace(/\n/g, ""), text.replace(/\n/g, ""));
  });
});

describe("ToolBox", () => {
  it("reads a section case-insensitively and records it as evidence", () => {
    const tb = toolbox();
    const out = tb.run("read_section", { doc_id: "pmc1", section: "table 2" });
    assert.equal(out.error, false);
    assert.match(out.text, /Hemoglobin \| 12.30/);
    assert.match(tb.evidence.join("\n"), /0\.455/);
  });

  it("accepts a pasted outline line but never resolves a missing table to a different one", () => {
    const tb = toolbox();
    assert.equal(tb.run("read_section", { doc_id: "PMC1", section: 'Table 2: Outcomes' }).error, false);
    assert.equal(tb.run("read_section", { doc_id: "PMC1", section: '"Table 1" (caption: Baseline)' }).error, false);
    assert.equal(tb.run("read_section", { doc_id: "PMC1", section: "Table 12" }).error, true);
  });

  it("reports missing documents and sections with what is available", () => {
    const tb = toolbox();
    assert.equal(tb.run("get_outline", { doc_id: "PMC9" }).error, true);
    const out = tb.run("read_section", { doc_id: "PMC1", section: "Table 7" });
    assert.equal(out.error, true);
    assert.match(out.text, /Available: Table 1, Table 2/);
  });

  it("finds rows by exact numbers, across documents or within one", () => {
    const tb = toolbox();
    assert.match(tb.run("search", { query: "12.3 0.455" }).text, /^1\. PMC1, Table 2: Hemoglobin/m);
    assert.match(tb.run("search", { query: "4200" }).text, /PMC2, Table 2: Pain/);
    assert.match(tb.run("search", { query: "4200", doc_id: "PMC1" }).text, /No results/);
  });
});
