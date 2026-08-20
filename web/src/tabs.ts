export type DocumentTab = readonly [id: number, title: string, active: boolean];

type TabAction = "tab" | "other" | "right" | "left";

interface TabCallbacks {
  selectTab: (tabId: number) => void;
  closeTabs: (tabId: number, action: TabAction) => void;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface TabController {
  readonly element: HTMLElement;
  render: (tabs: readonly DocumentTab[]) => void;
}

type TabElement = {
  element: HTMLElement;
  title: string;
};

function createContextAction(
  label: string,
  tabId: number,
  action: TabAction,
  callbacks: TabCallbacks,
  closeMenu: () => void,
): HTMLButtonElement {
  const actionElement = document.createElement("button");
  actionElement.type = "button";
  actionElement.textContent = label;
  actionElement.addEventListener("click", () => {
    closeMenu();
    callbacks.closeTabs(tabId, action);
  });
  return actionElement;
}

export function createTabController(callbacks: TabCallbacks): TabController {
  const element = document.createElement("nav");
  const contextMenuElement = document.createElement("div");
  let visibleContextMenu: HTMLElement | null = null;
  let currentTabs: readonly DocumentTab[] = [];
  let tabElements = new Map<number, TabElement>();

  element.className = "tab-strip";
  element.setAttribute("aria-label", "Open documents");
  contextMenuElement.className = "tab-context-menu";
  contextMenuElement.hidden = true;
  document.body.append(contextMenuElement);

  function closeContextMenu(): void {
    contextMenuElement.hidden = true;
    visibleContextMenu = null;
  }

  function openContextMenu(event: MouseEvent, tabId: number, index: number, tabCount: number): void {
    event.preventDefault();
    contextMenuElement.replaceChildren(createContextAction("Close Tab", tabId, "tab", callbacks, closeContextMenu));
    if (tabCount > 1) {
      contextMenuElement.append(createContextAction("Close Other Tabs", tabId, "other", callbacks, closeContextMenu));
    }
    if (index < tabCount - 1) {
      contextMenuElement.append(createContextAction("Close Tabs Right", tabId, "right", callbacks, closeContextMenu));
    }
    if (index > 0) {
      contextMenuElement.append(createContextAction("Close Tabs Left", tabId, "left", callbacks, closeContextMenu));
    }
    contextMenuElement.hidden = false;
    contextMenuElement.style.left = `${event.clientX}px`;
    contextMenuElement.style.top = `${event.clientY}px`;
    visibleContextMenu = contextMenuElement;
  }

  document.addEventListener("pointerdown", (event) => {
    if (visibleContextMenu !== null && !visibleContextMenu.contains(event.target as Node)) {
      closeContextMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeContextMenu();
    }
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || (event.key !== "Tab" && event.key !== "ISO_Left_Tab")) {
        return;
      }
      const activeIndex = currentTabs.findIndex(([, , active]) => active);
      if (activeIndex < 0 || currentTabs.length < 2) {
        return;
      }
      event.preventDefault();
      const nextIndex =
        event.shiftKey || event.key === "ISO_Left_Tab"
          ? (activeIndex - 1 + currentTabs.length) % currentTabs.length
          : (activeIndex + 1) % currentTabs.length;
      callbacks.selectTab(currentTabs[nextIndex][0]);
    },
    {capture: true},
  );

  function createTabElement(id: number, title: string, index: number, tabCount: number): TabElement {
    const tabElement = document.createElement("div");
    tabElement.className = "tab";
    tabElement.setAttribute("role", "tab");
    const selectElement = document.createElement("button");
    selectElement.type = "button";
    selectElement.className = "tab-select";
    selectElement.textContent = title;
    selectElement.title = title;
    selectElement.addEventListener("click", () => callbacks.selectTab(id));
    const closeElement = document.createElement("button");
    const iconElement = document.createElementNS(SVG_NAMESPACE, "svg");
    const iconUseElement = document.createElementNS(SVG_NAMESPACE, "use");
    closeElement.type = "button";
    closeElement.className = "tab-close";
    closeElement.setAttribute("aria-label", `Close ${title}`);
    iconElement.setAttribute("aria-hidden", "true");
    iconElement.setAttribute("class", "tab-close-icon");
    iconUseElement.setAttribute("href", "/icons/heroicons-x-mark.svg#heroicons-x-mark");
    iconElement.append(iconUseElement);
    closeElement.append(iconElement);
    closeElement.addEventListener("click", () => callbacks.closeTabs(id, "tab"));
    tabElement.addEventListener("contextmenu", (event) => openContextMenu(event, id, index, tabCount));
    tabElement.append(selectElement, closeElement);
    return {element: tabElement, title};
  }

  function render(tabs: readonly DocumentTab[]): void {
    const structureChanged =
      tabs.length !== currentTabs.length ||
      tabs.some(([id, title], index) => currentTabs[index]?.[0] !== id || currentTabs[index]?.[1] !== title);
    currentTabs = tabs;
    element.hidden = tabs.length < 2;
    if (structureChanged) {
      closeContextMenu();
      const nextTabElements = new Map<number, TabElement>();
      const nextElements = tabs.map(([id, title], index) => {
        const existingElement = tabElements.get(id);
        const tabElement =
          existingElement?.title === title ? existingElement : createTabElement(id, title, index, tabs.length);
        nextTabElements.set(id, tabElement);
        return tabElement.element;
      });
      tabElements = nextTabElements;
      element.replaceChildren(...nextElements);
    }
    for (const [id, , active] of tabs) {
      tabElements.get(id)?.element.setAttribute("aria-selected", String(active));
    }
  }

  return {element, render};
}
