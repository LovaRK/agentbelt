# Contributing

Thanks for helping! agentbelt aims to stay **small, safe and boring to operate**.

## Setup

```bash
npm install --ignore-scripts
npm run build
npm test            # unit, integration, install lifecycle, sandbox and repo guards
npm run typecheck
npm run format:check
```

## Ground rules

- **Security first.** New tools must go through `ctx` (the broker). CI rejects direct
  `child_process`, `fs` or `net` imports in `plugins/`.
- **No destructive or outward actions without the user.** No push, publish or delete tools, and
  no tool may approve a workflow gate.
- **Honest docs.** Don't claim compatibility you haven't verified (see
  `docs/compatibility.md`), and don't describe `policy-only` as a sandbox.
- **Small dependencies.** Discuss new runtime dependencies in an issue first.
- **Privacy.** No personal paths, emails or tokens in the repo; a CI guard checks.

## Good first contributions

- An adapter for another MCP client (`packages/cli/src/adapters.ts`), with a fixture test.
- A skill (`packages/cli/skills/<name>/SKILL.md`, Agent Skills format).
- Test-runner detection for another ecosystem (`plugins/testing`).

Pull requests need passing CI and a short description of what changed and how you tested it.
By contributing you agree your work is licensed under Apache-2.0.
