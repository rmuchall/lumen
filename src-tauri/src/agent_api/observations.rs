use super::{
    protocol,
    socket::{DocumentWorkObservation, EVENTS, STATE, complete_event},
};

const MAXIMUM_AGENT_EVENT_BYTES: usize = 1024;
const MAXIMUM_DOCUMENT_WORK_EVENTS: usize = 32;
const MAXIMUM_VIEWPORT_TRACE_SNAPSHOT_BYTES: usize = 48 * 1024;
const MAXIMUM_VIEWPORT_TRACE_CHUNK_BYTES: usize = 8 * 1024;
const MAXIMUM_VIEWPORT_TRACE_CHUNKS: usize = 6;

#[cfg(debug_assertions)]
pub(crate) fn record_document_work_lifecycle(
    lifecycle: &str,
    target: crate::document_work::WorkLifecycleTarget,
) {
    if !matches!(
        lifecycle,
        "queued"
            | "started"
            | "progress"
            | "cancelled"
            | "completed"
            | "failed"
            | "accepted"
            | "discarded"
    ) {
        return;
    }
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.document_work_lifecycle = lifecycle.to_owned();
    state.document_work_kind = target.kind.name().to_owned();
    state.document_work_sequence = state.document_work_sequence.saturating_add(1);
    let sequence = state.document_work_sequence;
    state.document_work_tab_id = target.tab_id;
    state.document_work_tab_revision = target.tab_revision;
    if state.document_work_events.len() == MAXIMUM_DOCUMENT_WORK_EVENTS {
        state.document_work_events.pop_front();
    }
    state
        .document_work_events
        .push_back(DocumentWorkObservation {
            kind: target.kind.name().to_owned(),
            lifecycle: lifecycle.to_owned(),
            sequence,
            tab_id: target.tab_id,
            tab_revision: target.tab_revision,
        });
}

#[cfg(debug_assertions)]
pub(crate) fn record_document_work_progress(
    target: crate::document_work::WorkLifecycleTarget,
    indexed_through: u64,
    checkpoint_count: u64,
    index_bytes: u64,
    directory_page_count: u64,
) {
    record_document_work_lifecycle("progress", target);
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.indexed_through = indexed_through;
    state.checkpoint_count = checkpoint_count;
    state.index_bytes = index_bytes;
    state.directory_page_count = directory_page_count;
}

#[cfg(debug_assertions)]
pub(crate) fn record_document_work_resource_counts(
    source_cache_bytes: u64,
    index_bytes: u64,
    search_bytes: u64,
) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.document_work_source_cache_bytes = source_cache_bytes;
    state.document_work_index_bytes = index_bytes;
    state.document_work_search_bytes = search_bytes;
}

#[cfg(debug_assertions)]
pub(crate) fn record_layout_page_viewport(source_start: u64, source_end: u64, source_length: u64) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.source_start = source_start;
    state.source_end = source_end;
    state.source_length = source_length;
}

#[cfg(debug_assertions)]
pub(crate) fn record_layout_page_resource_counts(
    indexed_through: u64,
    checkpoint_count: u64,
    index_bytes: u64,
    source_cache_bytes: u64,
    directory_page_count: u64,
    prepared_page_count: u64,
    prepared_html_bytes: u64,
) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.indexed_through = indexed_through;
    state.checkpoint_count = checkpoint_count;
    state.index_bytes = index_bytes;
    state.source_cache_bytes = source_cache_bytes;
    state.directory_page_count = directory_page_count;
    state.prepared_page_count = prepared_page_count;
    state.prepared_html_bytes = prepared_html_bytes;
}

#[cfg(not(debug_assertions))]
pub(crate) fn record_layout_page_viewport(
    _source_start: u64,
    _source_end: u64,
    _source_length: u64,
) {
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_displayed_html_inspection(
    request_id: u64,
    total_bytes: u64,
    displayed_html: String,
) -> bool {
    if request_id == 0
        || displayed_html.len() > protocol::MAXIMUM_INSPECTION_BYTES
        || u64::try_from(displayed_html.len()).unwrap_or(u64::MAX) > total_bytes
    {
        return false;
    }
    let Some(state) = STATE.get() else {
        return false;
    };
    let Ok(mut state) = state.lock() else {
        return false;
    };
    state.displayed_inspection_request_id = request_id;
    state.displayed_html_bytes = total_bytes;
    state.displayed_html = displayed_html;
    true
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_observation_scroll_state(
    viewport_state: String,
    sequence: u64,
    scroll_top: f64,
    scroll_height: f64,
    scroll_client_height: f64,
    scroll_source_offset: u64,
    visible_geometry: String,
) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    if sequence < state.scroll_state_sequence {
        return;
    }
    state.scroll_state_sequence = sequence;
    state.scroll_top = scroll_top.max(0.0);
    state.scroll_height = scroll_height.max(0.0);
    state.scroll_client_height = scroll_client_height.max(0.0);
    state.scroll_source_offset = scroll_source_offset;
    let mut visible_geometry = visible_geometry.split(':');
    let visible_source_start = visible_geometry
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let visible_source_end = visible_geometry
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let visible_page_top = visible_geometry
        .next()
        .and_then(|value| value.parse::<f64>().ok());
    let visible_page_bottom = visible_geometry
        .next()
        .and_then(|value| value.parse::<f64>().ok());
    let document_padding_bottom = visible_geometry
        .next()
        .and_then(|value| value.parse::<f64>().ok());
    if visible_geometry.next().is_none()
        && let (
            Some(visible_source_start),
            Some(visible_source_end),
            Some(visible_page_top),
            Some(visible_page_bottom),
            Some(document_padding_bottom),
        ) = (
            visible_source_start,
            visible_source_end,
            visible_page_top,
            visible_page_bottom,
            document_padding_bottom,
        )
    {
        state.visible_page_count = u64::from(visible_source_end > visible_source_start);
        state.visible_source_end = visible_source_end;
        state.visible_source_start = visible_source_start;
        state.visible_page_top = visible_page_top;
        state.visible_page_bottom = visible_page_bottom;
        state.document_padding_bottom = document_padding_bottom.max(0.0);
    }
    let mut viewport_state = viewport_state.split(':');
    let document_generation = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let input_generation = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let page_generation = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let width_epoch = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let geometry_revision = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let reader_input_active = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let measurement_commit_active = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let pending_page_request = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let scroll_write_pending = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    let viewport_anchor = viewport_state
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    if viewport_state.next().is_none()
        && let (
            Some(document_generation),
            Some(input_generation),
            Some(page_generation),
            Some(width_epoch),
            Some(geometry_revision),
            Some(reader_input_active),
            Some(measurement_commit_active),
            Some(pending_page_request),
            Some(scroll_write_pending),
            Some(viewport_anchor),
        ) = (
            document_generation,
            input_generation,
            page_generation,
            width_epoch,
            geometry_revision,
            reader_input_active,
            measurement_commit_active,
            pending_page_request,
            scroll_write_pending,
            viewport_anchor,
        )
    {
        state.document_generation = document_generation;
        state.input_generation = input_generation;
        state.page_generation = page_generation;
        state.width_epoch = width_epoch;
        state.geometry_revision = geometry_revision;
        state.reader_input_active = reader_input_active != 0;
        state.measurement_commit_active = measurement_commit_active != 0;
        state.pending_page_request = pending_page_request != 0;
        state.scroll_write_pending = scroll_write_pending != 0;
        state.viewport_anchor = viewport_anchor;
    }
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_observation_viewport_trace_chunk(
    trace_id: u64,
    chunk_index: usize,
    chunk_count: usize,
    chunk: String,
) {
    if trace_id == 0
        || chunk_count == 0
        || chunk_count > MAXIMUM_VIEWPORT_TRACE_CHUNKS
        || chunk_index >= chunk_count
        || chunk.len() > MAXIMUM_VIEWPORT_TRACE_CHUNK_BYTES
    {
        return;
    }
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    if chunk_index == 0 {
        state.viewport_trace_id = trace_id;
        state.viewport_trace_chunks.clear();
        state.viewport_trace_snapshot.clear();
    }
    if state.viewport_trace_id != trace_id || state.viewport_trace_chunks.len() != chunk_index {
        return;
    }
    state.viewport_trace_chunks.push(chunk);
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn commit_agent_observation_viewport_trace(trace_id: u64, chunk_count: usize) -> bool {
    let Some(state) = STATE.get() else {
        return false;
    };
    let Ok(mut state) = state.lock() else {
        return false;
    };
    if state.viewport_trace_id != trace_id
        || chunk_count == 0
        || chunk_count > MAXIMUM_VIEWPORT_TRACE_CHUNKS
        || state.viewport_trace_chunks.len() != chunk_count
    {
        return false;
    }
    let snapshot = state.viewport_trace_chunks.concat();
    state.viewport_trace_chunks.clear();
    if snapshot.len() > MAXIMUM_VIEWPORT_TRACE_SNAPSHOT_BYTES {
        return false;
    }
    state.viewport_trace_snapshot = snapshot;
    true
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn clear_agent_observation_viewport_trace(trace_id: u64) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    if state.viewport_trace_id == trace_id {
        state.viewport_trace_id = 0;
        state.viewport_trace_chunks.clear();
        state.viewport_trace_snapshot.clear();
    }
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_event_completion(
    request_id: u64,
    operation: String,
    outcome: String,
    boundary: String,
    detail: String,
    cause_request_id: u64,
) {
    if !protocol::operation_is_supported(&operation)
        || !matches!(
            outcome.as_str(),
            "completed" | "failed" | "no-op" | "not-found" | "stale" | "superseded" | "unavailable"
        )
        || !matches!(
            boundary.as_str(),
            "displayed" | "input-consumed" | "layout-settled" | "terminal-layout"
        )
        || detail.len() > MAXIMUM_AGENT_EVENT_BYTES
        || !detail
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'=' | b'-' | b'.'))
    {
        return;
    }
    let _ = complete_event(
        request_id,
        operation,
        outcome,
        boundary,
        cause_request_id,
        detail,
    );
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_observation_find_state(find_state: String) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.find_state = find_state;
    state.find_state_sequence += 1;
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_observation_ui_state(ui_state: String) {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.ui_state = ui_state;
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn report_agent_frontend_ready() {
    let Some(state) = STATE.get() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    state.frontend_ready = true;
    let (events, notifier) = EVENTS.get().expect("agent events must be initialized");
    let Ok(mut events) = events.lock() else {
        return;
    };
    events.frontend_ready = true;
    notifier.notify_all();
}
