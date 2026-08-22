# Agent API

## Boundary

The Agent API is Lumen's first-class development interface for AI agents and the internal application suite. It controls and verifies semantic viewer behaviour without human inspection. It has production-level quality and regression priority but is absent from production artifacts and adds no production launch or render cost.

The Linux transport is a local Unix agent socket enabled only by an explicit development option in a private runtime directory. It never listens on TCP and does not use network authentication.

```text
Normal UI ──────┐
                ├── shared product action ── authoritative product state
Agent API ──────┘
```

Every user-visible feature has one shared action and authoritative state transition. UI and Agent API inputs are adapters. An API-only mutation, test-only shortcut, duplicate action, or obsolete parallel path is a release-blocking defect. Diagnostic observations never mutate or synchronize product state.

## Protocol

Protocol v3 is local, line-based, and bounded. A client starts with `hello` and validates the returned version, capabilities, operations, schemas, and limits. There is no compatibility path for older versions.

```text
hello
event <operation> [arguments]
await <id>
await-ready
events [after-sequence]
```

- The socket allocates strictly increasing request IDs per process; clients never choose or coordinate them.
- `event` accepts and dispatches a semantic action, returning `accepted <id>`. `await <id>` returns one terminal record.
- Outcomes are `completed`, `failed`, `no-op`, `not-found`, `stale`, `superseded`, and `unavailable`.
- Completion boundaries are `input-consumed`, `displayed`, `layout-settled`, and `terminal-layout`.
- Normal UI input wins conflicts. Superseded Agent requests identify the causal request.
- Fixed limits are 4 KiB per request, 8 KiB per event-history response, 64 KiB per explicit inspection, 64 in-flight requests, and 128 retained completions.

The `hello` response implemented in `src-tauri/src/agent_api/protocol.rs` is the executable authority for available operations. The current domains are:

| Domain                     | Operations                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Documents                  | `open`, `close`, `close-tabs`, `select-tab`, `reload`, `handoff-open`, `link`                                                         |
| Viewport                   | `directory-ready`, `drag-begin`, `drag-end`, `page-displayed`, `scroll`, `scroll-settled`, `seek`, `terminal-layout`, `zoom`, `focus` |
| Find                       | `find`, `find-next`, `find-previous`, `find-clear`, `find-observation`                                                                |
| Watching/configuration     | `watcher-ready`, `watcher-reload`, `configuration-notice`                                                                             |
| UI                         | `notice-dismiss`, `notice-action`, `copy-path`                                                                                        |
| Explicit inspection        | `displayed-html`                                                                                                                      |
| Diagnostic trace           | `viewport-trace-begin`, `viewport-trace-read`, `viewport-trace-end`                                                                   |
| Isolated test presentation | `test-run-state`                                                                                                                      |

## Semantic boundaries

`scroll` changes the normal viewer scroll container and completes from its native `scroll` event. It exercises the same page-selection path as wheel or scrollbar input; it is not an Agent-only seek.

`drag-begin` and `drag-end` adapt to the viewer's ordinary pointer-interaction lifecycle and prevent intermediate `scrollend` settlement while a native thumb is held. They do not create a second scrolling implementation. A returned drag ID correlates `drag-end`, `page-displayed`, and `scroll-settled`; unrelated or stale IDs are rejected.

`page-displayed <source-offset> [drag-id]` completes when the mounted page window contains the offset. `terminal-layout` completes only after the terminal seek refreshes bounded scroll state. `find-observation` synchronously redraws the existing overlay before returning its bounded active-range state; it does not change the query, document, or viewport.

`watcher-ready` proves that the blocking inotify watcher installed the active directory generation. `watcher-reload` completes only after the shared single-flight watcher path drains its newest pending revision, adopts the restored viewport, and performs the external-generation acknowledgement. Failure is still reported through the ordinary document notice without crashing or blanking the last valid page.

`test-run-state` is accepted only by an isolated development instance launched with the native test-input guard. It updates the fixed test banner and cannot alter product state.

## Observations and inspection

Bounded observations cover `status`, tabs, Find/UI state, window state, viewport trace, explicit inspection, and document-work lifecycle. They may prove or diagnose a completed shared action, but they are not a private synchronization path. A UI probe carries the previous observation sequence, and the typed client accepts the resulting notice snapshot only after Rust records a newer sequence; this proves observation delivery without a fixed delay or product-state mutation.

Routine events, observations, and logs contain no document content. `displayed-html <byte-offset> <byte-length>` is the sole explicit rendered-content inspection. It captures at most 64 KiB of the requested UTF-8 range on demand, retains the response only for its matching request, never runs as part of page mounting, and never enters event history or logs. The API provides no arbitrary JavaScript, generic state serialization, filesystem mutation, raw-document dump, remote control, or production access.

`viewport-trace-begin <label>`, `viewport-trace-read <trace-id> [after-sequence]`, and `viewport-trace-end <trace-id>` manage one opt-in, content-free frontend trace. Its ID increases strictly, its lowercase-hyphen label is at most 64 bytes, and it deliberately spans document-generation changes. It retains at most 256 records and a 48 KiB snapshot; records carry monotonic elapsed time, request/drag IDs when applicable, bounded scroll and source positions, current generations, anchor state, and at most 512 bytes of diagnostic detail. A socket read transfers the snapshot through no more than six 8 KiB invoke chunks. Truncation and the first omitted sequence are explicit, and ending a trace releases it. It never creates per-scroll production IPC.

Document-work observation retains at most 32 content-free lifecycle transition records. Incremental indexing progress updates the bounded status counters without consuming lifecycle-history entries. For viewport work, `status` exposes `document_generation`, `input_generation`, `page_generation`, `width_epoch`, `geometry_revision`, `pending_page_request`, `reader_input_active`, `scroll_write_pending`, and `viewport_anchor`, plus bounded source-cache/index/search counters. `scroll_write_pending` acknowledges the one anchor-restoration scroll write until its native event arrives; it is not timer-driven settlement. [TESTING.md](TESTING.md) owns how observations, logs, and timing evidence may be used.

## Implementation ownership

| Path                            | Responsibility                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src-tauri/src/shared_actions/` | Shared Rust product actions.                                                                   |
| `src-tauri/src/agent_api/`      | Development protocol, request registry, Unix transport, test guard, and bounded observation.   |
| `web/src/shared-actions/`       | Shared frontend document, viewport, Find, and notice actions.                                  |
| `web/src/agent-api/`            | Development listeners and completion adapters, loaded only by the frontend development branch. |
| `scripts/agent-api/`            | Typed client, contract test, scenarios, and diagnostic helpers. Never shipped.                 |

Product state stays in its normal document, window, and frontend modules. Shared-action modules contain cross-boundary product actions; Agent API modules contain only protocol, adaptation, completion, guards, and bounded observation.

## Manual operation

Start a development build with an explicit private socket:

```sh
agent_runtime="$XDG_RUNTIME_DIR/lumen-agent"
install -d -m 700 "$agent_runtime"
npm run tauri -- dev -- --agent-socket "$agent_runtime/lumen.sock" fixtures/reload-on-save.md
```

Inspect it from another terminal:

```sh
src-tauri/target/debug/lumen --inspect-agent-socket "$agent_runtime/lumen.sock" status
```

The socket's `quit` command requests normal Tauri shutdown. Automated execution must use the isolated harness in [TESTING.md](TESTING.md), not this manual launch sequence.
