"""Builds fixtures/csr/items.jsonl and corpus.jsonl from the hand-written claims below.

A mock 52-week CSR (docs.jsonl, 7 tables) and 37 claims written by hand against it: 15 faithful
(including hedged and qualitative-but-true ones) and 22 wrong in ways a number check can't see:
qualitative safety claims, subgroup overreach, time-point scope, significance, causation,
magnitude, direction and arm swaps. Every label has a one-line reason in `note`.

  python3 fixtures/csr/build.py
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
DOC = "CSR-DRX201"
exec((HERE / "claims.py").read_text())  # defines ITEMS

docs = [json.loads(l) for l in (HERE / "docs.jsonl").read_text().splitlines() if l.strip()]
sections = {s["label"]: s for s in docs[0]["sections"]}

with open(HERE / "corpus.jsonl", "w") as f:
    for label, s in sections.items():
        f.write(json.dumps({"id": f"{DOC}/{label}", "title": s["heading"], "text": s["text"]}, ensure_ascii=False) + "\n")

rows = []
for id_, claim, table, label, err, note in ITEMS:
    assert f"Table {table}" in sections, table
    rows.append({"id": f"csr-{id_}", "dataset": "csr", "claim": claim, "citation": f"{DOC}, Table {table}",
                 "targetId": f"{DOC}/Table {table}", "label": label, "errorType": err, "note": note})
for name in ("items.jsonl", "items_sample.jsonl"):
    (HERE / name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
good = sum(r["label"] == "supported" for r in rows)
print(f"{len(rows)} items: {good} good, {len(rows) - good} bad")
