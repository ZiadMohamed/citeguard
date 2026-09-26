# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the "full" document store the tool agent searches: a stand-in for a whole submission.

  study reports   every paper cached by prep_pmc.py (data/pmc/raw, ~189): all body sections
                  except abstract/results/discussion/conclusion, plus all tables. Results prose
                  is excluded because the table benchmark's claims are verbatim results
                  sentences; leaving them in would let the agent find the unmodified original.
  references      every cited paper from prep_refs.py (data/pmcrefs): full text, since those
                  papers are the evidence for the report-cites-report claims.

Leakage filter: a study-report paragraph is dropped if it contains a benchmark claim's original
sentence, or at least half of that claim's informative numbers (only claims whose text came from
that paper are checked).

Output: data/pmc/docs_full.jsonl, one {id, title, kind, sections[]} per document.
"""

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prep_pmc as P  # noqa: E402
import prep_refs as R  # noqa: E402

DATA = P.ROOT / "data"
EXCLUDED_TOP_SECTIONS = re.compile(r"result|discussion|conclusion|limitation|finding|summary|^outcomes?$", re.I)


def norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w.%]+", " ", s.lower())).strip()


def load_claims() -> dict[str, list[dict]]:
    """Claims grouped by the paper their original sentence was taken from."""
    by_paper: dict[str, list[dict]] = {}
    for path, key in ((DATA / "pmc" / "items.jsonl", "sourcePaper"), (DATA / "pmcrefs" / "items.jsonl", "citingPaper")):
        for line in path.read_text().splitlines():
            it = json.loads(line)
            text = it.get("originalClaim") or it["claim"]
            by_paper.setdefault(it[key], []).append(
                {"text": norm_text(text), "numbers": P.informative_numbers(text)}
            )
    return by_paper


def leaks(paragraph: str, claims: list[dict]) -> bool:
    text = norm_text(paragraph)
    nums = {P.normalize_number(x) for x in P.NUM_RE.findall(paragraph)}
    for c in claims:
        if c["text"][:80] in text:
            return True
        if len(c["numbers"]) >= 2 and P.coverage_in(c["numbers"], nums) >= 0.5:
            return True
    return False


def text_sections(paragraphs: list[dict], keep=lambda p: True) -> list[dict]:
    sections: dict[str, list[str]] = {}
    for p in paragraphs:
        if keep(p):
            sections.setdefault(p["section"] or "Body", []).append(p["text"])
    return [
        {"label": label, "heading": label.split(" > ")[-1], "kind": "text", "text": "\n\n".join(texts)}
        for label, texts in sections.items()
    ]


def table_sections(tables: list[dict]) -> list[dict]:
    return [
        {
            "label": t["label"],
            "heading": t["caption"],
            "kind": "table",
            "text": "\n".join(t["rows"]) + (f"\n\nNotes: {t['foot']}" if t["foot"] else ""),
        }
        for t in tables
    ]


def main() -> None:
    claims = load_claims()
    docs, dropped, excluded = [], 0, 0

    for f in sorted((DATA / "pmc" / "raw").glob("PMC*.xml")):
        paper = P.parse_paper(f.stem, f.read_text())
        if not paper:
            continue
        own_claims = claims.get(f.stem, [])

        def keep(p: dict) -> bool:
            nonlocal dropped, excluded
            if EXCLUDED_TOP_SECTIONS.search(p["section"].split(" > ")[0]):
                excluded += 1
                return False
            if own_claims and leaks(p["text"], own_claims):
                dropped += 1
                return False
            return True

        sections = text_sections(paper["paragraphs"], keep) + table_sections(paper["tables"])
        if sections:
            docs.append({"id": f.stem, "title": paper["title"], "kind": "study", "sections": sections})
    n_study = len(docs)

    for pid in json.loads((DATA / "pmcrefs" / "references.json").read_text()):
        xml = (DATA / "pmcrefs" / "raw" / f"{pid}.xml").read_text()
        full = R.parse_full(pid, xml)
        if not full:
            continue
        abstract = [{"label": "Abstract", "heading": "Abstract", "kind": "text", "text": "\n\n".join(full["abstract"])}]
        sections = (abstract if full["abstract"] else []) + text_sections(full["paragraphs"]) + table_sections(full["tables"])
        docs.append({"id": pid, "title": full["title"], "kind": "reference", "sections": sections})

    out = DATA / "pmc" / "docs_full.jsonl"
    P.write_jsonl(out, docs)
    chars = sum(len(s["text"]) for d in docs for s in d["sections"])
    print(
        f"{n_study} study reports + {len(docs) - n_study} references -> {out.relative_to(P.ROOT)}\n"
        f"  {sum(len(d['sections']) for d in docs)} sections, {chars / 1e6:.1f}M chars (~{chars / 4e6:.1f}M tokens)\n"
        f"  study-report paragraphs excluded as results/discussion: {excluded}; dropped by leakage filter: {dropped}"
    )


if __name__ == "__main__":
    main()
