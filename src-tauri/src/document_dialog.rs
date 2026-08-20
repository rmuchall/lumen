use crate::document::DocumentState;
use std::{env, path::PathBuf};

#[cfg(target_os = "linux")]
pub(crate) fn open_dialog(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    use gtk::prelude::{FileChooserExt, NativeDialogExt};
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is unavailable".to_owned())?;
    let parent = window
        .gtk_window()
        .map_err(|error| format!("failed to access the native window: {error}"))?;
    let dialog = gtk::FileChooserNative::new(
        Some("Open Markdown File"),
        Some(&parent),
        gtk::FileChooserAction::Open,
        Some("_Open"),
        Some("_Cancel"),
    );
    let filter = gtk::FileFilter::new();
    filter.set_name(Some("Markdown documents"));
    for pattern in ["*.md", "*.markdown", "*.mdown", "*.mkdn"] {
        filter.add_pattern(pattern);
    }
    dialog.add_filter(filter);
    let initial_directory = app
        .state::<DocumentState>()
        .current_path()
        .and_then(|path| path.parent().map(ToOwned::to_owned))
        .or_else(|| env::var_os("HOME").map(PathBuf::from));
    if let Some(directory) = initial_directory {
        let _ = dialog.set_current_folder(directory);
    }
    let path = if dialog.run() == gtk::ResponseType::Accept {
        dialog.filename()
    } else {
        None
    };
    dialog.destroy();
    Ok(path)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn open_dialog(_app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    Err("opening files through a dialog is not implemented on this platform".to_owned())
}
