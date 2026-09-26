# citeguard

An agent that checks citations in regulatory documents: for each claim + citation, does the cited source actually back it up?

The writeup of what was measured, and what was cut, is [`WRITEUP.md`](WRITEUP.md).

## Setup

```bash
pnpm install
cp .env.example .env        # add your OpenRouter key
pnpm prep:scifact           # downloads SciFact, builds data/scifact/*.jsonl (needs uv)
```

## Run the benchmark

```bash
pnpm bench                                   # baseline agent, SciFact sample, openai/gpt-6-luna
pnpm bench --dataset mini --agent resolve    # citation lookup + one model call; tools only if the citation names no section
pnpm bench --dataset pmc --agent tool --corpus full
pnpm bench --model anthropic/claude-opus-5.5 --concurrency 4
```

`resolve` is the checker to use when citations name a table or section. `baseline` is the ablation that is handed the answer-key text. `tool` always searches. `fixtures/mini` is a five-item dossier that runs without the PMC download.

Each run writes `runs/<name>.jsonl` (one record per check) and `runs/<name>.summary.json`.

## Layout

- `python/` data prep (and later PDF parsing), outputs JSONL
- `src/llm.ts` minimal OpenRouter client (retries, token + cost tracking)
- `src/agents/` agents: `baseline` = one call with the cited text, no tools
- `src/bench/` dataset loading, runner, metrics (catch rate, false-alarm rate, confidence intervals)
