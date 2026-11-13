# Handoff — agentbelt 0.1.0

Read this first, then `.agentbelt/MASTER_PLAN.md`. Run `agentbelt resume` for live git/model facts.
Update progress with `agentbelt progress set <id> <STATUS> --evidence "…"` (VERIFIED needs evidence).

- Milestones: 18 verified, 0 implemented-unverified, 0 in progress, 0 not started, 0 blocked, 0 failed
- Current: M15 Adapters: Cursor, VS Code, Claude Desktop, LM Studio (VERIFIED)
- Interrupted (IN_PROGRESS): none
- Last verified: M15 Adapters: Cursor, VS Code, Claude Desktop, LM Studio — Real calls: VS Code 1.142.0 (client 'Visual Studio Code') and LM Studio 0.4.28 (client 'lmstudio-mcp-server-session', qwen3-4b-2507), 2026-11-13: testing_run_checks ok, workflows_start repo-health ok. Cursor and Claude Desktop remain config-only (fixtures).
- Next: none
- Open blockers: B1 DeepSeek verification needs the user to send one prompt in DeepSeek Harness (no headless mode used); B2 Release needs approvals: GitHub owner, commit author name, push, npm publish, Changesets install
- Recent decisions: D3 Untrusted plugins fail closed; D4 Model-independent, local-first routing; D5 Project state
- Last checkpoint: 2026-11-12T20:54:53.956Z Project control system added and verified; M10 waits for the user's DeepSeek prompt
