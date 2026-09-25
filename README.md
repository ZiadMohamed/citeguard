# citeguard

An agent that checks citations in regulatory documents: for each claim + citation, does the cited source actually back it up?

## Setup

```bash
pnpm install
cp .env.example .env        # add your OpenRouter key
pnpm prep:scifact           # downloads SciFact, builds data/scifact/*.jsonl (needs uv)
```

## Run the benchmark

```bash
pnpm bench                                   # baseline agent, 100-item sample, openai/gpt-6-luna
pnpm bench --split full                      # ~440 items
pnpm bench --model anthropic/claude-opus-5.5 --concurrency 4
```

Each run writes `runs/<name>.jsonl` (one record per check) and `runs/<name>.summary.json`.

## Layout

- `python/` data prep (and later PDF parsing), outputs JSONL
- `src/llm.ts` minimal OpenRouter client (retries, token + cost tracking)
- `src/agents/` agents: `baseline` = one call with the cited text, no tools
- `src/bench/` dataset loading, runner, metrics (catch rate, false-alarm rate, confidence intervals)
