---
title: Lumen viewer review notes
audience: desktop team
---

# Lumen viewer review notes

**Status:** ready for visual review  
**Audience:** desktop team  
**Last updated:** 16 August 2026

Lumen is intended to be the reader you reach for when you want to open a Markdown file immediately and stay focused on its contents. This short review collects the decisions, examples, and implementation notes for the current viewer pass.

---

## Reading experience

The document canvas should feel quiet. Prose is deliberately straightforward, with _gentle emphasis_ for a thought in passing, **strong emphasis** for an important conclusion, and ~~obsolete wording~~ when a decision has changed. Inline snippets such as `lumen README.md` should remain distinct without interrupting the sentence around them. Technical writing can also use a ^second^ iteration without breaking the reading flow; Lumen's subscript syntax is written as `~temporary~`.

> The viewer should disappear into the background. A reader ought to notice the document first, then the application only when an interaction is needed.
>
> This applies equally to a small project note and a long engineering document with tables, code samples, and links.

The default column is designed for sustained reading, while wide content remains available instead of being clipped. For related context, see the [local link example](link-target.md) or [jump to the implementation checklist](#implementation-checklist). A web reference such as [the CommonMark specification](https://spec.commonmark.org/) opens in the system browser.

---

## Reader notes

> [!NOTE]
> Lumen renders standard document notes locally, with no remote assets or network calls.

> [!TIP]
> Use the system appearance by default, then select an explicit theme only when it helps your reading environment.

> [!IMPORTANT]
> Keep source Markdown portable. Lumen's richer rendering should improve reading without making files application-specific.

> [!WARNING]
> A local image outside the opened document directory is intentionally not loaded.

> [!CAUTION]
> Raw HTML remains disabled, even in a document that otherwise uses extended Markdown.

---

## Implementation checklist

- [x] Centre a responsive reading column.
- [x] Use a calm off-white canvas in light mode and charcoal canvas in dark mode.
- [x] Keep links, focus, and selected interface details blue.
- [x] Render the GFM baseline: tables, tasks, strikethrough, and footnotes.
- [ ] Compare a future release on another display scale.

The current review remains intentionally small:

1. Open a representative document.
2. Switch between light and dark appearances.
3. Scan text, tables, links, and code for contrast or spacing issues.
4. Record only concrete observations.

### Design review summary

| Area               | Current direction                 | Reason to keep it                                         |
| ------------------ | --------------------------------- | --------------------------------------------------------- |
| Document canvas    | Neutral off-white / charcoal      | Comfortable during long reading sessions                  |
| Interactive colour | One blue accent family            | Links and focus remain immediately recognisable           |
| Code surface       | Pale blue-grey / dark charcoal    | Separates code without turning the whole app blue         |
| Wide tables        | Horizontal overflow when required | Preserves source information instead of clipping it       |
| Status bar         | Compact, fixed-height footer      | Makes link destinations available without layout movement |

### Terms used in this review

Document canvas
: The main reading surface behind ordinary Markdown prose.

Code surface
: The distinct surface behind inline and fenced code, chosen to make technical examples easy to scan.

Semantic colour
: A colour with a stable meaning, such as blue for interaction, orange for warnings, and red for errors.

---

## Rendering notes

An unsupported fence is kept as plain, safely escaped text. That fallback matters more than guessing incorrectly about a language.

```text
<viewer mode="offline">plain code should remain legible</viewer>
```

The supported languages below are deliberately short excerpts from the same fictional viewer feature. Together they make it easy to scan the syntax palette in either theme.

### HTML structure

```html
<main class="viewer">
  <h1>Lumen</h1>
  <p data-mode="offline">Fast Markdown preview.</p>
</main>
```

### CSS surface tokens

```css
.viewer {
  background: var(--background);
  color: var(--text);
  max-width: min(92vw, 72rem);
}
```

### JavaScript interaction

```javascript
function formatTitle(name) {
  return `Viewing: ${name}`;
}

console.log(formatTitle("Lumen"));
```

### TypeScript state

```typescript
type DocumentState = {
  readonly path: string;
  readonly rendered: boolean;
};

const state: DocumentState = {path: "README.md", rendered: true};
```

### C entry point

```c
#include <stdio.h>

int main(void) {
  puts("Lumen");
  return 0;
}
```

### C++ constant

```cpp
#include <string_view>

constexpr std::string_view name = "Lumen";
```

### Rust rendering helper

```rust
fn render(name: &str) -> String {
    format!("Viewing: {name}")
}
```

### Python utility

```python
def render(name: str) -> str:
    return f"Viewing: {name}"
```

---

## Closing note

The goal is not visual novelty. It is a dependable viewer that makes technical notes pleasant to read, whether the document is a quick checklist or a long reference.[^review]

[^review]: This footnote exercises reference layout, backlink behaviour, spacing, and contrast.
