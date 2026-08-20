import {mkdtemp, rm} from "node:fs/promises";
import {createServer, type Server, type Socket} from "node:net";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AgentClient} from "./client.ts";

const supportedOperations = [
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
  "watcher-ready",
  "watcher-reload",
  "viewport-trace-begin",
  "viewport-trace-end",
  "viewport-trace-read",
  "zoom",
].join(",");

function helloResponse(): string {
  return `agent-api-v3 protocol=3 build=development build_version=0.1.30 capabilities=event,await,await-ready,events,status,tabs,inspection operations=${supportedOperations} observation_schemas=status,tabs,inspection,find-state,ui-state,viewport-trace,window-state,document-work-events max_request_bytes=4096 max_event_history_bytes=8192 max_inspection_bytes=65536\n`;
}

function statusResponse(): string {
  return "frontend_ready=true displayed_html_bytes=0 source_start=0 source_end=12 source_length=12 indexed_through=12 checkpoint_count=1 index_bytes=1 source_cache_bytes=1 directory_page_count=1 prepared_page_count=1 prepared_html_bytes=12 document_padding_bottom=24 scroll_state_sequence=1 scroll_source_offset=0 scroll_top=0 viewport_anchor=0 scroll_height=100 scroll_client_height=50 visible_page_count=1 visible_page_top=0 visible_page_bottom=50 visible_source_start=0 visible_source_end=12 document_generation=1 input_generation=1 page_generation=1 width_epoch=1 geometry_revision=1 reader_input_active=false measurement_commit_active=false pending_page_request=false scroll_write_pending=false find_state_sequence=0 document_work_lifecycle=accepted document_work_kind=index document_work_sequence=1 document_work_tab_id=1 document_work_tab_revision=0 document_work_source_cache_bytes=1 document_work_index_bytes=1 document_work_search_bytes=0";
}

type CommandHandler = (command: string, socket: Socket) => void;

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function event(requestId: number, operation: string, outcome = "completed", detail = "ok"): string {
  return `event-v1 request_id=${requestId} operation=${operation} outcome=${outcome} boundary=displayed sequence=${requestId} cause_request_id=0 detail=${detail}`;
}

async function withServer(handler: CommandHandler, test: (socketPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lumen-agent-api-client-"));
  const socketPath = join(root, "agent.sock");
  const sockets = new Set<Socket>();
  const server = createServer({allowHalfOpen: true}, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let command = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      command += chunk;
      if (command.endsWith("\n")) {
        handler(command.trimEnd(), socket);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  try {
    await test(socketPath);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
    await rm(root, {force: true, recursive: true});
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

async function expectFailure(action: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    assertCondition(message.includes(expected), `expected ${expected} failure, got ${message}`);
    return;
  }
  throw new Error(`expected ${expected} failure`);
}

let frontendReadyRequestCount = 0;
await withServer(
  (command, socket) => {
    if (command === "hello") {
      socket.end(helloResponse());
    } else if (command === "await-ready") {
      frontendReadyRequestCount += 1;
      socket.end(
        "event-v1 request_id=0 operation=frontend-ready outcome=completed boundary=displayed sequence=0 cause_request_id=0 detail=ready\n",
      );
    } else if (command === "event open /fixture with spaces.md") {
      socket.end("accepted 42\n");
    } else if (command === "await 42") {
      socket.end(`${event(42, "open")}\n`);
    } else if (command === "status") {
      socket.end(`${statusResponse()}\n`);
    } else if (command === "document-work-events") {
      socket.end("document_work_events=1\nsequence=1 kind=index lifecycle=accepted tab_id=1 tab_revision=0\n");
    } else if (command === "tabs") {
      socket.end(
        "tab_count=1\ntab_id=1 revision=1 active=true stale=false frozen=false scroll_position=0 source_offset=0\n",
      );
    } else if (command === "window-state") {
      socket.end(
        "visible=true enabled=true minimized=false maximized=false focused=true zoom_factor=1 test_guard_active=false test_guard_tier=initializing test_guard_phase=initializing\n",
      );
    } else if (command === "event displayed-html 0 13") {
      socket.end("accepted 43\n");
    } else if (command === "await 43") {
      socket.end(`${event(43, "displayed-html", "completed", "offset=0.total_bytes=13.response_bytes=13")}\n`);
    } else if (command === "displayed-html 43") {
      socket.end("displayed_html_bytes=13 response_bytes=13\nMarkdown text");
    } else if (command === "event displayed-html 0 14") {
      socket.end("accepted 44\n");
    } else if (command === "await 44") {
      socket.end(`${event(44, "displayed-html", "completed", "offset=0.total_bytes=14.response_bytes=14")}\n`);
    } else if (command === "displayed-html 44") {
      socket.end("displayed_html_bytes=14 response_bytes=14\nMarkdown text\n");
    } else if (command === "event viewport-trace-begin drag-profile") {
      socket.end("accepted 45\n");
    } else if (command === "await 45") {
      socket.end(`${event(45, "viewport-trace-begin", "completed", "trace_id=45")}\n`);
    } else if (command === "event viewport-trace-read 45 0") {
      socket.end("accepted 46\n");
    } else if (command === "await 46") {
      socket.end(`${event(46, "viewport-trace-read", "completed", "trace_id=45.record_count=1.truncated=false")}\n`);
    } else if (command === "viewport-trace 45") {
      socket.end(
        JSON.stringify({
          documentGeneration: 1,
          firstOmittedSequence: null,
          id: 45,
          label: "drag-profile",
          records: [
            {
              agentRequestId: 42,
              detail: "source=1",
              documentGeneration: 1,
              elapsedMilliseconds: 1,
              event: "native-scroll-received",
              dragId: 41,
              geometryRevision: 1,
              inputGeneration: 1,
              pageGeneration: 1,
              scrollRange: 50,
              scrollSourceOffset: 1,
              scrollTop: 1,
              sequence: 1,
              viewportAnchor: 1,
            },
          ],
          truncated: false,
        }),
      );
    } else if (command === "event viewport-trace-end 45") {
      socket.end("accepted 47\n");
    } else if (command === "await 47") {
      socket.end(`${event(47, "viewport-trace-end", "completed", "trace_id=45.record_count=1.truncated=false")}\n`);
    } else if (command === "event find-observation") {
      socket.end("accepted 48\n");
    } else if (command === "await 48") {
      socket.end(`${event(48, "find-observation")}\n`);
    } else if (command === "find-state") {
      socket.end(
        JSON.stringify({
          activeMatchIndex: 0,
          activeMatchText: "query",
          activeRangeConnected: true,
          activeRangeRectCount: 1,
          fullDocumentMatchCount: 1,
          highlightMatchesActiveRange: true,
          highlightRectCount: 1,
          inputFocused: true,
          lastNavigationOffset: 0,
          panelVisible: true,
          query: "query",
          statusText: "1 of 1 visible · 1 total",
          visibleMatchCount: 1,
        }),
      );
    } else {
      socket.end("error=unexpected-command\n");
    }
  },
  async (socketPath) => {
    const client = new AgentClient(socketPath);
    const completion = await client.sendAndAwait("open", "/fixture with spaces.md");
    assertCondition(completion.requestId === 42 && completion.operation === "open", "request correlation failed");
    assertCondition((await client.status()).sourceLength === 12, "status observation parsing failed");
    assertCondition(
      (await client.documentWorkEvents())[0]?.lifecycle === "accepted",
      "document-work observation parsing failed",
    );
    assertCondition((await client.tabs())[0]?.active === true, "tab observation parsing failed");
    assertCondition((await client.windowState()).zoomFactor === 1, "window observation parsing failed");
    assertCondition((await client.displayedHtml(0, 13)).content === "Markdown text", "inspection parsing failed");
    assertCondition(
      (await client.displayedHtml(0, 14)).content === "Markdown text\n",
      "inspection parsing must preserve trailing whitespace",
    );
    const traceId = await client.beginViewportTrace("drag-profile");
    assertCondition(traceId === 45, "viewport trace begin parsing failed");
    const trace = await client.readViewportTrace(traceId);
    assertCondition(trace.records[0]?.event === "native-scroll-received", "viewport trace parsing failed");
    assertCondition(
      trace.records[0]?.agentRequestId === 42 && trace.records[0]?.dragId === 41,
      "viewport trace correlation parsing failed",
    );
    assertCondition((await client.endViewportTrace(traceId)).outcome === "completed", "viewport trace end failed");
    assertCondition((await client.findState()).highlightMatchesActiveRange, "Find observation parsing failed");
    assertCondition(
      frontendReadyRequestCount === 1,
      "Agent client repeated its ready handshake after frontend readiness",
    );
  },
);

let nextSocketAssignedRequestId = 1;
await withServer(
  (command, socket) => {
    if (command === "hello") {
      socket.end(helloResponse());
    } else if (command === "await-ready") {
      socket.end(
        "event-v1 request_id=0 operation=frontend-ready outcome=completed boundary=displayed sequence=0 cause_request_id=0 detail=ready\n",
      );
    } else if (command === "event open /first.md" || command === "event open /second.md") {
      const requestId = nextSocketAssignedRequestId;
      nextSocketAssignedRequestId += 1;
      socket.end(`accepted ${requestId}\n`);
    } else if (command === "await 1") {
      socket.end(`${event(1, "open")}\n`);
    } else if (command === "await 2") {
      socket.end(`${event(2, "open")}\n`);
    } else {
      socket.end("error=unexpected-command\n");
    }
  },
  async (socketPath) => {
    const firstClient = new AgentClient(socketPath);
    const secondClient = new AgentClient(socketPath);
    const first = await firstClient.sendAndAwait("open", "/first.md");
    const second = await secondClient.sendAndAwait("open", "/second.md");
    assertCondition(first.requestId === 1 && second.requestId === 2, "socket did not allocate unique request IDs");
  },
);

await withServer(
  (command, socket) => {
    if (command === "hello") {
      socket.end(helloResponse());
    } else if (command === "await-ready") {
      socket.end(
        "event-v1 request_id=0 operation=frontend-ready outcome=completed boundary=displayed sequence=0 cause_request_id=0 detail=ready\n",
      );
    } else if (command === "event find query") {
      socket.end("accepted 1\n");
    } else if (command === "await 1") {
      socket.end(`${event(2, "find")}\n`);
    } else {
      socket.end("error=unexpected-command\n");
    }
  },
  async (socketPath) => {
    const client = new AgentClient(socketPath);
    const requestId = await client.begin("find", "query");
    await expectFailure(() => client.await(requestId), "invalid agent API completion");
  },
);

await withServer(
  (command, socket) => {
    if (command === "hello") {
      socket.end("malformed-response\n");
    } else if (command === "await-ready") {
      socket.end("malformed-response\n");
    } else {
      socket.end("error=unexpected-command\n");
    }
  },
  async (socketPath) => {
    await expectFailure(() => new AgentClient(socketPath).awaitReady(), "invalid agent API hello response");
  },
);

await withServer(
  (command, socket) => {
    if (command !== "hello") {
      socket.end("error=unexpected-command\n");
    }
  },
  async (socketPath) => {
    await expectFailure(() => new AgentClient(socketPath, {requestTimeoutMilliseconds: 20}).awaitReady(), "timed out");
  },
);

process.stdout.write("agent API client tests passed\n");
