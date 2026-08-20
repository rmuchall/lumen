use crate::{
    document_source::DocumentSource,
    layout_page_limits::LayoutPageLimits,
    layout_page_renderer::{LayoutPageContext, reconstruct_markdown, select_layout_page_end},
    markdown::parser_options,
};
use pulldown_cmark::{Event, Parser};

const MAXIMUM_QUERY_BYTES: usize = 4 * 1024;

#[derive(Default)]
struct VisibleText {
    text: String,
    source_offsets: Vec<u64>,
}

impl VisibleText {
    fn push(&mut self, text: &str, source_offset: u64) {
        let start = self.text.len();
        self.text.push_str(text);
        self.source_offsets.extend(
            (0..text.len()).map(|offset| {
                source_offset.saturating_add(u64::try_from(offset).unwrap_or(u64::MAX))
            }),
        );
        debug_assert_eq!(self.text.len(), start + text.len());
    }

    fn source_offset(&self, offset: usize) -> Option<u64> {
        self.source_offsets.get(offset).copied()
    }
}

fn visible_text_in_range(
    source_start: u64,
    markdown: &str,
    context_before: &LayoutPageContext,
) -> VisibleText {
    let mut context_after = context_before.clone();
    context_after.advance(markdown);
    let reconstructed = reconstruct_markdown(context_before, markdown, &context_after);
    let prefix_length = reconstructed.len().saturating_sub(markdown.len());
    let source_end = prefix_length.saturating_add(markdown.len());
    let mut visible = VisibleText::default();
    for (event, range) in Parser::new_ext(&reconstructed, parser_options()).into_offset_iter() {
        if range.start < prefix_length || range.start >= source_end {
            continue;
        }
        let event_offset = source_start
            .saturating_add(u64::try_from(range.start - prefix_length).unwrap_or(u64::MAX));
        match event {
            Event::Text(text) | Event::Code(text) => visible.push(&text, event_offset),
            Event::SoftBreak | Event::HardBreak => visible.push("\n", event_offset),
            _ => {}
        }
    }
    visible
}

fn scan_length(context: &LayoutPageContext, markdown: &str, maximum_bytes: usize) -> usize {
    select_layout_page_end(context, markdown, maximum_bytes)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SearchProgress {
    pub(crate) complete: bool,
    pub(crate) match_count: u64,
    pub(crate) next_match_offset: Option<u64>,
    pub(crate) scanned_through: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NavigationProgress {
    pub(crate) complete: bool,
    pub(crate) match_offset: Option<u64>,
}

#[derive(Debug)]
struct NavigationScan {
    after: Option<u64>,
    carry: String,
    context: LayoutPageContext,
    scanned_through: u64,
    wrapped: bool,
}

#[derive(Debug)]
struct PreviousNavigationScan {
    before: Option<u64>,
    carry: String,
    context: LayoutPageContext,
    latest_match_offset: Option<u64>,
    scanned_through: u64,
    wrapped: bool,
}

pub(crate) struct DocumentSearch {
    normalized_query: String,
    ascii_case_insensitive: bool,
    carry: String,
    context: LayoutPageContext,
    match_count: u64,
    next_match_offset: Option<u64>,
    scanned_through: u64,
    navigation: Option<NavigationScan>,
    previous_navigation: Option<PreviousNavigationScan>,
}

impl DocumentSearch {
    pub(crate) fn new(query: String) -> Result<Self, String> {
        let original_query = query.trim().to_owned();
        if original_query.len() > MAXIMUM_QUERY_BYTES {
            return Err("the Find query exceeds Lumen's bounded search limit".to_owned());
        }
        let ascii_case_insensitive = original_query.is_ascii();
        let normalized_query = if ascii_case_insensitive {
            original_query.to_ascii_lowercase()
        } else {
            original_query.clone()
        };
        Ok(Self {
            normalized_query,
            ascii_case_insensitive,
            carry: String::new(),
            context: LayoutPageContext::default(),
            match_count: 0,
            next_match_offset: None,
            scanned_through: 0,
            navigation: None,
            previous_navigation: None,
        })
    }

    #[cfg(debug_assertions)]
    pub(crate) fn agent_observation_bytes(&self) -> u64 {
        let navigation_bytes = self.navigation.as_ref().map_or(0, |navigation| {
            navigation
                .carry
                .capacity()
                .saturating_add(navigation.context.estimated_bytes())
        });
        let previous_navigation_bytes = self.previous_navigation.as_ref().map_or(0, |navigation| {
            navigation
                .carry
                .capacity()
                .saturating_add(navigation.context.estimated_bytes())
        });
        u64::try_from(
            std::mem::size_of::<Self>()
                .saturating_add(self.normalized_query.capacity())
                .saturating_add(self.carry.capacity())
                .saturating_add(self.context.estimated_bytes())
                .saturating_add(navigation_bytes)
                .saturating_add(previous_navigation_bytes),
        )
        .unwrap_or(u64::MAX)
    }

    pub(crate) fn step(
        &mut self,
        source: &mut DocumentSource,
        limits: LayoutPageLimits,
        navigation_after: Option<u64>,
    ) -> Result<SearchProgress, String> {
        if self.normalized_query.is_empty() || self.scanned_through >= source.length() {
            return Ok(self.progress(source.length()));
        }
        let range = source
            .read_range(self.scanned_through, limits.maximum_page_input_bytes)
            .map_err(|error| error.to_string())?;
        if range.end <= self.scanned_through {
            return Err("the Find scanner did not make progress".to_owned());
        }
        let scanned_length =
            scan_length(&self.context, &range.text, limits.maximum_page_input_bytes);
        if scanned_length == 0 {
            return Err("the Find scanner selected an empty range".to_owned());
        }
        let markdown = &range.text[..scanned_length];
        let carry_length = self.carry.len();
        let visible = visible_text_in_range(range.start, markdown, &self.context);
        self.context.advance(markdown);
        let mut combined = self.carry.clone();
        combined.push_str(&visible.text);
        let searchable = self.searchable_text(&combined);
        let mut search_start = 0;
        while let Some(relative_start) = searchable[search_start..].find(&self.normalized_query) {
            let start = search_start + relative_start;
            let end = start.saturating_add(self.normalized_query.len());
            if end > carry_length {
                self.match_count = self.match_count.saturating_add(1);
                let source_offset = if start >= carry_length {
                    visible
                        .source_offset(start - carry_length)
                        .unwrap_or(range.start)
                } else {
                    range.start
                };
                if self.next_match_offset.is_none()
                    && navigation_after.is_none_or(|offset| source_offset >= offset)
                {
                    self.next_match_offset = Some(source_offset);
                }
            }
            search_start = end;
        }
        self.carry = trailing_text(&combined, self.normalized_query.len().saturating_sub(1));
        self.scanned_through = range
            .start
            .saturating_add(u64::try_from(scanned_length).unwrap_or(u64::MAX));
        Ok(self.progress(source.length()))
    }

    pub(crate) fn next_step(
        &mut self,
        source: &mut DocumentSource,
        limits: LayoutPageLimits,
        after: Option<u64>,
    ) -> Result<NavigationProgress, String> {
        if self.normalized_query.is_empty() {
            return Ok(NavigationProgress {
                complete: true,
                match_offset: None,
            });
        }
        let source_length = source.length();
        let ascii_case_insensitive = self.ascii_case_insensitive;
        let normalized_query = self.normalized_query.clone();
        let normalized_after = after.map(|offset| offset.min(source_length));
        if self
            .navigation
            .as_ref()
            .is_none_or(|navigation| navigation.after != normalized_after)
        {
            let start = normalized_after.map_or(0, |offset| offset.saturating_add(1));
            self.navigation = Some(NavigationScan {
                after: normalized_after,
                carry: String::new(),
                context: LayoutPageContext::default(),
                scanned_through: start.min(source_length),
                wrapped: false,
            });
        }
        let navigation = self
            .navigation
            .as_mut()
            .ok_or_else(|| "the Find navigation state is unavailable".to_owned())?;
        let scan_limit = navigation.after.unwrap_or(source_length);
        if navigation.scanned_through
            >= if navigation.wrapped {
                scan_limit
            } else {
                source_length
            }
        {
            if !navigation.wrapped && scan_limit > 0 {
                navigation.carry.clear();
                navigation.scanned_through = 0;
                navigation.wrapped = true;
            } else {
                return Ok(NavigationProgress {
                    complete: true,
                    match_offset: None,
                });
            }
        }
        let scan_limit = if navigation.wrapped {
            scan_limit
        } else {
            source_length
        };
        let requested_length =
            usize::try_from(scan_limit.saturating_sub(navigation.scanned_through))
                .unwrap_or(usize::MAX)
                .min(limits.maximum_page_input_bytes);
        if requested_length == 0 {
            return Ok(NavigationProgress {
                complete: true,
                match_offset: None,
            });
        }
        let range = source
            .read_range(navigation.scanned_through, requested_length)
            .map_err(|error| error.to_string())?;
        if range.end <= navigation.scanned_through {
            return Err("the Find navigation scanner did not make progress".to_owned());
        }
        let scanned_length = scan_length(
            &navigation.context,
            &range.text,
            limits.maximum_page_input_bytes,
        );
        if scanned_length == 0 {
            return Err("the Find navigation scanner selected an empty range".to_owned());
        }
        let markdown = &range.text[..scanned_length];
        let visible = visible_text_in_range(range.start, markdown, &navigation.context);
        navigation.context.advance(markdown);
        let carry_length = navigation.carry.len();
        let mut combined = navigation.carry.clone();
        combined.push_str(&visible.text);
        let searchable = if ascii_case_insensitive {
            combined.to_ascii_lowercase()
        } else {
            combined.clone()
        };
        let mut search_start = 0;
        while let Some(relative_start) = searchable[search_start..].find(&normalized_query) {
            let start = search_start + relative_start;
            let end = start.saturating_add(normalized_query.len());
            if end > carry_length {
                let source_offset = if start >= carry_length {
                    visible
                        .source_offset(start - carry_length)
                        .unwrap_or(range.start)
                } else {
                    range.start
                };
                if navigation.wrapped || navigation.after.is_none_or(|after| source_offset > after)
                {
                    return Ok(NavigationProgress {
                        complete: true,
                        match_offset: Some(source_offset),
                    });
                }
            }
            search_start = end;
        }
        navigation.carry = trailing_text(&combined, normalized_query.len().saturating_sub(1));
        navigation.scanned_through = range
            .start
            .saturating_add(u64::try_from(scanned_length).unwrap_or(u64::MAX));
        Ok(NavigationProgress {
            complete: false,
            match_offset: None,
        })
    }

    pub(crate) fn previous_step(
        &mut self,
        source: &mut DocumentSource,
        limits: LayoutPageLimits,
        before: Option<u64>,
    ) -> Result<NavigationProgress, String> {
        if self.normalized_query.is_empty() {
            return Ok(NavigationProgress {
                complete: true,
                match_offset: None,
            });
        }
        let source_length = source.length();
        let normalized_before = before.map(|offset| offset.min(source_length));
        if self
            .previous_navigation
            .as_ref()
            .is_none_or(|navigation| navigation.before != normalized_before)
        {
            self.previous_navigation = Some(PreviousNavigationScan {
                before: normalized_before,
                carry: String::new(),
                context: LayoutPageContext::default(),
                latest_match_offset: None,
                scanned_through: 0,
                wrapped: false,
            });
        }
        let ascii_case_insensitive = self.ascii_case_insensitive;
        let normalized_query = self.normalized_query.clone();
        let navigation = self
            .previous_navigation
            .as_mut()
            .ok_or_else(|| "the Find previous-navigation state is unavailable".to_owned())?;
        let scan_limit = navigation.before.unwrap_or(source_length);
        if navigation.scanned_through
            >= if navigation.wrapped {
                source_length
            } else {
                scan_limit
            }
        {
            if !navigation.wrapped
                && navigation.latest_match_offset.is_none()
                && scan_limit < source_length
            {
                navigation.carry.clear();
                navigation.scanned_through = scan_limit.saturating_add(1);
                navigation.wrapped = true;
            } else {
                return Ok(NavigationProgress {
                    complete: true,
                    match_offset: navigation.latest_match_offset,
                });
            }
        }
        let scan_limit = if navigation.wrapped {
            source_length
        } else {
            scan_limit
        };
        let requested_length =
            usize::try_from(scan_limit.saturating_sub(navigation.scanned_through))
                .unwrap_or(usize::MAX)
                .min(limits.maximum_page_input_bytes);
        if requested_length == 0 {
            return Ok(NavigationProgress {
                complete: true,
                match_offset: navigation.latest_match_offset,
            });
        }
        let range = source
            .read_range(navigation.scanned_through, requested_length)
            .map_err(|error| error.to_string())?;
        if range.end <= navigation.scanned_through {
            return Err("the Find previous-navigation scanner did not make progress".to_owned());
        }
        let scanned_length = scan_length(
            &navigation.context,
            &range.text,
            limits.maximum_page_input_bytes,
        );
        if scanned_length == 0 {
            return Err("the Find previous-navigation scanner selected an empty range".to_owned());
        }
        let markdown = &range.text[..scanned_length];
        let visible = visible_text_in_range(range.start, markdown, &navigation.context);
        navigation.context.advance(markdown);
        let carry_length = navigation.carry.len();
        let mut combined = navigation.carry.clone();
        combined.push_str(&visible.text);
        let searchable = if ascii_case_insensitive {
            combined.to_ascii_lowercase()
        } else {
            combined.clone()
        };
        let mut search_start = 0;
        while let Some(relative_start) = searchable[search_start..].find(&normalized_query) {
            let start = search_start + relative_start;
            let end = start.saturating_add(normalized_query.len());
            if end > carry_length {
                let source_offset = if start >= carry_length {
                    visible
                        .source_offset(start - carry_length)
                        .unwrap_or(range.start)
                } else {
                    range.start
                };
                let before_match = navigation
                    .before
                    .is_none_or(|before| source_offset < before);
                if navigation.wrapped || before_match {
                    navigation.latest_match_offset = Some(source_offset);
                }
            }
            search_start = end;
        }
        navigation.carry = trailing_text(&combined, normalized_query.len().saturating_sub(1));
        navigation.scanned_through = range
            .start
            .saturating_add(u64::try_from(scanned_length).unwrap_or(u64::MAX));
        Ok(NavigationProgress {
            complete: false,
            match_offset: None,
        })
    }

    fn progress(&self, source_length: u64) -> SearchProgress {
        SearchProgress {
            complete: self.scanned_through >= source_length,
            match_count: self.match_count,
            next_match_offset: self.next_match_offset,
            scanned_through: self.scanned_through,
        }
    }

    fn searchable_text(&self, text: &str) -> String {
        if self.ascii_case_insensitive {
            text.to_ascii_lowercase()
        } else {
            text.to_owned()
        }
    }
}

fn trailing_text(text: &str, maximum_bytes: usize) -> String {
    if text.len() <= maximum_bytes {
        return text.to_owned();
    }
    let mut start = text.len().saturating_sub(maximum_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::DocumentSearch;
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
        let directory = env::temp_dir().join(format!("lumen-document-search-{identifier}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.md");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn finds_case_insensitive_ascii_matches_across_read_boundaries() {
        let path = temporary_document("prefix LUMEN suffix\nlumen again\n");
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 7,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut search = DocumentSearch::new("lumen".to_owned()).unwrap();
        let mut progress = search.step(&mut source, limits, None).unwrap();
        while !progress.complete {
            progress = search.step(&mut source, limits, None).unwrap();
        }

        assert_eq!(progress.match_count, 2);
        assert_eq!(progress.next_match_offset, Some(7));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn counts_reader_visible_link_text_but_not_its_destination() {
        let path = temporary_document("[Visible Lumen](https://example.test/hidden-destination)\n");
        let limits = LayoutPageLimits::default();
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut visible = DocumentSearch::new("lumen".to_owned()).unwrap();
        let mut hidden = DocumentSearch::new("hidden-destination".to_owned()).unwrap();

        let visible_progress = visible.step(&mut source, limits, None).unwrap();
        let hidden_progress = hidden.step(&mut source, limits, None).unwrap();

        assert_eq!(visible_progress.match_count, 1);
        assert_eq!(hidden_progress.match_count, 0);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn does_not_expose_link_destinations_when_scanning_multiple_bounded_blocks() {
        let contents = "[Visible Lumen](https://example.invalid/hidden-destination)\n\n".repeat(8);
        let path = temporary_document(&contents);
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 64,
            maximum_page_input_bytes: 64,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut hidden = DocumentSearch::new("hidden-destination".to_owned()).unwrap();
        let mut progress = hidden.step(&mut source, limits, None).unwrap();
        while !progress.complete {
            progress = hidden.step(&mut source, limits, None).unwrap();
        }

        assert_eq!(progress.match_count, 0);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn preserves_exact_unicode_queries_without_invalid_byte_offsets() {
        let path = temporary_document("A 東京 match and another 東京 match.");
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 10,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut search = DocumentSearch::new("東京".to_owned()).unwrap();
        let mut progress = search.step(&mut source, limits, None).unwrap();
        while !progress.complete {
            progress = search.step(&mut source, limits, None).unwrap();
        }

        assert_eq!(progress.match_count, 2);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn navigates_forward_across_read_boundaries_and_wraps() {
        let contents = "Lumen first\n\nLUMEN second\n\nlumen third\n";
        let path = temporary_document(contents);
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 7,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();
        let mut search = DocumentSearch::new("lumen".to_owned()).unwrap();

        let first = complete_navigation(&mut search, &mut source, limits, None);
        let second = complete_navigation(&mut search, &mut source, limits, first);
        let third = complete_navigation(&mut search, &mut source, limits, second);
        let wrapped = complete_navigation(&mut search, &mut source, limits, third);
        let previous = complete_previous_navigation(&mut search, &mut source, limits, third);
        let wrapped_previous =
            complete_previous_navigation(&mut search, &mut source, limits, first);

        assert_eq!(first, Some(0));
        assert_eq!(second, Some(13));
        assert_eq!(third, Some(27));
        assert_eq!(wrapped, first);
        assert_eq!(previous, Some(13));
        assert_eq!(wrapped_previous, Some(27));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn complete_navigation(
        search: &mut DocumentSearch,
        source: &mut DocumentSource,
        limits: LayoutPageLimits,
        after: Option<u64>,
    ) -> Option<u64> {
        let mut progress = search.next_step(source, limits, after).unwrap();
        while !progress.complete {
            progress = search.next_step(source, limits, after).unwrap();
        }
        progress.match_offset
    }

    fn complete_previous_navigation(
        search: &mut DocumentSearch,
        source: &mut DocumentSource,
        limits: LayoutPageLimits,
        before: Option<u64>,
    ) -> Option<u64> {
        let mut progress = search.previous_step(source, limits, before).unwrap();
        while !progress.complete {
            progress = search.previous_step(source, limits, before).unwrap();
        }
        progress.match_offset
    }
}
