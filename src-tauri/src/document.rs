use crate::logging::RunLog;
use crate::{
    document_work::{
        CompletedEnrichment, CompletedFindNavigation, CompletedFindScan, CompletedIndex,
        CompletedPageRequest, DocumentTarget, DocumentWork, DocumentWorkCoordinator,
        DocumentWorkKind, DocumentWorkOutcome, EnrichmentTarget, FindDirection,
        FindNavigationTarget, FindTarget, PageRequestTarget,
    },
    layout_page_document::{LayoutPageDocument, PreparedLayoutPage},
    layout_page_limits::LayoutPageLimits,
};
use inotify::{Inotify, WatchMask};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, Manager};

pub(crate) const STALE_VIEWER_REQUEST: &str = "the viewer request is stale";
type EnrichmentCompletion = (u64, u64, u64, u64, String);
type PageRequestCompletion = (u64, u64, u64, u64);
type FindScanCompletion = (u64, u64, String, u64, Option<u64>);
type FindNavigationCompletion = (u64, u64, String, Option<u64>);

struct OpenDocument {
    id: u64,
    revision: u64,
    viewer: LayoutPageDocument,
    title: String,
    active_page: Option<PreparedLayoutPage>,
    scroll_position: f64,
    source_offset: u64,
    stale: bool,
    frozen_error: Option<String>,
    pending_anchor: Option<String>,
    index_requested_revision: Option<u64>,
    find_query: Option<String>,
}

fn complete_document_work(app: &tauri::AppHandle, outcome: DocumentWorkOutcome) {
    match outcome {
        DocumentWorkOutcome::CompletedPageRequest(completed) => {
            let lifecycle = completed
                .target
                .document
                .lifecycle(DocumentWorkKind::PageRequest);
            match app
                .state::<DocumentState>()
                .accept_completed_page_request(*completed)
            {
                Ok(Some((tab_id, tab_revision, source_start, source_end))) => {
                    crate::agent_api::record_document_work_lifecycle("accepted", lifecycle);
                    if app
                        .emit(
                            "viewer-priority-page-ready",
                            (tab_id, tab_revision, source_start, source_end),
                        )
                        .is_err()
                    {
                        app.state::<RunLog>()
                            .event("document-work-page-request-emit-failed");
                    }
                }
                Ok(None) => {
                    crate::agent_api::record_document_work_lifecycle("discarded", lifecycle)
                }
                Err(_) => crate::agent_api::record_document_work_lifecycle("failed", lifecycle),
            }
        }
        DocumentWorkOutcome::CompletedIndex(completed) => {
            let lifecycle_target = completed
                .target
                .lifecycle(crate::document_work::DocumentWorkKind::Index);
            match app
                .state::<DocumentState>()
                .accept_completed_index(*completed)
            {
                Ok(Some((tab_id, tab_revision, anchor_offset))) => {
                    crate::agent_api::record_document_work_lifecycle(
                        "accepted",
                        crate::document_work::WorkLifecycleTarget {
                            kind: crate::document_work::DocumentWorkKind::Index,
                            tab_id,
                            tab_revision,
                        },
                    );
                    if app
                        .emit(
                            "viewer-index-complete",
                            (tab_id, tab_revision, anchor_offset),
                        )
                        .is_err()
                    {
                        app.state::<RunLog>()
                            .event("document-work-index-emit-failed");
                    }
                }
                Ok(None) => {
                    crate::agent_api::record_document_work_lifecycle("discarded", lifecycle_target)
                }
                Err(_) => {
                    crate::agent_api::record_document_work_lifecycle("failed", lifecycle_target)
                }
            }
        }
        DocumentWorkOutcome::Cancelled(target) => {
            crate::agent_api::record_document_work_lifecycle("cancelled", target)
        }
        DocumentWorkOutcome::Failed(target) => {
            crate::agent_api::record_document_work_lifecycle("failed", target)
        }
        DocumentWorkOutcome::CompletedEnrichment(completed) => {
            let lifecycle = completed
                .target
                .document
                .lifecycle(DocumentWorkKind::Enrichment);
            match app
                .state::<DocumentState>()
                .accept_completed_enrichment(*completed)
            {
                Ok(Some((tab_id, tab_revision, source_start, source_end, html))) => {
                    crate::agent_api::record_document_work_lifecycle("accepted", lifecycle);
                    if app
                        .emit(
                            "viewer-page-enrichment-complete",
                            (tab_id, tab_revision, source_start, source_end, html),
                        )
                        .is_err()
                    {
                        app.state::<RunLog>()
                            .event("document-work-enrichment-emit-failed");
                    }
                }
                Ok(None) => {
                    crate::agent_api::record_document_work_lifecycle("discarded", lifecycle)
                }
                Err(_) => crate::agent_api::record_document_work_lifecycle("failed", lifecycle),
            }
        }
        DocumentWorkOutcome::CompletedFindScan(completed) => {
            let lifecycle = completed
                .target
                .document
                .lifecycle(DocumentWorkKind::FindScan);
            match app
                .state::<DocumentState>()
                .accept_completed_find_scan(completed)
            {
                Ok(Some((tab_id, tab_revision, query, match_count, next_match_offset))) => {
                    crate::agent_api::record_document_work_lifecycle("accepted", lifecycle);
                    let _ = app.emit(
                        "viewer-find-complete",
                        (tab_id, tab_revision, query, match_count, next_match_offset),
                    );
                }
                Ok(None) => {
                    crate::agent_api::record_document_work_lifecycle("discarded", lifecycle)
                }
                Err(_) => crate::agent_api::record_document_work_lifecycle("failed", lifecycle),
            }
        }
        DocumentWorkOutcome::CompletedFindNavigation(completed) => {
            let lifecycle = completed
                .target
                .document
                .lifecycle(DocumentWorkKind::FindNavigation);
            match app
                .state::<DocumentState>()
                .accept_completed_find_navigation(completed)
            {
                Ok(Some((tab_id, tab_revision, query, match_offset))) => {
                    crate::agent_api::record_document_work_lifecycle("accepted", lifecycle);
                    let _ = app.emit(
                        "viewer-find-navigation",
                        (tab_id, tab_revision, query, match_offset),
                    );
                }
                Ok(None) => {
                    crate::agent_api::record_document_work_lifecycle("discarded", lifecycle)
                }
                Err(_) => crate::agent_api::record_document_work_lifecycle("failed", lifecycle),
            }
        }
    }
}

#[derive(Default)]
struct DocumentSession {
    tabs: Vec<OpenDocument>,
    active_tab_id: Option<u64>,
    next_tab_id: u64,
    watch_generation: u64,
    watch_ready_generation: Option<u64>,
}

#[derive(Clone)]
struct DocumentWatchControl {
    path: PathBuf,
    run_log: RunLog,
}

fn active_viewer_tab(
    session: &mut DocumentSession,
    tab_id: u64,
    tab_revision: u64,
) -> Result<&mut OpenDocument, String> {
    if session.active_tab_id != Some(tab_id) {
        return Err(STALE_VIEWER_REQUEST.to_owned());
    }
    let tab = session
        .tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| STALE_VIEWER_REQUEST.to_owned())?;
    if tab.revision != tab_revision {
        return Err(STALE_VIEWER_REQUEST.to_owned());
    }
    Ok(tab)
}

fn document_target(tab: &OpenDocument) -> DocumentTarget {
    DocumentTarget {
        tab_id: tab.id,
        tab_revision: tab.revision,
        path: tab.viewer.path().to_path_buf(),
        identity: tab.viewer.source_identity(),
        limits: tab.viewer.limits(),
    }
}

#[derive(Clone)]
pub(crate) struct DocumentState {
    session: Arc<Mutex<DocumentSession>>,
    document_work: Arc<Mutex<Option<DocumentWorkCoordinator>>>,
    watch_control: Arc<Mutex<Option<DocumentWatchControl>>>,
}

impl Default for DocumentState {
    fn default() -> Self {
        Self {
            session: Arc::new(Mutex::new(DocumentSession::default())),
            document_work: Arc::new(Mutex::new(None)),
            watch_control: Arc::new(Mutex::new(None)),
        }
    }
}

impl DocumentState {
    pub(crate) fn current_path(&self) -> Option<PathBuf> {
        let session = self.session.lock().ok()?;
        let active_tab_id = session.active_tab_id?;
        session
            .tabs
            .iter()
            .find(|tab| tab.id == active_tab_id)
            .map(|tab| tab.viewer.path().to_path_buf())
    }

    pub(crate) fn active_path_display(&self) -> Option<String> {
        self.current_path()
            .map(|path| path.to_string_lossy().into_owned())
    }

    pub(crate) fn insert_initial_path(&self, path: PathBuf) -> Result<(), String> {
        let viewer = open_layout_page_document(path.clone())?;
        let inserted = if let Ok(mut session) = self.session.lock() {
            session.next_tab_id += 1;
            let tab_id = session.next_tab_id;
            session.tabs.push(OpenDocument {
                id: tab_id,
                revision: 0,
                title: document_title(&path),
                viewer,
                active_page: None,
                scroll_position: 0.0,
                source_offset: 0,
                stale: true,
                frozen_error: None,
                pending_anchor: None,
                index_requested_revision: None,
                find_query: None,
            });
            session.active_tab_id = Some(tab_id);
            session.watch_generation += 1;
            session.watch_ready_generation = None;
            true
        } else {
            false
        };
        if !inserted {
            return Err("the document session is unavailable".to_owned());
        }
        self.signal_watch_reconfiguration();
        Ok(())
    }

    fn open_path(&self, path: PathBuf) -> Result<(), String> {
        let path = canonical_document_path(path)?;
        let selection_changes = {
            let session = self
                .session
                .lock()
                .map_err(|_| "the document session is unavailable".to_owned())?;
            session
                .tabs
                .iter()
                .find(|tab| tab.viewer.path() == path)
                .is_none_or(|tab| session.active_tab_id != Some(tab.id))
        };
        if selection_changes {
            self.cancel_document_work();
        }
        let mut viewer = open_layout_page_document(path.clone())?;
        let active_page = viewer.initial_layout_page()?;
        let title = document_title(&path);
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        if let Some(existing_index) = session
            .tabs
            .iter()
            .position(|tab| tab.viewer.path() == path)
        {
            let existing_tab_id = session.tabs[existing_index].id;
            let selection_changed = session.active_tab_id != Some(existing_tab_id);
            if selection_changed {
                for tab in &mut session.tabs {
                    tab.pending_anchor = None;
                    tab.index_requested_revision = None;
                }
            }
            let tab = &mut session.tabs[existing_index];
            if tab.frozen_error.is_some() {
                tab.stale = true;
                tab.frozen_error = None;
            }
            session.active_tab_id = Some(existing_tab_id);
            return Ok(());
        }
        for tab in &mut session.tabs {
            tab.pending_anchor = None;
            tab.index_requested_revision = None;
        }
        session.next_tab_id += 1;
        let tab_id = session.next_tab_id;
        session.tabs.push(OpenDocument {
            id: tab_id,
            revision: 0,
            viewer,
            title,
            active_page: Some(active_page),
            scroll_position: 0.0,
            source_offset: 0,
            stale: false,
            frozen_error: None,
            pending_anchor: None,
            index_requested_revision: None,
            find_query: None,
        });
        session.active_tab_id = Some(tab_id);
        session.watch_generation += 1;
        session.watch_ready_generation = None;
        drop(session);
        self.signal_watch_reconfiguration();
        Ok(())
    }

    pub(crate) fn replace_active_path(&self, path: PathBuf) -> Result<(), String> {
        let path = canonical_document_path(path)?;
        if self.current_path().as_deref() == Some(path.as_path()) {
            return Ok(());
        }
        self.cancel_document_work();
        let mut viewer = open_layout_page_document(path.clone())?;
        let active_page = viewer.initial_layout_page()?;
        let title = document_title(&path);
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let active_tab_id = session
            .active_tab_id
            .ok_or_else(|| "there is no opened document for this link".to_owned())?;
        if let Some(existing_tab) = session
            .tabs
            .iter_mut()
            .find(|tab| tab.viewer.path() == path)
        {
            let existing_tab_id = existing_tab.id;
            if existing_tab.frozen_error.is_some() {
                existing_tab.stale = true;
                existing_tab.frozen_error = None;
            }
            if existing_tab_id != active_tab_id {
                session.tabs.retain(|tab| tab.id != active_tab_id);
                session.active_tab_id = Some(existing_tab_id);
                session.watch_generation += 1;
                session.watch_ready_generation = None;
                drop(session);
                self.signal_watch_reconfiguration();
            }
            return Ok(());
        }
        let tab = session
            .tabs
            .iter_mut()
            .find(|tab| tab.id == active_tab_id)
            .ok_or_else(|| "the active document is unavailable".to_owned())?;
        tab.viewer = viewer;
        tab.revision = tab.revision.saturating_add(1);
        tab.title = title;
        tab.active_page = Some(active_page);
        tab.scroll_position = 0.0;
        tab.source_offset = 0;
        tab.stale = false;
        tab.frozen_error = None;
        tab.pending_anchor = None;
        tab.index_requested_revision = None;
        session.watch_generation += 1;
        session.watch_ready_generation = None;
        drop(session);
        self.signal_watch_reconfiguration();
        Ok(())
    }

    pub(crate) fn select_tab(&self, tab_id: u64) -> Result<(), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        if !session.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err("the selected tab is unavailable".to_owned());
        }
        let selection_changed = session.active_tab_id != Some(tab_id);
        if selection_changed {
            for tab in &mut session.tabs {
                tab.pending_anchor = None;
                tab.index_requested_revision = None;
            }
        }
        session.active_tab_id = Some(tab_id);
        drop(session);
        if selection_changed {
            self.cancel_document_work();
        }
        Ok(())
    }

    pub(crate) fn close_tabs(&self, tab_id: u64, action: &str) -> Result<(), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let index = session
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| "the selected tab is unavailable".to_owned())?;
        let active_tab_id = session.active_tab_id;
        match action {
            "tab" => {
                session.tabs.remove(index);
                if !session.tabs.iter().any(|tab| Some(tab.id) == active_tab_id) {
                    session.active_tab_id = session
                        .tabs
                        .get(index)
                        .or_else(|| session.tabs.last())
                        .map(|tab| tab.id);
                }
            }
            "other" => {
                session.tabs = vec![session.tabs.remove(index)];
                session.active_tab_id = Some(tab_id);
            }
            "right" => {
                session.tabs.truncate(index + 1);
                session.active_tab_id = Some(tab_id);
            }
            "left" => {
                session.tabs.drain(..index);
                session.active_tab_id = Some(tab_id);
            }
            _ => return Err("the requested tab action is unsupported".to_owned()),
        }
        session.watch_generation += 1;
        session.watch_ready_generation = None;
        drop(session);
        self.signal_watch_reconfiguration();
        self.cancel_document_work();
        Ok(())
    }

    pub(crate) fn tabs(&self) -> Vec<(u64, String, bool)> {
        let Ok(session) = self.session.lock() else {
            return Vec::new();
        };
        session
            .tabs
            .iter()
            .map(|tab| {
                (
                    tab.id,
                    tab.title.clone(),
                    Some(tab.id) == session.active_tab_id,
                )
            })
            .collect()
    }

    pub(crate) fn active_page(
        &self,
    ) -> Result<(PreparedLayoutPage, Option<String>, u64, u64, u64), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let active_tab_id = session
            .active_tab_id
            .ok_or_else(|| "there is no opened document".to_owned())?;
        let tab = session
            .tabs
            .iter_mut()
            .find(|tab| tab.id == active_tab_id)
            .ok_or_else(|| "the active document is unavailable".to_owned())?;
        let previous_page = tab.active_page.clone();
        if tab.stale {
            if let Some(error) = &tab.frozen_error {
                return previous_page.map_or_else(
                    || Err(error.clone()),
                    |prepared_page| {
                        Ok((
                            prepared_page,
                            Some(error.clone()),
                            tab.viewer.length(),
                            tab.id,
                            tab.revision,
                        ))
                    },
                );
            }
            let mut viewer = match open_layout_page_document(tab.viewer.path().to_path_buf()) {
                Ok(viewer) => viewer,
                Err(error) => match &previous_page {
                    Some(page) => {
                        tab.frozen_error = Some(error.clone());
                        return Ok((
                            page.clone(),
                            Some(error),
                            tab.viewer.length(),
                            tab.id,
                            tab.revision,
                        ));
                    }
                    None => return Err(error),
                },
            };
            let page = match viewer.initial_layout_page() {
                Ok(page) => page,
                Err(error) => match &previous_page {
                    Some(page) => {
                        tab.frozen_error = Some(error.clone());
                        return Ok((
                            page.clone(),
                            Some(error),
                            tab.viewer.length(),
                            tab.id,
                            tab.revision,
                        ));
                    }
                    None => return Err(error),
                },
            };
            tab.viewer = viewer;
            tab.active_page = Some(page);
            tab.stale = false;
            tab.frozen_error = None;
            tab.revision = tab.revision.saturating_add(1);
        }
        let page = match &tab.active_page {
            Some(page) => page.clone(),
            None => {
                let page = tab.viewer.initial_layout_page()?;
                tab.active_page = Some(page.clone());
                page
            }
        };
        Ok((page, None, tab.viewer.length(), tab.id, tab.revision))
    }

    pub(crate) fn active_estimated_layout_page_count(&self) -> u64 {
        let Ok(session) = self.session.lock() else {
            return 0;
        };
        let Some(active_tab_id) = session.active_tab_id else {
            return 0;
        };
        session
            .tabs
            .iter()
            .find(|tab| tab.id == active_tab_id)
            .map_or(0, |tab| tab.viewer.estimated_layout_page_count())
    }

    pub(crate) fn active_viewer_position(&self) -> (f64, u64) {
        let Ok(session) = self.session.lock() else {
            return (0.0, 0);
        };
        let Some(active_tab_id) = session.active_tab_id else {
            return (0.0, 0);
        };
        session
            .tabs
            .iter()
            .find(|tab| tab.id == active_tab_id)
            .map(|tab| (tab.scroll_position, tab.source_offset))
            .unwrap_or((0.0, 0))
    }

    pub(crate) fn layout_page_window_for_active_viewer(
        &self,
        source_offset: u64,
        tab_id: u64,
        tab_revision: u64,
    ) -> Result<(Vec<PreparedLayoutPage>, bool, u64), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
        let pages = tab
            .viewer
            .layout_page_window_for_source_offset(source_offset)?;
        if let Some(page) = pages
            .iter()
            .find(|page| page.source_start <= source_offset && source_offset < page.source_end)
        {
            tab.active_page = Some(page.clone());
        }
        Ok((pages, tab.viewer.index_is_complete(), tab.viewer.length()))
    }

    pub(crate) fn request_layout_page_for_active_viewer(
        &self,
        app: tauri::AppHandle,
        source_offset: u64,
        tab_id: u64,
        tab_revision: u64,
    ) -> Result<bool, String> {
        let target = {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "the document session is unavailable".to_owned())?;
            let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
            if tab.viewer.index_is_complete()
                || tab
                    .viewer
                    .layout_page_window_for_source_offset(source_offset)
                    .is_ok()
            {
                return Ok(false);
            }
            PageRequestTarget::new(document_target(tab), source_offset)
        };
        self.submit_document_work(app, DocumentWork::PreparePage(target))
    }

    pub(crate) fn active_layout_page_directory(
        &self,
        tab_id: u64,
        tab_revision: u64,
    ) -> Result<Vec<(String, u64, u64)>, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
        if !tab.viewer.index_is_complete() {
            return Ok(Vec::new());
        }
        Ok(tab.viewer.layout_page_directory_snapshot())
    }

    pub(crate) fn queue_active_page_enrichment(
        &self,
        app: tauri::AppHandle,
        page_id: crate::layout_page::LayoutPageId,
        source_start: u64,
        source_end: u64,
        tab_id: u64,
        tab_revision: u64,
    ) -> Result<bool, String> {
        let work = {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "the document session is unavailable".to_owned())?;
            let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
            let Some(page) = tab
                .viewer
                .prepared_layout_page(page_id, source_start, source_end)
            else {
                return Ok(false);
            };
            let (definition_generation, definitions) = tab.viewer.definition_snapshot();
            DocumentWork::EnrichPage(Box::new(EnrichmentTarget {
                document: document_target(tab),
                page_id: page.page_id(),
                source_start,
                source_end,
                context_before: page.context_before(),
                context_after: page.context_after(),
                definition_generation,
                definitions,
            }))
        };
        self.submit_document_work(app, work)
    }

    pub(crate) fn find_active(
        &self,
        query: String,
        navigation_after: Option<u64>,
        tab_id: u64,
        tab_revision: u64,
        app: tauri::AppHandle,
    ) -> Result<bool, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
        let query = query.trim().to_owned();
        tab.find_query = Some(query.clone());
        let work = DocumentWork::ScanFind(FindTarget {
            document: document_target(tab),
            query,
            navigation_after,
        });
        drop(session);
        self.cancel_document_work_kind(DocumentWorkKind::FindNavigation);
        self.submit_document_work(app, work)
    }

    pub(crate) fn find_next_active(
        &self,
        query: String,
        after: Option<u64>,
        tab_id: u64,
        tab_revision: u64,
        app: tauri::AppHandle,
    ) -> Result<bool, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
        let work = DocumentWork::NavigateFind(FindNavigationTarget {
            document: document_target(tab),
            query: query.trim().to_owned(),
            position: after,
            direction: FindDirection::Next,
        });
        drop(session);
        self.submit_document_work(app, work)
    }

    pub(crate) fn find_previous_active(
        &self,
        query: String,
        before: Option<u64>,
        tab_id: u64,
        tab_revision: u64,
        app: tauri::AppHandle,
    ) -> Result<bool, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
        let work = DocumentWork::NavigateFind(FindNavigationTarget {
            document: document_target(tab),
            query: query.trim().to_owned(),
            position: before,
            direction: FindDirection::Previous,
        });
        drop(session);
        self.submit_document_work(app, work)
    }

    pub(crate) fn request_heading_offset(
        &self,
        identifier: String,
        tab_id: u64,
        tab_revision: u64,
    ) -> Result<(Option<u64>, bool), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
        let (offset, index_complete) = tab.viewer.heading_offset(&identifier)?;
        if !index_complete {
            tab.pending_anchor = Some(identifier);
        }
        Ok((offset, index_complete))
    }

    pub(crate) fn save_active_viewer_position(&self, scroll_position: f64, source_offset: u64) {
        let Ok(mut session) = self.session.lock() else {
            return;
        };
        let Some(active_tab_id) = session.active_tab_id else {
            return;
        };
        if let Some(tab) = session.tabs.iter_mut().find(|tab| tab.id == active_tab_id) {
            tab.scroll_position = scroll_position.max(0.0);
            tab.source_offset = source_offset;
        }
    }

    pub(crate) fn save_viewer_position(
        &self,
        tab_id: u64,
        tab_revision: u64,
        scroll_position: f64,
        source_offset: u64,
    ) -> Result<bool, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let Ok(tab) = active_viewer_tab(&mut session, tab_id, tab_revision) else {
            return Ok(false);
        };
        tab.scroll_position = scroll_position.max(0.0);
        tab.source_offset = source_offset;
        Ok(true)
    }

    fn watch_snapshot(&self) -> (u64, Vec<PathBuf>) {
        let Ok(session) = self.session.lock() else {
            return (0, Vec::new());
        };
        let mut directories = Vec::new();
        for tab in &session.tabs {
            let directory = tab
                .viewer
                .path()
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf();
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
        (session.watch_generation, directories)
    }

    fn install_watch_control(&self, control: DocumentWatchControl) {
        let Ok(mut watch_control) = self.watch_control.lock() else {
            return;
        };
        *watch_control = Some(control);
    }

    fn signal_watch_reconfiguration(&self) {
        let Ok(watch_control) = self.watch_control.lock() else {
            return;
        };
        let Some(control) = watch_control.as_ref() else {
            return;
        };
        if fs::write(&control.path, []).is_err() {
            control.run_log.event("watcher-reconfigure-signal-failed");
        }
    }

    fn mark_watch_ready(&self, generation: u64, ready: bool) {
        let Ok(mut session) = self.session.lock() else {
            return;
        };
        if session.watch_generation == generation {
            session.watch_ready_generation = ready.then_some(generation);
        }
    }

    #[cfg(debug_assertions)]
    pub(crate) fn agent_watcher_ready(&self) -> bool {
        let Ok(session) = self.session.lock() else {
            return false;
        };
        session.watch_ready_generation == Some(session.watch_generation)
    }

    fn mark_path_stale(&self, path: &Path) -> bool {
        let Ok(mut session) = self.session.lock() else {
            return false;
        };
        let active_tab_id = session.active_tab_id;
        let mut active_changed = false;
        let mut changed = false;
        for tab in &mut session.tabs {
            if tab.viewer.path() == path {
                tab.stale = true;
                tab.pending_anchor = None;
                tab.index_requested_revision = None;
                active_changed |= Some(tab.id) == active_tab_id;
                changed = true;
            }
        }
        drop(session);
        if changed {
            self.cancel_document_work();
        }
        active_changed
    }

    pub(crate) fn mark_active_stale(&self) {
        let Ok(mut session) = self.session.lock() else {
            return;
        };
        let Some(active_tab_id) = session.active_tab_id else {
            return;
        };
        if let Some(tab) = session.tabs.iter_mut().find(|tab| tab.id == active_tab_id) {
            tab.stale = true;
            tab.frozen_error = None;
            tab.pending_anchor = None;
            tab.index_requested_revision = None;
        }
        drop(session);
        self.cancel_document_work();
    }

    pub(crate) fn first_page_displayed(
        &self,
        app: tauri::AppHandle,
        tab_id: u64,
        tab_revision: u64,
    ) -> Result<bool, String> {
        let target = {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "the document session is unavailable".to_owned())?;
            let tab = active_viewer_tab(&mut session, tab_id, tab_revision)?;
            if tab.viewer.index_is_complete() || tab.index_requested_revision == Some(tab_revision)
            {
                return Ok(false);
            }
            tab.index_requested_revision = Some(tab_revision);
            DocumentTarget {
                tab_id,
                tab_revision,
                path: tab.viewer.path().to_path_buf(),
                identity: tab.viewer.source_identity(),
                limits: tab.viewer.limits(),
            }
        };
        self.submit_document_work(app, DocumentWork::BuildIndex(target))
    }

    fn document_work_coordinator(
        &self,
        app: tauri::AppHandle,
    ) -> Result<DocumentWorkCoordinator, String> {
        let mut coordinator = self
            .document_work
            .lock()
            .map_err(|_| "the document-work coordinator is unavailable".to_owned())?;
        if coordinator.is_none() {
            let delivery_app = app.clone();
            *coordinator = Some(DocumentWorkCoordinator::new(move |outcome| {
                let app = delivery_app.clone();
                let completion_app = app.clone();
                let _ = app.run_on_main_thread(move || {
                    complete_document_work(&completion_app, outcome);
                });
            }));
        }
        coordinator
            .as_ref()
            .cloned()
            .ok_or_else(|| "the document-work coordinator is unavailable".to_owned())
    }

    fn submit_document_work(
        &self,
        app: tauri::AppHandle,
        work: DocumentWork,
    ) -> Result<bool, String> {
        let lifecycle = work.lifecycle();
        let coordinator = self.document_work_coordinator(app)?;
        if let Some(cancelled) = coordinator.submit(work) {
            crate::agent_api::record_document_work_lifecycle("cancelled", cancelled);
        }
        crate::agent_api::record_document_work_lifecycle("queued", lifecycle);
        Ok(true)
    }

    fn cancel_document_work(&self) {
        let Ok(coordinator) = self.document_work.lock() else {
            return;
        };
        if let Some(coordinator) = coordinator.as_ref() {
            for cancelled in coordinator.cancel_all() {
                crate::agent_api::record_document_work_lifecycle("cancelled", cancelled);
            }
        }
    }

    fn cancel_document_work_kind(&self, kind: DocumentWorkKind) {
        let Ok(coordinator) = self.document_work.lock() else {
            return;
        };
        if let Some(coordinator) = coordinator.as_ref()
            && let Some(cancelled) = coordinator.cancel_kind(kind)
        {
            crate::agent_api::record_document_work_lifecycle("cancelled", cancelled);
        }
    }

    pub(crate) fn shutdown_document_work(&self) {
        let Ok(mut coordinator) = self.document_work.lock() else {
            return;
        };
        if let Some(coordinator) = coordinator.take() {
            coordinator.shutdown();
        }
    }

    pub(crate) fn remove_watch_control(&self) {
        let Ok(mut watch_control) = self.watch_control.lock() else {
            return;
        };
        let Some(control) = watch_control.take() else {
            return;
        };
        if let Err(error) = fs::remove_file(&control.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            control.run_log.event("watcher-control-cleanup-failed");
        }
    }

    #[cfg(test)]
    fn document_work_worker_created(&self) -> bool {
        self.document_work
            .lock()
            .map(|coordinator| coordinator.is_some())
            .unwrap_or(false)
    }

    fn accept_completed_index(
        &self,
        completed: CompletedIndex,
    ) -> Result<Option<(u64, u64, Option<u64>)>, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        if session.active_tab_id != Some(completed.target.tab_id) {
            return Ok(None);
        }
        let Some(tab) = session
            .tabs
            .iter_mut()
            .find(|tab| tab.id == completed.target.tab_id)
        else {
            return Ok(None);
        };
        if tab.revision != completed.target.tab_revision
            || tab.viewer.path() != completed.target.path
        {
            return Ok(None);
        }
        if !tab
            .viewer
            .adopt_completed_index(completed.target.identity, completed.index)?
        {
            return Ok(None);
        }
        let anchor_offset = tab.pending_anchor.take().and_then(|anchor| {
            tab.viewer
                .heading_offset(&anchor)
                .ok()
                .and_then(|(offset, _)| offset)
        });
        Ok(Some((tab.id, tab.revision, anchor_offset)))
    }

    fn accept_completed_page_request(
        &self,
        completed: CompletedPageRequest,
    ) -> Result<Option<PageRequestCompletion>, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        if session.active_tab_id != Some(completed.target.document.tab_id) {
            return Ok(None);
        }
        let Some(tab) = session
            .tabs
            .iter_mut()
            .find(|tab| tab.id == completed.target.document.tab_id)
        else {
            return Ok(None);
        };
        if tab.revision != completed.target.document.tab_revision
            || tab.viewer.path() != completed.target.document.path
            || tab.viewer.source_identity() != completed.target.document.identity
        {
            return Ok(None);
        }
        let prepared_page = tab.viewer.accept_prepared_layout_page(
            completed.page,
            completed.context_before,
            completed.rendered,
        )?;
        tab.active_page = Some(prepared_page.clone());
        Ok(Some((
            tab.id,
            tab.revision,
            prepared_page.source_start,
            prepared_page.source_end,
        )))
    }

    fn accept_completed_enrichment(
        &self,
        completed: CompletedEnrichment,
    ) -> Result<Option<EnrichmentCompletion>, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let target = &completed.target;
        if session.active_tab_id != Some(target.document.tab_id) {
            return Ok(None);
        }
        let Some(tab) = session
            .tabs
            .iter_mut()
            .find(|tab| tab.id == target.document.tab_id)
        else {
            return Ok(None);
        };
        if tab.revision != target.document.tab_revision
            || tab.viewer.path() != target.document.path
            || tab.viewer.source_identity() != target.document.identity
        {
            return Ok(None);
        }
        let Some(prepared_page) = tab.viewer.accept_enrichment(
            target.page_id,
            target.source_start,
            target.source_end,
            target.definition_generation,
            completed.html,
        )?
        else {
            return Ok(None);
        };
        tab.active_page = Some(prepared_page.clone());
        Ok(Some((
            tab.id,
            tab.revision,
            prepared_page.source_start,
            prepared_page.source_end,
            prepared_page.html().to_owned(),
        )))
    }

    fn accept_completed_find_scan(
        &self,
        completed: CompletedFindScan,
    ) -> Result<Option<FindScanCompletion>, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let target = completed.target;
        if session.active_tab_id != Some(target.document.tab_id) {
            return Ok(None);
        }
        let Some(tab) = session
            .tabs
            .iter()
            .find(|tab| tab.id == target.document.tab_id)
        else {
            return Ok(None);
        };
        if tab.revision != target.document.tab_revision
            || tab.viewer.path() != target.document.path
            || tab.viewer.source_identity() != target.document.identity
            || tab.find_query.as_deref() != Some(target.query.as_str())
        {
            return Ok(None);
        }
        Ok(Some((
            tab.id,
            tab.revision,
            target.query,
            completed.progress.match_count,
            completed.progress.next_match_offset,
        )))
    }

    fn accept_completed_find_navigation(
        &self,
        completed: CompletedFindNavigation,
    ) -> Result<Option<FindNavigationCompletion>, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "the document session is unavailable".to_owned())?;
        let target = completed.target;
        if session.active_tab_id != Some(target.document.tab_id) {
            return Ok(None);
        }
        let Some(tab) = session
            .tabs
            .iter()
            .find(|tab| tab.id == target.document.tab_id)
        else {
            return Ok(None);
        };
        if tab.revision != target.document.tab_revision
            || tab.viewer.path() != target.document.path
            || tab.viewer.source_identity() != target.document.identity
            || tab.find_query.as_deref() != Some(target.query.as_str())
        {
            return Ok(None);
        }
        Ok(Some((
            tab.id,
            tab.revision,
            target.query,
            completed.progress.match_offset,
        )))
    }

    #[cfg(debug_assertions)]
    fn agent_tabs(&self) -> Vec<(u64, u64, bool, bool, bool, f64, u64)> {
        let Ok(session) = self.session.lock() else {
            return Vec::new();
        };
        session
            .tabs
            .iter()
            .map(|tab| {
                (
                    tab.id,
                    tab.revision,
                    Some(tab.id) == session.active_tab_id,
                    tab.stale,
                    tab.frozen_error.is_some(),
                    tab.scroll_position,
                    tab.source_offset,
                )
            })
            .collect()
    }

    #[cfg(debug_assertions)]
    fn active_viewer_observation_counts(&self) -> Option<(u64, u64, u64, u64, u64, u64, u64)> {
        let session = self.session.lock().ok()?;
        let active_tab_id = session.active_tab_id?;
        session
            .tabs
            .iter()
            .find(|tab| tab.id == active_tab_id)
            .map(|tab| tab.viewer.agent_observation_counts())
    }
}

#[cfg(debug_assertions)]
pub(crate) fn record_active_viewer_observations(document_state: &DocumentState) {
    let Some((
        indexed_through,
        checkpoint_count,
        index_bytes,
        source_cache_bytes,
        directory_page_count,
        prepared_page_count,
        prepared_html_bytes,
    )) = document_state.active_viewer_observation_counts()
    else {
        crate::agent_api::record_layout_page_viewport(0, 0, 0);
        crate::agent_api::record_layout_page_resource_counts(0, 0, 0, 0, 0, 0, 0);
        return;
    };
    crate::agent_api::record_layout_page_resource_counts(
        indexed_through,
        checkpoint_count,
        index_bytes,
        source_cache_bytes,
        directory_page_count,
        prepared_page_count,
        prepared_html_bytes,
    );
}

#[cfg(not(debug_assertions))]
pub(crate) fn record_active_viewer_observations(_document_state: &DocumentState) {}

pub(crate) fn initial_path() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let mut arguments = env::args_os().skip(1);
    #[cfg(not(debug_assertions))]
    let mut arguments = env::args_os().skip(1);
    #[cfg(debug_assertions)]
    while let Some(argument) = arguments.next() {
        if argument == "--agent-socket" {
            let _ = arguments.next();
            continue;
        }
        if argument == "--test-input-guard" {
            continue;
        }
        let path = PathBuf::from(argument);
        if path.is_absolute() {
            return Some(path);
        }
        return Some(env::current_dir().ok()?.join(path));
    }
    #[cfg(debug_assertions)]
    {
        None
    }
    #[cfg(not(debug_assertions))]
    {
        let path = PathBuf::from(arguments.next()?);
        if path.is_absolute() {
            Some(path)
        } else {
            Some(env::current_dir().ok()?.join(path))
        }
    }
}

pub(crate) fn watch_open_documents(
    app: tauri::AppHandle,
    run_log: RunLog,
    document_state: DocumentState,
) -> std::io::Result<()> {
    let control_path = watcher_control_path()?;
    fs::write(&control_path, [])?;
    document_state.install_watch_control(DocumentWatchControl {
        path: control_path.clone(),
        run_log: run_log.clone(),
    });
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            let (generation, directories) = document_state.watch_snapshot();
            let Ok(mut watcher) = Inotify::init() else {
                run_log.event("watcher-setup-failed");
                return;
            };
            let Ok(control_descriptor) =
                watcher.watches().add(&control_path, WatchMask::CLOSE_WRITE)
            else {
                run_log.event("watcher-setup-failed");
                return;
            };
            let mut watched_directories = HashMap::new();
            let mut setup_complete = true;
            for directory in directories {
                match watcher.watches().add(
                    &directory,
                    WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO | WatchMask::DELETE,
                ) {
                    Ok(descriptor) => {
                        watched_directories.insert(descriptor, directory);
                    }
                    Err(_) => {
                        setup_complete = false;
                        run_log.event("watcher-setup-failed");
                    }
                }
            }
            document_state.mark_watch_ready(generation, setup_complete);
            #[cfg(debug_assertions)]
            if setup_complete {
                let _ = app.emit("agent-watcher-ready", ());
            }
            if document_state.watch_snapshot().0 != generation {
                continue;
            }
            loop {
                let events = match watcher.read_events_blocking(&mut buffer) {
                    Ok(events) => events,
                    Err(_) => {
                        run_log.event("watcher-read-failed");
                        return;
                    }
                };
                let mut reconfigure = false;
                for event in events {
                    if event.wd == control_descriptor {
                        reconfigure = true;
                        continue;
                    }
                    let Some(directory) = watched_directories.get(&event.wd) else {
                        continue;
                    };
                    let Some(name) = event.name else {
                        continue;
                    };
                    if document_state.mark_path_stale(&directory.join(name))
                        && let Err(error) = app.emit("markdown-file-changed", ())
                    {
                        run_log.event("watcher-emit-failed");
                        eprintln!("failed to emit Markdown file change event: {error}");
                    }
                }
                if reconfigure || document_state.watch_snapshot().0 != generation {
                    break;
                }
            }
        }
    });
    Ok(())
}

fn watcher_control_path() -> std::io::Result<PathBuf> {
    let runtime_directory = env::var_os("XDG_RUNTIME_DIR").ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Lumen runtime directory is unavailable",
        )
    })?;
    let directory = PathBuf::from(runtime_directory).join("lumen");
    fs::create_dir_all(&directory)?;
    Ok(directory.join("document-watch.signal"))
}

fn canonical_document_path(path: PathBuf) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("failed to access {}: {error}", path.display()))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("failed to access {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err("the selected path is not a file".to_owned());
    }
    Ok(path)
}

pub(crate) fn allow_document_assets(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let document_directory = path.parent().ok_or_else(|| {
        format!(
            "failed to grant local image access because {} has no parent directory",
            path.display()
        )
    })?;
    app.asset_protocol_scope()
        .allow_directory(document_directory, true)
        .map_err(|error| format!("failed to grant local image access: {error}"))
}

fn open_layout_page_document(path: PathBuf) -> Result<LayoutPageDocument, String> {
    LayoutPageDocument::open(path, LayoutPageLimits::default())
}

fn document_title(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled document")
        .to_owned()
}

pub(crate) fn window_title() -> String {
    "Lumen".to_owned()
}

pub(crate) fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mdown" | "mkdn")
    )
}

pub(crate) fn select(
    app: &tauri::AppHandle,
    path: PathBuf,
    emit_document_opened: bool,
) -> Result<(), String> {
    let document_state = app.state::<DocumentState>().inner().clone();
    let path = canonical_document_path(path)?;
    allow_document_assets(app, &path)?;
    document_state.open_path(path)?;
    update_window_title(app)?;
    if emit_document_opened && let Err(error) = app.emit("viewer-document-opened", ()) {
        app.state::<RunLog>().event("document-open-emit-failed");
        return Err(format!("failed to display the selected document: {error}"));
    }
    app.state::<RunLog>().event("document-selected");
    Ok(())
}

#[tauri::command]
pub(crate) fn save_document_viewer_position(
    tab_id: u64,
    tab_revision: u64,
    scroll_position: f64,
    source_offset: u64,
    document_state: tauri::State<'_, DocumentState>,
) -> Result<bool, String> {
    document_state.save_viewer_position(tab_id, tab_revision, scroll_position, source_offset)
}

pub(crate) fn replace_active(
    app: &tauri::AppHandle,
    path: PathBuf,
    emit_document_opened: bool,
) -> Result<(), String> {
    let document_state = app.state::<DocumentState>().inner().clone();
    let path = canonical_document_path(path)?;
    allow_document_assets(app, &path)?;
    if document_state.current_path().is_some() {
        document_state.replace_active_path(path)?;
    } else {
        document_state.open_path(path)?;
    }
    update_window_title(app)?;
    if emit_document_opened && let Err(error) = app.emit("viewer-document-opened", ()) {
        app.state::<RunLog>().event("document-open-emit-failed");
        return Err(format!("failed to display the selected document: {error}"));
    }
    app.state::<RunLog>().event("document-replaced");
    Ok(())
}

pub(crate) fn update_window_title(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_title(&window_title())
            .map_err(|error| format!("failed to update the window title: {error}"))?;
    }
    Ok(())
}

pub(crate) fn reload_active(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<DocumentState>().mark_active_stale();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is unavailable".to_owned())?;
    window
        .emit("viewer-reload", ())
        .map_err(|error| format!("failed to request a Markdown reload: {error}"))?;
    app.state::<RunLog>().event("viewer-reload-requested");
    Ok(())
}

#[cfg(debug_assertions)]
pub(crate) fn agent_tabs(app: &tauri::AppHandle) -> Vec<(u64, u64, bool, bool, bool, f64, u64)> {
    app.state::<DocumentState>().agent_tabs()
}

#[cfg(debug_assertions)]
#[tauri::command]
pub(crate) fn agent_watcher_ready(document_state: tauri::State<'_, DocumentState>) -> bool {
    document_state.agent_watcher_ready()
}

#[cfg(test)]
mod tests {
    use super::{DocumentState, STALE_VIEWER_REQUEST};
    use crate::{
        document_index::DocumentIndex,
        document_source::DocumentSource,
        document_work::{CompletedIndex, DocumentTarget},
        layout_page_limits::LayoutPageLimits,
    };
    use std::{env, fs, path::PathBuf, time::SystemTime};

    fn test_directory() -> PathBuf {
        env::temp_dir().join(format!(
            "lumen-document-session-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ))
    }

    fn completed_index(path: PathBuf, tab_id: u64, tab_revision: u64) -> CompletedIndex {
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 16,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let identity = source.identity();
        let mut index = DocumentIndex::new(limits);
        while !index.scan_step(&mut source).unwrap() {}
        CompletedIndex {
            target: DocumentTarget {
                tab_id,
                tab_revision,
                path,
                identity,
                limits,
            },
            index,
        }
    }

    #[test]
    fn does_not_create_a_document_work_worker_before_first_display_acknowledgement() {
        let directory = test_directory();
        let path = directory.join("lazy.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "# Lazy\n").unwrap();
        let state = DocumentState::default();
        state.open_path(path).unwrap();
        let _ = state.active_page().unwrap();
        let worker_created = state.document_work_worker_created();
        fs::remove_dir_all(directory).unwrap();

        assert!(!worker_created);
    }

    #[test]
    fn accepts_a_completed_index_and_resolves_one_pending_anchor() {
        let directory = test_directory();
        let path = directory.join("anchor.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "Opening paragraph.\n\n# Late heading\n").unwrap();
        let state = DocumentState::default();
        state.open_path(path.clone()).unwrap();
        let (_, _, _, tab_id, tab_revision) = state.active_page().unwrap();

        assert_eq!(
            state
                .request_heading_offset("late-heading".to_owned(), tab_id, tab_revision)
                .unwrap(),
            (None, false)
        );
        let accepted = state
            .accept_completed_index(completed_index(path.clone(), tab_id, tab_revision))
            .unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(accepted, Some((tab_id, tab_revision, Some(20))));
    }

    #[test]
    fn discards_a_completed_index_after_tab_selection_changes() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First\n").unwrap();
        fs::write(&second_path, "# Second\n").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path.clone()).unwrap();
        let (_, _, _, tab_id, tab_revision) = state.active_page().unwrap();
        let result = completed_index(first_path, tab_id, tab_revision);
        state.open_path(second_path).unwrap();

        let accepted = state.accept_completed_index(result).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert!(accepted.is_none());
    }

    #[test]
    fn rejects_a_same_length_replacement_before_completed_index_adoption() {
        let directory = test_directory();
        let path = directory.join("changed.md");
        let replacement = directory.join("replacement.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "# Before\n").unwrap();
        let state = DocumentState::default();
        state.open_path(path.clone()).unwrap();
        let (_, _, _, tab_id, tab_revision) = state.active_page().unwrap();
        let rendered_before = state.active_page().unwrap().0.html().to_owned();
        let result = completed_index(path.clone(), tab_id, tab_revision);
        fs::write(&replacement, "# After!\n").unwrap();
        fs::rename(&replacement, &path).unwrap();

        let error = state.accept_completed_index(result).unwrap_err();
        let rendered_after = state.active_page().unwrap().0.html().to_owned();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(error, "the document changed while it was being read");
        assert_eq!(rendered_after, rendered_before);
    }

    #[test]
    fn keeps_cached_rendering_for_a_deleted_open_document() {
        let directory = test_directory();
        let path = directory.join("cached.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "# Cached document").unwrap();
        let state = DocumentState::default();
        state.open_path(path.clone()).unwrap();
        let (page, error, _, _, _) = state.active_page().unwrap();
        let rendered_html = page.html().to_owned();
        assert!(error.is_none());
        assert!(rendered_html.contains("Cached document"));

        fs::remove_file(&path).unwrap();
        assert!(state.mark_path_stale(&path));
        let (cached_page, error, _, _, _) = state.active_page().unwrap();
        let cached_html = cached_page.html().to_owned();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(cached_html, rendered_html);
        assert!(error.unwrap().starts_with("failed to read"));
    }

    #[test]
    fn requires_an_explicit_reload_after_a_deleted_document_reappears() {
        let directory = test_directory();
        let path = directory.join("reappearing.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "# Before deletion\n").unwrap();
        let state = DocumentState::default();
        state.open_path(path.clone()).unwrap();
        let (_, _, _, _, revision_before) = state.active_page().unwrap();

        fs::remove_file(&path).unwrap();
        assert!(state.mark_path_stale(&path));
        let (cached_page, error, _, _, frozen_revision) = state.active_page().unwrap();
        assert!(cached_page.html().contains("Before deletion"));
        assert!(error.is_some());
        assert_eq!(frozen_revision, revision_before);

        fs::write(&path, "# After restoration\n").unwrap();
        assert!(state.mark_path_stale(&path));
        let (still_cached, error, _, _, still_frozen_revision) = state.active_page().unwrap();
        assert!(still_cached.html().contains("Before deletion"));
        assert!(error.is_some());
        assert_eq!(still_frozen_revision, revision_before);

        state.mark_active_stale();
        let (restored, error, _, _, revision_after) = state.active_page().unwrap();
        assert!(error.is_none());
        assert!(restored.html().contains("After restoration"));
        assert_eq!(revision_after, revision_before.saturating_add(1));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reloads_the_active_layout_page_document_after_a_watcher_change() {
        let directory = test_directory();
        let path = directory.join("reload.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "# Before\n").unwrap();
        let state = DocumentState::default();
        state.open_path(path.clone()).unwrap();
        let (_, _, _, tab_id, revision_before) = state.active_page().unwrap();

        fs::write(&path, "# After\n").unwrap();
        assert!(state.mark_path_stale(&path));
        let (page, error, _, active_tab_id, revision_after) = state.active_page().unwrap();

        assert!(error.is_none());
        assert_eq!(active_tab_id, tab_id);
        assert_eq!(revision_after, revision_before.saturating_add(1));
        assert!(page.html().contains("After"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn defers_an_inactive_layout_page_document_reload_until_selection() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First before\n").unwrap();
        fs::write(&second_path, "# Second\n").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path.clone()).unwrap();
        let (_, _, _, first_tab_id, first_revision) = state.active_page().unwrap();
        state.open_path(second_path).unwrap();

        fs::write(&first_path, "# First after\n").unwrap();
        assert!(!state.mark_path_stale(&first_path));
        state.select_tab(first_tab_id).unwrap();
        let (page, error, _, active_tab_id, revision_after) = state.active_page().unwrap();

        assert!(error.is_none());
        assert_eq!(active_tab_id, first_tab_id);
        assert_eq!(revision_after, first_revision.saturating_add(1));
        assert!(page.html().contains("First after"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn selects_existing_tabs_and_releases_closed_tabs() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path.clone()).unwrap();
        let first_id = state.tabs()[0].0;
        state.open_path(second_path.clone()).unwrap();
        state.open_path(first_path).unwrap();

        assert_eq!(state.tabs().len(), 2);
        assert!(state.tabs()[0].2);

        state.close_tabs(first_id, "tab").unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(state.tabs().len(), 1);
        assert_eq!(state.tabs()[0].1, "second.md");
        assert!(state.tabs()[0].2);
    }

    #[test]
    fn shares_watches_by_directory_and_releases_them_after_the_last_tab_closes() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path).unwrap();
        let first_id = state.tabs()[0].0;
        state.open_path(second_path).unwrap();
        let second_id = state.tabs()[1].0;

        let (_, directories) = state.watch_snapshot();
        assert_eq!(directories, vec![directory.clone()]);

        state.close_tabs(first_id, "tab").unwrap();
        let (_, directories) = state.watch_snapshot();
        assert_eq!(directories, vec![directory.clone()]);

        state.close_tabs(second_id, "tab").unwrap();
        let (_, directories) = state.watch_snapshot();
        assert!(directories.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn agent_tabs_expose_lifecycle_state_without_document_identity() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path.clone()).unwrap();
        let first_id = state.tabs()[0].0;
        state.open_path(second_path).unwrap();
        let second_id = state.tabs()[1].0;

        assert!(!state.mark_path_stale(&first_path));
        let tabs = state.agent_tabs();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0], (first_id, 0, false, true, false, 0.0, 0));
        assert_eq!(tabs[1], (second_id, 0, true, false, false, 0.0, 0));
    }

    #[test]
    fn preserves_logical_viewer_position_for_inactive_tabs() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path).unwrap();
        let first_id = state.tabs()[0].0;
        state.save_active_viewer_position(123.0, 456);
        state.open_path(second_path).unwrap();
        state.select_tab(first_id).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(state.active_viewer_position(), (123.0, 456));
    }

    #[test]
    fn rejects_a_delayed_viewer_position_save_after_opening_another_document() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path).unwrap();
        let (_, _, _, first_tab_id, first_tab_revision) = state.active_page().unwrap();
        state.open_path(second_path).unwrap();

        let was_saved = state
            .save_viewer_position(first_tab_id, first_tab_revision, 123.0, 456)
            .unwrap();
        let active_position = state.active_viewer_position();
        fs::remove_dir_all(directory).unwrap();

        assert!(!was_saved);
        assert_eq!(active_position, (0.0, 0));
    }

    #[test]
    fn replaces_the_active_document_without_retaining_a_tab() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path).unwrap();
        state.replace_active_path(second_path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(state.tabs().len(), 1);
        assert_eq!(state.tabs()[0].1, "second.md");
    }

    #[test]
    fn context_close_actions_select_their_target_tab() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        let third_path = directory.join("third.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "# First").unwrap();
        fs::write(&second_path, "# Second").unwrap();
        fs::write(&third_path, "# Third").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path).unwrap();
        state.open_path(second_path).unwrap();
        state.open_path(third_path).unwrap();
        let second_id = state.tabs()[1].0;

        state.close_tabs(second_id, "left").unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(state.tabs().len(), 2);
        assert_eq!(state.tabs()[0].0, second_id);
        assert!(state.tabs()[0].2);
    }

    #[test]
    fn prepares_a_bounded_layout_page_window() {
        let directory = test_directory();
        let path = directory.join("virtual.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "paragraph\n\n".repeat(100_000)).unwrap();
        let state = DocumentState::default();
        state.open_path(path).unwrap();

        let (_, _, _, tab_id, tab_revision) = state.active_page().unwrap();
        let (pages, _, _) = state
            .layout_page_window_for_active_viewer(0, tab_id, tab_revision)
            .unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(pages.len(), 1);
        assert!(pages[0].source_end > pages[0].source_start);
    }

    #[test]
    fn rejects_document_work_from_a_replaced_active_tab() {
        let directory = test_directory();
        let first_path = directory.join("first.md");
        let second_path = directory.join("second.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&first_path, "First document.\n\n").unwrap();
        fs::write(&second_path, "Second document.\n\n").unwrap();
        let state = DocumentState::default();
        state.open_path(first_path).unwrap();
        let (_, _, _, first_tab_id, first_tab_revision) = state.active_page().unwrap();
        state.open_path(second_path.clone()).unwrap();

        let error = state
            .layout_page_window_for_active_viewer(0, first_tab_id, first_tab_revision)
            .unwrap_err();

        assert_eq!(error, STALE_VIEWER_REQUEST);
        assert_eq!(state.current_path().as_deref(), Some(second_path.as_path()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_document_work_after_its_tab_is_closed() {
        let directory = test_directory();
        let path = directory.join("closed.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "Paragraph.\n\n".repeat(100_000)).unwrap();
        let state = DocumentState::default();
        state.open_path(path).unwrap();
        let (_, _, _, tab_id, tab_revision) = state.active_page().unwrap();

        state.close_tabs(tab_id, "tab").unwrap();
        let error = state
            .layout_page_window_for_active_viewer(0, tab_id, tab_revision)
            .unwrap_err();

        assert_eq!(error, STALE_VIEWER_REQUEST);
        assert!(state.tabs().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
