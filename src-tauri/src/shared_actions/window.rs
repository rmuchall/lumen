use std::sync::Mutex;

use tauri::Manager;

use crate::{logging::RunLog, window_state};

const DEFAULT_ZOOM_FACTOR: f64 = 1.0;
const ZOOM_INCREMENT: f64 = 0.1;
const MINIMUM_ZOOM_FACTOR: f64 = 0.5;
const MAXIMUM_ZOOM_FACTOR: f64 = 3.0;

pub(crate) struct ZoomState {
    factor: Mutex<f64>,
}

impl Default for ZoomState {
    fn default() -> Self {
        Self {
            factor: Mutex::new(DEFAULT_ZOOM_FACTOR),
        }
    }
}

pub(crate) fn zoom_in(app: &tauri::AppHandle) -> Result<(), String> {
    change_zoom(app, ZOOM_INCREMENT)
}

pub(crate) fn zoom_out(app: &tauri::AppHandle) -> Result<(), String> {
    change_zoom(app, -ZOOM_INCREMENT)
}

pub(crate) fn reset_zoom(app: &tauri::AppHandle) -> Result<(), String> {
    set_zoom(app, DEFAULT_ZOOM_FACTOR)
}

pub(crate) fn focus(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("the main window is unavailable".to_owned());
    };
    window
        .unminimize()
        .map_err(|error| format!("failed to restore the main window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("failed to show the main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus the main window: {error}"))
}

pub(crate) fn quit(app: &tauri::AppHandle) {
    window_state::save_current(app);
    app.exit(0);
}

#[cfg(debug_assertions)]
pub(crate) fn zoom_factor(app: &tauri::AppHandle) -> f64 {
    app.state::<ZoomState>()
        .factor
        .lock()
        .map(|factor| *factor)
        .unwrap_or(DEFAULT_ZOOM_FACTOR)
}

fn change_zoom(app: &tauri::AppHandle, delta: f64) -> Result<(), String> {
    let factor = app
        .state::<ZoomState>()
        .factor
        .lock()
        .map(|factor| *factor + delta)
        .unwrap_or(DEFAULT_ZOOM_FACTOR);
    set_zoom(app, factor)
}

fn set_zoom(app: &tauri::AppHandle, requested_factor: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("the main window is unavailable".to_owned());
    };
    let zoom_state = app.state::<ZoomState>();
    let Ok(mut zoom_factor) = zoom_state.factor.lock() else {
        return Err("the zoom state is unavailable".to_owned());
    };
    let new_factor = requested_factor.clamp(MINIMUM_ZOOM_FACTOR, MAXIMUM_ZOOM_FACTOR);
    window
        .set_zoom(new_factor)
        .map_err(|error| format!("failed to change the viewer zoom: {error}"))?;
    *zoom_factor = new_factor;
    app.state::<RunLog>().event("viewer-zoom-changed");
    Ok(())
}
