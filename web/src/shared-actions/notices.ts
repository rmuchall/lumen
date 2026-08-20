export type RecoverableErrorSource = "configuration" | "document";
export type RecoverableErrorKind = "warning" | "error";

type RecoverableNotice = {
  actionElement: HTMLButtonElement;
  element: HTMLElement;
  messageElement: HTMLSpanElement;
  titleElement: HTMLElement;
};

export type RecoverableNoticeController = {
  activate: (source: RecoverableErrorSource) => boolean;
  clear: (source: RecoverableErrorSource) => void;
  agentObservation: () => string;
  dismiss: (source: RecoverableErrorSource) => boolean;
  element: HTMLElement;
  showConfigurationRestart: (restart: () => void) => void;
  show: (source: RecoverableErrorSource, kind: RecoverableErrorKind, message: string) => void;
};

function noticeTitle(source: RecoverableErrorSource, kind: RecoverableErrorKind): string {
  const severity = kind === "warning" ? "Warning" : "Error";
  const category = source === "configuration" ? "Configuration error" : "Document error";
  return `${severity}: ${category}`;
}

export function createRecoverableNoticeController(): RecoverableNoticeController {
  const element = document.createElement("section");
  const notices = new Map<RecoverableErrorSource, RecoverableNotice>();
  element.classList.add("recoverable-notices");

  function clear(source: RecoverableErrorSource): void {
    const notice = notices.get(source);
    notice?.element.remove();
    notices.delete(source);
  }

  function dismiss(source: RecoverableErrorSource): boolean {
    if (!notices.has(source)) {
      return false;
    }
    clear(source);
    return true;
  }

  function activate(source: RecoverableErrorSource): boolean {
    const notice = notices.get(source);
    if (notice === undefined || notice.actionElement.hidden || notice.actionElement.onclick === null) {
      return false;
    }
    notice.actionElement.click();
    return true;
  }

  function createNotice(source: RecoverableErrorSource): RecoverableNotice {
    const noticeElement = document.createElement("aside");
    const contentElement = document.createElement("div");
    const titleElement = document.createElement("strong");
    const messageElement = document.createElement("span");
    const actionElement = document.createElement("button");
    const dismissElement = document.createElement("button");
    noticeElement.classList.add("recoverable-notice");
    noticeElement.setAttribute("role", "alert");
    contentElement.classList.add("recoverable-notice-content");
    dismissElement.type = "button";
    dismissElement.setAttribute("aria-label", "Dismiss error message");
    dismissElement.textContent = "Dismiss";
    actionElement.hidden = true;
    actionElement.type = "button";
    actionElement.textContent = "Restart Lumen";
    dismissElement.addEventListener("click", () => void dismiss(source));
    contentElement.append(titleElement, messageElement);
    noticeElement.append(contentElement, actionElement, dismissElement);
    element.append(noticeElement);
    return {actionElement, element: noticeElement, messageElement, titleElement};
  }

  function agentObservation(): string {
    const state = [...notices.entries()].map(([source, notice]) => ({
      hasAction: !notice.actionElement.hidden,
      kind: notice.element.classList.contains("recoverable-error") ? "error" : "warning",
      source,
    }));
    return JSON.stringify(state);
  }

  function show(source: RecoverableErrorSource, kind: RecoverableErrorKind, message: string): void {
    const notice = notices.get(source) ?? createNotice(source);
    notices.set(source, notice);
    notice.element.classList.toggle("recoverable-warning", kind === "warning");
    notice.element.classList.toggle("recoverable-error", kind === "error");
    notice.actionElement.hidden = true;
    notice.actionElement.onclick = null;
    notice.titleElement.textContent = noticeTitle(source, kind);
    notice.messageElement.textContent = message;
  }

  function showConfigurationRestart(restart: () => void): void {
    const notice = notices.get("configuration") ?? createNotice("configuration");
    notices.set("configuration", notice);
    notice.element.classList.add("recoverable-warning");
    notice.element.classList.remove("recoverable-error");
    notice.titleElement.textContent = "Restart required";
    notice.messageElement.textContent = "Lumen configuration changed. Restart Lumen to apply it.";
    notice.actionElement.hidden = false;
    notice.actionElement.onclick = restart;
  }

  return {activate, agentObservation, clear, dismiss, element, show, showConfigurationRestart};
}
