use crate::{
    document_index::DocumentIndex,
    document_search::{DocumentSearch, NavigationProgress, SearchProgress},
    document_source::{DocumentSource, SourceIdentity},
    layout_page::{LayoutPage, LayoutPageId},
    layout_page_limits::LayoutPageLimits,
    layout_page_renderer::{
        LayoutPageContext, StructuralLayoutPage, reconstruct_markdown, render_structural_page,
    },
    markdown::render_markdown,
};
use std::{
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DocumentWorkKind {
    PageRequest,
    Index,
    Enrichment,
    FindScan,
    FindNavigation,
}

impl DocumentWorkKind {
    #[cfg(debug_assertions)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::PageRequest => "page-request",
            Self::Index => "index",
            Self::Enrichment => "enrichment",
            Self::FindScan => "find-scan",
            Self::FindNavigation => "find-navigation",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct WorkLifecycleTarget {
    pub(crate) kind: DocumentWorkKind,
    pub(crate) tab_id: u64,
    pub(crate) tab_revision: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct DocumentTarget {
    pub(crate) tab_id: u64,
    pub(crate) tab_revision: u64,
    pub(crate) path: PathBuf,
    pub(crate) identity: SourceIdentity,
    pub(crate) limits: LayoutPageLimits,
}

impl DocumentTarget {
    pub(crate) fn lifecycle(&self, kind: DocumentWorkKind) -> WorkLifecycleTarget {
        WorkLifecycleTarget {
            kind,
            tab_id: self.tab_id,
            tab_revision: self.tab_revision,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct EnrichmentTarget {
    pub(crate) document: DocumentTarget,
    pub(crate) page_id: LayoutPageId,
    pub(crate) source_start: u64,
    pub(crate) source_end: u64,
    pub(crate) context_before: LayoutPageContext,
    pub(crate) context_after: LayoutPageContext,
    pub(crate) definition_generation: u64,
    pub(crate) definitions: Vec<String>,
}

pub(crate) struct PageRequestTarget {
    pub(crate) document: DocumentTarget,
    pub(crate) source_offset: u64,
    seed_index: Option<Box<DocumentIndex>>,
    index_continuation: Option<IndexContinuation>,
}

impl PageRequestTarget {
    pub(crate) fn new(document: DocumentTarget, source_offset: u64) -> Self {
        Self {
            document,
            source_offset,
            seed_index: None,
            index_continuation: None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FindTarget {
    pub(crate) document: DocumentTarget,
    pub(crate) query: String,
    pub(crate) navigation_after: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FindDirection {
    Next,
    Previous,
}

#[derive(Clone, Debug)]
pub(crate) struct FindNavigationTarget {
    pub(crate) document: DocumentTarget,
    pub(crate) query: String,
    pub(crate) position: Option<u64>,
    pub(crate) direction: FindDirection,
}

pub(crate) enum DocumentWork {
    PreparePage(PageRequestTarget),
    BuildIndex(DocumentTarget),
    EnrichPage(Box<EnrichmentTarget>),
    ScanFind(FindTarget),
    NavigateFind(FindNavigationTarget),
}

impl DocumentWork {
    fn kind(&self) -> DocumentWorkKind {
        match self {
            Self::PreparePage(_) => DocumentWorkKind::PageRequest,
            Self::BuildIndex(_) => DocumentWorkKind::Index,
            Self::EnrichPage(_) => DocumentWorkKind::Enrichment,
            Self::ScanFind(_) => DocumentWorkKind::FindScan,
            Self::NavigateFind(_) => DocumentWorkKind::FindNavigation,
        }
    }

    pub(crate) fn lifecycle(&self) -> WorkLifecycleTarget {
        match self {
            Self::PreparePage(target) => target.document.lifecycle(DocumentWorkKind::PageRequest),
            Self::BuildIndex(target) => target.lifecycle(DocumentWorkKind::Index),
            Self::EnrichPage(target) => target.document.lifecycle(DocumentWorkKind::Enrichment),
            Self::ScanFind(target) => target.document.lifecycle(DocumentWorkKind::FindScan),
            Self::NavigateFind(target) => {
                target.document.lifecycle(DocumentWorkKind::FindNavigation)
            }
        }
    }
}

pub(crate) struct CompletedIndex {
    pub(crate) target: DocumentTarget,
    pub(crate) index: DocumentIndex,
}

pub(crate) struct CompletedPageRequest {
    pub(crate) target: PageRequestTarget,
    pub(crate) page: LayoutPage,
    pub(crate) context_before: LayoutPageContext,
    pub(crate) rendered: StructuralLayoutPage,
}

pub(crate) struct CompletedEnrichment {
    pub(crate) target: EnrichmentTarget,
    pub(crate) html: String,
}

pub(crate) struct CompletedFindScan {
    pub(crate) target: FindTarget,
    pub(crate) progress: SearchProgress,
}

pub(crate) struct CompletedFindNavigation {
    pub(crate) target: FindNavigationTarget,
    pub(crate) progress: NavigationProgress,
}

pub(crate) enum DocumentWorkOutcome {
    Cancelled(WorkLifecycleTarget),
    CompletedIndex(Box<CompletedIndex>),
    CompletedPageRequest(Box<CompletedPageRequest>),
    CompletedEnrichment(Box<CompletedEnrichment>),
    CompletedFindScan(CompletedFindScan),
    CompletedFindNavigation(CompletedFindNavigation),
    Failed(WorkLifecycleTarget),
}

impl DocumentWorkOutcome {
    fn completed_lifecycle(&self) -> Option<WorkLifecycleTarget> {
        match self {
            Self::CompletedPageRequest(completed) => Some(
                completed
                    .target
                    .document
                    .lifecycle(DocumentWorkKind::PageRequest),
            ),
            Self::CompletedIndex(completed) => {
                Some(completed.target.lifecycle(DocumentWorkKind::Index))
            }
            Self::CompletedEnrichment(completed) => Some(
                completed
                    .target
                    .document
                    .lifecycle(DocumentWorkKind::Enrichment),
            ),
            Self::CompletedFindScan(completed) => Some(
                completed
                    .target
                    .document
                    .lifecycle(DocumentWorkKind::FindScan),
            ),
            Self::CompletedFindNavigation(completed) => Some(
                completed
                    .target
                    .document
                    .lifecycle(DocumentWorkKind::FindNavigation),
            ),
            Self::Cancelled(_) | Self::Failed(_) => None,
        }
    }
}

struct QueuedWork {
    generation: u64,
    work: DocumentWork,
}

#[derive(Default)]
struct WorkerState {
    pending_page_request: Option<QueuedWork>,
    pending_index: Option<QueuedWork>,
    pending_enrichment: Option<QueuedWork>,
    pending_find_scan: Option<QueuedWork>,
    pending_find_navigation: Option<QueuedWork>,
    shutdown: bool,
}

impl WorkerState {
    fn pending_slot(&mut self, kind: DocumentWorkKind) -> &mut Option<QueuedWork> {
        match kind {
            DocumentWorkKind::PageRequest => &mut self.pending_page_request,
            DocumentWorkKind::Index => &mut self.pending_index,
            DocumentWorkKind::Enrichment => &mut self.pending_enrichment,
            DocumentWorkKind::FindScan => &mut self.pending_find_scan,
            DocumentWorkKind::FindNavigation => &mut self.pending_find_navigation,
        }
    }

    fn take_pending(&mut self) -> Option<QueuedWork> {
        self.pending_find_navigation
            .take()
            .or_else(|| self.pending_page_request.take())
            .or_else(|| self.pending_find_scan.take())
            .or_else(|| self.pending_enrichment.take())
            .or_else(|| self.pending_index.take())
    }

    fn take_all_pending(&mut self) -> Vec<QueuedWork> {
        [
            self.pending_page_request.take(),
            self.pending_index.take(),
            self.pending_enrichment.take(),
            self.pending_find_scan.take(),
            self.pending_find_navigation.take(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

struct Generations {
    page_request: AtomicU64,
    index: AtomicU64,
    enrichment: AtomicU64,
    find_scan: AtomicU64,
    find_navigation: AtomicU64,
}

impl Generations {
    fn generation(&self, kind: DocumentWorkKind) -> &AtomicU64 {
        match kind {
            DocumentWorkKind::PageRequest => &self.page_request,
            DocumentWorkKind::Index => &self.index,
            DocumentWorkKind::Enrichment => &self.enrichment,
            DocumentWorkKind::FindScan => &self.find_scan,
            DocumentWorkKind::FindNavigation => &self.find_navigation,
        }
    }

    fn replace(&self, kind: DocumentWorkKind) -> u64 {
        self.generation(kind).fetch_add(1, Ordering::AcqRel) + 1
    }

    fn cancel(&self, kind: DocumentWorkKind) {
        self.generation(kind).fetch_add(1, Ordering::AcqRel);
    }

    fn is_current(&self, kind: DocumentWorkKind, generation: u64) -> bool {
        self.generation(kind).load(Ordering::Acquire) == generation
    }

    fn cancel_all(&self) {
        for kind in [
            DocumentWorkKind::PageRequest,
            DocumentWorkKind::Index,
            DocumentWorkKind::Enrichment,
            DocumentWorkKind::FindScan,
            DocumentWorkKind::FindNavigation,
        ] {
            self.cancel(kind);
        }
    }
}

struct WorkerShared {
    generations: Generations,
    state: Mutex<WorkerState>,
    ready: Condvar,
}

struct ActiveIndex {
    generation: u64,
    target: DocumentTarget,
    index: DocumentIndex,
}

struct IndexContinuation {
    generation: u64,
    target: DocumentTarget,
}

struct ActivePageRequest {
    generation: u64,
    target: PageRequestTarget,
    index: Box<DocumentIndex>,
    index_continuation: Option<IndexContinuation>,
}

struct ActiveFindScan {
    generation: u64,
    target: FindTarget,
    search: DocumentSearch,
}

struct ActiveFindNavigation {
    generation: u64,
    target: FindNavigationTarget,
    search: DocumentSearch,
}

enum ActiveWork {
    PageRequest(ActivePageRequest),
    Index(ActiveIndex),
    FindScan(ActiveFindScan),
    FindNavigation(ActiveFindNavigation),
}

impl ActiveWork {
    fn kind(&self) -> DocumentWorkKind {
        match self {
            Self::PageRequest(_) => DocumentWorkKind::PageRequest,
            Self::Index(_) => DocumentWorkKind::Index,
            Self::FindScan(_) => DocumentWorkKind::FindScan,
            Self::FindNavigation(_) => DocumentWorkKind::FindNavigation,
        }
    }

    fn generation(&self) -> u64 {
        match self {
            Self::PageRequest(active) => active.generation,
            Self::Index(active) => active.generation,
            Self::FindScan(active) => active.generation,
            Self::FindNavigation(active) => active.generation,
        }
    }

    fn lifecycle(&self) -> WorkLifecycleTarget {
        match self {
            Self::PageRequest(active) => active
                .target
                .document
                .lifecycle(DocumentWorkKind::PageRequest),
            Self::Index(active) => active.target.lifecycle(DocumentWorkKind::Index),
            Self::FindScan(active) => active.target.document.lifecycle(DocumentWorkKind::FindScan),
            Self::FindNavigation(active) => active
                .target
                .document
                .lifecycle(DocumentWorkKind::FindNavigation),
        }
    }
}

enum StepOutcome {
    Yield(Box<ActiveWork>),
    Complete(Box<DocumentWorkOutcome>),
    CompleteAndYield {
        outcome: Box<DocumentWorkOutcome>,
        active: Box<ActiveWork>,
    },
}

fn complete(outcome: DocumentWorkOutcome) -> StepOutcome {
    StepOutcome::Complete(Box::new(outcome))
}

/// Owns Lumen's one lazily created document-work worker.
///
/// It owns no foreground viewer state. Every scan step creates a separate
/// bounded source and drops it before the scheduler chooses the next job.
#[derive(Clone)]
pub(crate) struct DocumentWorkCoordinator {
    shared: Arc<WorkerShared>,
    _worker: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl DocumentWorkCoordinator {
    pub(crate) fn new(deliver: impl Fn(DocumentWorkOutcome) + Send + Sync + 'static) -> Self {
        let shared = Arc::new(WorkerShared {
            generations: Generations {
                page_request: AtomicU64::new(0),
                index: AtomicU64::new(0),
                enrichment: AtomicU64::new(0),
                find_scan: AtomicU64::new(0),
                find_navigation: AtomicU64::new(0),
            },
            state: Mutex::new(WorkerState::default()),
            ready: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let deliver = Arc::new(deliver);
        let worker = thread::spawn(move || run_worker(worker_shared, deliver));
        Self {
            shared,
            _worker: Arc::new(Mutex::new(Some(worker))),
        }
    }

    pub(crate) fn submit(&self, work: DocumentWork) -> Option<WorkLifecycleTarget> {
        let kind = work.kind();
        let generation = self.shared.generations.replace(kind);
        let Ok(mut state) = self.shared.state.lock() else {
            return None;
        };
        let replaced = state
            .pending_slot(kind)
            .replace(QueuedWork { generation, work });
        self.shared.ready.notify_one();
        replaced.map(|queued| queued.work.lifecycle())
    }

    pub(crate) fn cancel_kind(&self, kind: DocumentWorkKind) -> Option<WorkLifecycleTarget> {
        self.shared.generations.cancel(kind);
        let Ok(mut state) = self.shared.state.lock() else {
            return None;
        };
        let cancelled = state.pending_slot(kind).take();
        self.shared.ready.notify_one();
        cancelled.map(|queued| queued.work.lifecycle())
    }

    pub(crate) fn cancel_all(&self) -> Vec<WorkLifecycleTarget> {
        self.shared.generations.cancel_all();
        let Ok(mut state) = self.shared.state.lock() else {
            return Vec::new();
        };
        let cancelled = state
            .take_all_pending()
            .into_iter()
            .map(|queued| queued.work.lifecycle())
            .collect();
        self.shared.ready.notify_one();
        cancelled
    }

    pub(crate) fn shutdown(&self) {
        self.shared.generations.cancel_all();
        let Ok(mut state) = self.shared.state.lock() else {
            return;
        };
        state.take_all_pending();
        state.shutdown = true;
        self.shared.ready.notify_one();
    }

    #[cfg(test)]
    fn shutdown_and_join(&self) {
        self.shutdown();
        let Ok(mut worker) = self._worker.lock() else {
            return;
        };
        if let Some(worker) = worker.take() {
            worker
                .join()
                .expect("document-work worker must terminate cleanly");
        }
    }
}

fn run_worker(shared: Arc<WorkerShared>, deliver: Arc<dyn Fn(DocumentWorkOutcome) + Send + Sync>) {
    let mut active: Vec<ActiveWork> = Vec::new();
    loop {
        let Some(work) = next_work(&shared, &mut active) else {
            return;
        };
        if matches!(work, WorkItem::Queued(_)) {
            crate::agent_api::record_document_work_lifecycle("started", work.lifecycle());
        }
        match run_step(&shared, work) {
            StepOutcome::Yield(active_work) => active.push(*active_work),
            StepOutcome::Complete(outcome) => {
                if let Some(lifecycle) = outcome.completed_lifecycle() {
                    crate::agent_api::record_document_work_lifecycle("completed", lifecycle);
                }
                deliver(*outcome);
            }
            StepOutcome::CompleteAndYield {
                outcome,
                active: resumed,
            } => {
                if let Some(lifecycle) = outcome.completed_lifecycle() {
                    crate::agent_api::record_document_work_lifecycle("completed", lifecycle);
                }
                deliver(*outcome);
                active.push(*resumed);
            }
        }
    }
}

fn next_work(shared: &WorkerShared, active: &mut Vec<ActiveWork>) -> Option<WorkItem> {
    loop {
        let mut state = shared.state.lock().ok()?;
        if state.shutdown {
            return None;
        }
        if let Some(mut queued) = state.take_pending() {
            if let DocumentWork::PreparePage(target) = &mut queued.work
                && let Some(index_position) = active.iter().position(|work| {
                    matches!(
                        work,
                        ActiveWork::Index(index)
                            if index.target.tab_id == target.document.tab_id
                                && index.target.tab_revision == target.document.tab_revision
                                && index.target.identity == target.document.identity
                    ) || matches!(
                        work,
                        ActiveWork::PageRequest(request)
                            if request.target.document.tab_id == target.document.tab_id
                                && request.target.document.tab_revision == target.document.tab_revision
                                && request.target.document.identity == target.document.identity
                    )
                })
            {
                match active.remove(index_position) {
                    ActiveWork::Index(index) => {
                        target.seed_index = Some(Box::new(index.index));
                        target.index_continuation = Some(IndexContinuation {
                            generation: index.generation,
                            target: index.target,
                        });
                    }
                    ActiveWork::PageRequest(request) => {
                        // A newer native scroll target supersedes this request,
                        // but its partial index remains the fastest valid path.
                        crate::agent_api::record_document_work_lifecycle(
                            "cancelled",
                            request.target.document.lifecycle(DocumentWorkKind::PageRequest),
                        );
                        target.seed_index = Some(request.index);
                        target.index_continuation = request.index_continuation;
                    }
                    ActiveWork::FindNavigation(_) | ActiveWork::FindScan(_) => {
                        unreachable!("only index-compatible work may match a page request")
                    }
                }
            }
            drop(state);
            return Some(WorkItem::Queued(Box::new(queued)));
        }
        let next_active = take_active(shared, active);
        if next_active.is_some() {
            drop(state);
            return next_active;
        }
        state = shared.ready.wait(state).ok()?;
        if state.shutdown {
            return None;
        }
    }
}

enum WorkItem {
    Queued(Box<QueuedWork>),
    Active(Box<ActiveWork>),
}

impl WorkItem {
    fn lifecycle(&self) -> WorkLifecycleTarget {
        match self {
            Self::Queued(queued) => queued.work.lifecycle(),
            Self::Active(active) => active.lifecycle(),
        }
    }
}

fn take_active(shared: &WorkerShared, active: &mut Vec<ActiveWork>) -> Option<WorkItem> {
    let priority = [
        DocumentWorkKind::FindNavigation,
        DocumentWorkKind::PageRequest,
        DocumentWorkKind::FindScan,
        DocumentWorkKind::Index,
    ];
    for kind in priority {
        let Some(index) = active.iter().position(|work| work.kind() == kind) else {
            continue;
        };
        let work = active.remove(index);
        if shared
            .generations
            .is_current(work.kind(), work.generation())
        {
            return Some(WorkItem::Active(Box::new(work)));
        }
        crate::agent_api::record_document_work_lifecycle("cancelled", work.lifecycle());
    }
    None
}

fn run_step(shared: &WorkerShared, work: WorkItem) -> StepOutcome {
    match work {
        WorkItem::Queued(queued) => start_queued_work(shared, *queued),
        WorkItem::Active(active) => resume_work(shared, *active),
    }
}

fn start_queued_work(shared: &WorkerShared, queued: QueuedWork) -> StepOutcome {
    let kind = queued.work.kind();
    if !shared.generations.is_current(kind, queued.generation) {
        return complete(DocumentWorkOutcome::Cancelled(queued.work.lifecycle()));
    }
    match queued.work {
        DocumentWork::PreparePage(mut target) => {
            let limits = target.document.limits;
            let index = target
                .seed_index
                .take()
                .unwrap_or_else(|| Box::new(DocumentIndex::new(limits)));
            let index_continuation = target.index_continuation.take();
            StepOutcome::Yield(Box::new(ActiveWork::PageRequest(ActivePageRequest {
                generation: queued.generation,
                index,
                index_continuation,
                target,
            })))
        }
        DocumentWork::BuildIndex(target) => {
            StepOutcome::Yield(Box::new(ActiveWork::Index(ActiveIndex {
                generation: queued.generation,
                index: DocumentIndex::new(target.limits),
                target,
            })))
        }
        DocumentWork::EnrichPage(target) => {
            let lifecycle = target.document.lifecycle(DocumentWorkKind::Enrichment);
            let outcome = enrich_page(*target);
            if shared
                .generations
                .is_current(DocumentWorkKind::Enrichment, queued.generation)
            {
                complete(outcome)
            } else {
                complete(DocumentWorkOutcome::Cancelled(lifecycle))
            }
        }
        DocumentWork::ScanFind(target) => match DocumentSearch::new(target.query.clone()) {
            Ok(search) => StepOutcome::Yield(Box::new(ActiveWork::FindScan(ActiveFindScan {
                generation: queued.generation,
                target,
                search,
            }))),
            Err(_) => complete(DocumentWorkOutcome::Failed(
                target.document.lifecycle(DocumentWorkKind::FindScan),
            )),
        },
        DocumentWork::NavigateFind(target) => match DocumentSearch::new(target.query.clone()) {
            Ok(search) => {
                StepOutcome::Yield(Box::new(ActiveWork::FindNavigation(ActiveFindNavigation {
                    generation: queued.generation,
                    target,
                    search,
                })))
            }
            Err(_) => complete(DocumentWorkOutcome::Failed(
                target.document.lifecycle(DocumentWorkKind::FindNavigation),
            )),
        },
    }
}

fn resume_work(shared: &WorkerShared, active: ActiveWork) -> StepOutcome {
    if !shared
        .generations
        .is_current(active.kind(), active.generation())
    {
        return complete(DocumentWorkOutcome::Cancelled(active.lifecycle()));
    }
    match active {
        ActiveWork::PageRequest(active) => page_request_step(shared, active),
        ActiveWork::Index(active) => index_step(shared, active),
        ActiveWork::FindScan(active) => find_scan_step(shared, active),
        ActiveWork::FindNavigation(active) => find_navigation_step(shared, active),
    }
}

fn page_request_step(shared: &WorkerShared, mut active: ActivePageRequest) -> StepOutcome {
    let lifecycle = active
        .target
        .document
        .lifecycle(DocumentWorkKind::PageRequest);
    let Ok(mut source) = open_source(&active.target.document) else {
        return complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle));
    };
    let target_offset = active
        .target
        .source_offset
        .min(source.length().saturating_sub(1));
    let step = active.index.scan_step(&mut source);
    #[cfg(debug_assertions)]
    {
        let (indexed_through, checkpoint_count, index_bytes, directory_page_count) =
            active.index.agent_observation_counts();
        crate::agent_api::record_document_work_progress(
            indexed_through,
            checkpoint_count,
            index_bytes,
            directory_page_count,
        );
    }
    if !shared
        .generations
        .is_current(DocumentWorkKind::PageRequest, active.generation)
    {
        return complete_page_request(active, DocumentWorkOutcome::Cancelled(lifecycle));
    }
    let Ok(index_complete) = step else {
        return complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle));
    };
    let Some(page) = active.index.layout_page_at_source_offset(target_offset) else {
        return if index_complete {
            complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle))
        } else {
            StepOutcome::Yield(Box::new(ActiveWork::PageRequest(active)))
        };
    };
    let Some(context_before) = active.index.layout_page_context(page) else {
        return complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle));
    };
    let requested_length = usize::try_from(page.source_end().saturating_sub(page.source_start()))
        .unwrap_or(usize::MAX);
    let Ok(range) = source.read_range(page.source_start(), requested_length) else {
        return complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle));
    };
    if range.start != page.source_start() || range.end != page.source_end() {
        return complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle));
    }
    let rendered = render_structural_page(
        page.source_start(),
        &range.text,
        &context_before,
        active.target.document.path.parent(),
    );
    if rendered.html.len() > active.target.document.limits.maximum_page_output_bytes {
        return complete_page_request(active, DocumentWorkOutcome::Failed(lifecycle));
    }
    let ActivePageRequest {
        index,
        index_continuation,
        target,
        ..
    } = active;
    complete_page_request_with_index(
        index_continuation,
        *index,
        DocumentWorkOutcome::CompletedPageRequest(Box::new(CompletedPageRequest {
            target,
            page,
            context_before,
            rendered,
        })),
    )
}

fn complete_page_request(active: ActivePageRequest, outcome: DocumentWorkOutcome) -> StepOutcome {
    complete_page_request_with_index(active.index_continuation, *active.index, outcome)
}

fn complete_page_request_with_index(
    index_continuation: Option<IndexContinuation>,
    index: DocumentIndex,
    outcome: DocumentWorkOutcome,
) -> StepOutcome {
    let Some(continuation) = index_continuation else {
        return complete(outcome);
    };
    StepOutcome::CompleteAndYield {
        outcome: Box::new(outcome),
        active: Box::new(ActiveWork::Index(ActiveIndex {
            generation: continuation.generation,
            target: continuation.target,
            index,
        })),
    }
}

fn open_source(target: &DocumentTarget) -> Result<DocumentSource, ()> {
    match DocumentSource::open(target.path.clone(), target.limits) {
        Ok(source) if source.identity() == target.identity => Ok(source),
        Ok(_) | Err(_) => Err(()),
    }
}

fn index_step(shared: &WorkerShared, mut active: ActiveIndex) -> StepOutcome {
    let lifecycle = active.target.lifecycle(DocumentWorkKind::Index);
    let Ok(mut source) = open_source(&active.target) else {
        return complete(DocumentWorkOutcome::Failed(lifecycle));
    };
    let step = active.index.scan_step(&mut source);
    #[cfg(debug_assertions)]
    {
        let (indexed_through, checkpoint_count, index_bytes, directory_page_count) =
            active.index.agent_observation_counts();
        crate::agent_api::record_document_work_progress(
            indexed_through,
            checkpoint_count,
            index_bytes,
            directory_page_count,
        );
    }
    if !shared
        .generations
        .is_current(DocumentWorkKind::Index, active.generation)
    {
        return complete(DocumentWorkOutcome::Cancelled(lifecycle));
    }
    match step {
        Ok(true) => {
            #[cfg(debug_assertions)]
            {
                let (_, _, index_bytes, _) = active.index.agent_observation_counts();
                crate::agent_api::record_document_work_resource_counts(
                    u64::try_from(source.cache_bytes()).unwrap_or(u64::MAX),
                    index_bytes,
                    0,
                );
            }
            complete(DocumentWorkOutcome::CompletedIndex(Box::new(
                CompletedIndex {
                    target: active.target,
                    index: active.index,
                },
            )))
        }
        Ok(false) => StepOutcome::Yield(Box::new(ActiveWork::Index(active))),
        Err(_) => complete(DocumentWorkOutcome::Failed(lifecycle)),
    }
}

fn find_scan_step(shared: &WorkerShared, mut active: ActiveFindScan) -> StepOutcome {
    let lifecycle = active.target.document.lifecycle(DocumentWorkKind::FindScan);
    let Ok(mut source) = open_source(&active.target.document) else {
        return complete(DocumentWorkOutcome::Failed(lifecycle));
    };
    let step = active.search.step(
        &mut source,
        active.target.document.limits,
        active.target.navigation_after,
    );
    if !shared
        .generations
        .is_current(DocumentWorkKind::FindScan, active.generation)
    {
        return complete(DocumentWorkOutcome::Cancelled(lifecycle));
    }
    #[cfg(debug_assertions)]
    crate::agent_api::record_document_work_resource_counts(
        u64::try_from(source.cache_bytes()).unwrap_or(u64::MAX),
        0,
        active.search.agent_observation_bytes(),
    );
    match step {
        Ok(progress) if progress.complete => {
            complete(DocumentWorkOutcome::CompletedFindScan(CompletedFindScan {
                target: active.target,
                progress,
            }))
        }
        Ok(_) => StepOutcome::Yield(Box::new(ActiveWork::FindScan(active))),
        Err(_) => complete(DocumentWorkOutcome::Failed(lifecycle)),
    }
}

fn find_navigation_step(shared: &WorkerShared, mut active: ActiveFindNavigation) -> StepOutcome {
    let lifecycle = active
        .target
        .document
        .lifecycle(DocumentWorkKind::FindNavigation);
    let Ok(mut source) = open_source(&active.target.document) else {
        return complete(DocumentWorkOutcome::Failed(lifecycle));
    };
    let step = match active.target.direction {
        FindDirection::Next => active.search.next_step(
            &mut source,
            active.target.document.limits,
            active.target.position,
        ),
        FindDirection::Previous => active.search.previous_step(
            &mut source,
            active.target.document.limits,
            active.target.position,
        ),
    };
    if !shared
        .generations
        .is_current(DocumentWorkKind::FindNavigation, active.generation)
    {
        return complete(DocumentWorkOutcome::Cancelled(lifecycle));
    }
    #[cfg(debug_assertions)]
    crate::agent_api::record_document_work_resource_counts(
        u64::try_from(source.cache_bytes()).unwrap_or(u64::MAX),
        0,
        active.search.agent_observation_bytes(),
    );
    match step {
        Ok(progress) if progress.complete => complete(
            DocumentWorkOutcome::CompletedFindNavigation(CompletedFindNavigation {
                target: active.target,
                progress,
            }),
        ),
        Ok(_) => StepOutcome::Yield(Box::new(ActiveWork::FindNavigation(active))),
        Err(_) => complete(DocumentWorkOutcome::Failed(lifecycle)),
    }
}

pub(crate) fn enrich_page(target: EnrichmentTarget) -> DocumentWorkOutcome {
    let lifecycle = target.document.lifecycle(DocumentWorkKind::Enrichment);
    let Ok(mut source) = open_source(&target.document) else {
        return DocumentWorkOutcome::Failed(lifecycle);
    };
    let requested_length = usize::try_from(target.source_end.saturating_sub(target.source_start))
        .unwrap_or(usize::MAX);
    let Ok(range) = source.read_range(target.source_start, requested_length) else {
        return DocumentWorkOutcome::Failed(lifecycle);
    };
    if range.start != target.source_start || range.end != target.source_end {
        return DocumentWorkOutcome::Failed(lifecycle);
    }
    let mut markdown =
        reconstruct_markdown(&target.context_before, &range.text, &target.context_after);
    if !target.definitions.is_empty() {
        markdown.push_str("\n\n");
        markdown.push_str(&target.definitions.join("\n"));
    }
    let html = render_markdown(&markdown, target.document.path.parent());
    if html.len() > target.document.limits.maximum_page_output_bytes {
        return DocumentWorkOutcome::Failed(lifecycle);
    }
    DocumentWorkOutcome::CompletedEnrichment(Box::new(CompletedEnrichment { target, html }))
}

#[cfg(test)]
mod tests {
    use super::{
        ActivePageRequest, ActiveWork, DocumentTarget, DocumentWork, DocumentWorkCoordinator,
        DocumentWorkKind, DocumentWorkOutcome, FindDirection, FindNavigationTarget, FindTarget,
        Generations, PageRequestTarget, QueuedWork, WorkerShared, WorkerState, next_work,
    };
    use crate::{
        document_index::DocumentIndex, document_source::DocumentSource,
        layout_page_limits::LayoutPageLimits,
    };
    use std::{
        env, fs,
        path::PathBuf,
        sync::{Condvar, Mutex, atomic::AtomicU64, mpsc},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_document(contents: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "lumen-document-work-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, contents).unwrap();
        path
    }

    fn target(path: PathBuf, limits: LayoutPageLimits) -> DocumentTarget {
        let source = DocumentSource::open(path.clone(), limits).unwrap();
        DocumentTarget {
            tab_id: 1,
            tab_revision: 2,
            path,
            identity: source.identity(),
            limits,
        }
    }

    #[test]
    fn builds_one_completed_index_from_a_separate_source() {
        let path = temporary_document("# Heading\n\nContent\n");
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 4,
            ..LayoutPageLimits::default()
        };
        let (sender, receiver) = mpsc::channel();
        let coordinator =
            DocumentWorkCoordinator::new(move |outcome| sender.send(outcome).unwrap());
        coordinator.submit(DocumentWork::BuildIndex(target(path.clone(), limits)));

        let outcome = receiver.recv().unwrap();
        assert!(matches!(outcome, DocumentWorkOutcome::CompletedIndex(_)));
        coordinator.shutdown_and_join();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn prepares_the_exact_canonical_page_for_a_far_reader_request() {
        let path = temporary_document(&"Before\n\n".repeat(4_096));
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 128,
            maximum_source_read_bytes: 256,
            ..LayoutPageLimits::default()
        };
        let source_length = fs::metadata(&path).unwrap().len();
        let target_offset = source_length / 2;
        let (sender, receiver) = mpsc::channel();
        let coordinator =
            DocumentWorkCoordinator::new(move |outcome| sender.send(outcome).unwrap());
        coordinator.submit(DocumentWork::PreparePage(PageRequestTarget::new(
            target(path.clone(), limits),
            target_offset,
        )));

        let outcome = receiver.recv().unwrap();
        let DocumentWorkOutcome::CompletedPageRequest(completed) = outcome else {
            panic!("priority page request should complete");
        };
        assert!(
            completed.page.source_start() <= target_offset
                && target_offset < completed.page.source_end()
        );
        assert_eq!(
            completed.page.source_start(),
            completed.rendered.source_start
        );
        assert_eq!(completed.page.source_end(), completed.rendered.source_end);
        assert!(completed.rendered.html.contains("Before"));
        coordinator.shutdown_and_join();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn cancelling_a_find_lane_does_not_cancel_index_work() {
        let path = temporary_document("# Heading\n\nContent\n");
        let limits = LayoutPageLimits::default();
        let (sender, receiver) = mpsc::channel();
        let coordinator =
            DocumentWorkCoordinator::new(move |outcome| sender.send(outcome).unwrap());
        coordinator.submit(DocumentWork::BuildIndex(target(path.clone(), limits)));
        coordinator.cancel_kind(DocumentWorkKind::FindScan);

        let outcome = receiver.recv().unwrap();
        assert!(matches!(outcome, DocumentWorkOutcome::CompletedIndex(_)));
        coordinator.shutdown_and_join();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn finds_reader_visible_text_with_a_separate_worker_source() {
        let path = temporary_document("[Visible label](hidden-destination)\n");
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 8,
            ..LayoutPageLimits::default()
        };
        let (sender, receiver) = mpsc::channel();
        let coordinator =
            DocumentWorkCoordinator::new(move |outcome| sender.send(outcome).unwrap());
        coordinator.submit(DocumentWork::ScanFind(FindTarget {
            document: target(path.clone(), limits),
            query: "Visible".to_owned(),
            navigation_after: None,
        }));

        let outcome = receiver.recv().unwrap();
        let DocumentWorkOutcome::CompletedFindScan(completed) = outcome else {
            panic!("Find scan should complete");
        };
        assert_eq!(completed.progress.match_count, 1);
        coordinator.shutdown_and_join();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn navigation_work_precedes_pending_low_priority_index_work() {
        let path = temporary_document("# One\n\nVisible text\n");
        let limits = LayoutPageLimits::default();
        let document = target(path.clone(), limits);
        let mut state = WorkerState {
            pending_index: Some(QueuedWork {
                generation: 1,
                work: DocumentWork::BuildIndex(document.clone()),
            }),
            pending_find_navigation: Some(QueuedWork {
                generation: 1,
                work: DocumentWork::NavigateFind(FindNavigationTarget {
                    document,
                    query: "Visible".to_owned(),
                    position: None,
                    direction: FindDirection::Next,
                }),
            }),
            ..WorkerState::default()
        };

        let next = state.take_pending().expect("queued work should exist");
        assert!(matches!(next.work, DocumentWork::NavigateFind(_)));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn reader_page_request_precedes_background_indexing() {
        let path = temporary_document("# Heading\n\nVisible text\n");
        let limits = LayoutPageLimits::default();
        let document = target(path.clone(), limits);
        let mut state = WorkerState {
            pending_index: Some(QueuedWork {
                generation: 1,
                work: DocumentWork::BuildIndex(document.clone()),
            }),
            pending_page_request: Some(QueuedWork {
                generation: 1,
                work: DocumentWork::PreparePage(PageRequestTarget::new(document, 0)),
            }),
            ..WorkerState::default()
        };

        let next = state.take_pending().expect("queued work should exist");
        assert!(matches!(next.work, DocumentWork::PreparePage(_)));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn newer_page_request_inherits_an_active_request_index() {
        let path = temporary_document("# Heading\n\nVisible text\n");
        let limits = LayoutPageLimits::default();
        let document = target(path.clone(), limits);
        let shared = WorkerShared {
            generations: Generations {
                page_request: AtomicU64::new(2),
                index: AtomicU64::new(0),
                enrichment: AtomicU64::new(0),
                find_scan: AtomicU64::new(0),
                find_navigation: AtomicU64::new(0),
            },
            state: Mutex::new(WorkerState {
                pending_page_request: Some(QueuedWork {
                    generation: 2,
                    work: DocumentWork::PreparePage(PageRequestTarget::new(document.clone(), 12)),
                }),
                ..WorkerState::default()
            }),
            ready: Condvar::new(),
        };
        let mut active = vec![ActiveWork::PageRequest(ActivePageRequest {
            generation: 1,
            target: PageRequestTarget::new(document, 0),
            index: Box::new(DocumentIndex::new(limits)),
            index_continuation: None,
        })];

        let next = next_work(&shared, &mut active).expect("new request should be selected");
        let super::WorkItem::Queued(queued) = next else {
            panic!("new request should remain queued for worker startup");
        };
        let DocumentWork::PreparePage(target) = queued.work else {
            panic!("new reader request should remain a page request");
        };
        assert!(target.seed_index.is_some());
        assert!(active.is_empty());
        fs::remove_file(path).unwrap();
    }
}
