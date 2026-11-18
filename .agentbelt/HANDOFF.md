# Handoff — agentbelt 0.1.0

Read this first, then `.agentbelt/MASTER_PLAN.md`. Run `agentbelt resume` for live git/model facts.
Update progress with `agentbelt progress set <id> <STATUS> --evidence "…"` (VERIFIED needs evidence).

- Milestones: 19 verified, 2 implemented-unverified, 0 in progress, 1 not started, 0 blocked, 0 failed
- Current: M19 Claude Desktop: real tool call (issue 8) (IMPLEMENTED_UNVERIFIED)
- Interrupted (IN_PROGRESS): none
- Last verified: M15 Adapters: Cursor, VS Code, LM Studio (real calls) — Real calls on 2026-11-13: VS Code 1.142.0 ('Visual Studio Code'), LM Studio 0.4.28 ('lmstudio-mcp-server-session'), Cursor 3.30.8 ('cursor-vscode', run 20261113052709-cb53 succeeded, project via MCP roots): testing_run_checks ok, workflows_start repo-health ok. Claude Desktop remains config-only.
- Next: M19 Claude Desktop: real tool call (issue 8) (done when: a real Claude Desktop chat calls an agentbelt tool, seen in the audit log)
- Open blockers: B3 Claude Desktop check needs Claude Desktop quit, which ends any session running inside it; run it from a terminal
- Recent decisions: D3 Untrusted plugins fail closed; D4 Model-independent, local-first routing; D5 Project state
- Last checkpoint: 2026-11-12T20:54:53.956Z Project control system added and verified; M10 waits for the user's DeepSeek prompt
