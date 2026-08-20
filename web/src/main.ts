import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import lumenLogoUrl from "./assets/lumen-logo.svg";
import "./main.css";
import type {AgentEventLifecycle} from "./agent-api/listeners";
import {installCodeCopyControls} from "./code-copy";
import {createDocumentBar} from "./document-bar";
import {createFindController, type RustFindNavigation, type RustFindProgress} from "./find";
import {createRecoverableNoticeController} from "./shared-actions/notices";
import type {ScrollDiagnostics} from "./scroll-diagnostics";
import {createDocumentActions} from "./shared-actions/documents";
import {createFindActions} from "./shared-actions/find";
import {createViewportActions} from "./shared-actions/viewport";
import {createTabController, type DocumentTab} from "./tabs";
import type {TestRunBanner} from "./test-run-banner";
import {refreshConfiguration} from "./theme";
import {
  assignHeadingIdentifiers,
  closestLinkElement,
  createNativeContextMenuSelectionPreserver,
  installLocalImageSources,
  replaceTaskCheckboxes,
} from "./viewer-dom";
import {createLayoutPageViewport, type LayoutPageDirectoryEntry, type ViewerPage} from "./layout-page-viewport";
import type {PageGeometrySnapshot} from "./page-geometry";
import {
  createViewportCoordinator,
  type ViewerPageBatchResponse,
  type ViewportCoordinator,
} from "./viewport-coordinator";

const queriedAppElement = document.querySelector<HTMLElement>("#app");

if (queriedAppElement === null) {
  throw new Error("Lumen application element is missing.");
}

const appElement: HTMLElement = queriedAppElement;
const viewerScrollElement = document.createElement("main");
const markdownElement = document.createElement("article");
viewerScrollElement.classList.add("viewer-scroll");
viewerScrollElement.append(markdownElement);
let viewportCoordinator: ViewportCoordinator | null = null;
let scrollDiagnostics: ScrollDiagnostics | null = null;
const trace: ScrollDiagnostics["trace"] | undefined = import.meta.env.DEV
  ? (...arguments_) => scrollDiagnostics?.trace(...arguments_)
  : undefined;
const layoutPageViewport = createLayoutPageViewport(markdownElement, viewerScrollElement, (observation) => {
  trace?.("layout-measurements-observed", observation);
  viewportCoordinator?.commitMeasurements();
});
const buildMarkerElement = document.createElement("p");
const documentBar = createDocumentBar();
let testRunBanner: TestRunBanner | null = null;

async function installTestRunBanner(): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }
  const {createTestRunBanner} = await import("./test-run-banner");
  testRunBanner = createTestRunBanner();
  appElement.append(testRunBanner.element);
}
const statusBarElement = document.createElement("footer");
const linkStatusElement = document.createElement("span");
const recoverableNotices = createRecoverableNoticeController();
type PendingFindScan = {
  query: string;
  tabId: number;
  tabRevision: number;
  resolve: (progress: RustFindProgress) => void;
};
type PendingFindNavigation = {
  query: string;
  tabId: number;
  tabRevision: number;
  resolve: (progress: RustFindNavigation) => void;
};
let pendingFindScan: PendingFindScan | null = null;
let pendingFindNavigation: PendingFindNavigation | null = null;
let activeViewerTabId = 0;
let activeViewerTabRevision = 0;
const tabLayoutSnapshots = new Map<string, PageGeometrySnapshot>();
const findController = createFindController(
  appElement,
  markdownElement,
  viewerScrollElement,
  (query) => {
    if (activeViewerTabId === 0) {
      return Promise.resolve({complete: true, matchCount: 0});
    }
    const tabId = activeViewerTabId;
    const tabRevision = activeViewerTabRevision;
    pendingFindScan?.resolve({complete: true, matchCount: 0});
    return new Promise<RustFindProgress>((resolve) => {
      const pending = {query, tabId, tabRevision, resolve};
      pendingFindScan = pending;
      void invoke<boolean>("viewer_find_step", {
        query,
        navigationAfter: null,
        tabId,
        tabRevision,
      })
        .then((queued) => {
          if (!queued && pendingFindScan === pending) {
            pendingFindScan = null;
            resolve({complete: true, matchCount: 0});
          }
        })
        .catch(() => {
          if (pendingFindScan === pending) {
            pendingFindScan = null;
            resolve({complete: true, matchCount: 0});
          }
        });
    });
  },
  (query, after) => {
    if (activeViewerTabId === 0) {
      return Promise.resolve({matchOffset: null});
    }
    const requestedGeneration = viewportCoordinator?.documentGeneration() ?? 0;
    const requestedTabId = activeViewerTabId;
    const requestedTabRevision = activeViewerTabRevision;
    const navigationAfter = after;
    if (
      requestedGeneration === viewportCoordinator?.documentGeneration() &&
      requestedTabId === activeViewerTabId &&
      requestedTabRevision === activeViewerTabRevision
    ) {
      pendingFindNavigation?.resolve({matchOffset: null});
      return new Promise<RustFindNavigation>((resolve) => {
        const pending = {query, tabId: requestedTabId, tabRevision: requestedTabRevision, resolve};
        pendingFindNavigation = pending;
        void invoke<boolean>("viewer_find_next", {
          after: navigationAfter,
          query,
          tabId: requestedTabId,
          tabRevision: requestedTabRevision,
        })
          .then((queued) => {
            if (!queued && pendingFindNavigation === pending) {
              pendingFindNavigation = null;
              resolve({matchOffset: null});
            }
          })
          .catch(() => {
            if (pendingFindNavigation === pending) {
              pendingFindNavigation = null;
              resolve({matchOffset: null});
            }
          });
      });
    }
    return Promise.resolve({matchOffset: null});
  },
  (query, before) => {
    if (activeViewerTabId === 0) {
      return Promise.resolve({matchOffset: null});
    }
    const requestedGeneration = viewportCoordinator?.documentGeneration() ?? 0;
    const requestedTabId = activeViewerTabId;
    const requestedTabRevision = activeViewerTabRevision;
    const navigationBefore = before ?? layoutPageViewport.currentStart();
    if (
      requestedGeneration === viewportCoordinator?.documentGeneration() &&
      requestedTabId === activeViewerTabId &&
      requestedTabRevision === activeViewerTabRevision
    ) {
      pendingFindNavigation?.resolve({matchOffset: null});
      return new Promise<RustFindNavigation>((resolve) => {
        const pending = {query, tabId: requestedTabId, tabRevision: requestedTabRevision, resolve};
        pendingFindNavigation = pending;
        void invoke<boolean>("viewer_find_previous", {
          before: navigationBefore,
          query,
          tabId: requestedTabId,
          tabRevision: requestedTabRevision,
        })
          .then((queued) => {
            if (!queued && pendingFindNavigation === pending) {
              pendingFindNavigation = null;
              resolve({matchOffset: null});
            }
          })
          .catch(() => {
            if (pendingFindNavigation === pending) {
              pendingFindNavigation = null;
              resolve({matchOffset: null});
            }
          });
      });
    }
    return Promise.resolve({matchOffset: null});
  },
  (sourceOffset) => {
    trace?.("find-navigation-requested", `source_offset=${sourceOffset}`);
    return new Promise<boolean>((resolve) => {
      viewportActions.seek(sourceOffset, (outcome) => {
        resolve(outcome === "completed" || layoutPageViewport.containsSourceOffset(sourceOffset));
      });
    });
  },
);
const findActions = createFindActions(findController);
const documentActions = createDocumentActions({
  captureActiveLayout: captureActiveTabLayout,
  currentViewerPosition: () => ({
    scrollPosition: viewerScrollElement.scrollTop,
    sourceOffset: viewportCoordinator?.inputAnchor() ?? 0,
  }),
  refreshSession: refreshDocumentSession,
  showError: (message) => recoverableNotices.show("document", "error", message),
});
const viewportActions = createViewportActions({
  queueSeek: (sourceOffset, onCompletion) =>
    viewportCoordinator?.queueSeek(sourceOffset, true, "shared-action", onCompletion ?? null),
  settleViewport: () => viewportCoordinator?.settleAfterScroll(),
});
const tabController = createTabController({
  selectTab: (tabId) => void documentActions.selectTab(tabId),
  closeTabs: (tabId, action) => void documentActions.closeTabs(tabId, action),
});
let initialRenderReported = false;
let layoutPageDirectoryReady = false;
type PendingLayoutPageDirectory = {
  directory: readonly LayoutPageDirectoryEntry[];
  documentGeneration: number;
  tabId: number;
  tabRevision: number;
};
let pendingLayoutPageDirectory: PendingLayoutPageDirectory | null = null;

type ViewerSnapshot = readonly [
  tabs: DocumentTab[],
  documentPath: string | null,
  html: string,
  recoverableError: string | null,
  scrollPosition: number,
  sourceOffset: number,
  sourceStart: number,
  sourceEnd: number,
  sourceLength: number,
  estimatedPageCount: number,
  pageId: string,
  tabId: number,
  tabRevision: number,
];

let agentEvents: AgentEventLifecycle | null = null;
const queuedPageEnrichments = new Set<string>();
let headingIdentifierCounts = new Map<string, number>();
const nativeContextMenuSelection = createNativeContextMenuSelectionPreserver();

viewportCoordinator = createViewportCoordinator({
  activeDocument: () => ({tabId: activeViewerTabId, tabRevision: activeViewerTabRevision}),
  applyPages: (pages, preferViewportFindMatch) => displayMarkdown(pages, 0, false, preferViewportFindMatch),
  hasTerminalLayout,
  onInputSettled: applyPendingLayoutPageDirectory,
  onError: (message) => recoverableNotices.show("document", "error", message),
  onStable: () => {
    trace?.("layout-settled", `source=${viewportCoordinator?.inputAnchor() ?? 0}`);
    agentEvents?.viewportStable(hasTerminalLayout());
  },
  persistPosition: (sourceOffset, scrollPosition, tabId, tabRevision) =>
    invoke<boolean>("save_document_viewer_position", {
      sourceOffset,
      scrollPosition,
      tabId,
      tabRevision,
    }).then(() => undefined),
  queueEnrichment: queuePageEnrichment,
  requestPageBatch: (sourceOffset, tabId, tabRevision) =>
    invoke<ViewerPageBatchResponse>("viewer_page_batch", {sourceOffset, tabId, tabRevision}),
  trace: (eventName, detail, correlation) => trace?.(eventName, detail, correlation),
  viewerScrollElement,
  viewport: layoutPageViewport,
});

function beginViewportPointerInteraction(pointerId: number): void {
  viewportCoordinator?.beginPointerInteraction(pointerId);
}

function endViewportPointerInteraction(pointerId: number): void {
  viewportCoordinator?.endPointerInteraction(pointerId);
}

function reportInitialRender(): void {
  if (initialRenderReported) {
    return;
  }
  initialRenderReported = true;
  void invoke<void>("report_initial_render_ready");
}

function captureDisplayedHtml(offset: number, length: number): {content: string; totalBytes: number} | null {
  const bytes = new TextEncoder().encode(markdownElement.innerHTML);
  if (offset > bytes.length) {
    return null;
  }
  let start = offset;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  let end = Math.min(bytes.length, start + length);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {content: new TextDecoder().decode(bytes.slice(start, end)), totalBytes: bytes.length};
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

function showBlockingError(message: string): void {
  const titleElement = document.createElement("strong");
  const messageElement = document.createElement("p");
  markdownElement.classList.remove("empty-viewer");
  markdownElement.classList.add("document-error");
  titleElement.classList.add("document-error-title");
  titleElement.textContent = "Error: Document error";
  messageElement.textContent = message;
  layoutPageViewport.clear();
  trace?.("viewport-state", "state=error");
  markdownElement.replaceChildren(titleElement, messageElement);
  updateLinkStatus(null);
}

function showEmptyViewer(): void {
  const logoElement = document.createElement("img");
  const titleElement = document.createElement("strong");
  const messageElement = document.createElement("p");
  markdownElement.classList.add("empty-viewer");
  logoElement.className = "empty-viewer-logo";
  logoElement.src = lumenLogoUrl;
  logoElement.alt = "";
  titleElement.textContent = "Open Markdown document";
  messageElement.textContent = "Choose File → Open… to view a Markdown document.";
  layoutPageViewport.clear();
  markdownElement.replaceChildren(logoElement, titleElement, messageElement);
  trace?.("viewport-state", "state=empty");
  updateLinkStatus(null);
  recoverableNotices.clear("document");
}

function hasDisplayedDocument(): boolean {
  return (
    markdownElement.childNodes.length > 0 &&
    !markdownElement.classList.contains("document-error") &&
    !markdownElement.classList.contains("empty-viewer")
  );
}

function updateLinkStatus(linkElement: HTMLAnchorElement | null): void {
  linkStatusElement.textContent = linkElement?.getAttribute("href") ?? "";
}

function displayMarkdown(
  pages: readonly ViewerPage[],
  estimatedPageCount: number,
  resetLayout = false,
  preferViewportFindMatch = false,
  layoutSnapshot: PageGeometrySnapshot | null = null,
): void {
  const firstPage = pages[0];
  if (firstPage === undefined) {
    return;
  }
  findController.clearHighlight();
  const displayStartedAt = performance.now();
  layoutPageViewport.reset(firstPage, estimatedPageCount, resetLayout, layoutSnapshot);
  layoutPageViewport.mountPages(pages);
  const viewportReadyAt = performance.now();
  headingIdentifierCounts = new Map<string, number>();
  markdownElement.classList.remove("document-error", "empty-viewer");
  updateLinkStatus(null);
  for (const pageElement of Array.from(markdownElement.querySelectorAll<HTMLElement>(".layout-page"))) {
    installLocalImageSources(pageElement);
    replaceTaskCheckboxes(pageElement);
    assignHeadingIdentifiers(pageElement, headingIdentifierCounts);
    installCodeCopyControls(pageElement);
  }
  layoutPageViewport.reconcileHeldNativeRange();
  const controlsReadyAt = performance.now();
  findController.refreshVisible(preferViewportFindMatch, false);
  const lastPage = pages.at(-1) ?? firstPage;
  agentEvents?.pageDisplayed(firstPage.sourceStart, lastPage.sourceEnd, findController.agentObservation());
  trace?.(
    "reader-position-displayed",
    `source_start=${firstPage.sourceStart} source_end=${lastPage.sourceEnd} source=${viewportCoordinator?.inputAnchor() ?? firstPage.sourceStart}`,
  );
  trace?.("viewport-state", `state=rendered page_generation=${viewportCoordinator?.pageGeneration() ?? 0}`);
  recoverableNotices.clear("document");
  if (resetLayout && activeViewerTabId !== 0) {
    void invoke<boolean>("viewer_first_page_displayed", {
      tabId: activeViewerTabId,
      tabRevision: activeViewerTabRevision,
    });
  }
  trace?.(
    "page-display-complete",
    `total_ms=${(performance.now() - displayStartedAt).toFixed(1)} viewport_ms=${(viewportReadyAt - displayStartedAt).toFixed(1)} controls_ms=${(controlsReadyAt - viewportReadyAt).toFixed(1)} page_count=${pages.length} source_start=${firstPage.sourceStart} source_end=${firstPage.sourceEnd}`,
  );
  trace?.("page-window-mounted", `count=${pages.length} start=${firstPage.sourceStart} end=${lastPage.sourceEnd}`);
}

async function enrichDisplayedPage(page: ViewerPage): Promise<void> {
  const requestedGeneration = viewportCoordinator?.documentGeneration() ?? 0;
  const requestedPageGeneration = viewportCoordinator?.pageGeneration() ?? 0;
  const requestedTabId = activeViewerTabId;
  const requestedTabRevision = activeViewerTabRevision;
  trace?.(
    "page-enrichment-requested",
    `start=${page.sourceStart} end=${page.sourceEnd} generation=${requestedPageGeneration}`,
  );
  try {
    const queued = await invoke<boolean>("viewer_enrich_page", {
      pageId: page.pageId,
      sourceStart: page.sourceStart,
      sourceEnd: page.sourceEnd,
      tabId: requestedTabId,
      tabRevision: requestedTabRevision,
    });
    if (
      requestedGeneration !== viewportCoordinator?.documentGeneration() ||
      requestedPageGeneration !== viewportCoordinator?.pageGeneration() ||
      requestedTabId !== activeViewerTabId ||
      requestedTabRevision !== activeViewerTabRevision ||
      !queued
    ) {
      return;
    }
  } catch (error: unknown) {
    recoverableNotices.show("document", "error", `Unable to enrich Markdown syntax: ${errorMessage(error)}`);
  }
}

function applyEnrichedPage(sourceStart: number, sourceEnd: number, html: string): void {
  findController.clearHighlight();
  const pageElement = layoutPageViewport.replaceHtml(sourceStart, sourceEnd, html);
  if (pageElement === null) {
    return;
  }
  installLocalImageSources(pageElement);
  replaceTaskCheckboxes(pageElement);
  assignHeadingIdentifiers(pageElement, headingIdentifierCounts);
  installCodeCopyControls(pageElement);
  layoutPageViewport.reconcileHeldNativeRange();
  findController.refreshVisible(true, false);
  trace?.(
    "page-enrichment-applied",
    () => `${scrollDiagnostics?.geometry() ?? ""} start=${sourceStart} end=${sourceEnd}`,
  );
}

function queuePageEnrichment(page: ViewerPage): void {
  const requestedPageGeneration = viewportCoordinator?.pageGeneration() ?? 0;
  const enrichmentKey = `${requestedPageGeneration}:${page.pageId}`;
  if (queuedPageEnrichments.has(enrichmentKey)) {
    return;
  }
  if (requestedPageGeneration !== viewportCoordinator?.pageGeneration()) {
    return;
  }
  queuedPageEnrichments.add(enrichmentKey);
  void enrichDisplayedPage(page).finally(() => queuedPageEnrichments.delete(enrichmentKey));
}

function hasTerminalLayout(): boolean {
  const sourceLength = layoutPageViewport.sourceLength();
  const pageElement = markdownElement.querySelector<HTMLElement>(".layout-page");
  if (sourceLength === 0 || pageElement === null) {
    return false;
  }
  const maximumScroll = Math.max(0, viewerScrollElement.scrollHeight - viewerScrollElement.clientHeight);
  const viewportBounds = viewerScrollElement.getBoundingClientRect();
  const pageBounds = pageElement.getBoundingClientRect();
  const padding = Number.parseFloat(window.getComputedStyle(markdownElement).paddingBottom) || 0;
  return (
    layoutPageViewport.currentEnd() === sourceLength &&
    layoutPageViewport.sourceOffsetForScroll() === sourceLength - 1 &&
    viewerScrollElement.scrollTop >= maximumScroll - 1 &&
    Math.abs(viewportBounds.bottom - pageBounds.bottom - padding) <= 4
  );
}

function tabLayoutKey(tabId: number, tabRevision: number): string {
  return `${tabId}:${tabRevision}`;
}

async function loadLayoutPageDirectory(tabId: number, tabRevision: number): Promise<void> {
  const requestedGeneration = viewportCoordinator?.documentGeneration() ?? 0;
  try {
    const snapshot = await invoke<readonly [string, number, number][]>("viewer_layout_page_directory", {
      tabId,
      tabRevision,
    });
    if (
      requestedGeneration !== viewportCoordinator?.documentGeneration() ||
      tabId !== activeViewerTabId ||
      tabRevision !== activeViewerTabRevision
    ) {
      return;
    }
    const directory: LayoutPageDirectoryEntry[] = snapshot.map(([pageId, sourceStart, sourceEnd]) => ({
      pageId,
      sourceEnd,
      sourceStart,
    }));
    const pendingDirectory = {directory, documentGeneration: requestedGeneration, tabId, tabRevision};
    if (viewportCoordinator?.isPointerInteractionActive()) {
      pendingLayoutPageDirectory = pendingDirectory;
      trace?.("layout-directory-deferred", `tab=${tabId} revision=${tabRevision}`);
      return;
    }
    applyLayoutPageDirectory(pendingDirectory);
  } catch (error: unknown) {
    agentEvents?.layoutPageDirectoryFailed();
    recoverableNotices.show("document", "error", `Unable to load the Markdown page directory: ${errorMessage(error)}`);
  }
}

function applyLayoutPageDirectory(pendingDirectory: PendingLayoutPageDirectory): void {
  if (
    pendingDirectory.documentGeneration !== viewportCoordinator?.documentGeneration() ||
    pendingDirectory.tabId !== activeViewerTabId ||
    pendingDirectory.tabRevision !== activeViewerTabRevision
  ) {
    return;
  }
  pendingLayoutPageDirectory = null;
  // The provisional source-progress geometry and canonical page geometry use
  // different height models. Carry the logical anchor across that replacement.
  const sourceAnchor = viewportCoordinator?.inputAnchor() ?? layoutPageViewport.sourceOffsetForScroll();
  layoutPageViewport.setDirectory(pendingDirectory.directory);
  viewportCoordinator?.setAnchor(sourceAnchor);
  viewportCoordinator?.applySyntheticScrollPosition(layoutPageViewport.scrollPositionForSourceOffset(sourceAnchor));
  layoutPageDirectoryReady = true;
  trace?.("layout-directory-applied", `tab=${pendingDirectory.tabId} revision=${pendingDirectory.tabRevision}`);
  agentEvents?.layoutPageDirectoryReady();
  viewportCoordinator?.directoryBecameReady();
}

function applyPendingLayoutPageDirectory(): void {
  if (pendingLayoutPageDirectory !== null) {
    applyLayoutPageDirectory(pendingLayoutPageDirectory);
  }
}

function captureActiveTabLayout(): void {
  if (activeViewerTabId === 0) {
    return;
  }
  tabLayoutSnapshots.set(tabLayoutKey(activeViewerTabId, activeViewerTabRevision), layoutPageViewport.captureLayout());
}

function discardClosedTabLayouts(tabs: readonly DocumentTab[], tabId: number, tabRevision: number): void {
  const openTabIds = new Set(tabs.map(([id]) => id));
  for (const key of tabLayoutSnapshots.keys()) {
    const [savedTabId, savedRevision] = key.split(":");
    if (
      !openTabIds.has(Number(savedTabId)) ||
      (Number(savedTabId) === tabId && Number(savedRevision) !== tabRevision)
    ) {
      tabLayoutSnapshots.delete(key);
    }
  }
}

async function reloadOpenedMarkdown(preserveCommittedAction = false): Promise<void> {
  if (activeViewerTabId !== 0) {
    await invoke<boolean>("save_document_viewer_position", {
      sourceOffset: layoutPageViewport.sourceOffsetForScroll(),
      scrollPosition: viewerScrollElement.scrollTop,
      tabId: activeViewerTabId,
      tabRevision: activeViewerTabRevision,
    });
  }
  await refreshDocumentSession(preserveCommittedAction);
}

async function handleViewerReload(): Promise<void> {
  agentEvents?.documentReloading();
  await reloadOpenedMarkdown(true);
  agentEvents?.documentReloaded();
}

async function handleWatchedMarkdownChange(): Promise<void> {
  agentEvents?.beginWatchedMarkdownChange();
  await reloadOpenedMarkdown(true);
  agentEvents?.watchedMarkdownChanged();
}

async function refreshDocumentSession(preserveCommittedAction = false): Promise<void> {
  layoutPageDirectoryReady = false;
  pendingLayoutPageDirectory = null;
  captureActiveTabLayout();
  const requestedGeneration = viewportCoordinator?.beginDocumentRevision() ?? 0;
  agentEvents?.cancel(preserveCommittedAction);
  viewportCoordinator?.cancel();
  queuedPageEnrichments.clear();
  try {
    const [
      tabs,
      documentPath,
      renderedMarkdown,
      recoverableError,
      savedScrollPosition,
      savedSourceOffset,
      sourceStart,
      sourceEnd,
      sourceLength,
      estimatedPageCount,
      pageId,
      tabId,
      tabRevision,
    ] = await invoke<ViewerSnapshot>("viewer_snapshot");
    if (requestedGeneration !== viewportCoordinator?.documentGeneration()) {
      return;
    }
    tabController.render(tabs);
    if (tabs.length === 0) {
      activeViewerTabId = 0;
      activeViewerTabRevision = 0;
      tabLayoutSnapshots.clear();
      documentBar.setPath(null);
      showEmptyViewer();
      findController.refresh();
      return;
    }
    discardClosedTabLayouts(tabs, tabId, tabRevision);
    documentBar.setPath(documentPath);
    activeViewerTabId = tabId;
    activeViewerTabRevision = tabRevision;
    viewportCoordinator?.restorePositionInProgress(true);
    viewportCoordinator?.applySyntheticScrollPosition(0);
    const page = {html: renderedMarkdown, pageId, sourceStart, sourceEnd, sourceLength};
    displayMarkdown(
      [page],
      estimatedPageCount,
      true,
      false,
      tabLayoutSnapshots.get(tabLayoutKey(tabId, tabRevision)) ?? null,
    );
    queuePageEnrichment(page);
    if (recoverableError !== null) {
      recoverableNotices.show("document", "error", `Unable to refresh Markdown document: ${recoverableError}`);
    }
    findController.refresh();
    const restoredSourceOffset =
      savedSourceOffset === 0 && sourceStart > 0
        ? sourceStart
        : Math.min(savedSourceOffset, Math.max(0, sourceLength - 1));
    viewportCoordinator?.setAnchor(restoredSourceOffset);
    const restoreScrollPosition = (): void => {
      viewportCoordinator?.applySyntheticScrollPosition(
        layoutPageViewport.scrollPositionForSourceOffset(restoredSourceOffset),
      );
    };
    viewportCoordinator?.applySyntheticScrollPosition(Math.max(0, savedScrollPosition));
    const needsSourceAnchorRestoration = savedScrollPosition === 0;
    if (needsSourceAnchorRestoration) {
      restoreScrollPosition();
    }
    if (restoredSourceOffset > 0) {
      await new Promise<void>((resolve) => {
        if (requestedGeneration !== viewportCoordinator?.documentGeneration()) {
          resolve();
          return;
        }
        viewportCoordinator?.queueSeek(restoredSourceOffset, true, "tab-restore", () => {
          viewportCoordinator?.restorePositionInProgress(false);
          resolve();
        });
      });
    } else {
      viewportCoordinator?.restorePositionInProgress(false);
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (hasDisplayedDocument()) {
      recoverableNotices.show("document", "error", `Unable to refresh Markdown document: ${message}`);
    } else {
      showBlockingError(`Unable to display Markdown document: ${message}`);
    }
  }
}

async function handleViewerDocumentOpened(): Promise<void> {
  agentEvents?.documentOpening();
  await refreshDocumentSession(true);
  agentEvents?.documentOpened();
}

function scrollToDocumentAnchor(anchor: string): boolean {
  let targetIdentifier: string;
  try {
    targetIdentifier = decodeURIComponent(anchor).toLocaleLowerCase();
  } catch {
    targetIdentifier = anchor.toLocaleLowerCase();
  }
  const headingElement = Array.from(markdownElement.querySelectorAll<HTMLElement>("[id]")).find(
    (element) => element.id.toLocaleLowerCase() === targetIdentifier,
  );
  if (headingElement === undefined) {
    return false;
  }
  headingElement.scrollIntoView({block: "start"});
  return true;
}

async function scrollToIndexedAnchor(anchor: string): Promise<void> {
  if (scrollToDocumentAnchor(anchor) || activeViewerTabId === 0) {
    return;
  }
  let targetIdentifier: string;
  try {
    targetIdentifier = decodeURIComponent(anchor).toLocaleLowerCase();
  } catch {
    targetIdentifier = anchor.toLocaleLowerCase();
  }
  const requestedGeneration = viewportCoordinator?.documentGeneration() ?? 0;
  const requestedTabId = activeViewerTabId;
  const requestedTabRevision = activeViewerTabRevision;
  try {
    const result = await invoke<readonly [boolean, number | null] | null>("viewer_heading_offset", {
      identifier: targetIdentifier,
      tabId: requestedTabId,
      tabRevision: requestedTabRevision,
    });
    if (
      result === null ||
      requestedGeneration !== viewportCoordinator?.documentGeneration() ||
      requestedTabId !== activeViewerTabId ||
      requestedTabRevision !== activeViewerTabRevision
    ) {
      return;
    }
    const [indexComplete, sourceOffset] = result;
    if (indexComplete && sourceOffset !== null) {
      viewerScrollElement.scrollTop = layoutPageViewport.scrollPositionForSourceOffset(sourceOffset);
      viewportCoordinator?.queueSeek(sourceOffset, true, "anchor");
    }
  } catch (error: unknown) {
    recoverableNotices.show("document", "error", `Unable to follow Markdown anchor: ${errorMessage(error)}`);
  }
}

async function activateMarkdownLink(link: string): Promise<boolean> {
  if (link.startsWith("#")) {
    await scrollToIndexedAnchor(link.slice(1));
    return true;
  }
  try {
    const anchor = await invoke<string | null>("activate_link", {link});
    if (anchor === null) {
      return true;
    }
    await refreshDocumentSession();
    await scrollToIndexedAnchor(anchor);
    return true;
  } catch (error: unknown) {
    const message = errorMessage(error);
    recoverableNotices.show("document", "error", `Unable to follow Markdown link: ${message}`);
    return false;
  }
}

function handleConfigurationChanged(): void {
  recoverableNotices.showConfigurationRestart(() => void restartLumen());
  agentEvents?.configurationChanged();
}

async function refreshViewerConfiguration(): Promise<void> {
  try {
    const configurationError = await refreshConfiguration();
    if (configurationError === null) {
      recoverableNotices.clear("configuration");
    } else {
      recoverableNotices.show("configuration", "warning", `${configurationError} Using built-in defaults.`);
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    recoverableNotices.show("configuration", "error", `Unable to load Lumen configuration: ${message}`);
  }
}

async function restartLumen(): Promise<void> {
  try {
    await invoke<void>("restart_lumen");
  } catch (error: unknown) {
    recoverableNotices.show("configuration", "error", `Unable to restart Lumen: ${errorMessage(error)}`);
  }
}

async function installViewerEvents(): Promise<void> {
  await Promise.all([
    listen("markdown-file-changed", () => void handleWatchedMarkdownChange()),
    listen("viewer-reload", () => void handleViewerReload()),
    listen("viewer-find", findActions.show),
    listen("viewer-document-opened", () => void handleViewerDocumentOpened()),
    listen<readonly [number, number, number | null]>("viewer-index-complete", (event) => {
      const [tabId, tabRevision, anchorOffset] = event.payload;
      if (tabId !== activeViewerTabId || tabRevision !== activeViewerTabRevision) {
        return;
      }
      for (const page of layoutPageViewport.preparedPages()) {
        queuePageEnrichment(page);
      }
      void loadLayoutPageDirectory(tabId, tabRevision);
      if (anchorOffset !== null) {
        viewerScrollElement.scrollTop = layoutPageViewport.scrollPositionForSourceOffset(anchorOffset);
        viewportCoordinator?.queueSeek(anchorOffset, true, "anchor");
      }
    }),
    listen<readonly [number, number, number, number, string]>("viewer-page-enrichment-complete", (event) => {
      const [tabId, tabRevision, sourceStart, sourceEnd, html] = event.payload;
      if (tabId !== activeViewerTabId || tabRevision !== activeViewerTabRevision) {
        return;
      }
      applyEnrichedPage(sourceStart, sourceEnd, html);
    }),
    listen<readonly [number, number, number, number]>("viewer-priority-page-ready", (event) => {
      const [tabId, tabRevision, sourceStart, sourceEnd] = event.payload;
      viewportCoordinator?.handlePriorityPageReady(tabId, tabRevision, sourceStart, sourceEnd);
    }),
    listen<readonly [number, number, string, number, number | null]>("viewer-find-complete", (event) => {
      const [tabId, tabRevision, query, matchCount] = event.payload;
      const pending = pendingFindScan;
      if (
        pending === null ||
        pending.tabId !== tabId ||
        pending.tabRevision !== tabRevision ||
        pending.query !== query
      ) {
        return;
      }
      pendingFindScan = null;
      pending.resolve({complete: true, matchCount});
    }),
    listen<readonly [number, number, string, number | null]>("viewer-find-navigation", (event) => {
      const [tabId, tabRevision, query, matchOffset] = event.payload;
      const pending = pendingFindNavigation;
      if (
        pending === null ||
        pending.tabId !== tabId ||
        pending.tabRevision !== tabRevision ||
        pending.query !== query
      ) {
        return;
      }
      pendingFindNavigation = null;
      pending.resolve({matchOffset});
    }),
    listen("viewer-configuration-changed", handleConfigurationChanged),
  ]);

  if (!import.meta.env.DEV) {
    return;
  }

  await installTestRunBanner();
  const [{installAgentListeners}, {createScrollDiagnostics}] = await Promise.all([
    import("./agent-api/listeners"),
    import("./scroll-diagnostics"),
  ]);
  const diagnostics = createScrollDiagnostics(markdownElement, viewerScrollElement, layoutPageViewport, () => ({
    activeAgentRequestId: viewportCoordinator?.state().activeAgentRequestId ?? null,
    activeDragId: viewportCoordinator?.state().activeDragId ?? null,
    documentGeneration: viewportCoordinator?.state().documentGeneration ?? 0,
    geometryRevision: layoutPageViewport.geometryRevision(),
    inputGeneration: viewportCoordinator?.state().inputGeneration ?? 0,
    measurementCommitActive: viewportCoordinator?.state().measurementCommitActive ?? false,
    pageGeneration: viewportCoordinator?.state().pageGeneration ?? 0,
    pendingPageRequest: viewportCoordinator?.state().pendingPageRequest ?? false,
    readerInputActive: viewportCoordinator?.state().readerInputActive ?? false,
    scrollWritePending: viewportCoordinator?.state().scrollWritePending ?? false,
    viewportAnchor: viewportCoordinator?.state().viewportAnchor ?? 0,
    widthEpoch: layoutPageViewport.widthEpoch(),
  }));
  scrollDiagnostics = diagnostics;
  const resizeDiagnosticsObserver = new ResizeObserver(() => {
    void diagnostics.reportScrollState(true);
  });
  resizeDiagnosticsObserver.observe(viewerScrollElement);
  await Promise.all([
    installAgentListeners({
      activeTabId: () => activeViewerTabId,
      activateNotice: recoverableNotices.activate,
      beginPointerDrag: (dragId) => beginViewportPointerInteraction(dragId),
      beginViewportTrace: (traceId, label) => diagnostics.beginViewportTrace(traceId, label),
      closeTabs: documentActions.closeTabs,
      copyDocumentPath: documentBar.copyPath,
      captureDisplayedHtml,
      directoryReady: () => layoutPageDirectoryReady,
      dismissNotice: recoverableNotices.dismiss,
      endPointerDrag: (dragId) => endViewportPointerInteraction(dragId),
      endViewportTrace: (traceId) => diagnostics.endViewportTrace(traceId),
      findClear: findActions.clear,
      findObservation: () => findController.agentObservation(),
      findNext: findActions.requestNext,
      findPrevious: findActions.requestPrevious,
      followLink: activateMarkdownLink,
      focusWindow: async () => {
        try {
          await invoke<void>("agent_focus_window");
          return true;
        } catch {
          return false;
        }
      },
      handoffOpen: async (path) => {
        try {
          await invoke<void>("agent_handoff_open", {documentPath: path});
          return true;
        } catch {
          return false;
        }
      },
      openPath: async (path) => {
        const opened = await documentActions.openPath(path);
        if (opened) {
          await diagnostics.reportScrollState(true);
        }
        return opened;
      },
      readViewportTrace: (traceId, afterSequence) => diagnostics.readViewportTrace(traceId, afterSequence),
      reloadDocument: async () => {
        try {
          await invoke<void>("reload_document");
          return true;
        } catch {
          return false;
        }
      },
      reportScrollState: () => diagnostics.reportScrollState(true),
      scrollTo: (position, onCompletion, requestId) => {
        if (viewportCoordinator === null) {
          onCompletion("failed");
          return;
        }
        viewportCoordinator.scrollToPosition(
          position,
          (outcome) => {
            void diagnostics.reportScrollState(true).then(
              () => onCompletion(outcome),
              () => onCompletion("failed"),
            );
          },
          requestId,
        );
      },
      seek: viewportActions.seek,
      selectTab: async (tabId) => {
        const selected = await documentActions.selectTab(tabId);
        if (selected) {
          await diagnostics.reportScrollState(true);
        }
        return selected;
      },
      setFindQuery: findActions.setQuery,
      settleFindHighlight: () => findController.settleHighlight(),
      settleViewport: viewportActions.settle,
      viewportIsStable: () => viewportCoordinator?.isStable() ?? true,
      sourceLength: () => layoutPageViewport.sourceLength(),
      sourceOffset: () => layoutPageViewport.sourceOffsetForScroll(),
      watcherReady: () => invoke<boolean>("agent_watcher_ready"),
      setTestRunState: async (tier, phase) => {
        if (testRunBanner === null) {
          return false;
        }
        try {
          await invoke<void>("update_test_run_state", {tier, phase});
          testRunBanner.show({tier, phase});
          return true;
        } catch {
          return false;
        }
      },
      zoom: async (action) => {
        try {
          await invoke<void>("agent_zoom", {action});
          return true;
        } catch {
          return false;
        }
      },
    }).then((events) => {
      agentEvents = events;
    }),
    listen("agent-watcher-ready", () => agentEvents?.watcherReady()),
    listen("agent-observation-scroll-probe", () => {
      diagnostics.trace("scroll-probe", () => diagnostics.geometry());
      void diagnostics.reportScrollState(true);
    }),
    listen("agent-observation-find-probe", () => {
      const findState = findController.agentObservation();
      void invoke<void>("report_agent_observation_find_state", {findState: JSON.stringify(findState)});
    }),
    listen("agent-observation-ui-probe", () => {
      void invoke<void>("report_agent_observation_ui_state", {uiState: recoverableNotices.agentObservation()});
    }),
  ]);
}

buildMarkerElement.classList.add("build-marker");
statusBarElement.classList.add("status-bar");
linkStatusElement.classList.add("link-status");
statusBarElement.append(linkStatusElement, buildMarkerElement);
markdownElement.addEventListener("click", (event) => {
  const linkElement = closestLinkElement(event.target);
  if (linkElement !== null) {
    event.preventDefault();
    void activateMarkdownLink(linkElement.getAttribute("href") ?? "");
  }
});
markdownElement.addEventListener("mousedown", nativeContextMenuSelection.capture, {capture: true});
markdownElement.addEventListener("contextmenu", nativeContextMenuSelection.restore, {capture: true});
markdownElement.addEventListener("pointerover", (event) => {
  updateLinkStatus(closestLinkElement(event.target));
});
markdownElement.addEventListener("pointerout", (event) => {
  const linkElement = closestLinkElement(event.target);
  if (linkElement === null) {
    return;
  }
  const nextLinkElement = closestLinkElement(event.relatedTarget);
  if (nextLinkElement !== linkElement) {
    updateLinkStatus(null);
  }
});
viewerScrollElement.addEventListener(
  "scroll",
  (event) => {
    viewportCoordinator?.handleScrollEvent(event);
  },
  {passive: true},
);
viewerScrollElement.addEventListener(
  "pointerdown",
  (event) => {
    beginViewportPointerInteraction(event.pointerId);
  },
  {passive: true},
);
window.addEventListener(
  "pointerup",
  (event) => {
    endViewportPointerInteraction(event.pointerId);
  },
  {passive: true},
);
window.addEventListener(
  "pointercancel",
  (event) => {
    endViewportPointerInteraction(event.pointerId);
  },
  {passive: true},
);
viewerScrollElement.addEventListener(
  "scrollend",
  () => {
    viewportCoordinator?.settleAfterScroll();
  },
  {passive: true},
);
window.addEventListener(
  "resize",
  () => {
    viewportCoordinator?.beginWidthEpoch();
  },
  {passive: true},
);
if (import.meta.env.DEV) {
  window.addEventListener(
    "wheel",
    (event) => {
      trace?.(
        "wheel-input",
        `delta_mode=${event.deltaMode} delta_x=${event.deltaX.toFixed(1)} delta_y=${event.deltaY.toFixed(1)}`,
      );
    },
    {passive: true},
  );
}

if (import.meta.env.DEV) {
  buildMarkerElement.classList.add("development-build-marker");
  buildMarkerElement.textContent = "Development build";
} else {
  buildMarkerElement.classList.add("production-build-marker");
  buildMarkerElement.textContent = "Production build";
}
appElement.replaceChildren(
  findController.element,
  tabController.element,
  documentBar.element,
  recoverableNotices.element,
  viewerScrollElement,
  statusBarElement,
);

void installViewerEvents().then(async () => {
  await refreshDocumentSession();
  await refreshViewerConfiguration();
  if (import.meta.env.DEV) {
    await invoke<void>("report_agent_frontend_ready");
  }
  reportInitialRender();
});
