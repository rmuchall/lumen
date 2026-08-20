import {invoke} from "@tauri-apps/api/core";
import type {AgentBoundary, AgentEventRequest, AgentOperation, AgentOutcome} from "./protocol";

export function completeAgentEvent(
  request: AgentEventRequest,
  operation: AgentOperation,
  outcome: AgentOutcome,
  boundary: AgentBoundary,
  detail = "",
  causeRequestId = 0,
): void {
  if (!import.meta.env.DEV) {
    return;
  }
  void invoke<void>("report_agent_event_completion", {
    boundary,
    causeRequestId,
    detail,
    operation,
    outcome,
    requestId: request.requestId,
  });
}
