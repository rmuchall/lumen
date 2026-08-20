import {invoke} from "@tauri-apps/api/core";
import type {LayoutPageViewport} from "./layout-page-viewport";

type TraceDetail = string | (() => string);
const maximumViewportTraceRecordBytes = 46 * 1024;
const maximumViewportTraceDetailBytes = 512;
const maximumViewportTraceRecords = 256;

type ViewportTraceRecord = {
  agentRequestId: number | null;
  detail: string;
  documentGeneration: number;
  elapsedMilliseconds: number;
  event: string;
  dragId: number | null;
  geometryRevision: number;
  inputGeneration: number;
  pageGeneration: number;
  scrollRange: number;
  scrollSourceOffset: number;
  scrollTop: number;
  sequence: number;
  viewportAnchor: number;
};

type ActiveViewportTrace = {
  bytes: number;
  documentGeneration: number;
  firstOmittedSequence: number | null;
  id: number;
  label: string;
  records: ViewportTraceRecord[];
  startedAt: number;
  truncated: boolean;
};

export type ViewportTraceSnapshot = {
  documentGeneration: number;
  firstOmittedSequence: number | null;
  id: number;
  label: string;
  records: readonly ViewportTraceRecord[];
  truncated: boolean;
};

export type ViewportTraceSummary = {
  firstOmittedSequence: number | null;
  id: number;
  recordCount: number;
  truncated: boolean;
};

export type ViewportObservationState = {
  activeAgentRequestId: number | null;
  activeDragId: number | null;
  documentGeneration: number;
  geometryRevision: number;
  inputGeneration: number;
  measurementCommitActive: boolean;
  pageGeneration: number;
  pendingPageRequest: boolean;
  readerInputActive: boolean;
  scrollWritePending: boolean;
  viewportAnchor: number;
  widthEpoch: number;
};

export type ViewportTraceCorrelation = {
  agentRequestId?: number | null;
  documentGeneration?: number;
  dragId?: number | null;
  inputGeneration?: number;
  pageGeneration?: number;
};

export type ScrollDiagnostics = {
  beginViewportTrace(traceId: number, label: string): boolean;
  endViewportTrace(traceId: number): ViewportTraceSummary | null;
  geometry(): string;
  reportScrollState(force?: boolean): Promise<void>;
  readViewportTrace(traceId: number, afterSequence: number): ViewportTraceSnapshot | null;
  trace(eventName: string, detail: TraceDetail, correlation?: ViewportTraceCorrelation): void;
};

export function createScrollDiagnostics(
  articleElement: HTMLElement,
  scrollElement: HTMLElement,
  layoutPageViewport: LayoutPageViewport,
  viewportState: () => ViewportObservationState,
): ScrollDiagnostics {
  let activeViewportTrace: ActiveViewportTrace | null = null;
  let lastScrollStateAt = 0;
  let lastKnownScrollRange = 0;
  let lastKnownScrollTop = 0;
  let scrollStateSequence = 0;

  function boundedDetail(detail: string): string {
    return detail.slice(0, maximumViewportTraceDetailBytes);
  }

  function activeTrace(): ActiveViewportTrace | null {
    return activeViewportTrace;
  }

  function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  function viewportTraceRecord(
    event: string,
    detail: string,
    correlation: ViewportTraceCorrelation | undefined,
  ): ViewportTraceRecord {
    const state = viewportState();
    const trace = activeTrace();
    return {
      agentRequestId: correlation?.agentRequestId ?? state.activeAgentRequestId,
      detail: boundedDetail(detail),
      documentGeneration: correlation?.documentGeneration ?? state.documentGeneration,
      elapsedMilliseconds: trace === null ? 0 : Number((performance.now() - trace.startedAt).toFixed(3)),
      event,
      dragId: correlation?.dragId ?? state.activeDragId,
      geometryRevision: state.geometryRevision,
      inputGeneration: correlation?.inputGeneration ?? state.inputGeneration,
      pageGeneration: correlation?.pageGeneration ?? state.pageGeneration,
      scrollRange: lastKnownScrollRange,
      // Trace capture must not synchronously interrogate rendered page geometry:
      // that can force layout and alter the interaction being measured. Exact
      // geometry remains available through explicit Agent API observations.
      scrollSourceOffset: state.viewportAnchor,
      scrollTop: lastKnownScrollTop,
      sequence: trace === null ? 0 : trace.records.length + 1,
      viewportAnchor: state.viewportAnchor,
    };
  }

  function snapshot(trace: ActiveViewportTrace, afterSequence: number): ViewportTraceSnapshot {
    return {
      documentGeneration: trace.documentGeneration,
      firstOmittedSequence: trace.firstOmittedSequence,
      id: trace.id,
      label: trace.label,
      records: trace.records.filter((record) => record.sequence > afterSequence),
      truncated: trace.truncated,
    };
  }

  function beginViewportTrace(traceId: number, label: string): boolean {
    if (
      !import.meta.env.DEV ||
      activeTrace() !== null ||
      !Number.isSafeInteger(traceId) ||
      traceId <= 0 ||
      !/^[a-z0-9-]{1,64}$/.test(label)
    ) {
      return false;
    }
    activeViewportTrace = {
      bytes: 0,
      documentGeneration: viewportState().documentGeneration,
      firstOmittedSequence: null,
      id: traceId,
      label,
      records: [],
      startedAt: performance.now(),
      truncated: false,
    };
    trace("viewport-trace-started", `trace_id=${traceId} label=${label}`);
    return true;
  }

  function readViewportTrace(traceId: number, afterSequence: number): ViewportTraceSnapshot | null {
    const trace = activeTrace();
    if (trace === null || trace.id !== traceId || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return null;
    }
    return snapshot(trace, afterSequence);
  }

  function endViewportTrace(traceId: number): ViewportTraceSummary | null {
    const currentTrace = activeTrace();
    if (currentTrace === null || currentTrace.id !== traceId) {
      return null;
    }
    trace("viewport-trace-ended", `trace_id=${traceId}`);
    const summary = {
      firstOmittedSequence: currentTrace.firstOmittedSequence,
      id: currentTrace.id,
      recordCount: currentTrace.records.length,
      truncated: currentTrace.truncated,
    };
    activeViewportTrace = null;
    return summary;
  }

  function geometry(): string {
    const maximumScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    lastKnownScrollRange = Number(maximumScroll.toFixed(3));
    lastKnownScrollTop = Number(scrollElement.scrollTop.toFixed(3));
    const viewportBounds = scrollElement.getBoundingClientRect();
    const articleBounds = articleElement.getBoundingClientRect();
    const pageContainer = articleElement.querySelector<HTMLElement>(".layout-page-window");
    const pageGeometry = Array.from(articleElement.querySelectorAll<HTMLElement>(".layout-page"))
      .slice(0, 3)
      .map((pageElement) => {
        const bounds = pageElement.getBoundingClientRect();
        return `page=${pageElement.dataset.sourceStart}:${pageElement.dataset.sourceEnd}:${(bounds.top - viewportBounds.top).toFixed(1)}:${(bounds.bottom - viewportBounds.top).toFixed(1)}:${pageElement.offsetHeight}`;
      })
      .join(" ");
    return `time=${performance.now().toFixed(1)} top=${scrollElement.scrollTop.toFixed(1)} maximum=${maximumScroll.toFixed(1)} source=${layoutPageViewport.sourceOffsetForScroll()} article_height=${articleElement.offsetHeight} article_top=${(articleBounds.top - viewportBounds.top).toFixed(1)} article_bottom=${(articleBounds.bottom - viewportBounds.top).toFixed(1)} page_container=${pageContainer?.offsetHeight ?? 0} ${pageGeometry || "page=none"} ${layoutPageViewport.agentObservation()}`;
  }

  function trace(eventName: string, detail: TraceDetail, correlation?: ViewportTraceCorrelation): void {
    const trace = activeTrace();
    if (!import.meta.env.DEV || trace === null) {
      return;
    }
    const record = viewportTraceRecord(eventName, typeof detail === "function" ? detail() : detail, correlation);
    const recordBytes = byteLength(JSON.stringify(record));
    if (
      trace.records.length === maximumViewportTraceRecords ||
      trace.bytes + recordBytes > maximumViewportTraceRecordBytes
    ) {
      trace.truncated = true;
      trace.firstOmittedSequence ??= record.sequence;
      return;
    }
    trace.records.push(record);
    trace.bytes += recordBytes;
  }

  function reportScrollState(force = false): Promise<void> {
    if (!import.meta.env.DEV) {
      return Promise.resolve();
    }
    const now = performance.now();
    if (!force && now - lastScrollStateAt < 100) {
      return Promise.resolve();
    }
    lastScrollStateAt = now;
    const scrollHeight = scrollElement.scrollHeight;
    const scrollClientHeight = scrollElement.clientHeight;
    lastKnownScrollRange = Number(Math.max(0, scrollHeight - scrollClientHeight).toFixed(3));
    lastKnownScrollTop = Number(scrollElement.scrollTop.toFixed(3));
    const viewportBounds = scrollElement.getBoundingClientRect();
    const visiblePages = Array.from(articleElement.querySelectorAll<HTMLElement>(".layout-page")).filter(
      (pageElement) => {
        const bounds = pageElement.getBoundingClientRect();
        return bounds.bottom > viewportBounds.top && bounds.top < viewportBounds.bottom;
      },
    );
    const firstVisiblePage = visiblePages[0];
    const lastVisiblePage = visiblePages.at(-1);
    const firstVisibleBounds = firstVisiblePage?.getBoundingClientRect();
    const lastVisibleBounds = lastVisiblePage?.getBoundingClientRect();
    return invoke<void>("report_agent_observation_scroll_state", {
      viewportState: formatViewportState(viewportState()),
      sequence: ++scrollStateSequence,
      scrollClientHeight,
      scrollHeight,
      scrollSourceOffset: layoutPageViewport.sourceOffsetForScroll(),
      scrollTop: scrollElement.scrollTop,
      visibleGeometry: `${firstVisiblePage?.dataset.sourceStart ?? "0"}:${lastVisiblePage?.dataset.sourceEnd ?? "0"}:${(firstVisibleBounds?.top ?? viewportBounds.top) - viewportBounds.top}:${(lastVisibleBounds?.bottom ?? viewportBounds.top) - viewportBounds.top}:${Number.parseFloat(window.getComputedStyle(articleElement).paddingBottom) || 0}`,
    });
  }

  return {
    beginViewportTrace,
    endViewportTrace,
    geometry,
    readViewportTrace,
    reportScrollState,
    trace,
  };
}

function formatViewportState(state: ViewportObservationState): string {
  return `${state.documentGeneration}:${state.inputGeneration}:${state.pageGeneration}:${state.widthEpoch}:${state.geometryRevision}:${Number(state.readerInputActive)}:${Number(state.measurementCommitActive)}:${Number(state.pendingPageRequest)}:${Number(state.scrollWritePending)}:${state.viewportAnchor}`;
}
