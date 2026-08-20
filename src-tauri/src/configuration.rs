use crate::logging::RunLog;
use inotify::{Inotify, WatchMask};
use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};
use tauri::{Emitter, Manager};

const CONFIGURATION_VERSION: i64 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::System => "System",
            Self::Light => "Light",
            Self::Dark => "Dark",
        }
    }
}

#[derive(Debug)]
pub(crate) struct Configuration {
    pub(crate) start_maximized: Option<bool>,
    pub(crate) tabs_enabled: bool,
    pub(crate) theme: Theme,
}

impl Default for Configuration {
    fn default() -> Self {
        Self {
            start_maximized: None,
            tabs_enabled: true,
            theme: Theme::System,
        }
    }
}

pub(crate) struct ConfigurationState {
    pub(crate) load_error: Mutex<Option<String>>,
    pub(crate) settings: Mutex<Configuration>,
}

impl ConfigurationState {
    pub(crate) fn load() -> Self {
        match configuration_path().map(|path| load_configuration(&path)) {
            Some(Ok(settings)) => Self {
                load_error: Mutex::new(None),
                settings: Mutex::new(settings),
            },
            Some(Err(load_error)) => Self {
                load_error: Mutex::new(Some(load_error)),
                settings: Mutex::new(Configuration::default()),
            },
            None => Self {
                load_error: Mutex::new(None),
                settings: Mutex::new(Configuration::default()),
            },
        }
    }
}

pub(crate) fn configuration_path() -> Option<PathBuf> {
    let directory = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|home_directory| PathBuf::from(home_directory).join(".config"))
        })?;

    Some(directory.join("lumen").join("config.toml"))
}

pub(crate) fn load_configuration(path: &Path) -> Result<Configuration, String> {
    let configuration = match fs::read_to_string(path) {
        Ok(configuration) => configuration,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Configuration::default());
        }
        Err(_) => return Err("Lumen could not read the configuration file.".to_owned()),
    };
    let table = configuration
        .parse::<toml::Table>()
        .map_err(|error| format!("Lumen could not parse the configuration file: {error}"))?;

    if table
        .keys()
        .any(|key| key != "version" && key != "window" && key != "appearance" && key != "tabs")
        || !table.contains_key("version")
    {
        return Err("Lumen configuration contains unsupported settings.".to_owned());
    }

    match table.get("version").and_then(toml::Value::as_integer) {
        Some(CONFIGURATION_VERSION) => {}
        Some(version) => {
            return Err(format!(
                "Lumen does not support configuration version {version}."
            ));
        }
        None => return Err("Lumen configuration `version` must be an integer.".to_owned()),
    }

    let start_maximized = match table.get("window") {
        None => None,
        Some(window) => {
            let Some(window) = window.as_table() else {
                return Err("Lumen configuration `window` must be a table.".to_owned());
            };
            if window.len() != 1 || !window.contains_key("start_maximized") {
                return Err("Lumen configuration contains unsupported window settings.".to_owned());
            }
            let Some(start_maximized) =
                window.get("start_maximized").and_then(toml::Value::as_bool)
            else {
                return Err(
                    "Lumen configuration `window.start_maximized` must be true or false."
                        .to_owned(),
                );
            };
            Some(start_maximized)
        }
    };
    let theme =
        match table.get("appearance") {
            None => Theme::System,
            Some(appearance) => {
                let Some(appearance) = appearance.as_table() else {
                    return Err("Lumen configuration `appearance` must be a table.".to_owned());
                };
                if appearance.len() != 1 || !appearance.contains_key("theme") {
                    return Err(
                        "Lumen configuration contains unsupported appearance settings.".to_owned(),
                    );
                }
                match appearance.get("theme").and_then(toml::Value::as_str) {
                    Some("system") => Theme::System,
                    Some("light") => Theme::Light,
                    Some("dark") => Theme::Dark,
                    _ => return Err(
                        "Lumen configuration `appearance.theme` must be system, light, or dark."
                            .to_owned(),
                    ),
                }
            }
        };
    let tabs_enabled = match table.get("tabs") {
        None => true,
        Some(tabs) => {
            let Some(tabs) = tabs.as_table() else {
                return Err("Lumen configuration `tabs` must be a table.".to_owned());
            };
            if tabs.len() != 1 || !tabs.contains_key("enabled") {
                return Err("Lumen configuration contains unsupported tabs settings.".to_owned());
            }
            tabs.get("enabled")
                .and_then(toml::Value::as_bool)
                .ok_or_else(|| {
                    "Lumen configuration `tabs.enabled` must be true or false.".to_owned()
                })?
        }
    };

    Ok(Configuration {
        start_maximized,
        tabs_enabled,
        theme,
    })
}

fn notify_configuration_changed(app: &tauri::AppHandle) {
    app.state::<RunLog>().event("configuration-change-detected");
    if app.emit("viewer-configuration-changed", ()).is_err() {
        app.state::<RunLog>()
            .event("configuration-change-emit-failed");
    }
}

fn watch_configuration_file(
    app: tauri::AppHandle,
    path: PathBuf,
    directory: PathBuf,
) -> std::io::Result<()> {
    let file_name = path.file_name().map(OsString::from);
    let mut watcher = Inotify::init()?;
    watcher.watches().add(
        directory,
        WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO | WatchMask::DELETE,
    )?;

    thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            let events = match watcher.read_events_blocking(&mut buffer) {
                Ok(events) => events,
                Err(_) => {
                    app.state::<RunLog>().event("configuration-watcher-failed");
                    return;
                }
            };
            if events
                .filter_map(|event| event.name)
                .any(|name| Some(name) == file_name.as_deref())
            {
                notify_configuration_changed(&app);
            }
        }
    });
    Ok(())
}

pub(crate) fn watch_configuration(app: tauri::AppHandle, path: PathBuf) -> std::io::Result<()> {
    let Some(directory) = path.parent().map(Path::to_path_buf) else {
        return Ok(());
    };
    if directory.is_dir() {
        return watch_configuration_file(app, path, directory);
    }
    let Some(parent_directory) = directory.parent().map(Path::to_path_buf) else {
        return Ok(());
    };
    if !parent_directory.is_dir() {
        return Ok(());
    }

    let directory_name = directory.file_name().map(OsString::from);
    let mut watcher = Inotify::init()?;
    watcher
        .watches()
        .add(&parent_directory, WatchMask::CREATE | WatchMask::MOVED_TO)?;
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            let events = match watcher.read_events_blocking(&mut buffer) {
                Ok(events) => events,
                Err(_) => {
                    app.state::<RunLog>()
                        .event("configuration-directory-watcher-failed");
                    return;
                }
            };
            let created = events
                .filter_map(|event| event.name)
                .any(|name| Some(name) == directory_name.as_deref());
            if created && directory.is_dir() {
                if watch_configuration_file(app.clone(), path, directory).is_err() {
                    app.state::<RunLog>()
                        .event("configuration-watcher-setup-failed");
                }
                return;
            }
        }
    });
    Ok(())
}
