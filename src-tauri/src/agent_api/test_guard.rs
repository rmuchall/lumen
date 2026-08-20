use std::{env, sync::Mutex};

const MAXIMUM_PHASE_BYTES: usize = 64;

pub(crate) struct TestInputGuard {
    active: bool,
    state: Mutex<TestRunState>,
}

#[derive(Clone)]
pub(crate) struct TestRunState {
    pub(crate) phase: String,
    pub(crate) tier: String,
}

impl TestInputGuard {
    pub(crate) fn from_command_line() -> Self {
        let active = env::args_os().any(|argument| argument == "--test-input-guard");
        Self {
            active,
            state: Mutex::new(TestRunState {
                phase: "initializing".to_owned(),
                tier: "initializing".to_owned(),
            }),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.active
    }

    pub(crate) fn snapshot(&self) -> TestRunState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or(TestRunState {
                phase: "unavailable".to_owned(),
                tier: "unavailable".to_owned(),
            })
    }

    fn update(&self, tier: String, phase: String) -> Result<(), String> {
        if !self.active {
            return Err("the test input guard is inactive".to_owned());
        }
        if !matches!(tier.as_str(), "critical" | "regular" | "stress") {
            return Err("the test tier is invalid".to_owned());
        }
        if phase.is_empty()
            || phase.len() > MAXIMUM_PHASE_BYTES
            || !phase
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("the test phase is invalid".to_owned());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "the test input guard state is unavailable".to_owned())?;
        state.phase = phase;
        state.tier = tier;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn update_test_run_state(
    guard: tauri::State<'_, TestInputGuard>,
    tier: String,
    phase: String,
) -> Result<(), String> {
    guard.update(tier, phase)
}

#[cfg(test)]
mod tests {
    use super::{TestInputGuard, TestRunState};

    #[test]
    fn only_active_guards_accept_bounded_test_statuses() {
        let guard = TestInputGuard {
            active: true,
            state: std::sync::Mutex::new(TestRunState {
                phase: "initializing".to_owned(),
                tier: "initializing".to_owned(),
            }),
        };
        assert!(
            guard
                .update("stress".to_owned(), "mixed-100mib".to_owned())
                .is_ok()
        );
        assert_eq!(guard.snapshot().tier, "stress");
        assert!(
            guard
                .update("unknown".to_owned(), "mixed-100mib".to_owned())
                .is_err()
        );
        assert!(
            guard
                .update("stress".to_owned(), "not allowed".to_owned())
                .is_err()
        );
    }
}
