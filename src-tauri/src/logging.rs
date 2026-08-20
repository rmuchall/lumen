use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    sync::{Arc, Mutex},
    time::SystemTime,
};

const MAXIMUM_RETAINED_RUN_LOGS: usize = 10;
const MAXIMUM_RUN_LOG_BYTES: u64 = 64 * 1024;

#[derive(Clone)]
pub(crate) struct RunLog {
    file: Option<Arc<Mutex<RunLogFile>>>,
}

struct RunLogFile {
    bytes_written: u64,
    file: fs::File,
}

impl RunLog {
    pub(crate) fn open() -> Self {
        let Some(directory) = run_log_directory() else {
            return Self { file: None };
        };

        if fs::create_dir_all(&directory).is_err() {
            return Self { file: None };
        }

        remove_old_run_logs(&directory);

        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let path = directory.join(format!("run-{timestamp}-{}.log", process::id()));
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(path)
            .ok();
        let run_log = Self {
            file: file.map(|file| {
                Arc::new(Mutex::new(RunLogFile {
                    bytes_written: 0,
                    file,
                }))
            }),
        };

        run_log.event("run-start");
        run_log
    }

    pub(crate) fn event(&self, event: &str) {
        let Some(file) = &self.file else {
            return;
        };
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let record = format!("{timestamp} {event}\n");

        if let Ok(mut log_file) = file.lock() {
            let record_length = record.len() as u64;

            if log_file.bytes_written.saturating_add(record_length) > MAXIMUM_RUN_LOG_BYTES {
                return;
            }

            if log_file.file.write_all(record.as_bytes()).is_ok() {
                log_file.bytes_written += record_length;
            }
        }
    }
}

pub(crate) fn lumen_state_directory() -> Option<PathBuf> {
    let state_directory = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .map(|home_directory| PathBuf::from(home_directory).join(".local").join("state"))
        })?;

    Some(state_directory.join("lumen"))
}

fn run_log_directory() -> Option<PathBuf> {
    let lumen_directory = lumen_state_directory()?;

    #[cfg(debug_assertions)]
    {
        Some(lumen_directory.join("development").join("logs"))
    }

    #[cfg(not(debug_assertions))]
    Some(lumen_directory.join("logs"))
}

fn remove_old_run_logs(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
        .collect::<Vec<_>>();

    paths.sort();

    let excess_log_count = paths
        .len()
        .saturating_sub(MAXIMUM_RETAINED_RUN_LOGS.saturating_sub(1));

    for path in paths.into_iter().take(excess_log_count) {
        let _ = fs::remove_file(path);
    }
}
