use crate::logging::RunLog;
use std::{
    env,
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    thread,
};
use tauri::Manager;

const MAXIMUM_REQUEST_PATH_BYTES: usize = 32 * 1024;

pub(crate) struct InstanceState {
    listener: Mutex<Option<UnixListener>>,
    socket_path: Option<PathBuf>,
}

pub(crate) enum InstanceClaim {
    Forwarded,
    Primary(InstanceState),
}

enum ForwardResult {
    Forwarded,
    NoListener,
}

impl InstanceState {
    pub(crate) fn disabled() -> Self {
        Self {
            listener: Mutex::new(None),
            socket_path: None,
        }
    }
}

fn socket_path() -> Option<PathBuf> {
    let runtime_directory = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from)?;
    let directory = runtime_directory.join("lumen");
    fs::create_dir_all(&directory).ok()?;
    Some(directory.join("open.sock"))
}

fn write_request(stream: &mut UnixStream, path: Option<&Path>) -> io::Result<()> {
    let path_bytes = path.map_or(&[][..], |path| path.as_os_str().as_bytes());
    if path_bytes.len() > MAXIMUM_REQUEST_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "request path is too long",
        ));
    }
    let length = path_bytes.len() as u32;
    stream.write_all(&length.to_be_bytes())?;
    stream.write_all(path_bytes)
}

fn forward_request(path: &Path, document_path: Option<&Path>) -> io::Result<ForwardResult> {
    let mut stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(ForwardResult::NoListener);
        }
        Err(error) => return Err(error),
    };
    write_request(&mut stream, document_path)?;
    Ok(ForwardResult::Forwarded)
}

pub(crate) fn claim(document_path: Option<&Path>) -> Result<InstanceClaim, String> {
    let Some(path) = socket_path() else {
        return Ok(InstanceClaim::Primary(InstanceState::disabled()));
    };
    match forward_request(&path, document_path) {
        Ok(ForwardResult::Forwarded) => return Ok(InstanceClaim::Forwarded),
        Ok(ForwardResult::NoListener) => {}
        Err(error) => {
            return Err(format!(
                "failed to contact the running Lumen instance: {error}"
            ));
        }
    }
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            match forward_request(&path, document_path) {
                Ok(ForwardResult::Forwarded) => return Ok(InstanceClaim::Forwarded),
                Ok(ForwardResult::NoListener) => {
                    fs::remove_file(&path).map_err(|remove_error| {
                        format!("failed to remove Lumen's stale handoff socket: {remove_error}")
                    })?;
                    UnixListener::bind(&path).map_err(|bind_error| {
                        format!("failed to create Lumen's handoff socket: {bind_error}")
                    })?
                }
                Err(contact_error) => {
                    return Err(format!(
                        "failed to contact the running Lumen instance: {contact_error}"
                    ));
                }
            }
        }
        Err(error) => return Err(format!("failed to create Lumen's handoff socket: {error}")),
    };
    Ok(InstanceClaim::Primary(InstanceState {
        listener: Mutex::new(Some(listener)),
        socket_path: Some(path),
    }))
}

fn read_request(stream: &mut UnixStream) -> io::Result<Option<PathBuf>> {
    let mut length_bytes = [0; 4];
    stream.read_exact(&mut length_bytes)?;
    let length = u32::from_be_bytes(length_bytes) as usize;
    if length == 0 {
        return Ok(None);
    }
    if length > MAXIMUM_REQUEST_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "request path is too long",
        ));
    }
    let mut path_bytes = vec![0; length];
    stream.read_exact(&mut path_bytes)?;
    Ok(Some(PathBuf::from(OsString::from_vec(path_bytes))))
}

pub(crate) fn start(state: &InstanceState, app: tauri::AppHandle) {
    let Ok(mut listener) = state.listener.lock() else {
        app.state::<RunLog>().event("instance-handoff-setup-failed");
        return;
    };
    let Some(listener) = listener.take() else {
        return;
    };
    thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let document_path = match read_request(&mut stream) {
                        Ok(document_path) => document_path,
                        Err(_) => {
                            app.state::<RunLog>().event("instance-handoff-read-failed");
                            continue;
                        }
                    };
                    let app_handle = app.clone();
                    if app
                        .run_on_main_thread(move || {
                            let _ = handle_forwarded_document(&app_handle, document_path);
                        })
                        .is_err()
                    {
                        app.state::<RunLog>()
                            .event("instance-handoff-dispatch-failed");
                    }
                }
                Err(_) => {
                    app.state::<RunLog>()
                        .event("instance-handoff-listener-failed");
                    return;
                }
            }
        }
    });
}

/// Applies the primary-instance side of a forwarded open request.
/// Both the Unix listener and development Agent API use this one receiver path.
pub(crate) fn handle_forwarded_document(
    app: &tauri::AppHandle,
    document_path: Option<PathBuf>,
) -> Result<(), String> {
    if let Some(path) = document_path {
        if let Err(error) = crate::shared_actions::documents::open_path(app, path, None, true) {
            app.state::<RunLog>().event("instance-handoff-open-failed");
            return Err(error);
        }
        app.state::<RunLog>().event("instance-handoff-opened");
    }
    present_main_window(app);
    Ok(())
}

fn present_main_window(app: &tauri::AppHandle) {
    if crate::shared_actions::window::focus(app).is_err() {
        app.state::<RunLog>().event("instance-handoff-focus-failed");
    }
}

pub(crate) fn remove_socket(state: &InstanceState) {
    if let Some(path) = &state.socket_path {
        let _ = fs::remove_file(path);
    }
}

pub(crate) fn restart(document_path: Option<PathBuf>) -> Result<(), String> {
    let executable = env::current_exe()
        .map_err(|error| format!("failed to locate the Lumen executable: {error}"))?;
    let mut command = Command::new(executable);
    if let Some(path) = document_path {
        command.arg(path);
    }
    command
        .spawn()
        .map_err(|error| format!("failed to restart Lumen: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MAXIMUM_REQUEST_PATH_BYTES, read_request, write_request};
    use std::{io, os::unix::net::UnixStream, path::Path};

    #[test]
    fn request_framing_round_trips_a_document_path() {
        let (mut writer, mut reader) =
            UnixStream::pair().expect("test socket pair must be available");
        let expected = Path::new("/tmp/lumen framing fixture.md");

        write_request(&mut writer, Some(expected)).expect("request write must succeed");

        assert_eq!(
            read_request(&mut reader).expect("request read must succeed"),
            Some(expected.to_path_buf())
        );
    }

    #[test]
    fn request_framing_round_trips_an_empty_open_request() {
        let (mut writer, mut reader) =
            UnixStream::pair().expect("test socket pair must be available");

        write_request(&mut writer, None).expect("request write must succeed");

        assert_eq!(
            read_request(&mut reader).expect("request read must succeed"),
            None
        );
    }

    #[test]
    fn request_framing_rejects_an_oversized_path() {
        let (mut writer, _) = UnixStream::pair().expect("test socket pair must be available");
        let path = "x".repeat(MAXIMUM_REQUEST_PATH_BYTES + 1);

        let error = write_request(&mut writer, Some(Path::new(&path)))
            .expect_err("oversized request path must be rejected");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
