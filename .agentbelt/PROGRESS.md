# Progress (generated — edit with `agentbelt progress`)

Verified 12/14 milestones (86% by evidence). Updated 2026-11-12T20:54:53.957Z.

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
| M12 | Documentation and release | IMPLEMENTED_UNVERIFIED |  | M8, M9, M10, M11 | README, SECURITY, CONTRIBUTING, docs/, CI/CodeQL/release workflows written (8456b62). CI never ran: no remote. Not published |
| M13 | Project control system (status, resume, progress, context, model routing) | VERIFIED |  | M1 | test/project-state.test.ts 7/7 (persistence, crash recovery, 3-process concurrency + stale lock, evidence rule, context thresholds, model discovery doubles + ro |

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

### M13 Project control system (status, resume, progress, context, model routing) — VERIFIED
- Done when: focused tests pass; status/resume work on this repo
- Files: packages/core/src/project-state.ts, packages/core/src/context.ts, packages/core/src/models.ts, packages/core/src/status.ts, packages/core/src/server.ts, packages/cli/src/cli.ts
- Tests: npm test: 23 pass; 0 fail
- 2026-11-12T20:54 (cli): test/project-state.test.ts 7/7 (persistence, crash recovery, 3-process concurrency + stale lock, evidence rule, context thresholds, model discovery doubles + routing, MCP tools, CLI); full regression 23/23
