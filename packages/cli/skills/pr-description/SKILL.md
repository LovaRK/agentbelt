---
name: pr-description
description: Write a pull request title and description from a task branch's changes. Never pushes or opens the PR.
license: Apache-2.0
metadata:
  tools: git_log git_diff testing_run_checks
---

Write a pull request description for a task (or the current branch).

1. `git_log` and `git_diff` (with `task` if given) to understand the change.
2. `testing_run_checks` to report the real check status.
3. Produce:
   - a title under 70 characters in the imperative mood;
   - **What** changed and **why** (two to four sentences);
   - **How it was tested**: the actual check results, not assumptions;
   - **Risks / follow-ups**, if any.
4. Give it to the user as text. agentbelt never pushes or opens pull requests; the user does that.
