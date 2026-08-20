const COPY_LABEL = "Copy";
const COPIED_LABEL = "Copied";
const COPY_FAILED_LABEL = "Copy failed";
const RESULT_DURATION_MILLISECONDS = 1_500;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface DocumentBar {
  copyPath: () => Promise<boolean>;
  readonly element: HTMLElement;
  setPath: (path: string | null) => void;
}

function createCopyButton(copyPath: () => Promise<boolean>): HTMLButtonElement {
  const buttonElement = document.createElement("button");
  const iconElement = document.createElementNS(SVG_NAMESPACE, "svg");
  const iconUseElement = document.createElementNS(SVG_NAMESPACE, "use");
  const labelElement = document.createElement("span");
  let copyAttempt = 0;
  let resultTimer: number | null = null;
  buttonElement.className = "document-copy-button";
  buttonElement.type = "button";
  buttonElement.setAttribute("aria-label", "Copy document path");
  iconElement.setAttribute("aria-hidden", "true");
  iconElement.setAttribute("class", "document-copy-icon");
  iconUseElement.setAttribute("href", "/icons/heroicons-clipboard-document.svg#heroicons-clipboard-document");
  iconElement.append(iconUseElement);
  labelElement.textContent = COPY_LABEL;
  buttonElement.append(iconElement, labelElement);
  buttonElement.addEventListener("click", () => {
    const attempt = ++copyAttempt;
    void copyPath().then((copied) => {
      if (attempt !== copyAttempt) {
        return;
      }
      if (resultTimer !== null) {
        window.clearTimeout(resultTimer);
      }
      labelElement.textContent = copied ? COPIED_LABEL : COPY_FAILED_LABEL;
      resultTimer = window.setTimeout(() => {
        resultTimer = null;
        labelElement.textContent = COPY_LABEL;
      }, RESULT_DURATION_MILLISECONDS);
    });
  });
  return buttonElement;
}

function copyPath(pathElement: HTMLInputElement): Promise<boolean> {
  if (pathElement.value.length === 0) {
    return Promise.resolve(false);
  }
  pathElement.select();
  return navigator.clipboard.writeText(pathElement.value).then(
    () => true,
    () => false,
  );
}

export function createDocumentBar(): DocumentBar {
  const element = document.createElement("header");
  const pathControlElement = document.createElement("div");
  const pathElement = document.createElement("input");
  element.className = "document-bar";
  pathControlElement.className = "document-path-control";
  pathElement.className = "document-path";
  pathElement.type = "text";
  pathElement.readOnly = true;
  pathElement.tabIndex = -1;
  pathElement.setAttribute("aria-label", "Active document path");
  pathControlElement.append(
    pathElement,
    createCopyButton(() => copyPath(pathElement)),
  );
  element.append(pathControlElement);
  return {
    copyPath: () => copyPath(pathElement),
    element,
    setPath: (path) => {
      pathElement.value = path ?? "";
      element.hidden = path === null;
    },
  };
}
