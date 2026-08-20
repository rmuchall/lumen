//! Immutable source identity for one bounded layout page.
//!
//! A document revision is the outer ownership boundary. Within that revision,
//! a page ID is the exact canonical source range, so independently planned
//! pages can be compared without retaining source or HTML.

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct LayoutPageId {
    source_end: u64,
    source_start: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct LayoutPage {
    id: LayoutPageId,
    source_end: u64,
    source_start: u64,
}

/// Canonical source-order directory for the layout pages discovered for one
/// document revision. The directory owns only page identity/ranges; rendering
/// state and HTML remain outside it so it stays compact and content-free.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct LayoutPageDirectory {
    pages: Vec<LayoutPage>,
}

impl LayoutPageDirectory {
    pub(crate) fn known_through(&self) -> u64 {
        self.pages.last().map_or(0, |page| page.source_end())
    }

    pub(crate) fn page_by_id(&self, id: LayoutPageId) -> Option<LayoutPage> {
        self.pages.iter().find(|page| page.id() == id).copied()
    }

    pub(crate) fn page_at_source_offset(&self, source_offset: u64) -> Option<LayoutPage> {
        self.pages
            .iter()
            .find(|page| page.source_start() <= source_offset && source_offset < page.source_end())
            .copied()
    }

    pub(crate) fn pages(&self) -> &[LayoutPage] {
        &self.pages
    }

    pub(crate) fn append(&mut self, page: LayoutPage) -> Result<(), &'static str> {
        if let Some(previous) = self.pages.last() {
            if page.source_start() != previous.source_end() {
                return Err("layout pages must be source-contiguous");
            }
        } else if page.source_start() != 0 {
            return Err("the first layout page must start at source offset zero");
        }
        self.pages.push(page);
        Ok(())
    }
}

impl LayoutPage {
    pub(crate) fn new(source_start: u64, source_end: u64) -> Option<Self> {
        if source_end <= source_start {
            return None;
        }
        Some(Self {
            id: LayoutPageId {
                source_end,
                source_start,
            },
            source_end,
            source_start,
        })
    }

    pub(crate) fn id(self) -> LayoutPageId {
        self.id
    }

    pub(crate) fn source_end(self) -> u64 {
        self.source_end
    }

    pub(crate) fn source_start(self) -> u64 {
        self.source_start
    }
}

impl LayoutPageId {
    pub(crate) fn wire_value(self) -> String {
        format!("{}:{}", self.source_start, self.source_end)
    }
}

impl std::str::FromStr for LayoutPageId {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some((source_start, source_end)) = value.split_once(':') else {
            return Err(());
        };
        let source_start = source_start.parse().map_err(|_| ())?;
        let source_end = source_end.parse().map_err(|_| ())?;
        LayoutPage::new(source_start, source_end).map_or(Err(()), |page| Ok(page.id()))
    }
}

#[cfg(test)]
mod tests {
    use super::{LayoutPage, LayoutPageDirectory};

    #[test]
    fn rejects_empty_and_reversed_ranges() {
        assert!(LayoutPage::new(4, 4).is_none());
        assert!(LayoutPage::new(5, 4).is_none());
    }

    #[test]
    fn page_identity_is_deterministic_and_range_specific() {
        let first = LayoutPage::new(128, 256).unwrap();
        let repeated = LayoutPage::new(128, 256).unwrap();
        let adjacent = LayoutPage::new(256, 384).unwrap();

        assert_eq!(first, repeated);
        assert_eq!(first.id(), repeated.id());
        assert_ne!(first.id(), adjacent.id());
        assert_eq!(first.source_start(), 128);
        assert_eq!(first.source_end(), 256);
    }

    #[test]
    fn parses_only_exact_nonempty_wire_ranges() {
        let page = LayoutPage::new(128, 256).unwrap();
        assert_eq!("128:256".parse(), Ok(page.id()));
        assert_eq!("256:128".parse::<super::LayoutPageId>(), Err(()));
        assert_eq!("invalid".parse::<super::LayoutPageId>(), Err(()));
    }

    #[test]
    fn directory_requires_a_contiguous_source_order() {
        let first = LayoutPage::new(0, 64).unwrap();
        let second = LayoutPage::new(64, 128).unwrap();
        let gap = LayoutPage::new(192, 256).unwrap();
        let mut directory = LayoutPageDirectory::default();

        directory.append(first).unwrap();
        directory.append(second).unwrap();

        assert_eq!(directory.known_through(), 128);
        assert_eq!(directory.pages()[1], second);
        assert!(directory.append(gap).is_err());
    }

    #[test]
    fn directory_rejects_a_nonzero_first_page() {
        let mut directory = LayoutPageDirectory::default();
        assert!(directory.append(LayoutPage::new(1, 64).unwrap()).is_err());
        assert!(directory.pages().is_empty());
    }
}
