# Architecture

## Product boundary

Lumen is a fast, lightweight, offline Markdown viewer. Launch and preview speed outrank perfect rendering fidelity. Ubuntu Linux is the active target; portability is desirable only where it does not add speculative abstractions or compatibility paths.

Lumen renders local content with local assets. Explicit `http` and `https` links open in the system browser; the application itself never performs network requests, loads remote content, or sends telemetry.

## Ownership

| Layer          | Owns                                                                                                                              | Does not own                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Rust           | Lifecycle, files, configuration/state, Markdown parsing, layout pages, indexing, search, caching, watching, native integration.   | Frontend presentation state or fine-grained DOM work.             |
| TypeScript/CSS | One-window UI, tabs, document bar, notices, Find presentation, code controls, and the framework-independent layout-page viewport. | Markdown parsing, full raw-file retention, or platform decisions. |
| Tauri/WebKit   | Native window/menu, local asset protocol, GTK/WebKit integration, and the GPU-composited browser surface.                         | Markdown-link navigation or a second application architecture.    |

The Tauri application is assembled manually. The frontend uses Vite, strict TypeScript, and local CSS without a frontend or CSS framework. Rust-to-frontend document transfer is coarse-grained and bounded.

## Document pipeline

Rust parses Markdown with raw HTML disabled. It supports GFM basics, tables, task lists, footnotes, alerts, definition lists, superscript, subscript, and hidden YAML/TOML-style frontmatter. Tree-sitter highlights bounded HTML, CSS, JavaScript, TypeScript, C, C++, Rust, and Python fences; unsupported or over-budget fences remain plain code.

Every document uses one file-backed layout-page pipeline:

1. Rust plans deterministic UTF-8-safe pages with bounded continuation context and a capped canonical directory.
2. Rust prepares bounded HTML page windows from separate file sources; it never sends the full raw document to the frontend.
3. The frontend mounts a bounded, source-ordered normal-flow window between top and bottom spacers.
4. One page-ID geometry model owns estimates, current-width measurements, prefix-sum positions, inverse lookup, and semantic reader-anchor restoration.
5. Closing a tab immediately releases its source, index, geometry, prepared HTML, and pending work.

Source offsets establish order and semantic reader locations, not pixel height. Syntax, link destinations, embedded data, wrapping, and rich layout make source length an invalid visual-height estimate. Before the page directory completes, the native scrollbar represents stable logical source progress; afterward, canonical page geometry is authoritative. Geometry changes capture one semantic anchor and permit at most one validated restoration.

While the native scrollbar thumb is held, the frontend mounts only the requested page from the prepared window. The canonical geometry and spacers preserve the native range; ordinary seeks and scrolling retain the surrounding page window. This keeps held-drag DOM work bounded without introducing another scrolling model.

The canonical directory derives one page-height density from the already rendered first page and caps virtual geometry below WebKit's scroll-height ceiling. Later measurements refine the same geometry model at the current width; no transformed document fragment or second scrolling model exists.

Structural Markdown displays first. A lazily created Rust document-work coordinator schedules exact reader-page preparation, Find, syntax/reference enrichment, and background indexing from separate bounded file sources. Its priority order is explicit Find navigation, reader-page preparation, Find counting, enrichment, then background indexing. A far reader request starts page preparation without waiting for the full index. The main thread adopts a result only when document generation, tab revision, source identity, page identity, input generation, and width state are still current, and the last valid mounted page remains visible until its replacement is ready.

Find searches reader-visible text incrementally in Rust, excluding syntax and link destinations. Its frontend highlight exists only while the matching page is mounted.

If a source disappears, rendered content remains visible with a recoverable notice and unseen-range loading stops. Lumen does not retain a hidden full-file copy.

## Links, images, and icons

- `http` and `https` links delegate to the default browser. Readable local Markdown links open in Lumen; anchors remain inside the viewer. Other schemes are unsupported.
- Local PNG, JPEG, GIF, and WebP files below the document directory use Tauri's asset protocol. Small Base64 images are accepted under a fixed limit. Remote and SVG images do not render.
- Individually vendored solid Heroicons are the only interface-icon source. Their notice and distributed paths are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The locally authored Lumen mark is separate: `src-tauri/icons/icon.svg` is the editable source for the packaged PNG icon, and `web/src/assets/lumen-logo.svg` is its frontend asset.
- Documents use platform system sans-serif and monospace fonts; they cannot select or bundle fonts.

## Interface, configuration, and state

- One native Tauri window contains lightweight tabs; the tab strip is hidden until two documents are open.
- The document bar exposes the active path as selectable text with a copy action.
- The reading column is centered and responsive. Light and dark appearances share one design and semantic colour system.
- Recoverable problems preserve the document and use persistent dismissible notices. Blocking failures replace the viewer.
- Startup-only TOML configuration is read but never rewritten. Invalid configuration falls back to defaults with a warning.
- Automatic state lives below the XDG state directory and currently stores only window maximization.
- The main window is created visible and focused. GNOME activation remains attached to native creation; normal visibility is not deferred to frontend readiness.

## Linux integration

- One inotify watcher thread blocks on document directories and a private `$XDG_RUNTIME_DIR/lumen/document-watch.signal` control file. A directory-set generation change wakes the thread to adopt the latest set; it does not poll.
- GTK 3 provides the native Open chooser; no dialog plugin is used.
- With tabs enabled, a Unix socket forwards file-manager opens to the active instance and focuses it. With tabs disabled, launches are independent and File → Open replaces the current document.
- The Debian package registers the `text/markdown` association.
- WebKit's GPU-accelerated DMA-BUF compositor path is mandatory. Do not add software-rendering or compositor-disabling fallbacks.

## Timing mechanisms

Any new timer, deadline, polling loop, retry cadence, or frame scheduler requires an architectural discussion and explicit user decision before implementation. Do not disguise a required timing mechanism as another construct. Prefer authoritative events or I/O completion whenever they can define readiness or correctness.

## Development boundary

The development-only Agent API is local, bounded, and excluded from production artifacts. Normal UI and Agent API inputs converge on shared product actions; [AGENT_API.md](AGENT_API.md) owns the protocol and implementation contract.
