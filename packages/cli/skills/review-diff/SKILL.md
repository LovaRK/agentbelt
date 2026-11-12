---
name: review-diff
description: Review the current uncommitted changes (or a task branch) for bugs, risky edits and missing tests, without changing anything.
license: Apache-2.0
metadata:
  tools: git_status git_diff testing_run_checks
---

Review changes read-only. Do not edit files.

1. `git_status` to see what changed (pass `task` to review a task branch instead).
2. `git_diff` (and `git_diff` with `staged: true`) to read the changes.
3. Look for, in order: correctness bugs, security problems (secrets, injection, unsafe paths),
   behaviour changes without tests, and leftover debug code.
4. Optionally run `testing_run_checks` to confirm the checks still pass.
5. Report findings as a short list, most severe first, each with the file, what is wrong and a
   concrete suggestion. If there is nothing important, say so plainly.
