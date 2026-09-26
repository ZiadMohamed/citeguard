# CiteGuard handoff

> **Update:** the plan that follows was narrowed in [`HANDOFF-5.md`](HANDOFF-5.md). The writeup is [`WRITEUP.md`](WRITEUP.md). Read this file for the assignment and working style, then the later handoffs only for history. [`HANDOFF-5.md`](HANDOFF-5.md) says what not to rebuild.

Context for an LLM picking this project up in a new chat. Read this fully before acting, then read `WRITEUP.md` (local-only draft) and skim `README.md`. You are expected to continue the work **and** push back on the plan where it's weak. There's a "Challenge these" section at the end with the doubts I had.

---

## 1. The assignment

A take-home-style weekend project (today is Fri Sep 25, 2026). The user is Ziad, a fullstack engineer (Node, TypeScript, React, AWS). Brief, paraphrased:

> An FDA drug application is ~250k pages, mostly test reports and summaries of them. Every reference between summaries and underlying reports (and between reports) must be checked. Misalignment caught by the FDA causes delays that cost >$1M/day. Build an agent that's really good at checking citations, plus a writeup (in Ziad's voice; he'll rephrase) answering:
> 1. How do we parse documents so claims and citations are understood?
> 2. How do we benchmark it / create ground truth? (Wikipedia and public datasets allowed.)
> 3. What error metrics, and how to interpret them?
> 4. How to design the agent, what tools, how to keep context from blowing up?
> 5. Which agent wins on accuracy? on latency (live feedback while editing)? on cost?
> 6. How good is it: a preliminary check needing human re-review, or something a company can rely on?
> 7. Try many models, open and closed. How does performance vary? Qualitative differences in errors?
>
> Success = a minimally functional agent, the writeup, some benchmarks. Not everything needs to be complete.

### Stakeholder answers (emailed by Ziad)
1. The error types we're targeting are all fine: wrong numbers, wrong table/section refs, nonexistent refs, overstated claims.
2. Scope down to text documents / PDFs exported from Word, with simple citation formats. No scans, no eCTD folder structure needed.
3. Citation style: simplifying assumptions are fine; Wikipedia style or research-paper style.
4. Test data: use something non-regulatory, e.g. Wikipedia or published papers.
5. **Recall matters more than precision**, but precision can't be horrendous.
6. Output format: our choice, whatever communicates performance best.

---

## 2. How Ziad wants to work (important)

- **Collaborative, step by step.** Before each step, ask him questions using the AskQuestion tool, with your recommendation marked "(Recommended)" and listed first. He wants to be kept in the loop and prompted at each piece.
- **Start simple, grow from there.**
- **Explain unfamiliar terms in plain English.** He knows Node/TS/React/AWS; ML and eval jargon (recall, embeddings, BM25, Wilson intervals, etc.) needs a one-line plain explanation the first time.
- **Commits:** one commit per finished phase, but **ask him before committing**.
  - **Never commit `WRITEUP.md`.** It's local-only (listed in `.git/info/exclude`). `HANDOFF.md` is also excluded.
  - **No `Co-authored-by: Cursor <cursoragent@cursor.com>` trailer.** The Cursor agent shell injects it automatically on `git commit`. Commit with plumbing instead, which doesn't get the trailer:
    ```bash
    git add -A
    C=$(git commit-tree $(git write-tree) -p HEAD -F /tmp/msg.txt) && git update-ref refs/heads/main $C
    ```
    Verify with `git log -1 --format=%B`. Past commits were already cleaned. Nothing has been pushed; `main` is ahead of `origin/main`.
- **The writeup is in Ziad's voice** (first person, engineer explaining decisions). Keep `WRITEUP.md` updated with real numbers after each phase.
- He's fine with Python for parsing / data prep; TypeScript for the agent, runner, and sweep. **No FastAPI**: everything is CLI scripts, and the React viewer will read JSON files directly.
- He prefers **our own agent harness, no frameworks** (no LangChain etc.).

---

## 3. What's built (3 commits on `main`)

Repo root: `/Users/ziadosman/citeguard`

```
python/prep_scifact.py    SciFact -> data/scifact/{corpus,items,items_sample}.jsonl
python/prep_pmc.py        PMC RCT papers -> data/pmc/{papers,corpus,items,items_sample}.jsonl (+ raw/ cache, rewrites.json cache)
labels/pmc_overrides.jsonl   21 human-reviewed label corrections (status: confirmed)
src/types.ts              BenchItem, SourceDoc, CheckResult (zod), RunRecord, Usage
src/llm.ts                ~100-line OpenRouter client: fetch, retries/backoff, tool-call types, usage+cost ({usage:{include:true}})
src/parse.ts              pulls the JSON object out of a model reply, validates with zod
src/quote.ts              isQuoteGrounded(): normalized substring check per fragment (split on "..." and newlines)
src/agents/prompts.ts     VERDICT_RULES (strict) + OUTPUT_FORMAT
src/agents/baseline.ts    no-tools agent: one call with claim + citation + resolved source text; 1 retry on unparseable output
src/bench/datasets.ts     loadDataset, loadOverrides, applyOverrides, readJsonl
src/bench/metrics.ts      summarize(): catch rate, false-alarm rate, flag precision, verdict accuracy, quote grounded, per-type, confusion, cost, latency, Wilson 95% CIs
src/bench/report.ts       raw + adjusted (overrides applied) report
src/bench/run.ts          CLI runner with concurrency pool; writes runs/<stamp>_<dataset>-<split>_<agent>_<model>.jsonl + .summary.json
src/bench/rescore.ts      recompute a report from a saved runs/*.jsonl (no API calls)
src/*.test.ts, src/bench/metrics.test.ts   node:test (8 tests)
```

Commands:
```bash
pnpm install
cp .env.example .env            # OPENROUTER_API_KEY (already set on Ziad's machine)
pnpm prep:scifact               # needs uv
pnpm prep:pmc                   # ~3-5 min first time; cached after
pnpm bench [--dataset scifact|pmc] [--split sample|full] [--agent baseline] [--model openai/gpt-6-luna] [--concurrency 8] [--limit N]
pnpm rescore runs/<file>.jsonl
pnpm test && pnpm typecheck
```

Environment: macOS, Node 20.14 (Vitest 5 fails on this Node because of a rolldown native binding, so tests use `node:test` via `tsx --test`; Node 20's test runner doesn't glob, so paths are listed explicitly), pnpm 10, uv for Python ≥3.11 (system Python is 3.9). `data/` and `runs/` are gitignored.

### Verdicts and metrics
- Verdicts: `supported` | `not_supported` (right source, but it contradicts/differs/overstates) | `wrong_target` (citation doesn't resolve, or points at an unrelated source).
- Any non-`supported` verdict counts as a **flag**. Catch rate = flagged problems / all problems (recall). False-alarm rate = flagged good citations / all good citations.
- The agent must return verdict, **verbatim quote**, location, and a one-line reason. `quoteGrounded` checks in code that the quote exists (catches invented evidence).
- **Target agreed with Ziad: catch ≥95%, false-alarm ≤10%.** Also report false alarms per real catch at a realistic 3% error rate: FA-per-catch = (0.97 × FAR) / (0.03 × recall). E.g. FAR 10% gives ~3.2 per catch; FAR 56% gives ~18.

---

## 4. Benchmarks

### SciFact (claim level, human labels)
- Dev split: 300 claims → 340 (claim, cited abstract) pairs: SUPPORT 138, CONTRADICT 71, NOINFO 131. Plus 100 "SWAPPED" items (cited doc replaced with a random abstract) = 440 items.
- Mapping: SUPPORT→supported; CONTRADICT, NOINFO→not_supported; SWAPPED→wrong_target.
- Sample: balanced 100 (50 SUPPORT, 17 CONTRADICT, 17 NOINFO, 16 SWAPPED), seed 42.

### PMC (document level, the main benchmark)
- 30 open-access CC-BY RCT papers (2020–2025, ≥3 tables) from the Europe PMC search API. XML is fetched from the public S3 bucket `pmc-oa-opendata` (`PMCxxxx.1/PMCxxxx.1.{xml,pdf,txt,json}`; **PDFs are there too**, for the parsing phase).
- **Claims are the authors' verbatim results sentences.** A sentence becomes a claim if ≥80% of its "informative" numbers (decimals, or integers ≥13 that aren't years; "95% CI", 0.05, 0.01, 0.001, 95, 100 ignored) appear in exactly one table, and the second-best table covers <50%. Parentheticals mentioning Table/Fig are stripped, and sentences still mentioning tables are dropped.
- Citation string: `PMC12701592, Table 2`. `targetId`: `PMC12701592/Table 2`.
- **The searchable "report" side is tables only** (`corpus.jsonl`: one SourceDoc per table, with title = caption, text = rows joined by ` | ` plus footnotes). The full paper text is excluded so the agent can't find the original unmodified sentence.
- 209 claims: 104 left as-is (SUPPORTED) and 105 mutated round-robin across 6 types: `value_mismatch` (digit transposition/nudge, new value verified absent from the table), `wrong_location` (another table in the same paper with <30% number coverage), `nonexistent_target` (Table max+1..3; targetId null), `wrong_study` (same table number in another paper, <30% coverage), `overstated` (GPT-6 Sol rewrite, numbers verified identical), `overstated_subtle` (one small GPT-6 Sol edit, SequenceMatcher ratio ≥0.85). If a mutation fails, the next type is tried.
- Current counts: SUPPORTED 104, value_mismatch 24, wrong_location 18, nonexistent_target 18, wrong_study 17, overstated 15, overstated_subtle 13. Sample: 50 good + 50 bad (~8–9 per type).
- Rewrites and the candidate list are cached (`data/pmc/rewrites.json`, `data/pmc/raw/candidates.json`), so reruns are deterministic. Two GPT-6 Sol rewrite calls returned null content (probably reasoning tokens eating `max_tokens: 400`).
- **Label overrides** (`labels/pmc_overrides.jsonl`): I reviewed every false alarm and miss from the GPT-6 Luna baseline run on the PMC sample, and Ziad confirmed. Categories: `author_error` (6: real errors in published papers), `not_in_source` (3: claim has facts the table lacks, flagged under the strict policy), `pedantic` / `interpretation` (6: genuine agent false alarms, label stays supported), `not_an_error` (2: subtle rewrites that aren't errors, relabeled supported), `real_subtle_error` (4: genuine misses). The report shows raw and adjusted metrics.

---

## 5. Results so far (all GPT-6 Luna, `openai/gpt-6-luna`, $0.10/$0.50 per M tokens)

| Run | Catch | False alarm | Quote grounded | $/check | p50 / p95 |
|---|---|---|---|---|---|
| SciFact sample, baseline | 100% [93–100] | 56% [42–69] | 96% | $0.00017 | 2.5s / 4.9s |
| PMC sample, baseline, raw labels | 88% [76–94] | 30% [19–44] | 98% | $0.00019 | 2.4s / 5.0s |
| PMC sample, baseline, adjusted labels | 93% [83–97] | 14% [7–27] | | | |

Observations:
- SciFact false alarms are mostly the strict prompt refusing generalizations the academic annotators accepted ("hypoglycemia increases dementia risk" vs severe episodes in older T2D patients). **Ziad chose to keep the prompt strict** (regulators are strict), and treats the SciFact false-alarm rate as inflated by lenient labels.
- PMC: 100% catch on value_mismatch, wrong_location, nonexistent_target, wrong_study, and the easy overstated type. **The only weakness is subtle overstatement (~33% caught).**
- The remaining genuine false alarms are pedantic ("p = 0.00" vs "p < 0.001") or refuse reasonable interpretations.
- The baseline is handed the resolved table, which makes it easy. The tool-using agent must find it.

---

## 6. Decisions made (and why)

| Decision | Why |
|---|---|
| TS for agent/runner, Python for data prep/parsing, JSONL in between | Ziad reads TS; Python has better PDF/data tooling |
| Own harness, no framework | Need visibility into tokens, tool calls, context size, cost |
| OpenRouter for all models | One key/API for open and closed models; stakeholder gave the key |
| Benchmark before agent | Every change gets a score |
| PMC instead of a synthetic FDA dossier | Stakeholder asked for non-regulatory public data; real author text; XML gives a parsing answer key |
| Verbatim claims, number-matching linkage | Minimal LLM involvement, so no model-family home advantage |
| Tables-only report corpus | Prevents leakage of the original sentence |
| Balanced 50/50 samples | Tight enough CIs on both catch and false-alarm rates |
| Keep strict prompt | Regulatory context; SciFact labels are lenient |
| Subtle + easy overstated variants both kept | Report easy vs subtle separately |
| Parse XML first (perfect parser), PDFs later | Isolates agent quality; the later drop = cost of parsing |
| Output: React viewer (Ziad's pick) | Document on the left, flags inline. Not started |

### Agent design agreed (NOT built yet)
- The agent gets only the claim + citation text and must find the source itself.
- Tools: `list_documents`, `get_outline` (headings + table captions), `read_section` (paginated), `search`, `submit_verdict`. **Keyword search first** (BM25: classic term-frequency ranking); **embeddings as a switch** (Ziad wants both keyword + embeddings; I proposed hybrid via reciprocal rank fusion, measured as an ablation).
- Context control: fresh context per citation; tool outputs capped ~2k tokens and paginated ("page 1 of 4"); budget of **12 tool calls**. Log steps used; running out means a forced answer recorded as "could not verify" and **counted as a flag, never a pass**.
- **Retries only on objective failures** (max 2, fresh context): ungrounded quote, nonexistent location, unparseable output, budget exhausted. Ziad initially proposed an LLM judge re-grading every output; I pushed back (the judge has no answer key, models share blind spots, it doubles cost) and he agreed.
- **Second opinion on passes** (optional variant): only `supported` verdicts get a skeptical re-check (different prompt or model); flag if it disagrees. It targets the expensive error (a missed problem) and should help subtle overstatements. Measure its recall gain vs false-alarm cost.
- One citation per run (batching per section = later cost optimization).

---

## 7. What's left (planned order)

1. **Tool-using agent** (`src/agents/tool-agent.ts` + `src/tools/*`): harness loop using `chat()` with `tools`, the tools above over `data/pmc/papers.jsonl`, budget/pagination/retry logic, per-check step logging. Add it to `AGENTS` in `run.ts`. Compare to the baseline on the PMC sample.
2. **Search ablation:** keyword vs hybrid (keyword + embeddings). Check whether OpenRouter serves embeddings; otherwise a local model (transformers.js or Python sentence-transformers).
3. **Second-opinion variant** and its measured effect, especially on `overstated_subtle`.
4. **Model sweep** on the PMC sample (then full set for finalists). Candidates currently on OpenRouter (input/output $ per M tokens):
   - closed: `anthropic/claude-opus-5.5` (4/20), `openai/gpt-6-sol` (2/10), `openai/gpt-6-luna` (0.1/0.5), `google/gemini-3.8-flash` (0.75/3.75), `x-ai/grok-4.7` (1.6/4.8)
   - open-weight: `qwen/qwen3.8-27b` (0.42/3), `z-ai/glm-5.3` (1.4/4.4), `deepseek/deepseek-v4-pro-0813` (0.26/0.79), `deepseek/deepseek-v4.1-flash` (0.1/0.6), `ibm-granite/granite-4.2-8b` (0.06/0.25)
   - Note GPT-6 Sol generated the overstated rewrites, so watch for GPT-family advantage.
   - Also characterize qualitative error differences per model (pedantic vs lenient, invented quotes, tool-use failures, budget exhaustion).
5. **Accuracy / latency / cost answer:** e.g. best model + second opinion for accuracy; a cheap fast model with the baseline (cited section handed over) for live editing feedback; a cheap model plus escalation of flags or low-confidence cases to an expensive model for cost.
6. **PDF parsing** (Python; PyMuPDF / pdfplumber / docling): parse the same 30 PDFs, rebuild tables and sections, compare to XML-derived tables, rerun the agent on the PDF-derived corpus, and report the accuracy drop. Also the claim/citation extraction story for the writeup (regex for explicit refs plus LLM for implicit claim spans).
7. **React viewer:** document with inline flags (verdict, quote, reason), reading `runs/*.jsonl` + `data/pmc/*`. Vite + React, no backend.
8. **Writeup:** fill the TODO sections (agent design, parsing, accuracy/latency/cost, model comparison, reliability verdict), plus a leaderboard table and one cost-vs-catch-rate chart.

---

## 8. Open questions

- Does the tool agent lose accuracy vs the baseline (it has to find the table)? How often does it hit the 12-call budget?
- Do embeddings help at all when citations are explicit IDs? (Likely only for `wrong_location` diagnosis / finding where a claim really lives.)
- Should the strict prompt get a small list of domain equivalences (e.g. "p = 0.00 means p < 0.001", "testing rate" = "ever tested") to kill pedantic false alarms without loosening strictness?
- Full-set (209) numbers need label review of new disagreements, since overrides only cover the sample items that GPT-6 Luna disagreed with.
- Final "can a company rely on it" position. My current leaning: at ≥95% recall it's a strong first-pass filter that shrinks human review to the flagged set, but it's not a sole sign-off, especially for subtle overstatements.

---

## 9. Challenge these (my doubts about the current plan)

1. **The PMC benchmark doesn't stress what makes the real problem hard.** The citation string contains the exact paper ID and table number, and the corpus is only ~120 tables. Resolving the citation is trivial, and context never gets big. The FDA problem is 250k pages with references into long reports. Consider adding the papers' methods/other sections plus distractor papers to the corpus, or citing sections instead of tables, so search and context management actually matter.
2. **Only numeric claims.** Number matching was used to build the answer key, so qualitative claims ("well tolerated", "no safety signals") aren't represented, even though they're where overstatement lives in real submissions.
3. **Review bias in the label overrides.** I only reviewed items where the model *disagreed* with the label. Items where the model and the label are both wrong were never examined, which flatters the adjusted numbers. A fix: review all 50 good sample items once, independent of any model.
4. **Overrides are tied to one model's disagreements.** Other models will disagree on different items, so new human review each time. Budget for it, or have two different strong models pre-screen.
5. **Sample size.** 100 items gives ±~10 percentage-point CIs, too wide to rank models that are close. Use the full 209 (and more papers) for final comparisons.
6. **Strictness vs. usefulness.** Keeping the prompt strict is defensible, but most remaining false alarms are pedantry. A reviewer who sees "p = 0.00 ≠ p < 0.001" twice will stop trusting the tool. The second-opinion variant will add false alarms on top.
7. **Subtle rewrites are LLM-generated by the GPT family,** and 2 of 6 misses weren't real errors. The subtle set may need more human curation before it's used to rank models.
8. **SciFact mapping.** NOINFO→not_supported vs wrong_target is debatable; it doesn't affect the flag metrics but does affect the 3-way verdict accuracy.
