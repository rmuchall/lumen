#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
use std::env;
use std::{sync::OnceLock, time::Instant};
use tauri::{Emitter, Manager};

mod agent_api;
mod configuration;
mod document;
mod document_dialog;
mod document_index;
mod document_links;
mod document_search;
mod document_source;
mod document_work;
mod instance;
mod layout_page;
mod layout_page_document;
mod layout_page_limits;
mod layout_page_renderer;
mod logging;
mod markdown;
mod menu;
mod shared_actions;
mod viewer_api;
mod window_state;

use configuration::{ConfigurationState, Theme, configuration_path, watch_configuration};
use document::DocumentState;
use instance::{InstanceClaim, InstanceState};
use logging::RunLog;
use menu::{
    ABOUT as MENU_ABOUT, CLOSE_FILE as MENU_CLOSE_FILE, FIND as MENU_FIND, OPEN as MENU_OPEN,
    QUIT as MENU_QUIT, RELOAD as MENU_RELOAD, ZOOM_IN as MENU_ZOOM_IN, ZOOM_OUT as MENU_ZOOM_OUT,
    ZOOM_RESET as MENU_ZOOM_RESET,
};
use window_state::{should_start_maximized, start_maximized_from_state};

static APPLICATION_STARTED_AT: OnceLock<Instant> = OnceLock::new();

#[cfg(debug_assertions)]
macro_rules! application_invoke_handler {
    () => {
        tauri::generate_handler![
            document_links::activate_link,
            viewer_api::viewer_snapshot,
            shared_actions::documents::open_document_with_viewer_position,
            document::save_document_viewer_position,
            viewer_api::viewer_page_batch,
            viewer_api::viewer_layout_page_directory,
            viewer_api::viewer_first_page_displayed,
            viewer_api::viewer_enrich_page,
            viewer_api::viewer_find_step,
            viewer_api::viewer_find_next,
            viewer_api::viewer_find_previous,
            viewer_api::viewer_heading_offset,
            viewer_api::select_document_tab,
            shared_actions::documents::close_document_tabs,
            shared_actions::documents::reload_document,
            configuration_load_error,
            configuration_theme,
            restart_lumen,
            report_initial_render_ready,
            agent_api::observations::report_agent_displayed_html_inspection,
            agent_api::observations::report_agent_event_completion,
            agent_api::observations::report_agent_observation_find_state,
            agent_api::observations::report_agent_frontend_ready,
            agent_api::observations::report_agent_observation_ui_state,
            agent_api::observations::report_agent_observation_viewport_trace_chunk,
            agent_api::observations::commit_agent_observation_viewport_trace,
            agent_api::observations::clear_agent_observation_viewport_trace,
            agent_api::observations::report_agent_observation_scroll_state,
            agent_api::agent_handoff_open,
            agent_api::agent_focus_window,
            agent_api::agent_zoom,
            agent_api::test_guard::update_test_run_state,
            document::agent_watcher_ready
        ]
    };
}

#[cfg(not(debug_assertions))]
macro_rules! application_invoke_handler {
    () => {
        tauri::generate_handler![
            document_links::activate_link,
            viewer_api::viewer_snapshot,
            shared_actions::documents::open_document_with_viewer_position,
            document::save_document_viewer_position,
            viewer_api::viewer_page_batch,
            viewer_api::viewer_layout_page_directory,
            viewer_api::viewer_first_page_displayed,
            viewer_api::viewer_enrich_page,
            viewer_api::viewer_find_step,
            viewer_api::viewer_find_next,
            viewer_api::viewer_find_previous,
            viewer_api::viewer_heading_offset,
            viewer_api::select_document_tab,
            shared_actions::documents::close_document_tabs,
            shared_actions::documents::reload_document,
            configuration_load_error,
            configuration_theme,
            restart_lumen,
            report_initial_render_ready
        ]
    };
}

#[tauri::command]
fn configuration_load_error(configuration: tauri::State<'_, ConfigurationState>) -> Option<String> {
    configuration
        .load_error
        .lock()
        .ok()
        .and_then(|error| error.clone())
}

#[tauri::command]
fn configuration_theme(configuration: tauri::State<'_, ConfigurationState>) -> String {
    configuration
        .settings
        .lock()
        .map(|settings| settings.theme.name().to_owned())
        .unwrap_or_else(|_| Theme::System.name().to_owned())
}

#[tauri::command]
fn restart_lumen(
    app: tauri::AppHandle,
    instance_state: tauri::State<'_, InstanceState>,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<(), String> {
    instance::remove_socket(&instance_state);
    instance::restart(document_state.current_path())?;
    app.state::<RunLog>().event("restart-requested");
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn report_initial_render_ready(app: tauri::AppHandle, run_log: tauri::State<'_, RunLog>) {
    if let Some(application_started_at) = APPLICATION_STARTED_AT.get() {
        run_log.event("initial-render-ready");
        eprintln!(
            "initial-render-ready-ms={}",
            application_started_at.elapsed().as_millis()
        );
    }

    if shared_actions::window::focus(&app).is_err() {
        run_log.event("initial-window-present-failed");
    }
}

fn main() {
    let _ = APPLICATION_STARTED_AT.set(Instant::now());

    #[cfg(debug_assertions)]
    if agent_api::run_agent_client() {
        return;
    }

    #[cfg(debug_assertions)]
    let test_input_guard = agent_api::TestInputGuard::from_command_line();

    let configuration = ConfigurationState::load();
    let run_log = RunLog::open();
    let document_state = DocumentState::default();
    let initial_path = document::initial_path();
    let tabs_enabled = configuration
        .settings
        .lock()
        .map(|settings| settings.tabs_enabled)
        .unwrap_or(true);
    let instance_state = if tabs_enabled {
        match instance::claim(initial_path.as_deref()) {
            Ok(InstanceClaim::Forwarded) => return,
            Ok(InstanceClaim::Primary(instance_state)) => instance_state,
            Err(error) => {
                eprintln!("failed to initialise Lumen's tab handoff: {error}");
                InstanceState::disabled()
            }
        }
    } else {
        InstanceState::disabled()
    };

    if let Some(path) = initial_path
        && let Err(error) = document_state.insert_initial_path(path)
    {
        run_log.event("initial-document-source-failed");
        eprintln!("failed to access initial Markdown document: {error}");
    }

    if configuration
        .load_error
        .lock()
        .is_ok_and(|load_error| load_error.is_some())
    {
        run_log.event("configuration-load-failed");
    }

    let start_maximized = should_start_maximized(
        configuration
            .settings
            .lock()
            .map(|settings| settings.start_maximized)
            .unwrap_or(None),
        start_maximized_from_state(),
    );
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Ok(test_dev_url) = env::var("LUMEN_TEST_DEV_URL")
        && let Ok(test_dev_url) = test_dev_url.parse()
    {
        context.config_mut().build.dev_url = Some(test_dev_url);
    }
    if let Some(window) = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    {
        window.maximized = start_maximized;
    }

    let builder = tauri::Builder::default()
        .manage(configuration)
        .manage(run_log)
        .manage(document_state)
        .manage(instance_state)
        .manage(shared_actions::window::ZoomState::default());
    #[cfg(debug_assertions)]
    let builder = builder.manage(test_input_guard);
    let application = builder
        .setup(move |app| {
            if let Some(path) = app.state::<DocumentState>().current_path()
                && let Err(error) = document::allow_document_assets(app.handle(), &path)
            {
                app.state::<RunLog>()
                    .event("initial-document-assets-failed");
                eprintln!("failed to grant local image access: {error}");
            }

            let menu = menu::build(app).inspect_err(|_| {
                app.state::<RunLog>().event("menu-build-failed");
            })?;
            app.set_menu(menu).inspect_err(|_| {
                app.state::<RunLog>().event("menu-attach-failed");
            })?;

            if let Some(window) = app.get_webview_window("main") {
                let title = document::window_title();

                window.set_title(&title).inspect_err(|_| {
                    app.state::<RunLog>().event("window-title-set-failed");
                })?;

                #[cfg(debug_assertions)]
                if app.state::<agent_api::TestInputGuard>().is_active() {
                    window.set_enabled(false).inspect_err(|_| {
                        app.state::<RunLog>().event("test-input-guard-failed");
                    })?;
                    app.state::<RunLog>().event("test-input-guard-enabled");
                }
            }

            if let Err(error) = document::watch_open_documents(
                app.handle().clone(),
                app.state::<RunLog>().inner().clone(),
                app.state::<DocumentState>().inner().clone(),
            ) {
                app.state::<RunLog>().event("watcher-setup-failed");
                eprintln!("failed to watch opened Markdown file: {error}");
            }

            instance::start(app.state::<InstanceState>().inner(), app.handle().clone());

            if let Some(path) = configuration_path()
                && let Err(error) = watch_configuration(app.handle().clone(), path)
            {
                app.state::<RunLog>()
                    .event("configuration-watcher-setup-failed");
                eprintln!("failed to watch Lumen configuration: {error}");
            }

            #[cfg(debug_assertions)]
            if let Some(path) = agent_api::agent_socket_path()
                && agent_api::start_agent_socket(path, app.handle().clone()).is_err()
            {
                app.state::<RunLog>().event("agent-socket-failed");
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == MENU_OPEN {
                match document_dialog::open_dialog(app) {
                    Ok(Some(path)) => {
                        if let Err(error) =
                            shared_actions::documents::open_path(app, path, None, true)
                        {
                            app.state::<RunLog>().event("document-select-failed");
                            eprintln!("failed to open Markdown document: {error}");
                        }
                    }
                    Ok(None) => app.state::<RunLog>().event("document-select-cancelled"),
                    Err(error) => {
                        app.state::<RunLog>().event("document-dialog-failed");
                        eprintln!("failed to open file dialog: {error}");
                    }
                }
            } else if event.id() == MENU_CLOSE_FILE {
                if let Err(error) = shared_actions::documents::close_active(app) {
                    app.state::<RunLog>().event("document-close-failed");
                    eprintln!("failed to close Markdown document: {error}");
                }
            } else if event.id() == MENU_RELOAD {
                if let Err(error) = shared_actions::documents::reload_active(app) {
                    app.state::<RunLog>().event("viewer-reload-emit-failed");
                    eprintln!("failed to reload Markdown document: {error}");
                }
            } else if event.id() == MENU_ZOOM_IN {
                if let Err(error) = shared_actions::window::zoom_in(app) {
                    app.state::<RunLog>().event("viewer-zoom-failed");
                    eprintln!("failed to change the viewer zoom: {error}");
                }
            } else if event.id() == MENU_ZOOM_OUT {
                if let Err(error) = shared_actions::window::zoom_out(app) {
                    app.state::<RunLog>().event("viewer-zoom-failed");
                    eprintln!("failed to change the viewer zoom: {error}");
                }
            } else if event.id() == MENU_ZOOM_RESET {
                if let Err(error) = shared_actions::window::reset_zoom(app) {
                    app.state::<RunLog>().event("viewer-zoom-failed");
                    eprintln!("failed to change the viewer zoom: {error}");
                }
            } else if event.id() == MENU_FIND {
                if let Some(window) = app.get_webview_window("main") {
                    if window.emit("viewer-find", ()).is_ok() {
                        app.state::<RunLog>().event("viewer-find-requested");
                    } else {
                        app.state::<RunLog>().event("viewer-find-emit-failed");
                    }
                }
            } else if event.id() == MENU_ABOUT {
                if let Err(error) = menu::show_about(app) {
                    app.state::<RunLog>().event("about-dialog-failed");
                    eprintln!("failed to show About dialog: {error}");
                }
            } else if event.id() == MENU_QUIT {
                shared_actions::window::quit(app);
            }
        })
        .invoke_handler(application_invoke_handler!())
        .build(context)
        .expect("failed to build Lumen");

    application.run(|app_handle, event| {
        if let tauri::RunEvent::WindowEvent { label, event, .. } = &event
            && label == "main"
            && let tauri::WindowEvent::CloseRequested { api, .. } = event
        {
            #[cfg(debug_assertions)]
            if app_handle.state::<agent_api::TestInputGuard>().is_active() {
                api.prevent_close();
                return;
            }
            #[cfg(not(debug_assertions))]
            let _ = api;
            window_state::save_current(app_handle);
        }

        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<DocumentState>().shutdown_document_work();
            app_handle.state::<DocumentState>().remove_watch_control();
            agent_api::resolve_shutdown();
            instance::remove_socket(app_handle.state::<InstanceState>().inner());
            app_handle.state::<RunLog>().event("normal-shutdown");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::configuration::load_configuration;
    use crate::document_links::resolve_local_markdown_link;
    use crate::document_source::DocumentSource;
    use crate::layout_page_limits::LayoutPageLimits;
    use crate::markdown::{LARGE_MARKDOWN_SECTION, LARGE_MARKDOWN_SECTION_COUNT, render_markdown};
    use crate::window_state::{
        load_maximized as load_maximized_window_state,
        save_maximized as save_maximized_window_state,
    };
    use inotify::{Inotify, WatchMask};
    use std::{
        env, fs,
        path::Path,
        thread,
        time::{Instant, SystemTime},
    };

    #[test]
    fn identifies_development_windows() {
        assert_eq!(document::window_title(), "Lumen");
    }

    #[test]
    fn loads_start_maximized_configuration() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-configuration-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let configuration_path = test_directory.join("config.toml");
        fs::create_dir(&test_directory).unwrap();
        fs::write(
            &configuration_path,
            "version = 1\n\n[window]\nstart_maximized = true\n\n[appearance]\ntheme = \"dark\"\n\n[tabs]\nenabled = false\n",
        )
        .unwrap();

        let configuration = load_configuration(&configuration_path).unwrap();
        fs::remove_dir_all(test_directory).unwrap();

        assert_eq!(configuration.start_maximized, Some(true));
        assert!(!configuration.tabs_enabled);
        assert_eq!(configuration.theme, Theme::Dark);
    }

    #[test]
    fn saves_and_loads_maximized_window_state() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-window-state-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let state_path = test_directory.join("window-state.toml");

        save_maximized_window_state(&state_path, true).unwrap();
        let maximized = load_maximized_window_state(&state_path);
        fs::remove_dir_all(test_directory).unwrap();

        assert!(maximized);
    }

    #[test]
    fn configuration_overrides_saved_window_state() {
        assert!(should_start_maximized(None, true));
        assert!(!should_start_maximized(None, false));
        assert!(should_start_maximized(Some(true), false));
        assert!(!should_start_maximized(Some(false), true));
    }

    #[test]
    fn rejects_unknown_configuration_settings() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-configuration-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let configuration_path = test_directory.join("config.toml");
        fs::create_dir(&test_directory).unwrap();
        fs::write(&configuration_path, "version = 1\nunknown = true\n").unwrap();

        let error = load_configuration(&configuration_path).unwrap_err();
        fs::remove_dir_all(test_directory).unwrap();

        assert_eq!(error, "Lumen configuration contains unsupported settings.");
    }

    #[test]
    fn rejects_invalid_theme_configuration() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-configuration-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let configuration_path = test_directory.join("config.toml");
        fs::create_dir(&test_directory).unwrap();
        fs::write(
            &configuration_path,
            "version = 1\n\n[appearance]\ntheme = \"Dark\"\n",
        )
        .unwrap();

        let error = load_configuration(&configuration_path).unwrap_err();
        fs::remove_dir_all(test_directory).unwrap();

        assert_eq!(
            error,
            "Lumen configuration `appearance.theme` must be system, light, or dark."
        );
    }

    #[test]
    fn defaults_tabs_to_enabled_and_rejects_invalid_tabs_configuration() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-configuration-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let configuration_path = test_directory.join("config.toml");
        fs::create_dir(&test_directory).unwrap();
        fs::write(&configuration_path, "version = 1\n").unwrap();
        let configuration = load_configuration(&configuration_path).unwrap();
        assert!(configuration.tabs_enabled);

        fs::write(
            &configuration_path,
            "version = 1\n\n[tabs]\nenabled = \"false\"\n",
        )
        .unwrap();
        let error = load_configuration(&configuration_path).unwrap_err();
        fs::remove_dir_all(test_directory).unwrap();

        assert_eq!(
            error,
            "Lumen configuration `tabs.enabled` must be true or false."
        );
    }

    #[test]
    fn returns_a_readable_error_for_a_missing_document() {
        let path = env::temp_dir().join(format!(
            "lumen-missing-document-{}.md",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let error = DocumentSource::open(path.clone(), LayoutPageLimits::default())
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default();

        assert!(error.starts_with("failed to read the document:"));
    }

    #[test]
    fn renders_the_large_fixture() {
        for run_number in 1..=5 {
            let started_at = Instant::now();
            let rendered_html = render_markdown(
                &LARGE_MARKDOWN_SECTION.repeat(LARGE_MARKDOWN_SECTION_COUNT),
                None,
            );

            eprintln!(
                "large-fixture-render-run-{run_number}-ms={}",
                started_at.elapsed().as_millis()
            );
            assert!(!rendered_html.is_empty());
        }
    }

    #[test]
    fn references_local_png_images_through_the_asset_protocol() {
        let project_directory = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let rendered_html = render_markdown(
            "![Lumen icon](src-tauri/icons/icon.png)",
            Some(project_directory),
        );

        assert!(rendered_html.contains("data:application/x-lumen-asset,"));
        assert!(!rendered_html.contains("base64,"));
    }

    #[test]
    fn renders_the_gfm_baseline() {
        let rendered_html = render_markdown(
            "| Name | Value |\n| --- | --- |\n| Lumen | Fast |\n\n~~Old~~\n\n- [x] Done\n\nReference[^note].\n\n[^note]: Note text.\n",
            None,
        );

        assert!(rendered_html.contains("<table>"));
        assert!(rendered_html.contains("<del>Old</del>"));
        assert!(rendered_html.contains("type=\"checkbox\""));
        assert!(rendered_html.contains("footnote-reference"));
    }

    #[test]
    fn resolves_local_markdown_links_outside_the_current_directory() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-link-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let source_directory = test_directory.join("source");
        let target_directory = test_directory.join("target");
        let current_document = source_directory.join("current.md");
        let target_document = target_directory.join("target document.md");

        fs::create_dir_all(&source_directory).unwrap();
        fs::create_dir_all(&target_directory).unwrap();
        fs::write(&current_document, "current").unwrap();
        fs::write(&target_document, "target").unwrap();
        let expected_path = target_document.canonicalize().unwrap();

        let resolved_path = resolve_local_markdown_link(
            "../target/target%20document.md#target-document",
            &current_document,
        )
        .unwrap();
        fs::remove_dir_all(test_directory).unwrap();

        assert_eq!(resolved_path, expected_path);
    }

    #[test]
    fn rejects_non_markdown_and_non_local_links() {
        let current_document = Path::new("/tmp/current.md");

        assert!(
            resolve_local_markdown_link("https://example.com/document.md", current_document)
                .is_err()
        );
        assert!(resolve_local_markdown_link("document.txt", current_document).is_err());
    }

    #[test]
    fn watches_a_file_close_after_write() {
        let test_directory = env::temp_dir().join(format!(
            "lumen-inotify-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let file_path = test_directory.join("document.md");
        fs::create_dir(&test_directory).unwrap();
        fs::write(&file_path, "before").unwrap();

        let mut watcher = Inotify::init().unwrap();
        watcher
            .watches()
            .add(
                &test_directory,
                WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO,
            )
            .unwrap();

        let writer_path = file_path.clone();
        let writer = thread::spawn(move || fs::write(writer_path, "after"));
        let mut buffer = [0; 4096];
        let events = watcher.read_events_blocking(&mut buffer).unwrap();
        let file_changed = events
            .filter_map(|event| event.name)
            .any(|event_name| event_name == Path::new("document.md"));

        writer.join().unwrap().unwrap();
        fs::remove_dir_all(test_directory).unwrap();

        assert!(file_changed);
    }
}
