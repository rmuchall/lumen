import {stat, watch} from "node:fs/promises";
import {connect} from "node:net";
import {basename, dirname} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const requestTimeoutMilliseconds = 20_000;

type AgentClientOptions = {requestTimeoutMilliseconds?: number};

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

export type AgentCompletion = {
  boundary: string;
  causeRequestId: number;
  detail: string;
  operation: string;
  outcome: string;
  requestId: number;
  sequence: number;
};

export type AgentCapability = "await" | "await-ready" | "event" | "events" | "inspection" | "status" | "tabs";
export type AgentObservationSchema =
  | "document-work-events"
  | "find-state"
  | "inspection"
  | "viewport-trace"
  | "status"
  | "tabs"
  | "ui-state"
  | "window-state";

export type AgentCapabilities = {
  build: string;
  buildVersion: string;
  capabilities: readonly AgentCapability[];
  maxEventHistoryBytes: number;
  maxInspectionBytes: number;
  maxRequestBytes: number;
  observationSchemas: readonly AgentObservationSchema[];
  operations: readonly AgentOperation[];
  protocolVersion: number;
};

export type AgentStatus = {
  documentWorkLifecycle: string;
  documentWorkKind: string;
  documentWorkBytes: number;
  documentWorkSearchBytes: number;
  documentWorkSourceCacheBytes: number;
  documentWorkSequence: number;
  documentWorkTabId: number;
  documentWorkTabRevision: number;
  checkpointCount: number;
  directoryPageCount: number;
  displayedHtmlBytes: number;
  documentPaddingBottom: number;
  documentGeneration: number;
  findStateSequence: number;
  frontendReady: boolean;
  geometryRevision: number;
  indexBytes: number;
  indexedThrough: number;
  inputGeneration: number;
  preparedHtmlBytes: number;
  preparedPageCount: number;
  measurementCommitActive: boolean;
  pageGeneration: number;
  pendingPageRequest: boolean;
  readerInputActive: boolean;
  scrollClientHeight: number;
  scrollHeight: number;
  scrollSourceOffset: number;
  scrollStateSequence: number;
  scrollTop: number;
  sourceCacheBytes: number;
  sourceEnd: number;
  sourceLength: number;
  sourceStart: number;
  scrollWritePending: boolean;
  viewportAnchor: number;
  visiblePageBottom: number;
  visiblePageCount: number;
  visiblePageTop: number;
  visibleSourceEnd: number;
  visibleSourceStart: number;
};

export type AgentTab = {
  active: boolean;
  frozen: boolean;
  id: number;
  revision: number;
  scrollPosition: number;
  sourceOffset: number;
  stale: boolean;
};

export type AgentWindowState = {
  enabled: boolean;
  focused: boolean;
  maximized: boolean;
  minimized: boolean;
  testGuardActive: boolean;
  testGuardPhase: string;
  testGuardTier: string;
  visible: boolean;
  zoomFactor: number;
};

export type AgentNotice = {
  dismissLabel: string;
  hasAction: boolean;
  kind: "information" | "warning" | "error";
  message: string;
  role: string;
  source: "configuration" | "document";
  title: string;
};

export type DocumentWorkEvent = {
  kind: string;
  lifecycle: string;
  sequence: number;
  tabId: number;
  tabRevision: number;
};

export type AgentInspection = {
  bytes: number;
  content: string;
  responseBytes: number;
};

export type AgentFindState = {
  activeMatchIndex: number;
  activeMatchText: string;
  activeRangeConnected: boolean;
  activeRangeRectCount: number;
  fullDocumentMatchCount: number | null;
  highlightMatchesActiveRange: boolean;
  highlightRectCount: number;
  inputFocused: boolean;
  lastNavigationOffset: number | null;
  panelVisible: boolean;
  query: string;
  statusText: string;
  visibleMatchCount: number;
};

export type ViewportTraceRecord = {
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

export type ViewportTraceSnapshot = {
  documentGeneration: number;
  firstOmittedSequence: number | null;
  id: number;
  label: string;
  records: readonly ViewportTraceRecord[];
  truncated: boolean;
};

export class AgentClient {
  #capabilities: AgentCapabilities | null = null;
  #frontendReady = false;
  #socketPath: string;
  #requestTimeoutMilliseconds: number;

  constructor(socketPath: string, options: AgentClientOptions = {}) {
    this.#socketPath = socketPath;
    this.#requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? requestTimeoutMilliseconds;
  }

  async sendAndAwait(operation: AgentOperation, argumentsText = ""): Promise<AgentCompletion> {
    return this.await(await this.begin(operation, argumentsText));
  }

  async begin(operation: AgentOperation, argumentsText = ""): Promise<number> {
    if (!this.#frontendReady) {
      await this.awaitReady();
    }
    if (!this.#capabilities?.operations.includes(operation)) {
      throw new Error(`agent API operation is unavailable: ${operation}`);
    }
    const command = `event ${operation}${argumentsText.length === 0 ? "" : ` ${argumentsText}`}`;
    const accepted = await controlRequest(this.#socketPath, command, this.#requestTimeoutMilliseconds);
    const requestId = Number(accepted.match(/^accepted ([1-9]\d*)$/)?.[1]);
    if (!Number.isSafeInteger(requestId)) {
      throw new Error(`agent API event was not accepted: ${accepted}`);
    }
    return requestId;
  }

  async await(requestId: number): Promise<AgentCompletion> {
    const response = await controlRequest(this.#socketPath, `await ${requestId}`, null);
    try {
      return parseCompletion(response, requestId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const [status, documentWorkEvents, eventHistory] = await Promise.allSettled([
        this.status(),
        this.documentWorkEvents(),
        this.events(),
      ]);
      const statusDetail = status.status === "fulfilled" ? JSON.stringify(status.value) : "unavailable";
      const documentWorkDetail =
        documentWorkEvents.status === "fulfilled" ? JSON.stringify(documentWorkEvents.value) : "unavailable";
      const eventHistoryDetail =
        eventHistory.status === "fulfilled" ? JSON.stringify(eventHistory.value.slice(-16)) : "unavailable";
      throw new Error(
        `agent API await failed for request ${requestId}: ${message}; status=${statusDetail}; document_work_events=${documentWorkDetail}; event_history=${eventHistoryDetail}`,
      );
    }
  }

  async awaitReady(): Promise<void> {
    if (this.#frontendReady) {
      return;
    }
    await this.hello();
    const response = await controlRequest(this.#socketPath, "await-ready", null);
    const completion = parseEvent(response);
    if (completion.operation !== "frontend-ready" || completion.outcome !== "completed") {
      throw new Error(`agent API frontend was not ready: ${response}`);
    }
    this.#frontendReady = true;
  }

  async hello(): Promise<AgentCapabilities> {
    if (this.#capabilities !== null) {
      return this.#capabilities;
    }
    const response = await controlRequest(this.#socketPath, "hello", this.#requestTimeoutMilliseconds);
    this.#capabilities = parseHello(response);
    return this.#capabilities;
  }

  async status(): Promise<AgentStatus> {
    return parseStatus(await controlRequest(this.#socketPath, "status", this.#requestTimeoutMilliseconds));
  }

  async documentWorkEvents(): Promise<readonly DocumentWorkEvent[]> {
    return parseDocumentWorkEvents(
      await controlRequest(this.#socketPath, "document-work-events", this.#requestTimeoutMilliseconds),
    );
  }

  async events(afterSequence = 0): Promise<readonly AgentCompletion[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error(`invalid agent API event sequence: ${afterSequence}`);
    }
    const response = await controlRequest(
      this.#socketPath,
      `events ${afterSequence}`,
      this.#requestTimeoutMilliseconds,
    );
    if (response.length === 0) {
      return [];
    }
    return response
      .trimEnd()
      .split("\n")
      .map((line) => parseEvent(line));
  }

  async tabs(): Promise<readonly AgentTab[]> {
    return parseTabs(await controlRequest(this.#socketPath, "tabs", this.#requestTimeoutMilliseconds));
  }

  async windowState(): Promise<AgentWindowState> {
    return parseWindowState(await controlRequest(this.#socketPath, "window-state", this.#requestTimeoutMilliseconds));
  }

  async notices(): Promise<readonly AgentNotice[]> {
    const probe = await controlRequest(this.#socketPath, "ui-probe", this.#requestTimeoutMilliseconds);
    const previousSequence = Number(probe.match(/after_sequence=(\d+)/)?.[1]);
    if (!Number.isSafeInteger(previousSequence)) {
      throw new Error(`invalid Agent API notice probe: ${probe}`);
    }
    const deadline = Date.now() + this.#requestTimeoutMilliseconds;
    let response = "";
    while (Date.now() < deadline) {
      const observation = await controlRequest(this.#socketPath, "ui-state", this.#requestTimeoutMilliseconds);
      const match = observation.match(/^ui_state_sequence=(\d+) (.*)$/s);
      if (match !== null && Number(match[1]) > previousSequence) {
        response = match[2] ?? "";
        break;
      }
      await sleep(10);
    }
    if (response.length === 0) {
      throw new Error("timed out waiting for the Agent API notice observation");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response);
    } catch {
      throw new Error(`invalid Agent API notice observation: ${response}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isAgentNotice)) {
      throw new Error(`invalid Agent API notice observation: ${response}`);
    }
    return parsed;
  }

  async displayedHtml(offset: number, length: number): Promise<AgentInspection> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
      throw new Error(`invalid displayed HTML inspection range: ${offset} ${length}`);
    }
    const completion = await this.sendAndAwait("displayed-html", `${offset} ${length}`);
    if (completion.outcome !== "completed") {
      throw new Error(`displayed HTML inspection failed: ${JSON.stringify(completion)}`);
    }
    return parseInspection(
      await socketRequest(this.#socketPath, `displayed-html ${completion.requestId}`, this.#requestTimeoutMilliseconds),
      "displayed_html",
    );
  }

  async findState(): Promise<AgentFindState> {
    const completion = await this.sendAndAwait("find-observation");
    if (completion.outcome !== "completed") {
      throw new Error(`agent API Find observation failed: ${JSON.stringify(completion)}`);
    }
    return parseFindState(await socketRequest(this.#socketPath, "find-state", this.#requestTimeoutMilliseconds));
  }

  async beginPointerDrag(): Promise<number> {
    const completion = await this.sendAndAwait("drag-begin");
    const dragId = Number(completion.detail.match(/(?:^| )drag_id=(\d+)(?: |$)/)?.[1]);
    if (completion.outcome !== "completed" || !Number.isSafeInteger(dragId) || dragId <= 0) {
      throw new Error(`agent API pointer drag did not begin: ${JSON.stringify(completion)}`);
    }
    return dragId;
  }

  async endPointerDrag(dragId: number): Promise<AgentCompletion> {
    return this.sendAndAwait("drag-end", String(dragId));
  }

  async quit(): Promise<void> {
    const response = await controlRequest(this.#socketPath, "quit", this.#requestTimeoutMilliseconds);
    if (response !== "quitting") {
      throw new Error(`agent API quit failed: ${response}`);
    }
  }

  async beginViewportTrace(label: string): Promise<number> {
    const completion = await this.sendAndAwait("viewport-trace-begin", label);
    const traceId = Number(completion.detail.match(/(?:^| )trace_id=(\d+)(?:\.| |$)/)?.[1]);
    if (completion.outcome !== "completed" || !Number.isSafeInteger(traceId) || traceId <= 0) {
      throw new Error(`agent API viewport trace did not start: ${JSON.stringify(completion)}`);
    }
    return traceId;
  }

  async readViewportTrace(traceId: number, afterSequence = 0): Promise<ViewportTraceSnapshot> {
    const completion = await this.sendAndAwait("viewport-trace-read", `${traceId} ${afterSequence}`);
    if (completion.outcome !== "completed") {
      throw new Error(`agent API viewport trace read failed: ${JSON.stringify(completion)}`);
    }
    return parseViewportTrace(
      await socketRequest(this.#socketPath, `viewport-trace ${traceId}`, this.#requestTimeoutMilliseconds),
      traceId,
    );
  }

  async endViewportTrace(traceId: number): Promise<AgentCompletion> {
    return this.sendAndAwait("viewport-trace-end", String(traceId));
  }
}

export async function awaitAgentReady(socketPath: string): Promise<AgentClient> {
  const client = new AgentClient(socketPath);
  await waitForSocketCreation(socketPath);
  await client.awaitReady();
  return client;
}

function parseCompletion(response: string, requestId: number): AgentCompletion {
  const completion = parseEvent(response);
  if (completion.requestId !== requestId) {
    throw new Error(`invalid agent API completion: ${response}`);
  }
  return completion;
}

function parseEvent(response: string): AgentCompletion {
  const [header, ...fields] = response.split(" ");
  if (header !== "event-v1") {
    throw new Error(`invalid agent API event: ${response}`);
  }
  const values = new Map(fields.map(parseField).filter((field): field is readonly [string, string] => field !== null));
  const requestId = Number(values.get("request_id"));
  const sequence = Number(values.get("sequence"));
  const causeRequestId = Number(values.get("cause_request_id"));
  const operation = values.get("operation");
  const outcome = values.get("outcome");
  const boundary = values.get("boundary");
  if (
    !Number.isSafeInteger(requestId) ||
    !Number.isSafeInteger(sequence) ||
    !Number.isSafeInteger(causeRequestId) ||
    operation === undefined ||
    outcome === undefined ||
    boundary === undefined
  ) {
    throw new Error(`invalid agent API event: ${response}`);
  }
  return {
    boundary,
    causeRequestId,
    detail: values.get("detail") ?? "",
    operation,
    outcome,
    requestId,
    sequence,
  };
}

function parseHello(response: string): AgentCapabilities {
  const [header, ...fields] = response.split(" ");
  const versionText = header.match(/^agent-api-v(\d+)$/)?.[1];
  const values = new Map(fields.map(parseField).filter((field): field is readonly [string, string] => field !== null));
  const protocolVersion = Number(versionText);
  const build = values.get("build");
  const buildVersion = values.get("build_version");
  const declaredVersion = Number(values.get("protocol"));
  const maxRequestBytes = Number(values.get("max_request_bytes"));
  const maxEventHistoryBytes = Number(values.get("max_event_history_bytes"));
  const maxInspectionBytes = Number(values.get("max_inspection_bytes"));
  const operationNames = values.get("operations")?.split(",") ?? [];
  const operations = operationNames.filter(isAgentOperation);
  const capabilityNames = values.get("capabilities")?.split(",") ?? [];
  const capabilities = capabilityNames.filter(isAgentCapability);
  const observationSchemaNames = values.get("observation_schemas")?.split(",") ?? [];
  const observationSchemas = observationSchemaNames.filter(isAgentObservationSchema);
  if (
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion !== 3 ||
    declaredVersion !== protocolVersion ||
    !Number.isSafeInteger(maxRequestBytes) ||
    !Number.isSafeInteger(maxEventHistoryBytes) ||
    !Number.isSafeInteger(maxInspectionBytes) ||
    build !== "development" ||
    buildVersion === undefined ||
    capabilityNames.length === 0 ||
    capabilities.length !== capabilityNames.length ||
    observationSchemaNames.length === 0 ||
    observationSchemas.length !== observationSchemaNames.length ||
    operationNames.length === 0 ||
    operations.length !== operationNames.length
  ) {
    throw new Error(`invalid agent API hello response: ${response}`);
  }
  return {
    build,
    buildVersion,
    capabilities,
    maxEventHistoryBytes,
    maxInspectionBytes,
    maxRequestBytes,
    observationSchemas,
    operations,
    protocolVersion,
  };
}

function parseField(field: string): readonly [string, string] | null {
  const separator = field.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  return [field.slice(0, separator), field.slice(separator + 1)];
}

function isAgentNotice(value: unknown): value is AgentNotice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const notice = value as Record<string, unknown>;
  return (
    typeof notice.hasAction === "boolean" &&
    typeof notice.dismissLabel === "string" &&
    ["information", "warning", "error"].includes(String(notice.kind)) &&
    typeof notice.message === "string" &&
    typeof notice.role === "string" &&
    ["configuration", "document"].includes(String(notice.source)) &&
    typeof notice.title === "string"
  );
}

function isAgentCapability(value: string): value is AgentCapability {
  return ["await", "await-ready", "event", "events", "inspection", "status", "tabs"].includes(value as AgentCapability);
}

function isAgentObservationSchema(value: string): value is AgentObservationSchema {
  return [
    "document-work-events",
    "find-state",
    "inspection",
    "viewport-trace",
    "status",
    "tabs",
    "ui-state",
    "window-state",
  ].includes(value as AgentObservationSchema);
}

function isAgentOperation(operation: string): operation is AgentOperation {
  return [
    "close",
    "close-tabs",
    "configuration-notice",
    "copy-path",
    "directory-ready",
    "displayed-html",
    "drag-begin",
    "drag-end",
    "find",
    "find-clear",
    "find-next",
    "find-observation",
    "find-previous",
    "focus",
    "handoff-open",
    "link",
    "notice-action",
    "notice-dismiss",
    "open",
    "page-displayed",
    "reload",
    "scroll",
    "scroll-settled",
    "seek",
    "select-tab",
    "terminal-layout",
    "test-run-state",
    "zoom",
    "watcher-ready",
    "watcher-reload",
    "viewport-trace-begin",
    "viewport-trace-end",
    "viewport-trace-read",
  ].includes(operation as AgentOperation);
}

function parseViewportTrace(response: string, traceId: number): ViewportTraceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error("invalid agent API viewport trace JSON");
  }
  if (!isViewportTraceSnapshot(parsed) || parsed.id !== traceId) {
    throw new Error("invalid agent API viewport trace");
  }
  return parsed;
}

function parseFindState(response: string): AgentFindState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error("invalid agent API Find observation JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid agent API Find observation");
  }
  const state = parsed as Record<string, unknown>;
  const nullableInteger = (value: unknown): value is number | null =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value));
  if (
    !Number.isSafeInteger(state.activeMatchIndex) ||
    typeof state.activeMatchText !== "string" ||
    typeof state.activeRangeConnected !== "boolean" ||
    !Number.isSafeInteger(state.activeRangeRectCount) ||
    !nullableInteger(state.fullDocumentMatchCount) ||
    typeof state.highlightMatchesActiveRange !== "boolean" ||
    !Number.isSafeInteger(state.highlightRectCount) ||
    typeof state.inputFocused !== "boolean" ||
    !nullableInteger(state.lastNavigationOffset) ||
    typeof state.panelVisible !== "boolean" ||
    typeof state.query !== "string" ||
    typeof state.statusText !== "string" ||
    !Number.isSafeInteger(state.visibleMatchCount)
  ) {
    throw new Error("invalid agent API Find observation");
  }
  return state as AgentFindState;
}

function isViewportTraceSnapshot(value: unknown): value is ViewportTraceSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(snapshot.id) &&
    typeof snapshot.label === "string" &&
    Number.isSafeInteger(snapshot.documentGeneration) &&
    (Number.isSafeInteger(snapshot.firstOmittedSequence) || snapshot.firstOmittedSequence === null) &&
    typeof snapshot.truncated === "boolean" &&
    Array.isArray(snapshot.records) &&
    snapshot.records.every(isViewportTraceRecord)
  );
}

function isViewportTraceRecord(value: unknown): value is ViewportTraceRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const nullableInteger = (field: unknown): field is number | null =>
    field === null || (typeof field === "number" && Number.isSafeInteger(field));
  return (
    nullableInteger(record.agentRequestId) &&
    Number.isSafeInteger(record.sequence) &&
    typeof record.event === "string" &&
    nullableInteger(record.dragId) &&
    typeof record.detail === "string" &&
    typeof record.elapsedMilliseconds === "number" &&
    typeof record.scrollTop === "number" &&
    typeof record.scrollRange === "number" &&
    Number.isSafeInteger(record.scrollSourceOffset) &&
    Number.isSafeInteger(record.documentGeneration) &&
    Number.isSafeInteger(record.inputGeneration) &&
    Number.isSafeInteger(record.pageGeneration) &&
    Number.isSafeInteger(record.geometryRevision) &&
    Number.isSafeInteger(record.viewportAnchor)
  );
}

function parseFields(response: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const field of response.split(/\s+/)) {
    const separator = field.indexOf("=");
    if (separator > 0) {
      fields.set(field.slice(0, separator), field.slice(separator + 1));
    }
  }
  return fields;
}

function numberField(fields: ReadonlyMap<string, string>, name: string): number {
  const value = Number(fields.get(name));
  if (!Number.isFinite(value)) {
    throw new Error(`invalid agent API numeric ${name}`);
  }
  return value;
}

function booleanField(fields: ReadonlyMap<string, string>, name: string): boolean {
  const value = fields.get(name);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid agent API boolean ${name}`);
}

function parseStatus(response: string): AgentStatus {
  const fields = parseFields(response);
  return {
    documentWorkLifecycle: fields.get("document_work_lifecycle") ?? "",
    documentWorkKind: fields.get("document_work_kind") ?? "",
    documentWorkBytes: numberField(fields, "document_work_index_bytes"),
    documentWorkSearchBytes: numberField(fields, "document_work_search_bytes"),
    documentWorkSourceCacheBytes: numberField(fields, "document_work_source_cache_bytes"),
    documentWorkSequence: numberField(fields, "document_work_sequence"),
    documentWorkTabId: numberField(fields, "document_work_tab_id"),
    documentWorkTabRevision: numberField(fields, "document_work_tab_revision"),
    checkpointCount: numberField(fields, "checkpoint_count"),
    directoryPageCount: numberField(fields, "directory_page_count"),
    displayedHtmlBytes: numberField(fields, "displayed_html_bytes"),
    documentPaddingBottom: numberField(fields, "document_padding_bottom"),
    documentGeneration: numberField(fields, "document_generation"),
    findStateSequence: numberField(fields, "find_state_sequence"),
    frontendReady: booleanField(fields, "frontend_ready"),
    geometryRevision: numberField(fields, "geometry_revision"),
    indexBytes: numberField(fields, "index_bytes"),
    indexedThrough: numberField(fields, "indexed_through"),
    inputGeneration: numberField(fields, "input_generation"),
    preparedHtmlBytes: numberField(fields, "prepared_html_bytes"),
    preparedPageCount: numberField(fields, "prepared_page_count"),
    measurementCommitActive: booleanField(fields, "measurement_commit_active"),
    pageGeneration: numberField(fields, "page_generation"),
    pendingPageRequest: booleanField(fields, "pending_page_request"),
    readerInputActive: booleanField(fields, "reader_input_active"),
    scrollClientHeight: numberField(fields, "scroll_client_height"),
    scrollHeight: numberField(fields, "scroll_height"),
    scrollSourceOffset: numberField(fields, "scroll_source_offset"),
    scrollStateSequence: numberField(fields, "scroll_state_sequence"),
    scrollTop: numberField(fields, "scroll_top"),
    sourceCacheBytes: numberField(fields, "source_cache_bytes"),
    sourceEnd: numberField(fields, "source_end"),
    sourceLength: numberField(fields, "source_length"),
    sourceStart: numberField(fields, "source_start"),
    scrollWritePending: booleanField(fields, "scroll_write_pending"),
    viewportAnchor: numberField(fields, "viewport_anchor"),
    visiblePageBottom: numberField(fields, "visible_page_bottom"),
    visiblePageCount: numberField(fields, "visible_page_count"),
    visiblePageTop: numberField(fields, "visible_page_top"),
    visibleSourceEnd: numberField(fields, "visible_source_end"),
    visibleSourceStart: numberField(fields, "visible_source_start"),
  };
}

function parseDocumentWorkEvents(response: string): readonly DocumentWorkEvent[] {
  const [header, ...lines] = response.split("\n");
  const count = Number(parseFields(header).get("document_work_events"));
  if (!Number.isSafeInteger(count) || count < 0 || lines.length !== count) {
    throw new Error("invalid document work event response");
  }
  return lines.map((line) => {
    const fields = parseFields(line);
    const lifecycle = fields.get("lifecycle");
    const kind = fields.get("kind");
    if (lifecycle === undefined || kind === undefined) {
      throw new Error("invalid document work lifecycle");
    }
    return {
      kind,
      lifecycle,
      sequence: numberField(fields, "sequence"),
      tabId: numberField(fields, "tab_id"),
      tabRevision: numberField(fields, "tab_revision"),
    };
  });
}

function parseTabs(response: string): readonly AgentTab[] {
  const [header, ...lines] = response.split("\n");
  const count = numberField(parseFields(header ?? ""), "tab_count");
  const tabs = lines.map((line) => {
    const fields = parseFields(line);
    return {
      active: booleanField(fields, "active"),
      frozen: booleanField(fields, "frozen"),
      id: numberField(fields, "tab_id"),
      revision: numberField(fields, "revision"),
      scrollPosition: numberField(fields, "scroll_position"),
      sourceOffset: numberField(fields, "source_offset"),
      stale: booleanField(fields, "stale"),
    };
  });
  if (
    tabs.length !== count ||
    tabs.some((tab) => !Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.sourceOffset))
  ) {
    throw new Error("invalid agent API tab observation");
  }
  return tabs;
}

function parseWindowState(response: string): AgentWindowState {
  const fields = parseFields(response);
  return {
    enabled: booleanField(fields, "enabled"),
    focused: booleanField(fields, "focused"),
    maximized: booleanField(fields, "maximized"),
    minimized: booleanField(fields, "minimized"),
    testGuardActive: booleanField(fields, "test_guard_active"),
    testGuardPhase: fields.get("test_guard_phase") ?? "",
    testGuardTier: fields.get("test_guard_tier") ?? "",
    visible: booleanField(fields, "visible"),
    zoomFactor: numberField(fields, "zoom_factor"),
  };
}

function parseInspection(response: string, label: string): AgentInspection {
  const separator = response.indexOf("\n");
  const header = separator === -1 ? response : response.slice(0, separator);
  const content = separator === -1 ? "" : response.slice(separator + 1);
  const fields = parseFields(header);
  const bytes = numberField(fields, `${label}_bytes`);
  const responseBytes = numberField(fields, "response_bytes");
  if (Buffer.byteLength(content, "utf8") !== responseBytes) {
    throw new Error("invalid agent API inspection response length");
  }
  return {bytes, content, responseBytes};
}

function socketRequest(socketPath: string, command: string, timeoutMilliseconds: number | null): Promise<string> {
  return new Promise<string>((resolveRequest, rejectRequest) => {
    const connection = connect(socketPath);
    const chunks: string[] = [];
    const timeout =
      timeoutMilliseconds === null
        ? null
        : setTimeout(() => {
            connection.destroy();
            rejectRequest(new Error(`agent API request timed out: ${command}`));
          }, timeoutMilliseconds);
    connection.setEncoding("utf8");
    connection.once("error", (error) => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      rejectRequest(error);
    });
    connection.on("data", (chunk: string | Buffer) => chunks.push(chunk.toString()));
    connection.once("end", () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      resolveRequest(chunks.join(""));
    });
    connection.once("connect", () => connection.end(`${command}\n`));
  });
}

async function controlRequest(
  socketPath: string,
  command: string,
  timeoutMilliseconds: number | null,
): Promise<string> {
  return (await socketRequest(socketPath, command, timeoutMilliseconds)).trim();
}

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    return (await stat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

async function waitForSocketCreation(socketPath: string): Promise<void> {
  const timeout = AbortSignal.timeout(requestTimeoutMilliseconds);
  const watcher = watch(dirname(socketPath), {persistent: false, signal: timeout});
  try {
    if (await socketExists(socketPath)) {
      return;
    }
    for await (const event of watcher) {
      if (event.filename == null || event.filename.toString() !== basename(socketPath)) {
        continue;
      }
      if (await socketExists(socketPath)) {
        return;
      }
    }
  } catch (error: unknown) {
    if (timeout.aborted) {
      throw new Error(`agent socket was not created: ${socketPath}`);
    }
    throw error;
  } finally {
    void watcher.return?.();
  }
}
