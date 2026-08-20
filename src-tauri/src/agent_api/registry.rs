use std::collections::{HashMap, VecDeque};

use super::protocol::{MAXIMUM_COMPLETION_HISTORY, MAXIMUM_IN_FLIGHT_REQUESTS};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentCompletion {
    pub(crate) boundary: String,
    pub(crate) cause_request_id: u64,
    pub(crate) detail: String,
    pub(crate) operation: String,
    pub(crate) outcome: String,
    pub(crate) request_id: u64,
    pub(crate) sequence: u64,
}

#[derive(Default)]
pub(crate) struct AgentRegistry {
    accepted: HashMap<u64, String>,
    completed: VecDeque<AgentCompletion>,
    pub(crate) frontend_ready: bool,
    highest_evicted_request_id: u64,
    last_registered_request_id: u64,
    next_sequence: u64,
    pub(crate) shutdown: bool,
}

impl AgentRegistry {
    pub(crate) fn register(&mut self, operation: &str) -> Result<u64, &'static str> {
        if self.shutdown {
            return Err("application-shutting-down");
        }
        if !self.frontend_ready {
            return Err("frontend-not-ready");
        }
        if self.accepted.len() == MAXIMUM_IN_FLIGHT_REQUESTS {
            return Err("too-many-in-flight-events");
        }
        let request_id = self
            .last_registered_request_id
            .checked_add(1)
            .ok_or("request-id-exhausted")?;
        self.last_registered_request_id = request_id;
        self.accepted.insert(request_id, operation.to_owned());
        Ok(request_id)
    }

    pub(crate) fn complete(
        &mut self,
        request_id: u64,
        operation: String,
        outcome: String,
        boundary: String,
        cause_request_id: u64,
        detail: String,
    ) -> Result<(), &'static str> {
        let Some(expected_operation) = self.accepted.get(&request_id) else {
            return Err("unknown-or-completed-request-id");
        };
        if expected_operation != &operation {
            return Err("completion-operation-mismatch");
        }
        self.accepted.remove(&request_id);
        self.retain_completion(AgentCompletion {
            boundary,
            cause_request_id,
            detail,
            operation,
            outcome,
            request_id,
            sequence: self.next_sequence + 1,
        });
        Ok(())
    }

    pub(crate) fn completion(&self, request_id: u64) -> Option<&AgentCompletion> {
        self.completed
            .iter()
            .find(|completion| completion.request_id == request_id)
    }

    pub(crate) fn completions_after(
        &self,
        sequence: u64,
    ) -> impl Iterator<Item = &AgentCompletion> {
        self.completed
            .iter()
            .filter(move |completion| completion.sequence > sequence)
    }

    pub(crate) fn is_pending(&self, request_id: u64) -> bool {
        self.accepted.contains_key(&request_id)
    }

    pub(crate) fn request_error(&self, request_id: u64) -> &'static str {
        if self.accepted.contains_key(&request_id) {
            "event-timeout"
        } else if request_id <= self.highest_evicted_request_id {
            "event-evicted"
        } else {
            "unknown-request-id"
        }
    }

    pub(crate) fn resolve_shutdown(&mut self) {
        if self.shutdown {
            return;
        }
        self.shutdown = true;
        for (request_id, operation) in std::mem::take(&mut self.accepted) {
            self.retain_completion(AgentCompletion {
                boundary: "input-consumed".to_owned(),
                cause_request_id: 0,
                detail: "reason=application-shutdown".to_owned(),
                operation,
                outcome: "stale".to_owned(),
                request_id,
                sequence: self.next_sequence + 1,
            });
        }
    }

    fn retain_completion(&mut self, mut completion: AgentCompletion) {
        if self.completed.len() == MAXIMUM_COMPLETION_HISTORY
            && let Some(evicted) = self.completed.pop_front()
        {
            self.highest_evicted_request_id = evicted.request_id;
        }
        self.next_sequence += 1;
        completion.sequence = self.next_sequence;
        self.completed.push_back(completion);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_registry() -> AgentRegistry {
        AgentRegistry {
            frontend_ready: true,
            ..Default::default()
        }
    }

    #[test]
    fn allocates_monotonic_request_ids() {
        let mut registry = ready_registry();
        assert_eq!(registry.register("test"), Ok(1));
        assert_eq!(registry.register("test"), Ok(2));
        assert_eq!(
            registry.complete(
                1,
                "test".to_owned(),
                "completed".to_owned(),
                "displayed".to_owned(),
                0,
                String::new(),
            ),
            Ok(())
        );
        assert_eq!(registry.register("test"), Ok(3));
    }

    #[test]
    fn requires_readiness_and_matching_operation() {
        let mut registry = AgentRegistry::default();
        assert_eq!(registry.register("open"), Err("frontend-not-ready"));
        let mut registry = ready_registry();
        assert_eq!(registry.register("open"), Ok(1));
        assert_eq!(
            registry.complete(
                1,
                "scroll".to_owned(),
                "completed".to_owned(),
                "displayed".to_owned(),
                0,
                String::new(),
            ),
            Err("completion-operation-mismatch")
        );
        assert!(registry.is_pending(1));
    }

    #[test]
    fn rejects_unknown_completion() {
        let mut registry = AgentRegistry::default();
        assert_eq!(
            registry.complete(
                1,
                "test".to_owned(),
                "completed".to_owned(),
                "displayed".to_owned(),
                0,
                String::new(),
            ),
            Err("unknown-or-completed-request-id")
        );
        assert_eq!(registry.completions_after(0).count(), 0);
    }

    #[test]
    fn retains_bounded_completion_history() {
        let mut registry = ready_registry();
        for request_id in 1..=u64::try_from(MAXIMUM_COMPLETION_HISTORY + 1).unwrap() {
            assert_eq!(registry.register("test"), Ok(request_id));
            assert_eq!(
                registry.complete(
                    request_id,
                    "test".to_owned(),
                    "completed".to_owned(),
                    "displayed".to_owned(),
                    0,
                    String::new(),
                ),
                Ok(())
            );
        }
        assert_eq!(
            registry.completions_after(0).count(),
            MAXIMUM_COMPLETION_HISTORY
        );
        assert_eq!(
            registry
                .completions_after(0)
                .next()
                .map(|event| event.request_id),
            Some(2)
        );
        assert_eq!(registry.request_error(1), "event-evicted");
    }

    #[test]
    fn bounds_in_flight_requests() {
        let mut registry = ready_registry();
        for request_id in 1..=u64::try_from(MAXIMUM_IN_FLIGHT_REQUESTS).unwrap() {
            assert_eq!(registry.register("scroll"), Ok(request_id));
        }
        assert_eq!(
            registry.register("scroll"),
            Err("too-many-in-flight-events")
        );
    }

    #[test]
    fn retains_the_request_that_superseded_an_action() {
        let mut registry = ready_registry();
        assert_eq!(registry.register("find-next"), Ok(1));
        assert_eq!(registry.register("find-next"), Ok(2));
        assert_eq!(
            registry.complete(
                1,
                "find-next".to_owned(),
                "superseded".to_owned(),
                "displayed".to_owned(),
                2,
                String::new(),
            ),
            Ok(())
        );

        assert_eq!(
            registry
                .completion(1)
                .expect("completion must be retained")
                .cause_request_id,
            2
        );
    }

    #[test]
    fn distinguishes_an_in_flight_request_from_an_unknown_request() {
        let mut registry = ready_registry();
        registry.register("scroll-settled").unwrap();
        assert_eq!(registry.request_error(1), "event-timeout");
        assert_eq!(registry.request_error(2), "unknown-request-id");
    }
}
