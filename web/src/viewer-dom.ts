import {convertFileSrc} from "@tauri-apps/api/core";
import checkIconUrl from "./assets/icons/heroicons-check.svg";

const localAssetReferencePrefix = "data:application/x-lumen-asset,";

export function assignHeadingIdentifiers(containerElement: ParentNode, counts: Map<string, number>): void {
  for (const headingElement of containerElement.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    if (headingElement.id.length > 0) {
      continue;
    }
    const baseIdentifier =
      headingElement.textContent
        ?.toLocaleLowerCase()
        .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replaceAll(/\s+/g, "-") || "section";
    const count = counts.get(baseIdentifier) ?? 0;
    counts.set(baseIdentifier, count + 1);
    headingElement.id = count === 0 ? baseIdentifier : `${baseIdentifier}-${count}`;
  }
}

export function replaceTaskCheckboxes(containerElement: ParentNode): void {
  for (const checkboxElement of containerElement.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    const markerElement = document.createElement("span");
    markerElement.className = "task-checkbox";
    markerElement.setAttribute("aria-checked", String(checkboxElement.checked));
    markerElement.setAttribute("aria-disabled", "true");
    markerElement.setAttribute("role", "checkbox");
    if (checkboxElement.checked) {
      const checkIconElement = document.createElement("img");
      checkIconElement.alt = "";
      checkIconElement.className = "task-checkbox-icon";
      checkIconElement.src = checkIconUrl;
      markerElement.append(checkIconElement);
    }
    checkboxElement.replaceWith(markerElement);
    const taskRowElement = document.createElement("span");
    taskRowElement.className = "task-row";
    markerElement.before(taskRowElement);
    taskRowElement.append(markerElement);
    const taskLabelElement = document.createElement("span");
    taskLabelElement.className = "task-label";
    taskRowElement.append(taskLabelElement);
    while (taskRowElement.nextSibling !== null) {
      taskLabelElement.append(taskRowElement.nextSibling);
    }
  }
}

export function installLocalImageSources(containerElement: ParentNode): void {
  for (const imageElement of containerElement.querySelectorAll<HTMLImageElement>("img")) {
    const reference = imageElement.getAttribute("src");
    if (reference === null || !reference.startsWith(localAssetReferencePrefix)) {
      continue;
    }
    try {
      imageElement.src = convertFileSrc(decodeURIComponent(reference.slice(localAssetReferencePrefix.length)));
    } catch {
      imageElement.src = "data:,";
    }
  }
}

export function closestLinkElement(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const linkElement = target.closest("a");
  return linkElement instanceof HTMLAnchorElement ? linkElement : null;
}

export type NativeContextMenuSelectionPreserver = Readonly<{
  capture: (event: MouseEvent) => void;
  restore: () => void;
}>;

export function createNativeContextMenuSelectionPreserver(): NativeContextMenuSelectionPreserver {
  let contextMenuSelection: Range | null = null;
  let deferredRestoreTimer: number | null = null;

  function restoreSelection(selectedRange: Range): void {
    const selection = window.getSelection();
    if (selection === null) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(selectedRange);
  }

  // Preserve selection around WebKitGTK's native context menu, which otherwise clears it here.
  function capture(event: MouseEvent): void {
    if (deferredRestoreTimer !== null) {
      window.clearTimeout(deferredRestoreTimer);
      deferredRestoreTimer = null;
    }
    if (event.button !== 2 || !(event.target instanceof Node)) {
      contextMenuSelection = null;
      return;
    }
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount !== 1) {
      contextMenuSelection = null;
      return;
    }
    const selectedRange = selection.getRangeAt(0);
    contextMenuSelection = selectedRange.intersectsNode(event.target) ? selectedRange.cloneRange() : null;
  }

  function restore(): void {
    const selectedRange = contextMenuSelection;
    if (selectedRange === null) {
      return;
    }
    restoreSelection(selectedRange);
    // WebKitGTK can clear selection after contextmenu dispatch; restore after its default action too.
    deferredRestoreTimer = window.setTimeout(() => {
      restoreSelection(selectedRange);
      contextMenuSelection = null;
      deferredRestoreTimer = null;
    }, 0);
  }

  return {capture, restore};
}
