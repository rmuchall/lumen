import {invoke} from "@tauri-apps/api/core";

export type TabCloseAction = "tab" | "other" | "right" | "left";

type ViewerPosition = {
  scrollPosition: number;
  sourceOffset: number;
};

export type DocumentActions = {
  closeTabs: (tabId: number, action: TabCloseAction) => Promise<boolean>;
  openPath: (path: string) => Promise<boolean>;
  selectTab: (tabId: number) => Promise<boolean>;
};

export type DocumentActionDependencies = {
  captureActiveLayout: () => void;
  currentViewerPosition: () => ViewerPosition;
  refreshSession: () => Promise<void>;
  showError: (message: string) => void;
};

export function createDocumentActions(dependencies: DocumentActionDependencies): DocumentActions {
  async function selectTab(tabId: number): Promise<boolean> {
    try {
      dependencies.captureActiveLayout();
      const position = dependencies.currentViewerPosition();
      await invoke<void>("select_document_tab", {
        sourceOffset: position.sourceOffset,
        tabId,
        scrollPosition: position.scrollPosition,
      });
      await dependencies.refreshSession();
      return true;
    } catch (error: unknown) {
      dependencies.showError(`Unable to select document tab: ${errorMessage(error)}`);
      return false;
    }
  }

  async function openPath(path: string): Promise<boolean> {
    try {
      const position = dependencies.currentViewerPosition();
      await invoke<void>("open_document_with_viewer_position", {
        path,
        sourceOffset: position.sourceOffset,
        scrollPosition: position.scrollPosition,
      });
      await dependencies.refreshSession();
      return true;
    } catch (error: unknown) {
      dependencies.showError(`Unable to open Markdown document: ${errorMessage(error)}`);
      return false;
    }
  }

  async function closeTabs(tabId: number, action: TabCloseAction): Promise<boolean> {
    try {
      await invoke<void>("close_document_tabs", {tabId, action});
      await dependencies.refreshSession();
      return true;
    } catch (error: unknown) {
      dependencies.showError(`Unable to close document tab: ${errorMessage(error)}`);
      return false;
    }
  }

  return {closeTabs, openPath, selectTab};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
