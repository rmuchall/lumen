interface FindMatch {
  range: Range;
}

export type RustFindProgress = {
  complete: boolean;
  matchCount: number;
};

export type RustFindNavigation = {
  matchOffset: number | null;
};

export type AgentFindNavigation = {
  matchOffset: number | null;
  targetVisible: boolean;
};

export type AgentFindObservation = {
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

export interface FindController {
  agentObservation(): AgentFindObservation;
  agentNext(): Promise<AgentFindNavigation>;
  agentPrevious(): Promise<AgentFindNavigation>;
  dismiss(): void;
  element: HTMLFormElement;
  next(): void;
  previous(): void;
  clearHighlight(): void;
  refresh(): void;
  refreshVisible(preferViewportMatch?: boolean, scrollSelectedMatch?: boolean): void;
  settleHighlight(): Promise<void>;
  setQuery(query: string): void;
  show(): void;
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

export function createFindController(
  appElement: HTMLElement,
  markdownElement: HTMLElement,
  scrollElement: HTMLElement,
  findAcrossDocument: (query: string) => Promise<RustFindProgress>,
  findNextAcrossDocument: (query: string, after: number | null) => Promise<RustFindNavigation>,
  findPreviousAcrossDocument: (query: string, before: number | null) => Promise<RustFindNavigation>,
  navigateToSourceOffset: (sourceOffset: number) => Promise<boolean>,
): FindController {
  let findMatches: FindMatch[] = [];
  let activeFindMatchIndex = -1;
  let activeFindHighlightElements: HTMLElement[] = [];
  let fullDocumentMatchCount: number | null = null;
  let highlightRefreshRequested = false;
  let lastNavigationOffset: number | null = null;
  let searchGeneration = 0;
  const element = document.createElement("form");
  const inputElement = document.createElement("input");
  const previousButtonElement = document.createElement("button");
  const nextButtonElement = document.createElement("button");
  const closeButtonElement = document.createElement("button");
  const statusElement = document.createElement("span");

  function updateStatus(): void {
    statusElement.classList.remove("find-status-no-matches");
    if (inputElement.value.length === 0) {
      statusElement.textContent = "";
    } else if (findMatches.length === 0) {
      statusElement.textContent = fullDocumentMatchCount === null ? "Total pending" : "No matches";
      statusElement.classList.toggle("find-status-no-matches", fullDocumentMatchCount !== null);
    } else {
      const visibleStatus = `${activeFindMatchIndex + 1} of ${findMatches.length} visible`;
      statusElement.textContent =
        fullDocumentMatchCount === null
          ? `${visibleStatus} · total pending`
          : `${visibleStatus} · ${fullDocumentMatchCount} total`;
    }
  }

  function clearHighlight(): void {
    for (const highlightElement of activeFindHighlightElements) {
      highlightElement.remove();
    }
    activeFindHighlightElements = [];
  }

  function rangeRectangles(range: Range): DOMRect[] {
    if (!range.startContainer.isConnected || !range.endContainer.isConnected || range.toString().length === 0) {
      return [];
    }
    return Array.from(range.getClientRects());
  }

  function agentObservation(): AgentFindObservation {
    const activeMatch = findMatches[activeFindMatchIndex];
    const activeRange = activeMatch?.range;
    const activeRangeConnected =
      activeRange !== undefined && activeRange.startContainer.isConnected && activeRange.endContainer.isConnected;
    const rectangles = activeRange === undefined ? [] : rangeRectangles(activeRange);
    const highlightMatchesActiveRange =
      rectangles.length === activeFindHighlightElements.length &&
      rectangles.every((rectangle, index) => {
        const highlightElement = activeFindHighlightElements[index];
        if (highlightElement === undefined) {
          return false;
        }
        const highlightRectangle = highlightElement.getBoundingClientRect();
        return (
          Math.abs(highlightRectangle.top - rectangle.top) < 1 &&
          Math.abs(highlightRectangle.left - rectangle.left) < 1 &&
          Math.abs(highlightRectangle.width - rectangle.width) < 1 &&
          Math.abs(highlightRectangle.height - rectangle.height) < 1
        );
      });
    return {
      activeMatchIndex: activeFindMatchIndex,
      activeMatchText: activeRange?.toString().slice(0, 128) ?? "",
      activeRangeConnected,
      activeRangeRectCount: rectangles.length,
      fullDocumentMatchCount,
      highlightMatchesActiveRange,
      highlightRectCount: activeFindHighlightElements.length,
      inputFocused: document.activeElement === inputElement,
      lastNavigationOffset,
      panelVisible: !element.hidden,
      query: inputElement.value.slice(0, 128),
      statusText: statusElement.textContent ?? "",
      visibleMatchCount: findMatches.length,
    };
  }

  function drawHighlight(): void {
    clearHighlight();
    if (activeFindMatchIndex < 0) {
      return;
    }
    const range = findMatches[activeFindMatchIndex].range;
    for (const rectangle of rangeRectangles(range)) {
      const highlightElement = document.createElement("span");
      highlightElement.classList.add("find-highlight");
      highlightElement.setAttribute("aria-hidden", "true");
      highlightElement.style.height = `${rectangle.height}px`;
      highlightElement.style.left = `${rectangle.left}px`;
      highlightElement.style.top = `${rectangle.top}px`;
      highlightElement.style.width = `${rectangle.width}px`;
      appElement.append(highlightElement);
      activeFindHighlightElements.push(highlightElement);
    }
  }

  function refreshHighlightAfterScroll(): void {
    if (highlightRefreshRequested) {
      return;
    }
    highlightRefreshRequested = true;
    requestAnimationFrame(() => {
      highlightRefreshRequested = false;
      drawHighlight();
    });
  }

  function settleHighlight(): Promise<void> {
    drawHighlight();
    return Promise.resolve();
  }

  function select(index: number, scrollIntoView = true): void {
    if (findMatches.length === 0) {
      activeFindMatchIndex = -1;
      clearHighlight();
      updateStatus();
      return;
    }
    activeFindMatchIndex = (index + findMatches.length) % findMatches.length;
    const range = findMatches[activeFindMatchIndex].range;
    if (scrollIntoView) {
      range.startContainer.parentElement?.scrollIntoView({block: "center"});
    }
    drawHighlight();
    updateStatus();
  }

  function closestMatchToViewport(): number {
    const viewport = scrollElement.getBoundingClientRect();
    const viewportCenter = viewport.top + viewport.height / 2;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const [index, match] of findMatches.entries()) {
      const rectangles = Array.from(match.range.getClientRects());
      const distance = rectangles.reduce((nearest, rectangle) => {
        const center = rectangle.top + rectangle.height / 2;
        return Math.min(nearest, Math.abs(center - viewportCenter));
      }, Number.POSITIVE_INFINITY);
      if (distance < closestDistance) {
        closestIndex = index;
        closestDistance = distance;
      }
    }
    return closestIndex;
  }

  function refreshVisible(preferViewportMatch = false, scrollSelectedMatch = true): void {
    const searchTerm = inputElement.value.trim();
    const asciiCaseInsensitive = isAscii(searchTerm);
    const comparableSearchTerm = asciiCaseInsensitive ? searchTerm.toLowerCase() : searchTerm;
    findMatches = [];
    activeFindMatchIndex = -1;
    if (searchTerm.length === 0) {
      clearHighlight();
      updateStatus();
      return;
    }
    const textWalker = document.createTreeWalker(markdownElement, NodeFilter.SHOW_TEXT);
    let textNode = textWalker.nextNode();
    while (textNode !== null) {
      const text = (textNode as Text).data;
      const comparableText = asciiCaseInsensitive ? text.toLowerCase() : text;
      let startOffset = comparableText.indexOf(comparableSearchTerm);
      while (startOffset !== -1) {
        const range = document.createRange();
        range.setStart(textNode, startOffset);
        range.setEnd(textNode, startOffset + comparableSearchTerm.length);
        findMatches.push({range});
        startOffset = comparableText.indexOf(comparableSearchTerm, startOffset + comparableSearchTerm.length);
      }
      textNode = textWalker.nextNode();
    }
    select(preferViewportMatch ? closestMatchToViewport() : 0, scrollSelectedMatch && !preferViewportMatch);
  }

  function refresh(): void {
    const searchTerm = inputElement.value.trim();
    fullDocumentMatchCount = null;
    lastNavigationOffset = null;
    searchGeneration += 1;
    refreshVisible();
    if (searchTerm.length === 0) {
      return;
    }
    void refreshFullDocumentSearch(searchTerm, searchGeneration);
  }

  async function selectNext(): Promise<AgentFindNavigation> {
    if (activeFindMatchIndex + 1 < findMatches.length) {
      select(activeFindMatchIndex + 1);
      return {matchOffset: null, targetVisible: true};
    }
    const searchTerm = inputElement.value.trim();
    if (searchTerm.length === 0) {
      return {matchOffset: null, targetVisible: false};
    }
    searchGeneration += 1;
    const navigationGeneration = searchGeneration;
    statusElement.textContent = "Finding next…";
    try {
      const navigation = await findNextAcrossDocument(searchTerm, lastNavigationOffset);
      if (navigationGeneration !== searchGeneration || inputElement.value.trim() !== searchTerm) {
        return {matchOffset: null, targetVisible: false};
      }
      if (navigation.matchOffset === null) {
        statusElement.textContent = "No matches";
        return {matchOffset: null, targetVisible: false};
      }
      lastNavigationOffset = navigation.matchOffset;
      const targetVisible = await navigateToSourceOffset(navigation.matchOffset);
      void refreshFullDocumentSearch(searchTerm, navigationGeneration);
      return {matchOffset: navigation.matchOffset, targetVisible};
    } catch {
      if (navigationGeneration === searchGeneration) {
        updateStatus();
      }
      return {matchOffset: null, targetVisible: false};
    }
  }

  async function selectPrevious(): Promise<AgentFindNavigation> {
    if (activeFindMatchIndex > 0) {
      select(activeFindMatchIndex - 1);
      return {matchOffset: null, targetVisible: true};
    }
    const searchTerm = inputElement.value.trim();
    if (searchTerm.length === 0) {
      return {matchOffset: null, targetVisible: false};
    }
    searchGeneration += 1;
    const navigationGeneration = searchGeneration;
    statusElement.textContent = "Finding previous…";
    try {
      const navigation = await findPreviousAcrossDocument(searchTerm, lastNavigationOffset);
      if (navigationGeneration !== searchGeneration || inputElement.value.trim() !== searchTerm) {
        return {matchOffset: null, targetVisible: false};
      }
      if (navigation.matchOffset === null) {
        statusElement.textContent = "No matches";
        return {matchOffset: null, targetVisible: false};
      }
      lastNavigationOffset = navigation.matchOffset;
      const targetVisible = await navigateToSourceOffset(navigation.matchOffset);
      void refreshFullDocumentSearch(searchTerm, navigationGeneration);
      return {matchOffset: navigation.matchOffset, targetVisible};
    } catch {
      if (navigationGeneration === searchGeneration) {
        updateStatus();
      }
      return {matchOffset: null, targetVisible: false};
    }
  }

  async function refreshFullDocumentSearch(searchTerm: string, generation: number): Promise<void> {
    try {
      const progress = await findAcrossDocument(searchTerm);
      if (generation === searchGeneration) {
        fullDocumentMatchCount = progress.matchCount;
        updateStatus();
      }
    } catch {
      if (generation === searchGeneration) {
        fullDocumentMatchCount = null;
        updateStatus();
      }
    }
  }

  function hide(): void {
    element.hidden = true;
    findMatches = [];
    activeFindMatchIndex = -1;
    fullDocumentMatchCount = null;
    lastNavigationOffset = null;
    searchGeneration += 1;
    inputElement.value = "";
    statusElement.textContent = "";
    clearHighlight();
  }

  function show(): void {
    element.hidden = false;
    inputElement.focus();
    inputElement.select();
  }

  function setQuery(query: string): void {
    inputElement.value = query;
    show();
    refresh();
  }

  function next(): void {
    void selectNext();
  }

  function previous(): void {
    void selectPrevious();
  }

  element.classList.add("find-bar");
  element.hidden = true;
  inputElement.type = "search";
  inputElement.placeholder = "Find";
  inputElement.setAttribute("aria-label", "Find in document");
  previousButtonElement.type = "button";
  previousButtonElement.textContent = "Previous";
  nextButtonElement.type = "button";
  nextButtonElement.textContent = "Next";
  closeButtonElement.type = "button";
  closeButtonElement.textContent = "Close";
  statusElement.classList.add("find-status");
  element.append(inputElement, previousButtonElement, nextButtonElement, statusElement, closeButtonElement);
  element.addEventListener("submit", (event) => {
    event.preventDefault();
    void selectNext();
  });
  inputElement.addEventListener("input", refresh);
  inputElement.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
    } else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void selectPrevious();
    }
  });
  previousButtonElement.addEventListener("click", () => void selectPrevious());
  nextButtonElement.addEventListener("click", () => void selectNext());
  closeButtonElement.addEventListener("click", hide);
  window.addEventListener("resize", drawHighlight);
  scrollElement.addEventListener("scroll", refreshHighlightAfterScroll, {passive: true});

  return {
    clearHighlight,
    agentObservation,
    agentNext: selectNext,
    agentPrevious: selectPrevious,
    dismiss: hide,
    element,
    next,
    previous,
    refresh,
    refreshVisible,
    settleHighlight,
    setQuery,
    show,
  };
}
