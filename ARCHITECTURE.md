# Architecture

## Product boundary

Lumen is a fast, lightweight, offline Markdown viewer. Launch and preview speed outrank perfect rendering fidelity. Ubuntu Linux is the active target; portability is desirable only where it does not add speculative abstractions, dependencies, or compatibility paths.

Lumen renders local Markdown and explicitly permitted local assets. The application makes no network requests, loads no remote assets, uses no CDN, and sends no telemetry. Explicit `http` and `https` Markdown links may open only in the system browser.

Lumen is currently a viewer, not an editor. `EDITOR_PLAN.md` describes possible future work and is not current architecture. This document records the implemented product.

## System shape and ownership

Lumen is a manually assembled Tauri 2 application with one native window and one bundled webview.

| Layer            | Owns                                                                                                                                                                                                                                                      | Does not own                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Rust             | Process and window lifecycle, document tabs, files and source identity, Markdown parsing, layout-page planning and rendering, indexing, Find, caches, file watching, configuration/state, links, menus, logging, instance handoff, and Linux integration. | Fine-grained DOM presentation or a complete frontend document model.                             |
| TypeScript/CSS   | One-window presentation, tab and document controls, notices, Find presentation, rendered-page DOM adaptation, viewport coordination, virtual geometry, native-scroll interaction, and theme styling.                                                      | Markdown parsing, full raw-file retention, source truth, filesystem policy, or native lifecycle. |
| Tauri/GTK/WebKit | Native window and menu, explicit command/event transport, GTK integration, the local asset protocol, and the GPU-composited browser surface.                                                                                                              | A second product state, Markdown-link policy, or high-volume rendering pipeline.                 |

The frontend is plain strict TypeScript and locally authored CSS built with Vite. It has no frontend or CSS framework. Rust-to-frontend document transfer is coarse-grained and bounded: snapshots, small page windows, page-directory snapshots, and completion events rather than per-line or per-node IPC.

The manifests own exact dependency versions. Production uses the minimum Tauri capability for the main window and no Tauri plugins. The asset protocol is the only enabled Tauri feature beyond core application facilities.

## Runtime lifecycle

Startup proceeds in this order:

1. Rust records process start, reads startup configuration, opens the bounded local run log, resolves an optional initial Markdown path, and decides whether tabs and primary-instance handoff are enabled.
2. When tabs are enabled, a later launch forwards its bounded document-path request to the existing primary instance and exits. When tabs are disabled, each launch is independent.
3. An initial file is canonicalised and opened as a Rust `LayoutPageDocument` before Tauri setup when possible.
4. Rust creates the main window visible and focused, applying the configured or saved maximized state during native creation.
5. Setup installs the native menu, document watcher, configuration watcher, instance listener, permitted local-asset directory, and development-only Agent API when applicable.
6. The frontend requests one `viewer_snapshot`, mounts the first bounded page, reports initial render readiness, and then requests background indexing and optional enrichment.

GNOME activation remains attached to native window creation. The production window is not hidden until frontend readiness. On normal shutdown, Rust saves only maximized state, shuts down document work, removes watcher and instance control files, resolves development automation, and records normal shutdown.

## Authoritative document and tab state

Rust `DocumentState` owns one mutex-protected `DocumentSession`. Each open tab owns:

- a stable tab ID and a revision incremented when its underlying document object is replaced;
- canonical path and display title;
- one `LayoutPageDocument` containing its source, index, page directory, and prepared-page cache;
- the last active prepared page;
- native scroll position and semantic source offset;
- stale and frozen-error state;
- a pending heading anchor; and
- current Find state.

Only the selected tab may satisfy active-viewer commands. Every such request carries the selected tab ID and revision; Rust returns or records a stale outcome when either no longer matches. Selecting, opening, reloading, or closing tabs cancels or supersedes incompatible document work.

The frontend owns the visual tab strip and retains a `PageGeometrySnapshot` per open tab revision so a selected tab can restore its page identities, measured/estimated heights, width epoch, and source anchor. No inactive tab retains a hidden DOM tree. Closing a tab removes its Rust document state and frontend geometry snapshot; if the last tab closes, the viewer returns to its empty state.

Current source, index, page-directory, prepared-HTML, and geometry limits are primarily per document. There is not yet one application-wide cache governor across all tabs.

## File source and identity

`DocumentSource` is the only ordinary raw-file reader for viewer work. Opening a document records a `SourceIdentity` consisting of length, modification time when available, and—on Unix—device and inode.

Before a bounded range read or explicit identity comparison, Rust re-stats the canonical path. A mismatch clears the range cache and rejects the read as a changed document. Reads:

- reopen the path and seek to the requested byte offset;
- are capped by the configured source-read limit;
- extend by at most three bytes when needed to finish a UTF-8 scalar;
- return UTF-8-safe source start and end offsets;
- reject invalid UTF-8 and invalid ranges; and
- enter a bounded least-recently-used range cache keyed by exact source range.

Lumen never retains a hidden full-file copy. File size does not determine frontend memory use, and the complete raw document is never sent to WebKit.

The current identity check occurs before each bounded source read. It detects path replacement and metadata-visible in-place changes; it is not a filesystem transaction or immutable file handle guarantee.

## Layout-page model

A `LayoutPage` is one source-contiguous byte range. Non-empty documents use non-empty ranges; the sole zero-length identity `0:0` represents an empty document without adding a second viewer path. A page's canonical identity is the pair `(source_start, source_end)`, serialized across the current IPC boundary as `start:end`.

The default planner admits at most 64 KiB of source input for one page. It selects a UTF-8-safe end that makes progress and prefers a usable Markdown boundary within that input. Pages are deterministic for the document revision and independent of viewport width, font metrics, theme, and measured height.

Markdown constructs can cross page boundaries. `LayoutPageContext` carries bounded continuation state for:

- fenced code marker, marker length, and information string;
- active list marker;
- block-quote prefix;
- table header and alignment; and
- a pending table header.

Continuation context is capped at 8 KiB. Oversized individual lines still make bounded progress but are not retained as unbounded context. To render a page, Rust reconstructs only the synthetic prefix/suffix needed to reopen and close supported continued constructs, renders the bounded fragment, and associates the output with the original source range. Synthetic continuation content is an internal rendering aid and does not redefine source offsets.

The canonical `LayoutPageDirectory` is source ordered, contiguous from offset zero, and capped by a byte budget. Before the directory completes, the first page and exact requested pages may exist independently. Once complete, page windows are checked against canonical page identity and continuation context.

## Indexing and metadata

`DocumentIndex` scans the source sequentially in bounded units. It builds:

- the canonical layout-page directory;
- continuation context for each layout page;
- sparse source checkpoints with Markdown fence context;
- bounded reference-definition text used for enrichment; and
- hashed heading identifiers with source offsets for anchor navigation.

Checkpoints begin at a 64 KiB stride. If checkpoint count or estimated index bytes exceed their ceilings, the index doubles the stride and thins existing checkpoints while retaining the origin. Definitions and heading metadata share the index budget; definition retention is capped and heading capture stops conservatively when metadata no longer fits.

The scanner carries at most 8 KiB of an incomplete line. An oversized line remains processable without allowing pending-line metadata to grow with file size.

Complete canonical indexing requires sequential source progress because Markdown continuation state can depend on preceding input. It occurs lazily after the first page is visible and yields between bounded scan steps. A far page request may take ownership of a compatible partial index and advance it only until the requested page is known, then return the partial index to background work.

## Markdown rendering and enrichment

Rust parses Markdown with `pulldown-cmark`. Raw HTML events are suppressed. Supported extensions are GFM, tables, strikethrough, task lists, footnotes, definition lists, superscript, subscript, YAML-style frontmatter, and plus-delimited TOML-style frontmatter. Frontmatter is not displayed.

Rendering has two stages:

1. **Structural rendering** parses the bounded reconstructed page without syntax highlighting or complete cross-page reference definitions. It is the latency-sensitive result displayed first.
2. **Enrichment** re-renders an eligible prepared page with the completed bounded definition snapshot and syntax highlighting. It is adopted only when page identity, tab revision, source identity, and definition generation still match.

Tree-sitter highlights bounded fenced HTML, CSS, JavaScript, TypeScript, C, C++, Rust, and Python. A fenced block above the 256 KiB highlighting ceiling, an unsupported language, or a highlighting failure remains escaped plain code. One structural or enriched page may produce at most 2 MiB of HTML.

Prepared pages retain structural HTML or the adopted enriched result plus source range and continuation context. The default per-document cache retains no more than three prepared pages and 4 MiB of estimated HTML, evicting oldest pages until both bounds are satisfied.

The frontend performs presentation-only adaptation after mounting trusted Rust output:

- assigns stable, duplicate-aware heading IDs;
- converts rendered task inputs into accessible read-only task markers;
- resolves approved local-asset placeholders through Tauri's asset protocol; and
- adds local code-copy controls.

These operations do not parse Markdown or create another source model.

## Document-work coordinator

One Rust `DocumentWorkCoordinator` is created lazily for the application. It owns one worker thread, a condition variable, generation counters, one replaceable pending slot per work kind, and resumable bounded work. It owns no foreground viewer DOM or tab selection.

Work kinds are:

- explicit Find navigation;
- reader-page preparation;
- Find counting;
- page enrichment; and
- background indexing.

Pending work is selected in that priority order. Resumable active work uses the same order except enrichment, which completes as one already bounded queued operation. Submitting newer work of the same kind replaces the older pending request and advances that kind's generation.

Index, page, and Find work yield after bounded source steps. Each step opens its own `DocumentSource`, validates the expected identity, performs bounded work, and drops that source before the scheduler chooses again. A newer page request may reuse the compatible partial index of an older page request or background index rather than restart from zero.

Completion delivery returns to authoritative `DocumentState`. A result is accepted only if its tab, revision, path/source identity, work generation, page range, page identity, and operation-specific generation remain current. Otherwise it is discarded or reported stale. Rust then emits a coarse completion event so the frontend can request or adopt current data.

## Rust/frontend viewer protocol

The production command surface is explicit and contains no generic filesystem or evaluation command. The main viewer exchanges:

- a session snapshot containing tab metadata, active path, first page HTML/range/identity, saved position, source length, estimated page count, and recoverable error;
- a bounded source-ordered page batch around a requested source offset;
- the completed canonical page-directory snapshot;
- requests to start background indexing, page enrichment, Find work, and heading lookup; and
- shared tab, document, link, reload, zoom, and lifecycle actions.

The frontend rejects stale asynchronous results with document, tab, input, page, geometry, and width generations as applicable. It keeps the last valid page visible while replacement work is pending. Normal UI controls and development Agent API inputs call the same shared action/state paths.

## Virtual viewport

### Normal-flow window

The viewer is a native WebKit scrolling element. The rendered article contains exactly three normal-flow regions:

1. a top spacer representing unmounted content before the window;
2. a page window containing the current one-to-three prepared layout pages; and
3. a bottom spacer representing unmounted content after the window.

The ordinary canonical window is centered around the requested page where bounds permit. The viewport does not translate a full document, intercept wheel movement to simulate scrolling, draw text to canvas, retain all pages with `content-visibility`, or implement a custom scrollbar.

The current renderer recreates the mounted page elements and their `innerHTML` when adopting a page window. `ResizeObserver` reports mounted page heights. `IntersectionObserver` performs held-scrollbar range reconciliation after replacement enters normal layout. CSS sets `overflow-anchor: none` on the scroll surface and layout-page regions because Lumen owns semantic anchor restoration.

### Provisional and canonical geometry

Before the complete page directory is available, the native scrollbar represents logical source progress. The initial logical height is the estimated page count multiplied by a 960-pixel initial page height. Source offsets map proportionally into that provisional range.

When the directory arrives, the already rendered reference page supplies an initial pixels-per-source-byte density. Lumen estimates every canonical page from its source length and scales the total estimated geometry, when necessary, below an 8 MiB virtual-document-height ceiling. This cap avoids depending on extremely large WebKit scroll extents.

Measured page heights then refine canonical geometry at the current width. Measurements are multiplied by the same virtual-height scale so measured and estimated pages remain in one coordinate system. A resize begins a new width epoch; measurements from an earlier width epoch are rejected.

### Fenwick-tree height model

The frontend `PageGeometry` is the sole canonical-height model after directory adoption. It stores:

- source-ordered page IDs;
- one positive estimated or measured height per page;
- a page-ID-to-array-index map;
- the active width epoch; and
- a Fenwick tree over the height array.

The Fenwick tree provides prefix sums and point updates without recomputing every later page position. A page's virtual top is the prefix sum of heights before it; total virtual document height is the complete prefix sum. Inverse lookup binary-searches those prefix sums to find the page containing a virtual scroll position.

When a current-width measurement changes one page, geometry applies the height delta as a Fenwick point update. Page IDs and heights can be snapshotted for tab restoration. Geometry is never a second Markdown or source-order model: Rust page ranges remain authoritative, and the frontend height model only maps those identities into WebKit scroll coordinates.

### Semantic anchors and measurement adoption

Source offsets establish reading order and durable semantic positions; pixels do not. Before committing changed measurements, the frontend captures the first mounted page intersecting the viewport and its offset from the viewport top. It applies current-width height changes and spacer updates, then computes at most one clamped scroll restoration that keeps the same page at the same viewport-relative position.

The viewport coordinator serializes this with reader input and page adoption. It tracks document generation, input generation, page generation, width epoch, viewport source anchor, pending scroll writes, in-flight requests, and measurement activity. A newer seek supersedes the previous pending seek; only one page request is in flight from the frontend coordinator.

### Native scrollbar interaction

Ordinary wheel, keyboard, programmatic, and native-scrollbar movement converts the current native scroll position to a source offset. A seek is requested only when the source anchor leaves the mounted page window or when a forced action such as Find requires it.

Pointer interaction on the scroll surface begins a native-range hold:

- the current maximum scroll range is captured;
- trusted native scroll inputs while the pointer is held are coalesced by one event-driven `requestAnimationFrame` callback;
- only the exact requested page from a returned Rust page window is mounted during the hold;
- spacer or trailing-margin adjustment absorbs late measured differences so the native thumb range does not change underneath the pointer;
- release flushes the latest pending input synchronously, ends the hold, restores ordinary measurement/window behaviour, and saves the semantic position.

The existing frame callback is narrow, one-shot, and active only for a held native pointer interaction. It is not a continuous render loop.

## Find and anchor navigation

Find is Rust-owned and incremental. The query is trimmed and capped at 4 KiB. Rust parses bounded source ranges into reader-visible text while excluding raw Markdown syntax and link destinations, retains source-offset mapping for visible characters, and supports count, next, previous, and wrap-around navigation without sending the full raw document to the frontend.

Find navigation has the highest document-work priority. The frontend requests the matching source page and draws one transient highlight only while the corresponding reader-visible text is mounted. Scrolling or page replacement recomputes or removes that highlight.

Heading links use duplicate-aware identifiers. The background index stores bounded hashed heading metadata and source offsets. If an anchor is requested before indexing completes, Rust retains the pending identifier and resolves it after the canonical index is accepted.

## File changes and failure behaviour

One blocking inotify thread watches the directories containing open documents. A private control file below `$XDG_RUNTIME_DIR/lumen` wakes the thread when the set of watched directories changes; the watcher does not poll.

`CLOSE_WRITE`, `MOVED_TO`, and `DELETE` events mark matching tabs stale and advance one bounded per-tab external-change generation. An active changed tab reloads through the ordinary document snapshot path. An inactive changed tab retains only its stale state, saved semantic anchor, and external generation, then defers reopening until selected. Reload replaces the tab's `LayoutPageDocument`, advances its revision, invalidates prior work, and rebuilds from the current file.

Watched and explicit reloads share one frontend single-flight coordinator: at most one refresh is active and one newest intent is pending. Repeated events do not form a queue. Before refresh, Lumen captures the exact semantic source offset and the mounted page's viewport-relative offset in one constant-size anchor. The previous revision remains displayed while a nonzero target page is prepared. The anchor is clamped to the new source and native ranges, survives provisional geometry, and is reapplied when the canonical page directory is adopted. Only the current tab/revision/generation may complete restoration; a redundant watcher delivery for an already adopted revision is a no-op.

After a successfully adopted external revision, Rust acknowledges the matching external-change generation and Lumen shows one tab-scoped, timer-free **Document reloaded** informational notice. It uses polite `role="status"` semantics and the shared dismissal action. Explicit-only reloads do not show it. A failed reload never shows success: the document-error path has precedence and the last valid prepared page remains visible.

If reopening or reading a previously displayed source fails, Lumen preserves the last prepared page with a recoverable notice and freezes unseen-range loading. Deletion therefore does not blank content that was already rendered. An explicit reload or later successful source restoration can replace the frozen state. If no valid page has ever been rendered, the failure is blocking.

Recoverable configuration, document, and rendering problems use persistent dismissible warning/error notices; successful watched reloads use the same notice region for one informational status. Blocking failures replace the viewer. Failures remain local and bounded; they do not trigger automatic retries, full-file recovery copies, checksums, telemetry, or crash-reporting infrastructure.

## Links, images, and content security

- Raw Markdown HTML is disabled before HTML generation.
- `http` and `https` links spawn `/usr/bin/xdg-open` and never load inside the webview.
- Same-document anchors remain in the viewer.
- Relative or absolute local links are percent-decoded, canonicalised, and accepted only when they resolve to a Markdown file; navigation uses the normal document/tab action.
- Other schemes are unsupported.
- Local PNG, JPEG, GIF, and WebP paths must be relative, resolve beneath the current document directory, and exist. Rust emits an internal placeholder rather than a direct file URL.
- On document open, Tauri's asset scope permits the document directory recursively. The frontend converts only Lumen's internal placeholder to an asset-protocol URL.
- Base64 PNG, JPEG, GIF, and WebP data URLs are accepted only below 64 KiB and only with valid constrained syntax.
- Remote images, absolute-path Markdown images, directory escapes, SVG document images, and unsupported formats resolve to an empty data URL.

The bundled frontend and all UI assets are local. The Tauri configuration currently has no CSP, so safety relies on the bundled-only frontend, raw-HTML suppression, explicit link interception, constrained image rewriting, narrow command surface, and minimum capability set. Adding dynamic web content would require a separate security architecture decision.

Individually vendored solid Heroicons are the only interface-icon source. Their notice and distributed paths are in `THIRD_PARTY_NOTICES.md`. The locally authored Lumen mark is separate: `src-tauri/icons/icon.svg` is the editable source for the packaged PNG icon, and `web/src/assets/lumen-logo.svg` is its frontend asset. Images are files, never inlined source assets.

Documents use platform system sans-serif and monospace fonts; they cannot select or bundle fonts.

## Interface and presentation

- One native window contains the viewer, Find overlay, lightweight tab strip, document bar, notice region, and link-status presentation.
- The tab strip is hidden until two documents are open. Tabs support selection, individual close, and context actions for closing other, left, or right tabs.
- The document bar displays the active canonical path as selectable text with a copy action.
- The reading column is centered and responsive. Light, dark, and system appearances use one semantic colour system.
- Task-list controls are exposed as accessible disabled presentation rather than editable browser inputs.
- Code-copy and path-copy actions use the system clipboard and do not alter document state.
- WebKitGTK's native context menu can clear a selection, so the frontend captures an intersecting range on right-click and performs one immediate event-driven restoration after the native action.
- Zoom is native webview zoom controlled through one shared Rust action and bounded zoom state.

## Configuration, state, and local logs

User configuration is versioned, strict, read-only TOML at `$XDG_CONFIG_HOME/lumen/config.toml`, falling back to `~/.config/lumen/config.toml`. Supported startup values are:

- `window.start_maximized`;
- `appearance.theme` with `system`, `light`, or `dark`; and
- `tabs.enabled`.

Unknown keys, wrong types, missing/unsupported versions, or parse errors reject the complete configuration and use defaults with a warning. Lumen never rewrites user configuration. An inotify watcher detects configuration file creation, replacement, deletion, or close-after-write and shows a restart-required notice; settings are not applied live.

Automatically maintained state is separate under `$XDG_STATE_HOME/lumen`, falling back to `~/.local/state/lumen`. Production currently writes only:

- `window-state.toml`, containing the maximized boolean; and
- bounded local run logs containing event names and timestamps, never document contents.

Development state is isolated below the `development` subdirectory. Each run log is capped at 64 KiB and at most ten logs are retained. Logging failure is non-fatal.

## Linux integration

- GTK 3 provides the native Open chooser; no dialog plugin is used.
- With tabs enabled, a bounded Unix-socket request forwards file-manager opens to the active instance and focuses it. The maximum forwarded path payload is 32 KiB.
- With tabs disabled, launches are independent and File → Open replaces the active document.
- The native menu owns Open, Close File, Reload, Find, Zoom In, Zoom Out, Actual Size, About, and Quit actions.
- The Debian package registers `.md` and `.markdown` as `text/markdown` viewer associations.
- WebKit's GPU-accelerated DMA-BUF compositor path is mandatory. Do not add software-rendering or compositor-disabling fallbacks.

## Current resource ceilings

Default viewer ceilings are hard safety/resource bounds, not performance targets:

| Resource                 |                                         Current ceiling or rule |
| ------------------------ | --------------------------------------------------------------: |
| Source range cache       |                                              1 MiB per document |
| Index metadata           |                                              1 MiB per document |
| Index checkpoints        |                                 16,384 before density reduction |
| Layout-page directory    |                                              1 MiB per document |
| Prepared HTML            |                                              4 MiB per document |
| Prepared page count      |                                                  3 per document |
| Source read unit         |                                                         512 KiB |
| Layout-page source input |                                                          64 KiB |
| Layout-page HTML output  |                                                           2 MiB |
| Continuation context     |                                                           8 KiB |
| Pending index line       |                                                           8 KiB |
| Highlighted fenced code  |                                                         256 KiB |
| Embedded image data URL  |                                                          64 KiB |
| Find query               |                                                           4 KiB |
| Instance-handoff path    |                                                          32 KiB |
| Virtual geometry height  |                                                           8 MiB |
| Document-work execution  |            One lazy worker and one latest pending slot per kind |
| Frontend page request    |                       One in flight and one newest pending seek |
| Mounted DOM              | One active one-to-three-page window; held thumb mounts one page |
| Production run log       |                                    64 KiB per run, ten retained |

Cross-tab resource ownership is described above; this table is the authority for the implemented ceilings.

## Timing mechanisms

Production readiness and correctness are normally driven by native events, Tauri completion, inotify, observer delivery, and I/O completion rather than polling.

The current narrow frontend scheduling exceptions are:

- one coalesced animation-frame callback while a native scrollbar pointer is held;
- an animation-frame callback for mounted Find-highlight drawing; and
- one zero-delay callback that restores a WebKitGTK selection after the native context menu default action.

They are event-driven and do not run continuously. Any new timer, deadline, polling loop, retry cadence, idle task, or frame scheduler requires an architectural discussion and explicit user decision before implementation. Do not disguise a required timing mechanism as another construct.

## Development boundary

The Agent API, test input guard, viewport traces, detailed observations, development banner, and automation sockets exist only in development builds and internal test tooling. Production command registration excludes development-only commands, and the production-artifact test verifies that development code and fixtures are absent.

The Agent API is local, bounded, content-safe by default, and subordinate to product performance. Normal UI and Agent API inputs converge on shared product actions and authoritative Rust/frontend state; an Agent-API-only mutation or test-only product shortcut is forbidden. `AGENT_API.md` owns the protocol and operation contract, while `TESTING.md` owns evidence, diagnostics, and performance measurement policy.
