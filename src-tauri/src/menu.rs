use tauri::{
    Manager,
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
};

pub(crate) const OPEN: &str = "open";
pub(crate) const CLOSE_FILE: &str = "close-file";
pub(crate) const RELOAD: &str = "reload";
pub(crate) const QUIT: &str = "quit";
pub(crate) const ZOOM_IN: &str = "zoom-in";
pub(crate) const ZOOM_OUT: &str = "zoom-out";
pub(crate) const ZOOM_RESET: &str = "zoom-reset";
pub(crate) const FIND: &str = "find";
pub(crate) const ABOUT: &str = "about";

pub(crate) fn build(app: &tauri::App<tauri::Wry>) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open = MenuItemBuilder::with_id(OPEN, "Open…")
        .accelerator("Ctrl+O")
        .build(app)?;
    let close_file = MenuItemBuilder::with_id(CLOSE_FILE, "Close File")
        .accelerator("Ctrl+W")
        .build(app)?;
    let reload = MenuItemBuilder::with_id(RELOAD, "Reload")
        .accelerator("Ctrl+R")
        .build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "Quit")
        .accelerator("Ctrl+Q")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id(ZOOM_IN, "Zoom In")
        .accelerator("Ctrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id(ZOOM_OUT, "Zoom Out")
        .accelerator("Ctrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id(ZOOM_RESET, "Actual Size")
        .accelerator("Ctrl+0")
        .build(app)?;
    let find = MenuItemBuilder::with_id(FIND, "Find")
        .accelerator("Ctrl+F")
        .build(app)?;
    let about = MenuItemBuilder::with_id(ABOUT, "About Lumen").build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&close_file)
        .separator()
        .item(&reload)
        .separator()
        .item(&quit)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit").item(&find).build()?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&about).build()?;
    MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()
}

#[cfg(target_os = "linux")]
pub(crate) fn show_about(app: &tauri::AppHandle) -> Result<(), String> {
    use gtk::prelude::{AboutDialogExt, DialogExt, GtkWindowExt};

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is unavailable".to_owned())?;
    let parent = window
        .gtk_window()
        .map_err(|error| format!("failed to access the native window: {error}"))?;
    let dialog = gtk::AboutDialog::new();
    dialog.set_transient_for(Some(&parent));
    dialog.set_modal(true);
    dialog.set_title("About Lumen");
    dialog.set_program_name("Lumen");
    dialog.set_version(Some(env!("CARGO_PKG_VERSION")));
    dialog.set_comments(Some("A fast, lightweight, offline Markdown viewer."));
    dialog.set_logo_icon_name(Some("lumen"));
    dialog.run();
    dialog.close();
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn show_about(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("the native About dialog is not implemented on this platform".to_owned())
}
