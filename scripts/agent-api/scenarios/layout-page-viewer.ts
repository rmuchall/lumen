import {open, stat} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {generatePerformanceFixtures} from "../../testing/generate-performance-fixtures.ts";
import {AgentClient, type AgentStatus} from "../client.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultSocketPath = "/tmp/lumen-layout-page-viewer.sock";
const defaultFixtureRoot = resolve(repositoryRoot, "fixtures", "performance");
const maximumSourceCacheBytes = 1024 * 1024;
const maximumIndexBytes = 1024 * 1024;
const maximumPreparedPages = 3;
const fixtureKinds = ["prose", "code", "mixed", "malformed"] as const;
const fixtureSizes = [5, 20, 100] as const;
type FixtureKind = (typeof fixtureKinds)[number];
type FixtureSize = (typeof fixtureSizes)[number];
type Arguments = {fixtureRoot: string; kinds: FixtureKind[]; sizes: FixtureSize[]; socketPath: string};

const agentClients = new Map<string, AgentClient>();
let activePhase = "initializing";
let scenarioCompleted = false;

// Node can otherwise exit cleanly if an awaited operation loses every active handle.
// A scenario must always reach its explicit terminal record before it is considered successful.
process.once("beforeExit", () => {
  if (!scenarioCompleted) {
    process.stderr.write(`layout-page Agent API scenario ended before completion: phase=${activePhase}\n`);
    process.exitCode = 1;
  }
});

function setPhase(phase: string): void {
  activePhase = phase;
  process.stdout.write(`layout-page scenario phase=${phase}\n`);
}

function readArguments(): Arguments {
  const cliArguments = process.argv.slice(2);
  const argumentsByName = new Map<string, string>();
  for (let index = 0; index < cliArguments.length; index += 2) {
    const name = cliArguments[index];
    const value = cliArguments[index + 1];
    if (
      (name !== "--fixture-root" && name !== "--socket" && name !== "--sizes" && name !== "--kinds") ||
      value === undefined ||
      argumentsByName.has(name)
    ) {
      throw new Error(
        "usage: node scripts/agent-api/scenarios/layout-page-viewer.ts [--socket /tmp/lumen.sock] [--fixture-root /tmp/lumen-fixtures] [--sizes 5,20,100] [--kinds prose,code,mixed,malformed]",
      );
    }
    argumentsByName.set(name, value);
  }
  const sizes = (argumentsByName.get("--sizes") ?? "5,20,100").split(",").map(Number);
  const kinds = (argumentsByName.get("--kinds") ?? "prose,code,mixed,malformed").split(",");
  if (
    sizes.some((size) => !fixtureSizes.includes(size as FixtureSize)) ||
    kinds.some((kind) => !fixtureKinds.includes(kind as FixtureKind))
  ) {
    throw new Error("invalid layout-page fixture selection");
  }
  return {
    fixtureRoot: resolve(
      argumentsByName.get("--fixture-root") ?? process.env.LUMEN_TEST_FIXTURE_ROOT ?? defaultFixtureRoot,
    ),
    kinds: kinds as FixtureKind[],
    sizes: sizes as FixtureSize[],
    socketPath: argumentsByName.get("--socket") ?? process.env.LUMEN_AGENT_SOCKET ?? defaultSocketPath,
  };
}

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function tabCount(socketPath: string): Promise<number> {
  return (await agentApi(socketPath).tabs()).length;
}

async function setFindQuery(socketPath: string, query: string, description: string): Promise<void> {
  const completion = await agentApi(socketPath).sendAndAwait("find", query);
  assertCondition(completion.outcome === "completed", `${description}: Find query failed: ${completion.outcome}`);
}

async function clearFindQuery(socketPath: string, description: string): Promise<void> {
  const completion = await agentApi(socketPath).sendAndAwait("find-clear");
  assertCondition(completion.outcome === "completed", `${description}: Find clear failed: ${completion.outcome}`);
}

async function awaitLayoutPageDirectory(socketPath: string, description: string): Promise<void> {
  const completion = await agentApi(socketPath).sendAndAwait("directory-ready");
  assertCondition(
    completion.outcome === "completed",
    `${description}: layout-page directory did not become ready: ${completion.outcome}`,
  );
}

async function findNext(socketPath: string, description: string): Promise<void> {
  const completion = await agentApi(socketPath).sendAndAwait("find-next");
  assertCondition(
    completion.outcome === "completed" || completion.outcome === "not-found",
    `${description}: Find next failed: ${completion.outcome}`,
  );
}

async function scrollAndSettle(
  socketPath: string,
  position: number,
  description: string,
  traceId?: number,
): Promise<AgentStatus> {
  const client = agentApi(socketPath);
  const activeTraceId = traceId ?? (await client.beginViewportTrace("scroll-settle"));
  try {
    const scroll = await client.sendAndAwait("scroll", String(position));
    assertCondition(scroll.outcome === "completed", `${description}: scroll input failed: ${scroll.outcome}`);
    const settled = await client.sendAndAwait("scroll-settled");
    assertCondition(settled.outcome === "completed", `${description}: scroll settlement failed: ${settled.outcome}`);
    const status = await client.status();
    const settledSourceOffset = Number(settled.detail.match(/(?:^| )source_offset=(\d+)(?: |$)/)?.[1]);
    assertCondition(
      Number.isSafeInteger(settledSourceOffset),
      `${description}: scroll settlement did not return a valid rendered source offset: ${settled.detail}`,
    );
    assertCondition(
      status.visibleSourceStart <= settledSourceOffset && settledSourceOffset < status.visibleSourceEnd,
      `${description}: settled scroll did not display the logical page at its native position: ${JSON.stringify({
        settledSourceOffset,
        visibleSourceEnd: status.visibleSourceEnd,
        visibleSourceStart: status.visibleSourceStart,
      })}`,
    );
    const inspection = await client.displayedHtml(0, 256);
    assertCondition(inspection.bytes > 0, `${description}: settled scroll left the reader blank`);
    return status;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const trace = await client.readViewportTrace(activeTraceId).catch(() => null);
    throw new Error(`${message}\nviewport trace:\n${JSON.stringify(trace)}`);
  } finally {
    if (traceId === undefined) {
      await client.endViewportTrace(activeTraceId).catch(() => undefined);
    }
  }
}

function agentApi(socketPath: string): AgentClient {
  let client = agentClients.get(socketPath);
  if (client === undefined) {
    client = new AgentClient(socketPath);
    agentClients.set(socketPath, client);
  }
  return client;
}

function generatedFixtures(
  fixtureRoot: string,
  kinds: readonly FixtureKind[],
  sizes: readonly FixtureSize[],
): string[] {
  return sizes.flatMap((size) => kinds.map((kind) => resolve(fixtureRoot, `lumen-${kind}-${size}mib.md`)));
}

async function ensureGeneratedFixtures(
  fixturePaths: readonly string[],
  fixtureRoot: string,
  kinds: readonly FixtureKind[],
  sizes: readonly FixtureSize[],
): Promise<void> {
  try {
    await Promise.all(fixturePaths.map((fixturePath) => fixtureHasTerminalMarker(fixturePath)));
  } catch {
    process.stdout.write("generating missing layout-page fixtures\n");
    generatePerformanceFixtures({kinds, outputDirectory: fixtureRoot, sizes});
    await Promise.all(fixturePaths.map((fixturePath) => fixtureHasTerminalMarker(fixturePath)));
  }
}

async function fixtureHasTerminalMarker(fixturePath: string): Promise<void> {
  const fixture = await open(fixturePath, "r");
  try {
    const fixtureSize = (await fixture.stat()).size;
    const markerBuffer = Buffer.alloc(128);
    const {bytesRead} = await fixture.read(
      markerBuffer,
      0,
      markerBuffer.length,
      Math.max(0, fixtureSize - markerBuffer.length),
    );
    if (!markerBuffer.subarray(0, bytesRead).toString("utf8").includes("LUMEN_TERMINAL_MARKER")) {
      throw new Error(`${fixturePath} does not contain the terminal marker`);
    }
  } finally {
    await fixture.close();
  }
}

async function verifyFixture(socketPath: string, fixturePath: string): Promise<void> {
  const client = agentApi(socketPath);
  const fixtureSize = (await stat(fixturePath)).size;
  const fixtureName = fixturePath.slice(fixturePath.lastIndexOf("/") + 1);
  const provisionalTraceId =
    fixtureSize >= 100 * 1024 * 1024 ? await client.beginViewportTrace("pre-directory-provisional-range") : null;
  setPhase(`${fixtureName}:open`);
  const openCompletion = await client.sendAndAwait("open", fixturePath);
  assertCondition(openCompletion.outcome === "completed", `${fixtureName}: open failed: ${openCompletion.outcome}`);
  const midpointOffset = Math.floor(fixtureSize / 2);
  if (fixtureSize >= 20 * 1024 * 1024) {
    if (fixtureSize >= 100 * 1024 * 1024) {
      setPhase(`${fixtureName}:pre-directory-pointer-drag`);
      const pointerDragStart = await client.status();
      const pointerDragStartRange = Math.max(0, pointerDragStart.scrollHeight - pointerDragStart.scrollClientHeight);
      assertCondition(pointerDragStartRange > 0, `${fixtureName}: initial reader had no native scroll range`);
      const pointerDragId = await client.beginPointerDrag();
      for (const fraction of [0.4, 0.55, 0.7] as const) {
        const pointerDragScroll = await client.sendAndAwait(
          "scroll",
          String(Math.floor(pointerDragStartRange * fraction)),
        );
        assertCondition(
          pointerDragScroll.outcome === "completed",
          `${fixtureName}: pre-directory pointer drag input was not consumed`,
        );
      }
      const pointerDragInput = await client.status();
      const pointerDragMounted = await client.sendAndAwait(
        "page-displayed",
        `${pointerDragInput.scrollSourceOffset} ${pointerDragId}`,
      );
      assertCondition(
        pointerDragMounted.outcome === "completed",
        `${fixtureName}: pre-directory pointer drag did not mount its requested page`,
      );
      const pointerDragPage = await client.status();
      assertCondition(
        Math.abs(pointerDragPage.scrollTop - pointerDragInput.scrollTop) <= 1,
        `${fixtureName}: page mount changed the held native thumb position: ${JSON.stringify({
          mountedTop: pointerDragPage.scrollTop,
          requestedTop: pointerDragInput.scrollTop,
        })}`,
      );
      const pointerDragInputRange = Math.max(0, pointerDragInput.scrollHeight - pointerDragInput.scrollClientHeight);
      const pointerDragRange = Math.max(0, pointerDragPage.scrollHeight - pointerDragPage.scrollClientHeight);
      if (Math.abs(pointerDragRange - pointerDragInputRange) > 1) {
        const trace =
          provisionalTraceId === null
            ? null
            : await client
                .readViewportTrace(provisionalTraceId)
                .catch((error: unknown) => `unavailable=${error instanceof Error ? error.message : String(error)}`);
        throw new Error(
          `${fixtureName}: held provisional page mount changed the native scroll range: ${JSON.stringify({
            pointerDragStart,
            pointerDragStartRange,
            pointerDragInput,
            pointerDragInputRange,
            pointerDragPage,
            pointerDragRange,
            trace,
          })}`,
        );
      }
      const pointerDragEnd = await client.endPointerDrag(pointerDragId);
      assertCondition(pointerDragEnd.outcome === "completed", `${fixtureName}: pre-directory pointer drag did not end`);
      if (provisionalTraceId !== null) {
        await client.endViewportTrace(provisionalTraceId);
      }
      setPhase(`${fixtureName}:pre-directory-native-scroll`);
      const preDirectoryInput = await client.status();
      const preDirectoryInputRange = Math.max(0, preDirectoryInput.scrollHeight - preDirectoryInput.scrollClientHeight);
      const preDirectoryScroll = await scrollAndSettle(
        socketPath,
        Math.floor(preDirectoryInputRange / 2),
        `${fixtureName}: pre-directory native scroll must mount its requested page`,
      );
      const preDirectoryRange = Math.max(0, preDirectoryScroll.scrollHeight - preDirectoryScroll.scrollClientHeight);
      assertCondition(
        preDirectoryRange >= preDirectoryInputRange * 0.9,
        `${fixtureName}: mounting a provisional target page collapsed the native scroll range: ${JSON.stringify({
          preDirectoryInput,
          preDirectoryInputRange,
          preDirectoryRange,
        })}`,
      );
    }
    setPhase(`${fixtureName}:pre-directory-seek`);
    const firstOffset = fixtureSize >= 100 * 1024 * 1024 ? Math.floor(fixtureSize / 4) : midpointOffset;
    const firstRequest = await agentApi(socketPath).begin("seek", String(firstOffset));
    const directRequest =
      fixtureSize >= 100 * 1024 * 1024
        ? await agentApi(socketPath).begin("seek", String(midpointOffset))
        : firstRequest;
    const retainedInitialDocument = await agentApi(socketPath).displayedHtml(0, 256);
    assertCondition(
      retainedInitialDocument.bytes > 0,
      `${fixtureName}: a pre-directory direct seek blanked the initial reader page`,
    );
    const directCompletion = await agentApi(socketPath).await(directRequest);
    assertCondition(
      directCompletion.outcome === "completed",
      `${fixtureName}: pre-directory direct seek failed: ${directCompletion.outcome}`,
    );
    const directSettlement = await agentApi(socketPath).sendAndAwait("scroll-settled");
    assertCondition(
      directSettlement.outcome === "completed",
      `${fixtureName}: pre-directory direct seek did not reach a stable native viewport: ${directSettlement.outcome}`,
    );
    if (directRequest !== firstRequest) {
      const supersededCompletion = await agentApi(socketPath).await(firstRequest);
      assertCondition(
        supersededCompletion.outcome === "superseded" || supersededCompletion.outcome === "stale",
        `${fixtureName}: older competing pre-directory seek was not discarded: ${supersededCompletion.outcome}`,
      );
    }
    const directStatus = await agentApi(socketPath).status();
    assertCondition(
      directStatus.sourceStart <= midpointOffset && midpointOffset < directStatus.sourceEnd,
      `${fixtureName}: pre-directory direct seek did not resolve its exact target`,
    );
    assertCondition(
      directStatus.visibleSourceStart <= midpointOffset && midpointOffset < directStatus.visibleSourceEnd,
      `${fixtureName}: pre-directory direct seek mounted its target outside the native viewport: ${JSON.stringify({
        midpointOffset,
        scrollClientHeight: directStatus.scrollClientHeight,
        scrollHeight: directStatus.scrollHeight,
        scrollSourceOffset: directStatus.scrollSourceOffset,
        scrollTop: directStatus.scrollTop,
        sourceEnd: directStatus.sourceEnd,
        sourceStart: directStatus.sourceStart,
        visibleSourceEnd: directStatus.visibleSourceEnd,
        visibleSourceStart: directStatus.visibleSourceStart,
      })}`,
    );
    const pageRequestCompleted = (await agentApi(socketPath).documentWorkEvents()).some(
      (event) => event.kind === "page-request" && event.lifecycle === "accepted",
    );
    assertCondition(
      pageRequestCompleted,
      `${fixtureName}: pre-directory direct seek did not use the priority layout-page request lane`,
    );
  }
  setPhase(`${fixtureName}:directory`);
  await awaitLayoutPageDirectory(socketPath, fixtureName);
  const directorySettlement = await agentApi(socketPath).sendAndAwait("scroll-settled");
  assertCondition(
    directorySettlement.outcome === "completed",
    `${fixtureName}: directory geometry did not settle: ${directorySettlement.outcome}`,
  );
  const viewportStatus = await agentApi(socketPath).status();
  const sourceLength = viewportStatus.sourceLength;
  const scrollRange = viewportStatus.scrollHeight - viewportStatus.scrollClientHeight;
  assertCondition(
    sourceLength === fixtureSize &&
      viewportStatus.sourceStart < viewportStatus.sourceEnd &&
      viewportStatus.directoryPageCount > 1 &&
      scrollRange > 0,
    `${fixtureName}: open completion did not establish layout-page geometry: ${JSON.stringify({
      directoryPageCount: viewportStatus.directoryPageCount,
      scrollRange,
      sourceEnd: viewportStatus.sourceEnd,
      sourceLength,
      sourceStart: viewportStatus.sourceStart,
    })}`,
  );
  const maximumScroll = Math.max(0, viewportStatus.scrollHeight - viewportStatus.scrollClientHeight);
  assertCondition(maximumScroll > 0, `${fixtureName}: document did not create a scroll range`);

  if (fixtureSize >= 100 * 1024 * 1024) {
    setPhase(`${fixtureName}:pointer-drag`);
    const dragTarget = Math.floor(maximumScroll * 0.8);
    const dragId = await agentApi(socketPath).beginPointerDrag();
    const dragScroll = await agentApi(socketPath).begin("scroll", String(dragTarget));
    const dragInput = await agentApi(socketPath).await(dragScroll);
    assertCondition(dragInput.outcome === "completed", `${fixtureName}: pointer drag input was not consumed`);
    const duringDrag = await agentApi(socketPath).status();
    assertCondition(
      duringDrag.readerInputActive,
      `${fixtureName}: pointer drag lost reader input ownership: ${JSON.stringify({
        readerInputActive: duringDrag.readerInputActive,
        scrollHeight: duringDrag.scrollHeight,
        scrollSourceOffset: duringDrag.scrollSourceOffset,
        scrollTop: duringDrag.scrollTop,
      })}`,
    );
    const displayedDuringDrag = await agentApi(socketPath).sendAndAwait(
      "page-displayed",
      `${duringDrag.scrollSourceOffset} ${dragId}`,
    );
    assertCondition(
      displayedDuringDrag.outcome === "completed",
      `${fixtureName}: pointer drag did not mount the requested page while held: ${displayedDuringDrag.outcome}`,
    );
    const mountedDuringDrag = await agentApi(socketPath).status();
    assertCondition(
      mountedDuringDrag.sourceStart <= duringDrag.scrollSourceOffset &&
        duringDrag.scrollSourceOffset < mountedDuringDrag.sourceEnd,
      `${fixtureName}: pointer drag mounted a page unrelated to its logical reader position: ${JSON.stringify({
        targetSourceOffset: duringDrag.scrollSourceOffset,
        sourceEnd: mountedDuringDrag.sourceEnd,
        sourceStart: mountedDuringDrag.sourceStart,
      })}`,
    );
    const mountedDuringDragHtml = await agentApi(socketPath).displayedHtml(0, 256);
    assertCondition(mountedDuringDragHtml.bytes > 0, `${fixtureName}: pointer drag mounted a blank document`);
    const dragSettlement = await agentApi(socketPath).begin("scroll-settled", String(dragId));
    const dragEnd = await agentApi(socketPath).endPointerDrag(dragId);
    assertCondition(dragEnd.outcome === "completed", `${fixtureName}: pointer drag did not end`);
    const dragSettlementCompletion = await agentApi(socketPath).await(dragSettlement);
    assertCondition(dragSettlementCompletion.outcome === "completed", `${fixtureName}: pointer drag did not settle`);
    const dragStatus = await agentApi(socketPath).status();
    assertCondition(
      dragStatus.visiblePageCount > 0 &&
        dragStatus.visibleSourceStart <= dragStatus.scrollSourceOffset &&
        dragStatus.scrollSourceOffset < dragStatus.visibleSourceEnd,
      `${fixtureName}: pointer drag settled on a blank or mismatched page: ${JSON.stringify({
        scrollSourceOffset: dragStatus.scrollSourceOffset,
        scrollTop: dragStatus.scrollTop,
        sourceEnd: dragStatus.sourceEnd,
        sourceStart: dragStatus.sourceStart,
        visiblePageCount: dragStatus.visiblePageCount,
        visibleSourceEnd: dragStatus.visibleSourceEnd,
        visibleSourceStart: dragStatus.visibleSourceStart,
      })}`,
    );
  }

  const midpointCompletion = await agentApi(socketPath).sendAndAwait("seek", String(midpointOffset));
  assertCondition(
    midpointCompletion.outcome === "completed",
    `${fixtureName}: midpoint seek failed: ${midpointCompletion.outcome}`,
  );
  const midpointStatus = await agentApi(socketPath).status();
  assertCondition(
    midpointStatus.sourceStart <= midpointOffset && midpointOffset < midpointStatus.sourceEnd,
    `${fixtureName}: midpoint seek completion did not display the requested range`,
  );

  const terminalTraceId = await agentApi(socketPath).beginViewportTrace("terminal-layout");
  const terminalCompletion = await agentApi(socketPath).sendAndAwait("terminal-layout");
  assertCondition(
    terminalCompletion.outcome === "completed" && terminalCompletion.detail === "terminal-verified",
    `${fixtureName}: terminal layout failed verification: ${terminalCompletion.outcome} ${terminalCompletion.detail}`,
  );
  const terminalStatus = await agentApi(socketPath).status();
  assertCondition(
    terminalStatus.sourceEnd === fixtureSize,
    `${fixtureName}: terminal layout completion did not display the final layout page`,
  );
  const terminalScrollRange = Math.max(0, terminalStatus.scrollHeight - terminalStatus.scrollClientHeight);
  const nativeTerminalStatus = await scrollAndSettle(
    socketPath,
    terminalScrollRange,
    `${fixtureName}: native terminal scroll`,
    terminalTraceId,
  );
  const nativeTerminalMaximum = Math.max(
    0,
    nativeTerminalStatus.scrollHeight - nativeTerminalStatus.scrollClientHeight,
  );
  const retainedTerminalPosition =
    nativeTerminalStatus.scrollSourceOffset === fixtureSize - 1 &&
    nativeTerminalStatus.scrollTop >= nativeTerminalMaximum - 1 &&
    nativeTerminalStatus.visibleSourceEnd === fixtureSize;
  if (!retainedTerminalPosition) {
    const terminalTrace = await agentApi(socketPath).readViewportTrace(terminalTraceId);
    throw new Error(
      `${fixtureName}: native terminal scroll did not retain the terminal reader position: ${JSON.stringify({
        scrollSourceOffset: nativeTerminalStatus.scrollSourceOffset,
        scrollTop: nativeTerminalStatus.scrollTop,
        sourceEnd: nativeTerminalStatus.visibleSourceEnd,
        terminalScrollRange: nativeTerminalMaximum,
        trace: terminalTrace,
      })}`,
    );
  }
  await agentApi(socketPath).endViewportTrace(terminalTraceId);
  assertCondition(
    terminalStatus.sourceCacheBytes <= maximumSourceCacheBytes,
    `${fixtureName}: source cache exceeded its limit`,
  );
  assertCondition(terminalStatus.indexBytes <= maximumIndexBytes, `${fixtureName}: index exceeded its limit`);
  assertCondition(
    terminalStatus.preparedPageCount <= maximumPreparedPages,
    `${fixtureName}: prepared layout page count exceeded its limit`,
  );

  if (fixtureSize <= 5 * 1024 * 1024) {
    setPhase(`${fixtureName}:terminal-find`);
    const terminalMarker = "LUMEN_TERMINAL_MARKER";
    await setFindQuery(socketPath, terminalMarker, `${fixtureName} terminal marker query`);
    await findNext(socketPath, `${fixtureName} terminal marker navigation`);
    await clearFindQuery(socketPath, `${fixtureName} terminal marker dismissal`);
  }

  if (fixtureName === "lumen-mixed-20mib.md") {
    setPhase(`${fixtureName}:large-find`);
    const query = "Mixed section 200";
    const originCompletion = await agentApi(socketPath).sendAndAwait("seek", "0");
    assertCondition(originCompletion.outcome === "completed", `${fixtureName}: Find origin seek failed`);
    await setFindQuery(socketPath, query, "large-document Find query");
    await findNext(socketPath, "large-document Find next");
    await clearFindQuery(socketPath, "Find dismissal");
  }

  if (fixtureName === "lumen-mixed-100mib.md") {
    setPhase(`${fixtureName}:scroll-sequence`);
    const geometry = await agentApi(socketPath).status();
    const range = Math.max(0, geometry.scrollHeight - geometry.scrollClientHeight);
    const positions = [0.18, 0.27, 0.36, 0.45].map((fraction) => Math.floor(range * fraction));
    for (const position of positions) {
      await scrollAndSettle(socketPath, position, `${fixtureName} repeated input epoch`);
    }
    const returnPositions = [0.45, 0.34, 0.23, 0.12].map((fraction) => Math.floor(range * fraction));
    for (const position of returnPositions) {
      await scrollAndSettle(socketPath, position, `${fixtureName} return input epoch`);
    }
    const wheelPosition = Math.floor(range * 0.6);
    await scrollAndSettle(socketPath, wheelPosition, `${fixtureName} final input epoch`);
  }

  setPhase(`${fixtureName}:close`);
  const closeCompletion = await agentApi(socketPath).sendAndAwait("close");
  assertCondition(closeCompletion.outcome === "completed", `${fixtureName}: close failed: ${closeCompletion.outcome}`);
  const releasedStatus = await agentApi(socketPath).status();
  assertCondition(
    releasedStatus.sourceLength === 0 && releasedStatus.preparedPageCount === 0,
    `${fixtureName}: close completion did not release layout-page state`,
  );
  assertCondition(releasedStatus.sourceCacheBytes === 0, `${fixtureName}: source cache was retained`);
  assertCondition(releasedStatus.indexBytes === 0, `${fixtureName}: index was retained`);
  assertCondition((await tabCount(socketPath)) === 0, `${fixtureName}: tab remained open after close`);
  process.stdout.write(`passed ${fixtureName}\n`);
}

const {fixtureRoot, kinds, sizes, socketPath} = readArguments();
const fixturePaths = generatedFixtures(fixtureRoot, kinds, sizes);
setPhase("fixtures");
await ensureGeneratedFixtures(fixturePaths, fixtureRoot, kinds, sizes);
setPhase("agent-ready");
await agentApi(socketPath).awaitReady();
assertCondition(
  (await tabCount(socketPath)) === 0,
  "start with a fresh diagnostic Lumen instance with no open documents",
);
for (const fixturePath of fixturePaths) {
  await verifyFixture(socketPath, fixturePath);
}
scenarioCompleted = true;
process.stdout.write("layout-page Agent API regression suite passed\n");
