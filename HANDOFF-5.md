# CiteGuard handoff, part 5

Read [`WRITEUP.md`](WRITEUP.md) for the decisions and the numbers. This file is only so the next session does not restart the old plan.

[`HANDOFF-4.md`](HANDOFF-4.md) is wrong about git. Phase 4 is `8052ebd` on `main` (number check, labels, `prep_refs.py`, the four handoff files). `data/` and `runs/` are gitignored and are **not** in a fresh clone. The PMC sweep files are not here. Do not rescore them. Do not rerun `prep_pmc.py`; item ids in `labels/pmc_overrides.jsonl` depend on its caches, which are also absent.

## What changed

`resolve` is the checker for citations that name a section.

- `src/resolve.ts` parses the citation and finds the section. It does not read `targetId`.
- `src/agents/resolver.ts` `checkFastPath`: one model call on that section, or `wrong_target` with no call if the document or table is missing. At most one retry, and only for a missing number. A second `supported` stands (derived numbers).
- A citation with no section, or a section longer than one tool page (`PAGE_CHARS`), returns null. `src/bench/run.ts` then runs the existing tool agent and marks `resolution: "search"`.
- `pnpm bench --dataset mini --agent resolve` runs `fixtures/mini` (5 items, committed). No PMC download.

Smoke, Luna, 26 Sep 2026, `runs/` local only: 3 section, 1 missing ($0, 23 ms, "PMC1 has no Table 9."), 1 search (outline + search + read, supported). Catch 3/3, false alarms 0/2. The wrong-table item was flagged `not_supported` rather than `wrong_target`; catch rate counts both. Tests 40, `pnpm typecheck` clean.

## Do not build these

Embeddings, a second-opinion pass, a React viewer, a PDF parser, a Granite tool run, a Qwen finish, a 1,200-paper `prep:refs` crawl, finalists on the unreviewed 109 PMC items. Reasons are in the writeup. `max_tokens` is already 8,000; rerunning GLM and Granite baselines is optional color, not a decision.

## The one measurement that is still worth it

When `data/pmc` exists (papers, items, the tables store), run:

```bash
pnpm bench --dataset pmc --split sample --agent resolve --model openai/gpt-6-luna
```

Compare item by item with the Luna tool run (catch 93%, false alarms 4.7%) and the Luna baseline (catch 93%, false alarms 14%). The open question is whether the resolver inherits the baseline's higher false-alarm rate. If it does, the fix is the prompt or the table formatting, not a return to tools-for-every-table.

`pmcrefs` stays parked until someone deliberately regenerates it (`pnpm prep:refs` overwrites `items.jsonl`) and reviews the good items. The generator filters are already in `python/prep_refs.py`.
