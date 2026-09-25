# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build a document-level citation benchmark from open-access RCT papers in PubMed Central.

Idea: a paper's results prose ("the summary") reports numbers from its own tables
("the underlying report"). We keep the authors' sentences verbatim and link each one to
the table that contains its numbers. Those links are our known-good citations. Then we
inject known errors into half of them.

Outputs (under data/pmc/):
  raw/<pmcid>.xml       cached JATS XML from the public PMC S3 bucket
  papers.jsonl          per paper: id, title, tables[] (the searchable "report" side)
  corpus.jsonl          one SourceDoc per table: {id, title, text}
  items.jsonl           all benchmark items (~300)
  items_sample.jsonl    balanced 100-item sample (50 good, 10 per error type)
"""

import json
import os
import random
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "pmc"
RAW = OUT / "raw"
SEED = 7
N_PAPERS = 30
MAX_CLAIMS_PER_PAPER = 12
MIN_CLAIMS_PER_PAPER = 5
MUTATION_TYPES = ["value_mismatch", "wrong_location", "nonexistent_target", "wrong_study", "overstated"]
LABEL_FOR = {
    "SUPPORTED": "supported",
    "value_mismatch": "not_supported",
    "overstated": "not_supported",
    "wrong_location": "wrong_target",
    "nonexistent_target": "wrong_target",
    "wrong_study": "wrong_target",
}
REWRITE_MODEL = "openai/gpt-6-sol"

SEARCH_QUERY = (
    'PUB_TYPE:"Randomized Controlled Trial" AND OPEN_ACCESS:y AND HAS_PDF:y '
    'AND LICENSE:"cc by" AND PUB_YEAR:[2020 TO 2025]'
)

# ---------------------------------------------------------------- fetching


def search_candidates(n_pages: int = 3) -> list[str]:
    ids: list[str] = []
    cursor = "*"
    for _ in range(n_pages):
        qs = urllib.parse.urlencode(
            {"query": SEARCH_QUERY, "format": "json", "pageSize": 100, "resultType": "lite", "cursorMark": cursor}
        )
        data = json.loads(urllib.request.urlopen(f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?{qs}").read())
        ids += [r["pmcid"] for r in data["resultList"]["result"] if r.get("pmcid")]
        cursor = data.get("nextCursorMark", cursor)
    return ids


def fetch_xml(pmcid: str) -> str | None:
    path = RAW / f"{pmcid}.xml"
    if path.exists():
        return path.read_text()
    for version in (1, 2, 3):
        url = f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.{version}/{pmcid}.{version}.xml"
        try:
            text = urllib.request.urlopen(url).read().decode()
            path.write_text(text)
            return text
        except Exception:
            continue
    return None


# ---------------------------------------------------------------- XML -> structure

SKIP_TAGS = {"table-wrap", "fig", "disp-formula", "supplementary-material", "table-wrap-group", "fig-group"}


def local(tag: str) -> str:
    return tag.split("}")[-1]


def text_of(el: ET.Element, skip: set[str] = SKIP_TAGS) -> str:
    parts = [el.text or ""]
    for child in el:
        if local(child.tag) not in skip:
            parts.append(text_of(child, skip))
        parts.append(child.tail or "")
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def parse_table(tw: ET.Element) -> dict | None:
    label_el = tw.find("label")
    label = text_of(label_el) if label_el is not None else ""
    m = re.match(r"Table\s+(\d+)", label, re.I)
    if not m:
        return None
    caption_el = tw.find("caption")
    rows = []
    for tr in tw.iter("tr"):
        cells = [text_of(c, set()) for c in tr if local(c.tag) in ("td", "th")]
        if any(cells):
            rows.append(" | ".join(cells))
    if not rows:
        return None
    foot_el = tw.find("table-wrap-foot")
    return {
        "number": int(m.group(1)),
        "label": f"Table {m.group(1)}",
        "caption": text_of(caption_el, set()) if caption_el is not None else "",
        "rows": rows,
        "foot": text_of(foot_el, set()) if foot_el is not None else "",
    }


def parse_paper(pmcid: str, xml: str) -> dict | None:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    title_el = root.find(".//article-meta/title-group/article-title")
    title = text_of(title_el, set()) if title_el is not None else pmcid

    tables = {}
    for tw in root.iter("table-wrap"):
        t = parse_table(tw)
        if t and t["number"] not in tables:
            tables[t["number"]] = t

    body = root.find("body")
    paragraphs = []
    if body is not None:
        def walk(sec: ET.Element, path: list[str]):
            for child in sec:
                tag = local(child.tag)
                if tag == "sec":
                    t = child.find("title")
                    walk(child, path + [text_of(t, set()) if t is not None else ""])
                elif tag == "p":
                    paragraphs.append({"section": " > ".join(p for p in path if p), "text": text_of(child)})
        walk(body, [])

    return {"id": pmcid, "title": title, "tables": [tables[k] for k in sorted(tables)], "paragraphs": paragraphs}


# ---------------------------------------------------------------- claims

NUM_RE = re.compile(r"(?<![\w.])[-−]?\d[\d,]*(?:\.\d+)?")
IGNORED_NUMBERS = {"0.05", "0.01", "0.001", "0.0001", "95", "100"}
ABBREVIATIONS = r"(?:vs|al|Fig|Figs|e\.g|i\.e|approx|No|ref|Refs|Ref|n)"


def normalize_number(s: str) -> str:
    s = s.replace("−", "-").replace(",", "")
    if "." in s:
        s = s.rstrip("0").rstrip(".") if not s.endswith(".") else s[:-1]
    return s


def informative_numbers(text: str) -> list[str]:
    text = re.sub(r"95\s?%\s?(?:CI|confidence)", " ", text, flags=re.I)
    out = []
    for raw in NUM_RE.findall(text):
        n = normalize_number(raw)
        if n in IGNORED_NUMBERS:
            continue
        if "." in n:
            out.append(n)
            continue
        v = abs(int(n))
        if v >= 13 and not (1900 <= v <= 2100):
            out.append(n)
    return out


def table_numbers(table: dict) -> set[str]:
    text = " ".join(table["rows"]) + " " + table["foot"]
    return {normalize_number(x) for x in NUM_RE.findall(text)}


def split_sentences(text: str) -> list[str]:
    protected = re.sub(rf"\b({ABBREVIATIONS})\.", r"\1<DOT>", text)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z(])", protected)
    return [p.replace("<DOT>", ".").strip() for p in parts if p.strip()]


def clean_claim(sentence: str) -> str | None:
    s = re.sub(r"\s*\[[\d,\s–-]+\]", "", sentence)
    s = re.sub(r"\s*\((?:[^()]*\b(?:Tables?|Fig\.?|Figures?|Supplementary|Additional file)\b[^()]*)\)", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if re.search(r"\b(Tables?|Figures?|Fig\.)\b", s):
        return None
    if not (40 <= len(s) <= 400):
        return None
    return s


def is_results_section(section: str) -> bool:
    return bool(re.search(r"result|finding|outcome", section, re.I)) and not re.search(r"method", section, re.I)


def extract_claims(paper: dict) -> list[dict]:
    tnums = {t["number"]: table_numbers(t) for t in paper["tables"]}
    claims = []
    seen = set()
    for p in paper["paragraphs"]:
        if not is_results_section(p["section"]):
            continue
        for sent in split_sentences(p["text"]):
            claim = clean_claim(sent)
            if not claim or claim in seen:
                continue
            nums = informative_numbers(claim)
            if len(nums) < 2:
                continue
            coverage = sorted(
                ((sum(n in tn for n in nums) / len(nums), k) for k, tn in tnums.items()), reverse=True
            )
            best_cov, best_table = coverage[0]
            second_cov = coverage[1][0] if len(coverage) > 1 else 0
            if best_cov >= 0.8 and second_cov < 0.5:
                seen.add(claim)
                claims.append({"claim": claim, "table": best_table, "numbers": nums, "section": p["section"]})
    return claims


# ---------------------------------------------------------------- mutations


def perturb_number(n: str, forbidden: set[str], rng: random.Random) -> str | None:
    digits = [i for i, c in enumerate(n) if c.isdigit()]
    candidates = []
    for a, b in zip(digits, digits[1:]):
        if n[a] != n[b]:
            s = list(n)
            s[a], s[b] = s[b], s[a]
            candidates.append("".join(s))
    last = digits[-1]
    for delta in (1, 2, 3, -1, -2, -3):
        d = int(n[last]) + delta
        if 0 <= d <= 9:
            candidates.append(n[:last] + str(d) + n[last + 1:])
    candidates = [c for c in candidates if not re.match(r"-?0\d", c) and normalize_number(c) not in forbidden]
    return rng.choice(candidates) if candidates else None


def replace_number_in_text(text: str, old: str, new: str) -> str | None:
    for m in NUM_RE.finditer(text):
        if normalize_number(m.group(0)) == old:
            raw = m.group(0)
            new_raw = new
            if "," in raw and "." not in new:
                new_raw = f"{int(new):,}"
            return text[: m.start()] + new_raw + text[m.end():]
    return None


def coverage_in(nums: list[str], table_nums: set[str]) -> float:
    return sum(n in table_nums for n in nums) / len(nums)


def rewrite_overstated(claim: str) -> str | None:
    prompt = f"""Rewrite this sentence from a clinical trial results section so that it OVERSTATES the finding in a way a careful FDA reviewer would reject, while keeping every number exactly as written.

Use one or two of: remove hedges or qualifiers, claim statistical significance or superiority that isn't stated, generalize to a broader population, turn an association into causation, or strengthen verbs ("reduced" -> "eliminated", "some" -> "all").

Return only the rewritten sentence.

Sentence: {claim}"""
    body = json.dumps({
        "model": REWRITE_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "max_tokens": 400,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"},
    )
    try:
        out = json.loads(urllib.request.urlopen(req, timeout=120).read())
        text = out["choices"][0]["message"]["content"].strip().strip('"')
    except Exception as e:
        print(f"  rewrite failed: {e}")
        return None
    if sorted(informative_numbers(text)) != sorted(informative_numbers(claim)) or text == claim:
        return None
    return text


def mutate(item: dict, kind: str, paper: dict, papers: dict, rng: random.Random) -> dict | None:
    tnums = {t["number"]: table_numbers(t) for t in paper["tables"]}
    cited = item["table"]
    nums = item["numbers"]
    m = dict(item)
    m["errorType"] = kind
    m["originalClaim"] = item["claim"]
    m["sourcePaper"] = item["paper"]

    if kind == "value_mismatch":
        in_table = [n for n in nums if n in tnums[cited]]
        rng.shuffle(in_table)
        for old in in_table:
            new = perturb_number(old, tnums[cited], rng)
            text = replace_number_in_text(item["claim"], old, new) if new else None
            if text:
                m["claim"] = text
                m["mutation"] = f"{old} -> {new}"
                return m
        return None

    if kind == "wrong_location":
        others = [k for k in tnums if k != cited and coverage_in(nums, tnums[k]) < 0.3]
        if not others:
            return None
        m["table"] = rng.choice(others)
        m["mutation"] = f"Table {cited} -> Table {m['table']}"
        return m

    if kind == "nonexistent_target":
        m["table"] = max(tnums) + rng.randint(1, 3)
        m["targetMissing"] = True
        m["mutation"] = f"Table {cited} -> Table {m['table']} (does not exist)"
        return m

    if kind == "wrong_study":
        options = [
            pid for pid, p in papers.items()
            if pid != paper["id"] and any(
                t["number"] == cited and coverage_in(nums, table_numbers(t)) < 0.3 for t in p["tables"]
            )
        ]
        if not options:
            return None
        m["paper"] = rng.choice(options)
        m["mutation"] = f"{paper['id']} -> {m['paper']}"
        return m

    if kind == "overstated":
        text = rewrite_overstated(item["claim"])
        if not text:
            return None
        m["claim"] = text
        m["mutation"] = "overstated rewrite"
        return m

    raise ValueError(kind)


# ---------------------------------------------------------------- main


def table_doc(paper: dict, t: dict) -> dict:
    text = "\n".join(t["rows"])
    if t["foot"]:
        text += f"\n\nNotes: {t['foot']}"
    return {
        "id": f"{paper['id']}/{t['label']}",
        "title": f"{paper['id']}, {t['label']}: {t['caption']}",
        "text": text,
    }


def load_env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def main() -> None:
    load_env()
    RAW.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)

    candidates = search_candidates()
    rng.shuffle(candidates)
    print(f"{len(candidates)} candidate papers")

    papers: dict[str, dict] = {}
    claims_by_paper: dict[str, list[dict]] = {}
    for pmcid in candidates:
        if len(papers) >= N_PAPERS:
            break
        xml = fetch_xml(pmcid)
        paper = parse_paper(pmcid, xml) if xml else None
        if not paper or len(paper["tables"]) < 3:
            continue
        claims = extract_claims(paper)
        if len(claims) < MIN_CLAIMS_PER_PAPER:
            continue
        rng.shuffle(claims)
        papers[pmcid] = paper
        claims_by_paper[pmcid] = claims[:MAX_CLAIMS_PER_PAPER]
        print(f"  {pmcid}: {len(paper['tables'])} tables, {len(claims)} claims")

    base = [dict(c, paper=pid) for pid, cs in claims_by_paper.items() for c in cs]
    rng.shuffle(base)
    print(f"{len(papers)} papers, {len(base)} verified claims")

    half = len(base) // 2
    items = [dict(c, errorType="SUPPORTED") for c in base[:half]]
    to_mutate = base[half:]
    for i, c in enumerate(to_mutate):
        preferred = MUTATION_TYPES[i % len(MUTATION_TYPES)]
        for kind in [preferred] + [k for k in MUTATION_TYPES if k != preferred]:
            m = mutate(c, kind, papers[c["paper"]], papers, rng)
            if m:
                items.append(m)
                break

    out_items = []
    for i, it in enumerate(items):
        citation = f"{it['paper']}, Table {it['table']}"
        out_items.append({
            "id": f"pmc-{i:04d}",
            "dataset": "pmc",
            "claim": it["claim"],
            "citation": citation,
            "targetId": None if it.get("targetMissing") else f"{it['paper']}/Table {it['table']}",
            "label": LABEL_FOR[it["errorType"]],
            "errorType": it["errorType"],
            "sourcePaper": it.get("sourcePaper", it["paper"]),
            "mutation": it.get("mutation"),
            "originalClaim": it.get("originalClaim", it["claim"]),
        })
    rng.shuffle(out_items)

    with open(OUT / "papers.jsonl", "w") as f:
        for p in papers.values():
            f.write(json.dumps({"id": p["id"], "title": p["title"], "tables": p["tables"]}) + "\n")
    with open(OUT / "corpus.jsonl", "w") as f:
        for p in papers.values():
            for t in p["tables"]:
                f.write(json.dumps(table_doc(p, t)) + "\n")
    write_jsonl(OUT / "items.jsonl", out_items)

    sample = [i for i in out_items if i["errorType"] == "SUPPORTED"][:50]
    for kind in MUTATION_TYPES:
        sample += [i for i in out_items if i["errorType"] == kind][:10]
    rng.shuffle(sample)
    write_jsonl(OUT / "items_sample.jsonl", sample)

    counts: dict[str, int] = {}
    for i in out_items:
        counts[i["errorType"]] = counts.get(i["errorType"], 0) + 1
    print(f"items: {len(out_items)} {counts} | sample: {len(sample)}")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
