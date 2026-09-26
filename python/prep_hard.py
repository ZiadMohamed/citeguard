# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Harder PMC benchmark: errors where every number in the claim is still in the cited table.

The original PMC set (prep_pmc.py) has four mutation types that code alone catches (wrong
number, wrong table, missing table, wrong paper). This set keeps only errors that survive the
number check, because those are what a model is for:

  swap_values        two numbers from the same table row trade places ("138.85 vs 130.62"
                     becomes "130.62 vs 138.85"): the arm mix-up.
  direction_flip     "higher" <-> "lower", "increased" <-> "decreased", ...
  significance_flip  "significantly higher" -> "higher, but not significantly", "no significant" -> "a significant".
  timepoint_swap     "at 12 months" -> "at 24 months", where the table also reports 24 months.

Input: the good PMC items (data/pmc/items.jsonl, after labels/pmc_overrides.jsonl), and the
tables (data/pmc/papers.jsonl). No model calls: every edit is a deterministic rule, so the
label is known by construction. Each mutated claim is paired with its unmodified original,
so the set is balanced and every false alarm on an original has a matching catch to compare.
Originals from the reviewed 100-item sample carry reviewed=true; the leaderboard's "FA rev"
column counts false alarms on those only, because unreviewed originals include real author errors.

Outputs (under data/pmchard/): items.jsonl, items_sample.jsonl (same, it is small), corpus.jsonl.
"""

import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prep_pmc import NUM_RE, informative_numbers, normalize_number  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PMC = ROOT / "data" / "pmc"
OUT = ROOT / "data" / "pmchard"
SEED = 13

DIRECTION = [
    ("higher", "lower"), ("increased", "decreased"), ("increase", "decrease"), ("greater", "smaller"),
    ("rose", "fell"), ("improved", "worsened"),
]
FLIP = {a: b for a, b in DIRECTION} | {b: a for a, b in DIRECTION}
DIR_RE = re.compile(r"\b(" + "|".join(FLIP) + r")\b", re.I)
TIME_RE = re.compile(r"\b(\d+)(\s*|-)(weeks?|months?|days?|years?)\b", re.I)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def keep_case(src: str, word: str) -> str:
    return word.capitalize() if src[0].isupper() else word


def direction_flip(claim: str, table: dict) -> str | None:
    hits = DIR_RE.findall(claim)
    # One direction word only: with two ("higher in A, lower in B") a flip can stay true.
    if len(hits) != 1 or re.search(r"\b(no|not|neither|without)\b", claim, re.I):
        return None
    return DIR_RE.sub(lambda m: keep_case(m.group(0), FLIP[m.group(0).lower()]), claim, count=1)


def significance_flip(claim: str, table: dict) -> str | None:
    rules = [
        (r"\bnot (statistically )?significant(ly)?\b", lambda m: f"{m.group(1) or ''}significant{m.group(2) or ''}"),
        (r"\b(statistically )?significantly (higher|lower|greater|increased|decreased|improved|reduced|different|better|worse)\b",
         lambda m: f"not {m.group(1) or ''}significantly {m.group(2)}"),
    ]
    for pat, rep in rules:
        if len(re.findall(pat, claim, re.I)) == 1:
            return re.sub(pat, rep, claim, count=1, flags=re.I)
    return None


def row_cells(table: dict) -> list[list[set[str]]]:
    return [[{normalize_number(x) for x in NUM_RE.findall(c)} for c in row.split(" | ")] for row in table["rows"]]


STAT_BEFORE = re.compile(r"(?:\b[pntFdgr]\s*[=<>(]\s*|\bSD\s*[=:]?\s*|±\s*|\(\s*|\[\s*95% CI:?\s*|[\[,]\s*|\bto\s*)$", re.I)


def swap_values(claim: str, table: dict) -> str | None:
    """Swap two group values from one table row: the arm mix-up.

    Only like-for-like values count: same decimal places, within 3x of each other, sitting in
    different cells of the same row, and not a p-value, n, test statistic, SD, CI bound or other
    bracketed value. "138.85 vs 130.62" qualifies; "t (138) = 2.24" does not.
    """
    info = set(informative_numbers(claim))
    nums = []
    for m in NUM_RE.finditer(claim):
        n = normalize_number(m.group(0))
        if n in info and not STAT_BEFORE.search(claim[max(0, m.start() - 14) : m.start()]):
            nums.append((m, n))
    for row in row_cells(table):
        cell_of = {}
        for ci, cell in enumerate(row):
            for n in cell:
                cell_of.setdefault(n, ci)
        for i, (ma, a) in enumerate(nums):
            for mb, b in nums[i + 1 :]:
                va, vb = abs(float(a)), abs(float(b))
                like = len(ma.group(0).split(".")[-1]) == len(mb.group(0).split(".")[-1]) and ("." in ma.group(0)) == ("." in mb.group(0))
                if (a != b and a in cell_of and b in cell_of and cell_of[a] != cell_of[b] and like
                        and min(va, vb) > 0 and max(va, vb) / min(va, vb) < 3):
                    s, e = ma.span(), mb.span()
                    return claim[: s[0]] + mb.group(0) + claim[s[1] : e[0]] + ma.group(0) + claim[e[1] :]
    return None


def timepoint_swap(claim: str, table: dict) -> str | None:
    """"at 12 months" -> "at 24 months" when the table also reports 24 months."""
    found = TIME_RE.findall(claim)
    if len(found) != 1:
        return None
    n, _, unit = found[0]
    stem = unit.lower().rstrip("s")
    text = table["caption"] + " " + " ".join(table["rows"])
    others = sorted({int(k) for k, _, u in TIME_RE.findall(text) if u.lower().rstrip("s") == stem and int(k) not in (0, int(n))}, key=lambda k: abs(k - int(n)))
    if not others:
        return None
    return TIME_RE.sub(lambda m: f"{others[0]}{m.group(2)}{m.group(3)}", claim, count=1)


MUTATIONS = {
    "swap_values": swap_values,
    "direction_flip": direction_flip,
    "significance_flip": significance_flip,
    "timepoint_swap": timepoint_swap,
}


def main() -> None:
    rng = random.Random(SEED)
    overrides = {o["id"]: o for o in read_jsonl(ROOT / "labels" / "pmc_overrides.jsonl")}
    papers = {p["id"]: p for p in read_jsonl(PMC / "papers.jsonl")}
    sample = {i["id"] for i in read_jsonl(PMC / "items_sample.jsonl")}
    good = [
        i for i in read_jsonl(PMC / "items.jsonl")
        if i["errorType"] == "SUPPORTED" and overrides.get(i["id"], {}).get("label", "supported") == "supported"
    ]
    items: list[dict] = []
    counts: dict[str, int] = {}
    for it in good:
        table_no = it["citation"].split("Table ")[-1]
        table = next(t for t in papers[it["sourcePaper"]]["tables"] if t["label"] == f"Table {table_no}")
        kinds = list(MUTATIONS)
        rng.shuffle(kinds)
        for kind in kinds:
            text = MUTATIONS[kind](it["claim"], table)
            if not text or text == it["claim"]:
                continue
            # Only the 100-item sample was read by a person. An unreviewed "good" original can be a
            # real author error, so false alarms are scored on reviewed originals only.
            base = {k: it[k] for k in ("claim", "citation", "targetId", "sourcePaper")} | {"reviewed": it["id"] in sample}
            items.append({**base, "id": f"hard-{it['id']}-ok", "dataset": "pmchard", "label": "supported",
                          "errorType": "SUPPORTED", "mutation": None, "originalClaim": it["claim"]})
            items.append({**base, "id": f"hard-{it['id']}-{kind}", "dataset": "pmchard", "claim": text,
                          "label": "not_supported", "errorType": kind, "mutation": kind, "originalClaim": it["claim"]})
            counts[kind] = counts.get(kind, 0) + 1
            break
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ("items.jsonl", "items_sample.jsonl"):
        (OUT / name).write_text("".join(json.dumps(i) + "\n" for i in items))
    # The baseline agent reads corpus.jsonl; the resolver reads data/pmc/papers.jsonl via the store.
    (OUT / "corpus.jsonl").write_text((PMC / "corpus.jsonl").read_text())
    print(f"{len(items)} items from {len(good)} good claims: {counts}")


if __name__ == "__main__":
    main()
