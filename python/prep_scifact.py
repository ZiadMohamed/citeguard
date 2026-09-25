# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Download SciFact and convert it into CiteGuard benchmark items.

Outputs (under data/scifact/):
  corpus.jsonl        one abstract per line: {id, title, text, sentences}
  items.jsonl         full benchmark (~440 citation checks)
  items_sample.jsonl  fixed, balanced 100-item sample for fast iteration

Label mapping:
  SUPPORT    -> supported
  CONTRADICT -> not_supported
  NOINFO     -> not_supported   (cited paper doesn't address the claim)
  SWAPPED    -> wrong_target    (we replace the cited paper with a random one)
"""

import io
import json
import random
import tarfile
import urllib.request
from pathlib import Path

URL = "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz"
OUT = Path(__file__).resolve().parent.parent / "data" / "scifact"
SEED = 42
N_SWAPPED = 100
SAMPLE = {"SUPPORT": 50, "CONTRADICT": 17, "NOINFO": 17, "SWAPPED": 16}

LABELS = {
    "SUPPORT": "supported",
    "CONTRADICT": "not_supported",
    "NOINFO": "not_supported",
    "SWAPPED": "wrong_target",
}


def read_jsonl(tar: tarfile.TarFile, name: str) -> list[dict]:
    f = tar.extractfile(name)
    assert f is not None, name
    return [json.loads(line) for line in f.read().decode().splitlines() if line.strip()]


def main() -> None:
    print(f"downloading {URL}")
    raw = urllib.request.urlopen(URL).read()
    tar = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
    corpus = read_jsonl(tar, "data/corpus.jsonl")
    claims = read_jsonl(tar, "data/claims_dev.jsonl")

    OUT.mkdir(parents=True, exist_ok=True)
    doc_ids = []
    with open(OUT / "corpus.jsonl", "w") as f:
        for d in corpus:
            doc_id = str(d["doc_id"])
            doc_ids.append(doc_id)
            f.write(json.dumps({
                "id": doc_id,
                "title": d["title"],
                "text": " ".join(d["abstract"]),
                "sentences": d["abstract"],
            }) + "\n")

    rng = random.Random(SEED)
    items = []
    for c in claims:
        for doc in c["cited_doc_ids"]:
            ev = c["evidence"].get(str(doc))
            kind = ev[0]["label"] if ev else "NOINFO"
            items.append({
                "id": f"scifact-{c['id']}-{doc}",
                "dataset": "scifact",
                "claim": c["claim"],
                "citation": f"[doc {doc}]",
                "targetId": str(doc),
                "label": LABELS[kind],
                "errorType": kind,
                "goldSentences": sorted({s for e in ev for s in e["sentences"]}) if ev else [],
            })

    for c in rng.sample(claims, N_SWAPPED):
        cited = {str(d) for d in c["cited_doc_ids"]}
        doc = rng.choice([d for d in doc_ids if d not in cited])
        items.append({
            "id": f"scifact-{c['id']}-swap-{doc}",
            "dataset": "scifact",
            "claim": c["claim"],
            "citation": f"[doc {doc}]",
            "targetId": doc,
            "label": "wrong_target",
            "errorType": "SWAPPED",
            "goldSentences": [],
        })

    rng.shuffle(items)
    write_items(OUT / "items.jsonl", items)

    sample = []
    for kind, n in SAMPLE.items():
        sample += [i for i in items if i["errorType"] == kind][:n]
    rng.shuffle(sample)
    write_items(OUT / "items_sample.jsonl", sample)

    counts: dict[str, int] = {}
    for i in items:
        counts[i["errorType"]] = counts.get(i["errorType"], 0) + 1
    print(f"corpus: {len(corpus)} docs | items: {len(items)} {counts} | sample: {len(sample)}")


def write_items(path: Path, items: list[dict]) -> None:
    with open(path, "w") as f:
        for i in items:
            f.write(json.dumps(i) + "\n")


if __name__ == "__main__":
    main()
