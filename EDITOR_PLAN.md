# Editor and split-mode plan

Status: planning only. This document authorizes no implementation work.

## Objective

Add three modes for an open Markdown document:

- **Viewer** preserves the current rendered Markdown experience.
- **Editor** presents an editable raw Markdown surface with line numbers.
- **Split** presents the editor draft on the left and its rendered Markdown preview on the right, separated by a vertically drawn divider that the user drags horizontally.

The mode buttons must be direct, mutually exclusive controls. The editor and split view must remain responsive on large files and must not replace Lumen's bounded, Rust-owned document pipeline with a full-document frontend model.

Safety, speed, and low footprint are release-blocking product requirements, not later optimisation work. Safety is the first constraint: Lumen must never guess at a merge, silently discard local changes, corrupt known external changes, or knowingly overwrite an externally changed file. Save refuses every external change observed before commit and minimizes the final check-to-rename window, but Lumen cannot provide compare-and-swap replacement or arbitrate a simultaneous write from an uncooperative process because the supported filesystem interface provides no such guarantee. Safety means preventing silent corruption, overwrite, and loss during supported lifecycle operations within that explicit concurrency limit; it does not promise crash recovery or recovery of unsaved edits after an explicitly confirmed irreconcilable external change. Viewer-only use must pay almost no editor cost, Editor mode must not keep preview work alive, and Split mode must operate inside one shared document budget rather than doubling caches and workers.

When these goals compete, use this order: prevent silent corruption or overwrite and preserve predictable behaviour; keep the interface responsive; remain inside explicit resource ceilings; then maximise reconciliation success. External-change reconciliation is only a best-effort convenience and may conservatively reject a technically mergeable case.

This is a planning document. While it is active, enduring decisions still belong in `ARCHITECTURE.md`, testing policy belongs in `TESTING.md`, and user behaviour belongs in `README.md`. At completion, migrate accepted facts to their canonical owners and remove this file rather than retaining parallel documentation.

## Visual reference

The two supplied competitor screenshots were reviewed as inspiration only. They suggest:

- a compact group of Viewer, Editor, and Split buttons near the document controls;
- a clear selected state for the active mode;
- a monospace raw-text surface with a visually separate line-number gutter;
- a default approximately even split;
- a simple vertical separator between independently scrollable panes; and
- restrained editor chrome that leaves most space for the document.

Lumen will not copy the competitor's branding, exact icons, spacing, menus, typography, colours, syntax treatment, or pixel geometry. The screenshots are not project assets, fixtures, or acceptance-test references and will not be copied into the repository.

## Constraints established by the viewport refactor

The completed Viewer viewport refactor is the production baseline for editor work, not a provisional implementation to replace alongside the editor. Editor development must preserve these measured contracts:

- Rust's canonical Markdown layout pages currently target at most 64 KiB of source input. Automated 32, 48, and 56 KiB candidates increased tail latency, resource use, or readiness cost and were rejected. Gate 0 records the 64 KiB baseline unchanged; editor work must not combine feature development with another page-size experiment.
- The Viewer mounts one normal-flow window of one to three pages between native top and bottom spacers. Its canonical height model is the existing `PageGeometry` array and Fenwick tree, bounded by the existing virtual-height ceiling. Draft preview must feed the same layout-page viewport and geometry implementation; it must not create an editor-specific Viewer, a second height model, translated full-document surface, canvas renderer, or custom scrollbar.
- Viewer page identities are canonical source ranges, with `0:0` as the sole empty-document page. Draft preview must define equally deterministic generation-stamped logical ranges and preserve the empty-document identity without adding a special full-document frontend path.
- Durable Viewer position is an exact semantic source offset plus the mounted page's viewport-relative pixel offset. Page IDs and physical scroll pixels are not durable across edits because insertion or deletion can shift every later page range. Preview, mode, and tab restoration must stamp the constant-size semantic/relative anchor with tab revision and draft generation, clamp it to the accepted draft and native scroll ranges, and reject stale adoption.
- The Viewer keeps the last valid DOM visible while a requested page is prepared, then carries the anchor from provisional source-progress geometry into the canonical page directory. Draft preview must use the same two-stage adoption rule: never blank the pane for ordinary supersession, never claim an older generation is current, and complete only after the target page and matching canonical directory have adopted.
- The frontend viewport permits one in-flight page request and a newest-wins pending seek. Rust uses one lazy application-wide document-work worker with replaceable bounded lanes. Editor windows, draft preview, raw Find, line discovery, Save, and reconciliation must extend that coordinator and priority model; they may not add a parallel per-pane or per-tab scheduler.
- Watched and explicit reloads already share one frontend single-flight coordinator with at most one active refresh and one newest pending intent. The editor external-change barrier must be inserted ahead of this coordinator's clean adoption and external-generation acknowledgement. A dirty or input-pending tab must not acknowledge the candidate, display **Document reloaded**, or let the existing reload path replace either surface before the editor decision completes.
- A successful clean external adoption acknowledges the exact per-tab external-change generation and uses the shared timer-free notice region. Editor-specific informational, conflict, and failure notices must preserve the same semantic roles, error precedence, explicit dismissal, and fresh UI-observation sequence used by automation.
- Current tab restoration retains constant-size semantic position and bounded `PageGeometrySnapshot` state while Rust prepares the selected page; it does not retain hidden Viewer DOM. The planned “presentation capsule” is therefore an accounting name for the smallest extension of this existing prepared-page-plus-geometry-snapshot path, not a required new cache subsystem or abstraction. Gate 3 must first test the current retention mechanism with draft generations. Add a new capsule representation only if repeatable warm-tab evidence proves the existing path cannot meet the near-instant switching requirement inside its resource budget.

These constraints are release blockers. If an editor spike needs to weaken one, stop that gate, remove the spike, and revise the architecture from measured evidence before proceeding.

## Product decisions

### Modes and state

- A newly opened document starts in Viewer mode.
- Mode is tracked per tab for the life of the tab. Switching tabs restores that tab's mode, editor selection and scroll anchor, viewer anchor, and dirty state.
- Mode is not persisted across application launches in the first release.
- Switching modes never saves or discards edits.
- Editor code is loaded only when Editor or Split mode is first requested. Viewer startup must not eagerly parse, instantiate, index, or style the editing implementation beyond the three small mode controls.
- Viewer mode unmounts editor DOM and cancels editor-window work. A clean editor session releases its line index and window cache; only its small mode/anchor state remains. A dirty Rust-owned draft remains available until saved, discarded, or the tab closes.
- Editor mode unmounts preview DOM and cancels active preview preparation/enrichment for that tab. It does not keep an invisible preview current, but may retain the tab's globally budgeted last-valid presentation capsule for a later mode or tab switch.
- Split mode mounts one editor viewport and one existing Viewer viewport for the same authoritative draft generation. It must not create a duplicate document session or rendering pipeline.
- Inactive tabs retain essential lifecycle state, dirty draft pieces, small anchors, one coalesced desired-preview generation token, and—while the application-wide presentation budget permits—one bounded last-valid presentation capsule. They release mounted editor windows, hidden DOM, observers, full Viewer geometry/page caches, pinned preview snapshots, and nonessential background work.

### Mode controls

- Place a three-button mode group in the document bar: Viewer, Editor, Split.
- Use individually vendored Heroicons that match Lumen's existing icon policy. Do not add an icon package.
- Every control has a visible tooltip, an accessible name, a selected state exposed with `aria-pressed`, and a keyboard-focus indicator.
- Clicking a button uses the same shared mode action that automation and any menu/shortcut adapter use.
- Mode changes retain focus sensibly: Viewer focuses its scroll surface, Editor focuses the caret, and Split returns focus to the pane most recently used.

### Editor behaviour

- Show one-based line numbers in a non-selectable, right-aligned gutter.
- Use the platform monospace font and the existing semantic light/dark colour system.
- Use fixed-height rows and no soft wrapping for the first release. Long lines scroll horizontally. This makes line geometry deterministic and keeps large-file virtualization reliable.
- Preserve UTF-8, a leading UTF-8 BOM, CRLF/LF line endings, final-newline state, tabs, and all raw Markdown text not directly edited.
- Support ordinary insertion, deletion, bounded multiline paste, bounded cut/copy, caret movement, selection, composition/IME input, undo, and redo.
- Undo/redo is deliberately small and best-effort: all tabs share one global history budget rather than receiving a budget each. Retain at most 256 transactions and 512 KiB of journal metadata across the application, evicting the oldest inactive-tab history first.
- Undo records reference existing original or scratch ranges and must not copy deleted or inserted text into a second history buffer. Adjacent typing coalesces by input/composition boundaries, not a timer.
- A large accepted edit may become the new undo baseline and evict older history. Lumen must never duplicate clipboard text merely to make it undoable.
- `Ctrl+F` targets raw text when the editor owns focus and rendered reader-visible text when the viewer owns focus.
- Syntax colouring, Markdown formatting commands, autocomplete, folding, minimaps, multiple cursors, and soft wrapping are not part of the first release. They require separate evidence and scope decisions.

### Clipboard and browser input

- Copy, cut, and paste are best-effort bounded operations. Lumen is not required to accept or produce an abnormally large single clipboard payload; it is required to reject one predictably, leave the document and clipboard safe, notify the user, release temporary state, and remain responsive without a panic, renderer termination, or application crash.
- Gate 1 sets one explicit clipboard byte ceiling from measurements in the real production WebKit path. The evidence must include peak and released frontend heap and renderer/application RSS across every unavoidable WebKit, JavaScript, IPC, Rust, and scratch copy. Do not choose a larger limit merely because the piece model can represent the result.
- Intercept paste before WebKit's default action mutates the textarea or document. Inspect payload size before conversion to another complete string where the platform permits it. An over-limit or unavailable payload is rejected atomically with **Clipboard content exceeds Lumen's bounded edit limit. No text was inserted.** If WebKit necessarily materializes the payload first, Gate 1 must measure that allocation and lower the ceiling accordingly.
- Admit only one clipboard edit at a time. A permitted paste may use one bounded staged transaction larger than the ordinary edit batch, but the authoritative draft does not change until the complete transaction can commit. On rejection, cancellation, stale generation, or resource failure, discard the transaction and record any appended scratch range as unreachable in the existing exact accounting; do not insert a prefix. Release frontend payload references immediately after acknowledgement or rejection.
- Before copy, query the logical UTF-8 selection length without reading its text. Reject an over-limit selection without materializing it, changing the selection, or writing the clipboard. For an admitted copy, read exactly that bounded selection, write it once, then release the complete frontend string.
- Cut first passes the copy limit, writes the complete clipboard payload successfully, and only then submits the deletion transaction. An oversized or failed clipboard write never deletes text. If the file is externally invalidated between clipboard success and deletion, preserve the copied clipboard and reject the deletion through the normal stale-generation path.
- Keep logical selection anchors in Rust as UTF-8-safe offsets when selection crosses editor windows. The textarea contains only the mounted intersection. A very long line exposes only a bounded horizontal segment around the caret; logical navigation and selection remain Rust-owned, and the same clipboard ceiling applies.
- Disable spellcheck, autocorrect, autocapitalization, autocomplete, and native browser undo/redo so WebKit cannot retain or mutate hidden duplicate text. Route `historyUndo` and `historyRedo` through the Rust journal. Text drag-and-drop is excluded from the first release. Linux primary-selection and middle-click paste must use the same bounded transaction path or be disabled.
- Do not add a native editor, native clipboard-streaming service, or separate large-clipboard fallback initially. A failed Gate 1 stops for an explicit scope/dependency decision.

### Edit complexity and `SaveRequired`

- Gate 2 establishes measured application-wide soft/hard piece-metadata ceilings and a reclaimable scratch threshold. Values must include descriptors, internal nodes, allocator capacity, current and pinned roots, transaction overlays, and scratch allocation categories—not idealized payload alone.
- At the soft ceiling, first cancel/release superseded preview work, recomputable caches/indices, evictable inactive-tab undo, and other nonessential snapshots; then merge adjacent pieces and rebalance packed nodes without copying document text.
- Every edit transaction declares a bounded operation count and calculates its worst-case metadata delta before mutation. The hard ceiling permanently reserves enough capacity for one maximum legal transaction, acknowledgement/result state, lifecycle bookkeeping, and bounded rollback.
- If accepting a transaction would consume the normal hard-limit capacity, accept that triggering transaction completely using the reserve, publish its acknowledged generation, and atomically enter `SaveRequired`. Never partially apply or lose it.
- `SaveRequired` stops further ordinary insertion, deletion, paste, cut, composition mutation, redo, and formatting actions. Mode changes, scrolling, selection, bounded copy, Find, preview, Save, Discard, and lifecycle actions remain available.
- Permit Undo only when preflight proves the inverse transaction stays inside the absolute ceiling. If it reduces all triggering resources below a lower resume threshold, return to ordinary dirty editing. Redo remains disabled when it would cross the ceiling.
- Show one persistent notice: **This document has reached Lumen's edit-complexity limit. Save your changes to continue editing.** The notice is event-driven and creates no polling or timer work.
- Explicit successful Save collapses the saved draft to one file-backed range, releases superseded piece trees and scratch storage after pins close, clears undo/redo, resets accounting, and exits `SaveRequired`. Failed or cancelled Save leaves the complete accepted draft dirty and paused; it never starts compaction.
- If a Save was already active when the ceiling was reached, freeze new edits and recalculate after that generation adopts. Resume only if rebinding falls below the lower threshold; otherwise remain `SaveRequired` until the user explicitly saves the newest generation.
- An external change, unavailable target, or conflict while `SaveRequired` follows the existing fail-closed external/lifecycle rules. Lumen never writes automatically merely to regain edit capacity.

### Saving and dirty state

- Editing creates a process-local draft backed by original and unlinked scratch ranges. It does not silently write the target file on every keystroke.
- Add File → Save with `Ctrl+S`. Save captures one structurally immutable draft mapping plus its current source stamp and asynchronously streams its complete logical byte sequence to a uniquely created sibling temporary file without assembling the document in frontend memory.
- Show dirty state on the tab and expose it through accessible text, not colour alone. Mark the tab locally dirty on the first editor input before waiting for Rust acknowledgement, so an external-change event cannot race through a falsely clean state.
- Accept that a safe save may perform file-sized sequential reads/writes and temporarily consume space equal to the final file. This is an explicit trade for unrestricted Markdown editing, predictable persistence, and atomic old-or-new visibility.
- Saving runs outside the UI/main thread. Editor input, scrolling, mode changes, and draft preview remain responsive while the captured generation is serialized.
- Show event-driven `Saving…` progress from completed byte milestones. After all bytes are written, show `Finishing save…` until data, metadata, rename, and parent-directory durability complete; never equate buffered bytes with a durable save.
- A successful save verifies the written file and establishes the saved generation as the new disk baseline. The existing watcher adopts the resulting identity while the already-current preview and both pane anchors remain stable.
- If no newer editor generation exists, collapse the editor to the new file-backed source, close its scratch descriptor after pinned work releases, release superseded pieces, and clear undo/redo.
- If editing continued during the save, rebind pieces inherited from the saved generation to equivalent ranges in the new file, retain only post-snapshot scratch pieces and undo, and leave the tab dirty. Undo cannot cross the saved-generation boundary.
- External file changes follow the dedicated clean/pending decision contract below.
- Closing a dirty tab, replacing it when tabs are disabled, quitting, or closing the window must offer Save, Discard, and Cancel through one shared lifecycle action.
- No autosave, crash recovery, draft persistence, backup file, or hidden state-directory copy is included. Those behaviours require separate privacy and lifecycle decisions.

### Split behaviour

- Editor is always on the left; Viewer is always on the right.
- Default to an even split when a tab first enters Split mode.
- Implement the separator as an accessible `role="separator"` with a visible but restrained divider and a larger invisible pointer hit target.
- Pointer drag uses capture and updates CSS grid columns directly. The divider moves horizontally and is clamped so neither pane collapses below its usable minimum.
- Keyboard users can move the separator with the arrow keys and reset it to the even split.
- Retain the split ratio per tab for the tab lifetime. Do not persist it in configuration or XDG state initially.
- Each pane owns its own native scroll surface. Do not continuously couple their scrolling in the first release; scroll coupling creates high-volume work and surprising jumps.
- On entering Split mode, reveal the editor caret in the left pane and preserve the existing semantic Viewer anchor on the right. The right pane begins preparing the newest draft generation immediately.
- While a newer accepted draft is rendering, retain the last valid preview and expose concise “Updating preview” state. Never imply that an older generation is current.

### Draft-preview contract

- Viewer mode and the right Split pane render the newest Rust-accepted editor draft when one exists; otherwise they render the clean file source.
- Preview parsing remains in Rust with raw HTML disabled and all existing link, image, syntax, Find, and safety rules unchanged. Do not send the complete draft to the frontend or parse Markdown in TypeScript.
- Switching from Editor or Split to Viewer while dirty preserves the draft and renders its newest accepted generation. Viewer mode therefore acts as a full-width preview until the user returns to Editor or saves/discards.
- Use event-driven backpressure rather than a debounce timer: allow one edit transaction in flight, retain at most one newest pending transaction, and allow at most one preview generation to build. Skip superseded intermediate generations.
- Preview execution is application-wide and single-flight, but preview demand is tab-aware. Each tab may retain only its newest desired generation as a small token, not a pinned piece-tree root or queued job. The active visible Viewer or Split tab has first priority. Inactive warming may execute only when active input, scrolling, lifecycle safety, Save/reconciliation coordination, and active-tab preview/navigation need no work.
- The displayed preview is tagged with its draft generation and `SourceStamp`. It may be adopted only when tab ID, tab revision, editor generation, clean generation, target identity, watcher epoch, page identity, and width state are still current.
- Preserve the last valid preview page until its replacement is ready. While it is older than the accepted editor generation, expose “Updating preview”; a transient edit must never blank the pane or present stale content as current.
- On tab activation, mount that tab's valid retained presentation immediately, restore its semantic anchor, and promote its newest desired generation above all inactive work. A stale-but-valid capsule remains visibly marked **Updating preview** until replaced. Preempt the previous tab at the next bounded work boundary and retain its last valid presentation subject to the global budget.
- A presentation capsule is a logical retention/accounting unit and should initially be implemented by extending the current Rust prepared-page plus frontend `PageGeometrySnapshot` restoration path. It contains only its displayed generation and source stamp, mode/anchors, the bounded render result covering the last visible viewport, and the minimum geometry needed to remount it. It contains no hidden DOM, observer, complete document/page cache, editor window, worker, or pinned draft snapshot. The one active Viewer DOM mounts only the selected tab's retained presentation; no per-tab hidden Viewer tree or speculative general cache is retained.
- Gate 3 sets measured per-capsule and application-wide presentation-cache byte ceilings. Evict inactive enrichment and adjacent pages before least-recently-used capsules. Never evict the active presentation merely to warm another tab. A cold tab switch prioritizes its visible page immediately and shows a concise loading state rather than blank, incorrect, or unmarked stale content.
- Invalidate the changed layout page and all later structure whose continuation context, offsets, references, or index results may have changed. Reuse pre-edit work only when its structurally shared ranges/context are proven unchanged and every original-file range still carries the current source stamp.
- Structural Markdown for the relevant Viewer page has priority over enrichment and background reindexing. A far edit or Viewer seek must not wait for complete draft indexing.
- Saving persists the authoritative accepted draft generation whether or not preview has caught up. The self-save watcher event adopts the new clean file identity without creating a second render path or flickering back through an older disk generation.
- An unrelated external change follows the external-file contract below. It never replaces a dirty draft or its preview before the user decides.
- Viewer Find searches the rendered draft generation. Editor Find searches raw draft text. They share the same authoritative draft source but retain their distinct rendered/raw semantics.

### External file changes

Every watcher event for an open document is a candidate source change, not permission to replace editor state immediately:

1. On coordinator receipt of the watcher event, advance the document source epoch and revoke every prior source stamp before adopting any further source-derived result. Record the newest candidate disk identity and hold adoption of its bytes.
2. Cross an editor barrier that accounts for accepted Rust edits, an in-flight transaction, an unsent bounded frontend aggregate, composition text, and undo/redo in progress. If input is pending, preserve/acknowledge it before resolving the file event.
3. If the tab has no editor changes and no pending input after that barrier, automatically adopt the changed file as the new clean source.
4. A clean adoption invalidates/reloads both logical surfaces from that one source: refresh the mounted editor window and line metadata when Editor is visible, and use the existing Viewer file-change pipeline when Viewer is visible. An unmounted surface reads the new source when it is next shown.
5. Preserve the editor and Viewer semantic anchors where valid and clamp them when the changed file is shorter. Do not retain the old clean source, editor window, line index, layout pages, or work after replacement.
6. If editor changes exist or input remains pending, block Save to the original file, mark the tab externally invalidated, capture its bounded local edit operations and scratch ranges, cancel/reject work stamped with the revoked epoch, and classify whether the clean Base source remains immutable and readable.
7. If External is an atomic replacement and the pinned old inode still provides the exact Base bytes, begin one bounded conservative reconciliation. It may reapply Base → Local operations onto External only when every local edit maps uniquely to unchanged context and no mapped range overlaps an external change.
8. The attempt is atomic and all-or-nothing. It runs off the UI thread; accepted input after the captured generation remains in a bounded overlay and is rebound only after a successful result. A partial result is never visible or retained.
9. If reconciliation succeeds, atomically adopt the reconciled piece-tree root as the newest dirty draft, rebind any subsequently accepted edits, update Editor and Viewer from that generation, establish External as the new disk baseline, and re-enable Save. The reconciled document remains dirty until explicitly saved.
10. If External modified the same inode in place, the old Base bytes are no longer provably immutable. Do not copy the file, create a recovery artifact, or attempt reconciliation. Revoke the source, remove derived editor windows/pages/Find/index state, and enter the externally conflicted state immediately.
11. Ambiguity, overlap, invalid input, cancellation, or any resource/elapsed-time limit also abandons reconciliation completely and enters the conflicted state. Retain only the bounded local operations and scratch ranges until the user resolves the conflict, keep Save disabled, and do not retry automatically for the same invalidation episode.
12. A conflicted editor and preview are no longer authoritative or editable. When the source was compromised by same-inode mutation or lost watcher trust, unmount/hide their content, make the surfaces inert and unavailable to selection, clipboard, Find, or accessibility traversal, and show only the blocking conflict presentation. A Base-stable reconciliation rejection may retain its last presentation underneath the same inert blocking state. Expose one non-dismissible action: **Reload File and Discard Editor Changes**. Confirmation releases the local operations, scratch pieces, undo/redo, and invalid draft sources; adopts the newest readable disk generation; and refreshes both surfaces. No Save, Save a Copy, conflict-marker, patch-export, recovery-draft, or Keep path is offered.
13. Explain the result directly: Lumen could not safely reconcile the external change within its safety limits; pending edits cannot be saved. Exceeding a limit is an expected conservative rejection, not an application failure and not permission to increase a limit automatically.
14. Coalesce repeated watcher events into the newest candidate identity under one aggregate attempt budget for the invalidation episode. A newer candidate invalidates an older result; it does not reset the budgets or grow a queue.
15. Lumen's own verified atomic replacement bypasses external reconciliation because the save coordinator owns its expected identity transition, but it still travels through watcher reconciliation.

Reconcile and Reload-and-Discard are shared product actions used by normal UI and Agent API adapters. An inactive dirty tab is marked immediately; bounded reconciliation may proceed without mounting either surface, and any conflict notification is presented when the tab is selected. Closing or quitting with a conflicted tab may either cancel the close or confirm Reload-and-Discard before continuing; it may never silently release pending operations.

Because inotify reports after mutation, Lumen cannot guarantee that changed same-inode bytes were never displayed briefly before event processing. It guarantees that once the event or trust loss is observed, results from the revoked epoch are not authoritative, selectable, savable, or adoptable.

## Resource invariants and initial ceilings

These are hard architectural ceilings for the first implementation. Measurements may justify lowering them. Raising one requires an explicit plan revision with evidence; an implementation must not silently replace a bound with proportional allocation.

| Resource                 | Initial ceiling or rule                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor DOM               | At most 300 mounted logical rows and 256 KiB of mounted raw text per editor pane.                                                                                                                                                          |
| Editor window IPC        | At most 256 KiB per ordinary response; exceptional long lines use a bounded caret/visible-column segment, not the whole line.                                                                                                              |
| Edit IPC                 | One transaction in flight per active tab and at most 256 KiB per ordinary batch; no unbounded whole-document transaction.                                                                                                                  |
| Clipboard operation      | One active operation; Gate 1 sets a measured byte and transient-memory ceiling across WebKit, JavaScript, IPC, Rust, and scratch staging.                                                                                                  |
| Frontend pending edits   | At most one bounded unsent aggregate; apply backpressure before accepting another aggregate.                                                                                                                                               |
| Undo/redo                | One application-wide pool: 256 transactions and 512 KiB of metadata; text is referenced, never duplicated.                                                                                                                                 |
| Piece metadata           | Gate 2 sets explicit application-wide soft/hard byte ceilings covering descriptors, nodes, allocator capacity, overlays, and pinned roots.                                                                                                 |
| Transaction reserve      | The hard ceiling includes capacity for one maximum legal transaction, acknowledgement, lifecycle bookkeeping, and bounded rollback.                                                                                                        |
| Scratch accounting       | Track allocated, draft-live, undo-live, and unreachable bytes globally; Gate 2 sets a reclaimable/dead-byte SaveRequired threshold.                                                                                                        |
| Line index               | One compact count record per 64 KiB source/scratch block plus bounded prefix metadata; never one heap object per source line. This matching size simplifies accounting but does not make editor blocks identical to Markdown layout pages. |
| Viewer/editor caches     | One document-wide resource governor divided between active panes; Split mode receives no second full budget.                                                                                                                               |
| Preview execution        | One application-wide build; each tab retains only one coalesced desired-generation token, never a queued job or pinned requested root.                                                                                                     |
| Preview snapshot         | Only the executing build pins one structurally immutable root; release it immediately after output, cancellation, rejection, or failure.                                                                                                   |
| Presentation capsules    | Gate 3 sets measured per-capsule and fixed application-wide byte ceilings; retention is LRU and contains no hidden DOM or pinned root.                                                                                                     |
| Source read validation   | Ordinary derived work validates at most 1 MiB per unit; sequential Save checks epoch each ≤1 MiB chunk and identity each ≤16 MiB.                                                                                                          |
| Background execution     | Reuse the single document-work coordinator; no thread, interval, observer, or polling loop per tab or pane.                                                                                                                                |
| Save execution           | One application-wide asynchronous save worker, one active save, and one coalesced newest queued generation.                                                                                                                                |
| Save memory              | One fixed streaming buffer no larger than 1 MiB plus bounded metadata; never a full-file buffer.                                                                                                                                           |
| Save temporary storage   | At most one sibling temporary artifact, whose logical size may equal the final document; remove it on failure/cancellation.                                                                                                                |
| Save progress            | At most 100 byte-milestone events per save and no timer/polling progress loop.                                                                                                                                                             |
| Save commit              | One preallocated commit token/state; Committing performs only the final check and immediate rename.                                                                                                                                        |
| Retry Verification       | One user-triggered single-flight attempt, no queue/timer or document read, and at most 64 KiB transient state.                                                                                                                             |
| Reconciliation execution | At most one application-wide attempt; repeated candidates coalesce under one invalidation-episode budget.                                                                                                                                  |
| Reconciliation memory    | At most 4 MiB transient working memory and 1 MiB application-wide retained context metadata; never flatten a generation.                                                                                                                   |
| Reconciliation work      | At most 4,096 local change spans and 64 MiB of candidate bytes examined across an invalidation episode.                                                                                                                                    |
| Reconciliation time      | At most two seconds elapsed per invalidation episode, checked between bounded work units without a polling loop.                                                                                                                           |
| Clean inactive tab       | No editor index/window, hidden DOM, worker, or full Viewer cache; retain identity, anchors, one desired-generation token, and a budgeted capsule.                                                                                          |
| Production dependencies  | No editor dependency or plugin by default.                                                                                                                                                                                                 |

The 256 KiB text limits bound ordinary transfers and mounted text, not total document size. Save streams through bounded chunks. Clipboard operations follow the separate Gate-1 ceiling and may be rejected before mutation; Lumen makes no arbitrary-size clipboard guarantee. Long-line display and navigation use bounded segments with cancellation and generation checks.

The source-validation byte ceilings are initial proof values, not permission to read that much unnecessarily. Validate identity before and after every ordinary bounded source-read unit and check its stamp again at adoption. Long sequential Save work checks the epoch between chunks no larger than 1 MiB and performs full identity validation before streaming, after each 16 MiB at most, at every source transition, after streaming, and during the final commit check. Any mismatch revokes the operation and discards its output.

Unsaved inserted text is irreducible user data, but it must not inflate the Rust heap or exist in multiple forms. Store inserted chunks once in a private, mode-`0600`, file-backed scratch source created under the private XDG runtime area and immediately unlink its directory entry after opening on Ubuntu. The open file descriptor then owns its lifetime and the OS reclaims it on normal exit or process failure. Do not memory-map it, persist it for recovery, expose its path, or include its content in state, logs, diagnostics, or tests. Small transient command strings must be released after their bytes are appended.

Original unmodified text remains referenced from generation-validated ranges in the original file; those ranges are not intrinsically immutable against same-inode writers. A draft therefore consists primarily of compact ranges into the stamped original source and the unlinked scratch source. Piece descriptors use packed leaves, compact fixed-size fields unless the proof justifies a smaller encoding, bounded-depth balanced nodes, aggregate byte/newline counts, and no duplicated line-index or undo payload. Merge adjacent compatible ranges and remove empty pieces after each accepted transaction.

The scratch source is append-only until a successful Save or draft discard. Account separately for bytes reachable from the current draft, retained only by undo/redo, and unreachable garbage. Live inserted bytes are irreducible user data, but cumulative unreachable scratch growth is not; reaching the Gate-2 threshold enters `SaveRequired` instead of copying the draft into another scratch file.

No automatic full-document or regional text-copy compaction is included. Piece/scratch limits may be reset only by explicit successful Save, discard, or closing the draft. Gate 2 may evaluate regional compaction as a discarded spike, but retaining it requires a separate architecture decision proving that its hidden I/O, scratch growth, ancestry loss, and complexity outperform `SaveRequired` without weakening Lumen's goals.

### Hot-path rules

- The synchronous typing path may update only the bounded textarea/window model, selection state, and one pending transaction. It must not read a file, parse Markdown, scan an unloaded line, await IPC, measure layout, or rebuild line/preview geometry.
- Scratch appends, piece mutation, preview parsing, line discovery, reconciliation, and save run off the UI/main thread through the existing bounded work architecture. Source revocation and lifecycle safety take precedence; active input acknowledgement then outranks active-tab visible preview/navigation, Save and reconciliation coordination, inactive-tab warming, and background indexing/enrichment. A lower-priority task yields or cancels at its next bounded work boundary rather than blocking a higher-priority request.
- Source identity checks and bounded reads run off the UI/main thread. Once a watcher event reaches the coordinator, epoch revocation precedes adoption of any further source-derived completion regardless of its ordinary work priority.
- Editor scrolling performs constant-time geometry lookup and mounts one bounded replacement window only after crossing its overscan boundary. It must not perform per-scroll IPC, line-index rebuilding, or DOM-wide measurement.
- Divider dragging updates one CSS custom property from captured pointer coordinates. It performs no Rust IPC, document work, pane reconstruction, or forced layout read during the drag; commit the final ratio when the interaction ends.
- Line-number updates reuse the returned first-line number and mounted row sequence. They must not count from the beginning of the document in the frontend.
- Preview work is generation- and source-stamp-cancellable. Work for a merely superseded or deprioritized tab may finish only its current bounded unit and cannot then be adopted, extended, enriched, or cached unless it is still the newest eligible result. Work whose source epoch is revoked must return `SourceRevoked` or be discarded without adoption, presentation retention, enrichment, caching, or follow-on work.
- Reconciliation checks its aggregate byte, span, memory, and elapsed-time ceilings between bounded work units. It has no timer callback, polling loop, speculative retry, or recurring idle task; crossing any ceiling cancels the candidate and produces the ordinary conflicted state.
- Save progress is derived from bounded byte milestones, not a timer. It may not add a polling loop, animation, or recurring idle task.
- When no input, scroll, resize, file-watch, or requested background operation is active, Editor and Split modes consume no recurring CPU time.

## Architecture

### Authoritative edit model

Add one optional edit session to each Rust `OpenDocument`. The session is the only authoritative draft and contains:

- the clean source identity and clean generation;
- a monotonically increasing draft generation;
- a file-backed segmented text model whose pieces reference generation-validated original-file ranges or immutable ranges in one Lumen-owned unlinked scratch source;
- bounded newline/block metadata for locating editor windows and line numbers;
- selection and editor anchors expressed as UTF-8-safe logical offsets;
- dirty, `SaveRequired`, saving, reconciling, and externally conflicted state;
- the newest candidate external identity;
- bounded reconciliation context/counters and an optional captured local-operation generation;
- an optional immutable saving generation and coalesced newest save request; and
- a bounded undo/redo journal of inverse edit transactions.

The target heap shape is bounded indices, packed piece metadata, active windows, globally budgeted presentation capsules, and small in-flight transactions—not original file size, total inserted bytes, or open-tab count multiplied by a full Viewer cache. All current/pinned roots, overlays, internal-node/allocator overhead, presentation bytes, and scratch allocation categories participate in exact global accounting. Pathological fragmentation or reclaimable scratch growth enters `SaveRequired`; it never triggers hidden document serialization.

Define a structurally immutable read-snapshot abstraction over original/scratch piece ranges. Bounded editor windows, editor Find, streaming save, and the existing Markdown layout-page pipeline consume that same logical draft without flattening or copying it. Structural immutability fixes piece ordering and scratch bytes; it does not make an externally writable original inode immutable. Clean documents use the existing file source through the same narrow read interface.

Snapshotting clones only a small structurally shared piece-tree root and generation metadata. It never copies text, opens another source, or duplicates line/layout caches. Only the one executing application-wide preview build may pin a root. A tab's desired request stores identifiers and its newest generation only; the scheduler acquires and validates the root when execution begins, and releases it immediately when the bounded result is produced, cancelled, rejected, or failed.

### Generation-validated source reads

All production consumers of original-file bytes use one Rust-owned `ValidatedSource` boundary. Direct reads from an `OpenDocument` file descriptor outside this boundary are forbidden. Lumen-owned unlinked scratch ranges remain immutable for their descriptor lifetime, but every original-file read carries a `SourceStamp` containing tab ID/revision, clean generation, source role, expected descriptor identity, applicable path-bound target identity, and trusted watcher epoch.

Each bounded read follows one protocol:

1. Require `Trusted(epoch)`, compare the opened source descriptor with its expected identity, and—when the source role remains bound to the pathname—compare the path target with the stamp immediately before reading.
2. Read no more than the applicable bounded work unit through the shared source abstraction.
3. Compare identity and watcher epoch immediately after the read; return typed `SourceRevoked` rather than content on any mismatch or I/O uncertainty.
4. Tag the result with the exact stamp. The coordinator validates tab/revision, clean generation, identity, and epoch again immediately before adoption.
5. If adoption fails, release the result without mounting, indexing, caching, enriching, serializing, or scheduling follow-on work.

The protocol applies uniformly to editor windows, line discovery, raw Find, Markdown page/context parsing, preview enrichment, image/link source decisions derived from Markdown, Save, and reconciliation reads. A consumer may not weaken the checks because its output is “only” visual or temporary.

A revoked live-source stamp is never reusable. After a proven atomic replacement, reconciliation may mint a separate bounded read-only Base stamp for the detached old descriptor and a new External stamp for the candidate pathname. Base reads validate the descriptor's complete captured metadata before/after every unit and can be used only for comparison/mapping—not mounted or adopted as current content. Any same-inode/hard-link mutation, identity drift, or uncertainty revokes Base eligibility and rejects reconciliation.

When the coordinator receives a watcher candidate or trust failure, it revokes the prior epoch before processing further source-derived completions. Cancel pending work, reject queued results, invalidate caches and mounted surfaces stamped with that epoch, and prevent follow-on work. Work already adopted before event delivery may have briefly reflected changed bytes; revocation removes its authority rather than pretending that the display never occurred.

Do not add a full base copy, reflink requirement, memory map, content hashing pass, advisory lock, or file lease for this risk. They either fail to make arbitrary writers cooperative or impose storage, CPU, I/O, compatibility, or blocking costs contrary to Lumen's goals. Gate 5 may revise this only through an explicit architecture decision supported by automated evidence.

### Line discovery and editor windows

Use a compact 64 KiB block newline index rather than a dense offset or heap object for every line:

1. Read and count the opening blocks needed for first paint.
2. Return a bounded editor window containing complete UTF-8 lines, its source/draft range, first line number, total-known progress, and generation.
3. Continue newline discovery as low-priority document work.
4. Before discovery completes, represent scrollbar progress with stable logical source progress, as the viewer does.
5. After discovery completes, use total line count and fixed row height for canonical editor geometry.
6. Apply edit deltas to affected block counts and prefix totals without rescanning unrelated content.

The frontend mounts visible lines plus a small fixed overscan between top and bottom spacers, subject to the global ceilings above. Very long logical lines require horizontal text-window virtualization around the caret and visible columns; they may not bypass the byte ceiling.

### Editing surface proof gate

The preferred implementation is a locally authored bounded editing island based on a native `<textarea>` for the active window, paired with a virtual line-number gutter and outer logical scroll surface. Before product integration, build an automated development-only proof that demonstrates:

- accurate UTF-8 edit ranges for `beforeinput`, `input`, and composition events;
- stable caret and selection while a window is replaced above or below it;
- ordinary multiline paste, cut/copy, undo/redo, and selection that crosses a window boundary;
- copy, cut, and paste below, at, and above the candidate clipboard ceiling, including atomic rejection, safe cut ordering, clipboard-write failure, released complete strings, and no document mutation on failure;
- suppression of browser-native undo/redo and hidden text services, plus bounded or disabled Linux primary-selection, middle-click paste, and text drag-and-drop behaviour;
- correct vertical and horizontal scrolling without DOM growth;
- no lost or duplicated operation under edit-acknowledgement backpressure;
- bounded navigation, selection, and clipboard rejection for one line larger than the editor-window byte ceiling;
- bounded frontend heap and renderer/application RSS during and after Unicode, IME, long-line, cross-window, and over-limit clipboard cases, with no renderer or application crash; and
- no eager editor module, worker, line index, or DOM allocation during Viewer-only startup.

If this proof fails, remove it and stop for an explicit architecture/dependency decision. Do not ship a partial editor or keep two editor implementations. Any proposed editor dependency must first receive the dependency comparison and explicit user approval required by `AGENTS.md`; a dependency that retains the complete raw file in the frontend does not satisfy this plan.

### Edit transactions

All normal UI and Agent API editing must converge on one shared Rust action. A transaction includes:

- tab ID and tab revision;
- base draft generation;
- one or more ordered, non-overlapping UTF-8 range replacements;
- replacement text under an explicit per-transaction bound; and
- resulting caret/selection anchors.

The operation count is explicitly bounded so one transaction's worst-case descriptor/node growth fits the emergency reserve. Before mutation, Rust validates boundaries/generation and projects piece, node, allocator, overlay, undo, and scratch-accounting deltas. It appends new bytes once to the scratch source, applies the transaction atomically, records range-based inverse metadata if the global journal has capacity, coalesces/rebalances locally without copying text, and returns the accepted generation and bounded replacement window. If the transaction consumes normal hard-limit capacity, the same acknowledgement enters `SaveRequired`. Stale or over-absolute-reserve transactions are rejected without mutation and reconciled from the authoritative editor window; they are never partially applied or replayed against an unknown generation.

When a Viewer pane exists, an accepted transaction replaces the pending preview request with a structurally immutable root for that generation. `SaveRequired` does not suppress preview of the triggering transaction.

A paste admitted under the Gate-1 clipboard ceiling but larger than the ordinary batch may use one bounded staged transaction through the same product action and state model. Rust must preflight the complete operation and reserve before draft mutation; a failed transaction exposes no prefix, and any scratch append is rolled back logically through exact unreachable-byte accounting. It must not allocate a second complete string in Rust or retain a frontend copy after acknowledgement. Over-limit paste is rejected before mutation, and no arbitrary-size whole-document edit operation or test-only mutation route is permitted in the first release.

### External reconciliation

Reconciliation is a Rust-owned, dependency-free, conservative rebase of bounded local operations. It is not a general-purpose diff, merge, recovery, or export engine. It is eligible only when the pinned clean Base source remains provably byte-stable after External appears, as with atomic pathname replacement. The old Base inode, captured local operations/scratch ranges, and newly opened External source remain distinct until the complete result has been validated.

Derive Base → Local change spans from original/scratch piece ancestry rather than constructing full texts or retaining a second edit log. Retain only the bounded source context needed to relocate those spans. For each span:

1. Check its expected External position after already-proven earlier mappings.
2. If necessary, search only inside the remaining bounded candidate-byte allowance for its before/after context.
3. Accept a mapping only when its context is unchanged, its location is unique, it lands on UTF-8 boundaries, and it cannot overlap another local mapping or externally changed source.
4. Build the candidate as structurally shared External ranges plus the existing Local scratch ranges; never copy unchanged External text or flatten any generation.
5. Validate every mapped span, output ordering, source identity, candidate generation, and resource counter before one atomic root adoption.

Repeated text, overlapping changes, missing context, invalid UTF-8, source disappearance, another external generation, non-unique placement, or any exceeded ceiling rejects the entire attempt. Do not fall back to an unbounded diff, conflict-marker insertion, guessed offsets, partial merge, export path, or automatically raised limit. A rejected attempt retains no candidate pieces or caches.

Treat any same-inode external modification as destruction of the immutable Base premise. Once detected, do not read original-range pieces as though they still describe the former draft, and do not attempt to reconstruct that draft by copying the changed source. Retain inserted bytes once in scratch plus the bounded operation/range/context metadata already required for reconciliation, but make no promise that the former complete Local document remains reconstructible, reviewable, copyable, or savable.

Edits accepted after the captured Local generation use the same origin-mapping mechanism as edits made during Save. A successful reconciliation rebinds them only when their ancestry and ranges remain provably valid; otherwise the result is rejected. Save stays disabled from the first dirty external candidate until the reconciled generation and new disk baseline have both been adopted.

The conflicted state is terminal for those pending edits. Retain their bounded operation metadata and scratch ranges only so lifecycle handling cannot silently discard them; expose no action that serializes or reapplies them. Explicit Reload-and-Discard is the sole resolution that allows the tab to continue with the newest disk source.

### Save implementation

Save must be a Rust-owned streaming operation:

1. Capture draft generation `G`, its logical byte length, structurally immutable piece-tree root, and current `SourceStamp`. Save always means exactly the changes accepted through `G`, provided that stamp remains valid.
2. Compare the target identity tuple, clean generation, and trusted watcher epoch with the session baseline; refuse any mismatch, unresolved external invalidation, or untrusted watcher.
3. Create one unique sibling temporary file on the same filesystem with restrictive initial permissions. Never place it in `/tmp` or the XDG state/runtime directories.
4. Stream `G` in logical order from original and scratch ranges through one fixed buffer. Between chunks, check cancellation and watcher epoch; perform full source-identity validation at the declared byte/source boundaries. Any revocation discards the serialized output. Emit bounded byte-milestone progress without delaying or blocking editor input.
5. Preserve applicable mode, ownership, ACL, extended attributes, and line/BOM bytes. Resolve symlink targets deliberately rather than replacing a symlink path; define and test hard-link behavior before enabling Save for multiply linked targets.
6. Flush the temporary file's data and metadata. Enter `ReadyToCommit`, then recheck the complete target identity, trusted watcher epoch, and unresolved candidates; an external change aborts the save, removes the temporary artifact, and blocks another Save. Attempt bounded reconciliation only if the pinned pre-save source remains a provably immutable Base; otherwise enter the terminal conflict state.
7. Enter `Committing` and atomically rename the temporary file over the resolved target as the immediate next operation. Until rename succeeds, the original pathname must continue to expose the complete old file.
8. Enter `Verifying`: reopen and verify the saved source, flush the parent directory, establish `G` as the new disk baseline, and classify only the exact commit-token watcher event as Lumen's own save without replacing the already-current draft preview.
9. Cancel or reject outstanding snapshots older than `G`, reissue still-needed work against the equivalent saved-file source, and retag already-rendered `G` preview pages with the clean identity without rerendering unchanged HTML.
10. If `G` is still the current editor generation, replace its pieces with one saved-file range, preserve anchors, close the scratch source after its last pin releases, clear undo/redo, reset piece/scratch accounting, exit `SaveRequired`, and mark the tab clean.
11. If newer edits exist, rebind every surviving `G`-origin piece to its equivalent logical range in the saved file, retain only post-`G` scratch pieces and undo metadata, preserve the newest preview, recalculate all accounting, and keep the tab dirty. Exit `SaveRequired` only below its lower resume threshold; otherwise keep editing paused. Pieces must carry enough origin mapping to do this without replaying or flattening text.
12. Remove the temporary artifact on cancellation or every pre-commit failure and retain the complete draft. Never report success until replacement, verification, source adoption, and directory durability all succeed.

Only one application-wide save may stream at once. `Ctrl+S` during an active save records at most one newest requested generation; repeated requests replace that queued generation. After the active save adopts, begin the queued save only if it is still dirty and current. This bounds threads, temporary artifacts, descriptors, and concurrent disk bandwidth.

Create the save worker lazily for active/queued work and terminate it after the queue drains; do not retain an idle save thread, open temporary descriptor, or progress listener.

Cancellation is available only during streaming/flushing before the commit phase. Cancelling removes the temporary file, leaves the original and draft unchanged, and returns to dirty state. Closing or quitting during a cancellable save offers Wait or Cancel Save before the ordinary dirty-close decision; during atomic commit it waits for the bounded commit phase.

Read-only files, unavailable parent directories, insufficient space, permission/metadata failures, symlinks, hard links, cancellation, process failure, and replacement failures need focused policy tests before the save path is accepted. A stale named temporary artifact is never authoritative; detect and remove only positively identified Lumen-owned artifacts on a later launch without treating them as draft recovery.

### Concurrent-writer save guarantee

POSIX rename is atomic old-or-new pathname replacement, not conditional compare-and-swap. Lumen therefore guarantees detection and refusal of external changes it observes before commit; it does not claim that it can prevent an arbitrary writer from changing the target in the unavoidable interval between the last identity check and rename.

The expected target identity is one explicit tuple captured from non-symlink-following Linux metadata: resolved parent device/inode, target device/inode, regular-file type, byte length, nanosecond modification time, and nanosecond change time. Pair it with the document's clean generation and watcher epoch. This is an efficient change detector, not a content-equality proof; metadata-preserving writes and the final race remain part of the disclosed concurrency limit. Gate 5 must prove the exact system calls and supported-filesystem behavior before this tuple becomes enduring architecture.

Watcher trust is stateful: `Trusted(epoch)` or `Untrusted(reason)`. Queue overflow, watch invalidation/removal, watcher-thread or coordinator failure, an unexplained directory-set generation discontinuity, or an event that cannot be associated with the watched target makes it untrusted before any affected result is adopted. While untrusted, Save and self-save event bypass are disabled. A clean tab may rebuild its watch and adopt a freshly opened/validated source through one bounded revalidation action. A dirty tab cannot prove that its Base survived the gap and therefore enters terminal external-conflict handling; restoring the watch does not make that draft savable again.

The Save coordinator owns these explicit states:

| State           | Contract and allowed actions                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Preparing`     | Snapshot, stream, copy metadata, flush the temporary file, and prepare commit inputs. Save is cancellable; the original pathname is untouched.                                          |
| `ReadyToCommit` | All rename operands, directory handles, identity values, watcher epoch, and completion storage are preallocated. Perform the final checks; mismatch returns to dirty/external handling. |
| `Committing`    | Non-cancellable interval from the successful final check through rename. No allocation, path resolution, callback, IPC, wait, or unrelated syscall is permitted.                        |
| `Verifying`     | Rename succeeded; reopen/identify the pathname, flush the parent directory, and reconcile the scoped watcher event. Editing may continue on a newer generation, but another Save waits. |
| `Committed`     | Verification, file/directory durability, source adoption, and watcher reconciliation succeeded. Only now report Save success.                                                           |
| `Indeterminate` | Rename may have changed the pathname, but ownership or durability could not be established. Freeze the affected tab, retain available local state, disable Save, and never roll back.   |

A temporary-file flush or metadata failure in `Preparing`/`ReadyToCommit` is pre-commit: remove the artifact best-effort, leave the pathname unchanged, and remain dirty. Rename failure is also pre-commit when the kernel reports that replacement did not occur. After rename succeeds, reopen failure, unexpected ownership, target verification failure, or parent-directory flush failure enters `Indeterminate`; it must never be reported as either a clean success or a safe pre-commit failure.

Minimize that interval with one Rust-owned commit path:

1. Open and retain a handle to the resolved parent directory; create and address the sibling temporary file relative to that handle rather than repeatedly resolving the pathname. Before `ReadyToCommit`, re-resolve the displayed parent path and require it still identifies that pinned directory.
2. Capture the expected target identity and watcher epoch at Save start. Complete streaming, metadata copying, temporary-file flushing, cancellation decisions, result storage, rename operands, and every other fallible, allocating, or blocking preparation before the final target check.
3. Immediately before commit, inspect the target relative to the pinned directory without following a newly substituted symlink. Abort if its type or expected identity changed, any watcher candidate is unresolved, or watcher reliability was lost.
4. After the successful final check, perform no wait, allocation, metadata work, callback, IPC, or unrelated filesystem operation before the atomic rename. The rename itself is the only next operation.
5. Reopen and verify the committed target, flush the parent directory, reconcile only the exactly scoped expected watcher event, and report success only after source adoption and all durability steps complete.

Each Save creates a preallocated commit token containing tab ID/revision, draft generation `G`, expected watcher epoch, parent identity, expected old target identity, and temporary/new inode identity. A watcher event may bypass external-change handling only for that exact tab and matching transition while the token is active. Another tab, alias, hard link, Lumen process, unexpected event, or event arriving after token retirement is external; process-wide “Lumen wrote this path” classification is forbidden.

An observed mismatch always removes the temporary artifact and returns to external-change handling. A post-commit observation suggesting a simultaneous writer enters the indeterminate state; Lumen must not attempt an automatic rollback that could overwrite a newer generation.

Every anticipated race and filesystem error is an ordinary typed outcome. Missing or replaced paths, changed types or identities, reordered/coalesced watcher events, failed reopen/stat/rename/flush, and uncertain post-commit ownership must never panic, abort, poison shared state, terminate the worker without a completion result, or close the application. Keep unrelated tabs and Viewer actions usable while the affected tab is frozen with Save disabled.

Resolve a detected post-commit race as follows:

- If the pathname provably refers to Lumen's committed inode, report that Save committed but a concurrent external write may have been overwritten. Do not claim an error-free Save; require acknowledgement and a fresh reload/adoption before editing or saving resumes.
- If the pathname refers to another inode, report that another writer replaced Lumen's result and enter normal external-change handling with the retained local generation.
- If ownership or durability cannot be established, remain indeterminate, retain the local state, and offer an explicit **Retry Verification** action. One activation may perform at most one parent-identity check, one non-following target open/stat, one expected-inode comparison, and—only when that inode matches—one file flush and one parent-directory flush. It reads no document content, allocates at most 64 KiB of transient state, queues no second attempt, disables itself while active, and never retries on a timer. Repeated user activations remain individually bounded and cannot enable Save until verification completes.
- Closing from an indeterminate state may be cancelled. A separately confirmed discard-and-close path may release local state without pretending verification or Save succeeded.

The user-facing notice must state that the file changed concurrently, Lumen cannot determine a safe combined result, and further saving is disabled. Cleanup is best effort and bounded; failure to remove a temporary artifact is reported without treating that artifact as authoritative or terminating the process.

Automated evidence can prove state transitions, syscall ordering, refusal, bounded retries, and graceful survival; it cannot prove the absence of the disclosed check-to-rename race. The eventual production README must state that Lumen cannot safely arbitrate simultaneous saves by uncooperative applications and that users should avoid editing the same file concurrently when loss would be unacceptable.

Advisory locks are not a correctness mechanism because other applications may ignore them and filesystem support varies. Do not add locking to the initial implementation. Gate 5 may retain a courtesy lock only if automated evidence shows material collision reduction without blocking, deadlock, compatibility, launch, or footprint cost; the documented residual race remains either way.

### Frontend composition

Refactor the current single viewer composition into small mode-aware controllers:

- a document-mode controller owns Viewer/Editor/Split transitions;
- the existing layout-page viewport remains the only Viewer/preview implementation;
- that single mounted Viewer DOM adopts a tab's bounded presentation capsule on activation; inactive tabs never retain hidden Viewer trees;
- a new editor viewport owns line-window DOM, gutter, selection, and editor scroll geometry;
- a split controller owns only pane composition and separator ratio; and
- shared document actions own mode changes, edit transactions, save, dirty-close decisions, and conflict resolution.

Do not duplicate the current `main.ts` document lifecycle inside a second entry point. Extract only boundaries required by the feature, and delete superseded paths in the same change.

Keep the mode controls and mode dispatcher in the startup bundle, but load editor viewport/input modules through one Vite dynamic import on first Editor/Split activation. Editor CSS must be scoped in that lazy module or kept small enough that evidence proves no Viewer launch/render cost. Do not introduce a framework, worker bundle, syntax grammar, or general-purpose editor substrate.

### IPC and capability boundary

- Keep IPC coarse-grained: bounded editor-window reads, batched edit transactions, explicit save/lifecycle actions, and bounded draft preview windows.
- Set explicit byte, operation, and window limits on every editor command and response.
- Continue using no Tauri plugin unless a concrete gap is proven and separately approved.
- Reuse the existing GTK dependency for unavoidable Ubuntu-native integration only after comparing it with a smaller browser/local implementation.
- Keep draft text and selected text out of logs, diagnostics, completion receipts, tab observations, and error strings.
- Production capabilities remain minimal; development Agent API additions stay local-only and absent from release artifacts.
- Reuse the existing document-work worker and its priority lanes. Do not create one worker, file handle set, ResizeObserver, or scheduler per pane. One active editor scroll listener and the existing active viewer observers are the maximum in Split mode.

## Failure and lifecycle rules

- Invalid UTF-8 remains a blocking open error; editing must not introduce replacement characters silently.
- A rejected edit preserves the last acknowledged draft and restores the corresponding bounded editor window.
- An unavailable, failed, or over-limit clipboard operation is an expected typed rejection. Cancel browser default mutation, restore the acknowledged editor window if necessary, show the bounded-limit or clipboard-failure notice, release its transient state, and keep the editor and unrelated tabs operational.
- `SourceRevoked` is an expected typed result, not an error containing document content. It cancels adoption and routes the affected tab through clean reload or dirty conflict handling without panic, stale fallback, or direct reread.
- A draft preview failure leaves the editor usable and the last valid preview visible with a recoverable notice and explicit stale/updating state.
- A presentation capsule is displayable only while its complete `SourceStamp` remains valid. Source revocation, watcher-trust loss, or compromised identity discards it before tab activation and shows the defined loading or conflict state; instant switching never justifies displaying unsafe cached content.
- A missing or evicted presentation capsule is a normal cold-tab condition. Activate the tab, restore its anchors, prioritize its visible page, and show a concise loading state without spawning another worker or falling back to content from a different generation.
- A pre-commit save failure retains dirty state and the complete in-process draft while leaving the original pathname unchanged.
- A failure after atomic rename enters an explicit indeterminate-durability state: identify whether the pathname references the committed inode, retain the draft, disable another blind Save, and resolve verification before reporting success or allowing further replacement.
- Every expected I/O, watcher, identity, concurrency, cancellation, metadata, cleanup, and verification failure returns a typed lifecycle result and leaves the process, window, unrelated tabs, and shared coordinator operational. No such condition may reach a panic, assertion, abort, unhandled rejected promise, poisoned shared-state failure, or forced application exit.
- Unexpected worker termination is converted at its ownership boundary into a bounded internal-failure state for the affected operation; retain authoritative state when available, disable unsafe actions, and keep the application responsive. Do not add a global panic hook or crash-recovery subsystem to implement this rule.
- If the file disappears while clean, preserve current rendered behaviour. If it disappears while dirty, retain bounded local operations/scratch ranges, freeze both surfaces, disable Save, and enter the conflicted state without attempting reconciliation against a missing External generation. Reload-and-Discard becomes available only when a readable file returns.
- Same-inode mutation or watcher-trust loss on a dirty tab removes compromised source-derived content from interaction and accessibility immediately after observation; no cached editor/preview/Find/index result may remain usable merely because cancellation arrived late.
- A watcher candidate may not release or replace an editor source until the external-file decision barrier completes.
- Tab selection, close, reload, link-open, file-manager forwarding, and tabs-disabled replacement must all consult the same dirty lifecycle action.
- Closing the last window must be preventable while the dirty-state decision is pending.
- A reconciliation rejection or exceeded budget is a normal user-visible conflict, not a reason to discard edits silently, retry automatically, overwrite the original, create a recovery artifact, or increase resource limits.
- Piece/scratch pressure releases recomputable and superseded resources in the declared order, then enters `SaveRequired`; it never starts automatic full/regional compaction, exceeds the absolute reserve, drops an accepted transaction, or performs hidden document-sized I/O.
- Shutdown releases draft pieces, editor windows/indices, Viewer caches, and pending work immediately after all dirty decisions are resolved.
- Memory/piece pressure releases superseded preview roots first, then clean caches/recomputable indices, inactive-tab undo, and cancelable nonessential snapshots; it then coalesces/rebalances without copying text before entering `SaveRequired`. It may never evict or corrupt the only copy of unsaved inserted text or cancel an authoritative active Save snapshot.

## Automation and evidence

### Pure Rust coverage

Add focused tests for:

- packed-tree piece insertion, deletion, replacement, adjacent coalescing, empty removal, local rebalancing, aggregate maintenance, and bounded depth;
- UTF-8 boundaries, combining characters, tabs, BOM, CRLF/LF, and final-newline preservation;
- sparse line counts and line-window lookup before and after index completion;
- edits at block, line, layout-page, fence, table, reference, and end-of-file boundaries;
- generation rejection and transaction atomicity;
- clipboard staging preflight, transaction reservation, all-or-nothing commit, scratch rollback accounting, and rejection without draft mutation;
- bounded undo/redo and redo invalidation after a new edit;
- application-wide undo eviction, range-only journal entries, exact scratch allocation categories, and history/accounting reset after Save;
- structurally immutable, shared preview roots and rejection of stale generations/source stamps;
- application-wide preview single-flight scheduling, one coalesced generation token per tab, active-tab preemption at bounded work boundaries, inactive warming priority, and absence of a pinned root before execution;
- presentation-capsule creation, exact byte accounting, per-entry/global ceilings, LRU eviction, active-entry protection, immediate snapshot release, and rejection after generation/source-stamp invalidation;
- `ValidatedSource` pre-read, post-read, and adoption checks for every original-file consumer, with no direct file-descriptor read bypass;
- live-target, detached-Base, and External source-stamp composition; epoch revocation ordering; typed `SourceRevoked`; queued-result rejection; cache/surface invalidation; and absence of follow-on work;
- atomic-replacement Base-stamp minting, comparison-only enforcement, descriptor pre/post validation, and rejection after hard-link/open-descriptor mutation or identity uncertainty;
- injected same-inode writes before/during/after bounded reads and immediately before/after adoption for editor windows, line discovery, Find, Markdown pages, enrichment, Save, and reconciliation;
- exact 1 MiB ordinary-read, 1 MiB sequential-chunk epoch, and 16 MiB sequential identity-validation ceilings, including source transitions and final checks;
- complete streaming save success with fixed memory on small and large files;
- atomic old-or-new pathname visibility, cancellation, queued-save coalescing, disk-full, metadata, and every pre/post-commit failure;
- adversarial external replacement and same-inode writes before streaming, during streaming, before the final identity check, and at the narrow check-to-rename boundary;
- every component of the target identity tuple, parent-path/directory-handle mismatch, substituted symlink rejection, and honest classification of metadata detection versus the unavoidable concurrent-writer race;
- trusted watcher epochs plus overflow, watch loss, thread/coordinator failure, discontinuity, clean revalidation, dirty terminal conflict, and hard rejection of self-save bypass while untrusted;
- every allowed and forbidden transition across Preparing, ReadyToCommit, Committing, Verifying, Committed, and Indeterminate, including injected file/parent flush failure before and after rename;
- preallocated commit inputs and immediate check-to-rename sequencing, with fault instrumentation proving no allocation, path resolution, callback, IPC, wait, or unrelated syscall enters Committing;
- commit-token scoping across tabs, aliases, hard links, expected/late events, token retirement, and simulated independent Lumen processes;
- detected post-commit ownership outcomes for Lumen inode, external inode, and unverifiable pathname, including exact per-activation Retry Verification bounds and discard-and-close;
- injected failures for every save/watch identity and cleanup operation proving typed completion, retained authoritative state where available, no panic/abort, coordinator reuse, and continued operation of unrelated tabs;
- edits accepted during Save remaining dirty and rebinding to the saved generation without replaying or flattening text;
- clean post-save scratch/piece/history release and editor-anchor preservation;
- measured soft/hard piece thresholds including descriptors, internal nodes, allocator capacity, current/pinned roots, overlays, and application-wide multi-tab totals;
- reclaimable scratch threshold accounting for allocated, draft-live, undo-live, and unreachable bytes while permitting irreducible live inserted text;
- maximum-transaction reserve sizing, atomic triggering edit acknowledgement, `SaveRequired` action restrictions, notice, reducing Undo/resume behavior, and absolute-ceiling rejection without mutation;
- active-Save threshold crossing, post-adoption accounting recalculation, successful newest-generation Save reset, and failed/cancelled Save retaining a complete paused draft;
- proof that threshold handling performs no automatic regional/full serialization, creates no replacement scratch source, and preserves Base → Local ancestry;
- external modification, self-save watcher reconciliation, deletion, and reappearance;
- clean automatic dual-surface reload and successful non-overlapping dirty reconciliation;
- unique-context mapping, changed-offset mapping, ambiguity, overlap, repeated text, invalid UTF-8, and all-or-nothing rejection;
- exact enforcement of reconciliation span, byte, memory, and two-second aggregate ceilings without partial adoption or automatic retry;
- post-capture edits rebinding after successful reconciliation and bounded operation/scratch retention after rejection;
- terminal-conflict Save blocking, non-dismissible confirmed Reload-and-Discard, and absence of Save-a-Copy/export/Keep bypasses;
- atomic replacement retaining an immutable Base and same-inode writes immediately rejecting reconciliation without copying the source;
- release of edit state on close and replacement; and
- hard rejection of any response, cache, journal, or piece-metadata growth beyond its declared ceiling.

### TypeScript model coverage

Add dependency-free tests for:

- editor prefix geometry and inverse line lookup;
- mounted-window selection and anchor restoration;
- line-number calculation and gutter-width changes;
- horizontal scrolling and fixed-row spacers;
- edit batching, acknowledgement backpressure, and stale reconciliation;
- prevention of default paste before mutation, clipboard-operation single flight, over-limit notification state, complete-string release after acknowledgement/rejection, and no retained clipboard content in diagnostics;
- selection-length-first copy rejection, successful-write-before-delete cut ordering, clipboard-write failure, native undo/redo suppression, and the declared middle-click/primary-selection/drag-and-drop policy;
- mode transitions and per-tab state restoration;
- divider pointer/keyboard clamping and ratio restoration;
- lazy editor module activation and complete editor DOM teardown on Viewer transition; and
- mounting warm presentation capsules into the single Viewer DOM, restoring semantic anchors, marking stale generations as Updating, and cold-tab loading without hidden per-tab DOM; and
- compromised-source conflict presentation unmounting/hiding editor and preview content, removing selection/clipboard/Find/accessibility access, and restoring only after confirmed reload.

### Agent API and application coverage

Extend the development-only Agent API with bounded, content-safe observations and actions that use the production paths. Add independently runnable scenarios for:

- switching Viewer → Editor → Split → Viewer with button selected states;
- line numbers, caret, typing, deletion, bounded multiline paste, selection, undo, and redo;
- real-WebKit copy, cut, and paste below, at, and above the measured clipboard ceiling, including cross-window selection, Unicode/IME, a line larger than the editor window, clipboard-write failure, and Linux middle-click/primary-selection handling;
- oversized clipboard operations leaving the draft, selection, and existing clipboard unchanged as applicable, showing the bounded-limit notice, releasing transient strings, and leaving the renderer, application, and unrelated tabs responsive;
- unsaved typing, undo, and redo updating the preview to the newest accepted generation without writing the file;
- rapid edits skipping intermediate preview generations while eventually displaying the newest one;
- rapid warm-tab switching immediately displaying each valid retained viewport, restoring anchors, promoting active work, and never mounting a hidden Viewer per inactive tab;
- cold-tab switching after deterministic global-budget eviction showing bounded loading state, prioritizing the selected page, and becoming current without incorrect or unmarked stale content;
- active-tab preview preempting inactive warming within the measured bounded work unit, repeated inactive requests coalescing to one token, and many tabs never multiplying workers, pinned roots, full caches, or queued jobs;
- invalidating an inactive capsule on source change or trust loss before activation, including the safe loading/conflict presentation instead of cached compromised content;
- switching dirty Editor → Viewer and rendering the current draft full-width;
- manual asynchronous save preserving responsive Editor/preview interaction while the watcher adopts the saved identity;
- bounded byte progress, non-cancellable commit state, cancellable streaming, one active save, and newest queued-save coalescing;
- observed external writes always aborting pre-commit Save while a deliberately simultaneous uncooperative writer is handled according to the documented residual-race contract;
- every detected concurrent-writer outcome producing the correct non-dismissible notice and disabled actions while the application, Viewer, and unrelated tabs remain responsive;
- user-triggered Retry Verification exposing one in-flight action, no queue/timer, bounded observations, and no Save re-enable before a valid Committed resolution;
- editing during Save followed by correct post-save rebinding and persistent dirty state;
- clean post-save editor cleanup with no retained scratch or undo history;
- adversarial fragmentation and scratch-garbage growth entering `SaveRequired` only after the triggering edit is visibly acknowledged and previewed;
- `SaveRequired` blocking mutations while preserving mode/scroll/selection/copy/Find/preview/lifecycle actions, allowing only reducing Undo, and resuming below the measured lower threshold;
- explicit Save resetting piece/scratch accounting without hidden pre-save compaction, while failure/cancellation leaves the tab dirty and paused;
- dirty tab switching and Save/Discard/Cancel close behaviour;
- clean external changes refreshing both Editor and Viewer automatically;
- same-inode mutation revoking every old-stamp production result, hiding compromised surfaces, blocking Save, and leaving unrelated tabs responsive;
- a result adopted just before watcher delivery being invalidated on event processing rather than retained as authoritative;
- external changes during accepted, in-flight, unsent, composition, undo, redo, and Save states crossing the same barrier and never overwriting pending input;
- successful bounded reconciliation of provably non-overlapping edits while preserving a dirty live preview;
- ambiguous, overlapping, over-budget, timed-out, deleted, and repeatedly changing sources entering one fail-closed conflict state;
- Save blocking, sole confirmed Reload-and-Discard resolution, inactive-tab conflict handling, and repeated-event coalescing without budget reset;
- absence of Save a Copy, patch export, conflict markers, recovery artifacts, hidden base copies, and Keep bypasses;
- split layout, left/right ownership, pointer drag, keyboard resize, and minimum pane widths;
- independent pane scrolling and stable anchors across mode changes;
- links, images, Find, notices, tabs, and watcher behaviour after editing; and
- clean teardown with no draft text in diagnostics or receipts.

Use compact writable fixtures for correctness. Extend the persistent 5/20/100 MiB fixture matrix with large-file editor actions that verify bounded mounted lines/text, bounded Rust cache/index state, correct distant edits, save integrity, and responsive scrollbar dragging. Never copy automated fixtures or editor diagnostics into production artifacts.

Add deterministic resource observations for mounted row count, mounted text bytes, editor-window bytes, line-index records/bytes, piece descriptors/nodes/allocator bytes, current and pinned root bytes, overlay/reserve bytes, undo transactions/bytes, scratch allocated/draft-live/undo-live/unreachable bytes, `SaveRequired` state/reason, cache bytes, presentation-capsule count/bytes/ceiling and warm/cold state, active preview tab/generation, per-tab desired-generation presence, active worker count, pending transaction count, clipboard phase/payload-byte count/limit outcome, save generation, queued-save count, streamed/total bytes, progress-event count, temporary-artifact count, save phase, reconciliation phase/result, examined spans/bytes, context/working bytes, and elapsed-budget state. Observations expose counts/state only—never rendered, clipboard, or draft text, file identity, or paths.

### Performance evidence

Before retaining the implementation:

1. Add editor and split scenarios to the existing opt-in performance harness.
2. Record comparable Viewer baselines so the new dormant editor code does not regress launch or render speed.
3. Measure first editor paint, nearby and distant scrolling, sustained typing, adversarial fragmentation, at-limit paste/delete cycles, oversized clipboard rejection, `SaveRequired` transition/reset, preview replacement, warm/cold rapid tab switching, active-tab preemption latency, inactive warming, global capsule eviction, superseded-preview/source-revocation cancellation, mode switching, divider dragging, asynchronous sequential Save, and bounded external reconciliation.
4. Inspect DOM count, mounted text bytes, presentation-capsule count/bytes and render expansion, frontend heap and renderer/Rust RSS before/during/after clipboard and tab-switch work, release of complete clipboard strings and preview roots, scratch allocation categories, temporary bytes, complete piece-tree/current-pinned-root/allocator/reserve accounting, line-index memory, undo memory, source-validation syscall/latency overhead, reconciliation context/working memory and examined bytes, worker/file-descriptor count, queued saves, desired preview tokens, pending work, save throughput/progress overhead, UI responsiveness during Save/reconciliation, CPU use at idle, and tail behaviour on 5/20/100 MiB inputs and many clean/dirty tabs.
5. Apply the existing performance acceptance and unsuccessful-candidate rules from `TESTING.md`; do not invent correctness delays or hide latency with optimistic Viewer state.

The implementation is unacceptable if file size causes proportional heap/frontend retention or DOM growth, a clipboard operation bypasses its ceiling, mutates before complete acceptance, deletes before a successful cut copy, retains complete payload strings, crashes/terminates a process, or fails without notification, a tab switch displays blank/incorrect/unmarked-stale content when a valid warm capsule exists, inactive tabs retain hidden DOM or full caches, capsule retention exceeds its global budget, desired preview tokens pin roots or become queued jobs, active preview work cannot preempt inactive warming within its bound, threshold handling performs hidden regional/full serialization or creates a replacement scratch source, an accepted triggering edit is lost/partial, accounting omits allocator/pinned-root/scratch categories, Save blocks Editor/Viewer interaction, concurrent saves multiply disk bandwidth or temporary artifacts, progress becomes high-volume IPC, source validation causes measurable hot-path/idle regression, any consumer reads original bytes outside `ValidatedSource`, revoked work or a compromised capsule is adopted/retained, compromised content remains interactive, reconciliation guesses or partially adopts a result, same-inode mutation triggers a base copy/hash/lease/speculative merge, a conflict exposes a save/export bypass, limits reset under repeated events, an idle editor performs recurring work, each tab adds a worker or full cache budget, undo or preview snapshots duplicate text, typing drops accepted input, preview generations mix, scrollbar drag reintroduces stutter, or dormant editor support measurably harms Viewer launch/render behaviour.

## Proof-gated development sequence

Development is a sequence of automated technology spikes with hard stop/go gates, not one uninterrupted feature build. Only one gate may be active. Before its spike begins, define its hypothesis, fixtures, resource ceilings, observable pass/fail receipt, and cleanup path. A gate passes only with repeatable production-path evidence; an invalid receipt, intermittent failure, unexplained resource growth, or reliance on an Agent-API-only product path fails it.

Failed spike code is removed completely. Do not retain parallel prototypes, compatibility paths, speculative abstractions, disabled production code, or a dependency from a failed gate. Passing a gate permits the smallest clean production integration needed by the next gate; it does not waive later performance or safety evidence. Automation and production-artifact exclusion evolve with every gate rather than being postponed to the end.

0. **Baseline gate:** record current Viewer launch, first render, scrollbar drag, idle CPU, heap, DOM, worker, descriptor, and production-artifact evidence. Define comparison commands and valid receipts before editor code exists.
1. **Real WebKit editing-surface gate:** prove the bounded textarea/window design through actual production WebKit input, selection, composition/IME, long-line, scrolling, and accessibility paths. Measure every unavoidable copy and retained allocation in the production clipboard path, then set one explicit byte ceiling that preserves the application's transient-memory budget. Prove copy/cut/paste below, at, and above it; cross-window selection; clipboard-write failure; native undo suppression; the Linux primary-selection/middle-click policy; no mutation after rejection; prompt release of complete strings; bounded DOM/heap/RSS; graceful notification; continued renderer/application health; and zero Viewer-startup cost. If it fails, remove the spike and stop for the explicit editor-dependency/scope decision.
2. **Piece-model and resource gate:** prove packed original/scratch pieces, `ValidatedSource`, source stamps, pre/post/adoption checks, bounded transactions/reserve, line discovery, undo/redo, structurally immutable roots, exact current/pinned/allocator/scratch accounting, adversarial fragmentation, `SaveRequired`, cleanup, and distant large-file edits without full-document heap retention or automatic text-copy compaction. Set the measured soft/hard/resume/reclaimable-scratch ceilings before proceeding.
3. **Live-preview, tab-presentation, and cancellation gate:** connect stamped draft reads to the existing Rust Markdown/layout-page pipeline without changing its evidence-backed 64 KiB page limit, native normal-flow viewport, provisional-to-canonical adoption, or Fenwick geometry. First extend the current prepared-page plus `PageGeometrySnapshot` tab-restoration mechanism; introduce a separate capsule representation only if repeatable evidence proves that path insufficient. Set measured per-retained-presentation/application-wide budgets plus maximum preview work-unit/preemption bounds. Prove one application-wide build; one unpinned coalesced generation token per tab; exact generation-stamped semantic/viewport-relative anchor restoration; immediate warm-tab presentation; bounded cold-tab loading; active-tab priority; opportunistic inactive warming; deterministic eviction if retention exceeds the budget; no hidden DOM/full per-tab cache; newest-wins target-page and canonical-directory adoption; epoch revocation and compromised-presentation removal; bounded cancellation; stable marked stale presentation for non-compromised supersession; and sustained typing/tab switching without unbounded CPU, I/O, DOM, cache, validation-syscall, root, or snapshot growth.
4. **Atomic-Save and lifecycle gate:** prove stamped-generation streaming, chunk/identity validation ceilings, source revocation, responsiveness, progress, cancellation, the complete commit state machine, file/directory durability, edits during Save, close/quit behavior, and old-or-new visibility under controlled target ownership. This gate implements the preallocated minimized concurrent-writer window and documents that it is not filesystem compare-and-swap.
5. **Filesystem-hardening gate:** resolve and prove the exact identity tuple/system calls, watcher trust loss/reestablishment, scoped commit tokens, bounded Retry Verification, file-identity races, same-inode mutation, repeated candidates, aliases, duplicate tabs/processes, symlinks, hard links, metadata, sparse files, supported filesystems, and adversarial writers. Its receipt proves state ordering and graceful outcomes, not absence of the disclosed residual race. No reconciliation is implemented in this gate.
6. **External-reconciliation gate:** only after gates 1–5 pass, prove immutable-Base eligibility, bounded context mapping, all-or-nothing adoption, every rejection limit, terminal conflict behavior, and zero recovery/export paths. If this gate fails, remove reconciliation and stop for an explicit decision about shipping the editor with fail-closed external invalidation.
7. **Mode and split integration:** retain the proven editor, preview, and lifecycle paths behind the three accessible mode controls; add the left/right split controller and divider without duplicating sessions, caches, workers, or rendering pipelines.
8. **Final performance and cleanup gate:** run all applicable static checks, focused cases, critical coverage, change-specific stress evidence, Viewer baseline comparisons, and production-artifact exclusions. Delete every proof-only and superseded path.
9. **Documentation and release gate:** update canonical architecture, testing, Agent API, README, notices if assets change, and development commands; remove this planning document once its accepted facts have canonical owners.

Each gate must leave one implementation path, pass its focused automated evidence, preserve clean teardown, and keep the application usable before the next gate begins. Work may not continue merely because a failed result appears close to passing.

## Completion criteria

The feature is complete only when all of the following are proven:

- The three buttons select the correct per-tab mode through a shared action.
- Editor mode edits raw Markdown with correct line numbers, native-feeling core input, bounded undo/redo, and explicit saving.
- Split mode always places editor left and viewer right, and its accessible divider resizes both panes horizontally.
- Viewer mode and the right Split pane render the newest accepted draft generation through bounded Rust parsing without flattening the draft or parsing Markdown in the frontend.
- Rapid edits keep at most one application-wide preview build and one unpinned newest desired-generation token per tab, skip superseded generations, preserve the last valid page, and eventually display the newest accepted draft.
- Preview execution is one application-wide build; each tab retains at most one unpinned desired-generation token and one globally budgeted last-valid presentation capsule, with no hidden DOM, observer, worker, or full Viewer cache.
- Selecting a warm tab immediately displays its valid retained viewport and semantic anchor while visibly marking an older generation as Updating; selecting a cold tab prioritizes bounded reconstruction and never substitutes blank, incorrect, or compromised cached content.
- Active-tab preview/navigation preempts inactive warming within the Gate-3 bounded work unit. Capsule LRU eviction stays within the measured application-wide byte ceiling, protects the active presentation, and does not multiply roots or work with tab count.
- Every original-file consumer uses `ValidatedSource`; its bounded result passes pre-read, post-read, and adoption-time `SourceStamp` validation, and no direct descriptor-read bypass remains.
- A received same-inode event or watcher-trust loss revokes the old epoch before further adoption, rejects/cancels derived work and follow-ons, invalidates caches, hides compromised surfaces from interaction/accessibility, and disables Save without crashing or affecting unrelated tabs.
- Source validation stays within the 1 MiB ordinary unit, ≤1 MiB sequential epoch-check chunk, and ≤16 MiB sequential identity-check ceilings without measurable Viewer, typing, scrolling, preview, or idle regression.
- Every observed external change and every close/reload/quit path prevents silent corruption or overwrite: clean changes reload automatically; dirty changes reconcile only from a provably immutable Base and only when every mapping is safe; same-inode, ambiguous, or over-budget cases block Save and require confirmed Reload-and-Discard.
- Reconciliation is all-or-nothing, dependency-free, and constrained to one attempt, 4 MiB working memory, 1 MiB retained context, 4,096 spans, 64 MiB examined candidate bytes, and two seconds per invalidation episode; repeated events cannot reset those ceilings.
- 5/20/100 MiB editor and split scenarios retain bounded frontend DOM/text and bounded Rust caches while distant navigation and edits remain correct.
- Gate-2 evidence sets explicit global soft/hard/resume piece and reclaimable-scratch ceilings from complete packed-tree, allocator, current/pinned-root, overlay, undo, reserve, and scratch-category accounting.
- Reaching a ceiling atomically acknowledges/previews the triggering edit, enters `SaveRequired` without hidden I/O, preserves non-mutating actions, permits only preflight-proven reducing Undo, and resumes only below the lower threshold or after successful Save.
- Undo/redo remains inside one application-wide 256-transaction/512-KiB metadata pool, references text without duplication, and releases evicted history.
- Copy, cut, and paste are explicitly best effort under the Gate-1 clipboard ceiling. Under-limit operations use the shared production path; oversized or failed operations notify the user, make no partial document change, preserve selection/clipboard as applicable, release temporary state, and never panic, abort, terminate the renderer/application, or disable unrelated tabs.
- Save serializes one structurally immutable, source-stamped generation through at most 1 MiB of working memory, may perform file-sized sequential I/O, keeps the UI responsive, and exposes bounded byte-based progress plus a distinct durability phase.
- The pathname remains atomically old-or-new; success is reported only after file/directory durability, verification, and source adoption.
- Save aborts every external change observed before commit, performs no intervening work between its final pinned-directory identity check and rename, and documents rather than conceals the unavoidable race with a simultaneous uncooperative writer.
- Target identity uses the proven metadata tuple plus clean generation and trusted watcher epoch; any watcher-trust loss disables Save/self-save bypass, cleanly revalidates clean tabs, and terminally conflicts dirty tabs.
- The Save coordinator admits only the defined commit-state transitions; no post-rename reopen, ownership, verification, or parent-directory flush failure can be reported as success or rolled back automatically.
- Commit inputs are preallocated, and instrumented evidence proves Committing performs only the final check and immediate rename before entering Verifying.
- Self-save classification requires an exact active tab/generation/identity commit token; aliases, other tabs/processes, unexpected or late events, and every untrusted epoch remain external.
- Retry Verification is user-triggered, single-flight, queue/timer-free, bounded to its declared metadata/durability operations and 64 KiB transient state, and cannot re-enable Save without complete verification.
- Every anticipated concurrent-write, watcher, I/O, identity, verification, metadata, and cleanup failure resolves to a tested typed state without panic, abort, process exit, poisoned shared state, or loss of unrelated-tab functionality.
- A detected post-commit race never triggers automatic rollback: committed-Lumen, externally replaced, and unverifiable ownership each expose their defined frozen-state notice and explicit resolution while Save remains disabled.
- A clean successful save releases scratch/pieces/undo, while edits made during Save rebind to the saved file and remain dirty without replaying or copying text.
- Original and inserted text remain file-backed; no operation, preview, save, or test observation assembles a complete large draft in heap memory.
- No automatic full-document or regional text-copy compaction, replacement scratch source, metadata-limit increase, or partial/rejected-after-mutation transaction remains; explicit Save/discard/close are the only accounting resets.
- Same-inode mitigation introduces no full base copy, reflink requirement, content hash, memory map, file lease, or locking path, and never treats a structurally immutable piece root as proof that original-file bytes remained immutable.
- Viewer-only clean startup creates no editor session/index/DOM/worker, Editor mode keeps no hidden preview pipeline active, and inactive tabs retain no recomputable window caches.
- Split mode shares one document cache and worker budget across its panes and performs no work while idle.
- Viewer-only launch, rendering, links, Find, tabs, scrollbar behaviour, and production footprint do not regress.
- Static checks, Rust tests, focused editor cases, the critical suite, change-specific large-file stress evidence, and production-artifact exclusion checks pass with valid receipts.
- Every technology gate has a valid repeatable receipt; no failed spike, parallel prototype, Agent-API-only mutation, or proof-only production path remains.
- No editor dependency, plugin, remote asset, telemetry, test shortcut, legacy editor path, or full-document frontend retention remains.
- Enduring documentation is updated in its canonical owner, including the README's best-effort clipboard limit, simultaneous-writer limitation, and briefly displayed pre-notification same-inode limitation, and this plan is removed.

## Decisions to confirm before implementation

The plan recommends these initial defaults for refinement:

1. Manual `Ctrl+S` saving, not autosave.
2. Fixed-height unwrapped lines, not soft wrapping.
3. Independent split-pane scrolling, not continuous synchronization.
4. Plain raw Markdown initially, without editor syntax colouring.
5. A local bounded editing surface, with no external editor dependency unless the proof gate fails and a dependency is explicitly approved.
6. One small application-wide undo pool backed by range references, not full-text history.
7. One append-only unlinked file-backed scratch source stores inserted text without proportional Rust heap growth or persistence; exact accounting tracks draft-live, undo-live, unreachable, and allocated bytes until explicit Save/discard/close.
8. A true draft preview: Viewer mode and the right Split pane render unsaved editor changes from bounded structurally immutable, source-stamped draft roots, with newest-generation-wins backpressure.
9. Sublime-style asynchronous Save semantics with Lumen's file-backed buffer: accept file-sized sequential I/O and one full-size sibling temporary artifact in exchange for bounded RAM, responsive editing, atomic replacement, and predictable durability.
10. Best-effort external reconciliation with fail-closed semantics: Safety, responsiveness, and footprint outrank merge success; same-inode mutation or any exceeded limit retains only bounded local operation state, disables Save, and requires confirmed Reload-and-Discard. No Save a Copy or recovery/export path is included.
11. Honest concurrent-writer semantics: Lumen uses the explicit target-identity tuple, trusted watcher epoch, preallocated commit state machine, pinned parent directory, immediate final-check-to-rename transition, scoped commit token, post-rename verification, and bounded indeterminate-state retry. It aborts every external change observed before commit but does not claim unavailable compare-and-swap guarantees. Advisory locking is excluded initially because it cannot provide correctness against uncooperative writers.
12. Automated stop/go technology gates precede each architecture layer; reconciliation is the final optional spike and cannot begin until the editing surface, piece model, preview, Save/lifecycle, and filesystem-hardening gates pass.
13. Graceful failure is mandatory: every anticipated race and filesystem failure becomes a typed recoverable or terminal tab state, never a crash. Affected actions freeze safely, unrelated tabs remain operational, no automatic rollback occurs, and unverifiable post-commit ownership can be rechecked only through explicit bounded user action.
14. Same-inode contamination is contained through one stamped `ValidatedSource` boundary: bounded pre/post/adoption checks, immediate observed-event epoch revocation, rejection of all old-stamp work, and removal of compromised surfaces. Lumen discloses that bytes changed before inotify delivery may have appeared briefly; it does not pay for a base copy, hashing, lease, or lock to claim otherwise.
15. Hidden piece-tree compaction is forbidden. A packed/coalescing balanced tree, complete global accounting, resource eviction, and a maximum-transaction reserve delay exhaustion; measured hard/reclaimable-scratch ceilings atomically enter `SaveRequired`, and only explicit successful Save resets the draft to one file-backed range.
16. Clipboard support is best effort, not arbitrary-size. Gate 1 sets one evidence-based ceiling over the complete production WebKit path; paste rejects atomically before mutation, copy rejects before reading selected text, cut deletes only after a successful clipboard write, and every oversized or failed operation notifies without crashing or retaining unbounded state.
17. Near-instant tab switching uses globally budgeted presentation retention, not per-tab Viewer instances. Preview computation remains application-wide and single-flight; tabs retain one unpinned coalesced desired generation and may retain one LRU capsule, active work preempts inactive warming, and invalid source-stamped presentations are discarded before display.
