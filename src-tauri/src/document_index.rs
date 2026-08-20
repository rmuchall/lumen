use crate::{
    document_source::DocumentSource,
    layout_page::{LayoutPage, LayoutPageDirectory},
    layout_page_limits::LayoutPageLimits,
    layout_page_renderer::{LayoutPageContext, select_layout_page_end},
};
use std::collections::HashMap;

const MAXIMUM_PENDING_LINE_BYTES: usize = 8 * 1024;
const INITIAL_CHECKPOINT_STRIDE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IndexCheckpoint {
    pub(crate) source_offset: u64,
    pub(crate) context: LayoutPageContext,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct IndexedHeading {
    identifier_hash: u64,
    source_offset: u64,
}

#[derive(Clone)]
pub(crate) struct DocumentIndex {
    checkpoints: Vec<IndexCheckpoint>,
    layout_page_context: LayoutPageContext,
    layout_page_context_bytes: usize,
    layout_page_contexts: Vec<LayoutPageContext>,
    layout_page_directory: LayoutPageDirectory,
    context: LayoutPageContext,
    next_checkpoint_at: u64,
    checkpoint_stride: u64,
    indexed_through: u64,
    pending_line: String,
    pending_line_start: Option<u64>,
    oversized_pending_line: bool,
    markdown_definitions: Vec<String>,
    markdown_definition_bytes: usize,
    continuing_markdown_definition: bool,
    headings: Vec<IndexedHeading>,
    heading_bytes: usize,
    heading_identifier_counts: HashMap<u64, usize>,
    heading_metadata_capped: bool,
    limits: LayoutPageLimits,
}

impl DocumentIndex {
    pub(crate) fn new(limits: LayoutPageLimits) -> Self {
        Self {
            checkpoints: vec![IndexCheckpoint {
                source_offset: 0,
                context: LayoutPageContext::default(),
            }],
            layout_page_context: LayoutPageContext::default(),
            layout_page_context_bytes: 0,
            layout_page_contexts: Vec::new(),
            layout_page_directory: LayoutPageDirectory::default(),
            context: LayoutPageContext::default(),
            next_checkpoint_at: INITIAL_CHECKPOINT_STRIDE_BYTES,
            checkpoint_stride: INITIAL_CHECKPOINT_STRIDE_BYTES,
            indexed_through: 0,
            pending_line: String::new(),
            pending_line_start: None,
            oversized_pending_line: false,
            markdown_definitions: Vec::new(),
            markdown_definition_bytes: 0,
            continuing_markdown_definition: false,
            headings: Vec::new(),
            heading_bytes: 0,
            heading_identifier_counts: HashMap::new(),
            heading_metadata_capped: false,
            limits,
        }
    }

    pub(crate) fn is_complete(&self, source_length: u64) -> bool {
        self.indexed_through >= source_length
    }

    pub(crate) fn layout_page_directory(&self) -> &LayoutPageDirectory {
        &self.layout_page_directory
    }

    pub(crate) fn layout_page_context(&self, page: LayoutPage) -> Option<LayoutPageContext> {
        let index = self
            .layout_page_directory
            .pages()
            .iter()
            .position(|candidate| candidate.id() == page.id())?;
        self.layout_page_contexts.get(index).cloned()
    }

    pub(crate) fn layout_page_at_source_offset(&self, source_offset: u64) -> Option<LayoutPage> {
        self.layout_page_directory
            .page_at_source_offset(source_offset)
    }

    #[cfg(debug_assertions)]
    pub(crate) fn agent_observation_counts(&self) -> (u64, u64, u64, u64) {
        (
            self.indexed_through,
            u64::try_from(self.checkpoints.len()).unwrap_or(u64::MAX),
            u64::try_from(self.checkpoint_bytes()).unwrap_or(u64::MAX),
            u64::try_from(self.layout_page_directory.pages().len()).unwrap_or(u64::MAX),
        )
    }

    pub(crate) fn markdown_definitions(&self, source_length: u64) -> Option<&[String]> {
        self.is_complete(source_length)
            .then_some(&self.markdown_definitions)
    }

    pub(crate) fn heading_offset(&self, source_length: u64, identifier: &str) -> Option<u64> {
        let identifier_hash = heading_identifier_hash(identifier);
        self.is_complete(source_length).then(|| {
            self.headings
                .iter()
                .find(|heading| heading.identifier_hash == identifier_hash)
                .map(|heading| heading.source_offset)
        })?
    }

    pub(crate) fn scan_step(&mut self, source: &mut DocumentSource) -> Result<bool, String> {
        if self.is_complete(source.length()) {
            return Ok(true);
        }
        let range = source
            .read_range(self.indexed_through, self.limits.maximum_source_read_bytes)
            .map_err(|error| error.to_string())?;
        if range.end <= self.indexed_through {
            return Err("the document indexer did not make progress".to_owned());
        }
        self.consume_range(range.start, &range.text);
        self.indexed_through = range.end;
        self.plan_layout_pages(source)?;
        if self.is_complete(source.length()) && !self.oversized_pending_line {
            let line = std::mem::take(&mut self.pending_line);
            if !line.is_empty() {
                let line_start = self
                    .pending_line_start
                    .take()
                    .unwrap_or(self.indexed_through);
                self.context.advance_metadata_line(&line);
                self.capture_markdown_definition(&line);
                self.capture_heading(&line, line_start);
            }
        }
        Ok(self.is_complete(source.length()))
    }

    fn plan_layout_pages(&mut self, source: &mut DocumentSource) -> Result<(), String> {
        while self.layout_page_directory.known_through() < self.indexed_through {
            let source_start = self.layout_page_directory.known_through();
            let remaining_indexed = self.indexed_through.saturating_sub(source_start);
            let maximum_page_input =
                u64::try_from(self.limits.maximum_page_input_bytes).unwrap_or(u64::MAX);
            if remaining_indexed < maximum_page_input && self.indexed_through < source.length() {
                break;
            }
            let context_before = self.layout_page_context.clone();
            let page_directory_bytes = self
                .layout_page_directory
                .pages()
                .len()
                .saturating_add(1)
                .saturating_mul(std::mem::size_of::<LayoutPage>())
                .saturating_add(self.layout_page_context_bytes)
                .saturating_add(context_before.estimated_bytes());
            if page_directory_bytes > self.limits.layout_page_directory_bytes {
                return Err(
                    "the layout-page directory exceeded Lumen's bounded page budget".to_owned(),
                );
            }
            let read_length = usize::try_from(remaining_indexed)
                .unwrap_or(usize::MAX)
                .min(self.limits.maximum_page_input_bytes);
            let range = source
                .read_range(source_start, read_length)
                .map_err(|error| error.to_string())?;
            if range.start != source_start || range.end <= source_start {
                return Err("the layout-page planner did not make progress".to_owned());
            }
            let source_length = if range.end >= source.length() {
                range.text.len()
            } else {
                select_layout_page_end(
                    &self.layout_page_context,
                    &range.text,
                    self.limits.maximum_page_input_bytes,
                )
            };
            if source_length == 0 {
                return Err("the layout-page planner selected an empty range".to_owned());
            }
            let markdown = &range.text[..source_length];
            self.layout_page_context.advance(markdown);
            let source_end =
                source_start.saturating_add(u64::try_from(source_length).unwrap_or(u64::MAX));
            let page = LayoutPage::new(source_start, source_end)
                .ok_or_else(|| "the layout-page planner produced an empty range".to_owned())?;
            self.layout_page_directory
                .append(page)
                .map_err(ToOwned::to_owned)?;
            self.layout_page_context_bytes = self
                .layout_page_context_bytes
                .saturating_add(context_before.estimated_bytes());
            self.layout_page_contexts.push(context_before);
        }
        Ok(())
    }

    fn consume_range(&mut self, source_start: u64, text: &str) {
        let mut line_start = source_start;
        for line in text.split_inclusive('\n') {
            let line_end = line_start + u64::try_from(line.len()).unwrap_or(u64::MAX);
            if line.ends_with('\n') {
                self.consume_complete_line(line, line_start);
                self.maybe_add_checkpoint(line_end);
            } else {
                self.consume_partial_line(line, line_start);
            }
            line_start = line_end;
        }
    }

    fn consume_partial_line(&mut self, line: &str, line_start: u64) {
        if self.oversized_pending_line {
            return;
        }
        if self.pending_line.len().saturating_add(line.len()) > MAXIMUM_PENDING_LINE_BYTES {
            self.pending_line.clear();
            self.pending_line_start = None;
            self.oversized_pending_line = true;
            return;
        }
        if self.pending_line.is_empty() {
            self.pending_line_start = Some(line_start);
        }
        self.pending_line.push_str(line);
    }

    fn consume_complete_line(&mut self, line: &str, line_start: u64) {
        if self.oversized_pending_line {
            self.oversized_pending_line = false;
            return;
        }
        if self.pending_line.is_empty() {
            let was_inside_fence = self.context.is_inside_fence();
            self.context.advance_metadata_line(line);
            if !was_inside_fence {
                self.capture_markdown_definition(line);
                self.capture_heading(line, line_start);
            }
            return;
        }
        self.pending_line.push_str(line);
        let was_inside_fence = self.context.is_inside_fence();
        self.context.advance_metadata_line(&self.pending_line);
        let completed_line = std::mem::take(&mut self.pending_line);
        let completed_line_start = self.pending_line_start.take().unwrap_or(line_start);
        if !was_inside_fence {
            self.capture_markdown_definition(&completed_line);
            self.capture_heading(&completed_line, completed_line_start);
        }
    }

    fn maybe_add_checkpoint(&mut self, source_offset: u64) {
        if source_offset < self.next_checkpoint_at {
            return;
        }
        self.checkpoints.push(IndexCheckpoint {
            source_offset,
            context: self.context.clone(),
        });
        self.next_checkpoint_at = source_offset.saturating_add(self.checkpoint_stride);
        self.reduce_checkpoint_density();
    }

    fn reduce_checkpoint_density(&mut self) {
        while (self.checkpoint_bytes() > self.limits.index_bytes
            || self.checkpoints.len() > self.limits.index_checkpoint_count)
            && self.checkpoints.len() > 1
        {
            self.checkpoint_stride = self.checkpoint_stride.saturating_mul(2);
            self.checkpoints = self
                .checkpoints
                .iter()
                .enumerate()
                .filter_map(|(index, checkpoint)| {
                    (index == 0 || index % 2 == 0).then_some(checkpoint.clone())
                })
                .collect();
        }
    }

    fn checkpoint_bytes(&self) -> usize {
        self.checkpoints.iter().fold(
            self.markdown_definition_bytes
                .saturating_add(self.heading_bytes),
            |total, checkpoint| {
                total
                    .saturating_add(std::mem::size_of::<IndexCheckpoint>())
                    .saturating_add(checkpoint.context.estimated_bytes())
            },
        )
    }

    fn capture_markdown_definition(&mut self, line: &str) {
        let line = line.trim_end_matches(['\r', '\n']);
        if self.continuing_markdown_definition && is_definition_continuation(line) {
            self.continuing_markdown_definition = self.append_markdown_definition_line(line);
            return;
        }
        self.continuing_markdown_definition = false;
        let Some(closing_bracket) = line.find("]:") else {
            return;
        };
        if !line.starts_with('[') || closing_bracket <= 1 {
            return;
        }
        self.continuing_markdown_definition = self.append_markdown_definition_line(line);
    }

    fn append_markdown_definition_line(&mut self, line: &str) -> bool {
        let definition_bytes = line.len().saturating_add(1);
        if self
            .markdown_definition_bytes
            .saturating_add(definition_bytes)
            > self.limits.index_bytes / 2
            || self.checkpoint_bytes().saturating_add(definition_bytes) > self.limits.index_bytes
        {
            return false;
        }
        if self.continuing_markdown_definition {
            let Some(definition) = self.markdown_definitions.last_mut() else {
                return false;
            };
            definition.push('\n');
            definition.push_str(line);
        } else {
            self.markdown_definitions.push(line.to_owned());
        }
        self.markdown_definition_bytes = self
            .markdown_definition_bytes
            .saturating_add(definition_bytes);
        self.reduce_checkpoint_density();
        true
    }

    fn capture_heading(&mut self, line: &str, source_offset: u64) {
        if self.heading_metadata_capped {
            return;
        }
        let Some(base_identifier) = heading_identifier(line) else {
            return;
        };
        let base_identifier_hash = heading_identifier_hash(&base_identifier);
        let duplicate_count = *self
            .heading_identifier_counts
            .get(&base_identifier_hash)
            .unwrap_or(&0);
        let identifier = if duplicate_count == 0 {
            base_identifier
        } else {
            format!("{base_identifier}-{duplicate_count}")
        };
        let identifier_hash = heading_identifier_hash(&identifier);
        let heading_bytes = std::mem::size_of::<IndexedHeading>()
            .saturating_add(std::mem::size_of::<(u64, usize)>().saturating_mul(2));
        if self.checkpoint_bytes().saturating_add(heading_bytes) > self.limits.index_bytes {
            self.heading_metadata_capped = true;
            return;
        }
        self.headings.push(IndexedHeading {
            identifier_hash,
            source_offset,
        });
        self.heading_identifier_counts
            .insert(base_identifier_hash, duplicate_count.saturating_add(1));
        self.heading_bytes = self.heading_bytes.saturating_add(heading_bytes);
        self.reduce_checkpoint_density();
    }
}

fn is_definition_continuation(line: &str) -> bool {
    line.starts_with('\t') || line.starts_with("    ")
}

fn heading_identifier_hash(identifier: &str) -> u64 {
    identifier
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

fn heading_identifier(line: &str) -> Option<String> {
    let line = line.trim_end_matches(['\r', '\n']);
    let content = line.trim_start_matches(' ');
    if line.len().saturating_sub(content.len()) > 3 {
        return None;
    }
    let marker_count = content
        .chars()
        .take_while(|character| *character == '#')
        .count();
    let after_marker = content.get(marker_count..)?;
    if marker_count == 0
        || marker_count > 6
        || after_marker
            .chars()
            .next()
            .is_none_or(|character| !character.is_whitespace())
    {
        return None;
    }
    let title = after_marker.trim().trim_end_matches('#').trim_end();
    let mut identifier = String::new();
    let mut pending_separator = false;
    for character in title.chars() {
        if character.is_alphanumeric() || character == '-' {
            if pending_separator && !identifier.is_empty() {
                identifier.push('-');
            }
            pending_separator = false;
            identifier.extend(character.to_lowercase());
        } else if character.is_whitespace() {
            pending_separator = !identifier.is_empty();
        }
    }
    Some(if identifier.is_empty() {
        "section".to_owned()
    } else {
        identifier
    })
}

#[cfg(test)]
mod tests {
    use super::DocumentIndex;
    use crate::{document_source::DocumentSource, layout_page_limits::LayoutPageLimits};
    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_document(contents: &str) -> PathBuf {
        let identifier = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = env::temp_dir().join(format!("lumen-document-index-{identifier}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.md");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn indexes_incrementally_with_a_complete_layout_page_directory() {
        let path = temporary_document("Before.\n\n```rust\nlet value = 1;\n\nAfter.\n");
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 16,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert!(index.is_complete(source.length()));
        assert_eq!(
            index.layout_page_directory().known_through(),
            source.length()
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn keeps_checkpoint_memory_within_the_configured_budget() {
        let contents = "paragraph\n\n".repeat(512);
        let path = temporary_document(&contents);
        let limits = LayoutPageLimits {
            index_bytes: 128,
            maximum_source_read_bytes: 32,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert!(index.checkpoint_bytes() <= limits.index_bytes);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn caps_checkpoint_count_independently_of_the_memory_budget() {
        let contents = "paragraph\n\n".repeat(100_000);
        let path = temporary_document(&contents);
        let limits = LayoutPageLimits {
            index_checkpoint_count: 2,
            maximum_source_read_bytes: 4096,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert!(index.checkpoints.len() <= limits.index_checkpoint_count);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn bounds_heading_metadata_with_the_index_budget() {
        let contents = (0..512)
            .map(|index| format!("# Heading {index}\n\n"))
            .collect::<String>();
        let path = temporary_document(&contents);
        let limits = LayoutPageLimits {
            index_bytes: 256,
            maximum_source_read_bytes: 32,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert!(index.checkpoint_bytes() <= limits.index_bytes);
        assert!(index.headings.len() < 512);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn stops_parsing_dense_headings_after_the_metadata_budget_is_full() {
        let contents = (0..8_192)
            .map(|index| format!("# Distinct heading {index}\n\n"))
            .collect::<String>();
        let path = temporary_document(&contents);
        let limits = LayoutPageLimits {
            index_bytes: 256,
            maximum_source_read_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert!(index.heading_metadata_capped);
        assert!(index.checkpoint_bytes() <= limits.index_bytes);
        assert!(index.heading_identifier_counts.len() < 8_192);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn indexes_heading_anchors_across_read_boundaries() {
        let contents = "# First section\n\nBody.\n\n## First section\n\n### 東京 notes\n";
        let path = temporary_document(contents);
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 9,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert_eq!(
            index.heading_offset(source.length(), "first-section"),
            Some(0)
        );
        assert_eq!(
            index.heading_offset(source.length(), "first-section-1"),
            Some(24)
        );
        assert_eq!(
            index.heading_offset(source.length(), "東京-notes"),
            Some(42)
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn ignores_heading_and_definition_lookalikes_inside_fences() {
        let contents = "```markdown\n# Not a heading\n[not-a-definition]: https://example.test\n```\n\n# Real heading\n[real-definition]: https://example.test\n";
        let path = temporary_document(contents);
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 11,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        assert_eq!(index.heading_offset(source.length(), "not-a-heading"), None);
        assert_eq!(
            index.heading_offset(source.length(), "real-heading"),
            Some(74)
        );
        let definitions = index.markdown_definitions(source.length()).unwrap();
        assert_eq!(definitions, ["[real-definition]: https://example.test"]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn builds_a_contiguous_layout_page_directory_independent_of_index_read_size() {
        let contents = "paragraph with reader-visible text\n\n".repeat(256);
        let path = temporary_document(&contents);
        let limits = LayoutPageLimits {
            maximum_page_input_bytes: 64,
            maximum_source_read_bytes: 11,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut index = DocumentIndex::new(limits);

        while !index.scan_step(&mut source).unwrap() {}

        let pages = index.layout_page_directory().pages();
        assert!(!pages.is_empty());
        assert_eq!(index.layout_page_contexts.len(), pages.len());
        assert_eq!(pages.first().map(|page| page.source_start()), Some(0));
        assert_eq!(
            pages.last().map(|page| page.source_end()),
            Some(source.length())
        );
        assert!(
            pages
                .windows(2)
                .all(|pair| pair[0].source_end() == pair[1].source_start())
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
