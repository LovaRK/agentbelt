---
name: safe-dependency-update
description: Plan a dependency update in an isolated task branch and verify it with the project's checks before the user approves a commit.
license: Apache-2.0
metadata:
  tools: git_task_start testing_run_checks git_diff workflows_start
---

agentbelt does not install packages itself (installing runs third-party code). Use it to keep the
update isolated and verified:

1. Ask the user which dependency and version to update, unless they said so.
2. `git_task_start` (for example `update-<package>`), then edit the manifest in the task folder.
3. Tell the user the exact install command to run inside that task folder (for example
   `npm install`), and wait until they confirm they ran it.
4. `testing_run_checks` with the `task`. If something breaks, read the failure and fix the code in
   the task folder, or recommend not updating.
5. Show `git_diff` for the task, then start the `safe-commit` workflow so the user approves the
   commit in a terminal.
