import {PageGeometry, type PageGeometrySnapshot} from "./page-geometry";

export type ViewerPage = {
  html: string;
  pageId: string;
  sourceStart: number;
  sourceEnd: number;
  sourceLength: number;
};

export type LayoutPageDirectoryEntry = {
  pageId: string;
  sourceEnd: number;
  sourceStart: number;
};

export type MeasurementCommit = {
  changed: boolean;
  restoredScrollPosition: number | null;
};

export type LayoutPageViewport = {
  beginWidthEpoch(): void;
  beginNativeRangeHold(): void;
  captureLayout(): PageGeometrySnapshot;
  clear(): void;
  commitMeasurements(): MeasurementCommit;
  containsSourceOffset(sourceOffset: number): boolean;
  currentEnd(): number;
  currentStart(): number;
  agentObservation(): string;
  geometryRevision(): number;
  measureMountedPages(): void;
  endNativeRangeHold(): void;
  widthEpoch(): number;
  mountPages(pages: readonly ViewerPage[]): HTMLElement;
  preparedPages(): readonly ViewerPage[];
  reconcileHeldNativeRange(): void;
  replaceHtml(sourceStart: number, sourceEnd: number, html: string): HTMLElement | null;
  reset(
    page: ViewerPage,
    estimatedPageCount: number,
    resetLayout: boolean,
    snapshot: PageGeometrySnapshot | null,
  ): void;
  scrollPositionForMountedSourceOffset(sourceOffset: number): number | null;
  scrollPositionForSourceOffset(sourceOffset: number): number;
  sourceOffsetForScrollPosition(position: number): number;
  setDirectory(directory: readonly LayoutPageDirectoryEntry[]): void;
  sourceLength(): number;
  sourceOffsetForScroll(): number;
};

const INITIAL_PAGE_HEIGHT = 960;
const MAXIMUM_ESTIMATED_DOCUMENT_HEIGHT = 8 * 1024 * 1024;
const VIEWPORT_ORIGIN_TOLERANCE = 1;

function documentPadding(element: HTMLElement, property: "paddingTop" | "paddingBottom"): number {
  return Number.parseFloat(window.getComputedStyle(element)[property]) || 0;
}

export function createLayoutPageViewport(
  articleElement: HTMLElement,
  scrollElement: HTMLElement,
  onMeasurementsObserved: (observation: string) => void,
): LayoutPageViewport {
  const geometry = new PageGeometry();
  const topSpacerElement = document.createElement("div");
  const pageWindowElement = document.createElement("div");
  const bottomSpacerElement = document.createElement("div");
  const pages: ViewerPage[] = [];
  const directory = new Map<string, LayoutPageDirectoryEntry>();
  const pendingMeasurements = new Map<string, number>();
  let geometryRevision = 0;
  let estimatedPageCount = 0;
  let measurementScale = 1;
  let heldNativeRange: number | null = null;
  let widthEpoch = 0;

  articleElement.classList.add("layout-page-document");
  topSpacerElement.className = "layout-page-spacer";
  bottomSpacerElement.className = "layout-page-spacer";
  pageWindowElement.className = "layout-page-window";
  articleElement.replaceChildren(topSpacerElement, pageWindowElement, bottomSpacerElement);

  function maximumScroll(): number {
    return Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  }

  function layoutObservation(): string {
    const style = window.getComputedStyle(articleElement);
    return `width_epoch=${widthEpoch} geometry_revision=${geometryRevision} pending_measurements=${pendingMeasurements.size} pages=${pages.length} directory_pages=${directory.size} scroll_top=${scrollElement.scrollTop.toFixed(1)} scroll_maximum=${maximumScroll().toFixed(1)} top_spacer=${topSpacerElement.offsetHeight}/${topSpacerElement.scrollHeight} page_window=${pageWindowElement.offsetHeight}/${pageWindowElement.scrollHeight} bottom_spacer=${bottomSpacerElement.offsetHeight}/${bottomSpacerElement.scrollHeight} article_height=${articleElement.offsetHeight}/${articleElement.scrollHeight} article_margin=${style.marginTop}/${style.marginBottom} source_length=${sourceLength()}`;
  }

  function logicalDocumentHeight(): number {
    return Math.max(INITIAL_PAGE_HEIGHT, estimatedPageCount * INITIAL_PAGE_HEIGHT);
  }

  function sourceLength(): number {
    return pages[0]?.sourceLength ?? 0;
  }

  function isTerminalSourceOffset(sourceOffset: number): boolean {
    const length = sourceLength();
    return length > 0 && sourceOffset >= length - 1;
  }

  function pageForSourceOffset(sourceOffset: number): LayoutPageDirectoryEntry | null {
    for (const page of directory.values()) {
      if (page.sourceStart <= sourceOffset && sourceOffset < page.sourceEnd) {
        return page;
      }
    }
    return pages.find((page) => page.sourceStart <= sourceOffset && sourceOffset < page.sourceEnd) ?? null;
  }

  function sourceOffsetForScrollPosition(position: number): number {
    if (directory.size === 0 && sourceLength() > 0) {
      const maximum = maximumScroll();
      const logicalProgress = maximum === 0 ? 0 : position / maximum;
      return Math.min(sourceLength() - 1, Math.max(0, Math.floor(sourceLength() * logicalProgress)));
    }
    if (isTerminalSourceOffset(sourceLength() - 1) && position >= maximumScroll() - VIEWPORT_ORIGIN_TOLERANCE) {
      return sourceLength() - 1;
    }
    const pageId = geometry.pageAt(Math.max(0, position - documentPadding(articleElement, "paddingTop")));
    if (pageId === null) {
      return 0;
    }
    return directory.get(pageId)?.sourceStart ?? pages.find((page) => page.pageId === pageId)?.sourceStart ?? 0;
  }

  function renderedAnchor(): {pageId: string; viewportOffset: number} | null {
    const viewportTop = scrollElement.getBoundingClientRect().top;
    const pageElement = Array.from(pageWindowElement.children).find((candidate) => {
      if (!(candidate instanceof HTMLElement)) {
        return false;
      }
      const bounds = candidate.getBoundingClientRect();
      return (
        bounds.bottom > viewportTop + VIEWPORT_ORIGIN_TOLERANCE && bounds.top <= viewportTop + VIEWPORT_ORIGIN_TOLERANCE
      );
    });
    if (!(pageElement instanceof HTMLElement) || pageElement.dataset.pageId === undefined) {
      return null;
    }
    return {pageId: pageElement.dataset.pageId, viewportOffset: pageElement.getBoundingClientRect().top - viewportTop};
  }

  function restoredScrollPosition(anchor: {pageId: string; viewportOffset: number}): number | null {
    const pageElement = Array.from(pageWindowElement.children).find(
      (candidate) => candidate instanceof HTMLElement && candidate.dataset.pageId === anchor.pageId,
    );
    if (!(pageElement instanceof HTMLElement)) {
      return null;
    }
    const viewportTop = scrollElement.getBoundingClientRect().top;
    const position =
      scrollElement.scrollTop + pageElement.getBoundingClientRect().top - viewportTop - anchor.viewportOffset;
    return Math.max(0, Math.min(maximumScroll(), position));
  }

  function stabilizeHeldNativeRange(): void {
    if (heldNativeRange === null) {
      return;
    }
    const adjustment = heldNativeRange - maximumScroll();
    if (Math.abs(adjustment) <= VIEWPORT_ORIGIN_TOLERANCE) {
      return;
    }
    const currentBottom = Number.parseFloat(bottomSpacerElement.style.height) || 0;
    // While a native thumb is held, page replacement and ResizeObserver delivery
    // must not change its scroll range. The bottom spacer absorbs the measured DOM
    // difference without moving the reader's top anchor. At the terminal page no
    // bottom spacer remains; the page window's trailing margin then absorbs the
    // otherwise unrepresented overflow without moving the mounted content itself.
    if (adjustment >= 0) {
      bottomSpacerElement.style.height = `${currentBottom + adjustment}px`;
      return;
    }
    const currentMargin = Number.parseFloat(pageWindowElement.style.marginBottom) || 0;
    pageWindowElement.style.marginBottom = `${currentMargin + adjustment}px`;
  }

  function setSpacerHeights(top: number, bottom: number): void {
    topSpacerElement.style.height = `${top}px`;
    bottomSpacerElement.style.height = `${bottom}px`;
    pageWindowElement.style.marginBottom = "";
    stabilizeHeldNativeRange();
  }

  function applySpacers(): void {
    const first = pages[0];
    const last = pages.at(-1);
    if (first === undefined || last === undefined) {
      setSpacerHeights(0, 0);
      return;
    }
    if (directory.size === 0 && sourceLength() > 0) {
      const sourceProgress = Math.max(0, Math.min(1, first.sourceStart / sourceLength()));
      const documentHeight = Math.max(logicalDocumentHeight(), pageWindowElement.offsetHeight);
      // The provisional native range must not change when a newly mounted page
      // replaces an estimated page. Keep the window inside the fixed logical
      // range near the document end instead of allowing the bottom spacer to
      // clamp to zero and grow the browser's native scroll range.
      const mountedHeight = Math.max(
        pageWindowElement.offsetHeight,
        pages.reduce((total, page) => total + (geometry.heightForPage(page.pageId) ?? INITIAL_PAGE_HEIGHT), 0),
      );
      const top = Math.min(documentHeight * sourceProgress, Math.max(0, documentHeight - mountedHeight));
      setSpacerHeights(top, Math.max(0, documentHeight - top - mountedHeight));
      return;
    }
    const documentHeight = geometry.totalHeight();
    const mountedHeight = pageWindowElement.offsetHeight;
    // The geometry directory owns the native range. A page window's measured DOM
    // height can differ from its estimate, so account for its actual height in the
    // opposite spacer instead of changing the range beneath a held native thumb.
    const top = Math.min(geometry.positionForPage(first.pageId) ?? 0, Math.max(0, documentHeight - mountedHeight));
    setSpacerHeights(top, Math.max(0, documentHeight - top - mountedHeight));
  }

  function createPageElement(page: ViewerPage): HTMLElement {
    const pageElement = document.createElement("section");
    pageElement.className = "layout-page";
    pageElement.dataset.pageId = page.pageId;
    pageElement.dataset.sourceStart = String(page.sourceStart);
    pageElement.dataset.sourceEnd = String(page.sourceEnd);
    pageElement.innerHTML = page.html;
    pageResizeObserver.observe(pageElement);
    return pageElement;
  }

  function renderPages(): HTMLElement {
    pageResizeObserver.disconnect();
    pageIntersectionObserver.disconnect();
    const pageElements = pages.map(createPageElement);
    pageWindowElement.replaceChildren(...pageElements);
    articleElement.replaceChildren(topSpacerElement, pageWindowElement, bottomSpacerElement);
    for (const pageElement of pageElements) {
      pageIntersectionObserver.observe(pageElement);
    }
    applySpacers();
    const first = pageElements[0];
    if (first === undefined) {
      throw new Error("a non-empty layout-page window must mount a page");
    }
    return first;
  }

  function observeMeasurements(entries: ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const pageElement = entry.target;
      if (!(pageElement instanceof HTMLElement)) {
        continue;
      }
      const pageId = pageElement.dataset.pageId;
      if (pageId === undefined) {
        continue;
      }
      pendingMeasurements.set(pageId, entry.borderBoxSize[0]?.blockSize ?? pageElement.offsetHeight);
    }
    if (directory.size === 0 || heldNativeRange !== null) {
      // The provisional range is deliberately fixed while the reader holds the
      // native thumb. A late page measurement must rebalance its spacers now,
      // rather than changing the browser's total scroll range.
      applySpacers();
    }
    if (pendingMeasurements.size > 0) {
      onMeasurementsObserved(`pending=${pendingMeasurements.size} ${layoutObservation()}`);
    }
  }

  const pageResizeObserver = new ResizeObserver(observeMeasurements);
  const pageIntersectionObserver = new IntersectionObserver(
    () => {
      // Intersection delivery happens after the mounted page window has entered
      // normal layout. It catches overflow that is not visible in the synchronous
      // DOM replacement path while a native scrollbar thumb remains held.
      stabilizeHeldNativeRange();
    },
    {root: scrollElement},
  );

  function reset(
    page: ViewerPage,
    nextEstimatedPageCount: number,
    resetLayout: boolean,
    snapshot: PageGeometrySnapshot | null,
  ): void {
    if (resetLayout || nextEstimatedPageCount > 0) {
      estimatedPageCount = Math.max(1, nextEstimatedPageCount);
    }
    if (resetLayout) {
      if (snapshot?.pageIds.includes(page.pageId)) {
        geometry.reset(
          snapshot.pageIds.map((pageId, index) => ({
            estimatedHeight: snapshot.heights[index] ?? INITIAL_PAGE_HEIGHT,
            id: pageId,
          })),
          snapshot.widthEpoch,
        );
        widthEpoch = snapshot.widthEpoch;
      } else {
        geometry.reset([{estimatedHeight: INITIAL_PAGE_HEIGHT, id: page.pageId}], widthEpoch);
      }
      geometryRevision += 1;
    } else if (geometry.positionForPage(page.pageId) === null) {
      geometry.reset([{estimatedHeight: INITIAL_PAGE_HEIGHT, id: page.pageId}], widthEpoch);
      geometryRevision += 1;
    }
    pages.splice(0, pages.length, page);
    pendingMeasurements.clear();
  }

  function mountPages(nextPages: readonly ViewerPage[]): HTMLElement {
    if (nextPages.length === 0) {
      throw new Error("a layout-page window must contain at least one page");
    }
    pages.splice(0, pages.length, ...nextPages);
    pendingMeasurements.clear();
    return renderPages();
  }

  function setDirectory(entries: readonly LayoutPageDirectoryEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const referencePage = pages[0];
    const referenceSourceLength =
      referencePage === undefined ? 0 : Math.max(1, referencePage.sourceEnd - referencePage.sourceStart);
    const referenceHeight = Math.max(INITIAL_PAGE_HEIGHT, pageWindowElement.offsetHeight);
    const pixelsPerSourceByte = referenceHeight / referenceSourceLength;
    const unscaledEstimatedHeight = entries.reduce(
      (total, entry) =>
        total + Math.max(INITIAL_PAGE_HEIGHT, (entry.sourceEnd - entry.sourceStart) * pixelsPerSourceByte),
      0,
    );
    measurementScale = Math.min(1, MAXIMUM_ESTIMATED_DOCUMENT_HEIGHT / unscaledEstimatedHeight);
    directory.clear();
    for (const entry of entries) {
      directory.set(entry.pageId, {...entry});
    }
    geometry.reset(
      entries.map((entry) => ({
        estimatedHeight: Math.max(
          INITIAL_PAGE_HEIGHT,
          Math.round((entry.sourceEnd - entry.sourceStart) * pixelsPerSourceByte * measurementScale),
        ),
        id: entry.pageId,
      })),
      widthEpoch,
    );
    geometryRevision += 1;
    applySpacers();
  }

  function commitMeasurements(): MeasurementCommit {
    if (pendingMeasurements.size === 0) {
      return {changed: false, restoredScrollPosition: null};
    }
    const anchor = renderedAnchor();
    let changed = false;
    for (const [pageId, height] of pendingMeasurements) {
      changed = geometry.updateMeasurement({height: height * measurementScale, id: pageId, widthEpoch}) || changed;
    }
    pendingMeasurements.clear();
    if (!changed) {
      return {changed: false, restoredScrollPosition: null};
    }
    geometryRevision += 1;
    applySpacers();
    return {
      changed: true,
      restoredScrollPosition: anchor === null ? null : restoredScrollPosition(anchor),
    };
  }

  function measureMountedPages(): void {
    for (const pageElement of Array.from(pageWindowElement.children)) {
      if (!(pageElement instanceof HTMLElement)) {
        continue;
      }
      const pageId = pageElement.dataset.pageId;
      if (pageId !== undefined) {
        pendingMeasurements.set(pageId, pageElement.offsetHeight);
      }
    }
  }

  function replaceHtml(sourceStart: number, sourceEnd: number, html: string): HTMLElement | null {
    const page = pages.find((candidate) => candidate.sourceStart === sourceStart && candidate.sourceEnd === sourceEnd);
    if (page === undefined) {
      return null;
    }
    page.html = html;
    const pageElement = Array.from(pageWindowElement.children).find(
      (candidate) => candidate instanceof HTMLElement && candidate.dataset.pageId === page.pageId,
    );
    if (!(pageElement instanceof HTMLElement)) {
      return null;
    }
    pageElement.innerHTML = html;
    return pageElement;
  }

  return {
    beginNativeRangeHold: () => {
      heldNativeRange = maximumScroll();
    },
    beginWidthEpoch: () => {
      widthEpoch += 1;
      geometry.beginWidthEpoch(widthEpoch);
      pendingMeasurements.clear();
      geometryRevision += 1;
    },
    captureLayout: () => geometry.snapshot(),
    clear: () => {
      pages.splice(0, pages.length);
      directory.clear();
      estimatedPageCount = 0;
      measurementScale = 1;
      pendingMeasurements.clear();
      heldNativeRange = null;
      pageResizeObserver.disconnect();
      pageIntersectionObserver.disconnect();
      geometry.reset([], widthEpoch);
      articleElement.replaceChildren();
    },
    commitMeasurements,
    containsSourceOffset: (sourceOffset) =>
      pages.some((page) => page.sourceStart <= sourceOffset && sourceOffset < page.sourceEnd),
    currentEnd: () => pages.at(-1)?.sourceEnd ?? 0,
    currentStart: () => pages[0]?.sourceStart ?? 0,
    agentObservation: layoutObservation,
    geometryRevision: () => geometryRevision,
    measureMountedPages,
    endNativeRangeHold: () => {
      heldNativeRange = null;
      pageWindowElement.style.marginBottom = "";
      applySpacers();
    },
    widthEpoch: () => widthEpoch,
    mountPages,
    preparedPages: () => pages.map((page) => ({...page})),
    reconcileHeldNativeRange: stabilizeHeldNativeRange,
    replaceHtml,
    reset,
    scrollPositionForSourceOffset: (sourceOffset) => {
      if (sourceOffset === 0) {
        return 0;
      }
      if (isTerminalSourceOffset(sourceOffset)) {
        return maximumScroll();
      }
      if (directory.size === 0 && sourceLength() > 0) {
        const logicalProgress = Math.max(0, Math.min(sourceOffset, sourceLength() - 1)) / sourceLength();
        return maximumScroll() * logicalProgress;
      }
      const page = pageForSourceOffset(sourceOffset);
      if (page === null) {
        return 0;
      }
      const position = geometry.positionForPage(page.pageId) ?? 0;
      return Math.min(maximumScroll(), position + documentPadding(articleElement, "paddingTop"));
    },
    scrollPositionForMountedSourceOffset: (sourceOffset) => {
      if (sourceOffset === 0) {
        return 0;
      }
      // A provisional source-progress layout has no stable measured relationship
      // between a mounted page's DOM position and the document scroll range.
      if (directory.size === 0) {
        return null;
      }
      if (isTerminalSourceOffset(sourceOffset)) {
        return maximumScroll();
      }
      const page = pages.find(
        (candidate) => candidate.sourceStart <= sourceOffset && sourceOffset < candidate.sourceEnd,
      );
      if (page === undefined) {
        return null;
      }
      const pageElement = Array.from(pageWindowElement.children).find(
        (candidate) => candidate instanceof HTMLElement && candidate.dataset.pageId === page.pageId,
      );
      if (!(pageElement instanceof HTMLElement)) {
        return null;
      }
      const viewportTop = scrollElement.getBoundingClientRect().top;
      const position = scrollElement.scrollTop + pageElement.getBoundingClientRect().top - viewportTop;
      return Math.max(0, Math.min(maximumScroll(), position));
    },
    setDirectory,
    sourceLength,
    sourceOffsetForScrollPosition,
    sourceOffsetForScroll: () => {
      // Before canonical page geometry arrives, the native range is provisional.
      // A mounted page can occupy that entire range without representing EOF.
      if (directory.size === 0) {
        return sourceOffsetForScrollPosition(scrollElement.scrollTop);
      }
      if (
        isTerminalSourceOffset(sourceLength() - 1) &&
        scrollElement.scrollTop >= maximumScroll() - VIEWPORT_ORIGIN_TOLERANCE
      ) {
        return sourceLength() - 1;
      }
      const rendered = renderedAnchor();
      if (rendered !== null) {
        const mountedPage = pages.find((page) => page.pageId === rendered.pageId);
        if (mountedPage !== undefined) {
          return mountedPage.sourceStart;
        }
      }
      return sourceOffsetForScrollPosition(scrollElement.scrollTop);
    },
  };
}
