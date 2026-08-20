import {readFile} from "node:fs/promises";
import {
  performanceFixtureMarkerManifestPath,
  type PerformanceFixtureManifest,
  type PerformanceFixtureMarker,
} from "../testing/generate-performance-fixtures.ts";
import {AgentClient, type AgentStatus, type ViewportTraceRecord} from "./client.ts";

export type DragProfileName = "boundary" | "erratic" | "fast-jump" | "repeat" | "slow-linear" | "top-boundary";

export type DragProfile = {
  fractions: readonly number[];
  mountAfterEachStep: boolean;
  name: DragProfileName;
  orderedBurst: boolean;
};

export type DragTelemetry = {
  finalSourceOffset: number;
  fixturePath: string;
  marker: PerformanceFixtureMarker;
  profile: DragProfileName;
  recordCount: number;
  responsiveness: Readonly<Record<string, TimingDistribution>>;
  traceRecords: readonly ViewportTraceRecord[];
};

type HeldDragGeometry = {
  geometryRevision: number;
  scrollRange: number;
};

type TimingDistribution = {
  averageMilliseconds: number | null;
  count: number;
  maximumMilliseconds: number | null;
  minimumMilliseconds: number | null;
};

const maximumInspectionBytes = 16 * 1024;

export const dragProfiles: readonly DragProfile[] = [
  {fractions: [0.08, 0.16, 0.28, 0.42, 0.5], mountAfterEachStep: true, name: "slow-linear", orderedBurst: false},
  {fractions: [0.1, 0.48, 0.76, 0.92], mountAfterEachStep: false, name: "fast-jump", orderedBurst: true},
  {fractions: [0.68, 0.32, 0.74, 0.51, 0.84, 0.46], mountAfterEachStep: false, name: "erratic", orderedBurst: true},
  {fractions: [0, 0.015, 0.985, 1, 1], mountAfterEachStep: true, name: "boundary", orderedBurst: false},
  {fractions: [0.2, 0.62, 0.31, 0.77, 0.49], mountAfterEachStep: false, name: "repeat", orderedBurst: false},
  {fractions: [0.8, 0.1, 0, 0], mountAfterEachStep: true, name: "top-boundary", orderedBurst: false},
] as const;

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function maximumScroll(status: AgentStatus): number {
  return Math.max(0, status.scrollHeight - status.scrollClientHeight);
}

function targetPosition(status: AgentStatus, fraction: number): number {
  assertCondition(fraction >= 0 && fraction <= 1, `invalid normalized drag target: ${fraction}`);
  return Math.floor(maximumScroll(status) * fraction);
}

function parseManifest(value: string, fixturePath: string): PerformanceFixtureManifest {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid marker manifest for ${fixturePath}`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(manifest.byteLength) ||
    typeof manifest.fixtureFilename !== "string" ||
    !Array.isArray(manifest.markers) ||
    !manifest.markers.every(
      (marker) =>
        typeof marker === "object" &&
        marker !== null &&
        typeof (marker as Record<string, unknown>).label === "string" &&
        Number.isSafeInteger((marker as Record<string, unknown>).sourceOffset),
    )
  ) {
    throw new Error(`invalid marker manifest shape for ${fixturePath}`);
  }
  return manifest as PerformanceFixtureManifest;
}

async function readManifest(fixturePath: string): Promise<PerformanceFixtureManifest> {
  return parseManifest(await readFile(performanceFixtureMarkerManifestPath(fixturePath), "utf8"), fixturePath);
}

function markerInDisplayedRange(manifest: PerformanceFixtureManifest, status: AgentStatus): PerformanceFixtureMarker {
  const target = status.scrollSourceOffset;
  const candidates = manifest.markers.filter(
    (marker) => status.sourceStart <= marker.sourceOffset && marker.sourceOffset < status.sourceEnd,
  );
  const marker = candidates.reduce<PerformanceFixtureMarker | null>((closest, candidate) => {
    if (closest === null || Math.abs(candidate.sourceOffset - target) < Math.abs(closest.sourceOffset - target)) {
      return candidate;
    }
    return closest;
  }, null);
  if (marker === null) {
    throw new Error(
      `no deterministic marker is available in the rendered range: ${JSON.stringify({
        sourceEnd: status.sourceEnd,
        sourceStart: status.sourceStart,
        target,
      })}`,
    );
  }
  return marker;
}

async function displayedHtmlContains(client: AgentClient, marker: string): Promise<boolean> {
  let offset = 0;
  while (true) {
    const inspection = await client.displayedHtml(offset, maximumInspectionBytes);
    if (inspection.content.includes(marker)) {
      return true;
    }
    offset += inspection.responseBytes;
    if (offset >= inspection.bytes) {
      return false;
    }
    if (inspection.responseBytes === 0) {
      throw new Error("displayed HTML inspection ended before its declared length");
    }
  }
}

export async function assertDragMarkerDisplayed(
  client: AgentClient,
  expectedSourceOffset: number,
  marker: PerformanceFixtureMarker,
): Promise<void> {
  const status = await client.status();
  assertCondition(
    status.visiblePageCount > 0 &&
      status.visibleSourceStart <= expectedSourceOffset &&
      expectedSourceOffset < status.visibleSourceEnd,
    `restored viewport did not contain its expected reader position: ${JSON.stringify({
      expectedSourceOffset,
      visibleSourceEnd: status.visibleSourceEnd,
      visibleSourceStart: status.visibleSourceStart,
    })}`,
  );
  assertCondition(
    await displayedHtmlContains(client, marker.label),
    `restored viewport did not contain marker ${marker.label}`,
  );
}

function timingDistribution(values: readonly number[]): TimingDistribution {
  if (values.length === 0) {
    return {averageMilliseconds: null, count: 0, maximumMilliseconds: null, minimumMilliseconds: null};
  }
  return {
    averageMilliseconds: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3)),
    count: values.length,
    maximumMilliseconds: Number(Math.max(...values).toFixed(3)),
    minimumMilliseconds: Number(Math.min(...values).toFixed(3)),
  };
}

function recordsForRequest(records: readonly ViewportTraceRecord[], requestId: number): readonly ViewportTraceRecord[] {
  return records.filter((record) => record.agentRequestId === requestId);
}

function firstLaterRecord(
  records: readonly ViewportTraceRecord[],
  earlier: ViewportTraceRecord,
  event: string,
): ViewportTraceRecord | null {
  return (
    records.find(
      (record) =>
        record.sequence > earlier.sequence &&
        record.event === event &&
        record.agentRequestId === earlier.agentRequestId &&
        record.dragId === earlier.dragId &&
        record.documentGeneration === earlier.documentGeneration,
    ) ?? null
  );
}

function latencyBetween(
  records: readonly ViewportTraceRecord[],
  earlierEvent: string,
  laterEvent: string,
): readonly number[] {
  return records.flatMap((earlier) => {
    if (earlier.event !== earlierEvent || earlier.agentRequestId === null) {
      return [];
    }
    const later = firstLaterRecord(records, earlier, laterEvent);
    return later === null ? [] : [later.elapsedMilliseconds - earlier.elapsedMilliseconds];
  });
}

function telemetry(
  records: readonly ViewportTraceRecord[],
  finalRequestId: number,
): Readonly<Record<string, TimingDistribution>> {
  const finalRecords = recordsForRequest(records, finalRequestId);
  const native = finalRecords.findLast((record) => record.event === "native-scroll-received") ?? null;
  const settled = finalRecords.findLast((record) => record.event === "layout-settled") ?? null;
  return {
    finalTargetToSettled: timingDistribution(
      native === null || settled === null ? [] : [settled.elapsedMilliseconds - native.elapsedMilliseconds],
    ),
    nativeToDisplayed: timingDistribution(
      latencyBetween(finalRecords, "native-scroll-received", "page-window-applied"),
    ),
    nativeToPageWork: timingDistribution(latencyBetween(finalRecords, "native-scroll-received", "page-work-requested")),
    writeToNative: timingDistribution(latencyBetween(records, "scroll-write-accepted", "native-scroll-received")),
  };
}

function assertHeldGeometry(
  baseline: HeldDragGeometry,
  status: AgentStatus,
  profile: DragProfile,
  boundary: string,
): void {
  const range = maximumScroll(status);
  assertCondition(
    status.readerInputActive &&
      status.geometryRevision === baseline.geometryRevision &&
      Math.abs(range - baseline.scrollRange) <= 1 &&
      !status.measurementCommitActive &&
      !status.scrollWritePending,
    `${profile.name}: held drag changed virtual geometry at ${boundary}: ${JSON.stringify({
      baseline,
      observed: {
        geometryRevision: status.geometryRevision,
        measurementCommitActive: status.measurementCommitActive,
        readerInputActive: status.readerInputActive,
        scrollRange: range,
        scrollWritePending: status.scrollWritePending,
      },
    })}`,
  );
}

function assertTrace(
  records: readonly ViewportTraceRecord[],
  description: string,
  dragId: number,
  scrollRequests: readonly number[],
): void {
  const events = new Set(records.map((record) => record.event));
  for (const event of [
    "scroll-write-accepted",
    "native-scroll-received",
    "reader-position-displayed",
    "page-window-mounted",
    "layout-settled",
  ]) {
    assertCondition(events.has(event), `${description}: viewport trace did not contain ${event}`);
  }
  assertCondition(
    events.has("page-work-requested") || events.has("page-work-resolved"),
    `${description}: viewport trace did not record page work`,
  );
  const firstScroll = records.find(
    (record) => record.event === "scroll-write-accepted" && record.agentRequestId === scrollRequests[0],
  );
  assertCondition(firstScroll !== undefined, `${description}: viewport trace did not contain its first scroll write`);
  const release = records.find(
    (record) =>
      record.sequence >= firstScroll.sequence && record.event === "pointer-interaction-end" && record.dragId === null,
  );
  assertCondition(release !== undefined, `${description}: viewport trace did not record the drag release`);
  const heldRecords = records.filter(
    (record) =>
      record.sequence >= firstScroll.sequence && record.sequence < release.sequence && record.dragId === dragId,
  );
  const heldFrameRecords = heldRecords.filter((record) => record.event.startsWith("native-scroll-frame-"));
  assertCondition(
    heldFrameRecords.every((record) => /inputs=[1-9]\d*/.test(record.detail)),
    `${description}: held-drag frame telemetry omitted its input count: ${JSON.stringify(heldFrameRecords)}`,
  );
  assertCondition(
    heldRecords.every((record) => record.geometryRevision === firstScroll.geometryRevision),
    `${description}: held drag changed geometry revision: ${JSON.stringify(
      heldRecords.map((record) => ({
        event: record.event,
        geometryRevision: record.geometryRevision,
        sequence: record.sequence,
      })),
    )}`,
  );
  const knownRanges = heldRecords.map((record) => record.scrollRange).filter((range) => range > 0);
  assertCondition(
    knownRanges.every((range) => Math.abs(range - (knownRanges[0] ?? range)) <= 1),
    `${description}: held drag changed native scroll range: ${JSON.stringify(knownRanges)}`,
  );
  for (const requestId of scrollRequests) {
    const requestRecords = recordsForRequest(records, requestId);
    const write = requestRecords.find((record) => record.event === "scroll-write-accepted");
    const native = write === undefined ? null : firstLaterRecord(requestRecords, write, "native-scroll-received");
    assertCondition(
      write !== undefined && native !== null,
      `${description}: viewport trace did not correlate scroll request ${requestId} to its native scroll event`,
    );
  }
  const finalRequestId = scrollRequests.at(-1);
  assertCondition(finalRequestId !== undefined, `${description}: drag profile emitted no scroll request`);
  const finalRecords = recordsForRequest(records, finalRequestId);
  const finalNative = finalRecords.findLast((record) => record.event === "native-scroll-received");
  assertCondition(finalNative !== undefined, `${description}: final scroll request had no native event`);
  const finalQueued = firstLaterRecord(finalRecords, finalNative, "page-request-queued");
  const finalDispatched = firstLaterRecord(finalRecords, finalNative, "scroll-dispatched");
  assertCondition(finalDispatched !== null, `${description}: final scroll request was not dispatched`);
  const finalPageWork =
    finalQueued === null
      ? null
      : (finalRecords.find(
          (candidate) =>
            candidate.event === "page-work-requested" &&
            candidate.inputGeneration === finalQueued.inputGeneration &&
            candidate.documentGeneration === finalQueued.documentGeneration &&
            candidate.dragId === dragId,
        ) ?? null);
  if (finalQueued === null) {
    assertCondition(
      finalDispatched.detail.includes("contained=true"),
      `${description}: final scroll request neither queued work nor remained in the mounted page window`,
    );
  } else {
    assertCondition(
      finalPageWork !== undefined,
      `${description}: final scroll request did not retain correlated page-work-requested lifecycle`,
    );
  }
  const finalApplied =
    finalPageWork === null
      ? null
      : finalRecords.find(
          (candidate) =>
            candidate.event === "page-window-applied" &&
            candidate.sequence > finalPageWork.sequence &&
            candidate.inputGeneration === finalPageWork.inputGeneration &&
            candidate.documentGeneration === finalPageWork.documentGeneration &&
            candidate.dragId === dragId &&
            candidate.pageGeneration === finalPageWork.pageGeneration,
        );
  if (finalPageWork !== null) {
    assertCondition(
      finalApplied !== undefined,
      `${description}: final scroll request did not retain correlated page-window-applied lifecycle`,
    );
  }
  const finalInputGeneration = finalQueued?.inputGeneration ?? finalNative.inputGeneration;
  const finalDocumentGeneration = finalQueued?.documentGeneration ?? finalNative.documentGeneration;
  const finalPageGeneration = finalApplied?.pageGeneration ?? finalNative.pageGeneration;
  const finalSettlement = records.findLast(
    (record) =>
      record.sequence > finalNative.sequence &&
      record.event === "layout-settled" &&
      record.documentGeneration === finalDocumentGeneration &&
      record.inputGeneration === finalInputGeneration &&
      record.pageGeneration === finalPageGeneration,
  );
  assertCondition(finalSettlement !== undefined, `${description}: final scroll request did not settle coherently`);
  assertCondition(
    records.some((record) => record.event === "pointer-interaction-begin" && record.dragId === dragId),
    `${description}: viewport trace did not correlate drag ${dragId}`,
  );
}

async function dispatchProfile(
  client: AgentClient,
  profile: DragProfile,
  dragId: number,
  baseline: HeldDragGeometry,
): Promise<readonly number[]> {
  const requests: number[] = [];
  if (!profile.orderedBurst) {
    for (const fraction of profile.fractions) {
      const completion = await client.sendAndAwait("scroll", String(targetPosition(await client.status(), fraction)));
      requests.push(completion.requestId);
      assertCondition(
        completion.outcome === "completed",
        `${profile.name}: scroll input failed: ${completion.outcome}`,
      );
      assertHeldGeometry(baseline, await client.status(), profile, `input-${requests.length}`);
      if (profile.mountAfterEachStep) {
        const status = await client.status();
        const pageDisplayed = await client.sendAndAwait("page-displayed", `${status.scrollSourceOffset} ${dragId}`);
        assertCondition(
          pageDisplayed.outcome === "completed",
          `${profile.name}: intermediate drag page did not display`,
        );
        assertHeldGeometry(baseline, await client.status(), profile, `mount-${requests.length}`);
      }
    }
    return requests;
  }
  const currentStatus = await client.status();
  for (const fraction of profile.fractions) {
    requests.push(await client.begin("scroll", String(targetPosition(currentStatus, fraction))));
  }
  const completions = await Promise.all(requests.map((request) => client.await(request)));
  assertCondition(
    completions.at(-1)?.outcome === "completed",
    `${profile.name}: final burst scroll input did not complete: ${completions.at(-1)?.outcome ?? "missing"}`,
  );
  return requests;
}

async function holdDragAtTerminal(client: AgentClient, dragId: number, profile: DragProfile): Promise<void> {
  const initialStatus = await client.status();
  const maximumReconciliations = Math.max(1, initialStatus.directoryPageCount + 1);
  for (let reconciliation = 0; reconciliation < maximumReconciliations; reconciliation += 1) {
    const before = await client.status();
    const maximum = maximumScroll(before);
    const scroll = await client.sendAndAwait("scroll", String(maximum));
    assertCondition(scroll.outcome === "completed", `${profile.name}: terminal drag input failed`);
    const afterInput = await client.status();
    const displayed = await client.sendAndAwait("page-displayed", `${afterInput.scrollSourceOffset} ${dragId}`);
    assertCondition(displayed.outcome === "completed", `${profile.name}: terminal drag page did not display`);
    const afterDisplay = await client.status();
    if (
      afterDisplay.scrollTop >= maximumScroll(afterDisplay) - 1 &&
      afterDisplay.scrollSourceOffset === afterDisplay.sourceLength - 1
    ) {
      return;
    }
  }
  throw new Error(`${profile.name}: held terminal drag did not converge on the native endpoint`);
}

export async function runDragProfile(
  client: AgentClient,
  fixturePath: string,
  profile: DragProfile,
): Promise<DragTelemetry> {
  const manifest = await readManifest(fixturePath);
  const directoryReady = await client.sendAndAwait("directory-ready");
  assertCondition(
    directoryReady.outcome === "completed",
    `${profile.name}: layout-page directory was not ready before the drag trajectory`,
  );
  const initialSettlement = await client.sendAndAwait("scroll-settled");
  assertCondition(
    initialSettlement.outcome === "completed",
    `${profile.name}: layout-page viewport was not stable before the drag trajectory`,
  );
  const traceId = await client.beginViewportTrace(`drag-${profile.name}`);
  let traceEnded = false;
  let trace: Awaited<ReturnType<AgentClient["readViewportTrace"]>> | null = null;
  try {
    const initialTrace = await client.readViewportTrace(traceId);
    assertCondition(
      initialTrace.records[0]?.event === "viewport-trace-started",
      `${profile.name}: trace did not begin deterministically`,
    );
    const dragId = await client.beginPointerDrag();
    const dragStartStatus = await client.status();
    const scrollRequests = await dispatchProfile(client, profile, dragId, {
      geometryRevision: dragStartStatus.geometryRevision,
      scrollRange: maximumScroll(dragStartStatus),
    });
    if (profile.name === "boundary") {
      await holdDragAtTerminal(client, dragId, profile);
    }
    const duringDrag = await client.status();
    assertCondition(duringDrag.readerInputActive, `${profile.name}: held drag lost reader input ownership`);
    const pageDisplayed = await client.sendAndAwait("page-displayed", `${duringDrag.scrollSourceOffset} ${dragId}`);
    assertCondition(pageDisplayed.outcome === "completed", `${profile.name}: final drag page did not display`);
    const settlement = await client.begin("scroll-settled", String(dragId));
    const dragEnd = await client.endPointerDrag(dragId);
    assertCondition(dragEnd.outcome === "completed", `${profile.name}: drag did not release`);
    const settled = await client.await(settlement);
    assertCondition(settled.outcome === "completed", `${profile.name}: drag did not settle`);
    const finalStatus = await client.status();
    trace = await client.readViewportTrace(traceId);
    const marker = markerInDisplayedRange(manifest, finalStatus);
    if (profile.name !== "top-boundary") {
      await assertDragMarkerDisplayed(client, finalStatus.scrollSourceOffset, marker);
    }
    if (profile.name === "slow-linear") {
      const midpoint = manifest.byteLength / 2;
      const tolerance = manifest.byteLength / 10;
      assertCondition(
        Math.abs(finalStatus.scrollSourceOffset - midpoint) <= tolerance,
        `${profile.name}: midpoint drag did not resolve near the document midpoint`,
      );
    }
    if (profile.name === "boundary") {
      const terminal = manifest.markers.find((candidate) => candidate.label === "LUMEN_TERMINAL_MARKER");
      assertCondition(terminal !== undefined, `${profile.name}: fixture manifest did not contain its terminal marker`);
      await assertDragMarkerDisplayed(client, terminal.sourceOffset, terminal);
    }
    if (profile.name === "top-boundary") {
      assertCondition(
        finalStatus.scrollTop <= 1 &&
          finalStatus.scrollSourceOffset === 0 &&
          finalStatus.visibleSourceStart === 0 &&
          finalStatus.visiblePageCount > 0 &&
          Math.abs(finalStatus.visiblePageTop - finalStatus.documentPaddingBottom) <= 1,
        `${profile.name}: released top drag did not retain the document's symmetric top padding: ${JSON.stringify({
          documentPaddingBottom: finalStatus.documentPaddingBottom,
          scrollSourceOffset: finalStatus.scrollSourceOffset,
          scrollTop: finalStatus.scrollTop,
          visiblePageCount: finalStatus.visiblePageCount,
          visiblePageTop: finalStatus.visiblePageTop,
          visibleSourceStart: finalStatus.visibleSourceStart,
        })}`,
      );
    }
    assertCondition(!trace.truncated, `${profile.name}: viewport trace was truncated`);
    assertTrace(trace.records, profile.name, dragId, scrollRequests);
    const report = {
      finalSourceOffset: finalStatus.scrollSourceOffset,
      fixturePath,
      marker,
      profile: profile.name,
      recordCount: trace.records.length,
      responsiveness: telemetry(trace.records, scrollRequests.at(-1) ?? 0),
      traceRecords: trace.records,
    };
    process.stdout.write(
      `scroll-drag ${JSON.stringify({
        finalSourceOffset: report.finalSourceOffset,
        fixturePath: report.fixturePath,
        marker: report.marker,
        profile: report.profile,
        recordCount: report.recordCount,
        responsiveness: report.responsiveness,
      })}\n`,
    );
    await client.endViewportTrace(traceId);
    traceEnded = true;
    return report;
  } catch (error: unknown) {
    const status = await client.status().catch(() => null);
    trace ??= await client.readViewportTrace(traceId).catch(() => null);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nscroll-drag evidence=${JSON.stringify({
        status,
        trace: trace === null ? null : trace.records.slice(-16),
      })}`,
    );
  } finally {
    if (!traceEnded) {
      await client.endViewportTrace(traceId).catch(() => undefined);
    }
  }
}
