use crate::logging::{RunLog, lumen_state_directory};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

pub(crate) fn start_maximized_from_state() -> bool {
    window_state_path().as_deref().is_some_and(load_maximized)
}

pub(crate) fn should_start_maximized(configuration_value: Option<bool>, saved_state: bool) -> bool {
    configuration_value.unwrap_or(saved_state)
}

pub(crate) fn save_current(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(maximized) = window.is_maximized() else {
        app.state::<RunLog>().event("window-state-read-failed");
        return;
    };
    let Some(path) = window_state_path() else {
        app.state::<RunLog>().event("window-state-path-unavailable");
        return;
    };
    if save_maximized(&path, maximized).is_ok() {
        app.state::<RunLog>().event("window-state-saved");
    } else {
        app.state::<RunLog>().event("window-state-save-failed");
    }
}

fn window_state_path() -> Option<PathBuf> {
    let lumen_directory = lumen_state_directory()?;
    #[cfg(debug_assertions)]
    {
        Some(
            lumen_directory
                .join("development")
                .join("window-state.toml"),
        )
    }
    #[cfg(not(debug_assertions))]
    Some(lumen_directory.join("window-state.toml"))
}

pub(crate) fn load_maximized(path: &Path) -> bool {
    let Ok(state) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(table) = state.parse::<toml::Table>() else {
        return false;
    };
    table
        .get("maximized")
        .and_then(toml::Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn save_maximized(path: &Path, maximized: bool) -> std::io::Result<()> {
    if let Some(parent_directory) = path.parent() {
        fs::create_dir_all(parent_directory)?;
    }
    fs::write(path, format!("maximized = {maximized}\n"))
}
