import {listen} from "@tauri-apps/api/event";
import {invoke} from "@tauri-apps/api/core";
import {parseAgentEventRequest, type AgentEventRequest, type AgentOutcome} from "./protocol";
import {completeAgentEvent} from "./reporter";
import type {ViewportTraceSnapshot, ViewportTraceSummary} from "../scroll-diagnostics";

type TabCloseAction = "tab" | "other" | "right" | "left";
type NoticeSource = "configuration" | "document";
const maximumViewportTraceChunkBytes = 8 * 1024;
const maximumViewportTraceChunks = 6;
type TestRunTier = "critical" | "regular" | "stress";
type ZoomAction = "in" | "out" | "reset";

type FindState = {
  activeRangeConnected: boolean;
  highlightMatchesActiveRange: boolean;
};

type FindNavigation = {
  matchOffset: number | null;
  targetVisible: boolean;
};

type DisplayedPage = {
  sourceEnd: number;
  sourceStart: number;
};

type DisplayedHtmlInspection = {
  content: string;
  totalBytes: number;
};

type PendingPageDisplayed = {
  dragId: number | null;
  request: AgentEventRequest;
  sourceOffset: number;
};

type AgentActions = {
  activeTabId: () => number;
  activateNotice: (source: NoticeSource) => boolean;
  beginPointerDrag: (dragId: number) => void;
  beginViewportTrace: (traceId: number, label: string) => boolean;
  closeTabs: (tabId: number, action: TabCloseAction) => Promise<boolean>;
  copyDocumentPath: () => Promise<boolean>;
  captureDisplayedHtml: (offset: number, length: number) => DisplayedHtmlInspection | null;
  directoryReady: () => boolean;
  dismissNotice: (source: NoticeSource) => boolean;
  endPointerDrag: (dragId: number) => void;
  endViewportTrace: (traceId: number) => ViewportTraceSummary | null;
  findClear: () => void;
  findObservation: () => FindState;
  findNext: () => Promise<FindNavigation>;
  findPrevious: () => Promise<FindNavigation>;
  followLink: (link: string) => Promise<boolean>;
  focusWindow: () => Promise<boolean>;
  handoffOpen: (path: string) => Promise<boolean>;
  openPath: (path: string) => Promise<boolean>;
  readViewportTrace: (traceId: number, afterSequence: number) => ViewportTraceSnapshot | null;
  reloadDocument: () => Promise<boolean>;
  reportScrollState: () => Promise<void>;
  scrollTo: (position: number, onCompletion: (outcome: AgentOutcome) => void, requestId: number) => void;
  seek: (sourceOffset: number, onCompletion?: (outcome: AgentOutcome) => void) => void;
  selectTab: (tabId: number) => Promise<boolean>;
  setFindQuery: (query: string) => void;
  settleFindHighlight: () => Promise<void>;
  sourceLength: () => number;
  sourceOffset: () => number;
  settleViewport: () => void;
  viewportIsStable: () => boolean;
  setTestRunState: (tier: TestRunTier, phase: string) => Promise<boolean>;
  watcherReady: () => Promise<boolean>;
  zoom: (action: ZoomAction) => Promise<boolean>;
};

export type AgentEventLifecycle = {
  beginWatchedMarkdownChange: () => void;
  cancel: (preserveCommittedAction: boolean) => void;
  configurationChanged: () => void;
  documentOpening: () => void;
  documentOpened: () => void;
  layoutPageDirectoryFailed: () => void;
  layoutPageDirectoryReady: () => void;
  documentReloading: () => void;
  documentReloaded: () => void;
  pageDisplayed: (sourceStart: number, sourceEnd: number, findState: FindState) => void;
  viewportStable: (hasTerminalLayout: boolean) => void;
  watcherReady: () => void;
  watchedMarkdownChanged: () => void;
};

function complete(
  request: AgentEventRequest,
  operation: Parameters<typeof completeAgentEvent>[1],
  outcome: AgentOutcome,
  boundary: Parameters<typeof completeAgentEvent>[3],
  detail = "",
  causeRequestId = 0,
): void {
  completeAgentEvent(request, operation, outcome, boundary, detail, causeRequestId);
}

function parseNoticeSource(argumentsText: string): NoticeSource | null {
  return argumentsText === "configuration" || argumentsText === "document" ? argumentsText : null;
}

function parseTabCloseRequest(argumentsText: string): readonly [number, TabCloseAction] | null {
  const [tabIdText, action, extra] = argumentsText.split(" ");
  const tabId = Number(tabIdText);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(tabId) ||
    tabId <= 0 ||
    (action !== "tab" && action !== "other" && action !== "right" && action !== "left")
  ) {
    return null;
  }
  return [tabId, action];
}

function parseTestRunState(argumentsText: string): readonly [TestRunTier, string] | null {
  const [tier, phase, extra] = argumentsText.split(" ");
  if (
    extra !== undefined ||
    (tier !== "critical" && tier !== "regular" && tier !== "stress") ||
    phase === undefined ||
    !/^[a-z0-9-]{1,64}$/.test(phase)
  ) {
    return null;
  }
  return [tier, phase];
}

function parseTraceRead(argumentsText: string): readonly [number, number] | null {
  const [traceIdText, afterSequenceText, extra] = argumentsText.split(" ");
  const traceId = Number(traceIdText);
  const afterSequence = afterSequenceText === undefined ? 0 : Number(afterSequenceText);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(traceId) ||
    traceId <= 0 ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0
  ) {
    return null;
  }
  return [traceId, afterSequence];
}

function parseDisplayedPageRequest(argumentsText: string): readonly [number, number | null] | null {
  const [sourceOffsetText, dragIdText, extra] = argumentsText.split(" ");
  const sourceOffset = Number(sourceOffsetText);
  const dragId = dragIdText === undefined ? null : Number(dragIdText);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(sourceOffset) ||
    sourceOffset < 0 ||
    (dragId !== null && (!Number.isSafeInteger(dragId) || dragId <= 0))
  ) {
    return null;
  }
  return [sourceOffset, dragId];
}

function parseDisplayedHtmlRequest(argumentsText: string): readonly [number, number] | null {
  const [offsetText, lengthText, extra] = argumentsText.split(" ");
  const offset = Number(offsetText);
  const length = Number(lengthText);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > 64 * 1024
  ) {
    return null;
  }
  return [offset, length];
}

function traceDetail(traceId: number, summary?: ViewportTraceSummary): string {
  if (summary === undefined) {
    return `trace_id=${traceId}`;
  }
  return `trace_id=${traceId}.record_count=${summary.recordCount}.truncated=${summary.truncated}`;
}

function traceChunks(snapshot: string): readonly string[] | null {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of snapshot) {
    const characterBytes = encoder.encode(character).byteLength;
    if (characterBytes > maximumViewportTraceChunkBytes) {
      return null;
    }
    if (chunkBytes + characterBytes > maximumViewportTraceChunkBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks.length > 0 && chunks.length <= maximumViewportTraceChunks ? chunks : null;
}

async function reportViewportTraceSnapshot(traceId: number, snapshot: ViewportTraceSnapshot): Promise<boolean> {
  const chunks = traceChunks(JSON.stringify(snapshot));
  if (chunks === null) {
    return false;
  }
  for (const [chunkIndex, chunk] of chunks.entries()) {
    await invoke<void>("report_agent_observation_viewport_trace_chunk", {
      chunk,
      chunkCount: chunks.length,
      chunkIndex,
      traceId,
    });
  }
  return invoke<boolean>("commit_agent_observation_viewport_trace", {chunkCount: chunks.length, traceId});
}

export async function installAgentListeners(actions: AgentActions): Promise<AgentEventLifecycle | null> {
  if (!import.meta.env.DEV) {
    return null;
  }

  let pendingConfigurationNotice: AgentEventRequest | null = null;
  let pendingDirectoryReady: AgentEventRequest | null = null;
  let pendingHandoffOpen: AgentEventRequest | null = null;
  let pendingPageDisplayed: PendingPageDisplayed | null = null;
  let pendingReload: AgentEventRequest | null = null;
  let reloadInFlight: AgentEventRequest | null = null;
  let handoffOpenInFlight: AgentEventRequest | null = null;
  let pendingScrollSettlement: AgentEventRequest | null = null;
  let scrollSettlementReportingRequestId: number | null = null;
  let pendingTerminalLayout: AgentEventRequest | null = null;
  let pendingWatcherReady: AgentEventRequest | null = null;
  let pendingWatcherReload: AgentEventRequest | null = null;
  let watcherReloadInFlight: AgentEventRequest | null = null;
  let lastDisplayedPage: DisplayedPage | null = null;
  let activeDragId: number | null = null;

  function pageContainsOffset(page: DisplayedPage, sourceOffset: number): boolean {
    return page.sourceStart <= sourceOffset && sourceOffset < page.sourceEnd;
  }

  function completePageDisplayed(page: DisplayedPage): void {
    const pending = pendingPageDisplayed;
    if (
      pending === null ||
      !pageContainsOffset(page, pending.sourceOffset) ||
      (pending.dragId !== null && pending.dragId !== activeDragId)
    ) {
      return;
    }
    pendingPageDisplayed = null;
    complete(pending.request, "page-displayed", "completed", "displayed", `source_offset=${pending.sourceOffset}`);
  }
  function supersede(
    request: AgentEventRequest | null,
    operation: Parameters<typeof completeAgentEvent>[1],
    boundary: Parameters<typeof completeAgentEvent>[3],
    causeRequestId = 0,
  ): void {
    if (request !== null) {
      complete(request, operation, "superseded", boundary, "", causeRequestId);
    }
  }

  function completeScrollSettlement(request: AgentEventRequest): void {
    if (
      pendingScrollSettlement?.requestId !== request.requestId ||
      scrollSettlementReportingRequestId === request.requestId
    ) {
      return;
    }
    scrollSettlementReportingRequestId = request.requestId;
    void actions.reportScrollState().then(
      () => {
        if (pendingScrollSettlement?.requestId === request.requestId) {
          pendingScrollSettlement = null;
          complete(request, "scroll-settled", "completed", "layout-settled", `source_offset=${actions.sourceOffset()}`);
        }
        if (scrollSettlementReportingRequestId === request.requestId) {
          scrollSettlementReportingRequestId = null;
        }
      },
      () => {
        if (pendingScrollSettlement?.requestId === request.requestId) {
          pendingScrollSettlement = null;
          complete(request, "scroll-settled", "failed", "layout-settled", "reason=observation-failed");
        }
        if (scrollSettlementReportingRequestId === request.requestId) {
          scrollSettlementReportingRequestId = null;
        }
      },
    );
  }

  async function completeWatcherReady(): Promise<void> {
    const request = pendingWatcherReady;
    if (request === null || !(await actions.watcherReady())) {
      return;
    }
    pendingWatcherReady = null;
    complete(request, "watcher-ready", "completed", "displayed");
  }

  await Promise.all([
    listen<string>("agent-event-open", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length === 0) {
        complete(request, "open", "failed", "displayed", "reason=invalid-arguments");
        return;
      }
      void actions.openPath(request.argumentsText).then((opened) => {
        complete(request, "open", opened ? "completed" : "failed", "displayed");
      });
    }),
    listen<string>("agent-event-viewport-trace-begin", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (!/^[a-z0-9-]{1,64}$/.test(request.argumentsText)) {
        complete(request, "viewport-trace-begin", "failed", "input-consumed", "reason=invalid-trace-label");
        return;
      }
      complete(
        request,
        "viewport-trace-begin",
        actions.beginViewportTrace(request.requestId, request.argumentsText) ? "completed" : "failed",
        "input-consumed",
        `trace_id=${request.requestId}`,
      );
    }),
    listen<string>("agent-event-viewport-trace-read", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const traceRequest = parseTraceRead(request.argumentsText);
      if (traceRequest === null) {
        complete(request, "viewport-trace-read", "failed", "displayed", "reason=invalid-trace-read");
        return;
      }
      const [traceId, afterSequence] = traceRequest;
      const snapshot = actions.readViewportTrace(traceId, afterSequence);
      if (snapshot === null) {
        complete(request, "viewport-trace-read", "failed", "displayed", "reason=trace-unavailable");
        return;
      }
      void reportViewportTraceSnapshot(traceId, snapshot).then(
        (reported) => {
          if (!reported) {
            complete(request, "viewport-trace-read", "failed", "displayed", "reason=trace-report-failed");
            return;
          }
          complete(
            request,
            "viewport-trace-read",
            "completed",
            "displayed",
            traceDetail(traceId, {
              firstOmittedSequence: snapshot.firstOmittedSequence,
              id: snapshot.id,
              recordCount: snapshot.records.length,
              truncated: snapshot.truncated,
            }),
          );
        },
        () => complete(request, "viewport-trace-read", "failed", "displayed", "reason=trace-report-failed"),
      );
    }),
    listen<string>("agent-event-viewport-trace-end", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const traceId = Number(request.argumentsText);
      if (!Number.isSafeInteger(traceId) || traceId <= 0) {
        complete(request, "viewport-trace-end", "failed", "input-consumed", "reason=invalid-trace-id");
        return;
      }
      const summary = actions.endViewportTrace(traceId);
      if (summary === null) {
        complete(request, "viewport-trace-end", "failed", "input-consumed", "reason=trace-unavailable");
        return;
      }
      void invoke<void>("clear_agent_observation_viewport_trace", {traceId}).then(
        () => complete(request, "viewport-trace-end", "completed", "input-consumed", traceDetail(traceId, summary)),
        () => complete(request, "viewport-trace-end", "failed", "input-consumed", "reason=trace-clear-failed"),
      );
    }),
    listen<string>("agent-event-page-displayed", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const pageRequest = parseDisplayedPageRequest(request.argumentsText);
      if (pageRequest === null || actions.activeTabId() === 0) {
        complete(request, "page-displayed", "failed", "displayed", "reason=invalid-source-offset");
        return;
      }
      const [sourceOffset, dragId] = pageRequest;
      if (dragId !== null && dragId !== activeDragId) {
        complete(request, "page-displayed", "failed", "displayed", "reason=inactive-drag");
        return;
      }
      if (lastDisplayedPage !== null && pageContainsOffset(lastDisplayedPage, sourceOffset)) {
        complete(request, "page-displayed", "completed", "displayed", `source_offset=${sourceOffset}`);
        return;
      }
      if (pendingPageDisplayed !== null) {
        complete(pendingPageDisplayed.request, "page-displayed", "superseded", "displayed", "", request.requestId);
      }
      pendingPageDisplayed = {dragId, request, sourceOffset};
    }),
    listen<string>("agent-event-displayed-html", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const inspectionRequest = parseDisplayedHtmlRequest(request.argumentsText);
      if (inspectionRequest === null) {
        complete(request, "displayed-html", "failed", "displayed", "reason=invalid-inspection-range");
        return;
      }
      const [offset, length] = inspectionRequest;
      const inspection = actions.captureDisplayedHtml(offset, length);
      if (inspection === null) {
        complete(request, "displayed-html", "failed", "displayed", "reason=inspection-unavailable");
        return;
      }
      void invoke<boolean>("report_agent_displayed_html_inspection", {
        displayedHtml: inspection.content,
        requestId: request.requestId,
        totalBytes: inspection.totalBytes,
      }).then(
        (reported) => {
          complete(
            request,
            "displayed-html",
            reported ? "completed" : "failed",
            "displayed",
            reported
              ? `offset=${offset}.total_bytes=${inspection.totalBytes}.response_bytes=${new TextEncoder().encode(inspection.content).byteLength}`
              : "reason=inspection-report-failed",
          );
        },
        () => complete(request, "displayed-html", "failed", "displayed", "reason=inspection-report-failed"),
      );
    }),
    listen<string>("agent-event-select-tab", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const tabId = Number(request.argumentsText);
      if (!Number.isSafeInteger(tabId) || tabId <= 0) {
        complete(request, "select-tab", "failed", "displayed", "reason=invalid-tab-id");
        return;
      }
      void actions.selectTab(tabId).then((selected) => {
        complete(request, "select-tab", selected ? "completed" : "failed", "displayed");
      });
    }),
    listen<string>("agent-event-close", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const tabId = actions.activeTabId();
      if (request.argumentsText.length > 0 || tabId === 0) {
        complete(request, "close", "failed", "displayed", "reason=invalid-close-request");
        return;
      }
      void actions.closeTabs(tabId, "tab").then((closed) => {
        complete(request, "close", closed ? "completed" : "failed", "displayed");
      });
    }),
    listen<string>("agent-event-close-tabs", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const closeRequest = parseTabCloseRequest(request.argumentsText);
      if (closeRequest === null) {
        complete(request, "close-tabs", "failed", "displayed", "reason=invalid-close-tabs-request");
        return;
      }
      const [tabId, action] = closeRequest;
      void actions.closeTabs(tabId, action).then((closed) => {
        complete(request, "close-tabs", closed ? "completed" : "failed", "displayed");
      });
    }),
    listen<string>("agent-event-copy-path", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "copy-path", "failed", "input-consumed", "reason=invalid-copy-request");
        return;
      }
      void actions.copyDocumentPath().then((copied) => {
        complete(request, "copy-path", copied ? "completed" : "failed", "input-consumed");
      });
    }),
    listen<string>("agent-event-directory-ready", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0 || actions.activeTabId() === 0) {
        complete(request, "directory-ready", "failed", "displayed", "reason=invalid-directory-request");
        return;
      }
      if (actions.directoryReady()) {
        complete(request, "directory-ready", "completed", "displayed");
        return;
      }
      supersede(pendingDirectoryReady, "directory-ready", "displayed", request.requestId);
      pendingDirectoryReady = request;
    }),
    listen<string>("agent-event-drag-begin", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0 || actions.activeTabId() === 0 || activeDragId !== null) {
        complete(request, "drag-begin", "failed", "input-consumed", "reason=invalid-drag-begin-request");
        return;
      }
      activeDragId = request.requestId;
      actions.beginPointerDrag(activeDragId);
      complete(request, "drag-begin", "completed", "input-consumed", `drag_id=${activeDragId}`);
    }),
    listen<string>("agent-event-drag-end", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const dragId = Number(request.argumentsText);
      if (!Number.isSafeInteger(dragId) || dragId <= 0 || actions.activeTabId() === 0 || activeDragId !== dragId) {
        complete(request, "drag-end", "failed", "input-consumed", "reason=invalid-drag-end-request");
        return;
      }
      actions.endPointerDrag(dragId);
      activeDragId = null;
      complete(request, "drag-end", "completed", "input-consumed", `drag_id=${dragId}`);
    }),
    listen<string>("agent-event-reload", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0 || actions.activeTabId() === 0) {
        complete(request, "reload", "failed", "displayed", "reason=invalid-reload-request");
        return;
      }
      supersede(pendingReload, "reload", "displayed", request.requestId);
      supersede(reloadInFlight, "reload", "displayed", request.requestId);
      reloadInFlight = null;
      pendingReload = request;
      void actions.reloadDocument().then((reloaded) => {
        if (!reloaded && pendingReload?.requestId === request.requestId) {
          pendingReload = null;
          complete(request, "reload", "failed", "displayed", "reason=reload-failed");
        }
      });
    }),
    listen<string>("agent-event-scroll", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      supersede(pendingScrollSettlement, "scroll-settled", "layout-settled", request.requestId);
      pendingScrollSettlement = null;
      scrollSettlementReportingRequestId = null;
      const position = Number(request.argumentsText);
      if (!Number.isFinite(position) || position < 0 || actions.activeTabId() === 0) {
        complete(request, "scroll", "failed", "input-consumed", "reason=invalid-position");
        return;
      }
      actions.scrollTo(
        position,
        (outcome) => complete(request, "scroll", outcome, "input-consumed"),
        request.requestId,
      );
    }),
    listen<string>("agent-event-scroll-settled", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const dragId = request.argumentsText.length === 0 ? null : Number(request.argumentsText);
      if (
        actions.activeTabId() === 0 ||
        (dragId !== null && (!Number.isSafeInteger(dragId) || dragId <= 0 || activeDragId !== dragId))
      ) {
        complete(request, "scroll-settled", "failed", "layout-settled", "reason=invalid-settlement");
        return;
      }
      supersede(pendingScrollSettlement, "scroll-settled", "layout-settled", request.requestId);
      pendingScrollSettlement = request;
      actions.settleViewport();
      if (actions.viewportIsStable()) {
        completeScrollSettlement(request);
      }
    }),
    listen<string>("agent-event-seek", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const sourceOffset = Number(request.argumentsText);
      if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || actions.activeTabId() === 0) {
        complete(request, "seek", "failed", "displayed", "reason=invalid-source-offset");
        return;
      }
      actions.seek(sourceOffset, (outcome) => complete(request, "seek", outcome, "displayed"));
    }),
    listen<string>("agent-event-terminal-layout", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const sourceLength = actions.sourceLength();
      if (request.argumentsText.length > 0 || actions.activeTabId() === 0 || sourceLength === 0) {
        complete(request, "terminal-layout", "failed", "terminal-layout", "reason=invalid-terminal-request");
        return;
      }
      supersede(pendingTerminalLayout, "terminal-layout", "terminal-layout", request.requestId);
      pendingTerminalLayout = request;
      actions.seek(sourceLength - 1, (outcome) => {
        if (pendingTerminalLayout?.requestId !== request.requestId) {
          return;
        }
        if (outcome !== "completed") {
          pendingTerminalLayout = null;
          complete(request, "terminal-layout", outcome, "terminal-layout", "seek-unavailable");
          return;
        }
        void actions.reportScrollState().then(
          () => {
            if (pendingTerminalLayout?.requestId !== request.requestId) {
              return;
            }
            pendingTerminalLayout = null;
            complete(request, "terminal-layout", "completed", "terminal-layout", "terminal-verified");
          },
          () => {
            if (pendingTerminalLayout?.requestId !== request.requestId) {
              return;
            }
            pendingTerminalLayout = null;
            complete(request, "terminal-layout", "failed", "terminal-layout", "reason=observation-failed");
          },
        );
      });
    }),
    listen<string>("agent-event-test-run-state", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const state = parseTestRunState(request.argumentsText);
      if (state === null) {
        complete(request, "test-run-state", "failed", "displayed", "reason=invalid-test-run-state");
        return;
      }
      const [tier, phase] = state;
      void actions.setTestRunState(tier, phase).then((updated) => {
        complete(request, "test-run-state", updated ? "completed" : "failed", "displayed");
      });
    }),
    listen<string>("agent-event-watcher-ready", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0 || actions.activeTabId() === 0) {
        complete(request, "watcher-ready", "failed", "displayed", "reason=invalid-watcher-request");
        return;
      }
      supersede(pendingWatcherReady, "watcher-ready", "displayed", request.requestId);
      pendingWatcherReady = request;
      void completeWatcherReady();
    }),
    listen<string>("agent-event-watcher-reload", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0 || actions.activeTabId() === 0) {
        complete(request, "watcher-reload", "failed", "displayed", "reason=invalid-watcher-request");
        return;
      }
      supersede(pendingWatcherReload, "watcher-reload", "displayed", request.requestId);
      pendingWatcherReload = request;
    }),
    listen<string>("agent-event-link", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length === 0) {
        complete(request, "link", "failed", "displayed", "reason=invalid-link");
        return;
      }
      void actions.followLink(request.argumentsText).then((followed) => {
        complete(request, "link", "completed", "displayed", followed ? "link-followed" : "link-error-notice");
      });
    }),
    listen<string>("agent-event-focus", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "focus", "failed", "input-consumed", "reason=invalid-focus-request");
        return;
      }
      void actions.focusWindow().then((focused) => {
        complete(request, "focus", focused ? "completed" : "failed", "input-consumed");
      });
    }),
    listen<string>("agent-event-notice-dismiss", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const source = parseNoticeSource(request.argumentsText);
      if (source === null) {
        complete(request, "notice-dismiss", "failed", "displayed", "reason=invalid-notice-source");
        return;
      }
      complete(request, "notice-dismiss", actions.dismissNotice(source) ? "completed" : "not-found", "displayed");
    }),
    listen<string>("agent-event-notice-action", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const source = parseNoticeSource(request.argumentsText);
      if (source === null) {
        complete(request, "notice-action", "failed", "input-consumed", "reason=invalid-notice-source");
        return;
      }
      complete(request, "notice-action", actions.activateNotice(source) ? "completed" : "not-found", "input-consumed");
    }),
    listen<string>("agent-event-configuration-notice", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "configuration-notice", "failed", "displayed", "reason=invalid-configuration-request");
        return;
      }
      supersede(pendingConfigurationNotice, "configuration-notice", "displayed", request.requestId);
      pendingConfigurationNotice = request;
    }),
    listen<string>("agent-event-zoom", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      const action: ZoomAction | null =
        request.argumentsText === "in" || request.argumentsText === "out" || request.argumentsText === "reset"
          ? request.argumentsText
          : null;
      if (action === null) {
        complete(request, "zoom", "failed", "displayed", "reason=invalid-zoom-action");
        return;
      }
      void actions.zoom(action).then((zoomed) => {
        complete(request, "zoom", zoomed ? "completed" : "failed", "displayed");
      });
    }),
    listen<string>("agent-event-handoff-open", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length === 0) {
        complete(request, "handoff-open", "failed", "displayed", "reason=invalid-handoff-request");
        return;
      }
      supersede(pendingHandoffOpen, "handoff-open", "displayed", request.requestId);
      supersede(handoffOpenInFlight, "handoff-open", "displayed", request.requestId);
      handoffOpenInFlight = null;
      pendingHandoffOpen = request;
      void actions.handoffOpen(request.argumentsText).then((opened) => {
        if (!opened && pendingHandoffOpen?.requestId === request.requestId) {
          pendingHandoffOpen = null;
          complete(request, "handoff-open", "failed", "displayed", "reason=handoff-failed");
        }
      });
    }),
    listen<string>("agent-event-find", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length === 0) {
        complete(request, "find", "failed", "displayed", "reason=invalid-arguments");
        return;
      }
      actions.setFindQuery(request.argumentsText);
      complete(request, "find", "completed", "displayed");
    }),
    listen<string>("agent-event-find-observation", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "find-observation", "failed", "displayed", "reason=invalid-arguments");
        return;
      }
      void actions.settleFindHighlight().then(
        () =>
          invoke<void>("report_agent_observation_find_state", {
            findState: JSON.stringify(actions.findObservation()),
          }).then(
            () => complete(request, "find-observation", "completed", "displayed"),
            () => complete(request, "find-observation", "failed", "displayed", "reason=observation-failed"),
          ),
        () => complete(request, "find-observation", "failed", "displayed", "reason=highlight-settlement-failed"),
      );
    }),
    listen<string>("agent-event-find-next", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "find-next", "failed", "displayed", "reason=invalid-arguments");
        return;
      }
      void actions.findNext().then((navigation) => {
        complete(request, "find-next", navigation.targetVisible ? "completed" : "not-found", "displayed");
      });
    }),
    listen<string>("agent-event-find-clear", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "find-clear", "failed", "displayed", "reason=invalid-arguments");
        return;
      }
      actions.findClear();
      complete(request, "find-clear", "completed", "displayed");
    }),
    listen<string>("agent-event-find-previous", (event) => {
      const request = parseAgentEventRequest(event.payload);
      if (request === null) {
        return;
      }
      if (request.argumentsText.length > 0) {
        complete(request, "find-previous", "failed", "displayed", "reason=invalid-arguments");
        return;
      }
      void actions.findPrevious().then((navigation) => {
        complete(request, "find-previous", navigation.targetVisible ? "completed" : "not-found", "displayed");
      });
    }),
  ]);

  return {
    beginWatchedMarkdownChange: () => {
      watcherReloadInFlight = pendingWatcherReload;
      pendingWatcherReload = null;
    },
    cancel: (preserveCommittedAction) => {
      supersede(pendingConfigurationNotice, "configuration-notice", "displayed");
      pendingConfigurationNotice = null;
      supersede(pendingDirectoryReady, "directory-ready", "displayed");
      pendingDirectoryReady = null;
      supersede(pendingHandoffOpen, "handoff-open", "displayed");
      pendingHandoffOpen = null;
      if (pendingPageDisplayed !== null) {
        complete(pendingPageDisplayed.request, "page-displayed", "superseded", "displayed");
        pendingPageDisplayed = null;
      }
      lastDisplayedPage = null;
      supersede(pendingReload, "reload", "displayed");
      pendingReload = null;
      if (!preserveCommittedAction) {
        supersede(handoffOpenInFlight, "handoff-open", "displayed");
        handoffOpenInFlight = null;
        supersede(watcherReloadInFlight, "watcher-reload", "displayed");
        watcherReloadInFlight = null;
        supersede(reloadInFlight, "reload", "displayed");
        reloadInFlight = null;
      }
      supersede(pendingWatcherReady, "watcher-ready", "displayed");
      pendingWatcherReady = null;
      supersede(pendingWatcherReload, "watcher-reload", "displayed");
      pendingWatcherReload = null;
      supersede(pendingScrollSettlement, "scroll-settled", "layout-settled");
      pendingScrollSettlement = null;
      scrollSettlementReportingRequestId = null;
      supersede(pendingTerminalLayout, "terminal-layout", "terminal-layout");
      pendingTerminalLayout = null;
    },
    configurationChanged: () => {
      if (pendingConfigurationNotice !== null) {
        complete(pendingConfigurationNotice, "configuration-notice", "completed", "displayed");
        pendingConfigurationNotice = null;
      }
    },
    documentOpening: () => {
      lastDisplayedPage = null;
      handoffOpenInFlight = pendingHandoffOpen;
      pendingHandoffOpen = null;
    },
    documentOpened: () => {
      if (handoffOpenInFlight !== null) {
        complete(handoffOpenInFlight, "handoff-open", "completed", "displayed");
        handoffOpenInFlight = null;
      }
    },
    layoutPageDirectoryReady: () => {
      const request = pendingDirectoryReady;
      if (request === null) {
        return;
      }
      pendingDirectoryReady = null;
      complete(request, "directory-ready", "completed", "displayed");
    },
    layoutPageDirectoryFailed: () => {
      const request = pendingDirectoryReady;
      if (request === null) {
        return;
      }
      pendingDirectoryReady = null;
      complete(request, "directory-ready", "failed", "displayed", "reason=directory-unavailable");
    },
    documentReloading: () => {
      reloadInFlight = pendingReload;
      pendingReload = null;
    },
    documentReloaded: () => {
      if (reloadInFlight !== null) {
        complete(reloadInFlight, "reload", "completed", "displayed");
        reloadInFlight = null;
      }
    },
    pageDisplayed: (sourceStart, sourceEnd, _findState) => {
      const page = {sourceStart, sourceEnd};
      lastDisplayedPage = page;
      completePageDisplayed(page);
    },
    viewportStable: (_hasTerminalLayout) => {
      const request = pendingScrollSettlement;
      if (request !== null) {
        completeScrollSettlement(request);
      }
    },
    watcherReady: () => void completeWatcherReady(),
    watchedMarkdownChanged: () => {
      if (watcherReloadInFlight !== null) {
        complete(watcherReloadInFlight, "watcher-reload", "completed", "displayed");
        watcherReloadInFlight = null;
      }
    },
  };
}
