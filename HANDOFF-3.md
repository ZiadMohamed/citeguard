# CiteGuard handoff, part 3 (session of Fri Sep 25, 2026, late evening)

> **Update:** a later session started the pmcrefs generator fix, raised `max_tokens` to 8000, and stopped the sweep mid-run. **§1 and §8 here are wrong about git and running processes.** Read this file for the number check, sweep design and label review, then **[`HANDOFF-4.md`](HANDOFF-4.md)** for the real repo state and plan.

For an LLM picking this project up in a new chat. Read in this order:

1. [`HANDOFF.md`](HANDOFF.md): sections 1–2 (the assignment, stakeholder answers, how Ziad wants to work, commit rules) still apply in full.
2. [`HANDOFF-2.md`](HANDOFF-2.md): what the tool agent, the hard corpus and the `pmcrefs` benchmark are and how they were built.
3. This file: what changed since part 2, what's stale there, the pending decisions and the plan.
4. `WRITEUP.md` (local-only draft, Ziad's voice).

You are expected to **challenge what's built and the plan before proceeding**. There's a "Challenge these" section at the end. Don't just continue the to-do list; say where you think it's wrong first, using AskQuestion with your recommendation first and marked "(Recommended)". This session did exactly that at the start (§3 lists what Ziad decided), and it changed the plan.

The working style is unchanged: ask before each step (AskQuestion, recommendation first), plain-English explanations of ML/eval jargon, no commit without asking, never commit `WRITEUP.md`, commit with the `git commit-tree` plumbing (HANDOFF.md §2) to avoid the Cursor co-author trailer. All three handoff files are in `.git/info/exclude`.

---

## 0. What's stale in HANDOFF-2.md

- **§7 "Everything is uncommitted"**: stale. Phase 3 was committed as `b229d3e` and pushed; `origin/main` == `HEAD` == `b229d3e`. This session's new code is uncommitted (§8).
- **§5.1 pending decisions**: all four answered (§3). Unresolved "supported" becoming a flag (§5.3 there) is confirmed too.
- **§5.2 "Run-to-run variance is large ... 86–93%"**: that range mixed different prompts and settings. Real noise between identical configs is 3–6 flag/pass flips per 100 items (§4.2). The conclusion (100-item single runs can't rank close configs) still holds.
- **§5.2 pmcrefs label contamination**: the diagnosis was incomplete. Much of it is the generator, not author sloppiness (§5.3). The per-item review plan is replaced by "fix the generator first".
- **§5.1 item 1 "Number check (proposal)"**: built and measured (§2, §4.1). Uncommitted.
- **§6 "What's left"**: replaced by §7 here. The model sweep moved up and is running.
- **Challenge 2 there** (deterministic resolver): the baseline doesn't actually resolve citations. It looks the source up through the answer key's `targetId` (`run.ts`, `AGENTS.baseline`). A real resolver still has to be written.

---

## 1. Where the session ended

- **This is an exercise, not a system to launch.** Ziad's clarification at the end of the session: the point is to see how far we can get, and it's fine to make assumptions. Production concerns (deployment, data residency, integration with authoring tools, audit trails) are out of scope; state assumptions in the writeup instead of asking. §6 has the stakeholder answers and the assumptions made on them.
- **The model sweep is closed** (§4.3). 10 models × {tool agent, baseline} on the 100-item table sample, all re-scored with the final labels. Three runs are incomplete or unusable, all listed in §7 item 1: Granite's tool run was stopped on purpose at 42/100 (median 67 s per check), and the GLM and Granite baselines lost most of their checks to the output-token cap (§5.4). No background processes are left running.
- **Table-sample label review: confirmed by Ziad and written** to `labels/pmc_overrides.jsonl` (45 entries, all `confirmed`; §5.1).
- **Committed and pushed** (§8): the number check, the Anthropic `tool_choice` fallback and the label file.

---

## 2. What was built this session (committed, §8)

```
src/numbers.ts            informativeNumbers(): TS port of prep_pmc.informative_numbers (decimals; integers >= 13 that aren't
                          years; ignores 0.05/0.01/0.001/0.0001/95/100 and "95% CI"), plus: distinct numbers only, leading-dot
                          decimals (".026"), and skips numbers inside names ("IL-27", "FGF-21", "SF-36").
                          hasNumber(): exact match ignoring sign ("decrease of 2.7" vs -2.7), or a more precise source value that
                          rounds to the claim's precision (claim 75 matches 74.7; 0.66 doesn't match 0.630; 0.60 doesn't match 0.63).
                          Precision comes from the raw string, so "0.60" keeps 2 decimals.
                          missingNumbers(): claim numbers absent from the source, with the source's 2 closest values as written.
src/numbers.test.ts       5 tests.
src/agents/checks.ts      objectiveFailures(out, {claim, citation}, store, {checkNumbers}) (signature changed: it used to take the
                          citation string). New failure code number_missing: only on "supported" verdicts; compares the claim's
                          numbers against the CITED location from the store (the named table, or the whole document for
                          document-level citations), not against what the model happened to read.
src/agents/tool-agent.ts  checkWithRetries: number_missing fires at most once per check. The retry note names the missing numbers
                          and closest values and says "if a number is legitimately derived, say so in the reason". A retry that was
                          told and still says "supported" is accepted (so derived numbers can pass). The note is carried into later
                          retries. With --retries 0 the check acts as a hard rule (unverifiable supported -> flag).
                          chatWithTools(): if a provider rejects tool_choice "required" (Anthropic with extended thinking does),
                          remember the model and use "auto" (a prose reply is already handled: nudge, counts as a call).
src/types.ts              FailureCode + "number_missing".
src/agents/checks.test.ts updated helper; +2 tests (number check on table and document citations).
```

`pnpm typecheck` clean, `pnpm test` 31/31.

---

## 3. Decisions made this session

All via AskQuestion. Ziad picked the recommended option every time except Granite (the recommendation was to wait for it to finish).

| Decision | Choice |
|---|---|
| pmcrefs "known-good" claims | **Fix the generator first**: count only distinct numbers, ignore numbers inside names, keep only sentences reporting the cited paper's own results (drop descriptions of the citing study's procedure), regenerate with more citing papers to get back to ~50 good, then the agent reviews only flagged good items and Ziad confirms |
| Table-sample labels | **Review the whole sample once, independent of any model** (all good items + the overstated rewrites), so the sweep has one fixed answer key |
| Number check | **Build as proposed** (retry with a note naming the number and nearest values), report it as its own line, caveat the circularity in the writeup |
| Order | **Commit → number check → sweep in background → label reviews + pmcrefs fix while it runs → resolver-first pipeline → PDF parsing → writeup.** Second opinion after the sweep using its best model; embeddings only if time is left |
| Commit | **Commit Phase 3 and push** (done: `b229d3e`) |
| Unverifiable "supported" after retries | **Keep as a flag** (confirmed) |
| Sweep scope | **All 10 models × both agents** (tool agent on the full store with retries + number check; baseline with the table handed over) on the table sample; estimated $8–28 |
| Finalists | **Top 3 by catch rate at an acceptable false-alarm rate, plus the cheapest model within noise of them, tool agent only, full 209-item set** |
| pmc-0132 | **Relabel to `supported`, category `not_an_error`** (footnote: p < 0.05 vs placebo) |
| pmc-0003 | **Relabel to `not_supported`, category `not_in_source`** (direction can't be verified from F-tests; the §6 strictness rule) |
| Overrides file | **Record all 45 reviewed items as `confirmed`, with notes** (done) |
| Granite 4.2 8B tool run | **Stopped at 42/100** (too slow); ran its baseline only |
| `max_tokens` fix + reruns | **Next session**, together for all reasoning models (§7 item 1) |
| Commit | **Commit and push** this session's code and labels (done, §8) |
| Stakeholder answers | See §6: exercise only, QC reviewer before submission, strictness and error-rate assumptions are ours to make |

---

## 4. Results

All on the `pmc` 100-item table sample. §4.1 and §4.2 were measured with part 1's 21 overrides. §4.3 is re-scored with the final 66 (13 of them change a sample label). The sample is 43 good / 57 bad under both, but pmc-0003 and pmc-0132 swapped sides.

### 4.1 Number check

- **Offline replay** (no API calls, real TS code, `supported` forced on every item): fires on 100% of value_mismatch (24/24 full set), wrong_location (18/18), wrong_study (17/17); on 3/104 good items; 2/15 overstated, 0/13 subtle. On pmcrefs: 0/78 good, but only 15/21 value_mismatch and 20/23 wrong_study (see §5.4 on why document level is weak).
- **This is partly circular**: the table benchmark's answer key was built by number matching, so a number check looks near-perfect by construction. On human-written SciFact claims with numbers it fired on 2 of 6 good ones ("1,000 Genomes", inhibitor "CK-666"; n is tiny).
- **Measured** (GPT-6 Luna, runs `00-33-27` tables, `00-33-30` full, paired with the part-2 runs `00-10-23` / `00-10-27`): the check fired only on value_mismatch items (pmc-0152 in both runs, pmc-0175 once), **never on a good item**, and every firing turned a wrong pass into a flag. value_mismatch catch is 9/9 in both runs. Headline: catch 91.2% both, false alarms 4.7% / 7.0%. First attempt only (the model alone): catch 89.5% / 87.7%.

### 4.2 Noise between identical configs

- Tables vs full store (same prompt; the store barely matters for table citations): 4 of 100 items flip flag/pass.
- Same config run twice, excluding items where the number check fired: 3 flips (tables) and 6 flips (full store) per 100.
- GPT-6 Luna tool agent, full store, identical config, runs `00-33-30` vs `00-39-26`: catch 91.2% vs 93.0%, false alarms 7.0% vs 4.7%.
- So: **differences of ≤6 items per 100 between two configs are noise.** Compare configs item by item on the same items ("paired": count items where A flags and B doesn't, and vice versa), and use the full set for finalists. Repeating runs doesn't shrink the ±10-point interval that comes from having only ~50 items per class.

### 4.3 Model sweep (partial; still running at handoff)

| Model | Agent | Catch | False alarm | Subtle caught | First attempt catch / FA | $/check | p50 / p95 | Failed |
|---|---|---|---|---|---|---|---|---|
| gpt-6-sol | tool | **94.7%** | 4.7% | 3/6 | (no retries fired) | $0.0118 | 5.3s / 15.7s | 0 |
| grok-4.7 | tool | **94.7%** | 9.3% | 3/6 | 95% / 9% | $0.0167 | 14.3s / 138s | 0 |
| gpt-6-luna | tool (`00-39-26`) | 93.0% | 4.7% | 2/6 | 91% / 5% | $0.00042 | 3.9s / 11.0s | 0 |
| gpt-6-luna | tool (`00-33-30`) | 91.2% | 7.0% | 2/6 | 88% / 7% | $0.00043 | 3.7s / 10.5s | 0 |
| deepseek-v4-pro-0813 | tool | 91.1% | 4.7% | 3/6 | 91% / 5% | $0.0062 | 5.6s / 30.4s | 1 |
| claude-opus-5.5 | tool | 89.5% | 0.0% | 2/6 | 88% / 0% | $0.0400 | 8.6s / 18.8s | 0 |
| glm-5.3 | tool | 86.0% | 0.0% | 2/6 | 88% / 2% | $0.0104 | 9.5s / 139s | 0 |
| deepseek-v4.1-flash | tool | 83.9% | 0.0% | 2/6 | 86% / 0% | $0.0014 | 6.2s / 130s | 2 |
| gpt-6-sol | baseline | 93.0% | 14.0% | 2/6 | – | $0.0046 | 3.6s / 127s | 0 |
| gpt-6-luna | baseline | 93.0% | 14.0% | 2/6 | – | $0.00024 | 2.4s / 4.6s | 0 |
| glm-5.3 | baseline | 90.7% | 0.0% | 2/6 | – | $0.0076 | 4.5s / 19.3s | **17** |
| deepseek-v4-pro-0813 | baseline | 89.1% | 9.5% | 3/6 | – | $0.0016 | 5.9s / 37.8s | 3 |
| claude-opus-5.5 | baseline | 87.7% | 0.0% | 2/6 | – | $0.0112 | 4.2s / 7.5s | 0 |

14 of 20 runs done at the last check. Still running: tool agent for gemini-3.8-flash, qwen3.8-27b, granite-4.2-8b; baselines for deepseek-v4.1-flash, grok-4.7, and then gemini, qwen, granite. "Failed" is mostly network `fetch failed` after 4 attempts (§9), **except GLM's baseline**: 14 empty replies and 3 JSON cut off mid-quote. That's the 2000-token `max_tokens` cap running out during reasoning (§5.4), so GLM's baseline numbers are unusable until rerun with a higher cap. Catch n = 57, false-alarm n = 43 (after overrides), minus failed checks.

A pattern to check: the three Anthropic/GLM/DeepSeek-Flash tool runs have 0% false alarms but 84–90% catch (lenient), while GPT-6 Sol and Grok catch 94.7%. Paired comparison is needed before calling any of it real (§4.2).

Costs: Claude Opus 5.5 tool agent ≈ **$0.04/check** ($4 for the run; the 3-check smoke test suggested $0.08). Projected sweep total ≈ $15–20. Granite 4.2 8B takes 12–160 s per check.

**Aggregating:** there's no leaderboard script yet. The summaries are `runs/*.summary.json` with keys `raw`, `adjusted`, `firstAttempt` (only when some check retried). In `adjusted`: `catchRate`, `falseAlarmRate`, `flaggedByType`, `costPerCheckUsd`, `latencyMs.{p50,p95}`, `agent`, `failed`. The one-off Python used this session is easy to redo; a `src/bench/leaderboard.ts` (+ paired comparison) is worth proposing to Ziad.

---

## 5. Findings, pending decisions, open questions

### 5.1 Pending decisions (the questionnaire was interrupted; re-ask)

1. **pmc-0132** (injected "overstated" rewrite): "The active treatment demonstrated statistically significant superiority over placebo, increasing posterior total hair count by 13.1 (21.4) (p < 0.0005)...". The table's footnote b for that row says "p < 0.05 versus placebo", so the rewrite is supported. Recommended: relabel to `supported`, category `not_an_error` (as with the 2 subtle rewrites relabeled in part 1). Alternative: keep, because the p < 0.0005 next to it is the within-group p-value.
2. **pmc-0003**: "Self-assessed knowledge *increased* significantly over time (F = 28.39, p < 0.001)...". Every statistic matches, but the table has only F-tests, so the direction can't be verified. Recommended: `not_supported`, category `not_in_source` (same strict rule as part 1's age range and within-group p-values). Alternative: keep supported as a minor detail. **This may be superseded by the stakeholder's strictness answer (§6 question 5).**
3. **Record all 45 reviewed items in the overrides file?** Recommended: yes. Entries that keep the label are no-ops in `applyOverrides` (it skips `o.label === item.label`), and part 1's file already has such entries. They document that the whole sample was checked. Use `status: "proposed"` until Ziad confirms, then `"confirmed"` (note: `loadOverrides` does not filter by status, so anything written is applied). Include the notes in §5.2.

### 5.2 Table-sample label review (this session)

The 45 sample items never examined before (21 were reviewed in part 1): 35 good items read against their cited tables, and 10 injected rewrites (8 overstated, 2 subtle; the other 6 subtle were reviewed in part 1). Done without looking at any model's verdicts.

- **Good items: 34 of 35 correct as labeled.** Only pmc-0003 is questionable (§5.1). IDs reviewed: pmc-0003, 0004, 0015, 0016, 0019, 0022, 0030, 0035, 0036, 0040, 0041, 0042, 0043, 0044, 0046, 0048, 0051, 0055, 0056, 0061, 0067, 0068, 0070, 0074, 0075, 0081, 0082, 0084, 0087, 0089, 0090, 0091, 0093, 0096, 0103.
- **Rewrites: 9 of 10 are real errors**; pmc-0132 isn't (§5.1). Reviewed: pmc-0120, 0132, 0138, 0144, 0150, 0156, 0180, 0186 (overstated), 0139, 0205 (subtle).
- Notes worth recording:
  - **pmc-0205** (subtle, stays not_supported): the authors' *original* sentence already swaps two groups' percentages (text: Pre-tramadol 68.4%, Post-tramadol 57.9%; table: 57.9% and 68.4%). One more published author error, and the item has two problems, so a catch may be for the wrong reason.
  - **pmc-0090** (stays supported): "20% healthy weight, 26% overweight, 19% obese, 25% severely obese" is the two arms pooled ((16 + 28) / 220 = 20%). Correct, but derived. A real example for the number-check caveat; the check passes here only because 20/26/19 happen to appear elsewhere in the table.
  - Traps for pedantic checkers (stay supported): pmc-0070 (table "p < 0.000", claim "p < 0.001"); pmc-0081 (the table's own t = 1.93 with p = 0.04 is internally inconsistent, but the claim copies the table).
- Conclusion: the unexamined labels were almost all right, so part 1's review bias was small on this benchmark. After the pending decisions, the sample is roughly 42–43 good / 57–58 bad.
- Not reviewed: the 109 full-set items outside the sample (see challenge 1).

### 5.3 pmcrefs generator problems (to fix; approved)

Found by reading the 50 good sample items and their agent verdicts:

- **Numbers that aren't data.** `informative_numbers` returns duplicates, and `len(nums) >= 2` passes on one number repeated ("FGF−21 ... FGF−21" → ['21', '21']). `NUM_RE` also matches numbers inside names ("IL-27", "IL-21"). 14 of 157 claims (7 good / 7 bad) have fewer than 2 distinct real numbers; in the sample: ref-0013, 0050, 0057, 0084, 0108, 0133. Fix in `prep_refs.py` with a local stricter function; **don't change `prep_pmc.informative_numbers`** (would shift pmc item IDs that `labels/pmc_overrides.jsonl` is keyed to). `src/numbers.ts` already has the stricter logic to mirror.
- **Procedure citations.** About 14 of the 50 good sample items describe the *citing* study's own procedure and cite where the protocol came from: ref-0003, 0007, 0015, 0017, 0028, 0036, 0037, 0039, 0041, 0042, 0045, 0050, 0053, 0061 (e.g. "serum ... stored at −80 °C", "a 20 min run at 80% VO2max"). The protocol was adapted, so neither label is clearly right. The agent flags 11 of 14. Filter: keep sentences that report the cited paper's results (attributive: "X et al. reported/found/showed", "a trial/study/meta-analysis ... showed", or the sentence names the cited author), drop sentences about "participants", "samples", "we", scale definitions, etc. Measure how many good items survive before regenerating.
- **Findings claims still get flagged about half the time** (~18 of ~34). Part 2's tentative sort (probably real discrepancies: ref-0074, 0067, 0008, 0000, 0009, 0072, 0036, 0017, 0073, 0068, 0024, 0003, 0014, 0031, 0004, 0070, 0061, 0022) still needs verification against the evidence units after regeneration. ref-0024 vs ref-0049 is a nice pair: same data (19/134, 14.2%); 0024 says "per protocol" (the paper says intention-to-treat) and gets flagged, 0049 doesn't say it and passes.
- **"Verified absent from the entire cited paper" has a gap**: value_mismatch new values exist elsewhere in the paper for ref-0133 (15), ref-0126 (41), ref-0082 (23). The Python check uses abstract/paragraph/table-row units but not table captions or section headings. The labels are still right (the claim no longer matches its evidence unit), but fix the check.
- To top up good items: raise `N_EXTRA_CITING` (the pool yields ~0.36 claims per citing paper before this filtering; expect fewer after).

### 5.4 Other findings

- **The number check is weak at document level.** Against a whole paper, integers and 1-decimal claims almost always find something that rounds to them (76 vs 76.4, 63 vs 62.77, 0.8 vs 0.82). Possible upgrade: for document-level citations, check the claim's numbers against the section the model's quote/location points at, not the whole paper. Not built.
- **Baselines have 3× the false alarms of the tool agent for both GPT models** (14% vs ~5%, on the same items and labels). Unexplained. Suspects: the tool agent's prompt ("judge the cited location only", the tool framing) or the table formatting in `corpus.jsonl` vs `read_section`. Matters for the resolver-first architecture, which would reuse the baseline prompt (challenge 2).
- **Claude Opus 5.5 rejects `tool_choice: "required"`** ("type tool and any are not supported for this model"), probably because extended thinking is on. Fixed with the "auto" fallback. Opus is also expensive per check (~$0.04 tool, ~$0.011 baseline).
- **Claude Opus: 0% false alarms with both agents, but 87.7–89.5% catch.** Looks like the most lenient model so far (GLM and DeepSeek Flash look similar); check per-type misses and truncation (next bullet) before concluding.
- **`max_tokens` defaults to 2000 per call (`llm.ts`) and it truncates reasoning models.** Confirmed on GLM 5.3's baseline: 17 of 100 checks failed as unparseable (14 empty, 3 cut-off JSON). The tool agent may be hit too, but more quietly (a truncated turn becomes a prose reply that costs a tool call). Before comparing reasoning models: raise the cap (e.g. 8000, or per model), log `finishReason` in the trace, and rerun the affected runs. This changes their cost too.

### 5.5 Open questions (carried over or new)

- Domain equivalences in the strict prompt (p = 0.00 ≡ p < 0.001, "p < 0.000")? Carried over; the stakeholder's strictness answer (§6 question 5) should drive it.
- Embeddings: OpenRouter lists no embedding models (part 2). Low priority now.
- Full-set (209 / 157) numbers need label review of new disagreements (challenge 1).
- "Can a company rely on it?" Leaning unchanged: a strong first-pass filter, not a sole sign-off. GPT-6 Sol's tool agent is the first config inside the ≥95% / ≤10% target (94.7% / 4.7%), but still only 3/6 subtle overstatements.

---

## 6. Questions for the stakeholder (drafted, not sent)

Only questions that would simplify a hard part or change the product, and that we can't answer ourselves. Ziad will rephrase and email them.

1. **Where can the documents be processed?** Can draft submission content be sent to external model APIs (OpenAI, Anthropic, Google via a router)? Only specific vendors or clouds (e.g. Azure OpenAI, AWS Bedrock)? Or must it run on your own infrastructure with open-weight models? *This decides which models are even eligible, so it changes the model recommendation more than any benchmark number.*
2. **Can we work from the Word files (or your authoring system's export) instead of PDFs?** *Word/XML keeps table structure and headings intact; PDF parsing is the least reliable step. If Word is available, most of the parsing problem goes away.*
3. **What do real citations look like?** Could you share 20–30 citation strings as they appear in a summary (e.g. Module 2.7.3 citing CSR section 14 tables), and a few report-to-report references? Do they always name a specific table/section, or sometimes just the report? *If they almost always name a table or section, a simple lookup in code resolves them and the AI agent is only a fallback. That's faster (live feedback while editing) and cheaper.*
4. **Who uses it, and when?** A medical writer getting feedback while drafting, or a QC reviewer checking the finished document before submission? *Drafting needs answers in ~1–2 seconds; pre-submission QC can take minutes per citation and use the most accurate setup. We'd build the other one second.*
5. **How strict should it be in these three cases?** (a) A summary number that isn't in the table verbatim but is derived from it (pooled across arms, a difference, a percentage computed from counts). (b) A detail the cited table can't show (e.g. "increased" when the table has only test statistics). (c) A methods statement citing the protocol or SAP. For each: flag as an error, flag as "needs review", or pass? *This is the main source of false alarms. A written rule goes straight into the prompt and our answer key.*
6. **Error rate and tolerance for false alarms.** Roughly what share of citations in a typical draft turn out to be wrong (we assume ~3%), and which kinds are most common? How many false flags per real error would a reviewer accept before ignoring the tool (e.g. 3? 10?)? Any anonymized past QC findings or FDA information requests about citation mismatches would be ideal. *This turns "precision can't be horrendous" into a threshold for picking a configuration (e.g. whether a second-opinion pass is worth its extra false alarms), and lets us weight the benchmark's error types realistically.*

---

## 7. What's left (replaces HANDOFF-2.md §6)

0. **Challenge first**, then re-ask §5.1. Suggest sending §6 to the stakeholder now, because questions 1 and 5 can change the model recommendation and the labels.
1. **Finish the sweep.** Check logs; raise `max_tokens` and rerun truncated runs (GLM baseline at least; check `finishReason` for the others); rerun checks that failed with `fetch failed` (or rerun the model at lower concurrency). Build the leaderboard with paired comparisons (ask Ziad about adding `src/bench/leaderboard.ts`). Compare models on the **first-attempt** line too (§5.4 / challenge 4). Qualitative error differences per model: pedantic vs lenient, invented quotes, tool-use failures, budget exhaustion, truncation.
2. **Finalists on the full 209** (top 3 + cheapest within noise, tool agent only). Budget the label review of their disagreements on the 109 unreviewed items (challenge 1).
3. **pmcrefs generator fix** (§5.3), regenerate, then review flagged good items with Ziad. Rerun pmcrefs for the tool agent and baseline (and finalists).
4. **Resolver-first pipeline**: parse the citation in code (`parseLocation` + `findSection` exist), fetch the section, one model call; fall back to the tool agent when resolution fails, the citation is document-level, or the verdict is wrong_target (to find the real location). Measure latency/cost vs the tool agent. Investigate the baseline's higher false alarms first (§5.4).
5. **Second opinion** on `supported` verdicts using the sweep's best model, aimed at overstated_subtle; measure recall gain vs false-alarm cost with paired comparison.
6. **PDF parsing** (unchanged from HANDOFF.md §7 item 6), possibly simplified by stakeholder question 2.
7. **Writeup**: agent design section (tools, context rules, objective checks + retries, number check with its circularity caveat, the Opus `tool_choice` quirk), sweep results, noise, label-review story, accuracy/latency/cost answer, reliability verdict.
8. **React viewer** (unchanged).
9. **Commit** this session's code (number check, tool_choice fallback) as its own phase when Ziad agrees; ask first.
10. Embeddings ablation only if time is left.

---

## 8. Repo state

- `HEAD` = `origin/main` = `b229d3e` (Phase 3).
- Uncommitted: modified `src/agents/checks.ts`, `src/agents/checks.test.ts`, `src/agents/tool-agent.ts`, `src/types.ts`; new `src/numbers.ts`, `src/numbers.test.ts`. `pnpm typecheck` clean, `pnpm test` 31/31.
- New runs this session: `runs/2026-09-26T00-33-2*` and `00-33-30` (number-check measurement), `2026-09-26T00-39-*` / `00-4*` (sweep). Deletable smoke runs from part 2: `23-36-13`, `00-06-50`.
- `labels/pmc_overrides.jsonl` unchanged (21 entries). No `labels/pmcrefs_overrides.jsonl` yet.

## 9. Gotchas (new)

- **Don't write a script and launch it in the same parallel tool batch**: the shell started before the file existed ("can't open input file"), and 15 minutes were lost. Write first, then launch.
- zsh: `echo ========` fails ("= not found", because of `=` expansion). Quote it.
- Background runs: launch with the shell tool in background mode (`block_until_ms: 0`); a single call can run many `( ... ) &` groups followed by `wait`. The sweep launcher was:
  ```zsh
  for m in anthropic/claude-opus-5.5 openai/gpt-6-sol openai/gpt-6-luna google/gemini-3.8-flash x-ai/grok-4.7 \
           qwen/qwen3.8-27b z-ai/glm-5.3 deepseek/deepseek-v4-pro-0813 deepseek/deepseek-v4.1-flash ibm-granite/granite-4.2-8b; do
    n=${m//\//_}
    ( pnpm -s bench --dataset pmc --agent tool --corpus full --model $m > /tmp/sweep/${n}_tool.log 2>&1
      pnpm -s bench --dataset pmc --agent baseline --model $m > /tmp/sweep/${n}_baseline.log 2>&1 ) &
  done; wait
  ```
- About 80 concurrent requests (10 models × concurrency 8) produced a few `fetch failed` errors that survived `chat()`'s 4 attempts (3 checks so far). Rerun those items, or use lower concurrency for the finalists.
- Anthropic models + `tool_choice: "required"` → 400. Handled by `chatWithTools` in `tool-agent.ts`.
- `firstAttempt` is missing from a summary when no check retried (then first attempt = final).
- `loadOverrides` applies every entry regardless of `status`.

---

## 10. Challenge these (my doubts, in priority order)

1. **Finalists on the full 209 will run into unreviewed labels.** Only the 100 sample items are reviewed. The other 109 have the same ~1-in-5 raw-label error rate seen in part 1, so finalist rankings on the full set will be distorted unless their disagreements get reviewed. Budget that, or rank finalists on the reviewed sample plus paired comparison and use the full set only as a sanity check.
2. **The baseline prompt produces ~3× the false alarms of the tool agent** (14% vs ~5%, both GPT models). The planned resolver-first pipeline reuses the baseline's one-call setup. Find the cause before building on it, or the "fast path" will be the noisy path.
3. **The subtle-overstatement set can't rank models.** 6 items in the sample (3/6 vs 2/6 is one item), GPT-6 Sol wrote the rewrites (and Sol is among the best on them), and at least one item (pmc-0205) has a second, pre-existing error. If subtle overstatement is the headline weakness, it needs more items that are human-checked, ideally not all written by one model family.
4. **The number check flattens model differences on wrong numbers.** With retries on, every model gets ~100% on value_mismatch, so "which model is careful with numbers" only shows in the first-attempt line. Report both, or the sweep will say all models are equally careful.
5. **Stakeholder answers could overturn work in progress.** Question 1 (where data may go) can rule out most of the sweep's models; question 5 (strictness) can change labels like pmc-0003 and a whole category of pmcrefs flags. Send the questions before finalizing the model recommendation or the pmcrefs policy.
6. **Truncation may be distorting the reasoning models' results.** The 2000-token cap already broke GLM's baseline (17 failures). Before calling Opus ($0.04/check, 3.4× Sol, lower catch so far), GLM or DeepSeek "lenient", check `finishReason` and rerun with a higher cap. A lenient-looking model may just be one whose turns got cut short.
7. **Carry-overs**: numeric-only claims (no qualitative "well tolerated" claims); one-family subtle rewrites; strictness vs usefulness (HANDOFF.md §9, HANDOFF-2.md §9).
