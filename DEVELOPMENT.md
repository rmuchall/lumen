# Development

## First visit

Lumen is a manually assembled Tauri 2 application. Rust owns document and platform work; the plain TypeScript/CSS frontend owns presentation. Ubuntu Linux is the active target.

Before changing anything:

1. Read [AGENTS.md](AGENTS.md) for non-negotiable policy and documentation ownership.
2. Check `git status --short`; preserve unrelated user changes.
3. Read [ARCHITECTURE.md](ARCHITECTURE.md), then the specialist document for the area being changed.
4. Inspect the live implementation and its focused tests. Documentation describes current contracts, not an alternative source tree.
5. Make the smallest complete change and run the proportionate checks below.

The manifests are authoritative for exact tool and dependency versions. Do not add or update a dependency without the review required by `AGENTS.md`.

## Repository map

| Path                            | Responsibility                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src-tauri/src/`                | Rust lifecycle, documents, Markdown, search, configuration, watching, state, and Linux integration. |
| `src-tauri/src/shared_actions/` | Shared production actions used by UI and Agent API adapters.                                        |
| `src-tauri/src/agent_api/`      | Development-only protocol, bounded registry, Unix transport, test guard, and observations.          |
| `src-tauri/capabilities/`       | Minimum Tauri permissions.                                                                          |
| `web/src/`                      | Framework-independent viewer UI, local CSS, controls, and layout-page viewport.                     |
| `web/src/shared-actions/`       | Shared frontend document, viewport, Find, and notice actions.                                       |
| `web/src/agent-api/`            | Development-only Agent API listeners and completion reporting.                                      |
| `fixtures/`                     | Checked-in compact automated regression inputs and local image assets.                              |
| `fixtures/performance/`         | Generated, ignored, persistent 5/20/100 MiB read-only test inputs.                                  |
| `scripts/agent-api/`            | Internal typed client, contract tests, scenarios, and diagnostic helpers. Never shipped.            |
| `scripts/testing/`              | Internal isolation, suite orchestration, fixture generation, and pure-model tests. Never shipped.   |
| `scripts/release/`              | Internal production-artifact assertions. Never shipped.                                             |

## Commands

Node runs the internal TypeScript scripts directly. TypeScript uses strict checking; Rust uses edition 2024.

| Command                                                                          | Purpose                                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run tauri -- dev`                                                           | Start the development application with Vite.                          |
| `npm run build`                                                                  | Build the frontend.                                                   |
| `npm run lint`                                                                   | Run OXLint and verify OXFmt formatting.                               |
| `npm run types`                                                                  | Run strict TypeScript checking.                                       |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                         | Verify Rust formatting.                                               |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Run strict Rust linting.                                              |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                | Run Rust tests.                                                       |
| `npm run test:case -- <name>`                                                    | Run one clean focused application case.                               |
| `npm run test:critical`                                                          | Run the source-change application tier.                               |
| `npm run test:regular`                                                           | Run broader watcher, configuration, link, and viewer coverage.        |
| `npm run test:stress`                                                            | Run the large-document stress matrix.                                 |
| `npm run verify`                                                                 | Run static checks, Rust checks, and the critical application tier.    |
| `npm run test:production-artifact`                                               | Build release layers and verify that development-only code is absent. |

[TESTING.md](TESTING.md) owns test selection, isolation, fixtures, completion receipts, diagnostics, and the opt-in performance command.

## Runtime locations

| Data                           | Location                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- |
| User configuration             | `$XDG_CONFIG_HOME/lumen/config.toml`, otherwise `~/.config/lumen/config.toml` |
| Automatically maintained state | `$XDG_STATE_HOME/lumen`, otherwise `~/.local/state/lumen`                     |
| Production logs                | the `logs` directory below production state                                   |
| Development logs               | the `logs` directory below `lumen/development` state                          |

Lumen reads but never writes user configuration. Configuration changes apply after relaunch. Automatically maintained state currently stores window maximization only.

## Release procedure

The Debian package is the Linux release and dogfood artifact and registers Lumen for `text/markdown`.

1. Deliberately update the matching versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` when the release version changes.
2. Run `npm run verify`. Its critical tier is the only application-test tier required specifically to create a release; do not run the regular or stress tiers merely because a release is being built.
3. Run `npm run test:production-artifact`.
4. Inspect and dogfood the Debian package before distribution.
5. Create one release directory named `lumen-<version>-<platform>`, using the release version and platform identifier; for example, `lumen-0.1.39-linux-x86_64`.
6. Place the platform package, `README.md`, and `THIRD_PARTY_NOTICES.md` in that directory. Do not place release files alongside the directory or add repository-development documents.

`README.md` and `THIRD_PARTY_NOTICES.md` are mandatory and are the only documents that may accompany the production package. Git publication actions always require separate express authorization.
