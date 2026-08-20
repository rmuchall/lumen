//! VV.0a feasibility evidence for continuation-aware layout pages.
//!
//! This module is intentionally compiled only for tests.  It proves the
//! planner contract before its production implementation replaces the legacy
//! layout-page pipeline.

use crate::{
    layout_page_renderer::{LayoutPageContext, render_structural_page},
    markdown::parser_options,
};
use pulldown_cmark::Parser;
use std::time::Instant;

const PAGE_SOURCE_BUDGET: usize = 64 * 1024;
const PAGE_OUTPUT_BUDGET: usize = 2 * 1024 * 1024;
const TABLE_CONTEXT_BUDGET: usize = 8 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct TableContext {
    alignment: String,
    header: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PageContext {
    fence: LayoutPageContext,
    previous_line: Option<String>,
    table: Option<TableContext>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannedPage {
    context_after: PageContext,
    context_before: PageContext,
    source_end: usize,
    source_start: usize,
}

fn floor_utf8_boundary(source: &str, requested_end: usize) -> usize {
    let mut end = requested_end.min(source.len());
    while end > 0 && !source.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn is_table_row(line: &str) -> bool {
    let content = line.trim();
    content.contains('|') && !content.is_empty()
}

fn is_table_alignment(line: &str) -> bool {
    let content = line.trim().trim_matches('|');
    !content.is_empty()
        && content.split('|').all(|cell| {
            let cell = cell.trim().trim_matches(':');
            !cell.is_empty() && cell.bytes().all(|byte| byte == b'-')
        })
}

fn consume_line(context: &mut PageContext, line: &str) {
    context.fence.advance_line(line);
    if context.fence.is_inside_fence() {
        context.previous_line = None;
        context.table = None;
        return;
    }

    if let Some(table) = &context.table {
        if is_table_row(line) {
            context.previous_line = None;
            if table.header.len().saturating_add(table.alignment.len()) > TABLE_CONTEXT_BUDGET {
                context.table = None;
            }
            return;
        }
        context.table = None;
    }

    if is_table_alignment(line)
        && let Some(header) = context.previous_line.take()
        && is_table_row(&header)
        && header.len().saturating_add(line.len()) <= TABLE_CONTEXT_BUDGET
    {
        context.table = Some(TableContext {
            alignment: line.trim_end_matches(['\r', '\n']).to_owned(),
            header: header.trim_end_matches(['\r', '\n']).to_owned(),
        });
        return;
    }

    context.previous_line =
        is_table_row(line).then(|| line.trim_end_matches(['\r', '\n']).to_owned());
}

fn choose_page_end(
    context: &PageContext,
    source: &str,
    source_start: usize,
    budget: usize,
) -> usize {
    let available = &source[source_start..];
    let capped = floor_utf8_boundary(available, budget);
    if capped == 0 {
        return 0;
    }

    let mut scanned = context.clone();
    let mut cursor = 0;
    let mut preferred = 0;
    let mut line_boundary = 0;
    for line in available[..capped].split_inclusive('\n') {
        cursor += line.len();
        consume_line(&mut scanned, line);
        if line.ends_with('\n') {
            line_boundary = cursor;
            if !scanned.fence.is_inside_fence() && line.trim().is_empty() {
                preferred = cursor;
            }
        }
    }
    if preferred > 0 {
        preferred
    } else if line_boundary > 0 {
        line_boundary
    } else {
        capped
    }
}

fn plan_pages(source: &str, budget: usize) -> Vec<PlannedPage> {
    assert!(
        budget > 0,
        "a layout page requires a positive source budget"
    );
    let mut context = PageContext::default();
    let mut source_start = 0;
    let mut pages = Vec::new();
    while source_start < source.len() {
        let source_length = choose_page_end(&context, source, source_start, budget);
        assert!(source_length > 0, "layout-page planning must make progress");
        let source_end = source_start + source_length;
        let context_before = context.clone();
        for line in source[source_start..source_end].split_inclusive('\n') {
            consume_line(&mut context, line);
        }
        pages.push(PlannedPage {
            context_after: context.clone(),
            context_before,
            source_end,
            source_start,
        });
        source_start = source_end;
    }
    pages
}

fn reconstructed_markdown(page: &PlannedPage, source: &str) -> String {
    let mut reconstructed = String::new();
    if let Some(table) = &page.context_before.table {
        reconstructed.push_str(&table.header);
        reconstructed.push('\n');
        reconstructed.push_str(&table.alignment);
        reconstructed.push('\n');
    }
    let rendered_page = render_structural_page(
        u64::try_from(page.source_start).unwrap(),
        &source[page.source_start..page.source_end],
        &page.context_before.fence,
        None,
    );
    let original = &source[page.source_start..page.source_end];
    if page.context_before.table.is_some() {
        reconstructed.push_str(original);
        let html = crate::markdown::render_markdown_structural(&reconstructed, None).replacen(
            "<table>",
            "<table class=\"layout-page-table\">",
            1,
        );
        assert!(
            html.len() <= PAGE_OUTPUT_BUDGET,
            "table page output exceeded its budget"
        );
        return html;
    }
    assert!(
        rendered_page.html.len() <= PAGE_OUTPUT_BUDGET,
        "page output exceeded its budget"
    );
    rendered_page.html
}

fn assert_coverage(source: &str, pages: &[PlannedPage], budget: usize) {
    let mut expected_start = 0;
    for page in pages {
        assert_eq!(
            page.source_start, expected_start,
            "pages must be contiguous"
        );
        assert!(
            page.source_end > page.source_start,
            "pages must make progress"
        );
        assert!(
            page.source_end - page.source_start <= budget,
            "page exceeded source budget"
        );
        assert!(source.is_char_boundary(page.source_start));
        assert!(source.is_char_boundary(page.source_end));
        expected_start = page.source_end;
    }
    assert_eq!(
        expected_start,
        source.len(),
        "pages must cover all source exactly once"
    );
}

#[test]
fn pulldown_offsets_are_source_bounded_for_the_continuation_corpus() {
    let source = include_str!("../../fixtures/layout-page-boundaries.md");
    let events: Vec<_> = Parser::new_ext(source, parser_options())
        .into_offset_iter()
        .collect();

    assert!(
        !events.is_empty(),
        "the offset iterator must expose parser evidence"
    );
    for (_, range) in events {
        assert!(range.start <= range.end && range.end <= source.len());
        assert!(source.is_char_boundary(range.start));
        assert!(source.is_char_boundary(range.end));
    }
}

#[test]
fn continuation_planner_is_bounded_deterministic_and_source_complete() {
    let source = concat!(
        "> quote one\n> quote two\n\n",
        "1. first item\n   continuation\n2. second item\n\n",
        "```rust\nlet city = \"東京\";\n```\n\n",
        "| Name | Value |\n| --- | ---: |\n| Render | Static content |\n| View | Local only |\n\n",
        "A paragraph with UTF-8: 東京 and an unfinished fence follows.\n\n",
        "```python\nprint('open')\n",
    )
    .repeat(4_096);
    let first = plan_pages(&source, 1_024);
    let second = plan_pages(&source, 1_024);

    assert_eq!(first, second, "planning must be deterministic");
    assert_coverage(&source, &first, 1_024);
    for page in &first {
        let html = reconstructed_markdown(page, &source);
        assert!(!html.contains("<script>"));
        assert!(html.len() <= PAGE_OUTPUT_BUDGET);
    }
}

#[test]
fn table_pages_reopen_the_same_header_and_use_bounded_row_fragments() {
    let source = format!(
        "| Feature | Detail |\n| --- | --- |\n{}",
        (0..2_000)
            .map(|row| format!("| Row {row} | Reader-visible value {row} |\n"))
            .collect::<String>(),
    );
    let pages = plan_pages(&source, 1_024);
    assert_coverage(&source, &pages, 1_024);
    assert!(
        pages.len() > 2,
        "the table must be split into bounded pages"
    );
    for page in pages.iter().skip(1) {
        let html = reconstructed_markdown(page, &source);
        assert!(
            html.contains("<table class=\"layout-page-table\">"),
            "page context: {page:?}"
        );
        assert!(html.contains("Feature"));
        assert!(html.contains("Detail"));
    }
}

#[test]
fn a_hundred_mebibyte_unbroken_paragraph_has_bounded_utf8_safe_pages() {
    let source = "東京".repeat((100 * 1024 * 1024) / "東京".len());
    let pages = plan_pages(&source, PAGE_SOURCE_BUDGET);

    assert_coverage(&source, &pages, PAGE_SOURCE_BUDGET);
    assert!(
        pages.len() > 1,
        "an unbroken paragraph must not become one page"
    );
}

#[test]
fn checkpoint_discovery_matches_sequential_page_identity() {
    let source = (0..8_192)
        .map(|index| format!("## Section {index}\n\nparagraph {index}\n\n"))
        .collect::<String>();
    let pages = plan_pages(&source, 1_024);
    let checkpoint = pages[pages.len() / 2].clone();
    let mut direct_context = checkpoint.context_before;
    let mut direct_start = checkpoint.source_start;
    let mut direct = Vec::new();
    while direct_start < source.len() {
        let length = choose_page_end(&direct_context, &source, direct_start, 1_024);
        let direct_end = direct_start + length;
        let context_before = direct_context.clone();
        for line in source[direct_start..direct_end].split_inclusive('\n') {
            consume_line(&mut direct_context, line);
        }
        direct.push(PlannedPage {
            context_after: direct_context.clone(),
            context_before,
            source_end: direct_end,
            source_start: direct_start,
        });
        direct_start = direct_end;
    }

    assert_eq!(direct, pages[pages.len() / 2..]);
}

#[test]
#[ignore = "records comparative planner evidence; run explicitly before changing the page budget"]
fn benchmark_candidate_page_budgets() {
    let source = concat!(
        "## Layout-page benchmark\n\n",
        "A reader-visible paragraph with 東京 and `inline code`.\n\n",
        "| Name | Value |\n| --- | --- |\n| Render | Static content |\n\n",
        "```rust\npub fn lumen() {}\n```\n\n",
    )
    .repeat(131_072);
    for budget in [32 * 1024, PAGE_SOURCE_BUDGET, 128 * 1024] {
        let started_at = Instant::now();
        let pages = plan_pages(&source, budget);
        let elapsed = started_at.elapsed();
        assert_coverage(&source, &pages, budget);
        eprintln!(
            "layout-page benchmark budget={budget} pages={} elapsed_ms={}",
            pages.len(),
            elapsed.as_millis(),
        );
    }
}
