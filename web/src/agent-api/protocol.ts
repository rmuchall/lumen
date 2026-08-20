export type AgentOperation =
  | "close"
  | "close-tabs"
  | "configuration-notice"
  | "copy-path"
  | "directory-ready"
  | "displayed-html"
  | "drag-begin"
  | "drag-end"
  | "find"
  | "find-clear"
  | "find-next"
  | "find-observation"
  | "find-previous"
  | "focus"
  | "handoff-open"
  | "link"
  | "notice-action"
  | "notice-dismiss"
  | "open"
  | "page-displayed"
  | "reload"
  | "scroll"
  | "scroll-settled"
  | "seek"
  | "select-tab"
  | "terminal-layout"
  | "test-run-state"
  | "zoom"
  | "watcher-ready"
  | "watcher-reload"
  | "viewport-trace-begin"
  | "viewport-trace-end"
  | "viewport-trace-read";

export type AgentOutcome = "completed" | "failed" | "no-op" | "not-found" | "stale" | "superseded" | "unavailable";

export type AgentBoundary = "displayed" | "input-consumed" | "layout-settled" | "terminal-layout";

export type AgentEventRequest = {
  argumentsText: string;
  requestId: number;
};

export function parseAgentEventRequest(payload: string): AgentEventRequest | null {
  const separator = payload.indexOf("\t");
  const requestIdText = separator === -1 ? payload : payload.slice(0, separator);
  const requestId = Number(requestIdText);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    return null;
  }
  return {argumentsText: separator === -1 ? "" : payload.slice(separator + 1), requestId};
}
