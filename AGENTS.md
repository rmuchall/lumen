# Lumen agent instructions

Read [DEVELOPMENT.md](DEVELOPMENT.md) before changing the repository. It is the first-visit runbook; the document map below identifies the single owner for every specialist topic.

## Product constraints

- Lumen is an offline Markdown viewer for modern supported systems. Ubuntu Linux is the active target.
- Optimise launch and preview speed before rendering accuracy. Preserve WebKit's GPU-accelerated compositing path.
- Rust owns lifecycle, file I/O and watching, TOML configuration, Markdown parsing, caching, search, and platform integration. Do not move Markdown parsing into the frontend.
- The viewer is plain strict TypeScript and locally authored CSS, built by Vite. Keep its Markdown viewport independent of a frontend or CSS framework.
- Raw HTML is disabled. Lumen makes no network requests, loads no remote assets, uses no CDN, and sends no telemetry. Explicit Markdown web links may open only in the system browser.
- User configuration is read-only TOML. Automatically maintained values belong under the XDG state directory.
- Use the minimum Tauri capability set and no plugins unless a concrete feature requires one.

## Change policy

- Keep the project footprint as small as possible. Do not import templates or generated scaffolds; the Tauri integration is maintained manually.
- Add only what the active task requires. Prefer direct code over abstractions for hypothetical future work, compatibility fallbacks, or retained legacy paths.
- Do not add an external dependency without the user's explicit agreement. Before requesting approval, compare the smallest local implementation with the leanest robust dependency, its exact enabled features, and its dependency closure. Prefer local code when its maintenance cost is low; otherwise prefer the leanest robust dependency. Pin every accepted version exactly.
- Keep Rust-to-frontend communication coarse-grained. Do not add high-volume rendering IPC.
- Push back on work that materially compromises footprint, launch speed, or render speed.
- Do not inline image assets. Use the individually vendored Heroicons described in [ARCHITECTURE.md](ARCHITECTURE.md); never add an icon package or remote icon source.
- Automated-test code and fixtures are internal development tooling. Never import them into production code or include them in a release artifact.

## Evidence and quality

- Diagnose before fixing: gather evidence with the existing diagnostics and focused tests, identify the failure, then implement the smallest verified correction.
- Any automated-test failure, including an intermittent failure or invalid completion receipt, takes priority over product work. Follow [TESTING.md](TESTING.md) exactly.
- Add the smallest reliable regression test for an observable bug. Keep platform-owned or purely visual checks manual when automation would be brittle.
- Never retain obsolete or parallel implementations. A clean replacement is preferred even when it is destructive.
- Do not weaken or suppress Clippy, OXLint, OXFmt, or TypeScript rules. Use braces for control flow, avoid TypeScript `any`, use explicit module-boundary types, and prefer named functions when they are clearer.
- After source changes, run the applicable checks listed in [DEVELOPMENT.md](DEVELOPMENT.md). Rust changes must pass formatting, Clippy with warnings denied, and Rust tests.

## Agent API and diagnostics

- Normal UI and Agent API inputs must adapt to the same shared action and authoritative product state. An Agent-API-only mutation, duplicate action path, or test-only product shortcut is a release-blocking defect.
- Keep the development-only Agent API bounded, local-only, content-safe by default, and absent from production artifacts. Follow [AGENT_API.md](AGENT_API.md).
- Diagnostics must remain minimal, local, and subordinate to launch and render performance. Do not add panic hooks, checksums, crash recovery, telemetry, or complex logging without evidence that the active investigation requires them.

## Safety and execution

- Prefer `rg`, `git`, `node`, `npm`, `cargo`, and installed project tooling.
- Never stage, commit, amend, merge, rebase, push, pull, tag, or perform another Git write without express authorization in the current request.
- Never copy secrets, credentials, private data, or local databases into documentation.
- Do not make destructive or recursive changes outside this repository without explicit confirmation.
- Do not benchmark with cache flushing or rapid launch-and-force-termination loops. Use one interactive launch at a time and close it normally.
- Treat a yielded long-running command as live. Preserve and poll its session until it exits, then verify the required final receipt. If no session ID is returned, prove the writer exited from its process tree before inspecting its unique transcript or retrying. Never rerun or touch a live command's output target.
- Use one writer per output target. Verify downloaded release artifacts before execution. Use a managed, bounded systemd task only for work intentionally outliving the terminal.

## Documentation ownership

Keep each fact in one canonical document. `AGENTS.md` is the only documentation index. `README.md` and `THIRD_PARTY_NOTICES.md` are the only documents shipped in production; the README must remain user-facing and must not link to repository-development material.

| Document                                         | Owns                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [DEVELOPMENT.md](DEVELOPMENT.md)                 | First-visit workflow, repository map, commands, runtime locations, and release procedure. |
| [ARCHITECTURE.md](ARCHITECTURE.md)               | Enduring product boundaries and current implementation decisions.                         |
| [AGENT_API.md](AGENT_API.md)                     | Development-only protocol, actions, limits, ownership, and operation.                     |
| [TESTING.md](TESTING.md)                         | Evidence, tests, diagnostics, logs, performance measurement, and regression policy.       |
| [README.md](README.md)                           | Production installation, use, configuration, supported Markdown, and privacy behaviour.   |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Notices for third-party assets distributed with Lumen.                                    |
