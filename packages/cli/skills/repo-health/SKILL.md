---
name: repo-health
description: Quick health report for the project — working-tree state, recent history and all checks — using the repo-health workflow.
license: Apache-2.0
metadata:
  tools: workflows_start
---

1. Run `workflows_start` with `name: "repo-health"`.
2. Summarize in at most six lines: uncommitted changes, the last commits, and each check's
   PASS/FAIL with the first failure reason.
3. If something fails, offer to run the `fix-failing-tests` skill.
