# agentbelt — master plan

The single source of truth for scope and milestones. Edit this file by hand; agentbelt never overwrites it.
Live status is in `PROGRESS.md` (generated). Start every session with `agentbelt resume`, and end it by
recording progress with `agentbelt progress set <id> <STATUS> --evidence "…"`.

## Goal

A vendor-neutral, model-independent, open-source MCP toolkit:
- the same safe tools work in DeepSeek Harness, Claude Code, Codex and any MCP client;
- one-command install;
- enforced permissions and an audit log;
- untrusted plugins run only in an OS sandbox, and fail closed;
- explicit, verified updates with rollback;
- no mandatory LLM or cloud key.

## Priorities

Security → Reliability → Compatibility → Simplicity → Performance → Extensibility.

## v0.1.0 milestones

| ID | Milestone | Done when |
| --- | --- | --- |
| M0 | Repository inspection | audit of files, commits and tests recorded |
| M1 | Core MCP server | integration tests pass |
| M2 | Plugin SDK | unit tests pass |
| M3 | Permission broker | security tests pass |
| M4 | Git plugin | real tool execution |
| M5 | Testing plugin | real tool execution |
| M6 | Workflow plugin | workflow run results |
| M7 | CLI installer | fresh installation verified |
| M8 | Claude Code integration | real calls in audit log |
| M9 | Codex integration | real calls in audit log |
| M10 | DeepSeek integration | real MCP execution in audit log |
| M11 | Security hardening | security tests pass |
| M12 | Documentation and release | release checklist complete (needs the user's approvals) |
| M13 | Project control system | status, resume, progress, context, model routing tested |

## v0.2 (after v0.1 is released)

1. Linux sandbox backend (bubblewrap), still failing closed.
2. Adapters for Cursor, VS Code, Claude Desktop and LM Studio.
3. An optional coding-agent plugin (local, DeepSeek API or any endpoint) using the model router.
4. An opt-in scheduler and triggers within the broker and audit model.

Deferred: marketplace UI, multi-agent, voice.

## Rules

- Ask the user before:
  - pushing or publishing;
  - installing dependencies or models;
  - changing client app configs;
  - anything destructive.
- Never mark work VERIFIED without evidence. Never describe policy-only execution as a sandbox.
- Never send project code to a cloud model without the user choosing it.
