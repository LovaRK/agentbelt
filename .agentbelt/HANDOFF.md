# Handoff — agentbelt 0.1.0

Read this first, then `.agentbelt/MASTER_PLAN.md`. Run `agentbelt resume` for live git/model facts.
Update progress with `agentbelt progress set <id> <STATUS> --evidence "…"` (VERIFIED needs evidence).

- Milestones: 15 verified, 2 implemented-unverified, 1 in progress, 0 not started, 0 blocked, 0 failed
- Current: M15 Adapters: Cursor, VS Code, Claude Desktop, LM Studio (IMPLEMENTED_UNVERIFIED)
- Interrupted (IN_PROGRESS): M10 DeepSeek integration
- Last verified: M14 Linux bubblewrap sandbox backend — GitHub CI run https://github.com/LovaRK/agentbelt/actions/runs/43308961942 (commit 5b701db): ubuntu-latest Node 22+24 with AGENTBELT_REQUIRE_SANDBOX=1, bubblewrap backend active; malicious-plugin test blocked file read/write, shell, network, secrets. Not run on other distributions.
- Next: M10 DeepSeek integration (done when: real MCP execution in audit log)
- Open blockers: B1 DeepSeek verification needs the user to send one prompt in DeepSeek Harness (no headless mode used); B2 Release needs approvals: GitHub owner, commit author name, push, npm publish, Changesets install
- Recent decisions: D3 Untrusted plugins fail closed; D4 Model-independent, local-first routing; D5 Project state
- Last checkpoint: 2026-11-12T20:54:53.956Z Project control system added and verified; M10 waits for the user's DeepSeek prompt
