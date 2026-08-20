use crate::{
    document_index::DocumentIndex,
    document_source::{DocumentSource, SourceIdentity},
    layout_page::{LayoutPage, LayoutPageDirectory, LayoutPageId},
    layout_page_limits::LayoutPageLimits,
    layout_page_renderer::{LayoutPageContext, render_structural_page, select_layout_page_end},
};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub(crate) struct PreparedLayoutPage {
    page: LayoutPage,
    pub(crate) source_start: u64,
    pub(crate) source_end: u64,
    pub(crate) structural_html: String,
    pub(crate) enriched_html: Option<String>,
    context_before: LayoutPageContext,
    context_after: LayoutPageContext,
}

impl PreparedLayoutPage {
    pub(crate) fn page_id(&self) -> LayoutPageId {
        self.page.id()
    }

    pub(crate) fn page_id_wire_value(&self) -> String {
        self.page_id().wire_value()
    }

    pub(crate) fn html(&self) -> &str {
        self.enriched_html
            .as_deref()
            .unwrap_or(&self.structural_html)
    }

    pub(crate) fn context_before(&self) -> LayoutPageContext {
        self.context_before.clone()
    }

    pub(crate) fn context_after(&self) -> LayoutPageContext {
        self.context_after.clone()
    }

    fn estimated_html_bytes(&self) -> usize {
        self.structural_html
            .len()
            .saturating_add(self.enriched_html.as_ref().map_or(0, String::len))
    }
}

pub(crate) struct LayoutPageDocument {
    source: DocumentSource,
    index: DocumentIndex,
    limits: LayoutPageLimits,
    page_directory: LayoutPageDirectory,
    prepared_pages: VecDeque<PreparedLayoutPage>,
    prepared_html_bytes: usize,
    frozen_error: Option<String>,
    definition_generation: u64,
}

impl LayoutPageDocument {
    pub(crate) fn open(path: PathBuf, limits: LayoutPageLimits) -> Result<Self, String> {
        let source = DocumentSource::open(path, limits).map_err(|error| error.to_string())?;
        Ok(Self {
            source,
            index: DocumentIndex::new(limits),
            limits,
            page_directory: LayoutPageDirectory::default(),
            prepared_pages: VecDeque::new(),
            prepared_html_bytes: 0,
            frozen_error: None,
            definition_generation: 0,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        self.source.path()
    }

    pub(crate) fn length(&self) -> u64 {
        self.source.length()
    }

    pub(crate) fn source_identity(&self) -> SourceIdentity {
        self.source.identity()
    }

    pub(crate) fn limits(&self) -> LayoutPageLimits {
        self.limits
    }

    pub(crate) fn index_is_complete(&self) -> bool {
        self.index.is_complete(self.length())
    }

    #[cfg(debug_assertions)]
    pub(crate) fn layout_page_count(&self) -> usize {
        self.page_directory.pages().len()
    }

    pub(crate) fn estimated_layout_page_count(&self) -> u64 {
        let page_input_bytes = u64::try_from(self.limits.maximum_page_input_bytes).unwrap_or(1);
        self.length().saturating_add(page_input_bytes - 1) / page_input_bytes
    }

    pub(crate) fn layout_page_directory_snapshot(&self) -> Vec<(String, u64, u64)> {
        self.page_directory
            .pages()
            .iter()
            .map(|page| {
                (
                    page.id().wire_value(),
                    page.source_start(),
                    page.source_end(),
                )
            })
            .collect()
    }

    pub(crate) fn adopt_completed_index(
        &mut self,
        expected_identity: SourceIdentity,
        index: DocumentIndex,
    ) -> Result<bool, String> {
        self.ensure_loading_allowed()?;
        let source_matches = self
            .source
            .matches_current_identity(expected_identity)
            .map_err(|error| error.to_string())?;
        if !source_matches || !index.is_complete(self.length()) {
            return Ok(false);
        }
        self.page_directory = index.layout_page_directory().clone();
        self.index = index;
        self.definition_generation = self.definition_generation.saturating_add(1);
        Ok(true)
    }

    #[cfg(debug_assertions)]
    pub(crate) fn agent_observation_counts(&self) -> (u64, u64, u64, u64, u64, u64, u64) {
        let (indexed_through, checkpoint_count, index_bytes, indexed_page_count) =
            self.index.agent_observation_counts();
        (
            indexed_through,
            checkpoint_count,
            index_bytes,
            u64::try_from(self.source.cache_bytes()).unwrap_or(u64::MAX),
            indexed_page_count.max(u64::try_from(self.layout_page_count()).unwrap_or(u64::MAX)),
            u64::try_from(self.prepared_pages.len()).unwrap_or(u64::MAX),
            u64::try_from(self.prepared_html_bytes).unwrap_or(u64::MAX),
        )
    }

    pub(crate) fn initial_layout_page(&mut self) -> Result<PreparedLayoutPage, String> {
        self.ensure_loading_allowed()?;
        if let Some(page) = self.prepared_pages.front() {
            return Ok(page.clone());
        }
        let result = self.prepare_layout_page(0, LayoutPageContext::default());
        self.freeze_file_errors(&result);
        result
    }

    pub(crate) fn heading_offset(&self, identifier: &str) -> Result<(Option<u64>, bool), String> {
        if let Some(error) = &self.frozen_error {
            return Err(error.clone());
        }
        let index_complete = self.index.is_complete(self.length());
        Ok((
            self.index.heading_offset(self.length(), identifier),
            index_complete,
        ))
    }

    pub(crate) fn definition_snapshot(&self) -> (u64, Vec<String>) {
        let definitions = self
            .index
            .markdown_definitions(self.length())
            .map_or_else(Vec::new, ToOwned::to_owned);
        (self.definition_generation, definitions)
    }

    pub(crate) fn accept_enrichment(
        &mut self,
        page_id: LayoutPageId,
        source_start: u64,
        source_end: u64,
        definition_generation: u64,
        html: String,
    ) -> Result<Option<PreparedLayoutPage>, String> {
        self.ensure_loading_allowed()?;
        if definition_generation != self.definition_generation
            || html.len() > self.limits.maximum_page_output_bytes
        {
            return Ok(None);
        }
        let Some(page) = self
            .prepared_pages
            .iter()
            .find(|candidate| {
                candidate.page_id() == page_id
                    && candidate.source_start == source_start
                    && candidate.source_end == source_end
            })
            .cloned()
        else {
            return Ok(None);
        };
        let mut enriched = page;
        enriched.structural_html.clear();
        enriched.enriched_html = Some(html);
        self.replace_cached_page(enriched.clone());
        Ok(Some(enriched))
    }

    pub(crate) fn prepared_layout_page(
        &self,
        page_id: LayoutPageId,
        source_start: u64,
        source_end: u64,
    ) -> Option<PreparedLayoutPage> {
        self.prepared_pages
            .iter()
            .find(|page| {
                page.page_id() == page_id
                    && page.source_start == source_start
                    && page.source_end == source_end
            })
            .cloned()
    }

    pub(crate) fn accept_prepared_layout_page(
        &mut self,
        page: LayoutPage,
        context_before: LayoutPageContext,
        rendered: crate::layout_page_renderer::StructuralLayoutPage,
    ) -> Result<PreparedLayoutPage, String> {
        self.ensure_loading_allowed()?;
        if page.source_start() != rendered.source_start || page.source_end() != rendered.source_end
        {
            return Err("the prepared layout page disagrees with its canonical range".to_owned());
        }
        if rendered.html.len() > self.limits.maximum_page_output_bytes {
            return Err(
                "the structural layout page exceeds Lumen's bounded output limit".to_owned(),
            );
        }
        if let Some(cached) = self
            .prepared_pages
            .iter()
            .find(|candidate| candidate.page_id() == page.id())
        {
            return Ok(cached.clone());
        }
        let prepared = PreparedLayoutPage {
            page,
            source_start: rendered.source_start,
            source_end: rendered.source_end,
            structural_html: rendered.html,
            enriched_html: None,
            context_before,
            context_after: rendered.context_after,
        };
        self.cache_page(prepared.clone());
        Ok(prepared)
    }

    /// Returns the bounded source-ordered layout-page window around a reader
    /// target. Once the background directory is complete this never uses the
    /// legacy lead-in heuristic: every returned page is checked against the
    /// canonical directory identity.
    pub(crate) fn layout_page_window_for_source_offset(
        &mut self,
        source_offset: u64,
    ) -> Result<Vec<PreparedLayoutPage>, String> {
        self.ensure_loading_allowed()?;
        let result = self.prepare_layout_page_window(source_offset);
        self.freeze_file_errors(&result);
        result
    }

    fn prepare_layout_page_window(
        &mut self,
        source_offset: u64,
    ) -> Result<Vec<PreparedLayoutPage>, String> {
        if !self.index.is_complete(self.length()) {
            if let Some(prepared_page) = self
                .prepared_pages
                .iter()
                .find(|page| page.source_start <= source_offset && source_offset < page.source_end)
            {
                return Ok(vec![prepared_page.clone()]);
            }
            let initial_page = self.initial_layout_page()?;
            return if source_offset < initial_page.source_end {
                Ok(vec![initial_page])
            } else {
                Err("the layout-page directory is still indexing".to_owned())
            };
        }
        let requested_offset = source_offset.min(self.length().saturating_sub(1));
        let Some(target_index) = self.page_directory.pages().iter().position(|page| {
            page.source_start() <= requested_offset && requested_offset < page.source_end()
        }) else {
            return Ok(Vec::new());
        };
        let page_count = self.limits.visible_page_count;
        let before = page_count.saturating_sub(1) / 2;
        let first_index = target_index.saturating_sub(before);
        let last_index = first_index
            .saturating_add(page_count)
            .min(self.page_directory.pages().len());
        let pages = self.page_directory.pages()[first_index..last_index].to_vec();
        let mut prepared = Vec::with_capacity(pages.len());
        for page in pages {
            prepared.push(self.prepare_directory_page(page)?);
        }
        Ok(prepared)
    }

    fn prepare_directory_page(&mut self, page: LayoutPage) -> Result<PreparedLayoutPage, String> {
        if let Some(cached) = self
            .prepared_pages
            .iter()
            .find(|prepared_page| prepared_page.page_id() == page.id())
        {
            return Ok(cached.clone());
        }
        let prepared_page = self
            .index
            .layout_page_context(page)
            .ok_or_else(|| {
                "the canonical layout-page directory lost its continuation context".to_owned()
            })
            .and_then(|context| self.prepare_layout_page(page.source_start(), context))?;
        if prepared_page.page_id() != page.id() {
            return Err(
                "the canonical layout-page directory disagrees with the page planner".to_owned(),
            );
        }
        Ok(prepared_page)
    }

    fn prepare_layout_page(
        &mut self,
        source_start: u64,
        context_before: LayoutPageContext,
    ) -> Result<PreparedLayoutPage, String> {
        let source_range = self
            .source
            .read_range(source_start, self.limits.maximum_page_input_bytes)
            .map_err(|error| error.to_string())?;
        if source_range.start != source_start {
            return Err("the requested layout page does not start on a UTF-8 boundary".to_owned());
        }
        let source_length = if source_range.end >= self.length() {
            source_range.text.len()
        } else {
            select_layout_page_end(
                &context_before,
                &source_range.text,
                self.limits.maximum_page_input_bytes,
            )
        };
        if source_length == 0 && source_start < self.length() {
            return Err("the layout-page selector did not make progress".to_owned());
        }
        let markdown = &source_range.text[..source_length];
        let rendered = render_structural_page(
            source_start,
            markdown,
            &context_before,
            self.path().parent(),
        );
        if rendered.html.len() > self.limits.maximum_page_output_bytes {
            return Err(
                "the structural layout page exceeds Lumen's bounded output limit".to_owned(),
            );
        }
        let page = LayoutPage::new(rendered.source_start, rendered.source_end)
            .ok_or_else(|| "the layout-page planner produced an empty range".to_owned())?;
        let page = PreparedLayoutPage {
            page,
            source_start: page.source_start(),
            source_end: page.source_end(),
            structural_html: rendered.html,
            enriched_html: None,
            context_before,
            context_after: rendered.context_after,
        };
        self.record_layout_page(page.page)?;
        self.cache_page(page.clone());
        Ok(page)
    }

    fn record_layout_page(&mut self, page: LayoutPage) -> Result<(), String> {
        if self.page_directory.page_by_id(page.id()).is_some() {
            return Ok(());
        }
        if page.source_start() != self.page_directory.known_through() {
            return Ok(());
        }
        let page_directory_bytes = self
            .page_directory
            .pages()
            .len()
            .saturating_add(1)
            .saturating_mul(std::mem::size_of::<LayoutPage>());
        if page_directory_bytes > self.limits.layout_page_directory_bytes {
            return Err(
                "the layout-page directory exceeded Lumen's bounded page budget".to_owned(),
            );
        }
        self.page_directory.append(page).map_err(ToOwned::to_owned)
    }

    fn cache_page(&mut self, page: PreparedLayoutPage) {
        self.prepared_html_bytes = self
            .prepared_html_bytes
            .saturating_add(page.estimated_html_bytes());
        self.prepared_pages.push_back(page);
        self.trim_cached_pages();
    }

    fn trim_cached_pages(&mut self) {
        while self.prepared_pages.len() > self.limits.visible_page_count
            || self.prepared_html_bytes > self.limits.prepared_html_bytes
        {
            let Some(expired) = self.prepared_pages.pop_front() else {
                break;
            };
            self.prepared_html_bytes = self
                .prepared_html_bytes
                .saturating_sub(expired.estimated_html_bytes());
        }
    }

    fn replace_cached_page(&mut self, replacement: PreparedLayoutPage) {
        let Some(index) = self
            .prepared_pages
            .iter()
            .position(|prepared_page| prepared_page.page.id() == replacement.page.id())
        else {
            return;
        };
        let previous = std::mem::replace(&mut self.prepared_pages[index], replacement);
        self.prepared_html_bytes = self
            .prepared_html_bytes
            .saturating_sub(previous.estimated_html_bytes())
            .saturating_add(self.prepared_pages[index].estimated_html_bytes());
        self.trim_cached_pages();
    }

    fn ensure_loading_allowed(&self) -> Result<(), String> {
        self.frozen_error.clone().map_or(Ok(()), Err)
    }

    fn freeze_file_errors<T>(&mut self, result: &Result<T, String>) {
        let Err(error) = result else {
            return;
        };
        self.freeze_file_error(error);
    }

    fn freeze_file_error(&mut self, error: &str) {
        if error.starts_with("failed to read the document:")
            || error == "the document changed while it was being read"
        {
            self.frozen_error = Some(error.to_owned());
        }
    }

    #[cfg(test)]
    fn complete_index_for_test(&mut self) {
        let identity = self.source.identity();
        let mut source = DocumentSource::open(self.path().to_path_buf(), self.limits).unwrap();
        let mut index = DocumentIndex::new(self.limits);
        while !index.scan_step(&mut source).unwrap() {}
        assert!(self.adopt_completed_index(identity, index).unwrap());
    }
}

#[cfg(test)]
mod tests {
    use super::{LayoutPageDocument, PreparedLayoutPage};
    use crate::{
        document_work::{
            CompletedEnrichment, DocumentTarget, DocumentWorkOutcome, EnrichmentTarget, enrich_page,
        },
        layout_page_limits::LayoutPageLimits,
        layout_page_renderer::LayoutPageContext,
    };
    use std::{
        env, fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMPORARY_DOCUMENT_ID: AtomicU64 = AtomicU64::new(0);

    fn temporary_document(contents: &str) -> PathBuf {
        let identifier = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEMPORARY_DOCUMENT_ID.fetch_add(1, Ordering::Relaxed);
        let directory = env::temp_dir().join(format!(
            "lumen-layout-page-document-{}-{identifier}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.md");
        fs::write(&path, contents).unwrap();
        path
    }

    fn enrich(document: &mut LayoutPageDocument, page: &PreparedLayoutPage) -> PreparedLayoutPage {
        let (definition_generation, definitions) = document.definition_snapshot();
        let target = EnrichmentTarget {
            document: DocumentTarget {
                tab_id: 1,
                tab_revision: 1,
                path: document.path().to_path_buf(),
                identity: document.source_identity(),
                limits: document.limits(),
            },
            source_start: page.source_start,
            source_end: page.source_end,
            page_id: page.page_id(),
            context_before: page.context_before(),
            context_after: page.context_after(),
            definition_generation,
            definitions,
        };
        let DocumentWorkOutcome::CompletedEnrichment(completed) = enrich_page(target) else {
            panic!("enrichment should complete");
        };
        let CompletedEnrichment { target, html } = *completed;
        document
            .accept_enrichment(
                target.page_id,
                target.source_start,
                target.source_end,
                target.definition_generation,
                html,
            )
            .unwrap()
            .expect("prepared layout page should accept enrichment")
    }

    #[test]
    fn prepares_and_bounds_the_initial_layout_page() {
        let path = temporary_document(&"paragraph\n\n".repeat(128));
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 64,
            maximum_page_output_bytes: 1024,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();

        let first = document.initial_layout_page().unwrap();

        assert!(first.source_end <= 64);
        assert!(first.html().contains("paragraph"));
        assert_eq!(document.layout_page_count(), 1);
        assert_eq!(document.page_directory.known_through(), first.source_end);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn bounds_prepared_pages_under_sequential_cache_pressure() {
        let path = temporary_document(&"paragraph\n\n".repeat(256));
        let limits = LayoutPageLimits {
            visible_page_count: 2,
            prepared_html_bytes: 512,
            maximum_page_input_bytes: 32,
            maximum_source_read_bytes: 32,
            maximum_page_output_bytes: 256,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        document.complete_index_for_test();
        for source_offset in (0..document.length()).step_by(32) {
            document
                .layout_page_window_for_source_offset(source_offset)
                .unwrap();
        }

        assert!(document.prepared_pages.len() <= limits.visible_page_count);
        assert!(document.prepared_html_bytes <= limits.prepared_html_bytes);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn defers_a_noninitial_seek_until_the_directory_is_ready() {
        let path = temporary_document(&"paragraph\n\n".repeat(100));
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 64,
            maximum_page_input_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();

        assert!(!document.index_is_complete());
        assert_eq!(
            document
                .layout_page_window_for_source_offset(256)
                .unwrap_err(),
            "the layout-page directory is still indexing"
        );
        let initial = document.layout_page_window_for_source_offset(0).unwrap();
        assert_eq!(initial.len(), 1);
        assert!(initial[0].html().contains("paragraph"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn terminal_seek_uses_a_readable_final_layout_page() {
        let path = temporary_document(&"Mixed section\n\n".repeat(128));
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        document.complete_index_for_test();

        let page = document
            .layout_page_window_for_source_offset(u64::MAX)
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(page.source_end, document.length());
        assert!(page.html().contains("Mixed section"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn returns_a_source_ordered_directory_window_for_an_indexed_seek() {
        let path = temporary_document(&"paragraph\n\n".repeat(256));
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 64,
            visible_page_count: 3,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        document.complete_index_for_test();

        let window = document.layout_page_window_for_source_offset(512).unwrap();

        assert!(window.len() >= 2);
        assert!(window.windows(2).all(|pair| {
            pair[0].source_end == pair[1].source_start && pair[0].page_id() != pair[1].page_id()
        }));
        assert!(
            window
                .iter()
                .any(|page| page.source_start <= 512 && 512 < page.source_end)
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn keeps_terminal_whitespace_out_of_the_initial_page_identity() {
        let path = temporary_document("Visible content.\n\n     ");
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 16,
            maximum_source_read_bytes: 16,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();

        let page = document.initial_layout_page().unwrap();

        assert!(page.source_end < document.length());
        assert!(page.html().contains("Visible content"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn terminal_seek_includes_content_after_the_last_blank_boundary() {
        let path = temporary_document(&format!("{}Final heading.\n", "Body.\n\n".repeat(64)));
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        document.complete_index_for_test();

        let page = document
            .layout_page_window_for_source_offset(u64::MAX)
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(page.source_end, document.length());
        assert!(page.html().contains("Final heading"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn terminal_seek_ignores_a_cached_layout_page_that_ends_before_eof() {
        let path = temporary_document(&format!("{}Final heading.\n", "Body.\n\n".repeat(80)));
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 128,
            maximum_source_read_bytes: 128,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        document.complete_index_for_test();

        let terminal_start = document.length() - 64;
        let cached = document
            .prepare_layout_page(terminal_start - 100, LayoutPageContext::default())
            .unwrap();
        assert!(cached.source_start <= terminal_start);
        assert!(cached.source_end > terminal_start);
        assert!(cached.source_end < document.length());

        let page = document
            .layout_page_window_for_source_offset(u64::MAX)
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(page.source_end, document.length());
        assert!(page.html().contains("Final heading"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn canonical_page_context_renders_a_table_continuation() {
        let path = temporary_document(
            "Before the table.\n\n| Metric | Observation |\n| --- | --- |\n| Render | Static content |\n| View | Local only |\n\nAfter the table.\n",
        );
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        document.complete_index_for_test();

        let table_row_offset =
            u64::try_from("Before the table.\n\n| Metric | Observation |\n| --- | --- |\n".len())
                .unwrap();
        let page = document
            .layout_page_window_for_source_offset(table_row_offset)
            .unwrap()
            .into_iter()
            .find(|page| {
                page.source_start <= table_row_offset && table_row_offset < page.source_end
            })
            .unwrap();

        assert!(page.html().contains("<table>"));
        assert!(!page.html().starts_with("<p>| --- | --- |"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn references_local_images_without_embedding_binary_data() {
        let path = temporary_document("![Screenshot](screenshot.gif)\n");
        fs::write(path.parent().unwrap().join("screenshot.gif"), []).unwrap();
        let mut document =
            LayoutPageDocument::open(path.clone(), LayoutPageLimits::default()).unwrap();

        let page = document.initial_layout_page().unwrap();

        assert!(page.html().contains("data:application/x-lumen-asset,"));
        assert!(!page.html().contains("base64,"));
        assert!(
            page.html().len() <= document.limits.maximum_page_output_bytes,
            "embedded image output must remain within the layout-page budget"
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn keeps_tiny_embedded_images_bounded() {
        let embedded_gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
        let path = temporary_document(&format!("![Tiny embedded image]({embedded_gif})\n"));
        let mut document =
            LayoutPageDocument::open(path.clone(), LayoutPageLimits::default()).unwrap();

        let page = document.initial_layout_page().unwrap();

        assert!(page.html().contains(embedded_gif));
        assert!(
            page.html().len() <= document.limits.maximum_page_output_bytes,
            "an embedded image must remain within the layout-page budget"
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn enriches_a_supported_fence_without_changing_its_source_range() {
        let path = temporary_document("```rust\npub fn lumen() {}\n```\n");
        let mut document =
            LayoutPageDocument::open(path.clone(), LayoutPageLimits::default()).unwrap();

        let structural = document.initial_layout_page().unwrap();
        let enriched = enrich(&mut document, &structural);

        assert_eq!(enriched.source_start, structural.source_start);
        assert_eq!(enriched.source_end, structural.source_end);
        assert!(enriched.html().contains("syntax-keyword"));
        assert!(enriched.structural_html.is_empty());
        assert!(document.prepared_html_bytes <= document.limits.prepared_html_bytes);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn enriches_each_supported_fence_after_a_structural_first_paint() {
        let cases = [
            ("html", "<main>Lumen</main>"),
            ("css", "main { color: #0284c7; }"),
            ("javascript", "const lumen = 1;"),
            ("typescript", "interface Lumen { name: string; }"),
            ("c", "int main(void) { return 0; }"),
            ("cpp", "class Lumen {};"),
            ("rust", "pub fn lumen() {}"),
            ("python", "def lumen():\n    return True"),
        ];

        for (language, source) in cases {
            let path = temporary_document(&format!("```{language}\n{source}\n```\n"));
            let mut document =
                LayoutPageDocument::open(path.clone(), LayoutPageLimits::default()).unwrap();
            let structural = document.initial_layout_page().unwrap();
            let enriched = enrich(&mut document, &structural);

            assert!(!structural.html().contains("syntax-"));
            assert!(
                enriched.html().contains("syntax-"),
                "{language} should be highlighted"
            );
            assert_eq!(enriched.source_start, structural.source_start);
            assert_eq!(enriched.source_end, structural.source_end);
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn freezes_new_loading_after_the_source_disappears() {
        let path = temporary_document(&"paragraph\n\n".repeat(100_000));
        let mut document =
            LayoutPageDocument::open(path.clone(), LayoutPageLimits::default()).unwrap();
        let first = document.initial_layout_page().unwrap();
        document.complete_index_for_test();
        let unloaded_offset = first.source_end.saturating_add(1);
        fs::remove_file(&path).unwrap();

        let first_error = document
            .layout_page_window_for_source_offset(unloaded_offset)
            .unwrap_err();
        fs::write(&path, "restored source").unwrap();
        let second_error = document
            .layout_page_window_for_source_offset(unloaded_offset)
            .unwrap_err();

        assert_eq!(second_error, first_error);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn enriches_references_after_the_bounded_index_completes() {
        let path = temporary_document(
            "Read [the target][later].\n\nPadding paragraph.\n\n[later]: https://example.test/target\n",
        );
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 32,
            maximum_source_read_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        let page = document.initial_layout_page().unwrap();
        document.complete_index_for_test();

        let enriched = enrich(&mut document, &page);

        assert!(enriched.html().contains("https://example.test/target"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn enriches_late_reference_and_footnote_definitions_after_indexing() {
        let path = temporary_document(
            "Read [the target][later] and this note[^detail].\n\nPadding paragraph.\n\nPadding paragraph.\n\n[later]: https://example.test/target\n[^detail]: Footnote text from the document tail.\n",
        );
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        let page = document.initial_layout_page().unwrap();

        let provisional = enrich(&mut document, &page);
        assert!(!provisional.html().contains("https://example.test/target"));
        assert!(
            !provisional
                .html()
                .contains("Footnote text from the document tail")
        );

        document.complete_index_for_test();

        let enriched = enrich(&mut document, &page);
        assert!(enriched.html().contains("https://example.test/target"));
        assert!(
            enriched
                .html()
                .contains("Footnote text from the document tail")
        );
        assert!(enriched.html().contains("footnote-reference"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn enriches_a_late_multiline_footnote_definition_after_indexing() {
        let path = temporary_document(
            "Read this note[^detail].\n\nPadding paragraph.\n\n[^detail]: First line from the document tail.\n    Continued footnote detail.\n",
        );
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 48,
            maximum_source_read_bytes: 48,
            ..LayoutPageLimits::default()
        };
        let mut document = LayoutPageDocument::open(path.clone(), limits).unwrap();
        let page = document.initial_layout_page().unwrap();
        document.complete_index_for_test();

        let enriched = enrich(&mut document, &page);

        assert!(
            enriched
                .html()
                .contains("First line from the document tail")
        );
        assert!(enriched.html().contains("Continued footnote detail"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
