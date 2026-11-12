# Compatibility matrix

"Verified" means a real session in that app called agentbelt tools, and the calls and results were
confirmed in agentbelt's audit log (`.agentbelt/audit.jsonl`, which records the client name).
A successful connection alone doesn't count.

| App              | Version           | Date       | Tools exercised                                                                                         | Result  | Notes                                                                                                                                       |
| ---------------- | ----------------- | ---------- | ------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | 2.1.257           | 2026-11-12 | `testing_run_checks`, `workflows_start` (`repo-health` → `git_status`, `git_log`, `testing_run_checks`) | ✅      | headless `claude -p` with `--mcp-config`                                                                                                    |
| Codex            | codex-cli 0.166.0 | 2026-11-12 | same as above                                                                                           | ✅      | Codex asks before calling MCP tools that aren't read-only. Headless runs need `mcp_servers.agentbelt.default_tools_approval_mode="approve"` |
| DeepSeek Harness | 0.2.2-rc.1        | —          | —                                                                                                       | pending | connects through `@deepseek-ai/dsh-mcp-client`                                                                                              |

Server: official MCP TypeScript SDK `@modelcontextprotocol/server` 2.4.0. It negotiates protocol
versions 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07.
