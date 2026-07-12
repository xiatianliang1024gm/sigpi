# CLI Agent Benchmark

This directory provides two agent benchmark harnesses:

- **Local case benchmark** (`run-bench.mjs`): zero external dependencies, runs immediately after clone.
- **SWE-bench Lite** (`swebench-lite.mjs`): generates predictions for the official SWE-bench_Lite dataset. Requires building the project and external services (see its section).

Each local case provides:

- `case.json`: prompt, checker path, and timeout
- `workspace/`: initial files copied into an isolated `/tmp` workspace
- `checker.mjs`: automated pass/fail check after the agent exits

Run all cases:

```bash
pnpm bench -- --agent "your-agent"
```

Run one case:

```bash
pnpm bench -- --agent "your-agent" --case read-package-name
```

The runner executes:

```bash
your-agent "<case prompt>"
```

from inside the copied case workspace. The agent may modify files in that
workspace. The runner captures stdout, stderr, exit code, duration, timeout
state, checker result, and result paths under `bench/results/<run-id>/`.

`bench/results/` is ignored by git. The summary JSON keeps stdout/stderr paths
and preserves failing or timed-out workspaces for debugging.

Output capture intentionally uses shell redirection to log files instead of
accumulating Node pipe events. Keep that behavior unless there is a concrete
reason to change it; it avoids edge cases where short-lived CLI processes exit
before pipe reads are fully observed.

For harness smoke testing, use the included deterministic stub:

```bash
pnpm bench -- --agent "node /absolute/path/to/bench/stub-agent.mjs"
```

Passing workspaces are removed unless `--keep-workspaces` is set. Failing or
timed-out case workspaces are preserved and reported in `summary.json`.

When adding cases, keep the workspace self-contained and small. Prefer
deterministic checkers that inspect files or run local commands, and avoid
network, GUI, browser, or interactive-input requirements.

## SWE-bench Lite

> ⚠️ This harness requires a **build step and external services**. It is not
> runnable out of the box — read Prerequisites first.

`bench/swebench-lite.mjs` generates predictions for the official
`princeton-nlp/SWE-bench_Lite` dataset. It checks out each issue repository at
the base commit, runs a CLI agent in that checkout, captures `git diff`, and
writes a JSONL file suitable for the official SWE-bench harness.

### Prerequisites

1. **Build the project first** — the harness invokes `dist/src/cli.js`, so run
   `pnpm build` before generating predictions.
2. **Python `datasets` package** — `python -m pip install datasets` (loads the
   Hugging Face dataset).
3. **Official `swebench` package + Docker** — `python -m pip install swebench`
   plus a running Docker daemon, for final scoring.
4. **Network access** — to Hugging Face (dataset) and GitHub (clone issue
   repositories).

The final scoring harness runs Dockerized tests and is resource intensive. If
Docker is unavailable under WSL, enable Docker Desktop WSL integration or run
the harness on a Linux host with Docker available.

Generate one prediction:

```bash
python -m pip install datasets
pnpm build
pnpm bench:swebench-lite -- \
  --agent "node $(pwd)/dist/src/cli.js ask --new" \
  --limit 1
```

Run a specific instance:

```bash
pnpm build
pnpm bench:swebench-lite -- \
  --agent "node $(pwd)/dist/src/cli.js ask --new" \
  --instance astropy__astropy-12907
```

Generate all Lite predictions:

```bash
pnpm build
pnpm bench:swebench-lite -- \
  --agent "node $(pwd)/dist/src/cli.js ask --new" \
  --all
```

If `sigpi` is installed on `PATH`, `--agent "sigpi ask --new"` also works.

The default output is `bench/results/swebench-lite-predictions.jsonl`. Evaluate
that file with the official harness:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --split test \
  --predictions_path bench/results/swebench-lite-predictions.jsonl \
  --run_id sigpi-lite
```

The official harness runs Dockerized tests and is resource intensive. If Docker
is unavailable in WSL, enable Docker Desktop WSL integration or run the harness
on a Linux host with Docker available.
