# Decisions (generated)

## D1 Name, license, repo (2026-11-12)

agentbelt, Apache-2.0, fresh public-ready repo with no private history

Why: user decision 2026-11-12

## D2 MCP SDK (2026-11-12)

official @modelcontextprotocol/server 2.4.0 (stable v2), zod 4.6.7 pinned

Why: verified stable on npm; negotiates protocol versions back to 2024-10-07

## D3 Untrusted plugins fail closed (2026-11-12)

third-party plugins install with --ignore-scripts and run only in an OS sandbox; refused if none is available

Why: a permission manifest is not a sandbox

## D4 Model-independent, local-first routing (2026-11-12)

tools need no LLM; routing prefers local models with checked capabilities; complex/high-risk work goes to a user-selected model; never silent cloud

Why: privacy and cost

## D5 Project state (2026-11-12)

single JSON source (.agentbelt/project.json) with lock + atomic writes + backup; Markdown views generated; MASTER_PLAN.md human-owned

Why: continuity across agents and sessions
