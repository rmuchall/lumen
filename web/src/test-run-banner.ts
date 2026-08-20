export type TestRunBannerState = {
  phase: string;
  tier: string;
};

export type TestRunBanner = {
  element: HTMLElement;
  show: (state: TestRunBannerState) => void;
};

function displayPhase(phase: string): string {
  return phase.replaceAll("-", " ");
}

export function createTestRunBanner(): TestRunBanner {
  const element = document.createElement("aside");
  const tierElement = document.createElement("strong");
  const phaseElement = document.createElement("span");
  element.classList.add("test-run-banner");
  element.hidden = true;
  element.setAttribute("aria-live", "polite");
  element.setAttribute("role", "status");
  element.append(tierElement, phaseElement);
  return {
    element,
    show: ({tier, phase}) => {
      tierElement.textContent = `Test run in progress · ${tier.toUpperCase()}`;
      phaseElement.textContent = displayPhase(phase);
      element.hidden = false;
    },
  };
}
import "./test-run-banner.css";
