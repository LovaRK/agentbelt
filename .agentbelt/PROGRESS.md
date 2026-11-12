# Progress (generated — edit with `agentbelt progress`)

Verified 15/18 milestones (83% by evidence). Updated 2026-11-12T21:25:13.757Z.

| ID | Title | Status | Owner | Depends on | Latest evidence |
| --- | --- | --- | --- | --- | --- |
| M0 | Repository inspection | VERIFIED |  |  | Repo audit 2026-11-12: commits f80aa87, 8456b62 on main, no remote; 16 tests passing before this work |
| M1 | Core MCP server | VERIFIED |  | M0 | test/core.test.ts + test/install.test.ts: MCP handshake, 13 tools listed, real tool calls through the installed server |
| M2 | Plugin SDK | VERIFIED |  | M1 | definePlugin/ctx used by all plugins; test/core.test.ts and test/plugins.test.ts pass |
| M3 | Permission broker | VERIFIED |  | M2 | test/core.test.ts: ungranted exec/write/callTool denied and audited; git push, path escapes, .git and .agentbelt access refused |
| M4 | Git plugin | VERIFIED |  | M3 | test/plugins.test.ts: task worktree + commit on agentbelt/<id>, main untouched; git_status/git_log called from Claude Code and Codex (audit 2026-11-12T20:04:31Z |
| M5 | Testing plugin | VERIFIED |  | M3 | testing_run_checks from Claude Code (audit 2026-11-12T20:04:30.342Z) and Codex (20:05:38.569Z): PASS lint, PASS test |
| M6 | Workflow plugin | VERIFIED |  | M4, M5 | repo-health workflow succeeded from Claude Code (20:04:32Z) and Codex (20:05:40Z); safe-commit approval gate tested in test/plugins.test.ts |
| M7 | CLI installer | VERIFIED |  | M6 | test/install.test.ts: setup in an isolated HOME from local packages, verify-before-activate, broken release never activated, rollback, uninstall. Not yet tested |
| M8 | Claude Code integration | VERIFIED |  | M7 | Claude Code 2.1.257 headless with --mcp-config: real calls, audit client=claude-code 2026-11-12T20:04:30Z |
| M9 | Codex integration | VERIFIED |  | M7 | codex-cli 0.166.0 exec with -c overrides: real calls, audit client=codex-mcp-client 2026-11-12T20:05:38Z |
| M10 | DeepSeek integration | IN_PROGRESS |  | M7 | DeepSeek Harness 0.2.2-rc.1 loaded the agentbelt entry and started the server (parent process = DeepSeek app); 0 tool calls in the audit log so far |
| M11 | Security hardening | VERIFIED |  | M3 | test/sandbox.test.ts on macOS: postinstall never ran; sandboxed plugin blocked from files/network/shell/secrets; tampering refused; fail-closed without sandbox. |
| M12 | Documentation and release | IMPLEMENTED_UNVERIFIED |  | M8, M9, M10, M11 | Public repo github.com/LovaRK/agentbelt; CI green on ubuntu+macOS x Node 22/24 (https://github.com/LovaRK/agentbelt/actions/runs/43308961942); CodeQL green. Rem |
| M13 | Project control system (status, resume, progress, context, model routing) | VERIFIED |  | M1 | test/project-state.test.ts 7/7 (persistence, crash recovery, 3-process concurrency + stale lock, evidence rule, context thresholds, model discovery doubles + ro |
| M14 | Linux bubblewrap sandbox backend | VERIFIED |  |  | GitHub CI run https://github.com/LovaRK/agentbelt/actions/runs/43308961942 (commit 5b701db): ubuntu-latest Node 22+24 with AGENTBELT_REQUIRE_SANDBOX=1, bubblewr |
| M15 | Adapters: Cursor, VS Code, Claude Desktop, LM Studio | IMPLEMENTED_UNVERIFIED |  |  | commit a750121; test/adapters.test.ts 6/6 fixture tests; no real calls: Cursor/LM Studio not installed; VS Code/Claude Desktop installed but config change needs |
| M16 | Optional coding-agent plugin | VERIFIED |  |  | commit 935de89; test/agent.test.ts 7/7; real local call 2026-11-12: Ollama gpt-oss-20b-16k:latest via agent_run on a demo npm repo, completed in 3 steps (read_f |
| M17 | Opt-in scheduler and triggers | VERIFIED |  |  | commit 9d0bc25; test/scheduler.test.ts 6/6 incl. real repo-health runs via tick() in a temp git repo, audit client agentbelt-scheduler; full suite 44/44 |

## Details

### M0 Repository inspection — VERIFIED
- Done when: audit of files, commits and tests recorded
- 2026-11-12T20:53 (cli): Repo audit 2026-11-12: commits f80aa87, 8456b62 on main, no remote; 16 tests passing before this work

### M1 Core MCP server — VERIFIED
- Done when: integration tests pass
- 2026-11-12T20:54 (cli): test/core.test.ts + test/install.test.ts: MCP handshake, 13 tools listed, real tool calls through the installed server

### M2 Plugin SDK — VERIFIED
- Done when: unit tests pass
- 2026-11-12T20:54 (cli): definePlugin/ctx used by all plugins; test/core.test.ts and test/plugins.test.ts pass

### M3 Permission broker — VERIFIED
- Done when: security tests pass
- 2026-11-12T20:54 (cli): test/core.test.ts: ungranted exec/write/callTool denied and audited; git push, path escapes, .git and .agentbelt access refused

### M4 Git plugin — VERIFIED
- Done when: real tool execution
- 2026-11-12T20:54 (cli): test/plugins.test.ts: task worktree + commit on agentbelt/<id>, main untouched; git_status/git_log called from Claude Code and Codex (audit 2026-11-12T20:04:31Z, 20:05:40Z)

### M5 Testing plugin — VERIFIED
- Done when: real tool execution
- 2026-11-12T20:54 (cli): testing_run_checks from Claude Code (audit 2026-11-12T20:04:30.342Z) and Codex (20:05:38.569Z): PASS lint, PASS test

### M6 Workflow plugin — VERIFIED
- Done when: workflow run results
- 2026-11-12T20:54 (cli): repo-health workflow succeeded from Claude Code (20:04:32Z) and Codex (20:05:40Z); safe-commit approval gate tested in test/plugins.test.ts

### M7 CLI installer — VERIFIED
- Done when: fresh installation verified
- 2026-11-12T20:54 (cli): test/install.test.ts: setup in an isolated HOME from local packages, verify-before-activate, broken release never activated, rollback, uninstall. Not yet tested from the npm registry (not published)

### M8 Claude Code integration — VERIFIED
- Done when: real calls in audit log
- 2026-11-12T20:54 (cli): Claude Code 2.1.257 headless with --mcp-config: real calls, audit client=claude-code 2026-11-12T20:04:30Z

### M9 Codex integration — VERIFIED
- Done when: real calls in audit log
- 2026-11-12T20:54 (cli): codex-cli 0.166.0 exec with -c overrides: real calls, audit client=codex-mcp-client 2026-11-12T20:05:38Z

### M10 DeepSeek integration — IN_PROGRESS
- Done when: real MCP execution in audit log
- 2026-11-12T20:54 (cli): DeepSeek Harness 0.2.2-rc.1 loaded the agentbelt entry and started the server (parent process = DeepSeek app); 0 tool calls in the audit log so far

### M11 Security hardening — VERIFIED
- Done when: security tests pass
- 2026-11-12T20:54 (cli): test/sandbox.test.ts on macOS: postinstall never ran; sandboxed plugin blocked from files/network/shell/secrets; tampering refused; fail-closed without sandbox. Linux sandbox backend not built yet

### M12 Documentation and release — IMPLEMENTED_UNVERIFIED
- Done when: release checklist complete
- 2026-11-12T20:54 (cli): README, SECURITY, CONTRIBUTING, docs/, CI/CodeQL/release workflows written (8456b62). CI never ran: no remote. Not published
- 2026-11-12T21:25 (cli): Public repo github.com/LovaRK/agentbelt; CI green on ubuntu+macOS x Node 22/24 (https://github.com/LovaRK/agentbelt/actions/runs/43308961942); CodeQL green. Remaining: npm publish (needs user's NPM_TOKEN [REDACTED] + npm org).

### M13 Project control system (status, resume, progress, context, model routing) — VERIFIED
- Done when: focused tests pass; status/resume work on this repo
- Files: packages/core/src/project-state.ts, packages/core/src/context.ts, packages/core/src/models.ts, packages/core/src/status.ts, packages/core/src/server.ts, packages/cli/src/cli.ts
- Tests: npm test: 23 pass; 0 fail
- 2026-11-12T20:54 (cli): test/project-state.test.ts 7/7 (persistence, crash recovery, 3-process concurrency + stale lock, evidence rule, context thresholds, model discovery doubles + routing, MCP tools, CLI); full regression 23/23

### M14 Linux bubblewrap sandbox backend — VERIFIED
- Done when: fails closed when bwrap missing or probe fails; real isolation tests pass on ubuntu CI
- Files: packages/core/src/sandbox.ts, test/sandbox.test.ts, .github/workflows/ci.yml
- Tests: test/sandbox.test.ts; test/sandbox.test.ts
- 2026-11-12T20:56 (cli): commit 1d8d58e; bubblewrapArgs unit test passes on macOS (sandbox.test.ts 6/6 incl. fail-closed); NOT run on Linux: no local Linux VM/container running, no remote so CI has never run
- 2026-11-12T21:25 (cli): GitHub CI run https://github.com/LovaRK/agentbelt/actions/runs/43308961942 (commit 5b701db): ubuntu-latest Node 22+24 with AGENTBELT_REQUIRE_SANDBOX=1, bubblewrap backend active; malicious-plugin test blocked file read/write, shell, network, secrets. Not run on other distributions.

### M15 Adapters: Cursor, VS Code, Claude Desktop, LM Studio — IMPLEMENTED_UNVERIFIED
- Done when: fixture tests pass; real calls only where the app is installed and approved
- Files: packages/cli/src/adapters.ts, test/adapters.test.ts
- Tests: test/adapters.test.ts
- 2026-11-12T20:57 (cli): commit a750121; test/adapters.test.ts 6/6 fixture tests; no real calls: Cursor/LM Studio not installed; VS Code/Claude Desktop installed but config change needs user approval

### M16 Optional coding-agent plugin — VERIFIED
- Done when: tests pass; real call against a local model
- Files: packages/core/src/model.ts, plugins/agent/src/index.ts, packages/cli/src/agent.ts
- Tests: test/agent.test.ts; test/agent.test.ts
- 2026-11-12T21:02 (cli): commit 935de89; test/agent.test.ts 7/7 (scripted model + fake fetch); full suite 38 tests, 37 pass before guard fixture fix, guard+agent 9/9 after; no real model call yet
- 2026-11-12T21:03 (cli): commit 935de89; test/agent.test.ts 7/7; real local call 2026-11-12: Ollama gpt-oss-20b-16k:latest via agent_run on a demo npm repo, completed in 3 steps (read_file, run_checks), correct PASS report, 16.7s, 3 kind=model audit entries. DeepSeek API endpoint not exercised (needs a key).

### M17 Opt-in scheduler and triggers — VERIFIED
- Done when: tests pass; real workflow runs through broker+audit
- Files: packages/core/src/scheduler.ts, packages/cli/src/scheduler-cli.ts
- Tests: test/scheduler.test.ts
- 2026-11-12T21:05 (cli): commit 9d0bc25; test/scheduler.test.ts 6/6 incl. real repo-health runs via tick() in a temp git repo, audit client agentbelt-scheduler; full suite 44/44
