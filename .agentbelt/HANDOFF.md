# Handoff — agentbelt 0.1.0

Read this first, then `.agentbelt/MASTER_PLAN.md`. Run `agentbelt resume` for live git/model facts.
Update progress with `agentbelt progress set <id> <STATUS> --evidence "…"` (VERIFIED needs evidence).

- Milestones: 16 verified, 1 implemented-unverified, 1 in progress, 0 not started, 0 blocked, 0 failed
- Current: M15 Adapters: Cursor, VS Code, Claude Desktop, LM Studio (IMPLEMENTED_UNVERIFIED)
- Interrupted (IN_PROGRESS): M10 DeepSeek integration
- Last verified: M12 Documentation and release — Public repo github.com/LovaRK/agentbelt; CI green (ubuntu+macOS x Node 22/24) and CodeQL green; all 6 packages published to npm as 0.1.0 on 2026-11-13 (agentbelt, @agentbelt/core, plugin-git/testing/workflows/agent) with 2FA; clean 'npx agentbelt@0.1.0 setup' from the registry in an isolated HOME: verified install, handshake, 16 tools, real git_status/testing_detect/workflows_list calls. Note: first publish was local, so no provenance on 0.1.0.
- Next: M10 DeepSeek integration (done when: real MCP execution in audit log)
- Open blockers: B1 DeepSeek verification needs the user to send one prompt in DeepSeek Harness (no headless mode used); B2 Release needs approvals: GitHub owner, commit author name, push, npm publish, Changesets install
- Recent decisions: D3 Untrusted plugins fail closed; D4 Model-independent, local-first routing; D5 Project state
- Last checkpoint: 2026-11-12T20:54:53.956Z Project control system added and verified; M10 waits for the user's DeepSeek prompt
