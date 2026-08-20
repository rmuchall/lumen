#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct LayoutPageLimits {
    pub(crate) source_cache_bytes: usize,
    pub(crate) index_bytes: usize,
    pub(crate) index_checkpoint_count: usize,
    pub(crate) layout_page_directory_bytes: usize,
    pub(crate) prepared_html_bytes: usize,
    pub(crate) visible_page_count: usize,
    pub(crate) maximum_source_read_bytes: usize,
    pub(crate) maximum_page_input_bytes: usize,
    pub(crate) maximum_page_output_bytes: usize,
    pub(crate) foreground_work_units: usize,
    pub(crate) enrichment_work_units: usize,
    pub(crate) queue_length: usize,
}

impl Default for LayoutPageLimits {
    fn default() -> Self {
        Self {
            source_cache_bytes: 1024 * 1024,
            index_bytes: 1024 * 1024,
            index_checkpoint_count: 16_384,
            layout_page_directory_bytes: 1024 * 1024,
            prepared_html_bytes: 4 * 1024 * 1024,
            visible_page_count: 3,
            maximum_source_read_bytes: 512 * 1024,
            maximum_page_input_bytes: 64 * 1024,
            maximum_page_output_bytes: 2 * 1024 * 1024,
            foreground_work_units: 1,
            enrichment_work_units: 1,
            queue_length: 1,
        }
    }
}

impl LayoutPageLimits {
    pub(crate) fn is_valid(self) -> bool {
        self.source_cache_bytes > 0
            && self.index_bytes > 0
            && self.index_checkpoint_count > 0
            && self.layout_page_directory_bytes > 0
            && self.prepared_html_bytes > 0
            && self.visible_page_count > 0
            && self.maximum_source_read_bytes > 0
            && self.maximum_page_input_bytes > 0
            && self.maximum_page_output_bytes > 0
            && self.foreground_work_units > 0
            && self.enrichment_work_units > 0
            && self.queue_length > 0
    }
}

#[cfg(test)]
mod tests {
    use super::LayoutPageLimits;

    #[test]
    fn default_limits_are_valid() {
        assert!(LayoutPageLimits::default().is_valid());
    }

    #[test]
    fn rejects_a_zero_budget() {
        let limits = LayoutPageLimits {
            source_cache_bytes: 0,
            ..LayoutPageLimits::default()
        };

        assert!(!limits.is_valid());
    }
}
