use crate::{
    document::{DocumentState, STALE_VIEWER_REQUEST, record_active_viewer_observations},
    logging::RunLog,
};
use tauri::Manager;

type ViewerSnapshot = (
    Vec<(u64, String, bool)>,
    Option<String>,
    String,
    Option<String>,
    f64,
    u64,
    u64,
    u64,
    u64,
    u64,
    String,
    u64,
    u64,
);

type PageSnapshot = (String, u64, u64, u64, String, bool);
type PageBatchResponse = (Vec<PageSnapshot>, bool, bool);
type LayoutPageDirectorySnapshot = Vec<(String, u64, u64)>;
type HeadingOffsetSnapshot = (bool, Option<u64>);

#[tauri::command]
pub(crate) fn viewer_snapshot(
    document_state: tauri::State<'_, DocumentState>,
    run_log: tauri::State<'_, RunLog>,
) -> Result<ViewerSnapshot, String> {
    let tabs = document_state.tabs();
    if tabs.is_empty() {
        return Ok((
            tabs,
            None,
            String::new(),
            None,
            0.0,
            0,
            0,
            0,
            0,
            0,
            String::new(),
            0,
            0,
        ));
    }
    let active_path = document_state.active_path_display();
    let (page, recoverable_error, source_length, tab_id, tab_revision) =
        document_state.active_page().inspect_err(|_| {
            run_log.event("document-read-failed");
        })?;
    let estimated_page_count = document_state.active_estimated_layout_page_count();
    crate::agent_api::record_layout_page_viewport(
        page.source_start,
        page.source_end,
        source_length,
    );
    record_active_viewer_observations(&document_state);
    let (saved_scroll_position, saved_source_offset) = document_state.active_viewer_position();
    Ok((
        tabs,
        active_path,
        page.html().to_owned(),
        recoverable_error,
        saved_scroll_position,
        saved_source_offset,
        page.source_start,
        page.source_end,
        source_length,
        estimated_page_count,
        page.page_id_wire_value(),
        tab_id,
        tab_revision,
    ))
}

#[tauri::command]
pub(crate) fn viewer_page_batch(
    source_offset: u64,
    tab_id: u64,
    tab_revision: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<PageBatchResponse, String> {
    let (pages, index_complete, source_length) = match document_state
        .layout_page_window_for_active_viewer(source_offset, tab_id, tab_revision)
    {
        Ok(result) => result,
        Err(error) if error == STALE_VIEWER_REQUEST => return Ok((Vec::new(), true, false)),
        Err(error) if error == "the layout-page directory is still indexing" => {
            let queued = document_state.request_layout_page_for_active_viewer(
                app,
                source_offset,
                tab_id,
                tab_revision,
            )?;
            return Ok((Vec::new(), false, queued));
        }
        Err(error) => return Err(error),
    };
    record_active_viewer_observations(&document_state);
    if let Some(target) = pages
        .iter()
        .find(|page| page.source_start <= source_offset && source_offset < page.source_end)
    {
        crate::agent_api::record_layout_page_viewport(
            target.source_start,
            target.source_end,
            source_length,
        );
    }
    Ok((
        pages
            .into_iter()
            .map(|page| {
                (
                    page.html().to_owned(),
                    page.source_start,
                    page.source_end,
                    source_length,
                    page.page_id_wire_value(),
                    index_complete,
                )
            })
            .collect(),
        false,
        false,
    ))
}

#[tauri::command]
pub(crate) fn viewer_layout_page_directory(
    tab_id: u64,
    tab_revision: u64,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<LayoutPageDirectorySnapshot, String> {
    match document_state.active_layout_page_directory(tab_id, tab_revision) {
        Ok(directory) => {
            record_active_viewer_observations(&document_state);
            Ok(directory)
        }
        Err(error) if error == STALE_VIEWER_REQUEST => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn viewer_first_page_displayed(
    tab_id: u64,
    tab_revision: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<bool, String> {
    match document_state.first_page_displayed(app, tab_id, tab_revision) {
        Ok(queued) => Ok(queued),
        Err(error) if error == STALE_VIEWER_REQUEST => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn viewer_enrich_page(
    page_id: String,
    source_start: u64,
    source_end: u64,
    tab_id: u64,
    tab_revision: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<bool, String> {
    let page_id = page_id
        .parse()
        .map_err(|_| "the layout-page identity is invalid".to_owned())?;
    match document_state.queue_active_page_enrichment(
        app,
        page_id,
        source_start,
        source_end,
        tab_id,
        tab_revision,
    ) {
        Ok(queued) => Ok(queued),
        Err(error) if error == STALE_VIEWER_REQUEST => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn viewer_find_step(
    query: String,
    navigation_after: Option<u64>,
    tab_id: u64,
    tab_revision: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<bool, String> {
    match document_state.find_active(query, navigation_after, tab_id, tab_revision, app) {
        Ok(queued) => Ok(queued),
        Err(error) if error == STALE_VIEWER_REQUEST => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn viewer_find_next(
    query: String,
    after: Option<u64>,
    tab_id: u64,
    tab_revision: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<bool, String> {
    match document_state.find_next_active(query, after, tab_id, tab_revision, app) {
        Ok(queued) => Ok(queued),
        Err(error) if error == STALE_VIEWER_REQUEST => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn viewer_find_previous(
    query: String,
    before: Option<u64>,
    tab_id: u64,
    tab_revision: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<bool, String> {
    match document_state.find_previous_active(query, before, tab_id, tab_revision, app) {
        Ok(queued) => Ok(queued),
        Err(error) if error == STALE_VIEWER_REQUEST => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn viewer_heading_offset(
    identifier: String,
    tab_id: u64,
    tab_revision: u64,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<Option<HeadingOffsetSnapshot>, String> {
    let (offset, index_complete) =
        match document_state.request_heading_offset(identifier, tab_id, tab_revision) {
            Ok(result) => result,
            Err(error) if error == STALE_VIEWER_REQUEST => return Ok(None),
            Err(error) => return Err(error),
        };
    record_active_viewer_observations(&document_state);
    Ok(Some((index_complete, offset)))
}

#[tauri::command]
pub(crate) fn select_document_tab(
    tab_id: u64,
    scroll_position: f64,
    source_offset: u64,
    app: tauri::AppHandle,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<(), String> {
    document_state.save_active_viewer_position(scroll_position, source_offset);
    document_state.select_tab(tab_id)?;
    crate::document::update_window_title(&app)?;
    app.state::<RunLog>().event("document-tab-selected");
    Ok(())
}
