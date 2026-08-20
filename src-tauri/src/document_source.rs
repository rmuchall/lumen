use crate::layout_page_limits::LayoutPageLimits;
#[cfg(target_family = "unix")]
use std::os::unix::fs::MetadataExt;
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SourceRange {
    pub(crate) start: u64,
    pub(crate) end: u64,
    pub(crate) text: Arc<str>,
}

impl SourceRange {
    fn byte_len(&self) -> usize {
        self.text.len()
    }
}

#[derive(Debug)]
pub(crate) enum DocumentSourceError {
    Access(String),
    Changed,
    InvalidRange,
    InvalidUtf8,
    InvalidLimits,
}

impl std::fmt::Display for DocumentSourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Access(error) => write!(formatter, "failed to read the document: {error}"),
            Self::Changed => formatter.write_str("the document changed while it was being read"),
            Self::InvalidRange => formatter.write_str("the requested document range is invalid"),
            Self::InvalidUtf8 => formatter.write_str("the document is not valid UTF-8"),
            Self::InvalidLimits => formatter.write_str("the layout-page limits are invalid"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SourceIdentity {
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(target_family = "unix")]
    device: u64,
    #[cfg(target_family = "unix")]
    inode: u64,
}

impl SourceIdentity {
    fn from_path(path: &Path) -> Result<Self, DocumentSourceError> {
        let metadata =
            fs::metadata(path).map_err(|error| DocumentSourceError::Access(error.to_string()))?;
        if !metadata.is_file() {
            return Err(DocumentSourceError::Access(
                "the selected path is not a file".to_owned(),
            ));
        }
        Ok(Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(target_family = "unix")]
            device: metadata.dev(),
            #[cfg(target_family = "unix")]
            inode: metadata.ino(),
        })
    }
}

struct CachedRange {
    range: SourceRange,
}

pub(crate) struct DocumentSource {
    path: PathBuf,
    identity: SourceIdentity,
    limits: LayoutPageLimits,
    cache: VecDeque<CachedRange>,
    cache_bytes: usize,
}

impl DocumentSource {
    pub(crate) fn open(
        path: PathBuf,
        limits: LayoutPageLimits,
    ) -> Result<Self, DocumentSourceError> {
        if !limits.is_valid() {
            return Err(DocumentSourceError::InvalidLimits);
        }
        let identity = SourceIdentity::from_path(&path)?;
        Ok(Self {
            path,
            identity,
            limits,
            cache: VecDeque::new(),
            cache_bytes: 0,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn length(&self) -> u64 {
        self.identity.length
    }

    pub(crate) fn identity(&self) -> SourceIdentity {
        self.identity
    }

    pub(crate) fn matches_current_identity(
        &mut self,
        expected: SourceIdentity,
    ) -> Result<bool, DocumentSourceError> {
        self.ensure_current_identity()?;
        Ok(self.identity == expected)
    }

    #[cfg(any(test, debug_assertions))]
    pub(crate) fn cache_bytes(&self) -> usize {
        self.cache_bytes
    }

    pub(crate) fn read_range(
        &mut self,
        requested_start: u64,
        requested_length: usize,
    ) -> Result<SourceRange, DocumentSourceError> {
        self.ensure_current_identity()?;
        if requested_start > self.identity.length {
            return Err(DocumentSourceError::InvalidRange);
        }
        let capped_length = requested_length.min(self.limits.maximum_source_read_bytes);
        let requested_end = requested_start
            .saturating_add(capped_length as u64)
            .min(self.length());
        if let Some(range) = self.cached_range(requested_start, requested_end) {
            return Ok(range);
        }

        let range = self.read_uncached_range(requested_start, requested_end)?;
        self.cache_range(range.clone());
        Ok(range)
    }

    fn ensure_current_identity(&mut self) -> Result<(), DocumentSourceError> {
        let current_identity = SourceIdentity::from_path(&self.path)?;
        if current_identity != self.identity {
            self.cache.clear();
            self.cache_bytes = 0;
            return Err(DocumentSourceError::Changed);
        }
        Ok(())
    }

    fn cached_range(&mut self, start: u64, end: u64) -> Option<SourceRange> {
        let index = self
            .cache
            .iter()
            .position(|cached| cached.range.start == start && cached.range.end == end)?;
        let cached = self.cache.remove(index)?;
        let range = cached.range.clone();
        self.cache.push_back(cached);
        Some(range)
    }

    fn read_uncached_range(
        &self,
        requested_start: u64,
        requested_end: u64,
    ) -> Result<SourceRange, DocumentSourceError> {
        if requested_start == requested_end {
            return Ok(SourceRange {
                start: requested_start,
                end: requested_end,
                text: Arc::from(""),
            });
        }

        let read_end = requested_end.saturating_add(3).min(self.identity.length);
        let byte_count = usize::try_from(read_end.saturating_sub(requested_start))
            .map_err(|_| DocumentSourceError::InvalidRange)?;
        let mut bytes = vec![0; byte_count];
        let mut file = File::open(&self.path)
            .map_err(|error| DocumentSourceError::Access(error.to_string()))?;
        file.seek(SeekFrom::Start(requested_start))
            .map_err(|error| DocumentSourceError::Access(error.to_string()))?;
        file.read_exact(&mut bytes)
            .map_err(|error| DocumentSourceError::Access(error.to_string()))?;

        let start_offset = utf8_start_offset(&bytes, requested_start, requested_end)?;
        let end_offset = utf8_end_offset(&bytes, requested_start, requested_end)?;
        let text = std::str::from_utf8(&bytes[start_offset..end_offset])
            .map_err(|_| DocumentSourceError::InvalidUtf8)?;
        let start = requested_start + u64::try_from(start_offset).unwrap_or(0);
        let end = requested_start + u64::try_from(end_offset).unwrap_or(0);
        Ok(SourceRange {
            start,
            end,
            text: Arc::from(text),
        })
    }

    fn cache_range(&mut self, range: SourceRange) {
        let byte_len = range.byte_len();
        if byte_len > self.limits.source_cache_bytes {
            return;
        }
        while self.cache_bytes.saturating_add(byte_len) > self.limits.source_cache_bytes {
            let Some(expired) = self.cache.pop_front() else {
                break;
            };
            self.cache_bytes = self.cache_bytes.saturating_sub(expired.range.byte_len());
        }
        self.cache_bytes += byte_len;
        self.cache.push_back(CachedRange { range });
    }
}

fn utf8_start_offset(
    bytes: &[u8],
    requested_start: u64,
    requested_end: u64,
) -> Result<usize, DocumentSourceError> {
    let requested_length = usize::try_from(requested_end.saturating_sub(requested_start))
        .map_err(|_| DocumentSourceError::InvalidRange)?;
    let mut offset = 0;
    while offset < requested_length
        && bytes
            .get(offset)
            .is_some_and(|byte| is_utf8_continuation(*byte))
    {
        offset += 1;
    }
    Ok(offset)
}

fn utf8_end_offset(
    bytes: &[u8],
    requested_start: u64,
    requested_end: u64,
) -> Result<usize, DocumentSourceError> {
    let mut offset = usize::try_from(requested_end.saturating_sub(requested_start))
        .map_err(|_| DocumentSourceError::InvalidRange)?;
    while offset > 0
        && bytes
            .get(offset)
            .is_some_and(|byte| is_utf8_continuation(*byte))
    {
        offset -= 1;
    }
    Ok(offset)
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

#[cfg(test)]
mod tests {
    use super::{DocumentSource, DocumentSourceError};
    use crate::layout_page_limits::LayoutPageLimits;
    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_document(name: &str, contents: &[u8]) -> PathBuf {
        let identifier = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = env::temp_dir().join(format!("lumen-document-source-{name}-{identifier}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.md");
        fs::write(&path, contents).unwrap();
        path
    }

    fn remove_temporary_document(path: &Path) {
        let Some(directory) = path.parent() else {
            return;
        };
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reads_a_bounded_range_without_retaining_the_complete_file() {
        let path = temporary_document("bounded", b"abcdefghij");
        let limits = LayoutPageLimits {
            maximum_source_read_bytes: 4,
            source_cache_bytes: 4,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();

        let range = source.read_range(2, 99).unwrap();

        assert_eq!(range.start, 2);
        assert_eq!(range.end, 6);
        assert_eq!(&*range.text, "cdef");
        assert_eq!(source.cache_bytes(), 4);
        remove_temporary_document(&path);
    }

    #[test]
    fn moves_range_edges_to_valid_utf8_boundaries() {
        let path = temporary_document("utf8", "aé東京b".as_bytes());
        let mut source = DocumentSource::open(path.clone(), LayoutPageLimits::default()).unwrap();

        let range = source.read_range(2, 7).unwrap();

        assert_eq!(range.start, 3);
        assert_eq!(range.end, 9);
        assert_eq!(&*range.text, "東京");
        remove_temporary_document(&path);
    }

    #[test]
    fn rejects_invalid_utf8_without_replacing_bytes() {
        let path = temporary_document("invalid-utf8", b"valid\xffinvalid");
        let mut source = DocumentSource::open(path.clone(), LayoutPageLimits::default()).unwrap();

        assert!(matches!(
            source.read_range(0, 32),
            Err(DocumentSourceError::InvalidUtf8)
        ));
        remove_temporary_document(&path);
    }

    #[test]
    fn rejects_a_changed_file_and_releases_its_cached_ranges() {
        let path = temporary_document("changed", b"first document");
        let mut source = DocumentSource::open(path.clone(), LayoutPageLimits::default()).unwrap();
        let _ = source.read_range(0, 32).unwrap();
        assert!(source.cache_bytes() > 0);
        fs::write(&path, b"a replacement document with a different length").unwrap();

        assert!(matches!(
            source.read_range(0, 32),
            Err(DocumentSourceError::Changed)
        ));
        assert_eq!(source.cache_bytes(), 0);
        remove_temporary_document(&path);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn detects_a_same_length_atomic_replacement() {
        let path = temporary_document("atomic-replacement", b"first document\n");
        let replacement = path.parent().unwrap().join("replacement.md");
        let mut source = DocumentSource::open(path.clone(), LayoutPageLimits::default()).unwrap();
        let _ = source.read_range(0, 32).unwrap();
        assert!(source.cache_bytes() > 0);
        fs::write(&replacement, b"other document\n").unwrap();
        fs::rename(&replacement, &path).unwrap();

        assert!(matches!(
            source.read_range(0, 32),
            Err(DocumentSourceError::Changed)
        ));
        assert_eq!(source.cache_bytes(), 0);
        remove_temporary_document(&path);
    }

    #[test]
    fn evicts_old_cached_ranges_at_the_configured_budget() {
        let path = temporary_document("cache", b"abcdefgh");
        let limits = LayoutPageLimits {
            source_cache_bytes: 4,
            maximum_source_read_bytes: 4,
            ..LayoutPageLimits::default()
        };
        let mut source = DocumentSource::open(path.clone(), limits).unwrap();

        let _ = source.read_range(0, 4).unwrap();
        let _ = source.read_range(4, 4).unwrap();

        assert_eq!(source.cache_bytes(), 4);
        remove_temporary_document(&path);
    }

    #[test]
    fn preserves_bom_crlf_and_a_final_line_without_a_newline() {
        let contents = "\u{feff}first\r\nsecond";
        let path = temporary_document("line-endings", contents.as_bytes());
        let mut source = DocumentSource::open(path.clone(), LayoutPageLimits::default()).unwrap();

        let range = source.read_range(0, usize::MAX).unwrap();

        assert_eq!(&*range.text, contents);
        assert_eq!(range.end, u64::try_from(contents.len()).unwrap());
        remove_temporary_document(&path);
    }

    #[test]
    fn reports_an_inaccessible_source_after_opening() {
        let path = temporary_document("deleted", b"visible before deletion");
        let mut source = DocumentSource::open(path.clone(), LayoutPageLimits::default()).unwrap();
        fs::remove_file(&path).unwrap();

        assert!(matches!(
            source.read_range(0, 64),
            Err(DocumentSourceError::Access(_))
        ));
        remove_temporary_document(&path);
    }
}
