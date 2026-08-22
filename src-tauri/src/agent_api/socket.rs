#[cfg(debug_assertions)]
use std::{
    collections::VecDeque,
    env,
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    net::Shutdown,
    os::unix::{
        fs::{FileTypeExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, OnceLock},
    thread,
};
#[cfg(debug_assertions)]
use tauri::{Emitter, Manager};

use super::{
    protocol,
    registry::{AgentCompletion, AgentRegistry},
};

#[cfg(test)]
const MAXIMUM_RESPONSE_BYTES: usize = protocol::MAXIMUM_INSPECTION_BYTES;
#[cfg(debug_assertions)]
const MAXIMUM_AGENT_ARGUMENT_BYTES: usize = protocol::MAXIMUM_REQUEST_BYTES;
#[cfg(debug_assertions)]
const MAXIMUM_AGENT_EVENT_HISTORY_RESPONSE_BYTES: usize =
    protocol::MAXIMUM_EVENT_HISTORY_RESPONSE_BYTES;
#[cfg(debug_assertions)]
#[cfg(test)]
fn bounded_utf8_response(html: &str, offset: usize, requested_length: usize) -> Vec<u8> {
    let mut start = offset.min(html.len());
    while start < html.len() && !html.is_char_boundary(start) {
        start += 1;
    }
    let mut end = start
        .saturating_add(requested_length.min(MAXIMUM_RESPONSE_BYTES))
        .min(html.len());
    while end > start && !html.is_char_boundary(end) {
        end -= 1;
    }
    html.as_bytes()[start..end].to_vec()
}
#[cfg(debug_assertions)]
#[derive(Clone)]
pub(super) struct DocumentWorkObservation {
    pub(super) kind: String,
    pub(super) lifecycle: String,
    pub(super) sequence: u64,
    pub(super) tab_id: u64,
    pub(super) tab_revision: u64,
}
#[cfg(debug_assertions)]
#[derive(Default)]
pub(super) struct AgentObservationState {
    pub(super) displayed_html: String,
    pub(super) displayed_html_bytes: u64,
    pub(super) displayed_inspection_request_id: u64,
    pub(super) frontend_ready: bool,
    pub(super) source_start: u64,
    pub(super) source_end: u64,
    pub(super) source_length: u64,
    pub(super) index_bytes: u64,
    pub(super) indexed_through: u64,
    pub(super) checkpoint_count: u64,
    pub(super) source_cache_bytes: u64,
    pub(super) directory_page_count: u64,
    pub(super) prepared_page_count: u64,
    pub(super) prepared_html_bytes: u64,
    pub(super) document_padding_bottom: f64,
    pub(super) scroll_client_height: f64,
    pub(super) scroll_height: f64,
    pub(super) scroll_state_sequence: u64,
    pub(super) scroll_source_offset: u64,
    pub(super) scroll_top: f64,
    pub(super) viewport_anchor: u64,
    pub(super) visible_page_count: u64,
    pub(super) visible_page_bottom: f64,
    pub(super) visible_page_top: f64,
    pub(super) visible_source_end: u64,
    pub(super) visible_source_start: u64,
    pub(super) document_generation: u64,
    pub(super) geometry_revision: u64,
    pub(super) input_generation: u64,
    pub(super) measurement_commit_active: bool,
    pub(super) page_generation: u64,
    pub(super) pending_page_request: bool,
    pub(super) reader_input_active: bool,
    pub(super) scroll_write_pending: bool,
    pub(super) width_epoch: u64,
    pub(super) viewport_trace_id: u64,
    pub(super) viewport_trace_chunks: Vec<String>,
    pub(super) viewport_trace_snapshot: String,
    pub(super) find_state: String,
    pub(super) find_state_sequence: u64,
    pub(super) ui_state: String,
    pub(super) ui_state_sequence: u64,
    pub(super) document_work_lifecycle: String,
    pub(super) document_work_kind: String,
    pub(super) document_work_sequence: u64,
    pub(super) document_work_tab_id: u64,
    pub(super) document_work_tab_revision: u64,
    pub(super) document_work_source_cache_bytes: u64,
    pub(super) document_work_index_bytes: u64,
    pub(super) document_work_search_bytes: u64,
    pub(super) document_work_events: VecDeque<DocumentWorkObservation>,
}

#[cfg(debug_assertions)]
pub(super) static STATE: OnceLock<Mutex<AgentObservationState>> = OnceLock::new();
#[cfg(debug_assertions)]
pub(super) static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(debug_assertions)]
pub(super) static EVENTS: OnceLock<(Mutex<AgentRegistry>, Condvar)> = OnceLock::new();

#[cfg(debug_assertions)]
fn register_event_request(operation: &str) -> Result<u64, &'static str> {
    let (events, _) = EVENTS.get().expect("agent events must be initialized");
    let mut events = events
        .lock()
        .expect("agent events lock must not be poisoned");
    events.register(operation)
}

#[cfg(debug_assertions)]
pub(super) fn complete_event(
    request_id: u64,
    operation: String,
    outcome: String,
    boundary: String,
    cause_request_id: u64,
    detail: String,
) -> Result<(), &'static str> {
    let (events, notifier) = EVENTS.get().expect("agent events must be initialized");
    let mut events = events
        .lock()
        .expect("agent events lock must not be poisoned");
    events.complete(
        request_id,
        operation,
        outcome,
        boundary,
        cause_request_id,
        detail,
    )?;
    notifier.notify_all();
    Ok(())
}

#[cfg(debug_assertions)]
pub(crate) fn resolve_shutdown() {
    let Some((events, notifier)) = EVENTS.get() else {
        return;
    };
    let Ok(mut events) = events.lock() else {
        return;
    };
    events.resolve_shutdown();
    notifier.notify_all();
}

#[cfg(not(debug_assertions))]
pub(crate) fn resolve_shutdown() {}

#[cfg(debug_assertions)]
pub(crate) fn agent_socket_path() -> Option<PathBuf> {
    let mut arguments = env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--agent-socket" {
            return arguments.next().map(PathBuf::from);
        }
    }
    None
}

#[cfg(debug_assertions)]
pub(crate) fn start_agent_socket(
    path: PathBuf,
    app_handle: tauri::AppHandle,
) -> std::io::Result<()> {
    validate_socket_parent(&path)?;
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_socket() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "agent socket path is not a socket",
            ));
        }
        match UnixStream::connect(&path) {
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    "agent socket is already active",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                fs::remove_file(&path)?;
            }
            Err(error) => return Err(error),
        }
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let _ = STATE.set(Mutex::new(AgentObservationState::default()));
    let _ = EVENTS.set((Mutex::new(AgentRegistry::default()), Condvar::new()));
    let _ = APP_HANDLE.set(app_handle);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let _ = handle_request(stream);
            });
        }
    });
    Ok(())
}

#[cfg(debug_assertions)]
fn validate_socket_parent(path: &Path) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "agent socket path has no parent",
        )
    })?;
    let parent_metadata = fs::metadata(parent)?;
    if !parent_metadata.is_dir() || parent_metadata.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "agent socket parent directory must be private",
        ));
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn agent_operation_is_supported(operation: &str) -> bool {
    protocol::operation_is_supported(operation)
}

#[cfg(debug_assertions)]
fn write_event(stream: &mut UnixStream, event: &AgentCompletion) -> std::io::Result<()> {
    writeln!(
        stream,
        "event-v1 request_id={} operation={} outcome={} boundary={} sequence={} cause_request_id={} detail={}",
        event.request_id,
        event.operation,
        event.outcome,
        event.boundary,
        event.sequence,
        event.cause_request_id,
        event.detail,
    )
}

#[cfg(debug_assertions)]
fn handle_request(mut stream: UnixStream) -> std::io::Result<()> {
    let mut request = String::new();
    BufReader::new(stream.try_clone()?).read_line(&mut request)?;
    let request = request.trim_end_matches(['\r', '\n']);
    if request == "hello" {
        return writeln!(stream, "{}", protocol::hello_response());
    }
    if request == "await-ready" {
        let (events, notifier) = EVENTS.get().expect("agent events must be initialized");
        let events = events
            .lock()
            .expect("agent events lock must not be poisoned");
        let events = notifier
            .wait_while(events, |events| !events.frontend_ready && !events.shutdown)
            .expect("agent events lock must not be poisoned");
        if events.frontend_ready {
            return writeln!(
                stream,
                "event-v1 request_id=0 operation=frontend-ready outcome=completed boundary=displayed sequence=0 cause_request_id=0",
            );
        }
        return writeln!(stream, "error=frontend-not-ready");
    }
    if let Some(request_id) = request.strip_prefix("await ") {
        let Ok(request_id) = request_id.parse::<u64>() else {
            return writeln!(stream, "error=invalid-request-id");
        };
        let (events, notifier) = EVENTS.get().expect("agent events must be initialized");
        let events = events
            .lock()
            .expect("agent events lock must not be poisoned");
        let events = notifier
            .wait_while(events, |events| {
                events.completion(request_id).is_none()
                    && events.is_pending(request_id)
                    && !events.shutdown
            })
            .expect("agent events lock must not be poisoned");
        if let Some(event) = events.completion(request_id) {
            return write_event(&mut stream, event);
        }
        if events.shutdown {
            return writeln!(stream, "error=application-shutting-down");
        }
        return writeln!(stream, "error={}", events.request_error(request_id));
    }
    if let Some(after_sequence) = request.strip_prefix("events") {
        let after_sequence = after_sequence.trim();
        let after_sequence = if after_sequence.is_empty() {
            0
        } else {
            let Ok(sequence) = after_sequence.parse::<u64>() else {
                return writeln!(stream, "error=invalid-event-sequence");
            };
            sequence
        };
        let (events, _) = EVENTS.get().expect("agent events must be initialized");
        let events = events
            .lock()
            .expect("agent events lock must not be poisoned");
        let mut response_bytes = 0;
        for event in events.completions_after(after_sequence) {
            let response = format!(
                "event-v1 request_id={} operation={} outcome={} boundary={} sequence={} cause_request_id={} detail={}\n",
                event.request_id,
                event.operation,
                event.outcome,
                event.boundary,
                event.sequence,
                event.cause_request_id,
                event.detail,
            );
            if response_bytes + response.len() > MAXIMUM_AGENT_EVENT_HISTORY_RESPONSE_BYTES {
                return writeln!(stream, "error=events-response-too-large");
            }
            stream.write_all(response.as_bytes())?;
            response_bytes += response.len();
        }
        return Ok(());
    }
    if let Some(event_request) = request.strip_prefix("event ") {
        let mut fields = event_request.splitn(2, ' ');
        let operation = fields.next().filter(|value| !value.is_empty());
        let arguments = fields.next().unwrap_or("");
        let Some(operation) = operation else {
            return writeln!(stream, "error=invalid-event-request");
        };
        if !operation
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
            || !agent_operation_is_supported(operation)
        {
            return writeln!(stream, "error=invalid-event-operation");
        }
        if arguments.len() > MAXIMUM_AGENT_ARGUMENT_BYTES
            || arguments.contains('\0')
            || arguments.contains(['\r', '\n'])
        {
            return writeln!(stream, "error=invalid-event-arguments");
        }
        let request_id = match register_event_request(operation) {
            Ok(request_id) => request_id,
            Err(error) => return writeln!(stream, "error={error}"),
        };
        let event_name = format!("agent-event-{operation}");
        if APP_HANDLE
            .get()
            .expect("agent application handle must be initialized")
            .emit(&event_name, format!("{request_id}\t{arguments}"))
            .is_err()
        {
            let _ = complete_event(
                request_id,
                operation.to_owned(),
                "failed".to_owned(),
                "input-consumed".to_owned(),
                0,
                "reason=dispatch-failed".to_owned(),
            );
        }
        return writeln!(stream, "accepted {request_id}");
    }
    if request == "window-state" {
        let app = APP_HANDLE
            .get()
            .expect("agent application handle must be initialized");
        let Some(window) = app.get_webview_window("main") else {
            return writeln!(stream, "error=main-window-unavailable");
        };
        let test_guard = app.state::<crate::agent_api::TestInputGuard>();
        let test_state = test_guard.snapshot();
        return writeln!(
            stream,
            "visible={} enabled={} minimized={} maximized={} focused={} zoom_factor={} test_guard_active={} test_guard_tier={} test_guard_phase={}",
            window.is_visible().unwrap_or(false),
            window.is_enabled().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
            window.is_maximized().unwrap_or(false),
            window.is_focused().unwrap_or(false),
            crate::shared_actions::window::zoom_factor(app),
            test_guard.is_active(),
            test_state.tier,
            test_state.phase,
        );
    }
    let state = STATE
        .get()
        .expect("diagnostic state must be initialized")
        .lock()
        .expect("diagnostic state lock must not be poisoned");
    if request == "status" {
        return writeln!(
            stream,
            "frontend_ready={} displayed_html_bytes={} source_start={} source_end={} source_length={} indexed_through={} checkpoint_count={} index_bytes={} source_cache_bytes={} directory_page_count={} prepared_page_count={} prepared_html_bytes={} document_padding_bottom={} scroll_state_sequence={} scroll_source_offset={} scroll_top={} viewport_anchor={} scroll_height={} scroll_client_height={} visible_page_count={} visible_page_top={} visible_page_bottom={} visible_source_start={} visible_source_end={} document_generation={} input_generation={} page_generation={} width_epoch={} geometry_revision={} reader_input_active={} measurement_commit_active={} pending_page_request={} scroll_write_pending={} find_state_sequence={} document_work_lifecycle={} document_work_kind={} document_work_sequence={} document_work_tab_id={} document_work_tab_revision={} document_work_source_cache_bytes={} document_work_index_bytes={} document_work_search_bytes={}",
            state.frontend_ready,
            state.displayed_html_bytes,
            state.source_start,
            state.source_end,
            state.source_length,
            state.indexed_through,
            state.checkpoint_count,
            state.index_bytes,
            state.source_cache_bytes,
            state.directory_page_count,
            state.prepared_page_count,
            state.prepared_html_bytes,
            state.document_padding_bottom,
            state.scroll_state_sequence,
            state.scroll_source_offset,
            state.scroll_top,
            state.viewport_anchor,
            state.scroll_height,
            state.scroll_client_height,
            state.visible_page_count,
            state.visible_page_top,
            state.visible_page_bottom,
            state.visible_source_start,
            state.visible_source_end,
            state.document_generation,
            state.input_generation,
            state.page_generation,
            state.width_epoch,
            state.geometry_revision,
            state.reader_input_active,
            state.measurement_commit_active,
            state.pending_page_request,
            state.scroll_write_pending,
            state.find_state_sequence,
            state.document_work_lifecycle,
            state.document_work_kind,
            state.document_work_sequence,
            state.document_work_tab_id,
            state.document_work_tab_revision,
            state.document_work_source_cache_bytes,
            state.document_work_index_bytes,
            state.document_work_search_bytes,
        );
    }
    if request == "document-work-events" {
        writeln!(
            stream,
            "document_work_events={}",
            state.document_work_events.len()
        )?;
        for event in &state.document_work_events {
            writeln!(
                stream,
                "sequence={} kind={} lifecycle={} tab_id={} tab_revision={}",
                event.sequence, event.kind, event.lifecycle, event.tab_id, event.tab_revision
            )?;
        }
        return Ok(());
    }
    if request == "quit" {
        writeln!(stream, "quitting")?;
        stream.flush()?;
        stream.shutdown(Shutdown::Write)?;
        crate::shared_actions::window::quit(
            APP_HANDLE
                .get()
                .expect("agent application handle must be initialized"),
        );
        return Ok(());
    }
    if let Some(trace_id) = request.strip_prefix("viewport-trace ") {
        let Ok(trace_id) = trace_id.parse::<u64>() else {
            return writeln!(stream, "error=invalid-trace-id");
        };
        if state.viewport_trace_id != trace_id || state.viewport_trace_snapshot.is_empty() {
            return writeln!(stream, "error=viewport-trace-unavailable");
        }
        let snapshot = state.viewport_trace_snapshot.clone();
        drop(state);
        return stream.write_all(snapshot.as_bytes());
    }
    if request == "find-state" {
        return writeln!(stream, "{}", state.find_state);
    }
    if request == "find-probe" {
        drop(state);
        APP_HANDLE
            .get()
            .expect("agent application handle must be initialized")
            .emit("agent-observation-find-probe", ())
            .map_err(std::io::Error::other)?;
        return writeln!(stream, "find-probe=requested");
    }
    if request == "ui-state" {
        return writeln!(
            stream,
            "ui_state_sequence={} {}",
            state.ui_state_sequence, state.ui_state
        );
    }
    if request == "ui-probe" {
        let previous_sequence = state.ui_state_sequence;
        drop(state);
        APP_HANDLE
            .get()
            .expect("agent application handle must be initialized")
            .emit("agent-observation-ui-probe", ())
            .map_err(std::io::Error::other)?;
        return writeln!(
            stream,
            "ui-probe=requested after_sequence={previous_sequence}"
        );
    }
    if request == "tabs" {
        let tabs = crate::document::agent_tabs(
            APP_HANDLE
                .get()
                .expect("agent application handle must be initialized"),
        );
        writeln!(stream, "tab_count={}", tabs.len())?;
        for (id, revision, active, stale, frozen, scroll_position, source_offset) in tabs {
            writeln!(
                stream,
                "tab_id={id} revision={revision} active={active} stale={stale} frozen={frozen} scroll_position={scroll_position} source_offset={source_offset}"
            )?;
        }
        return Ok(());
    }
    if request == "watcher-ready" {
        let ready = APP_HANDLE
            .get()
            .expect("agent application handle must be initialized")
            .state::<crate::document::DocumentState>()
            .agent_watcher_ready();
        return writeln!(stream, "watcher_ready={ready}");
    }
    if request == "scroll-probe" {
        drop(state);
        APP_HANDLE
            .get()
            .expect("agent application handle must be initialized")
            .emit("agent-observation-scroll-probe", ())
            .map_err(std::io::Error::other)?;
        return writeln!(stream, "scroll-probe=requested");
    }
    let Some(request_id) = request
        .strip_prefix("displayed-html ")
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return writeln!(stream, "error=unknown-request");
    };
    if request_id == 0 || request_id != state.displayed_inspection_request_id {
        return writeln!(stream, "error=inspection-unavailable");
    }
    writeln!(
        stream,
        "displayed_html_bytes={} response_bytes={}",
        state.displayed_html_bytes,
        state.displayed_html.len()
    )?;
    stream.write_all(state.displayed_html.as_bytes())
}

#[cfg(debug_assertions)]
pub(crate) fn run_agent_client() -> bool {
    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--inspect-agent-socket")) {
        return false;
    }
    let Some(path) = arguments.next().map(PathBuf::from) else {
        eprintln!("missing agent socket path");
        return true;
    };
    let request = arguments.next().unwrap_or_else(|| OsString::from("status"));
    let request = arguments.fold(request, |mut request, argument| {
        request.push(" ");
        request.push(argument);
        request
    });
    let mut stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("failed to connect to agent socket: {error}");
            return true;
        }
    };
    if stream.write_all(request.as_encoded_bytes()).is_err() || stream.write_all(b"\n").is_err() {
        eprintln!("failed to send agent API request");
        return true;
    }
    let mut response = Vec::new();
    if std::io::Read::read_to_end(&mut stream, &mut response).is_err() {
        eprintln!("failed to read agent API response");
        return true;
    }
    let _ = std::io::stdout().write_all(&response);
    true
}

#[cfg(test)]
mod tests {
    use super::{bounded_utf8_response, validate_socket_parent};
    use std::{
        env, fs,
        os::unix::fs::PermissionsExt,
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn test_directory() -> std::path::PathBuf {
        env::temp_dir().join(format!(
            "lumen-agent-socket-test-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time must be after the Unix epoch")
                .as_nanos(),
        ))
    }

    #[test]
    fn requires_a_private_socket_parent_directory() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("test directory must be created");
        let socket_path = directory.join("agent.sock");

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private permissions must be set");
        assert!(validate_socket_parent(&socket_path).is_ok());

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755))
            .expect("non-private permissions must be set");
        assert_eq!(
            validate_socket_parent(&socket_path)
                .expect_err("non-private parent must be rejected")
                .kind(),
            std::io::ErrorKind::PermissionDenied,
        );
        fs::remove_dir_all(directory).expect("test directory must be removed");
    }

    #[test]
    fn inspection_responses_never_split_utf8_characters() {
        let html = "A🦀B";

        assert_eq!(bounded_utf8_response(html, 0, 4), b"A");
        assert_eq!(bounded_utf8_response(html, 1, 4), "🦀".as_bytes());
        assert_eq!(bounded_utf8_response(html, 2, 4), b"B");
    }
}
