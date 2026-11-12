# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository (Security → Advisories). Don't open a public issue. We aim to reply within 3 working days.

## Threat model

agentbelt assumes that **the model driving it may be wrong or manipulated**, for example by a prompt injection in a file it read. The goal is that such a model can't:

- push code;
- change your current branch;
- escape the project folder;
- run arbitrary programs;
- approve its own work.

### What is enforced

| Layer              | Enforcement                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool arguments     | Validated against each tool's schema before the tool runs.                                                                                                                                                                                                                                                                        |
| Plugin permissions | Checked by the broker on **every** action at the moment it happens: which programs (`exec`), project reads, project writes, and calling other tools.                                                                                                                                                                              |
| Command policy     | Arguments are passed as a list, never through a shell. Each program is on an allowlist, limited to allowed subcommands (git has no `push`/`fetch`/`reset`/`checkout`/`clean`/`config`). Every argument that looks like a path must resolve inside the project, symlinks included, and may not touch `.git` or `.agentbelt` state. |
| Environment        | Commands get a minimal environment: tokens and keys from your shell are not passed.                                                                                                                                                                                                                                               |
| Output             | Common credential formats are redacted before output reaches the model or the audit log.                                                                                                                                                                                                                                          |
| Approvals          | Workflow approval gates are decided only by the `agentbelt` CLI; no MCP tool can approve or reject.                                                                                                                                                                                                                               |
| Commits            | Only to `agentbelt/<task>` branches in separate worktrees.                                                                                                                                                                                                                                                                        |
| Workspace          | One project per server; the home directory and `/` are refused.                                                                                                                                                                                                                                                                   |
| Audit              | Every tool call, command and denial is written to `<project>/.agentbelt/audit.jsonl`.                                                                                                                                                                                                                                             |

### What is not a sandbox

Built-in (first-party) plugins run **in-process with `policy-only` isolation**. The checks above apply, but there is no OS sandbox. When `testing_run_checks` runs `npm test`, your project's own test code runs with your user's rights, exactly as in your terminal. agentbelt labels this as `policy-only` everywhere and never calls it a sandbox.

### Third-party plugins

- **Install:** with npm `--ignore-scripts`, so no `preinstall`/`postinstall`/`prepare` code runs. npm checks package integrity. The plugin's permissions come from static JSON in its `package.json`, and you approve them before anything is enabled.
- **Pinning:** the grant is pinned to a SHA-256 hash of every installed file. Any change refuses the plugin until you grant it again.
- **Run:** in a separate process inside an **OS sandbox**, macOS `sandbox-exec`, which denies by default:
  - no network;
  - no file writes;
  - no reads outside the plugin's folder and the Node runtime;
  - no other programs;
  - a minimal environment.

  The plugin's only channel is the broker, which applies its permissions and the command policy to every request and audits it.

- **Fail closed:** if no sandbox backend is available, third-party plugins are neither installed nor run. Today that is anything except macOS; Linux (bubblewrap) and container backends are planned.
- **Caveat:** Apple deprecated `sandbox-exec`, though it still ships and enforces profiles. If it disappears or changes, agentbelt refuses third-party plugins rather than running them unsandboxed.

### Known limits

- Redaction is pattern-based. It reduces accidental leaks; it is not a guarantee.
- A project's own test scripts can do anything your user can. Review unfamiliar projects before running their checks.
- MCP clients decide which tools the model may call without asking you; check your client's approval settings.
