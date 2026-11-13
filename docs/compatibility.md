# Compatibility matrix

"Verified" means a real session in that app called agentbelt tools, and the calls and results were
confirmed in agentbelt's audit log (`.agentbelt/audit.jsonl`, which records the client name).
A successful connection alone doesn't count.

| App                                | Version           | Date       | Tools exercised                                                                                         | Result | Notes                                                                                                                                                        |
| ---------------------------------- | ----------------- | ---------- | ------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code                        | 2.1.257           | 2026-11-12 | `testing_run_checks`, `workflows_start` (`repo-health` → `git_status`, `git_log`, `testing_run_checks`) | ✅     | headless `claude -p` with `--mcp-config`                                                                                                                     |
| Codex                              | codex-cli 0.166.0 | 2026-11-12 | same as above                                                                                           | ✅     | Codex asks before calling MCP tools that aren't read-only. Headless runs need `mcp_servers.agentbelt.default_tools_approval_mode="approve"`                  |
| VS Code (Copilot Chat, Agent mode) | 1.142.0           | 2026-11-13 | same as above                                                                                           | ✅     | project folder from MCP roots (no `--workspace`); audit client `Visual Studio Code`; agent-mode tool calls approved in the chat                              |
| DeepSeek Harness                   | 0.2.2-rc.1        | 2026-11-13 | same as above                                                                                           | ✅     | audit client `dsh-mcp-client`; no MCP roots, so `setup --workspace <project>` is required                                                                    |
| LM Studio                          | 0.4.28            | 2026-11-13 | same as above                                                                                           | ✅     | audit client `lmstudio-mcp-server-session`; model qwen3-4b-2507; plugin `mcp/agentbelt` must be switched on in the chat; needs `setup --workspace <project>` |
| Cursor                             | 3.30.8            | 2026-11-13 | same as above                                                                                           | ✅     | audit client `cursor-vscode`; project from MCP roots (open the folder first)                                                                                 |

Config only (no real tool call yet): Claude Desktop. Cursor 3.30 does not expand
`${workspaceFolder}` in `~/.cursor/mcp.json` (the first setup pointed at a nonexistent folder), but
with a folder open it sends MCP roots, so setup writes plain `serve`. In Cursor's "No Repo" agent
window there is no project, and agentbelt refuses the home folder.
Note: Bionic (also from Element Labs) shares `~/.lmstudio` but manages MCP servers as its own
Connectors and ignores `mcp.json`; agentbelt has no Bionic adapter. Claude Desktop, LM Studio and DeepSeek Harness give MCP servers no project folder, so
`setup` needs `--workspace <project>` for them; VS Code and Cursor (with a folder open) send MCP roots.

Release: `agentbelt@0.1.0` and the five `@agentbelt/*` packages are on npm (2026-11-13). A clean
`npx agentbelt@0.1.0 setup` from the registry was checked: install, verification, MCP handshake,
16 tools, and real `git_status`, `testing_detect` and `workflows_list` calls.

Server: official MCP TypeScript SDK `@modelcontextprotocol/server` 2.4.0. It negotiates protocol
versions 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07.
