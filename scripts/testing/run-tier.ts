import {createReadStream} from "node:fs";
import {copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {spawn, type ChildProcess} from "node:child_process";
import {createHash} from "node:crypto";
import {cpus, hostname, release, totalmem, type as operatingSystemType} from "node:os";
import {join, resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {cleanTestEnvironment} from "./clean-environment.ts";
import {generatePerformanceFixtures} from "./generate-performance-fixtures.ts";
import {
  awaitAgentReady,
  AgentClient,
  type AgentStatus,
  type AgentTab,
  type ViewportTraceRecord,
  type AgentWindowState,
} from "../agent-api/client.ts";
import {
  assertDragMarkerDisplayed,
  dragProfiles,
  runDragProfile,
  type DragProfileName,
} from "../agent-api/scroll-drag.ts";
import {
  assertPerformanceRecordAvailable,
  parsePerformanceRunArguments,
  writePerformanceRecord,
  type PerformanceFixtureRecord,
  type PerformanceRecord,
  type PerformanceRunArguments,
  type PerformanceScenarioRecord,
} from "./performance-metrics.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readinessTimeoutMilliseconds = 15_000;
const pollIntervalMilliseconds = 50;
const tierNames = ["critical", "regular", "stress"] as const;
const testCaseNames = [
  "critical-agent-api-and-empty-viewer",
  "critical-agent-api-viewport-trace",
  "critical-viewer-actions",
  "critical-tabs-find-and-link-error",
  "critical-handoff",
  "layout-page-5mib-mixed",
  "regular-watcher-reload",
  "regular-watcher-directory-change",
  "regular-configuration-notice",
  "regular-local-link",
  "layout-page-20mib-mixed",
  "layout-page-20mib-malformed",
  "layout-page-100mib-prose",
  "layout-page-100mib-code",
  "layout-page-100mib-mixed",
  "layout-page-100mib-malformed",
  "scroll-drag-5mib-midpoint",
  "scroll-drag-5mib-fast-jump",
  "scroll-drag-5mib-erratic",
  "scroll-drag-5mib-boundary",
  "scroll-drag-5mib-top-boundary",
  "scroll-drag-5mib-repeat",
  "scroll-drag-5mib-find",
  "scroll-drag-20mib-fast-jump",
  "scroll-drag-100mib-boundary",
  "scroll-drag-100mib-fast-jump",
  "scroll-drag-tab-restoration",
  "stress-coalesced-scroll",
  "stress-tab-restoration",
] as const;
type TierName = (typeof tierNames)[number];
type TestCaseName = (typeof testCaseNames)[number];
type TestRun = {
  name: string;
  performance: PerformanceRunArguments | null;
  testCase: TestCaseName | null;
  tier: TierName;
};
type TestEnvironment = {
  application: ChildProcess;
  environment: NodeJS.ProcessEnv;
  fixtureRoot: string;
  launchReadyMilliseconds: number;
  root: string;
  socketPath: string;
  vite: ChildProcess;
};
const agentClients = new Map<string, AgentClient>();
const expectedAgentOperations = [
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
] as const;
const expectedAgentCapabilities = ["event", "await", "await-ready", "events", "status", "tabs", "inspection"] as const;
const expectedObservationSchemas = [
  "status",
  "tabs",
  "inspection",
  "find-state",
  "ui-state",
  "viewport-trace",
  "window-state",
  "document-work-events",
] as const;

function agentApi(socketPath: string): AgentClient {
  let client = agentClients.get(socketPath);
  if (client === undefined) {
    client = new AgentClient(socketPath);
    agentClients.set(socketPath, client);
  }
  return client;
}

function testFixturePath(environment: TestEnvironment, name: string): string {
  return join(environment.root, "documents", name);
}

function parseRun(): TestRun {
  const argumentsList = process.argv.slice(2);
  const [argument] = argumentsList;
  if (argument === undefined) {
    return {name: "critical", performance: null, testCase: null, tier: "critical"};
  }
  if (argument === "--performance") {
    return {
      name: "performance",
      performance: parsePerformanceRunArguments(argumentsList.slice(1), repositoryRoot),
      testCase: null,
      tier: "stress",
    };
  }
  if (argument === "--tier") {
    const tier = process.argv[3];
    if (tierNames.includes(tier as TierName) && process.argv.length === 4) {
      return {name: tier, performance: null, testCase: null, tier: tier as TierName};
    }
  }
  if (argument === "--case") {
    const testCase = process.argv[3];
    if (testCaseNames.includes(testCase as TestCaseName) && process.argv.length === 4) {
      const tier = testCase.startsWith("critical-")
        ? "critical"
        : testCase.startsWith("regular-")
          ? "regular"
          : "stress";
      return {name: testCase, performance: null, testCase: testCase as TestCaseName, tier};
    }
  }
  throw new Error(
    `usage: node scripts/testing/run-tier.ts [--tier ${tierNames.join("|")}] [--case ${testCaseNames.join("|")}] [--performance --scenario baseline|scroll-drag|wheel|tabs|enrichment --record performance/<name>.md]`,
  );
}

function elapsedMilliseconds(startedAt: number): string {
  return `${(performance.now() - startedAt).toFixed(0)}ms`;
}

async function writeOutput(message: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(message, (error) => {
      if (error === undefined || error === null) {
        resolveWrite();
      } else {
        rejectWrite(error);
      }
    });
  });
}

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectFailure(action: () => Promise<unknown>, description: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${description} unexpectedly completed`);
}

async function waitFor<T>(description: string, operation: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + readinessTimeoutMilliseconds;
  let lastError = "no result";
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) {
        return result;
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(pollIntervalMilliseconds);
  }
  throw new Error(`timed out waiting for ${description}: ${lastError}`);
}

async function run(command: string, argumentsList: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, argumentsList, {cwd: repositoryRoot, env: environment, stdio: "inherit"});
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} exited with ${code ?? "no exit code"}`));
      }
    });
  });
}

async function waitForFrontend(frontendUrl: string): Promise<void> {
  await waitFor("Vite readiness", async () => {
    try {
      const response = await fetch(frontendUrl, {signal: AbortSignal.timeout(250)});
      return response.ok ? true : null;
    } catch {
      return null;
    }
  });
}

// Tauri's fixed development URL would otherwise make tests share port 1420 with development.
async function startIsolatedVite(environment: NodeJS.ProcessEnv): Promise<{frontendUrl: string; vite: ChildProcess}> {
  const vite = spawn(
    process.execPath,
    [join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: repositoryRoot,
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let frontendUrl: string | null = null;
  let exitMessage: string | null = null;
  const collectOutput = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-2_048);
    frontendUrl ??= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? null;
  };
  vite.stdout?.on("data", collectOutput);
  vite.stderr?.on("data", collectOutput);
  vite.once("error", (error) => {
    exitMessage = error.message;
  });
  vite.once("exit", (code) => {
    exitMessage ??= `Vite exited with ${code ?? "no exit code"}: ${output.trim()}`;
  });

  try {
    const isolatedFrontendUrl = await waitFor("isolated Vite port assignment", async () => {
      if (frontendUrl !== null) {
        return frontendUrl;
      }
      if (exitMessage !== null) {
        throw new Error(exitMessage);
      }
      return null;
    });
    await waitForFrontend(isolatedFrontendUrl);
    return {frontendUrl: isolatedFrontendUrl, vite};
  } catch (error: unknown) {
    await stopChild(vite);
    throw error;
  }
}

async function createEnvironment(): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "lumen-test-"));
  const configurationHome = join(root, "config");
  const stateHome = join(root, "state");
  const cacheHome = join(root, "cache");
  const runtimeDirectory = join(root, "runtime");
  const documentsDirectory = join(root, "documents");
  const fixtureRoot = join(repositoryRoot, "fixtures", "performance");
  await Promise.all([
    mkdir(join(configurationHome, "lumen"), {recursive: true}),
    mkdir(stateHome, {recursive: true}),
    mkdir(cacheHome, {recursive: true}),
    mkdir(runtimeDirectory, {recursive: true}),
    mkdir(documentsDirectory, {recursive: true}),
  ]);
  await Promise.all([
    copyFile(join(repositoryRoot, "fixtures", "link-target.md"), join(documentsDirectory, "link-target.md")),
    copyFile(
      join(repositoryRoot, "fixtures", "rendering-comparison.md"),
      join(documentsDirectory, "rendering-comparison.md"),
    ),
    copyFile(
      join(repositoryRoot, "fixtures", "syntax-highlighting.md"),
      join(documentsDirectory, "syntax-highlighting.md"),
    ),
  ]);
  await writeFile(join(configurationHome, "lumen", "config.toml"), "version = 1\n[tabs]\nenabled = true\n", "utf8");
  const socketPath = join(root, "lumen.sock");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LUMEN_TEST_ROOT: root,
    LUMEN_TEST_FIXTURE_ROOT: fixtureRoot,
    XDG_RUNTIME_DIR: runtimeDirectory,
    XDG_CACHE_HOME: cacheHome,
    XDG_CONFIG_HOME: configurationHome,
    XDG_STATE_HOME: stateHome,
  };
  let vite: ChildProcess | null = null;
  let application: ChildProcess | null = null;
  try {
    const isolatedVite = await startIsolatedVite(environment);
    vite = isolatedVite.vite;
    environment.LUMEN_TEST_DEV_URL = isolatedVite.frontendUrl;
    await run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], environment);
    const applicationArguments = ["--agent-socket", socketPath, "--test-input-guard"];
    const launchStartedAt = performance.now();
    application = spawn(join(repositoryRoot, "src-tauri", "target", "debug", "lumen"), applicationArguments, {
      cwd: repositoryRoot,
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    agentClients.set(socketPath, await awaitAgentReady(socketPath));
    return {
      application,
      environment,
      fixtureRoot,
      launchReadyMilliseconds: performance.now() - launchStartedAt,
      root,
      socketPath,
      vite,
    };
  } catch (error: unknown) {
    await Promise.all([stopChild(application), stopChild(vite)]);
    throw error;
  }
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  const processIdentifier = child?.pid;
  if (processIdentifier === undefined) {
    return;
  }
  try {
    process.kill(-processIdentifier, "SIGTERM");
  } catch {
    // The process may already have exited after normal shutdown.
  }
}

async function waitForChildExit(child: ChildProcess | null, description: string): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveExit, rejectExit) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      child.removeListener("error", rejectError);
      child.removeListener("exit", handleExit);
    };
    const rejectError = (error: Error): void => {
      cleanup();
      rejectExit(error);
    };
    const handleExit = (): void => {
      cleanup();
      resolveExit();
    };
    timeout = setTimeout(() => {
      cleanup();
      let processAlive = false;
      try {
        process.kill(child.pid ?? 0, 0);
        processAlive = true;
      } catch {
        processAlive = false;
      }
      rejectExit(
        new Error(
          `timed out waiting for ${description}: pid=${child.pid ?? "unknown"} alive=${processAlive} exit_code=${child.exitCode ?? "none"} signal=${child.signalCode ?? "none"}`,
        ),
      );
    }, readinessTimeoutMilliseconds);
    child.once("error", rejectError);
    child.once("exit", handleExit);
  });
}

async function stopEnvironment(environment: TestEnvironment): Promise<void> {
  let applicationStoppedNormally = false;
  try {
    await agentApi(environment.socketPath).quit();
    await waitForChildExit(environment.application, "normal Lumen shutdown");
    applicationStoppedNormally = true;
  } finally {
    if (!applicationStoppedNormally) {
      await stopChild(environment.application);
    }
    await waitForChildExit(environment.application, "Lumen process exit");
    await stopChild(environment.vite);
    await waitForChildExit(environment.vite, "Vite process exit");
    await rm(environment.root, {force: true, recursive: true});
    // WebKit helper processes can finish releasing test-owned temporary state
    // after Lumen's direct child exits. Re-run the canonical cleanup before
    // asserting the mandatory clean-slate postcondition.
    await cleanTestEnvironment();
  }
}

async function failureEvidence(environment: TestEnvironment): Promise<string> {
  const logDirectory = join(environment.root, "state", "lumen", "development", "logs");
  const logs = await readdir(logDirectory)
    .then((entries) => entries.filter((entry) => entry.endsWith(".log")).sort())
    .catch(() => [] as string[]);
  const latestLog = logs.at(-1);
  const runLog =
    latestLog === undefined
      ? "unavailable"
      : await readFile(join(logDirectory, latestLog), "utf8")
          .then((contents) => contents.slice(-8_192))
          .catch(() => "unavailable");
  const application = environment.application;
  return JSON.stringify({
    applicationExitCode: application?.exitCode ?? null,
    applicationSignal: application?.signalCode ?? null,
    runLog,
  });
}

async function openFixture(socketPath: string, fixturePath: string): Promise<AgentStatus> {
  const fixtureSize = (await stat(fixturePath)).size;
  const completion = await agentApi(socketPath).sendAndAwait("open", fixturePath);
  assertCondition(completion.outcome === "completed", `failed to open ${fixturePath}: ${completion.outcome}`);
  const status = await agentApi(socketPath).status();
  assertCondition(
    status.sourceLength === fixtureSize && status.sourceStart < status.sourceEnd && status.visiblePageCount > 0,
    `${fixturePath} was not displayed after its open completion: ${JSON.stringify(status)}`,
  );
  return status;
}

async function closeActive(socketPath: string): Promise<void> {
  await closeActiveToTabCount(socketPath, 0);
  const status = await agentApi(socketPath).status();
  assertCondition(status.sourceLength === 0, "empty viewer was not displayed");
}

async function closeActiveToTabCount(socketPath: string, expectedTabCount: number): Promise<void> {
  const completion = await agentApi(socketPath).sendAndAwait("close");
  assertCondition(completion.outcome === "completed", `failed to close document: ${completion.outcome}`);
  assertCondition(
    (await diagnosticTabs(socketPath)).length === expectedTabCount,
    `tab close did not leave ${expectedTabCount} tabs`,
  );
}

async function reportTestPhase(environment: TestEnvironment, tier: TierName, phase: string): Promise<void> {
  const completion = await agentApi(environment.socketPath).sendAndAwait("test-run-state", `${tier} ${phase}`);
  assertCondition(completion.outcome === "completed", `test status banner did not update: ${completion.outcome}`);
  const state = await agentApi(environment.socketPath).windowState();
  assertCondition(
    state.testGuardActive && state.testGuardTier === tier && state.testGuardPhase === phase,
    "test input guard state did not update",
  );
}

async function runLayoutPageScenario(environment: TestEnvironment, sizes: string, kinds: string): Promise<void> {
  await run(
    "node",
    [
      "scripts/agent-api/scenarios/layout-page-viewer.ts",
      "--socket",
      environment.socketPath,
      "--sizes",
      sizes,
      "--kinds",
      kinds,
    ],
    environment.environment,
  );
}

async function diagnosticTabs(socketPath: string): Promise<readonly AgentTab[]> {
  return agentApi(socketPath).tabs();
}

async function runAgentApiAndEmptyViewerChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const capabilities = await agentApi(socketPath).hello();
  assertCondition(
    capabilities.operations.join(",") === expectedAgentOperations.join(","),
    `Agent API capability contract changed: ${capabilities.operations.join(",")}`,
  );
  assertCondition(
    capabilities.capabilities.join(",") === expectedAgentCapabilities.join(","),
    `Agent API transport capability contract changed: ${capabilities.capabilities.join(",")}`,
  );
  assertCondition(
    capabilities.observationSchemas.join(",") === expectedObservationSchemas.join(","),
    `Agent API observation schema contract changed: ${capabilities.observationSchemas.join(",")}`,
  );
  const initialWindowState: AgentWindowState = await agentApi(socketPath).windowState();
  assertCondition(
    initialWindowState.visible &&
      !initialWindowState.enabled &&
      !initialWindowState.minimized &&
      initialWindowState.zoomFactor === 1,
    "initial window state was incomplete",
  );
  const initialStatus = await agentApi(socketPath).status();
  assertCondition(initialStatus.sourceLength === 0, "fresh Lumen did not start with an empty viewer");
  assertCondition((await agentApi(socketPath).tabs()).length === 0, "fresh Lumen opened a document");
  const emptyViewerHtml = await agentApi(socketPath).displayedHtml(0, 1024);
  assertCondition(
    emptyViewerHtml.content.includes("Open Markdown document") && emptyViewerHtml.content.includes("Choose File"),
    "fresh Lumen did not present the empty viewer",
  );
}

async function runAgentApiViewportTraceChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const client = agentApi(socketPath);
  const firstFixture = join(environment.fixtureRoot, "lumen-mixed-5mib.md");
  const secondFixture = join(environment.fixtureRoot, "lumen-mixed-20mib.md");
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [5, 20]});
  await openFixture(socketPath, firstFixture);
  const directoryReady = await client.sendAndAwait("directory-ready");
  assertCondition(directoryReady.outcome === "completed", "viewport trace fixture directory was not ready");
  const initialSettlement = await client.sendAndAwait("scroll-settled");
  assertCondition(initialSettlement.outcome === "completed", "viewport trace fixture viewport was not stable");
  const traceId = await client.beginViewportTrace("trace-contract");
  await expectFailure(() => client.beginViewportTrace("second-trace"), "a second active viewport trace");
  const initialTrace = await client.readViewportTrace(traceId);
  assertCondition(
    initialTrace.records[0]?.event === "viewport-trace-started",
    `viewport trace did not retain its deterministic start record: ${JSON.stringify(initialTrace)}`,
  );

  const initialStatus = await client.status();
  const maximumScroll = Math.max(0, initialStatus.scrollHeight - initialStatus.scrollClientHeight);
  assertCondition(maximumScroll > 0, "viewport trace fixture has no scroll range");
  for (let index = 1; index <= 96; index += 1) {
    const fraction = index % 2 === 0 ? 0.2 : 0.8;
    const scroll = await client.sendAndAwait("scroll", String(Math.floor(maximumScroll * fraction)));
    assertCondition(scroll.outcome === "completed", "viewport trace traffic did not complete");
  }
  const settled = await client.sendAndAwait("scroll-settled");
  assertCondition(settled.outcome === "completed", "viewport trace traffic did not settle");
  const truncatedTrace = await client.readViewportTrace(traceId);
  assertCondition(
    truncatedTrace.truncated && truncatedTrace.firstOmittedSequence !== null,
    "viewport trace did not explicitly report bounded truncation",
  );
  const ended = await client.endViewportTrace(traceId);
  assertCondition(
    ended.outcome === "completed" && ended.detail.includes("truncated=true"),
    `viewport trace final summary was incorrect: ${JSON.stringify(ended)}`,
  );
  await expectFailure(() => client.readViewportTrace(traceId), "an explicitly ended viewport trace read");

  const spanningTraceId = await client.beginViewportTrace("spanning-trace");
  await openFixture(socketPath, secondFixture);
  const spanningTrace = await client.readViewportTrace(spanningTraceId);
  assertCondition(
    spanningTrace.records.some((record) => record.documentGeneration !== spanningTrace.documentGeneration),
    `viewport trace did not retain records after a document-generation change: ${JSON.stringify(spanningTrace)}`,
  );
  const spanningEnd = await client.endViewportTrace(spanningTraceId);
  assertCondition(spanningEnd.outcome === "completed", "a spanning viewport trace did not end cleanly");
  await closeActiveToTabCount(socketPath, 1);
  await closeActive(socketPath);
}

async function runViewerActionChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const comparisonFixture = testFixturePath(environment, "rendering-comparison.md");
  await openFixture(socketPath, comparisonFixture);
  const duplicateOpen = await agentApi(socketPath).sendAndAwait("open", comparisonFixture);
  assertCondition(duplicateOpen.outcome === "completed", "opening the active document did not complete");
  assertCondition((await agentApi(socketPath).tabs()).length === 1, "opening an active document duplicated its tab");
  const reload = await agentApi(socketPath).sendAndAwait("reload");
  assertCondition(reload.outcome === "completed", `Agent API reload did not complete: ${reload.outcome}`);
  const zoomOut = await agentApi(socketPath).sendAndAwait("zoom", "out");
  assertCondition(zoomOut.outcome === "completed", "zoom out did not complete");
  assertCondition((await agentApi(socketPath).windowState()).zoomFactor === 0.9, "zoom out was not applied");
  const zoomReset = await agentApi(socketPath).sendAndAwait("zoom", "reset");
  assertCondition(zoomReset.outcome === "completed", "zoom reset did not complete");
  assertCondition((await agentApi(socketPath).windowState()).zoomFactor === 1, "zoom reset was not applied");
  const focus = await agentApi(socketPath).sendAndAwait("focus");
  assertCondition(focus.outcome === "completed", "window focus action did not complete");
  await closeActive(socketPath);
}

async function runTabsFindAndLinkErrorChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const comparisonFixture = testFixturePath(environment, "rendering-comparison.md");
  await openFixture(socketPath, comparisonFixture);
  const secondFixture = testFixturePath(environment, "link-target.md");
  await openFixture(socketPath, secondFixture);
  const activeSecondTab = (await diagnosticTabs(socketPath)).find((tab) => tab.active);
  assertCondition(activeSecondTab !== undefined, "second document did not become active");
  const closeOtherTabs = await agentApi(socketPath).sendAndAwait("close-tabs", `${activeSecondTab.id} other`);
  assertCondition(closeOtherTabs.outcome === "completed", "close other tabs did not complete");
  const remainingTabs = await diagnosticTabs(socketPath);
  assertCondition(
    remainingTabs.length === 1 && remainingTabs[0]?.id === activeSecondTab.id,
    "close other tabs did not retain the selected tab",
  );
  const find = await agentApi(socketPath).sendAndAwait("find", "Example");
  assertCondition(find.outcome === "completed", "Find query did not complete");
  const findNext = await agentApi(socketPath).sendAndAwait("find-next");
  assertCondition(findNext.outcome === "completed" || findNext.outcome === "not-found", "Find next did not complete");
  const findPrevious = await agentApi(socketPath).sendAndAwait("find-previous");
  assertCondition(
    findPrevious.outcome === "completed" || findPrevious.outcome === "not-found",
    "Find previous did not complete",
  );
  const findClear = await agentApi(socketPath).sendAndAwait("find-clear");
  assertCondition(findClear.outcome === "completed", "Find clear did not complete");
  const missingLinkResponse = await agentApi(socketPath).sendAndAwait("link", "missing.md");
  assertCondition(
    missingLinkResponse.outcome === "completed" && missingLinkResponse.detail === "link-error-notice",
    `missing local link error notice was not displayed: ${missingLinkResponse.outcome} ${missingLinkResponse.detail}`,
  );
  await closeActive(socketPath);
}

async function runCriticalHandoffChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  await runLayoutPageScenario(environment, "5", "mixed");

  const handoffFixture = join(environment.fixtureRoot, "lumen-mixed-5mib.md");
  const handoff = await agentApi(socketPath).sendAndAwait("handoff-open", handoffFixture);
  assertCondition(handoff.outcome === "completed", `handoff receiver did not complete: ${handoff.outcome}`);
  const handoffStatus = await agentApi(socketPath).status();
  assertCondition(handoffStatus.sourceStart < 1_024, "native handoff did not display the initial source range");
  await closeActive(socketPath);
}

async function runWatcherReloadChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const watchedFixture = testFixturePath(environment, "reload-on-save.md");
  await copyFile(join(repositoryRoot, "fixtures", "reload-on-save.md"), watchedFixture);
  await openFixture(socketPath, watchedFixture);
  const watcherReady = await agentApi(socketPath).sendAndAwait("watcher-ready");
  assertCondition(watcherReady.outcome === "completed", "watcher did not become ready");
  const watcherReloadRequest = await agentApi(socketPath).begin("watcher-reload");
  await writeFile(watchedFixture, "# Reload fixture\n\nThis file changed during an isolated automated test.\n", "utf8");
  const watcherReload = await agentApi(socketPath).await(watcherReloadRequest);
  assertCondition(watcherReload.outcome === "completed", "watcher reload did not complete");
  await closeActive(socketPath);
}

async function runWatcherDirectoryChangeChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const reconfiguredDirectory = join(environment.root, "documents", "watcher-reconfigured-directory");
  const reconfiguredFixture = join(reconfiguredDirectory, "reload-on-save.md");
  await mkdir(reconfiguredDirectory);
  await copyFile(join(repositoryRoot, "fixtures", "reload-on-save.md"), reconfiguredFixture);
  await openFixture(socketPath, reconfiguredFixture);
  const reconfiguredWatcherReady = await agentApi(socketPath).sendAndAwait("watcher-ready");
  assertCondition(reconfiguredWatcherReady.outcome === "completed", "watcher did not reconfigure for a new directory");
  const reconfiguredReloadRequest = await agentApi(socketPath).begin("watcher-reload");
  await writeFile(
    reconfiguredFixture,
    "# Reconfigured watcher fixture\n\nThis file changed after its directory was added.\n",
    "utf8",
  );
  const reconfiguredReload = await agentApi(socketPath).await(reconfiguredReloadRequest);
  assertCondition(reconfiguredReload.outcome === "completed", "reconfigured watcher reload did not complete");
  await closeActive(socketPath);
}

async function runConfigurationNoticeChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const configurationPath = join(environment.root, "config", "lumen", "config.toml");
  const configurationNoticeRequest = await agentApi(socketPath).begin("configuration-notice");
  await writeFile(configurationPath, 'version = 1\n[appearance]\ntheme = "dark"\n', "utf8");
  const configurationNotice = await agentApi(socketPath).await(configurationNoticeRequest);
  assertCondition(configurationNotice.outcome === "completed", "configuration restart notice was not displayed");
  const dismissConfigurationNotice = await agentApi(socketPath).sendAndAwait("notice-dismiss", "configuration");
  assertCondition(
    dismissConfigurationNotice.outcome === "completed",
    `configuration notice was not dismissed: ${dismissConfigurationNotice.outcome}`,
  );
}

async function runLocalLinkChecks(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const comparisonFixture = testFixturePath(environment, "rendering-comparison.md");
  const targetFixture = testFixturePath(environment, "link-target.md");
  const targetFixtureSize = (await stat(targetFixture)).size;
  await openFixture(socketPath, comparisonFixture);
  const linkResponse = await agentApi(socketPath).sendAndAwait("link", "link-target.md#linked-target");
  assertCondition(
    linkResponse.outcome === "completed" && linkResponse.detail === "link-followed",
    "local Markdown link did not complete",
  );
  const linkStatus = await agentApi(socketPath).status();
  assertCondition(
    linkStatus.sourceLength === targetFixtureSize && linkStatus.visiblePageCount > 0,
    "local Markdown link navigation was incorrect",
  );
  await closeActive(socketPath);
}

async function runCriticalChecks(environment: TestEnvironment): Promise<void> {
  await runAgentApiAndEmptyViewerChecks(environment);
  await runAgentApiViewportTraceChecks(environment);
  await runViewerActionChecks(environment);
  await runTabsFindAndLinkErrorChecks(environment);
  await runCriticalHandoffChecks(environment);
}

async function runRegularChecks(environment: TestEnvironment): Promise<void> {
  await runWatcherReloadChecks(environment);
  await runWatcherDirectoryChangeChecks(environment);
  await runConfigurationNoticeChecks(environment);
  await runLocalLinkChecks(environment);
  await runLayoutPageScenario(environment, "20", "mixed,malformed");
}

async function runStressChecks(environment: TestEnvironment): Promise<void> {
  await runLayoutPageScenario(environment, "5,20,100", "prose,code,mixed,malformed");
  await runStressCoalescedScroll(environment);
  await runStressTabRestoration(environment);
  await runScrollDragScenario(environment, 5, "slow-linear");
  await runScrollDragScenario(environment, 5, "fast-jump");
  await runScrollDragScenario(environment, 5, "erratic");
  await runScrollDragScenario(environment, 5, "boundary");
  await runScrollDragScenario(environment, 5, "top-boundary");
  await runScrollDragScenario(environment, 5, "repeat");
  await runScrollDragFindScenario(environment);
  await runScrollDragScenario(environment, 20, "fast-jump");
  await runScrollDragScenario(environment, 100, "boundary");
  await runScrollDragScenario(environment, 100, "fast-jump");
  await runScrollDragTabRestorationScenario(environment);
}

async function runStressCoalescedScroll(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;

  const mediumFixture = join(environment.fixtureRoot, "lumen-mixed-20mib.md");
  const mediumSize = (await stat(mediumFixture)).size;
  const mediumStatus = await openFixture(socketPath, mediumFixture);
  const maximumScroll = Math.max(0, mediumStatus.scrollHeight - mediumStatus.scrollClientHeight);
  assertCondition(maximumScroll > 0, "stress fixture has no logical scroll range");
  for (const fraction of [0.2, 0.5, 0.8]) {
    const completion = await agentApi(socketPath).sendAndAwait("scroll", String(Math.floor(maximumScroll * fraction)));
    assertCondition(completion.outcome === "completed", "coalesced scroll input did not complete");
  }
  const scrollSettled = await agentApi(socketPath).sendAndAwait("scroll-settled");
  assertCondition(scrollSettled.outcome === "completed", "coalesced scroll input did not settle");
  const terminal = await agentApi(socketPath).sendAndAwait("terminal-layout");
  assertCondition(terminal.outcome === "completed", "coalesced terminal seek did not complete");
  const terminalStatus = await agentApi(socketPath).status();
  assertCondition(
    terminalStatus.sourceLength === mediumSize && terminalStatus.sourceEnd === mediumSize,
    "coalesced terminal seek did not display the terminal range",
  );
  const returnToStart = await agentApi(socketPath).sendAndAwait("seek", "0");
  assertCondition(returnToStart.outcome === "completed", "coalesced return seek did not complete");
  const startStatus = await agentApi(socketPath).status();
  assertCondition(startStatus.sourceStart < 1_024, "coalesced return seek was incorrect");
  await closeActive(socketPath);
}

async function runStressTabRestoration(environment: TestEnvironment): Promise<void> {
  const {socketPath} = environment;
  const firstFixture = join(environment.fixtureRoot, "lumen-mixed-5mib.md");
  const secondFixture = join(environment.fixtureRoot, "lumen-malformed-100mib.md");
  const firstSize = (await stat(firstFixture)).size;
  const secondSize = (await stat(secondFixture)).size;
  await openFixture(socketPath, firstFixture);
  const firstTargetOffset = Math.floor(firstSize / 2);
  const firstSeek = await agentApi(socketPath).sendAndAwait("seek", String(firstTargetOffset));
  assertCondition(firstSeek.outcome === "completed", "first large-tab seek did not complete");
  const firstAnchorStatus = await agentApi(socketPath).status();
  assertCondition(
    firstAnchorStatus.sourceStart <= firstTargetOffset && firstTargetOffset < firstAnchorStatus.sourceEnd,
    "first large-tab seek did not display its anchor",
  );
  const [firstTab] = await diagnosticTabs(socketPath);
  assertCondition(firstTab !== undefined, "first large tab was not retained");

  await openFixture(socketPath, secondFixture);
  const firstSavedTab = (await diagnosticTabs(socketPath)).find((tab) => tab.id === firstTab.id);
  assertCondition(firstSavedTab !== undefined, "first large-tab was not retained during the tab transition");
  const firstRestorationAnchor = firstSavedTab.sourceOffset;
  const secondInitialStatus = await agentApi(socketPath).status();
  assertCondition(secondInitialStatus.sourceStart < 1_024, "new large tab did not start at its initial range");
  const secondInitialHtml = await agentApi(socketPath).displayedHtml(0, 1024);
  assertCondition(
    secondInitialHtml.content.includes("Malformed boundary section 1"),
    `a newly opened large tab did not display its initial rendered range: ${JSON.stringify({
      html: secondInitialHtml.content,
      status: secondInitialStatus,
    })}`,
  );
  const secondTerminal = await agentApi(socketPath).sendAndAwait("terminal-layout");
  assertCondition(secondTerminal.outcome === "completed", "second large-tab terminal seek did not complete");
  const secondTerminalStatus = await agentApi(socketPath).status();
  assertCondition(
    secondTerminalStatus.sourceLength === secondSize && secondTerminalStatus.sourceEnd === secondSize,
    "second large-tab terminal seek was incorrect",
  );
  const tabs = await diagnosticTabs(socketPath);
  assertCondition(tabs.length === 2, "opening a second large document did not create a tab");
  const selectFirst = await agentApi(socketPath).sendAndAwait("select-tab", String(firstTab.id));
  assertCondition(selectFirst.outcome === "completed", "first large-tab selection did not complete");
  const restoredFirstStatus = await agentApi(socketPath).status();
  assertCondition(
    restoredFirstStatus.sourceLength === firstSize &&
      restoredFirstStatus.sourceStart <= firstRestorationAnchor &&
      firstRestorationAnchor < restoredFirstStatus.sourceEnd,
    `first large-tab anchor was not restored: ${JSON.stringify({
      status: restoredFirstStatus,
      savedTab: firstSavedTab,
    })}`,
  );
  const secondTab = (await diagnosticTabs(socketPath)).find((tab) => tab.id !== firstTab.id);
  assertCondition(secondTab !== undefined, "second large tab was not retained");
  const selectSecond = await agentApi(socketPath).sendAndAwait("select-tab", String(secondTab.id));
  assertCondition(selectSecond.outcome === "completed", "second large-tab selection did not complete");
  const restoredSecondStatus = await agentApi(socketPath).status();
  assertCondition(
    restoredSecondStatus.sourceLength === secondSize && restoredSecondStatus.sourceEnd === secondSize,
    `second large-tab terminal anchor was not restored: ${JSON.stringify(restoredSecondStatus)}`,
  );
  await closeActiveToTabCount(socketPath, 1);
  await closeActive(socketPath);
}

async function runScrollDragScenario(
  environment: TestEnvironment,
  size: 5 | 20 | 100,
  profileName: DragProfileName,
): Promise<void> {
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [size]});
  const fixturePath = join(environment.fixtureRoot, `lumen-mixed-${size}mib.md`);
  await openFixture(environment.socketPath, fixturePath);
  const profile = dragProfiles.find((candidate) => candidate.name === profileName);
  assertCondition(profile !== undefined, `scroll-drag ${profileName} profile is unavailable`);
  const report = await runDragProfile(agentApi(environment.socketPath), fixturePath, profile);
  assertCondition(
    report.finalSourceOffset >= 0 && report.finalSourceOffset < (await stat(fixturePath)).size,
    `scroll-drag ${profileName} did not remain within the fixture bounds`,
  );
  await closeActive(environment.socketPath);
}

async function runScrollDragFindScenario(environment: TestEnvironment): Promise<void> {
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [5]});
  const fixturePath = join(environment.fixtureRoot, "lumen-mixed-5mib.md");
  const client = agentApi(environment.socketPath);
  await openFixture(environment.socketPath, fixturePath);
  const find = await client.sendAndAwait("find", "Mixed section");
  assertCondition(find.outcome === "completed", "scroll-drag Find query did not complete");
  const initialFindState = await client.findState();
  assertCondition(
    initialFindState.query === "Mixed section" &&
      initialFindState.activeRangeConnected &&
      initialFindState.highlightMatchesActiveRange &&
      initialFindState.highlightRectCount > 0,
    `scroll-drag Find did not create a live initial highlight: ${JSON.stringify(initialFindState)}`,
  );
  const profile = dragProfiles.find((candidate) => candidate.name === "erratic");
  assertCondition(profile !== undefined, "scroll-drag erratic profile is unavailable");
  await runDragProfile(client, fixturePath, profile);
  const finalFindState = await client.findState();
  assertCondition(
    finalFindState.query === "Mixed section" &&
      finalFindState.activeRangeConnected &&
      finalFindState.highlightMatchesActiveRange &&
      finalFindState.highlightRectCount === finalFindState.activeRangeRectCount,
    `scroll-drag Find highlight detached from the active match: ${JSON.stringify(finalFindState)}`,
  );
  await closeActive(environment.socketPath);
}

async function runScrollDragTabRestorationScenario(environment: TestEnvironment): Promise<void> {
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [5, 20]});
  const client = agentApi(environment.socketPath);
  const firstFixture = join(environment.fixtureRoot, "lumen-mixed-5mib.md");
  const secondFixture = join(environment.fixtureRoot, "lumen-mixed-20mib.md");
  const repeat = dragProfiles.find((candidate) => candidate.name === "repeat");
  const fastJump = dragProfiles.find((candidate) => candidate.name === "fast-jump");
  assertCondition(repeat !== undefined && fastJump !== undefined, "scroll-drag tab profiles are unavailable");

  await openFixture(environment.socketPath, firstFixture);
  const firstReport = await runDragProfile(client, firstFixture, repeat);
  const firstTab = (await client.tabs()).find((tab) => tab.active);
  assertCondition(firstTab !== undefined, "first scroll-drag tab was not active");

  await openFixture(environment.socketPath, secondFixture);
  const secondReport = await runDragProfile(client, secondFixture, fastJump);
  const secondTab = (await client.tabs()).find((tab) => tab.active);
  assertCondition(secondTab !== undefined && secondTab.id !== firstTab.id, "second scroll-drag tab was not active");

  const selectFirst = await client.sendAndAwait("select-tab", String(firstTab.id));
  assertCondition(selectFirst.outcome === "completed", "first scroll-drag tab did not restore");
  await assertDragMarkerDisplayed(client, firstReport.finalSourceOffset, firstReport.marker);

  const selectSecond = await client.sendAndAwait("select-tab", String(secondTab.id));
  assertCondition(selectSecond.outcome === "completed", "second scroll-drag tab did not restore");
  await assertDragMarkerDisplayed(client, secondReport.finalSourceOffset, secondReport.marker);
  await closeActiveToTabCount(environment.socketPath, 1);
  await closeActive(environment.socketPath);
}

type TimedResult<T> = {elapsedMilliseconds: number; value: T};

function summarizedMilliseconds(values: readonly number[]): Readonly<Record<string, number | null>> {
  if (values.length === 0) {
    return {count: 0, maximumMilliseconds: null, medianMilliseconds: null, minimumMilliseconds: null};
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0 ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2 : (ordered[middle] ?? 0);
  return {
    count: ordered.length,
    maximumMilliseconds: Number(Math.max(...ordered).toFixed(3)),
    medianMilliseconds: Number(median.toFixed(3)),
    minimumMilliseconds: Number(Math.min(...ordered).toFixed(3)),
  };
}

async function timed<T>(action: () => Promise<T>): Promise<TimedResult<T>> {
  const startedAt = performance.now();
  const value = await action();
  return {elapsedMilliseconds: Number((performance.now() - startedAt).toFixed(3)), value};
}

function compactStatus(status: AgentStatus): Readonly<Record<string, number | boolean | string>> {
  return {
    directoryPageCount: status.directoryPageCount,
    displayedHtmlBytes: status.displayedHtmlBytes,
    geometryRevision: status.geometryRevision,
    indexBytes: status.indexBytes,
    pendingPageRequest: status.pendingPageRequest,
    preparedHtmlBytes: status.preparedHtmlBytes,
    preparedPageCount: status.preparedPageCount,
    sourceCacheBytes: status.sourceCacheBytes,
    sourceLength: status.sourceLength,
    visiblePageCount: status.visiblePageCount,
  };
}

function traceDurations(
  records: readonly ViewportTraceRecord[],
  earlierEvent: string,
  laterEvent: string,
): readonly number[] {
  return records.flatMap((earlier, index) => {
    if (earlier.event !== earlierEvent) {
      return [];
    }
    const later = records.slice(index + 1).find((record) => record.event === laterEvent);
    return later === undefined ? [] : [later.elapsedMilliseconds - earlier.elapsedMilliseconds];
  });
}

async function fixtureChecksum(fixturePath: string): Promise<string> {
  return new Promise<string>((resolveChecksum, rejectChecksum) => {
    const hash = createHash("sha256");
    const input = createReadStream(fixturePath);
    input.once("error", rejectChecksum);
    input.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    input.once("end", () => resolveChecksum(hash.digest("hex")));
  });
}

function fixtureClass(fixturePath: string): string {
  const filename = fixturePath.slice(fixturePath.lastIndexOf("/") + 1);
  const match = /^lumen-([a-z-]+)-\d+mib\.md$/.exec(filename);
  return match?.[1] ?? "compact";
}

async function fixtureRecord(fixturePath: string): Promise<PerformanceFixtureRecord> {
  return {
    bytes: (await stat(fixturePath)).size,
    checksum: await fixtureChecksum(fixturePath),
    documentClass: fixtureClass(fixturePath),
    filename: fixturePath.slice(fixturePath.lastIndexOf("/") + 1),
  };
}

async function runWheelPerformanceScenario(
  environment: TestEnvironment,
  size: 5 | 20 | 100,
): Promise<PerformanceScenarioRecord> {
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [size]});
  const fixturePath = join(environment.fixtureRoot, `lumen-mixed-${size}mib.md`);
  const client = agentApi(environment.socketPath);
  const open = await timed(() => openFixture(environment.socketPath, fixturePath));
  const ready = await client.sendAndAwait("directory-ready");
  assertCondition(ready.outcome === "completed", `wheel-${size}mib: directory did not become ready`);
  const initialSettlement = await client.sendAndAwait("scroll-settled");
  assertCondition(initialSettlement.outcome === "completed", `wheel-${size}mib: initial viewport did not settle`);
  const traceId = await client.beginViewportTrace(`performance-wheel-${size}`);
  let traceEnded = false;
  try {
    const initialStatus = await client.status();
    const scrollRange = Math.max(0, initialStatus.scrollHeight - initialStatus.scrollClientHeight);
    assertCondition(scrollRange > 0, `wheel-${size}mib: fixture has no scroll range`);
    const samples: Array<Readonly<Record<string, number>>> = [];
    for (const fraction of [0.2, 0.5, 0.8] as const) {
      const scroll = await timed(async () => {
        const completion = await client.sendAndAwait("scroll", String(Math.floor(scrollRange * fraction)));
        assertCondition(completion.outcome === "completed", `wheel-${size}mib: scroll was not consumed`);
        const settled = await client.sendAndAwait("scroll-settled");
        assertCondition(settled.outcome === "completed", `wheel-${size}mib: scroll did not settle`);
      });
      const status = await client.status();
      const inspection = await client.displayedHtml(0, 256);
      assertCondition(
        status.visiblePageCount > 0 && inspection.bytes > 0,
        `wheel-${size}mib: scroll left no reader-visible content`,
      );
      samples.push({
        fraction,
        operationMilliseconds: scroll.elapsedMilliseconds,
        sourceOffset: status.scrollSourceOffset,
      });
    }
    const trace = await client.readViewportTrace(traceId);
    assertCondition(!trace.truncated, `wheel-${size}mib: viewport trace was truncated`);
    const operationMilliseconds = samples.map((sample) => sample.operationMilliseconds);
    const nativeToDisplayed = traceDurations(trace.records, "native-scroll-received", "reader-position-displayed");
    const finalStatus = await client.status();
    await client.endViewportTrace(traceId);
    traceEnded = true;
    await closeActive(environment.socketPath);
    return {
      cold: false,
      name: `wheel-${size}mib-mixed`,
      rawSamples: {openMilliseconds: open.elapsedMilliseconds, samples, traceRecordCount: trace.records.length},
      summary: {
        nativeToDisplayedMilliseconds: summarizedMilliseconds(nativeToDisplayed),
        operationMilliseconds: summarizedMilliseconds(operationMilliseconds),
        resourceBounds: compactStatus(finalStatus),
      },
    };
  } finally {
    if (!traceEnded) {
      await client.endViewportTrace(traceId).catch(() => undefined);
    }
  }
}

async function runScrollDragPerformanceScenario(
  environment: TestEnvironment,
  size: 5 | 20 | 100,
  profileNames: readonly DragProfileName[],
): Promise<PerformanceScenarioRecord> {
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [size]});
  const fixturePath = join(environment.fixtureRoot, `lumen-mixed-${size}mib.md`);
  const open = await timed(() => openFixture(environment.socketPath, fixturePath));
  const reports = [];
  for (const profileName of profileNames) {
    const profile = dragProfiles.find((candidate) => candidate.name === profileName);
    assertCondition(profile !== undefined, `performance drag profile is unavailable: ${profileName}`);
    reports.push(await runDragProfile(agentApi(environment.socketPath), fixturePath, profile));
  }
  const finalStatus = await agentApi(environment.socketPath).status();
  await closeActive(environment.socketPath);
  const rawReports = reports.map(({fixturePath: _fixturePath, ...report}) => report);
  return {
    cold: false,
    name: `scroll-drag-${size}mib-mixed`,
    rawSamples: {openMilliseconds: open.elapsedMilliseconds, reports: rawReports},
    summary: {
      finalTargetToSettledMilliseconds: reports.map((report) => report.responsiveness.finalTargetToSettled),
      nativeToDisplayedMilliseconds: reports.map((report) => report.responsiveness.nativeToDisplayed),
      resourceBounds: compactStatus(finalStatus),
    },
  };
}

async function runTabPerformanceScenario(environment: TestEnvironment): Promise<PerformanceScenarioRecord> {
  generatePerformanceFixtures({kinds: ["mixed"], sizes: [5, 20, 100]});
  const fixturePaths = [
    testFixturePath(environment, "rendering-comparison.md"),
    join(environment.fixtureRoot, "lumen-mixed-5mib.md"),
    join(environment.fixtureRoot, "lumen-mixed-20mib.md"),
    join(environment.fixtureRoot, "lumen-mixed-100mib.md"),
  ];
  const anchors = new Map<number, number>();
  for (const fixturePath of fixturePaths) {
    await openFixture(environment.socketPath, fixturePath);
    const size = (await stat(fixturePath)).size;
    if (size >= 5 * 1024 * 1024) {
      const seek = await agentApi(environment.socketPath).sendAndAwait("seek", String(Math.floor(size / 2)));
      assertCondition(seek.outcome === "completed", `tab metric did not seek ${fixturePath}`);
    }
    const activeTab = (await diagnosticTabs(environment.socketPath)).find((tab) => tab.active);
    assertCondition(activeTab !== undefined, `tab metric did not activate ${fixturePath}`);
    anchors.set(activeTab.id, activeTab.sourceOffset);
  }
  const samples: Array<Readonly<Record<string, number>>> = [];
  for (const tab of await diagnosticTabs(environment.socketPath)) {
    const selection = await timed(() => agentApi(environment.socketPath).sendAndAwait("select-tab", String(tab.id)));
    assertCondition(selection.value.outcome === "completed", `tab metric did not select tab ${tab.id}`);
    const status = await agentApi(environment.socketPath).status();
    const anchor = anchors.get(tab.id) ?? 0;
    assertCondition(
      status.visiblePageCount > 0 && status.visibleSourceStart <= anchor && anchor < status.visibleSourceEnd,
      `tab metric restored an incorrect reader position for tab ${tab.id}`,
    );
    samples.push({
      operationMilliseconds: selection.elapsedMilliseconds,
      sourceOffset: status.scrollSourceOffset,
      tabId: tab.id,
    });
  }
  const finalStatus = await agentApi(environment.socketPath).status();
  for (let remaining = fixturePaths.length; remaining > 0; remaining -= 1) {
    await closeActiveToTabCount(environment.socketPath, remaining - 1);
  }
  return {
    cold: false,
    name: "tab-restoration",
    rawSamples: {samples},
    summary: {
      operationMilliseconds: summarizedMilliseconds(samples.map((sample) => sample.operationMilliseconds)),
      resourceBounds: compactStatus(finalStatus),
    },
  };
}

async function runEnrichmentPerformanceScenario(environment: TestEnvironment): Promise<PerformanceScenarioRecord> {
  const fixturePaths = [
    testFixturePath(environment, "syntax-highlighting.md"),
    testFixturePath(environment, "rendering-comparison.md"),
  ];
  const samples: Array<Readonly<Record<string, number | string>>> = [];
  for (const fixturePath of fixturePaths) {
    const open = await timed(() => openFixture(environment.socketPath, fixturePath));
    const directoryReady = await timed(() => agentApi(environment.socketPath).sendAndAwait("directory-ready"));
    assertCondition(directoryReady.value.outcome === "completed", `enrichment metric did not prepare ${fixturePath}`);
    const status = await agentApi(environment.socketPath).status();
    const inspection = await agentApi(environment.socketPath).displayedHtml(0, 256);
    assertCondition(status.visiblePageCount > 0 && inspection.bytes > 0, `enrichment metric left ${fixturePath} blank`);
    samples.push({
      directoryReadyMilliseconds: directoryReady.elapsedMilliseconds,
      fixture: fixturePath.slice(fixturePath.lastIndexOf("/") + 1),
      openMilliseconds: open.elapsedMilliseconds,
    });
    await closeActive(environment.socketPath);
  }
  return {
    cold: false,
    name: "structural-and-enrichment-ready",
    rawSamples: {samples},
    summary: {
      directoryReadyMilliseconds: summarizedMilliseconds(
        samples.map((sample) => Number(sample.directoryReadyMilliseconds)),
      ),
      openMilliseconds: summarizedMilliseconds(samples.map((sample) => Number(sample.openMilliseconds))),
    },
  };
}

async function runPerformanceScenario(
  environment: TestEnvironment,
  performanceRun: PerformanceRunArguments,
): Promise<{fixtures: readonly string[]; scenarios: readonly PerformanceScenarioRecord[]}> {
  const scenario = performanceRun.scenario;
  await reportTestPhase(environment, "stress", `performance-${scenario}`);
  if (scenario === "scroll-drag") {
    return {
      fixtures: [
        join(environment.fixtureRoot, "lumen-mixed-5mib.md"),
        join(environment.fixtureRoot, "lumen-mixed-20mib.md"),
        join(environment.fixtureRoot, "lumen-mixed-100mib.md"),
      ],
      scenarios: [
        await runScrollDragPerformanceScenario(environment, 5, [
          "slow-linear",
          "fast-jump",
          "erratic",
          "top-boundary",
          "boundary",
        ]),
        await runScrollDragPerformanceScenario(environment, 20, ["fast-jump"]),
        await runScrollDragPerformanceScenario(environment, 100, ["boundary"]),
      ],
    };
  }
  if (scenario === "wheel") {
    return {
      fixtures: [
        join(environment.fixtureRoot, "lumen-mixed-5mib.md"),
        join(environment.fixtureRoot, "lumen-mixed-20mib.md"),
        join(environment.fixtureRoot, "lumen-mixed-100mib.md"),
      ],
      scenarios: [
        await runWheelPerformanceScenario(environment, 5),
        await runWheelPerformanceScenario(environment, 20),
        await runWheelPerformanceScenario(environment, 100),
      ],
    };
  }
  if (scenario === "tabs") {
    return {
      fixtures: [
        join(repositoryRoot, "fixtures", "rendering-comparison.md"),
        join(environment.fixtureRoot, "lumen-mixed-5mib.md"),
        join(environment.fixtureRoot, "lumen-mixed-20mib.md"),
        join(environment.fixtureRoot, "lumen-mixed-100mib.md"),
      ],
      scenarios: [await runTabPerformanceScenario(environment)],
    };
  }
  if (scenario === "enrichment") {
    return {
      fixtures: [
        join(repositoryRoot, "fixtures", "syntax-highlighting.md"),
        join(repositoryRoot, "fixtures", "rendering-comparison.md"),
      ],
      scenarios: [await runEnrichmentPerformanceScenario(environment)],
    };
  }
  const drag = await runPerformanceScenario(environment, {
    recordPath: performanceRun.recordPath,
    scenario: "scroll-drag",
  });
  const wheel = await runPerformanceScenario(environment, {recordPath: performanceRun.recordPath, scenario: "wheel"});
  const tabs = await runPerformanceScenario(environment, {recordPath: performanceRun.recordPath, scenario: "tabs"});
  const enrichment = await runPerformanceScenario(environment, {
    recordPath: performanceRun.recordPath,
    scenario: "enrichment",
  });
  return {
    fixtures: [...new Set([...drag.fixtures, ...wheel.fixtures, ...tabs.fixtures, ...enrichment.fixtures])],
    scenarios: [
      {
        cold: true,
        name: "launch-to-agent-ready",
        rawSamples: {launchReadyMilliseconds: environment.launchReadyMilliseconds},
        summary: {launchReadyMilliseconds: environment.launchReadyMilliseconds},
      },
      ...drag.scenarios,
      ...wheel.scenarios,
      ...tabs.scenarios,
      ...enrichment.scenarios,
    ],
  };
}

async function readCommandOutput(command: string, argumentsList: readonly string[]): Promise<string> {
  return new Promise<string>((resolveOutput) => {
    const child = spawn(command, argumentsList, {cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"]});
    let output = "";
    child.stdout?.on("data", (chunk: string | Buffer) => {
      output = `${output}${chunk.toString("utf8")}`;
    });
    child.once("error", () => resolveOutput("unknown"));
    child.once("close", (code) => resolveOutput(code === 0 ? output.trim() || "unknown" : "unknown"));
  });
}

async function createPerformanceRecord(
  performanceRun: PerformanceRunArguments,
  collection: {fixtures: readonly string[]; scenarios: readonly PerformanceScenarioRecord[]},
): Promise<PerformanceRecord> {
  const [revision, porcelainStatus, webkitVersion] = await Promise.all([
    readCommandOutput("git", ["rev-parse", "HEAD"]),
    readCommandOutput("git", ["status", "--porcelain"]),
    readCommandOutput("dpkg-query", ["--show", "--showformat=${Version}", "libwebkit2gtk-4.1-0"]),
  ]);
  const fixtures = await Promise.all(collection.fixtures.map((fixturePath) => fixtureRecord(fixturePath)));
  return {
    build: {
      command: `npm run test:performance -- --scenario ${performanceRun.scenario} --record ${performanceRun.recordPath}`,
      configuration: "tabs=true; theme=system; test-input-guard=true",
      git_dirty: porcelainStatus === "" ? "false" : "true",
      git_revision: revision,
      lumen_version: process.env.npm_package_version ?? "unknown",
      renderer: "default GPU-composited WebKit",
      type: "development",
    },
    collectorSchemaVersion: 1,
    conclusion: "Measurement record only. Compare only with the same environment, build type, fixture, and scenario.",
    correctness: {
      cleanTeardown: true,
      fixtureCount: fixtures.length,
      scenarioCount: collection.scenarios.length,
      semanticChecksPassed: true,
    },
    environment: {
      cpu: cpus()[0]?.model ?? "unknown",
      cpu_count: String(cpus().length),
      desktop_session: process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "unknown",
      display: process.env.WAYLAND_DISPLAY ?? process.env.DISPLAY ?? "unknown",
      gpu_driver: "unknown",
      host: hostname(),
      kernel: release(),
      operating_system: operatingSystemType(),
      ram_bytes: String(totalmem()),
      sample_classification: "cold launch-to-agent-ready; warm in-process document scenarios",
      webkitgtk: webkitVersion,
    },
    fixtures,
    scenarios: collection.scenarios,
  };
}

async function runTestCase(environment: TestEnvironment, testCase: TestCaseName): Promise<void> {
  switch (testCase) {
    case "critical-agent-api-and-empty-viewer":
      await reportTestPhase(environment, "critical", testCase);
      await runAgentApiAndEmptyViewerChecks(environment);
      return;
    case "critical-agent-api-viewport-trace":
      await reportTestPhase(environment, "critical", testCase);
      await runAgentApiViewportTraceChecks(environment);
      return;
    case "critical-viewer-actions":
      await reportTestPhase(environment, "critical", testCase);
      await runViewerActionChecks(environment);
      return;
    case "critical-tabs-find-and-link-error":
      await reportTestPhase(environment, "critical", testCase);
      await runTabsFindAndLinkErrorChecks(environment);
      return;
    case "critical-handoff":
      await reportTestPhase(environment, "critical", testCase);
      await runCriticalHandoffChecks(environment);
      return;
    case "regular-watcher-reload":
      await reportTestPhase(environment, "regular", testCase);
      await runWatcherReloadChecks(environment);
      return;
    case "regular-watcher-directory-change":
      await reportTestPhase(environment, "regular", testCase);
      await runWatcherDirectoryChangeChecks(environment);
      return;
    case "regular-configuration-notice":
      await reportTestPhase(environment, "regular", testCase);
      await runConfigurationNoticeChecks(environment);
      return;
    case "regular-local-link":
      await reportTestPhase(environment, "regular", testCase);
      await runLocalLinkChecks(environment);
      return;
    case "layout-page-5mib-mixed":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "5", "mixed");
      return;
    case "layout-page-20mib-mixed":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "20", "mixed");
      return;
    case "layout-page-20mib-malformed":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "20", "malformed");
      return;
    case "layout-page-100mib-prose":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "100", "prose");
      return;
    case "layout-page-100mib-code":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "100", "code");
      return;
    case "layout-page-100mib-mixed":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "100", "mixed");
      return;
    case "layout-page-100mib-malformed":
      await reportTestPhase(environment, "stress", testCase);
      await runLayoutPageScenario(environment, "100", "malformed");
      return;
    case "scroll-drag-5mib-midpoint":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 5, "slow-linear");
      return;
    case "scroll-drag-5mib-fast-jump":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 5, "fast-jump");
      return;
    case "scroll-drag-5mib-erratic":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 5, "erratic");
      return;
    case "scroll-drag-5mib-boundary":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 5, "boundary");
      return;
    case "scroll-drag-5mib-top-boundary":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 5, "top-boundary");
      return;
    case "scroll-drag-5mib-repeat":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 5, "repeat");
      return;
    case "scroll-drag-5mib-find":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragFindScenario(environment);
      return;
    case "scroll-drag-20mib-fast-jump":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 20, "fast-jump");
      return;
    case "scroll-drag-100mib-boundary":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 100, "boundary");
      return;
    case "scroll-drag-100mib-fast-jump":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragScenario(environment, 100, "fast-jump");
      return;
    case "scroll-drag-tab-restoration":
      await reportTestPhase(environment, "stress", testCase);
      await runScrollDragTabRestorationScenario(environment);
      return;
    case "stress-coalesced-scroll":
      await reportTestPhase(environment, "stress", testCase);
      await runStressCoalescedScroll(environment);
      return;
    case "stress-tab-restoration":
      await reportTestPhase(environment, "stress", testCase);
      await runStressTabRestoration(environment);
      return;
  }
}

const {name, performance: performanceRun, testCase, tier} = parseRun();
const startedAt = performance.now();
let environment: TestEnvironment | null = null;
try {
  if (performanceRun !== null) {
    await assertPerformanceRecordAvailable(performanceRun.recordPath);
  }
  await cleanTestEnvironment();
  await run("node", ["scripts/agent-api/contract.test.ts"], process.env);
  await run("node", ["scripts/testing/page-geometry.test.ts"], process.env);
  if (performanceRun !== null) {
    await run("node", ["scripts/testing/performance-metrics.test.ts"], process.env);
  }
  environment = await createEnvironment();
  await writeOutput(`test:${name} launch=${elapsedMilliseconds(startedAt)}\n`);
  let performanceRecordPath: string | null = null;
  if (performanceRun !== null) {
    const collection = await runPerformanceScenario(environment, performanceRun);
    await stopEnvironment(environment);
    environment = null;
    const performanceRecord = await createPerformanceRecord(performanceRun, collection);
    await writePerformanceRecord(performanceRun.recordPath, performanceRecord);
    performanceRecordPath = performanceRun.recordPath;
  } else if (testCase !== null) {
    await runTestCase(environment, testCase);
  } else {
    await reportTestPhase(environment, tier, "critical-viewer");
    await runCriticalChecks(environment);
    if (tier === "regular" || tier === "stress") {
      await reportTestPhase(environment, tier, "regular-watcher-and-links");
      await runRegularChecks(environment);
    }
    if (tier === "stress") {
      await reportTestPhase(environment, tier, "stress-layout-page-viewer");
      await runStressChecks(environment);
    }
  }
  if (environment !== null) {
    await stopEnvironment(environment);
    environment = null;
  }
  if (performanceRecordPath !== null) {
    await writeOutput(`test:${name} record=${performanceRecordPath}\n`);
  }
  await writeOutput(`test:${name} complete status=passed total=${elapsedMilliseconds(startedAt)}\n`);
} catch (error: unknown) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`test:${name} failed total=${elapsedMilliseconds(startedAt)}\n${message}\n`);
  if (environment !== null) {
    process.stderr.write(`test:${name} failure-evidence=${await failureEvidence(environment)}\n`);
    try {
      await stopEnvironment(environment);
    } catch (teardownError: unknown) {
      const teardownMessage = teardownError instanceof Error ? teardownError.message : String(teardownError);
      process.stderr.write(`test:${name} teardown failed: ${teardownMessage}\n`);
    }
  }
  process.exitCode = 1;
}
