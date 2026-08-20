use pulldown_cmark::{
    BlockQuoteKind, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd, html,
};
use std::{collections::VecDeque, path::Path, sync::OnceLock};
use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

const MAXIMUM_HIGHLIGHTED_CODE_BYTES: usize = 256 * 1024;
const MAXIMUM_EMBEDDED_IMAGE_DATA_URL_BYTES: usize = 64 * 1024;
const PERCENT_ENCODING_HEX: &[u8; 16] = b"0123456789ABCDEF";
const HIGHLIGHT_NAMES: &[&str] = &[
    "attribute",
    "charset",
    "comment",
    "comment.documentation",
    "constant",
    "constant.builtin",
    "constructor",
    "delimiter",
    "embedded",
    "escape",
    "function",
    "function.builtin",
    "function.macro",
    "function.method",
    "function.special",
    "import",
    "keyframes",
    "keyword",
    "label",
    "media",
    "namespace",
    "number",
    "operator",
    "property",
    "punctuation.bracket",
    "punctuation.delimiter",
    "punctuation.special",
    "string",
    "string.special",
    "supports",
    "tag",
    "tag.error",
    "type",
    "type.builtin",
    "variable",
    "variable.builtin",
    "variable.parameter",
];

macro_rules! define_highlight_configuration {
    ($static_name:ident, $function_name:ident, $language:expr, $name:literal, $highlights:expr, $injections:expr) => {
        static $static_name: OnceLock<Option<HighlightConfiguration>> = OnceLock::new();

        fn $function_name() -> Option<&'static HighlightConfiguration> {
            $static_name
                .get_or_init(|| {
                    let language = $language.into();
                    let mut configuration =
                        HighlightConfiguration::new(language, $name, $highlights, $injections, "")
                            .ok()?;
                    configuration.configure(HIGHLIGHT_NAMES);
                    Some(configuration)
                })
                .as_ref()
        }
    };
}

define_highlight_configuration!(
    C_HIGHLIGHT_CONFIGURATION,
    c_highlight_configuration,
    tree_sitter_c::LANGUAGE,
    "c",
    tree_sitter_c::HIGHLIGHT_QUERY,
    ""
);
define_highlight_configuration!(
    CPP_HIGHLIGHT_CONFIGURATION,
    cpp_highlight_configuration,
    tree_sitter_cpp::LANGUAGE,
    "cpp",
    tree_sitter_cpp::HIGHLIGHT_QUERY,
    ""
);
define_highlight_configuration!(
    CSS_HIGHLIGHT_CONFIGURATION,
    css_highlight_configuration,
    tree_sitter_css::LANGUAGE,
    "css",
    tree_sitter_css::HIGHLIGHTS_QUERY,
    ""
);
define_highlight_configuration!(
    HTML_HIGHLIGHT_CONFIGURATION,
    html_highlight_configuration,
    tree_sitter_html::LANGUAGE,
    "html",
    tree_sitter_html::HIGHLIGHTS_QUERY,
    tree_sitter_html::INJECTIONS_QUERY
);
define_highlight_configuration!(
    JAVASCRIPT_HIGHLIGHT_CONFIGURATION,
    javascript_highlight_configuration,
    tree_sitter_javascript::LANGUAGE,
    "javascript",
    tree_sitter_javascript::HIGHLIGHT_QUERY,
    tree_sitter_javascript::INJECTIONS_QUERY
);
define_highlight_configuration!(
    PYTHON_HIGHLIGHT_CONFIGURATION,
    python_highlight_configuration,
    tree_sitter_python::LANGUAGE,
    "python",
    tree_sitter_python::HIGHLIGHTS_QUERY,
    ""
);
define_highlight_configuration!(
    RUST_HIGHLIGHT_CONFIGURATION,
    rust_highlight_configuration,
    tree_sitter_rust::LANGUAGE,
    "rust",
    tree_sitter_rust::HIGHLIGHTS_QUERY,
    tree_sitter_rust::INJECTIONS_QUERY
);
define_highlight_configuration!(
    TYPESCRIPT_HIGHLIGHT_CONFIGURATION,
    typescript_highlight_configuration,
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
    "typescript",
    tree_sitter_typescript::HIGHLIGHTS_QUERY,
    ""
);

#[cfg(test)]
pub(crate) const LARGE_MARKDOWN_SECTION: &str = r#"## Large fixture section

This repeated paragraph exercises Markdown parsing, layout, and scrolling performance with **strong text**, *emphasis*, and `inline code`.

```text
Lumen renders locally.
```

"#;

#[cfg(test)]
pub(crate) const LARGE_MARKDOWN_SECTION_COUNT: usize = 1_000;

fn is_supported_local_image(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };

    matches!(
        extension.to_ascii_lowercase().as_str(),
        "gif" | "jpeg" | "jpg" | "png" | "webp"
    )
}

fn percent_encode_asset_path(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    let mut encoded = String::with_capacity(path.len());

    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(PERCENT_ENCODING_HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(
                PERCENT_ENCODING_HEX[usize::from(byte & 0b0000_1111)],
            ));
        }
    }

    Some(encoded)
}

fn local_image_asset_reference(document_directory: Option<&Path>, source: &str) -> Option<String> {
    let document_directory = document_directory?.canonicalize().ok()?;
    let relative_path = Path::new(source);

    if relative_path.is_absolute() {
        return None;
    }

    let image_path = document_directory.join(relative_path).canonicalize().ok()?;

    if !image_path.starts_with(&document_directory) {
        return None;
    }

    if !is_supported_local_image(&image_path) {
        return None;
    }

    Some(format!(
        "data:application/x-lumen-asset,{}",
        percent_encode_asset_path(&image_path)?
    ))
}

fn embedded_image_data_url(source: &str) -> Option<&str> {
    if source.len() > MAXIMUM_EMBEDDED_IMAGE_DATA_URL_BYTES {
        return None;
    }

    let (metadata, payload) = source.split_once(',')?;
    let media_type = metadata.strip_prefix("data:")?.strip_suffix(";base64")?;
    if !matches!(
        media_type.to_ascii_lowercase().as_str(),
        "image/gif" | "image/jpeg" | "image/png" | "image/webp"
    ) || payload.is_empty()
        || !payload
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return None;
    }

    Some(source)
}

fn rewrite_image_tag<'a>(tag: Tag<'a>, document_directory: Option<&Path>) -> Tag<'a> {
    let Tag::Image {
        link_type,
        dest_url,
        title,
        id,
    } = tag
    else {
        return tag;
    };

    let destination = embedded_image_data_url(dest_url.as_ref())
        .map(|value| CowStr::Boxed(value.to_owned().into_boxed_str()))
        .or_else(|| {
            local_image_asset_reference(document_directory, dest_url.as_ref())
                .map(|value| CowStr::Boxed(value.into_boxed_str()))
        })
        .unwrap_or(CowStr::Borrowed("data:,"));

    Tag::Image {
        link_type,
        dest_url: destination,
        title,
        id,
    }
}

fn code_block_highlight_configuration(tag: &Tag<'_>) -> Option<&'static HighlightConfiguration> {
    let Tag::CodeBlock(CodeBlockKind::Fenced(language)) = tag else {
        return None;
    };
    let language = language.split_ascii_whitespace().next()?;

    if language.eq_ignore_ascii_case("c") {
        return c_highlight_configuration();
    }
    if matches!(language, "c++" | "cc" | "cpp" | "cxx") {
        return cpp_highlight_configuration();
    }
    if language.eq_ignore_ascii_case("css") {
        return css_highlight_configuration();
    }
    if language.eq_ignore_ascii_case("html") {
        return html_highlight_configuration();
    }
    if matches!(language, "javascript" | "js") {
        return javascript_highlight_configuration();
    }
    if matches!(language, "python" | "py") {
        return python_highlight_configuration();
    }
    if matches!(language, "rust" | "rs") {
        return rust_highlight_configuration();
    }
    if matches!(language, "typescript" | "ts") {
        return typescript_highlight_configuration();
    }

    None
}

fn alert_opening_html(kind: BlockQuoteKind) -> String {
    let (class, title) = match kind {
        BlockQuoteKind::Note => ("note", "Note"),
        BlockQuoteKind::Tip => ("tip", "Tip"),
        BlockQuoteKind::Important => ("important", "Important"),
        BlockQuoteKind::Warning => ("warning", "Warning"),
        BlockQuoteKind::Caution => ("caution", "Caution"),
    };

    format!(
        "<blockquote class=\"markdown-alert markdown-alert-{class}\"><strong class=\"markdown-alert-title\">{title}</strong>"
    )
}

fn escape_html(source: &str, output: &mut String) {
    for character in source.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(character),
        }
    }
}

fn highlight_code(source: &str, configuration: &HighlightConfiguration) -> Option<String> {
    if source.len() > MAXIMUM_HIGHLIGHTED_CODE_BYTES {
        return None;
    }

    let mut highlighter = Highlighter::new();
    let events = highlighter
        .highlight(configuration, source.as_bytes(), None, |_| None)
        .ok()?;
    let mut html = String::with_capacity(source.len());

    for event in events {
        match event.ok()? {
            HighlightEvent::Source { start, end } => escape_html(&source[start..end], &mut html),
            HighlightEvent::HighlightStart(highlight) => {
                let name = HIGHLIGHT_NAMES.get(highlight.0)?;
                html.push_str("<span class=\"syntax-");
                for character in name.chars() {
                    html.push(if character == '.' { '-' } else { character });
                }
                html.push_str("\">");
            }
            HighlightEvent::HighlightEnd => html.push_str("</span>"),
        }
    }

    Some(html)
}

struct MarkdownEvents<'markdown, 'document> {
    parser: Parser<'markdown>,
    document_directory: Option<&'document Path>,
    syntax_highlighting: bool,
    block_quote_kinds: Vec<Option<BlockQuoteKind>>,
    pending: VecDeque<Event<'markdown>>,
}

impl<'markdown, 'document> MarkdownEvents<'markdown, 'document> {
    fn new(
        markdown: &'markdown str,
        options: Options,
        document_directory: Option<&'document Path>,
        syntax_highlighting: bool,
    ) -> Self {
        Self {
            parser: Parser::new_ext(markdown, options),
            document_directory,
            syntax_highlighting,
            block_quote_kinds: Vec::new(),
            pending: VecDeque::new(),
        }
    }

    fn queue_highlighted_code_block(
        &mut self,
        opening_tag: Tag<'markdown>,
        configuration: &'static HighlightConfiguration,
    ) {
        let mut source = String::new();

        for event in self.parser.by_ref() {
            match event {
                Event::Text(text) => source.push_str(&text),
                Event::SoftBreak | Event::HardBreak => source.push('\n'),
                Event::End(TagEnd::CodeBlock) => break,
                _ => {}
            }
        }

        let rendered_code = highlight_code(&source, configuration).unwrap_or_else(|| {
            let mut escaped = String::with_capacity(source.len());
            escape_html(&source, &mut escaped);
            escaped
        });
        self.pending.push_back(Event::Start(opening_tag));
        self.pending
            .push_back(Event::Html(CowStr::Boxed(rendered_code.into_boxed_str())));
        self.pending.push_back(Event::End(TagEnd::CodeBlock));
    }
}

impl<'markdown, 'document> Iterator for MarkdownEvents<'markdown, 'document> {
    type Item = Event<'markdown>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Some(event);
            }

            match self.parser.next()? {
                Event::Html(_) | Event::InlineHtml(_) => {}
                Event::Start(Tag::BlockQuote(kind)) => {
                    self.block_quote_kinds.push(kind);
                    if let Some(kind) = kind {
                        return Some(Event::Html(CowStr::Boxed(
                            alert_opening_html(kind).into_boxed_str(),
                        )));
                    }
                    return Some(Event::Start(Tag::BlockQuote(None)));
                }
                Event::End(TagEnd::BlockQuote(kind)) => {
                    if matches!(self.block_quote_kinds.pop(), Some(Some(_))) {
                        return Some(Event::Html(CowStr::Borrowed("</blockquote>")));
                    }
                    return Some(Event::End(TagEnd::BlockQuote(kind)));
                }
                Event::Start(tag) => {
                    if self.syntax_highlighting
                        && let Some(configuration) = code_block_highlight_configuration(&tag)
                    {
                        self.queue_highlighted_code_block(tag, configuration);
                    } else {
                        return Some(Event::Start(rewrite_image_tag(
                            tag,
                            self.document_directory,
                        )));
                    }
                }
                event => return Some(event),
            }
        }
    }
}

pub(crate) fn parser_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_GFM
        | Options::ENABLE_DEFINITION_LIST
        | Options::ENABLE_SUPERSCRIPT
        | Options::ENABLE_SUBSCRIPT
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS
}

fn render_markdown_with_options(
    markdown: &str,
    document_directory: Option<&Path>,
    syntax_highlighting: bool,
) -> String {
    let parser = MarkdownEvents::new(
        markdown,
        parser_options(),
        document_directory,
        syntax_highlighting,
    );
    let mut html_output = String::new();

    html::push_html(&mut html_output, parser);
    html_output
}

pub(crate) fn render_markdown(markdown: &str, document_directory: Option<&Path>) -> String {
    render_markdown_with_options(markdown, document_directory, true)
}

pub(crate) fn render_markdown_structural(
    markdown: &str,
    document_directory: Option<&Path>,
) -> String {
    render_markdown_with_options(markdown, document_directory, false)
}

#[cfg(test)]
mod tests {
    use super::{
        MAXIMUM_EMBEDDED_IMAGE_DATA_URL_BYTES, MAXIMUM_HIGHLIGHTED_CODE_BYTES, render_markdown,
    };

    #[test]
    fn highlights_rust_fences_with_static_token_spans() {
        let html = render_markdown("```rust\npub fn lumen() {}\n```", None);

        assert!(html.contains("<span class=\"syntax-keyword\">pub</span>"));
        assert!(html.contains("<span class=\"syntax-function\">lumen</span>"));
    }

    #[test]
    fn highlights_each_initially_supported_language() {
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
            let markdown = format!("```{language}\n{source}\n```");
            let html = render_markdown(&markdown, None);

            assert!(html.contains("syntax-"), "{language} should be highlighted");
        }
    }

    #[test]
    fn leaves_unknown_code_fences_plain() {
        let html = render_markdown("```unknown\nlet value = 1;\n```", None);

        assert!(!html.contains("syntax-"));
        assert!(html.contains("let value = 1;"));
    }

    #[test]
    fn escapes_rust_source_before_inserting_highlight_markup() {
        let html = render_markdown("```rust\nlet source = \"<script>\";\n```", None);

        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn leaves_oversized_supported_code_fences_plain() {
        let source = "x".repeat(MAXIMUM_HIGHLIGHTED_CODE_BYTES + 1);
        let markdown = format!("```rust\n{source}\n```");
        let html = render_markdown(&markdown, None);

        assert!(!html.contains("syntax-"));
    }

    #[test]
    fn rejects_oversized_embedded_images_without_expanding_rendered_html() {
        let encoded_payload = "A".repeat(MAXIMUM_EMBEDDED_IMAGE_DATA_URL_BYTES);
        let markdown = format!("![Oversized](data:image/png;base64,{encoded_payload})");
        let html = render_markdown(&markdown, None);

        assert!(html.contains("src=\"data:,\""));
        assert!(!html.contains(&encoded_payload));
    }

    #[test]
    fn renders_the_approved_dependency_free_extensions() {
        let yaml_frontmatter = "---\ntitle: Hidden metadata\n---\n\n# Visible heading";
        let toml_frontmatter = "+++\ntitle = \"Hidden metadata\"\n+++\n\n# Visible heading";
        let extensions = "Term\n: Definition\n\nA ^second^ iteration with a ~temporary~ index.";

        for (source, class) in [
            ("> [!NOTE]\n> A note.", "markdown-alert-note"),
            ("> [!TIP]\n> A tip.", "markdown-alert-tip"),
            ("> [!IMPORTANT]\n> Important.", "markdown-alert-important"),
            ("> [!WARNING]\n> A warning.", "markdown-alert-warning"),
            ("> [!CAUTION]\n> A caution.", "markdown-alert-caution"),
        ] {
            let html = render_markdown(source, None);
            assert!(html.contains(class));
        }

        let yaml_html = render_markdown(yaml_frontmatter, None);
        let toml_html = render_markdown(toml_frontmatter, None);
        let extensions_html = render_markdown(extensions, None);

        assert!(!yaml_html.contains("Hidden metadata"));
        assert!(!toml_html.contains("Hidden metadata"));
        assert!(yaml_html.contains("Visible heading"));
        assert!(toml_html.contains("Visible heading"));
        assert!(extensions_html.contains("<dl>"));
        assert!(extensions_html.contains("<dt>Term</dt>"));
        assert!(extensions_html.contains("<dd>Definition</dd>"));
        assert!(extensions_html.contains("A <sup>second</sup> iteration"));
        assert!(extensions_html.contains("a <sub>temporary</sub> index"));
    }
}
