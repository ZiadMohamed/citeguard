# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf>=1.24", "requests>=2.31"]
# ///
"""PDF parsing test: rebuild the PMC tables store from the papers' PDFs instead of their XML.

For every paper in data/pmc/papers.jsonl:
  1. Download the PDF from the public pmc-oa-opendata S3 bucket (cached in data/pmc/pdf/).
  2. Find table captions ("Table 2 ...") in the page text, and extract table grids with
     PyMuPDF's find_tables(). Each grid is assigned to the nearest caption above it on the page;
     a grid with no caption on its page continues the previous table (tables split across pages).
  3. Write data/pmc/papers_pdf.jsonl in the same shape as papers.jsonl, so the resolver can run
     on it with --corpus pdf.
  4. Score each XML table against its PDF twin: share of the XML table's informative numbers
     found in the PDF table (what the checker needs), and whether the table was found at all.

Report: data/pmc/pdf_report.json and a printed summary.
"""

import json
import re
import sys
from pathlib import Path

import pymupdf
import requests

sys.path.insert(0, str(Path(__file__).parent))
from prep_pmc import informative_numbers  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PMC = ROOT / "data" / "pmc"
PDF_DIR = PMC / "pdf"
BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com"

# A caption is "Table 2." / "Table 2:" / "Table 2 |" at the start of a line, or "Table 2" alone
# on its line. In-text references ("Table 3 presents ...") have no punctuation after the number.
CAPTION_RE = re.compile(
    r"^\s*Table[\s\u00a0\u2000-\u200b\u202f]*(\d+)[\s\u00a0\u2000-\u200b\u202f]*"
    r"(?:[.:|\u2002\u2003]\s*(.*)|\(continued\).*|([A-Z(].*)|$)",
    re.I,
)


def caption_match(text: str):
    """A table caption, not an in-text reference ("Table 3 presents ...", "... (Table 1).")."""
    m = CAPTION_RE.match(text)
    if not m:
        return None
    rest = text[m.end(1):].lstrip(" \u00a0\u2000\u2001\u2002\u2003\u2009\u202f")
    if not rest:
        return None  # "Table 1" alone at a line end is usually a reference that wrapped
    if rest[0] in ".:|" or rest.lower().startswith("(continued") or rest[0].isupper():
        return m
    return None


def fetch_pdf(pmcid: str) -> Path | None:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    path = PDF_DIR / f"{pmcid}.pdf"
    if path.exists() and path.stat().st_size > 0:
        return path
    for version in (1, 2, 3):
        r = requests.get(f"{BUCKET}/{pmcid}.{version}/{pmcid}.{version}.pdf", timeout=60)
        if r.ok and r.content[:4] == b"%PDF":
            path.write_bytes(r.content)
            return path
    return None


def clean(text) -> str:
    return re.sub(r"[\s\u00a0\u2000-\u200b\u202f]+", " ", str(text or "")).strip()


def page_lines(page) -> list[dict]:
    """Visual lines: spans on the same baseline merged in reading order, cells split by wide gaps.

    Landscape tables printed sideways on a portrait page have vertical text. Their spans are
    rotated into a horizontal frame first (baseline = x, reading position = -y or y), and form
    their own lines after the page's horizontal lines.
    """
    groups: dict[str, list] = {"h": [], "up": [], "down": []}
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            dx, dy = line.get("dir", (1, 0))
            kind = "h" if abs(dx) >= abs(dy) else ("up" if dy < 0 else "down")
            for sp in line["spans"]:
                if not sp["text"].strip():
                    continue
                x0, y0, x1, y1 = sp["bbox"]
                if kind == "h":
                    base, a, b = y1, x0, x1
                elif kind == "up":  # text reads bottom to top; the page's right is "down" the table
                    base, a, b = x1, -y1, -y0
                else:  # reads top to bottom
                    base, a, b = -x0, y0, y1
                groups[kind].append((round(base), a, b, sp["text"]))
    lines: list[dict] = []
    for kind in ("h", "up", "down"):
        spans = sorted(groups[kind])
        start = len(lines)
        for base, a, b, text in spans:
            if len(lines) > start and abs(lines[-1]["y"] - base) <= 2:
                ln = lines[-1]
            else:
                ln = {"y": base, "spans": [], "rotated": kind != "h"}
                lines.append(ln)
            ln["spans"].append((a, b, text))
    for ln in lines:
        ln["spans"].sort()
        cells, cur, last_b = [], "", None
        for a, b, text in ln["spans"]:
            if last_b is not None and a - last_b > 8:
                cells.append(clean(cur))
                cur = ""
            cur += text
            last_b = b
        cells.append(clean(cur))
        ln["cells"] = [c for c in cells if c]
        ln["text"] = " ".join(ln["cells"])
        ln["x0"] = ln["spans"][0][0]
        ln["x1"] = ln["spans"][-1][1]
    return lines


def is_prose(ln: dict, col_width: float) -> bool:
    """A body-text line: one cell, wide, many words, few numbers."""
    words = ln["text"].split()
    nums = sum(1 for w in words if re.search(r"\d", w))
    return len(ln["cells"]) == 1 and (ln["x1"] - ln["x0"]) > 0.8 * col_width and len(words) >= 9 and nums <= len(words) * 0.3


def extract_tables(pdf_path: Path) -> dict[int, dict]:
    doc = pymupdf.open(pdf_path)
    tables: dict[int, dict] = {}
    for page in doc:
        lines = page_lines(page)
        if not lines:
            continue
        col_width = max(ln["x1"] - ln["x0"] for ln in lines)
        i = 0
        while i < len(lines):
            m = caption_match(lines[i]["text"])
            if not m:
                i += 1
                continue
            num = int(m.group(1))
            caption = [lines[i]["text"]]
            j = i + 1
            # Caption continuation: single-cell wide lines directly under the caption.
            while j < len(lines) and len(lines[j]["cells"]) == 1 and is_prose(lines[j], col_width) and len(caption) < 4:
                caption.append(lines[j]["text"])
                j += 1
            rows, prose_run = [], 0
            while j < len(lines) and not caption_match(lines[j]["text"]):
                if is_prose(lines[j], col_width):
                    prose_run += 1
                    if prose_run >= 2:
                        rows = rows[:-1]  # the first prose line was already appended
                        break
                else:
                    prose_run = 0
                rows.append(" | ".join(lines[j]["cells"]))
                j += 1
            entry = tables.setdefault(num, {"number": num, "label": f"Table {num}", "caption": clean(" ".join(caption)), "rows": [], "foot": ""})
            entry["rows"].extend(rows)
            i = j
    return tables


def score(xml_table: dict, pdf_table: dict | None) -> dict:
    xml_text = "\n".join(xml_table["rows"]) + " " + xml_table.get("foot", "")
    nums = set(informative_numbers(xml_text))
    if pdf_table is None:
        return {"found": False, "numbers": len(nums), "numberRecall": 0.0}
    pdf_nums = set(informative_numbers("\n".join(pdf_table["rows"])))
    hit = len(nums & pdf_nums)
    return {
        "found": True,
        "numbers": len(nums),
        "numberRecall": hit / len(nums) if nums else 1.0,
        "xmlRows": len(xml_table["rows"]),
        "pdfRows": len(pdf_table["rows"]),
    }


def main():
    papers = [json.loads(l) for l in open(PMC / "papers.jsonl")]
    out_rows, report = [], []
    for p in papers:
        pdf = fetch_pdf(p["id"])
        if pdf is None:
            report.append({"paper": p["id"], "pdf": False})
            out_rows.append({"id": p["id"], "title": p["title"], "tables": []})
            continue
        pdf_tables = extract_tables(pdf)
        for t in p["tables"]:
            s = score(t, pdf_tables.get(t["number"]))
            report.append({"paper": p["id"], "table": t["label"], **s})
        out_rows.append({"id": p["id"], "title": p["title"], "tables": [pdf_tables[k] for k in sorted(pdf_tables)]})
        print(f"{p['id']}: xml {len(p['tables'])} tables, pdf {len(pdf_tables)}", flush=True)

    with open(PMC / "papers_pdf.jsonl", "w") as f:
        for r in out_rows:
            f.write(json.dumps(r) + "\n")
    (PMC / "pdf_report.json").write_text(json.dumps(report, indent=2))

    tables = [r for r in report if "table" in r]
    found = [r for r in tables if r["found"]]
    exact = [r for r in found if r["numberRecall"] >= 0.999]
    good = [r for r in found if r["numberRecall"] >= 0.9]
    print(f"\n{len(papers)} papers, {sum(1 for r in report if r.get('pdf') is False)} without a PDF")
    print(f"{len(tables)} XML tables; {len(found)} found in the PDF ({len(found)/len(tables):.0%})")
    print(f"  all numbers recovered: {len(exact)} ({len(exact)/len(tables):.0%}); >=90%: {len(good)} ({len(good)/len(tables):.0%})")
    if found:
        print(f"  mean number recall on found tables: {sum(r['numberRecall'] for r in found)/len(found):.1%}")


if __name__ == "__main__":
    main()
