# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build a report-cites-report benchmark: sentences in the PMC papers that cite another paper.

In an FDA submission, reports cite other reports and the literature references filed with
them. The research-paper analog is one paper citing another ("Fahey et al. reported safety
in 52 patients [27]"). Unlike the table benchmark, the citation names only a document, so
the checker has to find the evidence inside a long full-text paper.

Ground truth uses the same number-matching trick as prep_pmc.py: a citing sentence is kept
as a known-good claim only if >=80% of its informative numbers appear together in a single
paragraph or table of the cited paper. Half the claims then get one injected error.

Outputs (under data/pmcrefs/):
  raw/<pmcid>.xml        cached JATS XML of cited papers
  idconv.json            cache of PMID/DOI -> PMCID lookups
  references.json        PMCIDs of every cited paper that goes into the document store
  corpus.jsonl           one SourceDoc per cited paper (full text), for the baseline agent
  items.jsonl            all benchmark items
  items_sample.jsonl     balanced sample
"""

import difflib
import json
import os
import random
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prep_pmc as P  # noqa: E402

PMC_RAW = P.ROOT / "data" / "pmc" / "raw"
OUT = P.ROOT / "data" / "pmcrefs"
RAW = OUT / "raw"
CITING = OUT / "citing"
N_EXTRA_CITING = 250
SEED = 11
MIN_UNIT_COVERAGE = 0.8
MAX_CLAIMS_PER_CITING_PAPER = 6
MAX_CLAIMS_PER_CITED_PAPER = 3
MUTATION_TYPES = ["value_mismatch", "wrong_study", "nonexistent_target", "overstated_subtle"]
LABEL_FOR = {
    "SUPPORTED": "supported",
    "value_mismatch": "not_supported",
    "overstated_subtle": "not_supported",
    "wrong_study": "wrong_target",
    "nonexistent_target": "wrong_target",
}
IDCONV = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"

# ---------------------------------------------------------------- citing side


def extra_citing_papers() -> list[Path]:
    """More RCT papers from the same Europe PMC search, used only as citing papers (not added
    to the study-report corpus). Picks up after the 300 candidates prep_pmc.py already used."""
    cache = OUT / "citing_candidates.json"
    if cache.exists():
        ids = json.loads(cache.read_text())
    else:
        ids, cursor = [], "*"
        for _ in range(6):
            qs = urllib.parse.urlencode({"query": P.SEARCH_QUERY, "format": "json", "pageSize": 100,
                                         "resultType": "lite", "cursorMark": cursor})
            data = json.loads(urllib.request.urlopen(f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?{qs}").read())
            ids += [r["pmcid"] for r in data["resultList"]["result"] if r.get("pmcid")]
            cursor = data.get("nextCursorMark", cursor)
        cache.write_text(json.dumps(ids))
    known = {f.stem for f in PMC_RAW.glob("PMC*.xml")} | set(json.loads((PMC_RAW / "candidates.json").read_text()))
    ids = [i for i in ids if i not in known][:N_EXTRA_CITING]
    CITING.mkdir(parents=True, exist_ok=True)

    def fetch(pmcid: str) -> Path | None:
        path = CITING / f"{pmcid}.xml"
        if path.exists():
            return path
        for version in (1, 2, 3):
            try:
                url = f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.{version}/{pmcid}.{version}.xml"
                path.write_bytes(urllib.request.urlopen(url, timeout=60).read())
                return path
            except Exception:
                continue
        return None

    with ThreadPoolExecutor(16) as ex:
        return [p for p in ex.map(fetch, ids) if p]


def parse_refs(root: ET.Element) -> dict[str, dict]:
    """Reference list: rid -> ids and a short author-year label."""
    out = {}
    for ref in root.iter("ref"):
        ids = {p.get("pub-id-type"): (p.text or "").strip() for p in ref.iter("pub-id")}
        pmcid = ids.get("pmcid") or ids.get("pmc")
        if pmcid and not pmcid.upper().startswith("PMC"):
            pmcid = f"PMC{pmcid}"
        surnames = [s.text for s in ref.iter("surname") if s.text]
        collab = ref.find(".//collab")
        year_el = ref.find(".//year")
        year = re.match(r"\d{4}", (year_el.text or "") if year_el is not None else "")
        if len(surnames) >= 3:
            author = f"{surnames[0]} et al."
        elif len(surnames) == 2:
            author = f"{surnames[0]} and {surnames[1]}"
        elif surnames:
            author = surnames[0]
        else:
            author = P.text_of(collab, set()) if collab is not None else None
        out[ref.get("id")] = {
            "pmcid": pmcid.upper() if pmcid else None,
            "pmid": ids.get("pmid"),
            "doi": ids.get("doi"),
            "label": f"{author} {year.group(0)}" if author and year else None,
        }
    return out


def cited_sentences(p: ET.Element) -> list[tuple[str, list[str]]]:
    """Sentences of a paragraph with their bibliography xrefs removed, plus the cited ref ids.
    A single xref covering a range ("12-14") counts as several refs."""
    parts: list[str] = []
    spans: list[tuple[int, int, list[str]]] = []

    def walk(el: ET.Element) -> None:
        if el.text:
            parts.append(el.text)
        for c in el:
            tag = P.local(c.tag)
            if tag == "xref" and c.get("ref-type") == "bibr":
                start = sum(map(len, parts))
                label = P.text_of(c, set())
                rids = c.get("rid", "").split()
                if re.search(r"\d\s*[–,-]\s*\d", label):
                    rids = rids + ["<range>"]
                parts.append(label)
                spans.append((start, start + len(label), rids))
            elif tag not in P.SKIP_TAGS:
                walk(c)
            if c.tail:
                parts.append(c.tail)

    walk(p)
    text = "".join(parts)
    out, pos = [], 0
    for s in P.split_sentences(text):
        i = text.find(s, pos)
        if i < 0:
            continue
        pos = i + len(s)
        inside = [sp for sp in spans if i <= sp[0] < i + len(s)]
        rids = sorted({r for sp in inside for r in sp[2]})
        cleaned = s
        for a, b, _ in sorted(inside, reverse=True):
            cleaned = cleaned[: a - i] + cleaned[b - i:]
        out.append((tidy(cleaned), rids))
    return out


def tidy(s: str) -> str:
    s = re.sub(r"[\[(]\s*[,;–\- ]*\s*[\])]", "", s)
    s = re.sub(r"\s+([.,;:])", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def is_claim_text(s: str) -> bool:
    return 40 <= len(s) <= 400 and not re.search(r"\b(Tables?|Figures?|Fig\.)\b", s)


# ---------------------------------------------------------------- cited side


def fetch_cited(pmcid: str) -> str | None:
    path = RAW / f"{pmcid}.xml"
    if path.exists():
        return path.read_text()
    for version in (1, 2, 3):
        try:
            url = f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.{version}/{pmcid}.{version}.xml"
            text = urllib.request.urlopen(url, timeout=60).read().decode()
            path.write_text(text)
            return text
        except Exception:
            continue
    return None


def parse_full(pmcid: str, xml: str) -> dict | None:
    """Full paper as evidence units: abstract paragraphs, body paragraphs, tables."""
    paper = P.parse_paper(pmcid, xml)
    if not paper:
        return None
    root = ET.fromstring(xml)
    abstracts = root.findall(".//article-meta/abstract")
    main = next((a for a in abstracts if not a.get("abstract-type")), abstracts[0] if abstracts else None)
    abstract = [P.text_of(p) for p in main.iter("p")] if main is not None else []
    units = [("Abstract", t) for t in abstract if t]
    units += [(p["section"] or "Body", p["text"]) for p in paper["paragraphs"] if p["text"]]
    units += [(t["label"], " ".join(t["rows"]) + " " + t["foot"]) for t in paper["tables"]]
    return {
        "id": pmcid,
        "title": paper["title"],
        "abstract": abstract,
        "paragraphs": paper["paragraphs"],
        "tables": paper["tables"],
        "units": [(label, {P.normalize_number(x) for x in P.NUM_RE.findall(text)}) for label, text in units],
    }


def all_numbers(doc: dict) -> set[str]:
    return set().union(*(nums for _, nums in doc["units"])) if doc["units"] else set()


def best_unit(nums: list[str], doc: dict) -> tuple[float, str]:
    return max(((P.coverage_in(nums, un), label) for label, un in doc["units"]), default=(0.0, ""))


def idconv(ids: list[str], idtype: str, cache: dict) -> None:
    todo = [i for i in ids if i not in cache]
    for k in range(0, len(todo), 100 if idtype == "pmid" else 20):
        batch = todo[k: k + (100 if idtype == "pmid" else 20)]
        qs = urllib.parse.urlencode(
            {"ids": ",".join(batch), "idtype": idtype, "format": "json", "tool": "citeguard", "email": "dev@example.com"}
        )
        try:
            data = json.loads(urllib.request.urlopen(f"{IDCONV}?{qs}", timeout=60).read())
        except Exception as e:
            print(f"  idconv {idtype} batch failed: {e}")
            continue
        for r in data.get("records", []):
            cache[str(r.get("requested-id"))] = r.get("pmcid")
        for i in batch:
            cache.setdefault(i, None)


def source_doc(doc: dict) -> dict:
    parts = []
    if doc["abstract"]:
        parts.append("Abstract\n" + "\n".join(doc["abstract"]))
    section = None
    for p in doc["paragraphs"]:
        if p["section"] != section:
            section = p["section"]
            parts.append(f"{section or 'Body'}")
        parts[-1] += "\n" + p["text"]
    for t in doc["tables"]:
        parts.append(f"{t['label']}: {t['caption']}\n" + "\n".join(t["rows"]) + (f"\nNotes: {t['foot']}" if t["foot"] else ""))
    return {"id": doc["id"], "title": f"{doc['id']}: {doc['title']}", "text": "\n\n".join(parts)}


# ---------------------------------------------------------------- mutations


def perturb_pmcid(pmcid: str, taken: set[str], rng: random.Random) -> str:
    digits = pmcid[3:]
    for _ in range(100):
        pos = rng.randrange(len(digits) - 3, len(digits))
        d = str((int(digits[pos]) + rng.randint(1, 9)) % 10)
        cand = f"PMC{digits[:pos]}{d}{digits[pos + 1:]}"
        if cand not in taken:
            return cand
    raise RuntimeError("could not perturb pmcid")


def mutate(c: dict, kind: str, docs: dict, taken: set[str], rng: random.Random) -> dict | None:
    m = dict(c, errorType=kind, originalClaim=c["claim"])
    cited = docs[c["cited"]]
    if kind == "value_mismatch":
        in_unit = [n for n in c["numbers"] if n in all_numbers(cited)]
        rng.shuffle(in_unit)
        for old in in_unit:
            new = P.perturb_number(old, all_numbers(cited), rng)
            text = P.replace_number_in_text(c["claim"], old, new) if new else None
            if text:
                return dict(m, claim=text, mutation=f"{old} -> {new}")
        return None
    if kind == "wrong_study":
        pool = [
            pid for pid, d in docs.items()
            if pid != c["cited"] and P.coverage_in(c["numbers"], all_numbers(d)) < 0.3
        ]
        same_paper = [pid for pid in pool if pid in c["siblings"]]
        choice = rng.choice(same_paper or pool) if pool else None
        if not choice:
            return None
        # Keep the original author-year label: claims often name the author ("Smith et al.
        # reported..."), and a mismatched label would give the error away without reading.
        return dict(m, cited=choice, mutation=f"{c['cited']} -> {choice}")
    if kind == "nonexistent_target":
        fake = perturb_pmcid(c["cited"], taken, rng)
        return dict(m, cited=fake, missing=True, mutation=f"{c['cited']} -> {fake} (not in submission)")
    if kind == "overstated_subtle":
        text = rewrite_subtle(c["claim"])
        return dict(m, claim=text, mutation=f"{kind} rewrite") if text else None
    raise ValueError(kind)


REWRITE_CACHE = OUT / "rewrites.json"


def rewrite_subtle(claim: str) -> str | None:
    """Same prompt and checks as prep_pmc.py, with its own cache and a larger token limit
    (reasoning tokens made some 400-token calls return nothing). Past failures are retried."""
    cache = json.loads(REWRITE_CACHE.read_text()) if REWRITE_CACHE.exists() else {}
    if cache.get(claim) is None:
        cache[claim] = call_rewrite(claim)
        REWRITE_CACHE.write_text(json.dumps(cache, indent=1))
    text = cache[claim]
    if not text or text == claim or sorted(P.informative_numbers(text)) != sorted(P.informative_numbers(claim)):
        return None
    if difflib.SequenceMatcher(None, claim, text).ratio() < 0.85:
        return None
    return text


def call_rewrite(claim: str) -> str | None:
    body = json.dumps({
        "model": P.REWRITE_MODEL,
        "messages": [{"role": "user", "content": f"{P.REWRITE_PROMPTS['overstated_subtle']}\n\nSentence: {claim}"}],
        "temperature": 0.7,
        "max_tokens": 3000,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"},
    )
    try:
        out = json.loads(urllib.request.urlopen(req, timeout=180).read())
        content = out["choices"][0]["message"]["content"]
        return content.strip().strip('"') if content else None
    except Exception as e:
        print(f"  rewrite failed: {e}")
        return None


# ---------------------------------------------------------------- main


def main() -> None:
    P.load_env()
    RAW.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    study_ids = {f.stem for f in PMC_RAW.glob("PMC*.xml")}

    citing_files = sorted(PMC_RAW.glob("PMC*.xml")) + sorted(extra_citing_papers())
    print(f"{len(citing_files)} citing papers")
    candidates = []
    for f in citing_files:
        try:
            root = ET.fromstring(f.read_text())
        except ET.ParseError:
            continue
        refs = parse_refs(root)
        body = root.find("body")
        if body is None:
            continue
        for p in body.iter("p"):
            for claim, rids in cited_sentences(p):
                if len(rids) != 1 or rids[0] not in refs or not is_claim_text(claim):
                    continue
                nums = P.informative_numbers(claim)
                if len(nums) >= 2:
                    candidates.append({"citing": f.stem, "claim": claim, "rid": rids[0], "numbers": nums, "refs": refs})
    print(f"{len(candidates)} candidate sentences cite one reference and have >=2 informative numbers")

    cache_path = OUT / "idconv.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    all_refs = [r for c in candidates for r in [c["refs"][c["rid"]]]]
    idconv(sorted({r["pmid"] for r in all_refs if r["pmid"] and not r["pmcid"]}), "pmid", cache)
    idconv(sorted({r["doi"] for r in all_refs if r["doi"] and not r["pmcid"] and not r["pmid"]}), "doi", cache)
    cache_path.write_text(json.dumps(cache, indent=0))

    def resolve(ref: dict) -> str | None:
        return ref["pmcid"] or cache.get(ref["pmid"] or "") or cache.get(ref["doi"] or "")

    for c in candidates:
        c["cited"] = resolve(c["refs"][c["rid"]])
        c["citeLabel"] = c["refs"][c["rid"]]["label"]
    candidates = [c for c in candidates if c["cited"] and c["cited"] not in study_ids and c["citeLabel"]]
    cited_ids = sorted({c["cited"] for c in candidates})
    print(f"{len(candidates)} resolve to a PMCID ({len(cited_ids)} cited papers)")

    with ThreadPoolExecutor(16) as ex:
        xmls = dict(zip(cited_ids, ex.map(fetch_cited, cited_ids)))
    docs = {}
    for pid, xml in xmls.items():
        try:
            d = parse_full(pid, xml) if xml else None
        except ET.ParseError:
            d = None
        if d and d["units"]:
            docs[pid] = d
    print(f"{len(docs)} cited papers available as open-access XML")

    labels_by_citing: dict[str, dict[str, str]] = {}
    for c in candidates:
        labels_by_citing.setdefault(c["citing"], {})[c["cited"]] = c["citeLabel"]
    for pid, d in docs.items():
        d["label"] = next((l[pid] for l in labels_by_citing.values() if pid in l), pid)

    accepted, per_citing, per_cited, seen = [], {}, {}, set()
    rng.shuffle(candidates)
    for c in candidates:
        doc = docs.get(c["cited"])
        if not doc or c["claim"] in seen:
            continue
        cov, unit = best_unit(c["numbers"], doc)
        if cov < MIN_UNIT_COVERAGE:
            continue
        if per_citing.get(c["citing"], 0) >= MAX_CLAIMS_PER_CITING_PAPER or per_cited.get(c["cited"], 0) >= MAX_CLAIMS_PER_CITED_PAPER:
            continue
        seen.add(c["claim"])
        per_citing[c["citing"]] = per_citing.get(c["citing"], 0) + 1
        per_cited[c["cited"]] = per_cited.get(c["cited"], 0) + 1
        labels = labels_by_citing[c["citing"]]
        accepted.append({
            "citing": c["citing"], "claim": c["claim"], "numbers": c["numbers"], "cited": c["cited"],
            "citeLabel": c["citeLabel"], "evidenceUnit": unit, "siblings": set(labels) & set(docs), "labels": labels,
        })
    print(f"{len(accepted)} claims whose numbers appear together in one paragraph/table of the cited paper "
          f"({len(per_citing)} citing papers, {len(per_cited)} cited papers)")

    rng.shuffle(accepted)
    half = len(accepted) // 2
    items = [dict(c, errorType="SUPPORTED") for c in accepted[:half]]
    taken = set(docs) | study_ids | {c["cited"] for c in candidates}
    for i, c in enumerate(accepted[half:]):
        preferred = MUTATION_TYPES[i % len(MUTATION_TYPES)]
        for kind in [preferred] + [k for k in MUTATION_TYPES if k != preferred]:
            m = mutate(c, kind, docs, taken, rng)
            if m:
                items.append(m)
                break

    out_items = []
    for i, it in enumerate(items):
        out_items.append({
            "id": f"ref-{i:04d}",
            "dataset": "pmcrefs",
            "claim": it["claim"],
            "citation": f"{it['citeLabel']} ({it['cited']})",
            "targetId": None if it.get("missing") else it["cited"],
            "label": LABEL_FOR[it["errorType"]],
            "errorType": it["errorType"],
            "sourcePaper": accepted_source(it),
            "citingPaper": it["citing"],
            "evidenceUnit": it["evidenceUnit"],
            "mutation": it.get("mutation"),
            "originalClaim": it.get("originalClaim", it["claim"]),
        })
    rng.shuffle(out_items)

    P.write_jsonl(OUT / "items.jsonl", out_items)
    (OUT / "references.json").write_text(json.dumps(sorted(docs)))
    P.write_jsonl(OUT / "corpus.jsonl", [source_doc(docs[pid]) for pid in sorted(docs)])

    good = [i for i in out_items if i["errorType"] == "SUPPORTED"]
    n_good = min(50, len(good))
    sample = good[:n_good]
    pools = {k: [i for i in out_items if i["errorType"] == k] for k in MUTATION_TYPES}
    bad: list[dict] = []
    while len(bad) < n_good and any(pools.values()):
        for k in MUTATION_TYPES:
            if pools[k] and len(bad) < n_good:
                bad.append(pools[k].pop(0))
    sample += bad
    rng.shuffle(sample)
    P.write_jsonl(OUT / "items_sample.jsonl", sample)

    counts: dict[str, int] = {}
    for i in out_items:
        counts[i["errorType"]] = counts.get(i["errorType"], 0) + 1
    print(f"items: {len(out_items)} {counts} | sample: {len(sample)} | reference docs: {len(docs)}")


def accepted_source(it: dict) -> str:
    """The paper the claim's data really comes from (before any wrong_study/nonexistent swap)."""
    m = re.match(r"(PMC\d+) -> ", it.get("mutation") or "")
    return m.group(1) if m else it["cited"]


if __name__ == "__main__":
    main()
