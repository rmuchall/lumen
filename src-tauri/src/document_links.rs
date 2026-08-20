use crate::{
    document::{DocumentState, is_markdown_path, update_window_title},
    logging::RunLog,
};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;

fn link_scheme(link: &str) -> Option<&str> {
    let scheme_end = link.find(':')?;
    let delimiter_end = link.find(['/', '#', '?']).unwrap_or(link.len());
    if scheme_end > delimiter_end {
        return None;
    }
    Some(&link[..scheme_end])
}

fn decode_percent_encoded_path(path_text: &str) -> Result<String, String> {
    let bytes = path_text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let (Some(high), Some(low)) = (bytes.get(index + 1), bytes.get(index + 2)) else {
            return Err("the local link contains an incomplete percent escape".to_owned());
        };
        let digit = |value: u8| match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        };
        let (Some(high), Some(low)) = (digit(*high), digit(*low)) else {
            return Err("the local link contains an invalid percent escape".to_owned());
        };
        decoded.push(high << 4 | low);
        index += 3;
    }
    String::from_utf8(decoded).map_err(|_| "the local link contains a non-UTF-8 path".to_owned())
}

pub(crate) fn resolve_local_markdown_link(
    link: &str,
    current_document: &Path,
) -> Result<PathBuf, String> {
    let path_text = link.split_once('#').map_or(link, |(path, _)| path);
    if path_text.is_empty() {
        return Err("a same-document anchor does not need file navigation".to_owned());
    }
    if link_scheme(path_text).is_some() {
        return Err("only local Markdown-file links are supported".to_owned());
    }
    let decoded_path = decode_percent_encoded_path(path_text)?;
    let candidate = Path::new(&decoded_path);
    let resolved_path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        current_document
            .parent()
            .ok_or_else(|| "the current document has no parent directory".to_owned())?
            .join(candidate)
    };
    let resolved_path = resolved_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve {path_text}: {error}"))?;
    if !is_markdown_path(&resolved_path) {
        return Err("local links must target a Markdown file".to_owned());
    }
    Ok(resolved_path)
}

#[tauri::command]
pub(crate) fn activate_link(
    link: String,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<Option<String>, String> {
    let (target, anchor) = link
        .split_once('#')
        .map_or((link.as_str(), None), |(target, anchor)| {
            (target, Some(anchor.to_owned()))
        });
    if matches!(
        link_scheme(target).map(str::to_ascii_lowercase).as_deref(),
        Some("http" | "https")
    ) {
        if let Err(error) = Command::new("/usr/bin/xdg-open").arg(&link).spawn() {
            app.state::<RunLog>().event("external-link-open-failed");
            return Err(format!("failed to open the system browser: {error}"));
        }
        app.state::<RunLog>().event("external-link-opened");
        return Ok(None);
    }
    let current_document = match document_state
        .current_path()
        .ok_or_else(|| "there is no opened document for this link".to_owned())
    {
        Ok(document) => document,
        Err(error) => {
            app.state::<RunLog>().event("local-link-activate-failed");
            return Err(error);
        }
    };
    let path = match resolve_local_markdown_link(target, &current_document) {
        Ok(path) => path,
        Err(error) => {
            app.state::<RunLog>().event("local-link-resolve-failed");
            return Err(error);
        }
    };
    if let Err(error) = document_state.replace_active_path(path) {
        app.state::<RunLog>().event("local-link-select-failed");
        return Err(error);
    }
    if let Err(error) = update_window_title(&app) {
        app.state::<RunLog>().event("window-title-set-failed");
        return Err(error);
    }
    Ok(Some(anchor.unwrap_or_default()))
}
