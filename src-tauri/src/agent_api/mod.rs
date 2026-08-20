#[cfg(debug_assertions)]
use std::path::PathBuf;

#[cfg(debug_assertions)]
pub(crate) mod observations;
#[cfg(debug_assertions)]
mod protocol;
#[cfg(debug_assertions)]
mod registry;
#[cfg(debug_assertions)]
mod socket;
#[cfg(debug_assertions)]
pub(crate) mod test_guard;

#[cfg(debug_assertions)]
pub(crate) use observations::{
    record_document_work_lifecycle, record_document_work_progress,
    record_document_work_resource_counts, record_layout_page_resource_counts,
    record_layout_page_viewport,
};
#[cfg(debug_assertions)]
pub(crate) use socket::{
    agent_socket_path, resolve_shutdown, run_agent_client, start_agent_socket,
};
#[cfg(debug_assertions)]
pub(crate) use test_guard::TestInputGuard;

#[cfg(not(debug_assertions))]
pub(crate) fn resolve_shutdown() {}
#[cfg(not(debug_assertions))]
pub(crate) fn record_document_work_lifecycle(
    _lifecycle: &str,
    target: crate::document_work::WorkLifecycleTarget,
) {
    let _ = (target.kind, target.tab_id, target.tab_revision);
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
pub(crate) fn agent_handoff_open(
    app: tauri::AppHandle,
    document_path: String,
) -> Result<(), String> {
    if document_path.is_empty() {
        return Err("the agent handoff path is missing".to_owned());
    }
    crate::instance::handle_forwarded_document(&app, Some(PathBuf::from(document_path)))
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn agent_focus_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::shared_actions::window::focus(&app)
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn agent_zoom(action: String, app: tauri::AppHandle) -> Result<(), String> {
    match action.as_str() {
        "in" => crate::shared_actions::window::zoom_in(&app),
        "out" => crate::shared_actions::window::zoom_out(&app),
        "reset" => crate::shared_actions::window::reset_zoom(&app),
        _ => Err("the zoom action is invalid".to_owned()),
    }
}
