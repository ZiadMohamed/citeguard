# CiteGuard handoff, part 2 (session of Fri Sep 25, 2026, evening)

> **Update:** later sessions committed Phase 3 (`b229d3e`), added a number check, started a 10-model sweep, and began a pmcrefs generator fix. Read [`HANDOFF.md`](HANDOFF.md), then this file for how things were built, then [`HANDOFF-3.md`](HANDOFF-3.md), then **[`HANDOFF-4.md`](HANDOFF-4.md)** (the latest).

For an LLM picking this project up in a new chat. **Read `HANDOFF.md` first**: sections 1–2 (the assignment, stakeholder answers, how Ziad wants to work, commit rules) still apply in full. This file covers everything done since, corrects what's stale there, and lists the open decisions. Then read `WRITEUP.md` (local-only draft, Ziad's voice).

You are expected to **challenge what's built and the plan before proceeding**. There's a "Challenge these" section at the end. Don't just continue the to-do list; say where you think it's wrong first, using AskQuestion with your recommendation first and marked "(Recommended)".

---

## 0. What's stale in HANDOFF.md

- "Nothing has been pushed; `main` is ahead of `origin/main`": **stale.** At the start of this session `origin/main` == `HEAD` == `cfcc673` (Phase 2b). Everything from this session is **uncommitted** (see §7).
- §3 "What's built" and §5 "Results": extended below.
- §6 "Agent design agreed (NOT built yet)": **built**, with some deviations (§3 below).
- §7 item 1 (tool-using agent) is **done**. The plan in §6 of this file replaces HANDOFF.md §7.
- §8 open questions: partly answered (§5 below).
- The working style is unchanged: Ziad wants to be asked before each step (AskQuestion, recommendation first), plain-English explanations of ML/eval jargon, no commit without asking, never commit `WRITEUP.md`, commit with the `git commit-tree` plumbing to avoid the Cursor co-author trailer. `HANDOFF.md` and this file are both in `.git/info/exclude`.

---

## 1. Where the session ended

The last thing that happened: I presented the results (§4) and asked four questions via AskQuestion. **Ziad cancelled the questionnaire** and asked for this handoff instead, so **all four are still open** (§5.1). Nothing was committed, and no runs are in progress.

---

## 2. What was built this session

### New and changed files (all uncommitted)

```
src/tools/store.ts          DocStore: documents with sections (tables and text). loadStore(dataset, "tables"|"full").
                            findSection: exact label, then heading, then "pasted outline line" prefix match
                            ("Table 1: caption" -> Table 1, but never "Table 12" -> Table 1). paginate() at line boundaries.
src/tools/search.ts         MiniSearch (BM25+) index over chunks = one table row or one paragraph. Custom tokenizer keeps
                            "0.455"/"1,234" as single tokens; normalizes "12.30"->"12.3", "1,234"->"1234". Fields: text (boost 2),
                            context (doc id + title + section label + heading + table header row). No fuzzy, no prefix.
src/tools/tools.ts          TOOL_SPECS + ToolBox (one per check). Tools: list_documents (25/page), get_outline (quoted labels +
                            table captions + sizes), read_section (PAGE_CHARS = 8000 ≈ 2k tokens, "[page 1 of 3; call again...]"),
                            search (default 8, max 15 hits, 300-char snippets), submit_verdict. ToolBox.evidence collects exactly
                            what the model was shown, for quote grounding.
src/agents/tool-agent.ts    checkWithTools(): the harness loop. Native function calling, tool_choice "required", fresh context per
                            check, budget 12 tool calls (submit_verdict not counted; prose replies and invalid submit_verdict args
                            count). Budget exhaustion -> "could not verify" (not_supported). checkWithRetries(): objective checks,
                            then fresh-context retry (max 2) with a note saying why the last attempt was rejected. The first attempt
                            that passes every check wins; if none does, the last one stands, except that "supported" is downgraded
                            to a flag.
src/agents/checks.ts        objectiveFailures(): budget_exhausted | ungrounded_quote (the note quotes the exact missing fragment) |
                            missing_quote (supported with empty quote) | bad_location (named table/doc doesn't exist; skipped when
                            it just echoes the citation, so a correct "Table 7 doesn't exist" flag passes) | off_target (supported
                            but the evidence came from a location other than the cited one).
src/bench/locations.ts      Loc {doc, table|null}. trueLocation(item) from sourcePaper + mutation; parseLocation(free text);
                            sameLocation (doc-level targets only compare the doc).
src/bench/metrics.ts        + locationSuggestion (on wrong_target items: did suggestedLocation name where the data really is),
                            + agent stats (avg/p95/max tool calls, budget exhausted, peak context tokens, tool use per check,
                            retried, unresolved, retry flips flag<->pass, failure counts), + firstAttemptOnly().
src/bench/report.ts         + "FIRST ATTEMPT ONLY (no retries)" line, so one run yields with/without-retries numbers.
src/bench/run.ts            AGENTS map now = factories: baseline | tool. New flags --corpus tables|full (default tables),
                            --retries N (default 2). Run name: <stamp>_<dataset>-<split>_tool-<corpus>-r<N>_<model>.
src/types.ts                BenchItem + sourcePaper/mutation/originalClaim; CheckResult + suggestedLocation (nullish);
                            RunRecord + trace; ToolStep, Attempt, FailureCode, AgentTrace.
src/llm.ts                  + toolChoice. (Assistant messages are echoed back raw, incl. any reasoning fields, which some
                            providers need for multi-turn tool calls.)
src/quote.ts                + ungroundedFragments() (isQuoteGrounded now uses it).
python/prep_refs.py         Report-cites-report benchmark (§2.2). Imports prep_pmc.py helpers.
python/build_docs.py        The "full" document store (§2.3). Imports prep_pmc.py and prep_refs.py.
tests                       src/agents/checks.test.ts, src/bench/locations.test.ts, src/tools/tools.test.ts: 24 tests total, all pass.
package.json                + minisearch ^7.2.0, + scripts prep:refs, prep:docs.
```

Commands (in addition to HANDOFF.md's):
```bash
pnpm prep:refs          # ~2 min with caches; network + OPENROUTER_API_KEY (subtle rewrites via GPT-6 Sol)
pnpm prep:docs          # ~3 s; needs data/pmc/raw + data/pmcrefs
pnpm bench --dataset pmc --agent tool [--corpus tables|full] [--retries 2]
pnpm bench --dataset pmcrefs --agent tool --corpus full      # pmcrefs requires --corpus full
pnpm bench --dataset pmcrefs --agent baseline                # baseline gets the entire cited paper as text
```

### 2.1 Tool-using agent: how it behaves
- The model gets only `Claim: ...\nCitation: ...` and must find the source. The system prompt covers table citations ("PMC12345, Table 2") and document citations ("Smith et al. 2021 (PMC12345)"), says to judge **only the cited location**, and says that for wrong_target it should search without doc_id and fill `suggestedLocation`. It includes the same strict VERDICT_RULES as the baseline.
- Typical traces: supported table claim = 1 read_section (+ maybe get_outline). Wrong study = read cited table, search the claim's numbers corpus-wide, suggest the right paper. Reference claim = outline + search in doc + 2–3 reads.
- **Prompt versions matter for comparisons.** v1 (runs `23-36-33`, `23-52-50`) had table-only citation guidance and the old outline format. v2 (runs `00-06-50` and all `00-10-2x`) has generalized citation guidance, the "1 to 4" calls hint, quoted outline labels and lenient section matching. Only the four `00-10-2x` runs are directly comparable with each other.

### 2.2 New benchmark: `pmcrefs` (report cites report)
Why: the brief says references *between reports* must be checked too. In a submission, reports cite other reports and literature references (Module 5.4). The research-paper analog is paper A citing paper B. The citation names only a document, so the checker has to search a long full-text paper. This is the first benchmark where navigation and context control actually matter.

- **Citing pool:** the 189 cached PMC XMLs (`data/pmc/raw`) plus 250 more RCT papers from the same Europe PMC query (excluding the 300 prep_pmc already considered), cached in `data/pmcrefs/citing/`. The extra citing papers are **not** added to the document store.
- **Candidate sentences:** they cite exactly one bibliography xref (a range xref like "12–14" counts as several and is excluded), are 40–400 chars, don't mention a Table/Figure, and have ≥2 informative numbers **after stripping citation-marker text**. References are resolved to a PMCID from the XML's reference list, or else via the NCBI idconv API (`pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/`; one ID type per request, since mixing PMIDs and DOIs returns 400; most PMIDs genuinely aren't in PMC). Cited full texts come from the `pmc-oa-opendata` S3 bucket: 294 cited papers. `pnpm prep:refs` prints the full funnel counts.
- **Known-good linkage:** ≥80% of the claim's informative numbers appear **together in one unit** (an abstract paragraph, body paragraph or table) of the cited paper. Scattered matches were too often coincidental. Caps: 6 claims per citing paper, 3 per cited paper. Yield: **157 claims** (120 citing papers → 144 cited papers). The evidence unit is stored per item (`evidenceUnit`).
- **Mutations (half the claims, round-robin):** value_mismatch (new value verified absent from the *entire* cited paper), wrong_study (another cited paper with <30% number coverage, preferring the same citing paper's reference list, i.e. same topic), nonexistent_target (PMCID digits perturbed to an ID not in the store), overstated_subtle (same GPT-6 Sol prompt as prep_pmc, own cache `data/pmcrefs/rewrites.json`, max_tokens 3000, failed/None entries are retried). No cartoonish "overstated" and no wrong_location (document-level citations have no table).
- **Citation format:** `"<Author> et al. <year> (PMCxxxx)"` from the reference list. wrong_study and nonexistent **keep the original author-year label** and change only the ID. The first version swapped the label too, so a claim saying "Christensson et al. reported…" cited "Banna et al. 2017", which gave the error away without reading.
- **Counts:** full 157 = SUPPORTED 78, wrong_study 23, value_mismatch 21, nonexistent_target 20, overstated_subtle 15. Sample (`items_sample.jsonl`) = 100: 50 good, 13/13/12/12 bad. Evidence unit for the sample's good items: 27 body text, 18 tables, 5 abstracts.
- Item fields: `sourcePaper` = where the data really is (the originally cited paper); `citingPaper`; `evidenceUnit`; `mutation` ("PMCa -> PMCb", "PMCa -> PMCfake (not in submission)", "0.9 -> 0.8", "overstated_subtle rewrite").
- Outputs in `data/pmcrefs/`: items.jsonl, items_sample.jsonl, corpus.jsonl (one full-text SourceDoc per cited paper, for the baseline), references.json, idconv.json, citing_candidates.json, rewrites.json, raw/, citing/. Everything is gitignored.

### 2.3 The "full" document store (`data/pmc/docs_full.jsonl`)
- **189 study reports** (every XML in `data/pmc/raw`): all body sections at subsection granularity (label = path, e.g. "Methods > Participants") **except** top-level sections matching `result|discussion|conclusion|limitation|finding|summary|^outcomes?$`; no abstracts; plus all tables. Results prose is excluded because the table benchmark's claims are verbatim results sentences.
- **294 references** (from pmcrefs): full text including abstract, results, discussion and tables. They are the evidence for pmcrefs claims.
- **Leakage filter** on study reports: drop a paragraph if it contains the first 80 normalized chars of any claim's original sentence, or ≥50% of that claim's informative numbers. Only claims whose text came from that paper are checked (pmc `sourcePaper`, pmcrefs `citingPaper`). 3,862 paragraphs excluded as results/discussion, **138 dropped by the leakage filter**. A verification pass found no pmc claim sentence anywhere in the store's text. It found 1 pmcrefs sentence (`ref-0090`), and that's legitimate: the citing authors copied the cited paper's sentence nearly verbatim, and the cited paper *is* the evidence.
- Size: 483 docs, 8,819 sections, 14.7M chars ≈ **3.7M tokens**, bigger than any candidate model's context (~1M). The MiniSearch index builds in a few seconds.

---

## 3. Decisions made this session (and why)

| Decision | Who / why |
|---|---|
| Build the tool agent on the tables-only corpus first, then a hard variant | Ziad took my recommendation. Gives a clean "cost of finding it yourself" number, then "cost of a big corpus" |
| `suggestedLocation` on wrong_target verdicts, scored on items with a known true location | Ziad, as recommended. It's what a reviewer needs to fix the citation, and the only thing on these benchmarks that makes search matter (gives the embeddings ablation a metric) |
| Native function calling, submit_verdict as a tool, prose-JSON fallback | Ziad, as recommended |
| **Search = MiniSearch, in TypeScript** | Ziad wanted a library rather than hand-rolled BM25, asked "why not Python?", then "which is better regardless of effort, Python or TS for the agent?". My answer: TS. The agent is I/O orchestration with no in-process ML; search must run live inside the loop (the model invents queries), so Python would need a subprocess per call or a server; TS keeps a path to an editor/Word add-in for the live-feedback answer and shares types with the React viewer. Python stays for data prep, PDF parsing, and offline embeddings if needed. Orama was the alternative (keyword+vector+hybrid built in) but its hybrid fusion is less transparent than hand-written cosine + reciprocal rank fusion |
| v1 without retries, measure, then retries | Ziad, as recommended |
| **Retries = fresh context, as in the original plan** | Ziad chose this **against my recommendation** (I proposed rejecting submit_verdict inline in the same conversation, like form validation, which keeps what the agent already read and is cheaper). Implemented as he chose, with the failure reason passed in the fresh attempt's user message |
| Unresolved "supported" after all retries becomes a flag | My call, consistent with "budget exhausted = could not verify = flag, never a pass". **Not explicitly confirmed by Ziad** |
| Report-cites-report added as its own benchmark (`pmcrefs`) | Ziad raised "what about report-cites-report cases?" and said "accuracy is most important", then "make a recommendation and proceed". I prioritized ground-truth accuracy: same-unit number co-location, extra citing papers for sample size, label-preserving wrong_study |
| Hard-corpus content: non-results sections + tables for study reports, full text for references, leakage filter | Same instruction ("factor it in, recommend and proceed"). Not individually confirmed by Ziad |
| Retry note quotes the exact missing quote fragment | My call, after seeing that a fresh temperature-0 retry with a generic note reproduced the identical bad quote three times |
| Outline shows quoted labels; lenient section matching | My call, after the model repeatedly pasted whole outline lines ("Table 1: caption…") as the section name and wasted calls |

---

## 4. Results (all GPT-6 Luna, `openai/gpt-6-luna`)

### Table benchmark (`pmc`, 100-item sample, adjusted = human-reviewed labels)

| Run file (runs/) | Setup | Catch | False alarm | Grounded | $/check | p50 / p95 | Tool calls avg / max | Peak ctx avg / max | Right location |
|---|---|---|---|---|---|---|---|---|---|
| `2026-09-25T23-06-41_..._baseline` | baseline, table handed over (prev. session) | 93% [83–97] | 14% [7–27] | 98% | $0.00019 | 2.4s / 5.0s | – | 1.1k avg prompt | – |
| `2026-09-25T23-36-33_..._tool-tables` | tool v1, no retries, prompt v1 | 91.2% [81–96] | 11.6% [5–24] | 96% | $0.00058 | 4.8s / 9.8s | 1.9 / 6 | 2.1k / 7.4k | 80% |
| `2026-09-25T23-52-50_..._tool-tables-r2` | + retries, prompt v1 | 93.0% [83–97] | 9.3% [4–22] | 99% | $0.00062 | 4.7s / 11.4s | 2.1 / 13* | 2.1k / 5.2k | 88% |
| `2026-09-26T00-10-23_..._tool-tables-r2` | retries, prompt v2, tables store | 86.0% [75–93] | 7.0% [2–19] | 100% | $0.00051 | 4.0s / 11.0s | 1.8 / 8 | 2.2k / 6.4k | 96% |
| `2026-09-26T00-10-27_..._tool-full-r2` | retries, prompt v2, **full store (3.7M tokens)** | 89.5% [79–95] | 11.6% [5–24] | 100% | $0.00049 | 4.0s / 11.3s | 1.7 / 5 | 2.2k / 6.9k | 84% |

\* summed over 3 attempts of one retried check. Raw-label numbers for these runs: catch 82–88%, false alarms 22–26%.

### Report-cites-report benchmark (`pmcrefs`, 100-item sample, **raw labels, not reviewed**)

| Run file | Setup | Catch | False alarm | Grounded | $/check | p50 / p95 | Tool calls | Peak ctx | Right doc suggested |
|---|---|---|---|---|---|---|---|---|---|
| `2026-09-26T00-10-27_pmcrefs-sample_tool-full-r2` | tool agent, full store | 88% [76–94] | 62% [48–74] | 100% | $0.0011 | 9.0s / 20.5s | 5.5 avg, p95 11, max 17* | 3.9k / 10.9k | 68% |
| `2026-09-26T00-10-23_pmcrefs-sample_baseline` | baseline, whole cited paper handed over | 92% [81–97] | 60% [46–72] | 89% | $0.0010 | 3.0s / 6.7s | – | 7.8k avg prompt | – |

Per type (tool / baseline): value_mismatch 100/100, wrong_study 100/100, nonexistent 100/100, **overstated_subtle 50 / 67%**.

The rest are smoke runs (`23-36-13`, `00-06-50`, 6 items each) and can be deleted.

---

## 5. Findings, open decisions, open questions

### 5.1 Pending decisions (asked, questionnaire cancelled, re-ask)
1. **Number check** (my proposal): before accepting "supported", code checks that every informative number in the claim appears in the cited source (section, or whole doc for pmcrefs), with rounding tolerance (74.7 passes for 75; 0.630 doesn't pass for 0.66). A missing number triggers the same fresh-context retry with a note naming it. Targets the dominant miss (see 5.2). Recommended: add it and measure before vs after.
2. **pmcrefs label review.** Recommended: I (the agent) read each of the 50 good sample items next to its evidence unit in the cited paper, propose label + category, Ziad confirms changes; results go to `labels/pmcrefs_overrides.jsonl` (same format as `labels/pmc_overrides.jsonl`; `loadOverrides(dataset)` picks it up automatically). Alternatives: two strong models pre-screen and I settle disagreements; or Ziad reviews everything from a sheet.
3. **Re-review all 50 good table items** too (handoff §9.3 review bias). Recommended: yes, same process.
4. **Commit** this phase ("Phase 3: tool-using agent, hard corpus, report-cites-report benchmark"). Recommended: now, after updating WRITEUP.md. Ask first, and use the plumbing commit.

### 5.2 Findings
- **Finding the source costs little accuracy and ~3× the money.** On table claims the tool agent matches the baseline that's handed the table, within noise, at ~$0.0005 vs $0.0002 per check and ~2× latency.
- **Corpus size is irrelevant when the citation names the exact table.** Going from 50k to 3.7M tokens left tool calls (1.7–1.8), peak context (~2.2k) and cost unchanged. Context control only gets exercised by document-level citations (pmcrefs: 5.5 calls, peak ≤ 11k tokens).
- **Budget never exhausted** (12 per attempt). The closest call was one pmcrefs attempt that used 11. On table claims no attempt used more than 6. If you tighten the budget or make references longer, pmcrefs will start hitting it. **Retries rarely fire** (1–4 checks per 100, all ungrounded quotes) and **never flipped** flag↔pass. At temperature 0 a fresh retry reproduces the same output unless the note is specific.
- **Run-to-run variance is large.** Four tool runs on the same 100 table claims gave catch 86–93% and false alarms 7–12%. The swing is almost entirely value_mismatch items where the model **quoted the correct table value and still passed** (`pmc-0152`: claim p = 0.66, quoted 0.630; `pmc-0175`: 35.36% vs quoted 35.35%). Different runs miss different items. So 100-item single runs can't rank close configs (see challenge 3).
- **Subtle overstatement is still the weak spot:** 2/6 caught on tables in every run; 50–67% on pmcrefs.
- **pmcrefs "known-good" labels are heavily contaminated.** Both agents flagged 29 of the 50 good sample items (2 more by the tool only, 1 by the baseline only). Reading the agents' reasons (**not yet verified against the source text**), my tentative sort:
  - *Probably real discrepancies in the citing paper* (label → not_supported): ref-0074 (Western Europe 9.0% listed among "highest" though global is 11.7%; Caribbean 35.4% omitted), 0067, 0008 (torque Nm/kg vs force N/kg), 0000, 0009 (20 vs 30 min), 0072 ("4 in 5" vs 71%), 0036 (15 s vs 16–20 s), 0017, 0073 (oldest 86 vs 88), 0068, 0024 (per-protocol vs ITT), 0003 (three vs four targets), 0014, 0031, 0004, 0070, 0061. Also 0022, which needs checking: the agents say the α range is 0.85–0.95, yet number matching found 0.66 in the same unit.
  - *Details not in the source* (strict policy → flag): 0015, 0045, 0026, 0007, 0013, 0071, 0058.
  - *Probably agent pedantry* (label stays supported): 0042, 0020, possibly 0057, 0050.
  - Many are "method citations": the sentence describes the *citing* study's own procedure and cites a source for the protocol. That's a policy question for Ziad (see challenge 1).
  - If most flags are confirmed, the reviewed sample becomes ~25 good / ~75 bad, so the false-alarm CI gets wide. You'll need more good items.
- **Published papers have citation errors at a visible rate** in both benchmarks (6/50 table sentences, likely ~20/50 citing sentences). That's a good argument in the writeup for why the tool should exist.
- **Stuffing the whole cited paper (baseline) vs searching (tool):** same cost and similar accuracy, but the baseline is 3× faster and has worse quote grounding (89% vs 100%). Stuffing only works while the cited document fits comfortably; a real CSR won't.

### 5.3 Open questions (carried over or new)
- Should the strict prompt get a short list of domain equivalences (p = 0.00 ≡ p < 0.001, etc.)? (carried over)
- Does "supported → flag when unverifiable after retries" need Ziad's sign-off? (new)
- Do embeddings help? OpenRouter's `/api/v1/models` listed **no embedding models** this session. Check whether an embeddings endpoint exists; otherwise use a local model (transformers.js in Node for query embeddings, corpus vectors precomputed). The only meaningful metrics: `locationSuggestion` (table 84–96%, pmcrefs 68%) and pmcrefs evidence finding.
- Full-set (209 / 157) numbers need label review of new disagreements. (carried over)
- "Can a company rely on it?" My leaning hasn't changed: a strong first-pass filter that shrinks human review, not a sole sign-off. Subtle overstatement and model sloppiness on number comparison are the reasons.

---

## 6. What's left (replaces HANDOFF.md §7)

0. **Re-ask the four pending decisions** (§5.1), after your own challenges.
1. **Label review:** pmcrefs good items (50 sample, then the other 28 in the full set), then the 50 good table items. Decide the "method citation" policy first. Top up pmcrefs good items if relabeling leaves too few (raise `N_EXTRA_CITING` in prep_refs.py; the pool yields ~0.36 claims per citing paper).
2. **Number check** (if approved), measured with the first-attempt vs with-retries lines the report already prints.
3. **Variance handling:** repeated runs (2–3 per config) or full sets for anything that's compared.
4. **Search ablation:** keyword vs hybrid (keyword + embeddings via reciprocal rank fusion), measured on location suggestion and pmcrefs.
5. **Second-opinion variant** (skeptical re-check of `supported` only), aimed at overstated_subtle; measure recall gain vs false-alarm cost.
6. **Model sweep.** All 10 candidates support `tools` + `tool_choice` on OpenRouter (checked this session). Prices per M in/out: claude-opus-5.5 4/20, gpt-6-sol 2/10, gpt-6-luna 0.1/0.5, gemini-3.8-flash 0.75/3.75, grok-4.7 1.6/4.8, qwen3.8-27b 0.42/3, glm-5.3 1.4/4.4, deepseek-v4-pro-0813 0.26/0.79, **deepseek-v4.1-flash now 0.15/0.60** (HANDOFF.md said 0.1/0.6), granite-4.2-8b 0.06/0.25 (131k context; the others are ~0.5–1.3M). GPT-6 Sol wrote the subtle rewrites, so watch for GPT-family advantage.
7. **Accuracy / latency / cost answer** (see challenge 2 for a likely architecture).
8. **PDF parsing** (unchanged from HANDOFF.md).
9. **React viewer** (unchanged). Traces (`record.trace.steps`, `attempts`) are there for it to show.
10. **WRITEUP.md:** this session added "3. Report cites report" and "The hard corpus" under Benchmarks. Still TODO: the Agent design section (replace the plan text with what was built: tools table, the four context rules, objective checks + retries, "why not paste everything into a 1M window": 3.7M-token store, 100M+ tokens for a real submission), the tool-agent results, variance, and the pmcrefs label story once reviewed.

---

## 7. Repo state

- `HEAD` = `origin/main` = `cfcc673`. Uncommitted: modified package.json, pnpm-lock.yaml, src/{llm,quote,types}.ts, src/bench/{metrics,report,run}.ts; new python/{prep_refs,build_docs}.py, src/agents/{tool-agent,checks,checks.test}.ts, src/bench/{locations,locations.test}.ts, src/tools/.
- `pnpm typecheck` clean, `pnpm test` 24/24.
- Data (gitignored) is all present locally: data/pmc/docs_full.jsonl and data/pmcrefs/*. Caches make prep_refs deterministic (citing_candidates.json, idconv.json, rewrites.json, raw/, citing/). **Don't rerun prep_pmc.py casually**: its outputs are deterministic given its caches, but `labels/pmc_overrides.jsonl` is keyed to its item IDs.

## 8. Gotchas

- Launching runs as `(pnpm bench ... &)` from the agent shell: the processes got **killed when the tool call returned** (partial runs, no error). Use one backgrounded shell call: `cmd1 & cmd2 & wait`.
- Ad hoc Python: `uv run --python 3.11 -` (system Python is 3.9). Scripts with inline metadata work via `pnpm prep:*`.
- The `pnpm test` glob `src/**/*.test.ts` runs under sh (no globstar), so it only matches one directory level below src/. Fine today; deeper test files would be silently skipped.
- `isQuoteGrounded` splits on "..." and newlines. "Tidied" quotes, where the model moves a table row label onto a neighbouring row whose first cell is empty, are counted as ungrounded. That's accurate, but it's the source of most quote failures.
- MiniSearch search results: `filter` takes the stored fields; docId matching is case-insensitive in our wrapper.

---

## 9. Challenge these (my doubts, in priority order)

1. **pmcrefs as a benchmark may be measuring label noise more than the agent.** Number co-location proves the right *paper* was cited, not that the sentence represents it faithfully. Before a big review effort, consider narrowing claims to **attributive sentences** ("X et al. reported/found/showed…", or the sentence names the cited author) and dropping method citations ("samples were stored at −80 °C [12]"). Or decide explicitly that method citations are in scope and flags on missing protocol details are correct (strict policy). Either way this needs Ziad's call before labeling.
2. **The agent-first design may be wrong for explicit citations.** For "Study X, Table 14.2.1"-style citations, a deterministic resolver (parse the citation → fetch that section) plus one model call (the baseline) was as accurate, 2–3× cheaper and 2× faster. A likely production architecture: deterministic resolution first, and fall back to the tool agent only when resolution fails, the citation is document-level, or the verdict is wrong_target (to find the real location). This also answers "live feedback while editing". Test it rather than assume the agent everywhere.
3. **Sample size and variance.** ±3–4 points of run-to-run swing on top of ±10-point CIs means the planned model sweep on 100-item samples will produce rankings that are mostly noise for close models. Budget for repeated runs or full sets, and report ranges.
4. **Retries are mostly insurance.** They almost never fire, and when they do (quote issues on flags) they can only waste money or turn a correct flag into a pass. Consider retrying only `supported` verdicts, or only budget/number failures. Ziad chose fresh-context retries over inline validation; revisit with data, not taste.
5. **The number check is a heuristic, not an objective failure.** Derived numbers (differences, percentages computed by the author) and rounding will trigger it on good claims. Measure its false-alarm cost, not just the recall gain.
6. **The hard corpus only stresses document-level citations**, and nonexistent_target on pmcrefs (perturbed PMCID) is trivially caught by `get_outline` failing (100%). If context management is a headline answer in the writeup, make sure the claim is backed by pmcrefs numbers, not the table benchmark.
7. **Everything so far is one model (GPT-6 Luna).** Qualitative error patterns (pedantry vs leniency, tool-use failures, invented quotes) are still unknown for other families.
8. **Carry-overs from HANDOFF.md §9** still stand: numeric-only claims (no qualitative "well tolerated" claims); GPT-written subtle rewrites (2 of 6 table "misses" weren't real errors); strictness vs usefulness.
