use crate::{configuration::ConfigurationState, document, logging::RunLog};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

pub(crate) fn open_path(
    app: &tauri::AppHandle,
    path: PathBuf,
    viewer_position: Option<(f64, u64)>,
    emit_document_opened: bool,
) -> Result<(), String> {
    if let Some((scroll_position, source_offset)) = viewer_position {
        app.state::<document::DocumentState>()
            .save_active_viewer_position(scroll_position, source_offset);
    }
    let tabs_enabled = app
        .state::<ConfigurationState>()
        .settings
        .lock()
        .map(|settings| settings.tabs_enabled)
        .unwrap_or(true);
    if tabs_enabled {
        document::select(app, path, emit_document_opened)
    } else {
        document::replace_active(app, path, emit_document_opened)
    }
}

pub(crate) fn close_active(app: &tauri::AppHandle) -> Result<(), String> {
    let active_tab_id = app
        .state::<document::DocumentState>()
        .tabs()
        .into_iter()
        .find(|(_, _, active)| *active)
        .map(|(tab_id, _, _)| tab_id)
        .ok_or_else(|| "there is no opened document".to_owned())?;
    close_tabs(app, active_tab_id, "tab")?;
    app.emit("viewer-document-opened", ())
        .map_err(|error| format!("failed to display the selected document: {error}"))?;
    app.state::<RunLog>().event("document-closed");
    Ok(())
}

pub(crate) fn close_tabs(app: &tauri::AppHandle, tab_id: u64, action: &str) -> Result<(), String> {
    app.state::<document::DocumentState>()
        .close_tabs(tab_id, action)?;
    document::record_active_viewer_observations(app.state::<document::DocumentState>().inner());
    document::update_window_title(app)?;
    app.state::<RunLog>().event("document-tabs-closed");
    Ok(())
}

pub(crate) fn reload_active(app: &tauri::AppHandle) -> Result<(), String> {
    document::reload_active(app)
}

#[tauri::command]
pub(crate) fn open_document_with_viewer_position(
    path: PathBuf,
    scroll_position: f64,
    source_offset: u64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    open_path(&app, path, Some((scroll_position, source_offset)), false)
}

#[tauri::command]
pub(crate) fn close_document_tabs(
    tab_id: u64,
    action: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    close_tabs(&app, tab_id, &action)
}

#[tauri::command]
pub(crate) fn reload_document(app: tauri::AppHandle) -> Result<(), String> {
    reload_active(&app)
}
