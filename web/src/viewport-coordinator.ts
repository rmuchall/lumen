import type {LayoutPageViewport, ViewerPage} from "./layout-page-viewport";
import type {ViewportTraceCorrelation} from "./scroll-diagnostics";
import type {SeekOutcome} from "./shared-actions/viewport";

export type ViewerPageSnapshot = readonly [
  html: string,
  sourceStart: number,
  sourceEnd: number,
  sourceLength: number,
  pageId: string,
  indexComplete: boolean,
];

export type ViewerPageBatchResponse = readonly [pages: ViewerPageSnapshot[], stale: boolean, pending: boolean];

type PendingSeek = {
  agentRequestId: number | null;
  dragId: number | null;
  force: boolean;
  inputGeneration: number;
  onCompletion: ((outcome: SeekOutcome) => void) | null;
  reason: string;
  sourceOffset: number;
};

export type ViewportCoordinatorState = {
  activeAgentRequestId: number | null;
  activeDragId: number | null;
  documentGeneration: number;
  inputGeneration: number;
  measurementCommitActive: boolean;
  pageGeneration: number;
  readerInputActive: boolean;
  pendingPageRequest: boolean;
  scrollWritePending: boolean;
  viewportAnchor: number;
};

type ActiveDocument = {tabId: number; tabRevision: number};

type ViewportCoordinatorDependencies = {
  activeDocument: () => ActiveDocument;
  applyPages: (pages: readonly ViewerPage[], preferViewportFindMatch: boolean) => void;
  hasTerminalLayout: () => boolean;
  onInputSettled: () => void;
  onError: (message: string) => void;
  onStable: () => void;
  persistPosition: (sourceOffset: number, scrollPosition: number, tabId: number, tabRevision: number) => Promise<void>;
  queueEnrichment: (page: ViewerPage) => void;
  requestPageBatch: (sourceOffset: number, tabId: number, tabRevision: number) => Promise<ViewerPageBatchResponse>;
  trace: (eventName: string, detail: string | (() => string), correlation?: ViewportTraceCorrelation) => void;
  viewport: LayoutPageViewport;
  viewerScrollElement: HTMLElement;
};

function pageFromSnapshot(snapshot: ViewerPageSnapshot): ViewerPage {
  const [html, sourceStart, sourceEnd, sourceLength, pageId] = snapshot;
  return {html, pageId, sourceEnd, sourceLength, sourceStart};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error.";
}

export type ViewportCoordinator = {
  beginDocumentRevision(): number;
  beginWidthEpoch(): void;
  beginPointerInteraction(pointerId: number): void;
  cancel(): void;
  commitMeasurements(): void;
  documentGeneration(): number;
  handleScrollEvent(event?: Event): number | null;
  handlePriorityPageReady(tabId: number, tabRevision: number, sourceStart: number, sourceEnd: number): void;
  inputAnchor(): number;
  isStable(): boolean;
  isPointerInteractionActive(): boolean;
  endPointerInteraction(pointerId: number): void;
  pageGeneration(): number;
  queueSeek(
    sourceOffset: number,
    force?: boolean,
    reason?: string,
    onCompletion?: ((outcome: SeekOutcome) => void) | null,
  ): void;
  restorePositionInProgress(value: boolean): void;
  setAnchor(sourceOffset: number): void;
  savePosition(): void;
  scrollToPosition(position: number, onCompletion: (outcome: SeekOutcome) => void, agentRequestId?: number): void;
  settleAfterScroll(): void;
  state(): ViewportCoordinatorState;
  applySyntheticScrollPosition(position: number): void;
  directoryBecameReady(): void;
};

export function createViewportCoordinator(dependencies: ViewportCoordinatorDependencies): ViewportCoordinator {
  const trace = import.meta.env.DEV ? dependencies.trace : undefined;
  let documentGeneration = 0;
  let inputGeneration = 0;
  let readerInputActive = false;
  let measurementCommitActive = false;
  let pageGeneration = 0;
  let pendingSeek: PendingSeek | null = null;
  let requestInFlight = false;
  let restoringPosition = false;
  let pendingAgentNativeScrollPosition: number | null = null;
  let pendingScrollWritePosition: number | null = null;
  let pendingSharedScrollCompletion: ((outcome: SeekOutcome) => void) | null = null;
  let activeAgentRequestId: number | null = null;
  let viewportAnchor = 0;
  let pageWakePending = false;
  let pointerInteractionId: number | null = null;
  let heldDragFrame: number | null = null;
  let heldNativeScrollPending = false;
  let heldNativeScrollCount = 0;

  function correlationForRequest(request: PendingSeek, requestPageGeneration: number): ViewportTraceCorrelation {
    return {
      agentRequestId: request.agentRequestId,
      documentGeneration,
      dragId: request.dragId,
      inputGeneration: request.inputGeneration,
      pageGeneration: requestPageGeneration,
    };
  }

  function state(): ViewportCoordinatorState {
    return {
      activeAgentRequestId,
      activeDragId: pointerInteractionId,
      documentGeneration,
      inputGeneration,
      measurementCommitActive,
      pageGeneration,
      pendingPageRequest: pendingSeek !== null || requestInFlight,
      readerInputActive,
      scrollWritePending: pendingScrollWritePosition !== null,
      viewportAnchor,
    };
  }

  function applySyntheticScrollPosition(position: number): void {
    if (Math.abs(dependencies.viewerScrollElement.scrollTop - position) <= 1) {
      return;
    }
    pendingScrollWritePosition = position;
    pendingAgentNativeScrollPosition = position;
    dependencies.viewerScrollElement.scrollTop = position;
    dependencies.viewerScrollElement.dispatchEvent(new Event("scroll"));
  }

  async function applyPageWindow(request: PendingSeek, pages: readonly ViewerPage[]): Promise<void> {
    if (pendingSeek !== request) {
      return;
    }
    pendingSeek = null;
    const targetPage = pages.find(
      (page) => page.sourceStart <= request.sourceOffset && request.sourceOffset < page.sourceEnd,
    );
    if (targetPage === undefined) {
      throw new Error("Lumen received a page window that does not contain the requested reader position.");
    }
    const requestedSourceOffset = Math.min(request.sourceOffset, Math.max(0, targetPage.sourceLength - 1));
    viewportAnchor = requestedSourceOffset;
    const scrollPositionBeforeMount = dependencies.viewerScrollElement.scrollTop;
    const maximumScrollBeforeMount = Math.max(
      0,
      dependencies.viewerScrollElement.scrollHeight - dependencies.viewerScrollElement.clientHeight,
    );
    const mountedPages = pointerInteractionId === null ? pages : [targetPage];
    dependencies.applyPages(mountedPages, request.reason === "find");
    if (pointerInteractionId === null) {
      dependencies.viewport.measureMountedPages();
      commitMeasurements();
    }
    const scrollPositionAfterMount = dependencies.viewerScrollElement.scrollTop;
    trace?.(
      "page-window-applied",
      `target=${requestedSourceOffset} top_before=${scrollPositionBeforeMount.toFixed(1)} top_after=${scrollPositionAfterMount.toFixed(1)} maximum_before=${maximumScrollBeforeMount.toFixed(1)} pointer=${pointerInteractionId === null ? "none" : pointerInteractionId}`,
      correlationForRequest(request, pageGeneration),
    );
    if (pointerInteractionId === null) {
      const mountedScrollPosition =
        dependencies.viewport.scrollPositionForMountedSourceOffset(requestedSourceOffset) ??
        dependencies.viewport.scrollPositionForSourceOffset(requestedSourceOffset);
      trace?.(
        "mounted-page-position",
        `target=${requestedSourceOffset} position=${mountedScrollPosition.toFixed(1)} anchor=${viewportAnchor}`,
      );
      applySyntheticScrollPosition(mountedScrollPosition);
    } else {
      if (Math.abs(scrollPositionAfterMount - scrollPositionBeforeMount) > 1) {
        trace?.(
          "anchor-or-range-adjusted",
          `target=${requestedSourceOffset} current=${scrollPositionAfterMount.toFixed(1)} target=${scrollPositionBeforeMount.toFixed(1)}`,
        );
        applySyntheticScrollPosition(scrollPositionBeforeMount);
      }
      trace?.("mounted-page-preserved-pointer-position", `target=${requestedSourceOffset}`);
    }
    if (pointerInteractionId === null) {
      const {tabId, tabRevision} = dependencies.activeDocument();
      await dependencies.persistPosition(
        requestedSourceOffset,
        dependencies.viewerScrollElement.scrollTop,
        tabId,
        tabRevision,
      );
    }
    request.onCompletion?.("completed");
    commitMeasurements();
    trace?.(
      "page-work-resolved",
      `target=${request.sourceOffset} pages=${mountedPages.length} start=${targetPage.sourceStart} end=${targetPage.sourceEnd} reason=${request.reason}`,
      correlationForRequest(request, pageGeneration),
    );
    for (const page of mountedPages) {
      dependencies.queueEnrichment(page);
    }
  }

  async function requestSeek(request: PendingSeek): Promise<void> {
    requestInFlight = true;
    const requestedDocumentGeneration = documentGeneration;
    const requestedPageGeneration = pageGeneration + 1;
    const {tabId: requestedTabId, tabRevision: requestedTabRevision} = dependencies.activeDocument();
    pageGeneration = requestedPageGeneration;
    trace?.(
      "page-work-requested",
      () => `target=${request.sourceOffset} force=${request.force} reason=${request.reason}`,
      correlationForRequest(request, requestedPageGeneration),
    );
    try {
      const [snapshots, stale, pending] = await dependencies.requestPageBatch(
        request.sourceOffset,
        requestedTabId,
        requestedTabRevision,
      );
      const activeDocument = dependencies.activeDocument();
      if (
        pendingSeek !== request ||
        requestedDocumentGeneration !== documentGeneration ||
        requestedTabId !== activeDocument.tabId ||
        requestedTabRevision !== activeDocument.tabRevision
      ) {
        trace?.(
          "page-work-resolved",
          `target=${request.sourceOffset} outcome=discarded reason=${request.reason}`,
          correlationForRequest(request, requestedPageGeneration),
        );
        return;
      }
      if (stale) {
        pendingSeek = null;
        trace?.(
          "page-work-resolved",
          `target=${request.sourceOffset} outcome=stale reason=${request.reason}`,
          correlationForRequest(request, requestedPageGeneration),
        );
        request.onCompletion?.("stale");
        return;
      }
      if (pending) {
        trace?.(
          "page-work-resolved",
          `target=${request.sourceOffset} outcome=pending reason=${request.reason}`,
          correlationForRequest(request, requestedPageGeneration),
        );
        return;
      }
      if (snapshots.length === 0) {
        throw new Error("Lumen could not prepare a Markdown page window.");
      }
      const pages = snapshots.map(pageFromSnapshot);
      trace?.(
        "page-window-received",
        () =>
          `target=${request.sourceOffset} ranges=${pages
            .map((page) => `${page.sourceStart}-${page.sourceEnd}`)
            .join(",")}`,
      );
      await applyPageWindow(request, pages);
    } catch (error: unknown) {
      dependencies.onError(`Unable to seek in Markdown document: ${errorMessage(error)}`);
      request.onCompletion?.("failed");
    } finally {
      requestInFlight = false;
      if (pendingSeek !== null && (pageWakePending || pendingSeek !== request)) {
        pageWakePending = false;
        drainPendingSeek();
      }
      completeStableEvents();
    }
  }

  function drainPendingSeek(): void {
    if (requestInFlight) {
      return;
    }
    if (pendingSeek === null) {
      return;
    }
    void requestSeek(pendingSeek);
  }

  function queueSeek(
    sourceOffset: number,
    force = false,
    reason = "scroll",
    onCompletion: ((outcome: SeekOutcome) => void) | null = null,
  ): void {
    const sourceLength = dependencies.viewport.sourceLength();
    const target =
      sourceLength > 0 ? Math.min(Math.max(0, Math.floor(sourceOffset)), sourceLength - 1) : Math.max(0, sourceOffset);
    if (!force && pendingSeek?.sourceOffset === target) {
      return;
    }
    pendingSeek?.onCompletion?.("superseded");
    inputGeneration += 1;
    const request = {
      agentRequestId: activeAgentRequestId,
      dragId: pointerInteractionId,
      force,
      inputGeneration,
      onCompletion,
      reason,
      sourceOffset: target,
    };
    pendingSeek = request;
    trace?.("page-request-queued", `target=${target} force=${force} reason=${reason}`);
    drainPendingSeek();
  }

  function beginInteraction(reason: string): void {
    readerInputActive = true;
    trace?.("reader-input-begin", `generation=${inputGeneration} reason=${reason}`);
  }

  function settleInteraction(): void {
    if (!readerInputActive) {
      return;
    }
    readerInputActive = false;
    trace?.("reader-input-settled", `generation=${inputGeneration} anchor=${viewportAnchor}`);
    dependencies.onInputSettled();
    if (!dependencies.viewport.containsSourceOffset(viewportAnchor)) {
      queueSeek(viewportAnchor, false, "scroll-settled");
    } else {
      commitMeasurements();
    }
  }

  function completeStableEvents(): void {
    if (!isStable()) {
      return;
    }
    const observedSourceOffset = dependencies.viewport.sourceOffsetForScroll();
    if (!dependencies.viewport.containsSourceOffset(observedSourceOffset)) {
      trace?.(
        "anchor-or-range-adjusted",
        `previous=${viewportAnchor} observed=${observedSourceOffset} outcome=reload-page`,
      );
      viewportAnchor = observedSourceOffset;
      queueSeek(observedSourceOffset, false, "reconciled-scroll-position");
      return;
    }
    dependencies.onStable();
  }

  function isStable(): boolean {
    return (
      !readerInputActive &&
      !measurementCommitActive &&
      !requestInFlight &&
      pendingSeek === null &&
      pointerInteractionId === null &&
      heldDragFrame === null &&
      !heldNativeScrollPending &&
      pendingScrollWritePosition === null
    );
  }

  function commitMeasurements(): void {
    if (dependencies.activeDocument().tabId === 0 || readerInputActive) {
      return;
    }
    measurementCommitActive = true;
    const measurementCommit = dependencies.viewport.commitMeasurements();
    measurementCommitActive = false;
    if (measurementCommit.restoredScrollPosition !== null) {
      trace?.(
        "anchor-or-range-adjusted",
        `current=${dependencies.viewerScrollElement.scrollTop.toFixed(1)} target=${measurementCommit.restoredScrollPosition.toFixed(1)}`,
      );
      applySyntheticScrollPosition(measurementCommit.restoredScrollPosition);
    }
    trace?.(
      "geometry-committed",
      `input_generation=${inputGeneration} anchor=${viewportAnchor} changed=${measurementCommit.changed}`,
    );
    completeStableEvents();
  }

  function handleNativeScroll(): number | null {
    if (restoringPosition) {
      trace?.("scroll-ignored-restoring-position", "");
      return null;
    }
    beginInteraction("native-scroll");
    const sourceOffset = dependencies.viewport.sourceOffsetForScroll();
    viewportAnchor = sourceOffset;
    if (!dependencies.viewport.containsSourceOffset(sourceOffset)) {
      queueSeek(sourceOffset);
    }
    trace?.(
      "scroll-dispatched",
      () => `source=${sourceOffset} contained=${dependencies.viewport.containsSourceOffset(sourceOffset)}`,
    );
    return sourceOffset;
  }

  function completeNativeScroll(): number | null {
    const sourceOffset = handleNativeScroll();
    trace?.("native-scroll", `source=${sourceOffset ?? 0}`);
    pendingSharedScrollCompletion?.(sourceOffset === null ? "stale" : "completed");
    pendingSharedScrollCompletion = null;
    return sourceOffset;
  }

  function flushHeldNativeScroll(reason: "frame" | "release"): void {
    if (!heldNativeScrollPending) {
      return;
    }
    const inputCount = heldNativeScrollCount;
    if (heldDragFrame !== null) {
      cancelAnimationFrame(heldDragFrame);
      heldDragFrame = null;
    }
    heldNativeScrollPending = false;
    heldNativeScrollCount = 0;
    if (inputCount > 1 || reason === "release") {
      trace?.(`native-scroll-frame-${reason}`, `anchor=${viewportAnchor} inputs=${inputCount}`);
    }
    completeNativeScroll();
  }

  // Coalesce only a held native thumb's intermediate inputs; release flushes synchronously.
  function scheduleHeldNativeScroll(): void {
    heldNativeScrollPending = true;
    heldNativeScrollCount += 1;
    if (heldDragFrame !== null) {
      return;
    }
    heldDragFrame = requestAnimationFrame(() => {
      heldDragFrame = null;
      flushHeldNativeScroll("frame");
    });
  }

  function savePosition(): void {
    if (dependencies.activeDocument().tabId === 0 || pendingScrollWritePosition !== null || restoringPosition) {
      return;
    }
    const {tabId, tabRevision} = dependencies.activeDocument();
    void dependencies.persistPosition(viewportAnchor, dependencies.viewerScrollElement.scrollTop, tabId, tabRevision);
  }

  function handleScrollEvent(event?: Event): number | null {
    if (event?.isTrusted === true) {
      if (
        pendingAgentNativeScrollPosition !== null &&
        Math.abs(dependencies.viewerScrollElement.scrollTop - pendingAgentNativeScrollPosition) <= 1
      ) {
        trace?.("agent-native-scroll-duplicate", `top=${dependencies.viewerScrollElement.scrollTop.toFixed(1)}`);
        pendingAgentNativeScrollPosition = null;
        return null;
      }
      pendingAgentNativeScrollPosition = null;
    }
    if (
      pendingScrollWritePosition !== null &&
      Math.abs(dependencies.viewerScrollElement.scrollTop - pendingScrollWritePosition) <= 1
    ) {
      pendingScrollWritePosition = null;
      trace?.(
        "scroll-write-observed",
        `top=${dependencies.viewerScrollElement.scrollTop.toFixed(1)} anchor=${viewportAnchor}`,
      );
      completeStableEvents();
      pendingSharedScrollCompletion?.("completed");
      pendingSharedScrollCompletion = null;
      return null;
    }
    pendingScrollWritePosition = null;
    trace?.(
      "native-scroll-received",
      `top=${dependencies.viewerScrollElement.scrollTop.toFixed(1)} anchor=${viewportAnchor}`,
    );
    if (pointerInteractionId !== null) {
      scheduleHeldNativeScroll();
      return null;
    }
    return completeNativeScroll();
  }

  function scrollToPosition(
    position: number,
    onCompletion: (outcome: SeekOutcome) => void,
    agentRequestId?: number,
  ): void {
    activeAgentRequestId = agentRequestId ?? null;
    pendingSharedScrollCompletion?.("superseded");
    pendingSharedScrollCompletion = onCompletion;
    const maximumScroll = Math.max(
      0,
      dependencies.viewerScrollElement.scrollHeight - dependencies.viewerScrollElement.clientHeight,
    );
    const targetPosition = Math.max(0, Math.min(position, maximumScroll));
    trace?.(
      "scroll-write-accepted",
      `requested=${position.toFixed(1)} target=${targetPosition.toFixed(1)} maximum=${maximumScroll.toFixed(1)} generation=${inputGeneration}`,
    );
    pendingAgentNativeScrollPosition = targetPosition;
    dependencies.viewerScrollElement.scrollTop = targetPosition;
    dependencies.viewerScrollElement.dispatchEvent(new Event("scroll"));
  }

  function beginDocumentRevision(): number {
    documentGeneration += 1;
    pageGeneration += 1;
    return documentGeneration;
  }

  function beginWidthEpoch(): void {
    if (dependencies.activeDocument().tabId === 0) {
      return;
    }
    const anchor = dependencies.viewport.sourceOffsetForScroll();
    dependencies.viewport.beginWidthEpoch();
    commitMeasurements();
    trace?.("width-epoch-begin", `anchor=${anchor} ${dependencies.viewport.agentObservation()}`);
  }

  function beginPointerInteraction(pointerId: number): void {
    if (restoringPosition || pointerInteractionId !== null) {
      return;
    }
    pointerInteractionId = pointerId;
    dependencies.viewport.beginNativeRangeHold();
    beginInteraction("pointer");
    trace?.("pointer-interaction-begin", `pointer=${pointerId}`);
  }

  function endPointerInteraction(pointerId: number): void {
    if (pointerInteractionId !== pointerId) {
      return;
    }
    flushHeldNativeScroll("release");
    pointerInteractionId = null;
    trace?.("pointer-interaction-end", `pointer=${pointerId} anchor=${viewportAnchor}`);
    dependencies.viewport.endNativeRangeHold();
    dependencies.viewport.measureMountedPages();
    settleInteraction();
    drainPendingSeek();
    savePosition();
  }

  function cancel(): void {
    pendingSeek?.onCompletion?.("stale");
    pendingSeek = null;
    pendingAgentNativeScrollPosition = null;
    pageWakePending = false;
    if (heldDragFrame !== null) {
      cancelAnimationFrame(heldDragFrame);
      heldDragFrame = null;
    }
    heldNativeScrollPending = false;
    heldNativeScrollCount = 0;
    dependencies.viewport.endNativeRangeHold();
    pointerInteractionId = null;
    readerInputActive = false;
    measurementCommitActive = false;
    restoringPosition = false;
    pendingScrollWritePosition = null;
    pendingSharedScrollCompletion?.("stale");
    pendingSharedScrollCompletion = null;
    activeAgentRequestId = null;
  }

  function handlePriorityPageReady(tabId: number, tabRevision: number, sourceStart: number, sourceEnd: number): void {
    const active = dependencies.activeDocument();
    if (tabId !== active.tabId || tabRevision !== active.tabRevision) {
      return;
    }
    if (pendingSeek === null) {
      return;
    }
    pageWakePending = true;
    trace?.("page-request-ready", `target=${pendingSeek.sourceOffset} start=${sourceStart} end=${sourceEnd}`);
    drainPendingSeek();
  }

  function directoryBecameReady(): void {
    pageWakePending = true;
    if (pendingSeek === null && !dependencies.viewport.containsSourceOffset(viewportAnchor)) {
      queueSeek(viewportAnchor, false, "directory-ready");
    }
    drainPendingSeek();
    commitMeasurements();
  }

  return {
    applySyntheticScrollPosition,
    beginDocumentRevision,
    beginWidthEpoch,
    beginPointerInteraction,
    cancel,
    commitMeasurements,
    directoryBecameReady,
    documentGeneration: () => documentGeneration,
    endPointerInteraction,
    handleScrollEvent,
    handlePriorityPageReady,
    inputAnchor: () => viewportAnchor,
    isStable,
    isPointerInteractionActive: () => pointerInteractionId !== null,
    pageGeneration: () => pageGeneration,
    queueSeek,
    restorePositionInProgress: (value) => {
      restoringPosition = value;
    },
    setAnchor: (sourceOffset) => {
      viewportAnchor = sourceOffset;
    },
    savePosition,
    scrollToPosition,
    settleAfterScroll: () => {
      if (pointerInteractionId !== null) {
        trace?.("scrollend-deferred-for-pointer", `pointer=${pointerInteractionId}`);
        return;
      }
      settleInteraction();
      savePosition();
    },
    state,
  };
}
