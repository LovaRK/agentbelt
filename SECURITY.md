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
- **Run:** in a separate process inside an **OS sandbox** that denies by default: macOS `sandbox-exec`, or on Linux bubblewrap (`bwrap`: an empty read-only root, its own network and process namespaces, only the Node binary, its libraries and the plugin folder mounted). Either way:
  - no network;
  - no file writes;
  - no reads outside the plugin's folder and the Node runtime;
  - no other programs;
  - a minimal environment.

  The plugin's only channel is the broker, which applies its permissions and the command policy to every request and audits it.

- **Fail closed:** if no sandbox backend is available, third-party plugins are neither installed nor run. On Linux, bubblewrap is used only after a probe run succeeds, since some distributions restrict unprivileged user namespaces (Ubuntu 24.04 does, through AppArmor); otherwise third-party plugins are refused. Windows has no backend. Container backends are planned.
- **Testing:** the macOS backend is tested on a Mac and in CI. The Linux backend is tested in CI on `ubuntu-latest` (Node 22 and 24, namespace restriction lifted on the runner), where the malicious-plugin test passes; it has not been run on other distributions.
- **Caveat:** Apple deprecated `sandbox-exec`, though it still ships and enforces profiles. If it disappears or changes, agentbelt refuses third-party plugins rather than running them unsandboxed.

### Optional coding agent (`agent_run`)

- Off unless the user runs `agentbelt agent setup`. The endpoint and model are chosen there and stored in agentbelt's own config (mode 600), which plugins cannot write.
- Loopback endpoints only, unless the user picks the DeepSeek API or passes `--allow-remote`. Remote endpoints must use https. Redirects and credentials in the URL are refused.
- The API key is kept in the OS keychain (macOS `security`, Linux `secret-tool`) and typed at the keychain's own prompt. The core adds it to each request; plugin code never sees it, and it is never written to disk or logged.
- The agent model acts only through broker tools (list/read files, run the checks, see the diff; write files only with `write: true`). Every model call is audited (`kind: "model"`). Files it reads are sent to the endpoint you chose.

### Scheduler and triggers

- Off by default. Schedules and triggers are created only with the CLI, never through MCP tools, and run only while the user keeps `agentbelt scheduler run` going in that project.
- Each run is a normal `workflows_start` call through the broker, audited as client `agentbelt-scheduler`. Approval gates still wait for the user.
- Only local triggers: file changes and new commits on a branch, both polled. Webhook and GitHub triggers are not offered, since they would need a network listener or remote access. Event values are cleaned and clipped, and only inputs the workflow declares are passed.

### Known limits

- Redaction is pattern-based. It reduces accidental leaks; it is not a guarantee.
- A project's own test scripts can do anything your user can. Review unfamiliar projects before running their checks.
- MCP clients decide which tools the model may call without asking you; check your client's approval settings.
