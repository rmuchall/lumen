# Evidence and testing

## Evidence rule

Do not guess at a defect or optimisation. Reproduce it, capture the smallest relevant request-correlated evidence, identify the failing Lumen-owned boundary, and only then change code. Correctness is established by semantic events and bounded state at the action boundary—not elapsed time, retry success, fixed delays, stale geometry, or machine speed.

Any automated failure, including an intermittent failure, invalid completion output, or dirty teardown, takes priority over product work. A suite is not a trustworthy regression guard until the failure is isolated and eliminated.

## Isolated application contract

Every tier and focused case is self-contained and owns exactly one Lumen process, private XDG directories, one agent socket, one OS-assigned Vite port, and one temporary root. It must begin from a clean slate, request normal Lumen shutdown, tear down its owned resources, and prove that no owned process, socket, or temporary root remains.

A test must never:

- reuse an application, port, socket, XDG directory, mutable fixture, or log resource;
- launch a second Lumen process or pass objects between Lumen processes;
- alter production window size, position, maximization, minimization, theme, compositor, rendering path, or configuration semantics;
- replace semantic completion with a delay, timing threshold, polling shortcut, or private state mutation; or
- import test code or fixtures into production artifacts.

Native cross-process file-manager forwarding remains manual dogfood coverage. Automated coverage exercises the primary-instance receiver inside its one process.

### Native input guard

Every automated application run starts Lumen with the Rust-owned native test-input guard. Rust disables GTK window input and rejects close requests while leaving the Agent API available. The runner sends coarse phase changes; the development frontend displays a fixed, non-interactive, layout-neutral banner. The guard, banner, and CSS are absent from production artifacts.

Do not weaken, bypass, or replace the native guard with frontend-only input blocking.

### Completion receipt

After clean teardown, every tier and focused case emits exactly one:

```text
test:<name> complete status=passed total=<milliseconds>ms
```

The wrapper then validates that terminal line and writes one JSON receipt. By default it creates a unique path below `/tmp/lumen-receipts/` and prints the path before launch. An investigation may select a new absolute path:

```sh
node scripts/testing/run-suite.ts --receipt <new-absolute-path> --tier stress
```

The path must not already exist. Read it only after the wrapper exits. A zero exit without exactly one valid terminal receipt and one valid durable receipt is a failure; incomplete terminal output is never evidence of completion.

## Suites and focused cases

| Command                                                                        | Coverage                                                                      | Use                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm run test:case -- <name>`                                                  | One independently isolated application behaviour.                             | Reproduction and focused regression work.              |
| `npm run test:critical`                                                        | Agent API contract, clean launch, core viewer/Find/tabs/errors, 5 MiB viewer. | After every source change.                             |
| `npm run test:regular`                                                         | Critical plus watcher, configuration, links, notices, and 20 MiB cases.       | Broader non-release handoff or investigation coverage. |
| `npm run test:stress`                                                          | 5/20/100 MiB content matrix and repeated viewer interactions.                 | After large-document pipeline work or investigation.   |
| `npm test`                                                                     | Critical followed by regular.                                                 | Default application suite.                             |
| `npm run verify`                                                               | Static checks, Rust checks, and the critical application tier.                | Default verification and release gate.                 |
| `npm run test:production-artifact`                                             | Release build and development/test exclusion scan.                            | Before release.                                        |
| `npm run test:performance -- --scenario <name> --record performance/<name>.md` | One opt-in measurement scenario.                                              | Explicit performance investigation only.               |

`npm run test:clean` removes owned resources from an interrupted run and is invoked by each application suite. Before any run, verify that no unrelated Lumen instance, agent socket, or earlier test writer remains. Never rerun a yielded suite; preserve and poll its live session until it exits.

Release creation requires the critical application tier only. The regular and stress tiers remain available for change-specific evidence and investigations, but are not release gates and must not be run solely because a release is being created. Release static, Rust, and production-artifact checks remain mandatory as listed in [DEVELOPMENT.md](DEVELOPMENT.md).

Test-suite composition is mandatory. New application behaviour first receives one independently runnable focused case with an explicit fixture and Agent API boundary; only then may it join a tier. `scripts/testing/run-tier.ts` is the executable list of supported cases and tier membership. Tier composition must never make one case depend on state from another.

## Fixtures and coverage

Compact fixtures are checked into `fixtures/` and copied into a run's temporary document root before mutation. Large deterministic prose, code, mixed, and malformed fixtures live under ignored `fixtures/performance/` at 5, 20, and 100 MiB.

Large fixtures and their adjacent marker manifests are persistent read-only inputs:

- Generate each only when absent, using the test runner or `npm run generate:performance-fixtures`.
- Never delete, rewrite, regenerate, or copy them during normal cleanup.
- Every tier reuses the same files.
- Marker manifests map bounded reader-visible markers to source offsets so tests do not load or compare an entire document.

Scroll-drag cases use the normal shared scroll-container action, held-drag lifecycle, and bounded viewport trace. They prove the final reader-visible page, non-blank mounted window, marker, Find state, and current generations. A terminal geometry reconciliation may legitimately change the physical scroll range, but not the semantic reader endpoint. These cases model deterministic Lumen-owned DOM behaviour; they do not claim to measure GNOME overlay painting or physical pointer latency.

The application suite covers launch and empty state, tabs, links, Find, notices, configuration, watcher lifecycle, structural Markdown, images, syntax, page boundaries, direct and held-drag seeks, terminal content, stale-work rejection, bounded resource release, tab restoration, and protocol isolation. Rust tests cover parser, source, layout planning, index, search, cache, watcher, and socket boundaries. The TypeScript geometry suite covers prefix sums, inverse lookup, measurements, width epochs, snapshots, and anchor round-trips.

## Diagnostics and logs

Diagnostics observe; they never control Lumen. Use a request-correlated Agent API completion first, then inspect only the bounded state needed to explain it. `status`, tabs, window state, Find/UI state, viewport traces, explicit rendered inspection, and document-work events are defined in [AGENT_API.md](AGENT_API.md).

Production lifecycle/error logs are best-effort plain text below `$XDG_STATE_HOME/lumen/logs`, or `~/.local/state/lumen/logs`. Development builds use the corresponding `lumen/development/logs` directory. Logs contain no document identity or content, retain at most ten whole runs, and cap each run at 64 KiB. They are evidence, not an audit trail.

For a crash, retain the smallest available local evidence: the OS report path, Lumen run log, package versions, renderer environment, and preceding ordinary action. Do not add crash hooks, recovery, software rendering, or broad workarounds without a reproducible Lumen-owned cause.

## Performance measurement

Performance collection is an explicit exception to ordinary correctness execution, not to isolation, semantic proof, or clean teardown. It accepts the scenarios `baseline`, `scroll-drag`, `wheel`, `tabs`, and `enrichment`. The output must be a new immutable Markdown file below ignored `performance/`; an invalid scenario, existing path, or path outside that directory fails before launch. A record is written only after normal shutdown and the usual valid receipt.

Ordinary tiers, `npm test`, `npm run verify`, and release checks never collect metrics. A measurement record contains environment, revision, fixture checksum, cold/warm state, raw samples, summary, and semantic/resource results. Build, Vite, and fixture-generation time are not application metrics.

Compare repeated samples only when environment, build type, fixture, configuration, and scenario match. Before a production performance change:

1. Establish a comparable baseline.
2. Use request-correlated evidence to identify one Lumen-owned bottleneck.
3. Change one production path at a time.
4. Retain it only if it is reproducibly faster without correctness, memory, startup, complexity, tail-latency, or worst-case regression.

The normal reader-visible rendering gate is a median improvement of at least 9%. The scrollbar gate is at least 5% and 5 ms at the median, with no reproducibly worse tail, blank viewport, incorrect page, reader jump, or resource regression. Stop after five evidence-backed unsuccessful candidates, or earlier when remaining cost is platform-owned or requires unjustified complexity. Remove rejected production code and temporary instrumentation.

Never optimise with a splash screen, artificial delay, cache flushing, force-termination loop, software renderer, compositor fallback, correctness timing threshold, full-document frontend rendering, or fine-grained rendering IPC.

## Regression policy

Add the smallest reliable regression test for a reproducible defect. Keep pixel-level WebKit and desktop-owned presentation checks manual unless a stable local semantic assertion exists. Every retained test must remain deterministic, focused, independently runnable, and cleanly composable.
