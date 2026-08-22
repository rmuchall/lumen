export type NoticeSource = "configuration" | "document";
export type NoticeKind = "information" | "warning" | "error";

type RecoverableNotice = {
  actionElement: HTMLButtonElement;
  dismissElement: HTMLButtonElement;
  element: HTMLElement;
  messageElement: HTMLSpanElement;
  titleElement: HTMLElement;
};

export type NoticeController = {
  activate: (source: NoticeSource) => boolean;
  clear: (source: NoticeSource) => void;
  agentObservation: () => string;
  dismiss: (source: NoticeSource) => boolean;
  element: HTMLElement;
  showConfigurationRestart: (restart: () => void) => void;
  showDocumentReloaded: () => boolean;
  show: (source: NoticeSource, kind: NoticeKind, message: string) => void;
};

function noticeTitle(source: NoticeSource, kind: NoticeKind): string {
  if (source === "document" && kind === "information") {
    return "Document reloaded";
  }
  const severity = kind === "warning" ? "Warning" : "Error";
  const category = source === "configuration" ? "Configuration error" : "Document error";
  return `${severity}: ${category}`;
}

export function createNoticeController(): NoticeController {
  const element = document.createElement("section");
  const notices = new Map<NoticeSource, RecoverableNotice>();
  element.classList.add("recoverable-notices");

  function clear(source: NoticeSource): void {
    const notice = notices.get(source);
    notice?.element.remove();
    notices.delete(source);
  }

  function dismiss(source: NoticeSource): boolean {
    if (!notices.has(source)) {
      return false;
    }
    clear(source);
    return true;
  }

  function activate(source: NoticeSource): boolean {
    const notice = notices.get(source);
    if (notice === undefined || notice.actionElement.hidden || notice.actionElement.onclick === null) {
      return false;
    }
    notice.actionElement.click();
    return true;
  }

  function createNotice(source: NoticeSource): RecoverableNotice {
    const noticeElement = document.createElement("aside");
    const contentElement = document.createElement("div");
    const titleElement = document.createElement("strong");
    const messageElement = document.createElement("span");
    const actionElement = document.createElement("button");
    const dismissElement = document.createElement("button");
    noticeElement.classList.add("recoverable-notice");
    contentElement.classList.add("recoverable-notice-content");
    dismissElement.type = "button";
    dismissElement.setAttribute("aria-label", "Dismiss notification");
    dismissElement.textContent = "Dismiss";
    actionElement.hidden = true;
    actionElement.type = "button";
    actionElement.textContent = "Restart Lumen";
    dismissElement.addEventListener("click", () => void dismiss(source));
    contentElement.append(titleElement, messageElement);
    noticeElement.append(contentElement, actionElement, dismissElement);
    element.append(noticeElement);
    return {actionElement, dismissElement, element: noticeElement, messageElement, titleElement};
  }

  function agentObservation(): string {
    const state = [...notices.entries()].map(([source, notice]) => ({
      dismissLabel: notice.dismissElement.getAttribute("aria-label") ?? "",
      hasAction: !notice.actionElement.hidden,
      kind: notice.element.classList.contains("recoverable-error")
        ? "error"
        : notice.element.classList.contains("recoverable-information")
          ? "information"
          : "warning",
      message: notice.messageElement.textContent ?? "",
      role: notice.element.getAttribute("role") ?? "",
      source,
      title: notice.titleElement.textContent ?? "",
    }));
    return JSON.stringify(state);
  }

  function show(source: NoticeSource, kind: NoticeKind, message: string): void {
    const notice = notices.get(source) ?? createNotice(source);
    notices.set(source, notice);
    notice.element.classList.toggle("recoverable-information", kind === "information");
    notice.element.classList.toggle("recoverable-warning", kind === "warning");
    notice.element.classList.toggle("recoverable-error", kind === "error");
    notice.element.setAttribute("role", kind === "information" ? "status" : "alert");
    if (kind === "information") {
      notice.element.setAttribute("aria-live", "polite");
    } else {
      notice.element.removeAttribute("aria-live");
    }
    notice.actionElement.hidden = true;
    notice.actionElement.onclick = null;
    notice.titleElement.textContent = noticeTitle(source, kind);
    notice.messageElement.textContent = message;
  }

  function showConfigurationRestart(restart: () => void): void {
    const notice = notices.get("configuration") ?? createNotice("configuration");
    notices.set("configuration", notice);
    notice.element.classList.add("recoverable-warning");
    notice.element.classList.remove("recoverable-error", "recoverable-information");
    notice.element.setAttribute("role", "alert");
    notice.element.removeAttribute("aria-live");
    notice.titleElement.textContent = "Restart required";
    notice.messageElement.textContent = "Lumen configuration changed. Restart Lumen to apply it.";
    notice.actionElement.hidden = false;
    notice.actionElement.onclick = restart;
  }

  function showDocumentReloaded(): boolean {
    const documentNotice = notices.get("document");
    if (documentNotice?.element.classList.contains("recoverable-error")) {
      return false;
    }
    show("document", "information", "Document changed on disk and was reloaded.");
    return true;
  }

  return {activate, agentObservation, clear, dismiss, element, show, showConfigurationRestart, showDocumentReloaded};
}
