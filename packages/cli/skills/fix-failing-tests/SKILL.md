---
name: fix-failing-tests
description: Find why the project's checks fail, fix the cause in an isolated task branch, and prepare a commit the user approves.
license: Apache-2.0
metadata:
  tools: testing_run_checks git_task_start git_diff workflows_start
---

Fix the failing checks in this project without touching the user's own checkout.

1. Run `testing_run_checks`. If everything passes, say so and stop.
2. Read the failure output. Identify the root cause before editing; do not change or delete tests
   just to make them pass.
3. Run `git_task_start` with a short name (for example `fix-tests`). Make your edits only inside the
   task folder it returns.
4. Run `testing_run_checks` with that `task` until the checks pass. Keep changes minimal.
5. Show the result with `git_diff` for the task and explain the cause and the fix in two or three
   sentences.
6. Start the `safe-commit` workflow with `workflows_start` (inputs: `task`, `message`). It re-runs
   the checks and then waits for the user. Tell the user to approve it in a terminal with the
   `agentbelt approve …` command shown in the result. Never claim the commit is done before that.
