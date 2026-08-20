use crate::markdown::render_markdown_structural;
use std::path::Path;

/// Continuation state is directory metadata, never an unbounded second copy of
/// document source. Oversized single lines still make progress as bounded page
/// fragments, but they deliberately do not become continuation context.
const MAXIMUM_CONTINUATION_CONTEXT_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct FenceContext {
    marker: char,
    marker_count: usize,
    info: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TableContext {
    alignment: String,
    header: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ListContext {
    marker: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct QuoteContext {
    prefix: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct LayoutPageContext {
    fence: Option<Box<FenceContext>>,
    list: Option<Box<ListContext>>,
    pending_table_header: Option<String>,
    quote: Option<Box<QuoteContext>>,
    table: Option<Box<TableContext>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StructuralLayoutPage {
    pub(crate) source_start: u64,
    pub(crate) source_end: u64,
    pub(crate) html: String,
    pub(crate) context_after: LayoutPageContext,
}

impl LayoutPageContext {
    pub(crate) fn is_inside_fence(&self) -> bool {
        self.fence.is_some()
    }

    pub(crate) fn advance(&mut self, markdown: &str) {
        for line in markdown.split_inclusive('\n') {
            self.advance_line(line);
        }
    }

    pub(crate) fn advance_line(&mut self, line: &str) {
        let line = line.trim_end_matches(['\r', '\n']);
        let was_inside_fence = self.fence.is_some();
        let Some((marker, marker_count, info)) = fence_marker(line) else {
            if !was_inside_fence {
                self.advance_quote(line);
                self.advance_list(line);
                self.advance_table(line);
            }
            return;
        };
        let Some(active_fence) = &self.fence else {
            if info.len() > MAXIMUM_CONTINUATION_CONTEXT_BYTES {
                self.clear_table_context();
                return;
            }
            self.fence = Some(Box::new(FenceContext {
                marker,
                marker_count,
                info: info.to_owned(),
            }));
            self.clear_table_context();
            return;
        };
        if active_fence.marker == marker
            && marker_count >= active_fence.marker_count
            && info.trim().is_empty()
        {
            self.fence = None;
        }
        self.clear_table_context();
    }

    /// Advances the fence state needed by metadata discovery without building
    /// presentation-only quote, list, or table continuation state.
    pub(crate) fn advance_metadata_line(&mut self, line: &str) {
        let line = line.trim_end_matches(['\r', '\n']);
        let Some((marker, marker_count, info)) = fence_marker(line) else {
            return;
        };
        let Some(active_fence) = &self.fence else {
            if info.len() <= MAXIMUM_CONTINUATION_CONTEXT_BYTES {
                self.fence = Some(Box::new(FenceContext {
                    marker,
                    marker_count,
                    info: info.to_owned(),
                }));
            }
            return;
        };
        if active_fence.marker == marker
            && marker_count >= active_fence.marker_count
            && info.trim().is_empty()
        {
            self.fence = None;
        }
    }

    pub(crate) fn estimated_bytes(&self) -> usize {
        let fence_bytes = self.fence.as_ref().map_or(0, |fence| {
            std::mem::size_of::<FenceContext>().saturating_add(fence.info.len())
        });
        let table_bytes = self.table.as_ref().map_or(0, |table| {
            std::mem::size_of::<TableContext>()
                .saturating_add(table.header.len())
                .saturating_add(table.alignment.len())
        });
        let list_bytes = self.list.as_ref().map_or(0, |list| {
            std::mem::size_of::<ListContext>().saturating_add(list.marker.len())
        });
        let pending_header_bytes = self.pending_table_header.as_ref().map_or(0, String::len);
        let quote_bytes = self.quote.as_ref().map_or(0, |quote| {
            std::mem::size_of::<QuoteContext>().saturating_add(quote.prefix.len())
        });
        std::mem::size_of::<Self>()
            .saturating_add(fence_bytes)
            .saturating_add(table_bytes)
            .saturating_add(list_bytes)
            .saturating_add(pending_header_bytes)
            .saturating_add(quote_bytes)
    }

    fn advance_table(&mut self, line: &str) {
        if self.table.is_some() {
            if is_table_row(line) {
                self.pending_table_header = None;
                return;
            }
            self.table = None;
        }
        if is_table_alignment(line)
            && let Some(header) = self.pending_table_header.take()
            && is_table_row(&header)
            && header.len().saturating_add(line.len()) <= MAXIMUM_CONTINUATION_CONTEXT_BYTES
        {
            self.table = Some(Box::new(TableContext {
                alignment: line.to_owned(),
                header,
            }));
            return;
        }
        self.pending_table_header = (is_table_row(line)
            && line.len() <= MAXIMUM_CONTINUATION_CONTEXT_BYTES)
            .then(|| line.to_owned());
    }

    fn clear_table_context(&mut self) {
        self.pending_table_header = None;
        self.table = None;
    }

    fn advance_list(&mut self, line: &str) {
        if let Some(marker) = list_marker(line)
            && marker.len() <= MAXIMUM_CONTINUATION_CONTEXT_BYTES
        {
            self.list = Some(Box::new(ListContext { marker }));
            return;
        }
        if line.trim().is_empty() || list_marker(line).is_some() {
            self.list = None;
        }
    }

    fn advance_quote(&mut self, line: &str) {
        self.quote = quote_prefix(line)
            .filter(|prefix| prefix.len() <= MAXIMUM_CONTINUATION_CONTEXT_BYTES)
            .map(|prefix| Box::new(QuoteContext { prefix }));
    }
}

pub(crate) fn select_layout_page_end(
    context: &LayoutPageContext,
    markdown: &str,
    maximum_bytes: usize,
) -> usize {
    if markdown.is_empty() {
        return 0;
    }

    let capped_end = markdown.len().min(maximum_bytes);
    let capped_end = floor_utf8_boundary(markdown, capped_end);
    let mut candidate = 0;
    let mut line_boundary = 0;
    let mut safe_boundary = 0;
    let mut scanned_context = context.clone();
    for line in markdown[..capped_end].split_inclusive('\n') {
        candidate += line.len();
        scanned_context.advance_line(line);
        if line.ends_with('\n') {
            line_boundary = candidate;
            if scanned_context.fence.is_none() && line.trim().is_empty() {
                safe_boundary = candidate;
            }
        }
    }

    if safe_boundary > 0 {
        return safe_boundary;
    }
    if line_boundary > 0 {
        return line_boundary;
    }
    capped_end
}

pub(crate) fn render_structural_page(
    source_start: u64,
    markdown: &str,
    context_before: &LayoutPageContext,
    document_directory: Option<&Path>,
) -> StructuralLayoutPage {
    let mut context_after = context_before.clone();
    context_after.advance(markdown);
    let reconstructed = reconstruct_markdown(context_before, markdown, &context_after);

    StructuralLayoutPage {
        source_start,
        source_end: source_start + u64::try_from(markdown.len()).unwrap_or(u64::MAX),
        html: render_markdown_structural(&reconstructed, document_directory),
        context_after,
    }
}

pub(crate) fn reconstruct_markdown(
    context_before: &LayoutPageContext,
    markdown: &str,
    context_after: &LayoutPageContext,
) -> String {
    let mut reconstructed = String::new();
    if let Some(quote) = &context_before.quote
        && !markdown_starts_with_quote(markdown)
    {
        reconstructed.push_str(&quote.prefix);
        reconstructed.push(' ');
    }
    if let Some(table) = &context_before.table {
        reconstructed.push_str(&table.header);
        reconstructed.push('\n');
        reconstructed.push_str(&table.alignment);
        reconstructed.push('\n');
    }
    if let Some(list) = &context_before.list
        && !markdown_starts_with_list_marker(markdown)
    {
        reconstructed.push_str(&list.marker);
        reconstructed.push(' ');
    }
    if let Some(fence) = &context_before.fence {
        reconstructed.push_str(&fence.marker.to_string().repeat(fence.marker_count));
        if !fence.info.is_empty() {
            reconstructed.push(' ');
            reconstructed.push_str(&fence.info);
        }
        reconstructed.push('\n');
    }
    reconstructed.push_str(markdown);
    if let Some(fence) = &context_after.fence {
        if !reconstructed.ends_with('\n') {
            reconstructed.push('\n');
        }
        reconstructed.push_str(&fence.marker.to_string().repeat(fence.marker_count));
        reconstructed.push('\n');
    }
    reconstructed
}

fn floor_utf8_boundary(markdown: &str, requested_end: usize) -> usize {
    let mut end = requested_end.min(markdown.len());
    while end > 0 && !markdown.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn fence_marker(line: &str) -> Option<(char, usize, &str)> {
    let mut content = line.trim_start_matches(' ');
    if line.len().saturating_sub(content.len()) > 3 {
        return None;
    }
    while let Some(after_quote) = content.strip_prefix('>') {
        content = after_quote.strip_prefix(' ').unwrap_or(after_quote);
        content = content.trim_start_matches(' ');
    }
    let marker = content.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let marker_count = content
        .chars()
        .take_while(|character| *character == marker)
        .count();
    if marker_count < 3 {
        return None;
    }
    Some((marker, marker_count, &content[marker_count..]))
}

fn is_table_row(line: &str) -> bool {
    let content = line.trim();
    !content.is_empty() && content.contains('|')
}

fn is_table_alignment(line: &str) -> bool {
    let content = line.trim().trim_matches('|');
    !content.is_empty()
        && content.split('|').all(|cell| {
            let cell = cell.trim().trim_matches(':');
            !cell.is_empty() && cell.bytes().all(|byte| byte == b'-')
        })
}

fn list_marker(line: &str) -> Option<String> {
    let indentation = line.len().saturating_sub(line.trim_start().len());
    let content = &line[indentation..];
    for marker in ["-", "+", "*"] {
        if content.starts_with(marker) && content.as_bytes().get(marker.len()) == Some(&b' ') {
            return Some(format!("{}{}", " ".repeat(indentation), marker));
        }
    }
    let digits = content.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0
        && content.as_bytes().get(digits) == Some(&b'.')
        && content.as_bytes().get(digits + 1) == Some(&b' ')
    {
        return Some(format!(
            "{}{}.",
            " ".repeat(indentation),
            &content[..digits]
        ));
    }
    None
}

fn markdown_starts_with_list_marker(markdown: &str) -> bool {
    markdown
        .split_inclusive('\n')
        .next()
        .and_then(list_marker)
        .is_some()
}

fn quote_prefix(line: &str) -> Option<String> {
    let mut content = line.trim_start();
    let mut depth = 0;
    while let Some(after_quote) = content.strip_prefix('>') {
        depth += 1;
        content = after_quote
            .strip_prefix(' ')
            .unwrap_or(after_quote)
            .trim_start();
    }
    (depth > 0).then(|| ">".repeat(depth))
}

fn markdown_starts_with_quote(markdown: &str) -> bool {
    markdown
        .split_inclusive('\n')
        .next()
        .and_then(quote_prefix)
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::{
        LayoutPageContext, MAXIMUM_CONTINUATION_CONTEXT_BYTES, render_structural_page,
        select_layout_page_end,
    };

    #[test]
    fn reconstructs_a_fence_that_crosses_a_layout_page_boundary() {
        let markdown = "```rust\npub fn luminance() {\n    println!(\"visible\");\n}\n```\n";
        let split = markdown.find("    println!").unwrap();
        let mut context = LayoutPageContext::default();
        context.advance(&markdown[..split]);

        let page = render_structural_page(0, &markdown[split..], &context, None);

        assert!(page.html.contains("println!"));
        assert!(page.html.contains("<pre><code"));
        assert_eq!(page.context_after, LayoutPageContext::default());
    }

    #[test]
    fn closes_an_incomplete_fence_for_a_readable_first_paint() {
        let markdown = "```python\nprint(\"still loading\")";
        let page = render_structural_page(0, markdown, &LayoutPageContext::default(), None);

        assert!(page.html.contains("still loading"));
        assert!(page.html.contains("<pre><code"));
        assert_ne!(page.context_after, LayoutPageContext::default());
    }

    #[test]
    fn favors_a_blank_line_boundary_outside_a_fence() {
        let markdown = "first paragraph\n\n```rust\nlet value = 1;\n```\n\nsecond paragraph\n";
        let end = select_layout_page_end(&LayoutPageContext::default(), markdown, 40);

        assert_eq!(&markdown[..end], "first paragraph\n\n");
    }

    #[test]
    fn retains_table_context_across_a_bounded_page_boundary() {
        let markdown = concat!(
            "| Name | Value |\n",
            "| --- | --- |\n",
            "| First | Reader-visible content |\n",
            "| Second | More reader-visible content |\n",
        );
        let first_end = select_layout_page_end(&LayoutPageContext::default(), markdown, 64);
        let mut context = LayoutPageContext::default();
        context.advance(&markdown[..first_end]);
        let second = render_structural_page(0, &markdown[first_end..], &context, None);

        assert!(second.html.contains("<table>"));
        assert!(second.html.contains("Name"));
        assert!(second.html.contains("Second"));
    }

    #[test]
    fn does_not_accept_a_partial_table_row_as_a_boundary() {
        let markdown =
            "| Name | Value |\n| --- | --- |\n| A long reader-visible value | More content |\n";
        let end = select_layout_page_end(&LayoutPageContext::default(), markdown, 50);

        assert!(end < 50);
        assert!(markdown[..end].ends_with('\n'));
    }

    #[test]
    fn reopens_an_oversized_ordered_list_item_with_its_original_ordinal() {
        let markdown = "7. ".to_owned() + &"reader-visible continuation ".repeat(128);
        let first_end = select_layout_page_end(&LayoutPageContext::default(), &markdown, 64);
        let mut context = LayoutPageContext::default();
        context.advance(&markdown[..first_end]);
        let second = render_structural_page(0, &markdown[first_end..], &context, None);

        assert!(second.html.contains("<ol start=\"7\">"));
        assert!(second.html.contains("reader-visible continuation"));
    }

    #[test]
    fn reopens_an_oversized_nested_quote() {
        let markdown = "> > ".to_owned() + &"reader-visible quoted continuation ".repeat(128);
        let first_end = select_layout_page_end(&LayoutPageContext::default(), &markdown, 64);
        let mut context = LayoutPageContext::default();
        context.advance(&markdown[..first_end]);
        let second = render_structural_page(0, &markdown[first_end..], &context, None);

        assert!(second.html.contains("<blockquote>"));
        assert!(second.html.contains("reader-visible quoted continuation"));
    }

    #[test]
    fn structural_rendering_never_emits_raw_html() {
        let page = render_structural_page(
            0,
            "<script>not executable</script>\n\nVisible text.\n",
            &LayoutPageContext::default(),
            None,
        );

        assert!(!page.html.contains("<script>"));
        assert!(page.html.contains("Visible text"));
    }

    #[test]
    fn compact_boundary_corpus_has_safe_structural_output_at_each_line_boundary() {
        let fixture = include_str!("../../fixtures/layout-page-boundaries.md");
        for (offset, _) in fixture.match_indices('\n') {
            let mut context = LayoutPageContext::default();
            context.advance(&fixture[..=offset]);
            let end = select_layout_page_end(&context, &fixture[offset + 1..], 512);
            let text = &fixture[offset + 1..offset + 1 + end];
            let page =
                render_structural_page(u64::try_from(offset + 1).unwrap(), text, &context, None);

            assert!(page.source_end >= page.source_start);
            assert!(!page.html.contains("<script>"));
        }
    }

    #[test]
    fn adjacent_layout_pages_preserve_all_source_text_without_duplication() {
        let markdown = include_str!("../../fixtures/layout-page-boundaries.md");
        let mut context = LayoutPageContext::default();
        let mut source_start = 0;
        let mut reconstructed_source = String::new();

        while source_start < markdown.len() {
            let source_end =
                source_start + select_layout_page_end(&context, &markdown[source_start..], 127);
            assert!(source_end > source_start);
            let source = &markdown[source_start..source_end];
            let page = render_structural_page(
                u64::try_from(source_start).unwrap(),
                source,
                &context,
                None,
            );

            assert!(page.html.len() < 16 * 1024);
            reconstructed_source.push_str(source);
            context = page.context_after;
            source_start = source_end;
        }

        assert_eq!(reconstructed_source, markdown);
    }

    #[test]
    fn tolerates_crlf_utf8_and_fence_marker_read_boundaries() {
        let markdown = "> ```rust\r\n> let city = \"東京\";\r\n> ```\r\n\r\nAfterward.\r\n";
        for (offset, _) in markdown.char_indices() {
            let mut context = LayoutPageContext::default();
            context.advance(&markdown[..offset]);
            let end = select_layout_page_end(&context, &markdown[offset..], 32);
            if end == 0 {
                continue;
            }
            let page = render_structural_page(
                u64::try_from(offset).unwrap(),
                &markdown[offset..offset + end],
                &context,
                None,
            );

            assert!(!page.html.contains("<script>"));
        }
    }

    #[test]
    fn never_retains_an_oversized_continuation_context() {
        let indentation = " ".repeat(9 * 1024);
        let oversized_table_header = format!("| {} | Value |\n", "Column".repeat(2 * 1024));
        let oversized_fence = format!("```{}\n", "rust ".repeat(2 * 1024));
        let mut context = LayoutPageContext::default();

        context.advance(&format!("{indentation}- item\n"));
        context.advance(&format!("> {}quoted\n", "> ".repeat(5 * 1024)));
        context.advance(&oversized_table_header);
        context.advance("| --- | --- |\n");
        context.advance(&oversized_fence);

        assert!(
            context.estimated_bytes()
                <= MAXIMUM_CONTINUATION_CONTEXT_BYTES + std::mem::size_of::<LayoutPageContext>()
        );
    }
}
