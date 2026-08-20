export type SeekOutcome = "completed" | "failed" | "stale" | "superseded";

export type ViewportActions = {
  seek: (sourceOffset: number, onCompletion?: (outcome: SeekOutcome) => void) => void;
  settle: () => void;
};

type ViewportActionDependencies = {
  queueSeek: (sourceOffset: number, onCompletion?: (outcome: SeekOutcome) => void) => void;
  settleViewport: () => void;
};

export function createViewportActions(dependencies: ViewportActionDependencies): ViewportActions {
  function seek(sourceOffset: number, onCompletion?: (outcome: SeekOutcome) => void): void {
    dependencies.queueSeek(sourceOffset, onCompletion);
  }

  function settle(): void {
    dependencies.settleViewport();
  }

  return {seek, settle};
}
