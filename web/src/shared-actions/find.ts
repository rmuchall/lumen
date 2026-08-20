import type {AgentFindNavigation, FindController} from "../find";

export type FindActions = {
  clear: () => void;
  next: () => void;
  previous: () => void;
  requestNext: () => Promise<AgentFindNavigation>;
  requestPrevious: () => Promise<AgentFindNavigation>;
  setQuery: (query: string) => void;
  show: () => void;
};

export function createFindActions(controller: FindController): FindActions {
  return {
    clear: () => controller.dismiss(),
    next: () => controller.next(),
    previous: () => controller.previous(),
    requestNext: () => controller.agentNext(),
    requestPrevious: () => controller.agentPrevious(),
    setQuery: (query) => controller.setQuery(query),
    show: () => controller.show(),
  };
}
