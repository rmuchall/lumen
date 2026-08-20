pub(crate) const PROTOCOL_VERSION: u8 = 3;
pub(crate) const MAXIMUM_REQUEST_BYTES: usize = 4 * 1024;
pub(crate) const MAXIMUM_EVENT_HISTORY_RESPONSE_BYTES: usize = 8 * 1024;
pub(crate) const MAXIMUM_INSPECTION_BYTES: usize = 64 * 1024;
pub(crate) const MAXIMUM_COMPLETION_HISTORY: usize = 128;
pub(crate) const MAXIMUM_IN_FLIGHT_REQUESTS: usize = 64;

pub(crate) const OPERATIONS: &[&str] = &[
    "close",
    "close-tabs",
    "configuration-notice",
    "copy-path",
    "directory-ready",
    "displayed-html",
    "drag-begin",
    "drag-end",
    "find",
    "find-clear",
    "find-next",
    "find-observation",
    "find-previous",
    "focus",
    "handoff-open",
    "link",
    "notice-action",
    "notice-dismiss",
    "open",
    "page-displayed",
    "reload",
    "scroll",
    "scroll-settled",
    "seek",
    "select-tab",
    "terminal-layout",
    "test-run-state",
    "watcher-ready",
    "watcher-reload",
    "viewport-trace-begin",
    "viewport-trace-end",
    "viewport-trace-read",
    "zoom",
];

pub(crate) fn operation_is_supported(operation: &str) -> bool {
    OPERATIONS.contains(&operation)
}

pub(crate) fn hello_response() -> String {
    format!(
        "agent-api-v{version} protocol={version} build=development build_version={build_version} capabilities=event,await,await-ready,events,status,tabs,inspection operations={operations} observation_schemas=status,tabs,inspection,find-state,ui-state,viewport-trace,window-state,document-work-events max_request_bytes={request_bytes} max_event_history_bytes={history_bytes} max_inspection_bytes={inspection_bytes}",
        version = PROTOCOL_VERSION,
        build_version = env!("CARGO_PKG_VERSION"),
        operations = OPERATIONS.join(","),
        request_bytes = MAXIMUM_REQUEST_BYTES,
        history_bytes = MAXIMUM_EVENT_HISTORY_RESPONSE_BYTES,
        inspection_bytes = MAXIMUM_INSPECTION_BYTES,
    )
}
