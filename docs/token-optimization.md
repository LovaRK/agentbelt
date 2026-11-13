# Token optimization (0.2.0)

The optional coding agent (`agent_run`) can run long tasks on a local model with a small context
window, such as `gpt-oss-20b` with a 16k context in Ollama. Every file it reads and every test log
it runs stays in the conversation, so the prompt grows each step until it hits the context limit.
The `tokens` plugin adds two things:

- **Context compaction** (off by default). Before each model call, agentbelt sends a shortened copy
  of the conversation. The full history is kept; only what is sent changes.
- **A token report** of the token counts the model server itself returned for each run. Nothing in
  the report is estimated.

## Turn it on

Ask your AI app to call `agent_run` with `compact: true`, for example:

> Use agentbelt's agent_run with compact: true to read the files in src/ and summarize them.

| Input           | Default | Meaning                                                               |
| --------------- | ------- | --------------------------------------------------------------------- |
| `compact`       | `false` | Compact the conversation before each model call                       |
| `contextBudget` | `10000` | Estimated token budget for the messages (leave room for tools/output) |

What compaction does, in order:

1. Keeps the system prompt, the task and the 4 newest messages exactly as they are.
2. Replaces a tool result that came back again word for word later in the run with a short pointer
   to the newer copy.
3. While the conversation is over the budget, shortens older tool results (file reads, test logs),
   oldest first. A shortened result keeps its first and last lines, every line that mentions an
   identifier, file name or quoted word from the task, and every line that looks like an error,
   with line numbers.
4. If that is still not enough, shortens those to a one-line note.

It never drops or reorders messages, so every tool call keeps its result. It makes no model call
and no network call. The budget is checked with an estimate of about 4 characters per token; the
reported numbers always come from the model server.

## See the numbers

```bash
agentbelt tokens          # in the project folder
```

Your AI app can call `tokens_report` (or `agent_runs`) for the same report. Each `agent_run`
also prints the tokens of that run:

```text
tokens (reported by the model server): input 34395, output 236, largest prompt 10269; compaction on (budget 10000, used in 1 call(s))
```

Runs are kept in `<project>/.agentbelt/state/agent/runs.json` (the newest 200).

## Measured results

Measured on 2026-11-13 on a MacBook Air M4 with 24 GB of memory, with Ollama serving
`gpt-oss-20b-16k:latest` (gpt-oss 20B, `num_ctx 16384`). The same tasks ran with compaction off and
on, with the order alternated between repetitions. Token counts are Ollama's `prompt_tokens` and
`completion_tokens`, summed over every model call in a run. The harness is
[`bench/compaction.ts`](../bench/compaction.ts); the raw results are in
[`benchmarks/compaction-gpt-oss-20b-16k.json`](benchmarks/compaction-gpt-oss-20b-16k.json).

The tasks:

- **read-5-files:** read five source files (about 50,000 characters together), then say which one
  defines `KEYCHAIN_SERVICE` and its value. Without compaction this brings the prompt close to the
  16k limit.
- **test-log-twice:** run a failing 300-line test suite twice, read another file, then name the
  failing test and the audit log file. This is hard: `testing_run_checks` shows only the last 60
  lines of a failing check, so the failing test is visible only if the model also reads the test
  script.

Three runs per task and mode, budget 10,000:

| Task           | Compaction | Correct | Completed | Input tokens per run     | Average input | Largest prompt | Average time |
| -------------- | ---------- | ------- | --------- | ------------------------ | ------------- | -------------- | ------------ |
| read-5-files   | off        | 3/3     | 3/3       | 38,038 · 51,355 · 51,355 | 46,916        | 13,317         | 70 s         |
| read-5-files   | on         | 3/3     | 3/3       | 82,439 · 34,395 · 34,395 | 50,410        | 10,269         | 93 s         |
| test-log-twice | off        | 1/3     | 1/3       | 62,872 · 41,778 · 22,152 | 42,267        | 6,182          | 84 s         |
| test-log-twice | on         | 1/3     | 3/3       | 12,592 · 9,432 · 33,321  | 18,448        | 3,338          | 63 s         |

What this shows, and only this:

- Compaction kept the largest prompt lower in every run: 10,269 instead of up to 13,317 tokens on
  read-5-files, and at most 3,338 instead of up to 6,182 on test-log-twice.
- On test-log-twice, the runs with compaction used 56% fewer input tokens on average (18,448 vs
  42,267) and all three ended with an answer instead of running out of steps. Correct answers were
  the same (1 of 3). The prompt never reached the budget here, so what acted was step 2 (the
  repeated test log replaced by a pointer); in one of the three runs nothing was compacted at all,
  so part of this difference is ordinary run-to-run variation.
- On read-5-files, accuracy was the same (3 of 3), and two of three runs with compaction used fewer
  input tokens (34,395 vs 38,038 to 51,355). The third re-read files and used 82,439, so the
  average was higher with compaction (50,410 vs 46,916). There is no average saving to claim here.
- Runs vary a lot between repetitions of the same task, and three runs per case is a small sample.

### The first version did worse

An earlier version (budget 8,000; shortened results kept only first, last and error lines and
told the model to call the tool again) also ran three times per case. It lowered the largest
prompt (about 8,500 instead of 13,300 on read-5-files) but the model re-read the files it had lost:
read-5-files was correct in 1 of 3 runs with compaction against 3 of 3 without, and the runs with
compaction used more input tokens (51,591 to 99,744 against 38,038 to 64,764). The test-log-twice
task in that round asked for a value the file reader could not reach, so it was replaced. The
current version keeps lines that match the task and asks the model to use what is shown.

## When to use it

- **Leave `compact` off for short tasks.** It only helps when a run gets close to the model's
  context limit. In a real run on 2026-11-13 (LM Studio calling `agent_run` with
  gpt-oss-20b-16k, three named files, about 6,300 tokens of context), the run without compaction
  finished in 4 steps with 12,295 input tokens. The same task with `contextBudget: 4000`
  shortened the files 8 times, the model re-read what was shortened, and the run took 12 steps and
  46,315 input tokens. Both answers were correct. One run each, so this is an example, not an
  average.
- **Do not set the budget below what the task needs.** Keep the default (10,000 for a 16k model)
  unless you have measured otherwise.
- **Some apps stop waiting before a long run ends.** `agent_run` with a local model can take a
  few minutes. LM Studio reported a timeout for runs of 98 and 169 seconds, although both
  finished and were recorded; `agentbelt tokens` (or `tokens_report`) shows them. Claude Code and
  Codex wait longer. In apps with a short limit, keep `maxSteps` low and name the exact files.

## Not covered

- Only one model and two tasks were measured. Other models, tasks and budgets may behave
  differently; measure with `bench/compaction.ts --model <name>` before relying on it.
- The output per step is capped by the model client (`max_tokens`, default 4096).
