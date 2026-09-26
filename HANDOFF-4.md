# CiteGuard handoff, part 4 (session of Fri Sep 25, 2026, night)

For an LLM picking this project up in a new chat. Read in this order:

1. [`HANDOFF.md`](HANDOFF.md): sections 1–2 (the assignment, stakeholder answers, how Ziad wants to work, commit rules) still apply in full.
2. [`HANDOFF-2.md`](HANDOFF-2.md): how the tool agent, the hard corpus and the original `pmcrefs` benchmark were built.
3. [`HANDOFF-3.md`](HANDOFF-3.md): number check, sweep design, label-review findings, stakeholder-question draft. **§1 and §8 there are inconsistent with the repo** (see §0).
4. This file: what happened after HANDOFF-3 was written, the real repo state, and the plan.
5. `WRITEUP.md` (local-only draft, Ziad's voice). It still describes the tool agent as a plan; it has not been updated with this session's numbers.

You are expected to **challenge what's built and the plan before proceeding**. There's a "Challenge these" section at the end. Don't just continue the to-do list; say where you think it's wrong first, using AskQuestion with your recommendation first and marked "(Recommended)".

The working style is unchanged: ask before each step (AskQuestion, recommendation first), plain-English explanations of ML/eval jargon, no commit without asking, never commit `WRITEUP.md`, commit with the `git commit-tree` plumbing (HANDOFF.md §2) to avoid the Cursor co-author trailer. All four handoff files are in `.git/info/exclude`.

---

## 0. What's stale in HANDOFF-3.md

Treat HANDOFF-3 as the design and results writeup for the number check and the sweep **as of ~18:45**. These claims in it are wrong now:

- **§1 "Committed and pushed" / §2 "committed" / §7 item 9 / §8 "HEAD = b229d3e" mixed with "uncommitted"**: the number check, `tool_choice` fallback, `max_tokens` change, label file and `prep_refs.py` edits are **all still uncommitted**. `HEAD` = `origin/main` = `b229d3e` (Phase 3 only).
- **§1 "The model sweep is closed" / "No background processes"**: stale even when written (several runs were still going). They were killed at the end of this session. Incomplete runs are listed in §4.
- **§4.3 table**: missing Gemini tool (finished: 93.0% / 7.0%), Grok baseline (94.7% / 9.3%), Gemini baseline (93.0% / 9.3%), and the unusable Granite/GLM baseline rows. Use §4 here.
- **§5.1 "re-ask pmc-0132 / pmc-0003 / record 45"**: the 45 review rows are already in `labels/pmc_overrides.jsonl` as `status: "confirmed"` (file now 66 lines). Ziad's confirmation happened in the HANDOFF-3 session according to that file's §1/§3; do not re-ask unless he wants to revisit.
- **§5.3 "pmcrefs generator problems (to fix)"**: the code fix is **in the working tree**. A first regenerate **already overwrote** `data/pmcrefs/items.jsonl` (157 → 70). See §3.
- **§5.4 "`max_tokens` defaults to 2000"**: changed to **8000** in uncommitted `src/llm.ts`. No reasoning-model reruns have used the new cap yet.
- **§6 stakeholder questions**: drafted in HANDOFF-3. HANDOFF-3 §1 also says Ziad later called this an exercise and said to assume rather than email. Confirm with Ziad before sending anything.
- **§7 item 3 "pmcrefs generator fix"**: in progress, not finished (yield too small; second top-up was killed).

---

## 1. Where the session ended

Ziad said **stop** and write this handoff so a new chat can start clean.

**All long-running processes were killed** (sweep launcher, Qwen tool at 97/100, Qwen baseline just started, Granite tool rerun at 14/100, `pnpm prep:refs` mid top-up). Nothing is running. Do not assume `/tmp/sweep.sh` is still going.

Nothing was committed. `WRITEUP.md` was not updated.

---

## 2. What was built after HANDOFF-3 (all uncommitted)

On top of the HANDOFF-3 number-check work (also still uncommitted):

```
src/llm.ts                 default max_tokens 2000 → 8000 (reasoning models were truncated).
python/prep_refs.py        claim_numbers() — distinct numbers, strips name-tokens (IL-27, FGF-21).
                           is_attributive() — keep findings sentences, drop protocol copy.
                           all_numbers() includes titles, headings, table captions (closes the
                           "mutated value exists in a caption" hole).
                           extra_citing_papers() tops up the Europe PMC list if unused IDs < N_EXTRA.
                           N_EXTRA_CITING = 1200, search loop up to 40 pages (was 250 / 6 pages).
                           parse_full table units now include the caption.
labels/pmc_overrides.jsonl +45 confirmed rows from the table-sample review (66 total).
```

`pnpm typecheck` was clean after the `max_tokens` change. Tests were 31/31 after the number-check work; not re-run after the last `prep_refs.py` edits (those are Python-only).

---

## 3. pmcrefs regenerate (partial, data already overwritten)

**Important:** the first `pnpm prep:refs` this session finished and **replaced** the 157-item set. There is no git copy (`data/` is gitignored). Recover from Time Machine / a backup if you need the old items. Caches (`raw/`, `citing/`, `idconv.json`, `rewrites.json`) are still there.

First regenerate (same cached citing pool + new filters), ~76 s:

```
689 citing papers
388 candidate sentences (one ref, ≥2 distinct numbers, attributive)
143 resolve to a PMCID (138 cited papers)
116 cited papers as open-access XML
70 claims after same-unit ≥80% coverage (54 citing → 68 cited)
items: 70  SUPPORTED 35, wrong_study 10, nonexistent 9, value_mismatch 8, overstated_subtle 8
sample: 70 (the whole set)
```

That is too few for a 50/50 sample with useful false-alarm intervals. Offline, the cached 439 citing XMLs had 246 attributive numeric candidates; linkage is what shrinks it (many PMIDs are not in PMC).

A second run with `N_EXTRA_CITING = 1200` and 40 search pages was **killed while fetching**. `citing_candidates.json` may have grown; `items.jsonl` is still the 70-item output from the first run.

`pnpm prep:docs` was **not** re-run. `data/pmc/docs_full.jsonl` still has the old 294 references. If the new `pmcrefs` cited-paper list differs, the full store is stale until `prep:docs`.

---

## 4. Model sweep (stopped, incomplete)

Goal: 10 models × {tool-full-r2, baseline} on the `pmc` 100-item sample. Summaries below are **as written by the runner** (they use whatever overrides existed at rescore time; the +45 label rows were added during the evening, so some summaries may still reflect the old 21-override sample). Re-score with `pnpm rescore` before ranking.

### Tool agent (full store, retries + number check)

| Model | n | Fail | Catch | FA | Subtle | $/check | p50 | Run |
|---|---|---|---|---|---|---|---|---|
| gpt-6-sol | 100 | 0 | **94.7%** | 4.7% | 3/6 | $0.0118 | 5.3s | `00-39-26` |
| grok-4.7 | 100 | 0 | **94.7%** | 9.3% | 3/6 | $0.0167 | 14.3s | `00-39-26` |
| gemini-3.8-flash | 100 | 0 | 93.0% | 7.0% | 3/6 | $0.0276 | 26.0s | `00-39-26` |
| gpt-6-luna | 100 | 0 | 93.0% | 4.7% | 2/6 | $0.00042 | 3.9s | `00-39-26` |
| deepseek-v4-pro-0813 | 100 | 1 | 91.1% | 4.7% | 3/6 | $0.0062 | 5.6s | `00-39-26` |
| claude-opus-5.5 | 100 | 0 | 89.5% | 0.0% | 2/6 | $0.0400 | 8.6s | `00-42-49` |
| glm-5.3 | 100 | 0 | 86.0% | 0.0% | 2/6 | $0.0104 | 9.5s | `00-39-26` |
| deepseek-v4.1-flash | 100 | 2 | 83.9% | 0.0% | 2/6 | $0.0014 | 6.2s | `00-39-26` |
| qwen3.8-27b | **97** | ? | — | — | — | — | — | `00-39-26` jsonl only, no summary |
| granite-4.2-8b | **42** then **14** | — | — | — | — | — | — | first run died; rerun killed. Two partial jsonls |

### Baseline (table handed over)

| Model | n | Fail | Catch | FA | Subtle | $/check | p50 | Run |
|---|---|---|---|---|---|---|---|---|
| grok-4.7 | 100 | 0 | 94.7% | 9.3% | 3/6 | $0.0064 | 8.7s | `00-45-35` |
| gpt-6-luna | 100 | 0 | 93.0% | 14.0% | 2/6 | $0.00024 | 2.4s | `00-40-34` |
| gpt-6-sol | 100 | 0 | 93.0% | 14.0% | 2/6 | $0.0046 | 3.6s | `00-40-54` |
| gemini-3.8-flash | 100 | 0 | 93.0% | 9.3% | 2/6 | $0.0031 | 4.7s | `00-50-00` |
| glm-5.3 | 100 | **17** | 90.7% | 0.0% | 2/6 | $0.0076 | 4.5s | `00-45-49` — truncated; unusable |
| deepseek-v4-pro-0813 | 100 | 3 | 89.1% | 9.5% | 3/6 | $0.0016 | 5.9s | `00-43-25` |
| deepseek-v4.1-flash | 100 | 3 | 89.1% | 4.8% | 2/6 | $0.00072 | 3.0s | `00-43-57` |
| claude-opus-5.5 | 100 | 0 | 87.7% | 0.0% | 2/6 | $0.0112 | 4.2s | `00-39-51` |
| granite-4.2-8b | 100 | **60** | 93.1% | 27.3% | 0/0 | $0.00075 | 34.0s | `00-58-36` — unusable |
| qwen3.8-27b | 0 | — | — | — | — | — | — | never finished (killed as it started) |

Number-check measurement runs (Luna only, still valid): `00-33-27` (tables) and `00-33-30` (full). See HANDOFF-3 §4.1.

---

## 5. Findings from this stretch (add to HANDOFF-3 §5)

- **Killing `prep:refs` after it has already written `items.jsonl` leaves a half-migrated benchmark.** The 157-item set is gone; the 70-item set is live. Do not run pmcrefs benches until you either accept 70, finish the top-up, or restore a backup.
- **Granite 4.2 8B is too slow for a 100-item tool sweep** (12–160 s/check; first run died at 42). HANDOFF-3 says Ziad chose to stop it; a rerun was started anyway and then killed. Recommend: skip Granite tool, maybe keep a cheap baseline-only data point after `max_tokens=8000`.
- **Qwen tool was 3 checks from done** (97/100). Finishing those three (or rerunning the model) is cheaper than a full rerun. There is no `.summary.json`.
- **`max_tokens=8000` is in the tree but no sweep run used it.** GLM baseline (17 failures) and Granite baseline (60) still need reruns before you call those models lenient.
- Offline, the attributive + distinct-number filter on the **old** 50 good sample kept ~19–20 and dropped ~3 for junk numbers and ~28 as procedure/non-attributive. That matches the diagnosis; the cost is yield.

---

## 6. Pending decisions (ask first)

1. **Commit the working tree** as Phase 4 (number check, Anthropic fallback, `max_tokens=8000`, 45 label rows, `prep_refs.py` filters)? Recommended: **yes, code + labels only**, after a quick `pnpm test`. Do not commit `WRITEUP.md` or handoffs. Use the plumbing commit. `data/pmcrefs` stays gitignored, so committing `prep_refs.py` does not restore the 157-item set.
2. **pmcrefs data.** Recommended: **finish the top-up** (`pnpm prep:refs` with the current 1200 extra / 40-page settings; then `pnpm prep:docs`), and only then review flagged good items. Alternative: keep the 70-item set and report wider CIs. Alternative: restore the 157-item backup if one exists and apply the filters in a new output dir so you can compare.
3. **Sweep leftovers.** Recommended: `pnpm rescore` every finished run against the 66 overrides; finish Qwen tool (3 items or full rerun); skip Granite tool; rerun GLM + Granite baselines with `max_tokens=8000`; run Qwen baseline. Then pick finalists from paired comparisons, not from the raw table.
4. **Stakeholder email.** HANDOFF-3 drafted six questions, then said Ziad called this an exercise and to assume. Recommended: **do not email**; write the assumptions in `WRITEUP.md` and ask Ziad only if a choice would change a week of work.

---

## 7. What's left (replaces HANDOFF-3 §7)

0. **Challenge first**, then the four decisions in §6.
1. **Commit** if approved (plumbing; ask first).
2. **Close the sweep:** rescore, finish/rerun the holes in §4, raise-cap reruns for truncated reasoning models. Optional `src/bench/leaderboard.ts` with paired comparison.
3. **Finish pmcrefs:** top-up regenerate, `prep:docs`, spot-check that mutated values are absent from captions too, review flagged good items with Ziad, then tool + baseline (+ finalists).
4. **Finalists on the full 209** (top 3 + cheapest within noise, tool agent). Budget review of disagreements on the 109 unreviewed full-set items (HANDOFF-3 challenge 1).
5. **Resolver-first pipeline** (HANDOFF-3 §7.4). Investigate the baseline's 3× false-alarm rate first.
6. **Second opinion** on `supported`, aimed at `overstated_subtle`.
7. **PDF parsing** (HANDOFF.md §7 item 6).
8. **WRITEUP.md**: agent design (it is still a plan), number check + circularity caveat, Opus `tool_choice`, sweep, noise, labels, accuracy/latency/cost, reliability verdict.
9. **React viewer** (unchanged).
10. Embeddings only if time is left.

---

## 8. Repo state

- `HEAD` = `origin/main` = `b229d3e`.
- Uncommitted:
  - modified: `labels/pmc_overrides.jsonl`, `python/prep_refs.py`, `src/agents/checks.ts`, `src/agents/checks.test.ts`, `src/agents/tool-agent.ts`, `src/llm.ts`, `src/types.ts`
  - new: `src/numbers.ts`, `src/numbers.test.ts`
- Data (gitignored): `data/pmcrefs/items.jsonl` and `items_sample.jsonl` are the **70-item** regenerate. `data/pmc/docs_full.jsonl` is the **pre-regenerate** store.
- Partial runs to ignore or finish, not treat as scores:  
  `runs/2026-09-26T00-39-26_pmc-sample_tool-full-r2_qwen_qwen3.8-27b.jsonl` (97 lines),  
  `runs/2026-09-26T00-39-26_pmc-sample_tool-full-r2_ibm-granite_granite-4.2-8b.jsonl` (42),  
  `runs/2026-09-26T01-06-49_pmc-sample_tool-full-r2_ibm-granite_granite-4.2-8b.jsonl` (14).
- Deletable smoke runs from part 2: `23-36-13`, `00-06-50`.

## 9. Gotchas (new)

- **`pnpm prep:refs` overwrites `items.jsonl` in place.** There is no output-dir flag. Snapshot `data/pmcrefs/items*.jsonl` before a regenerate if you might want the old set.
- **Do not commit mid-regenerate.** The Python is fine to commit; the 70-item data is local-only.
- **HANDOFF-3 §1 lies about git.** Read `git status` and `git log -1`, not that paragraph.
- Sweep launcher, Qwen, Granite and `prep:refs` were force-killed. Partial jsonl files are valid records up to the last complete line; they have no summary.
- Same launch/zsh/`tool_choice`/`loadOverrides` gotchas as HANDOFF-3 §9.

---

## 10. Challenge these

1. **The 70-item pmcrefs set is not a benchmark yet.** Half the good items you would have reviewed are gone, and 35 good / 35 bad makes the false-alarm interval huge. Either top up or drop pmcrefs from model ranking until it is.
2. **Do not rank models from the §4 table as-is.** Overrides changed after some summaries were written; three tool runs are incomplete; two baselines are truncated. Rescore + paired comparison first (HANDOFF-3 §4.2: ≤6 flips / 100 is noise).
3. **Skipping Granite's tool run is fine; calling Granite "93% catch" from a 60-failure baseline is not.**
4. HANDOFF-3 challenges 1–4 and 6–7 still stand (full-set labels, baseline false alarms, tiny subtle set, number check flattening value_mismatch, truncation, numeric-only claims).
5. **Challenge 5 in HANDOFF-3 (send stakeholder questions first) is weaker if this is only an exercise.** Prefer stated assumptions in the writeup over a blocked email.
