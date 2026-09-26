# Checking citations

A citation check answers one question: does the cited location say what this sentence says? I built that as a lookup in code, then one model call on the text it found. A tool-using agent searches only when the citation names a whole document, or a section too long to paste in one page. On a five-item fixture that split was 3 lookups, 1 missing table (no model call, 23 ms, $0), and 1 document search (3 tool calls).

This is a study of how well that works, not a system to deploy. Draft submission text is assumed to be allowed out to a model API. Documents are assumed to be Word or XML exports, not scans. The reviewer is a QC reader before submission, so a few seconds per citation is acceptable and a live check should stay near one model call.

## What I cut, and why

The earlier plan had grown a tool agent, two corpora, a second benchmark, a ten-model sweep, a number check, and a queue of embeddings, a second-opinion pass, PDF parsing, a React viewer, and a finalist run on unreviewed items. Several of those were already showing they would not change the answer.

**Named tables do not need an agent.** On the PMC table sample, giving the model the table and letting it find the table were the same accuracy, within run-to-run noise. Finding it cost about 3× the money and about 2× the time. Growing the corpus from the tables alone to 3.7M tokens did not change tool calls, context size, or cost, because the citation already said `PMC123, Table 2`. The baseline that "resolved" the citation was reading `targetId` from the answer key. The resolver parses the citation string and opens that section. A missing document or a missing table is `wrong_target` with no model call.

**Search stays for citations that do not name a section.** A paper citing another paper, or a summary that only names a report, still needs keyword search and paged reading. That is the tool agent. It is the fallback, not the default.

**Embeddings are out.** The citation already contains the id. Keyword search on the claim's numbers is what the tool agent uses inside a document. There is no ranking metric left that embeddings would move, and OpenRouter was not serving an embeddings model.

**A second opinion is out.** The only miss the models share is subtle overstatement, and the reviewed sample has 6 of those. One item is the difference between 3/6 and 2/6. GPT-6 Sol wrote the rewrites. A second pass would add false alarms on a set that cannot rank anything.

**The report-cites-report set is not a leaderboard.** Number overlap showed the right paper was cited, not that the sentence was faithful. Many "good" sentences described the citing study's own procedure. The generator now keeps attributive findings sentences with distinct numbers. The regenerated set is 70 items and is not in git. I did not crawl more papers. Model comparison stays on the reviewed PMC table sample.

**I did not finish the sweep holes.** Qwen's tool run stopped at 97/100. Granite's tool run is too slow (tens of seconds to minutes per check) to be a candidate. GLM and Granite baselines were truncated at the old 2,000-token cap; `max_tokens` is 8,000 now, and those two baselines were not rerun. Differences of about 6 items per 100 between two runs of the same setup are noise. Another point of catch rate will not change which model I would ship.

**PDF parsing and a viewer are out of this round.** The parsing answer is: start from the structured export, where tables and headings already exist. PDF is a later measurement of how much accuracy that export is worth. The viewer would display flags the runner already writes as JSON.

**Retries are one number note, not a loop.** On the tool agent, fresh-context retries almost never fired, and when they did they did not flip a flag into a pass. The exception is the number check, which caught models quoting the right cell and still saying "supported". The fast path retries that case once. A second "supported" is kept, because a pooled percentage or a difference is a real number that is not in the table verbatim.

## Parsing

Prep reads JATS XML for open-access trial papers. Each table becomes a section: caption, rows, footnotes. A results sentence becomes a claim when at least 80% of its informative numbers sit in exactly one table. Informative numbers are decimals, and integers ≥ 13 that are not years; conventional values (`95% CI`, 0.05, 0.01, 100) are ignored. The citation string is `PMC12701592, Table 2`. The model never sees the original sentence in the report side, so it cannot match the claim by finding a copy of itself.

The checker then parses that string: a PMC id, and a table number when one is present. `Table 12` does not match `Table 1`. Resolution does not use the benchmark's `targetId`.

Claim extraction for a real summary would be the same shape. Explicit citations are a pattern (`Table 14.2.1`, `Smith et al. 2021 (PMC…)`). Sentences with no citation marker are out of scope until a person or a later model marks the span. I did not add that model. The benchmark's claims are the authors' sentences, chosen by the number rule, so the answer key is not a model's opinion.

## Benchmarks and labels

**SciFact** (claim vs abstract) was the first harness. Its false-alarm rate is high because the prompt is stricter than the academic labels. I kept the strict prompt. SciFact is a smoke test of the harness, not the ranking set.

**PMC tables** is the ranking set. 30 CC-BY trial papers, 209 claims, half left as written and half mutated: wrong number, wrong table, missing table, wrong paper, easy overstatement, subtle overstatement. The 100-item sample was read against the cited tables, including the good items and the rewrites, not only the rows a model had missed. 66 review rows are in `labels/pmc_overrides.jsonl`. Under those labels the sample is 43 good and 57 bad. The other 109 items are not reviewed. I am not ranking models on them. Published papers already contain citation mistakes; a handful of "good" sentences were real author errors and were relabeled.

**Report cites report** is built and then parked. See the cuts above.

The table benchmark's answer key is itself a number match. A code check that the claim's numbers appear in the table will look almost perfect on `value_mismatch` by construction. I still run it, and I say so when I quote catch rate. It is a safety net for a sloppy comparison, not evidence that the model can do arithmetic.

## Metrics

A flag is any verdict other than `supported`. **Catch rate** is the share of bad citations that were flagged (recall). **False-alarm rate** is the share of good citations that were flagged. The target I used is catch ≥ 95% and false alarms ≤ 10%.

At a 3% error rate in a real draft, false alarms per real catch are `(0.97 × false-alarm rate) / (0.03 × catch rate)`. A 10% false-alarm rate is about 3 false alarms per catch. A 5% false-alarm rate is about 1.7. That is the number a reviewer feels.

Rates on 50 items per class have a 95% Wilson interval of roughly ±10 points. Two configs within 6 flips per 100 items are tied. I compare them on the same items, and I read the first-attempt line when a retry did the work.

Quote grounding is a code check that the quote is a verbatim span of the text the model was shown. An empty quote is not counted. Invented evidence fails the check.

## What won

Numbers below are from the earlier PMC sample runs (GPT-6 Luna unless noted). This clone does not contain those `runs/` files, and some summaries were written before the last label pass. The sample's good/bad counts did not change in that pass (two items swapped sides). Treat gaps of a few items as noise.

| Setup | Catch | False alarms | Subtle (of 6) | $/check | p50 |
|---|---|---|---|---|---|
| Tool agent, Luna, full store | 93.0% | 4.7% | 2 | $0.00042 | 3.9s |
| Tool agent, Sol | 94.7% | 4.7% | 3 | $0.012 | 5.3s |
| Tool agent, Grok 4.7 | 94.7% | 9.3% | 3 | $0.017 | 14s |
| Tool agent, Gemini 3.8 Flash | 93.0% | 7.0% | 3 | $0.028 | 26s |
| Tool agent, DeepSeek V4 Pro | 91.1% | 4.7% | 3 | $0.006 | 5.6s |
| Tool agent, Opus 5.5 | 89.5% | 0% | 2 | $0.040 | 8.6s |
| Baseline, Luna (table handed over) | 93.0% | 14.0% | 2 | $0.00024 | 2.4s |
| Baseline, Sol | 93.0% | 14.0% | 2 | $0.005 | 3.6s |

The first attempt, before the number retry, is about 2 points lower on catch for Luna. With the retry, every strong model catches wrong numbers. "Careful with numbers" only shows up on the first-attempt line. Subtle overstatement stays at 2–3 of 6 for everyone.

**Accuracy.** Sol and Grok at 94.7% are inside noise of Luna at 93%. Opus flags nothing good and misses more bad items. I would not pay $0.04 to miss more.

**Latency.** The live path is the resolver: one call when the citation names a section. On the earlier baseline, Luna's median was 2.4s. On the five-item fixture (`fixtures/mini`, Luna, 26 Sep 2026) a resolved table was 1.5–2.7s, a missing table was 23ms, and a document-level citation that had to search was 3.4s. The fixture tables are smaller than PMC tables, so the dollar figures ($0.00008 for a table, $0.00052 for the search, $0 for the miss) show the shape, not the PMC price. A resolver run on PMC should sit next to the baseline's 2.4s and $0.00024, because it is the same single call, and missing targets become free.

**Cost.** Luna is the model. Sol is ~30× the price for a gain the sample cannot see. The tool agent on Luna was ~$0.00042 and two calls even when the citation named the table. Skipping those calls is the cost win. Document-level citations still pay for search.

The baseline's false-alarm rate (14% for both GPT models) is worse than the tool agent's (~5%). The resolver uses the baseline prompt on the resolved section, so I expect it to land nearer 14% than 5% until that prompt is understood. I did not have the PMC sample in this environment to measure it. Possible causes are the tool prompt ("judge the cited location only") and the way `read_section` formats a table versus `corpus.jsonl`. That is the open measurement. It does not bring back "agent for every table": the tool agent's lower false-alarm rate was a few items, and its extra cost is paid on every check.

## How good this is

It is a first pass that shrinks what a person re-reads. It is not a sign-off.

Wrong numbers, missing tables, wrong tables, and wrong papers are caught. On Luna's tool run that was essentially all of them, with the number check doing the last wrong-number cases. Subtle overstatement ("slightly stronger than the source") is caught about half the time or less, on six items. A company that needs those caught still needs a person.

False alarms that remain are pedantic: `p = 0.00` versus `p < 0.001`, or a direction the table's test statistic does not state. The prompt stays strict, because a regulator is strict. A short list of equivalences (`p = 0.00` means `p < 0.001`) would remove the ones that make a reviewer stop trusting the tool. I did not add them; they are a prompt edit with a before/after on the same 100 items, not a new system.

At Luna's 93% catch and 4.7% false alarms, a draft that is 3% wrong produces about 1.6 false alarms per real catch. That is reviewable. At the baseline's 14% false alarms it is about 4.9, which is the edge of what I would ask someone to read. The resolver should be measured against that line before anyone prefers it on false alarms.

## Models, qualitatively

All of these support tool calls on OpenRouter except that Opus rejects `tool_choice: "required"` when extended thinking is on. The client falls back to `auto`.

GPT-6 Sol, Grok, Gemini, and Luna flag more of the bad items and also flag a few good ones. Opus, GLM 5.3, and DeepSeek V4.1 Flash flagged no good items in the tool runs and missed more bad ones: they read as lenient, with the caveat that reasoning models were capped at 2,000 output tokens in those runs. GLM's baseline lost 17 of 100 checks to that cap (empty or cut-off JSON), so its baseline numbers are not usable. Granite 4.2 8B lost 60 baseline checks the same way and is too slow as a tool agent. Qwen 3.8 27B has no finished run.

Invented quotes were rare once the quote had to be copied from tool output (grounding near 100% on the tool agent, 89% when the whole paper was pasted). Budget exhaustion at 12 calls did not happen on table citations. Document-level checks used about 5 or 6 calls and peaked near 11, still under the cap, with context around 4k–11k tokens rather than the 3.7M-token store.

I would run Luna on the resolver for table citations, and Luna on the tool agent for document citations. I would not run a second model over the passes.

## Reliability, stated plainly

A QC reviewer can use the flags as a queue. They cannot skip the sentences the tool called supported, because subtle overstatement and an occasional derived number still get through. The number check makes "supported" slightly safer on numeric claims and does not touch claims with no numbers. Qualitative claims ("well tolerated", "no safety signal") are not in the benchmark.

Nothing here was measured on a 250,000-page dossier. The context design is ready for that size: one citation, one section, tool output capped and paged, no attempt to put the submission in the window. The accuracy numbers are from 30 papers and 100 reviewed items.
