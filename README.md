# citeguard

An agent that checks citations in regulatory documents: for each claim + citation, does the cited source actually back it up?

The writeup of what was measured, and what was cut, is [`WRITEUP.md`](WRITEUP.md).

The benchmark sets (`data/pmc`, `data/pmchard`, `data/pmcrefs` items), the reviewed labels (`labels/`) and every saved run (`runs/`) are committed, so `pnpm leaderboard`, `pnpm scan`, `pnpm extract:eval`, `pnpm audit:tables` and `pnpm bench --dataset pmc` work from a fresh clone. The raw XML/PDF downloads and the full-text stores are not; rebuild them with the `prep:*` scripts (needs `uv`) for `--corpus full`, `--corpus pdf` and SciFact.

## Setup

```bash
pnpm install
cp .env.example .env        # add your OpenRouter key
pnpm prep:scifact           # optional: SciFact smoke-test set (needs uv)
```

## Check a document

```bash
pnpm check fixtures/demo/summary.txt --docs fixtures/demo/docs.jsonl     # whole summary -> reviewer report
pnpm check --docs fixtures/demo/docs.jsonl --interactive                  # type one sentence at a time
pnpm check fixtures/demo/summary.txt --docs fixtures/demo/docs.jsonl --fix # + a verified rewrite per flag
pnpm audit:tables                                                           # errors inside the reports' own tables
```

`--fix` offers a rewrite only if every number in it is in the cited table and the checker accepts it against the same citation; a wrong citation gets a different citation instead. `audit:tables` checks every table against itself (estimate inside its CI, CI and p-value agree, k (x%) matches the column's N), with no model.

Interactive mode checks each line on its own (no conversation memory). It prints the fast model's verdict as soon as it's in, and the strong model's verdict when the hybrid re-checks it.

Errors print as one line; set `DEBUG=1` for the stack trace.

## Run the benchmark

```bash
pnpm bench --dataset mini --agent resolve    # five-item smoke test, no data download needed

# Most accurate: Sol, with the overstatement cues
pnpm bench --dataset pmc --agent resolve --cues --model openai/gpt-6-sol

# Cheaper, fast first verdict: Luna answers, Sol re-checks Luna's flags and the passes code raised a cue on
pnpm bench --dataset pmc --agent hybrid --cues --model openai/gpt-6-luna --strong openai/gpt-6-sol

# The harder set: errors where every number is still in the table (arm swaps, direction, significance, time point)
pnpm prep:hard && pnpm bench --dataset pmchard --agent resolve --cues --model openai/gpt-6-sol

pnpm bench --dataset pmc --agent resolve --corpus pdf   # tables parsed from PDFs (pnpm prep:pdf first)
pnpm bench --dataset pmc --agent tool --corpus full     # always search with tools
pnpm leaderboard --ref resolve-tables-v2-cues_openai_gpt-6-sol     # rescore every saved run, paired against one
pnpm leaderboard --dataset pmchard                                 # same, on the harder set
pnpm extract:eval                                                   # claim/citation extraction on raw results text
pnpm scan                                                           # submission-level pass: resolve every citation, point uncited numbers at a source
```

Defaults: `--prompt v2`, `--escalate flags,cues`, `--strong openai/gpt-6-sol`. `--prompt v1` reproduces the first runs.

- `resolve`: code resolves the citation, then one model call on the cited section. The tool agent runs only when the citation names no section.
- `hybrid`: a fast model first, then a strong model on the verdicts named in `--escalate`:
  - `flags`: every flag;
  - `cues`: a pass kept after code raised a cue;
  - `judgment`: a pass on a claim with judgment words (measured and superseded by `cues`);
  - `lowconf` and `passes`.
- `baseline`: the ablation that is handed the answer-key text.
- `tool`: always searches.
- `--cues`: adds sign-direction, overstatement (`src/hedges.ts`) and comparison checks (`src/comparisons.ts`: a between-group comparison on a non-significant row, or "higher"/"decreased to" contradicting the claim's own values) to the retry after a "supported" verdict.
- `fixtures/mini`: a five-item dossier that runs without the PMC download.

Each run writes `runs/<name>.jsonl` (one record per check) and `runs/<name>.summary.json`. The leaderboard's "model: bad good" column scores only the items code can't decide alone. Compare models on that column. Compare costs only between runs launched together, since per-token prices vary about 2× between runs.

## Datasets

| Name | What | Built by |
|---|---|---|
| `mini` | 5 hand-written items, committed in `fixtures/mini` | – |
| `scifact` | claim vs abstract; harness smoke test | `pnpm prep:scifact` |
| `pmc` | 30 open-access trial papers; authors' sentences linked to their tables by number match; half mutated (wrong number, table, paper, missing table, overstatement). 100-item reviewed sample | `pnpm prep:pmc` (committed; reviewed labels are pinned to claim text, so a stale one is skipped with a warning) |
| `pmchard` | the 50 reviewed-good PMC claims, each paired with one rule-based edit that keeps every number in the table: two group values swapped, direction flipped, significance flipped, time point swapped. No model in the loop | `pnpm prep:hard` |
| `pmcrefs` | paper-cites-paper sentences; citation names a whole document (parked, labels unreviewed) | `pnpm prep:refs` |

## Citations the resolver understands

- **Document ids and aliases from the store**, ignoring case, spaces and hyphens: `PMC123`, `CSR-ABC101`, `CSR ABC-101`, and `Study ABC-101` as an alias.
- **Exact table ids:** `Table 14.2.1` (never Table 14), `Supplementary Table S1`, `Table 1a`.
- **Lists and ranges:** `Tables 14.2.1 and 14.2.2`, `Tables 2-4`. Every table must exist.
- **Figures, listings, sections, appendices and modules by name.** If one isn't in the parsed document, the check falls back to the whole document and records a `warning`.

## Layout

- `python/`: data prep and PDF table parsing, outputs JSONL.
- `src/llm.ts`: minimal OpenRouter client (retries, token and cost tracking).
- `src/resolve.ts`, `src/locations.ts`: citation parsing and lookup, no model.
- `src/numbers.ts`: the number check, including derived percentages and sign conflicts.
- `src/hedges.ts`: overstatement cues; `src/comparisons.ts`: comparison cues.
- `src/extract.ts`: claim and citation extraction from raw text.
- `src/submission.ts`: the whole-submission scan and number index.
- `src/source-audit.ts`: internal-consistency checks on the reports' own tables.
- `src/agents/fixer.ts`: gated fix suggestions.
- `src/agents/`: the agents.
  - `baseline`: one call with the cited text, no tools.
  - `resolver`: the fast path, and `checkCitation`, the front door (fast path, else tool agent).
  - `hybrid`: the fast/strong router.
  - `tool-agent`: search and paged reading.
- `src/bench/`: dataset loading, runner, metrics (catch rate, false-alarm rate, confidence intervals), leaderboard.
