const COPY_LABEL = "Copy";
const COPIED_LABEL = "Copied";
const COPY_FAILED_LABEL = "Copy failed";
const RESULT_DURATION_MILLISECONDS = 1_500;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function createCopyButton(codeElement: HTMLElement): HTMLButtonElement {
  const buttonElement = document.createElement("button");
  const iconElement = document.createElementNS(SVG_NAMESPACE, "svg");
  const labelElement = document.createElement("span");
  const iconUseElement = document.createElementNS(SVG_NAMESPACE, "use");
  let copyAttempt = 0;
  let resultTimer: number | null = null;

  async function copyCode(): Promise<void> {
    const attempt = ++copyAttempt;
    let copied = false;
    try {
      await navigator.clipboard.writeText(codeElement.textContent ?? "");
      copied = true;
    } catch {
      copied = false;
    }
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
  }

  buttonElement.className = "code-copy-button";
  buttonElement.setAttribute("aria-label", "Copy code block");
  buttonElement.type = "button";
  iconElement.setAttribute("aria-hidden", "true");
  iconElement.setAttribute("class", "code-copy-icon");
  iconUseElement.setAttribute("href", "/icons/heroicons-clipboard-document.svg#heroicons-clipboard-document");
  iconElement.append(iconUseElement);
  labelElement.textContent = COPY_LABEL;
  buttonElement.append(iconElement, labelElement);
  buttonElement.addEventListener("click", () => void copyCode());
  return buttonElement;
}

export function installCodeCopyControls(markdownElement: HTMLElement): void {
  for (const codeElement of markdownElement.querySelectorAll<HTMLElement>("pre > code")) {
    const preElement = codeElement.parentElement;
    if (preElement?.querySelector(":scope > .code-copy-button") === null) {
      preElement?.append(createCopyButton(codeElement));
    }
  }
}
